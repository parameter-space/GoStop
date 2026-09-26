const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Room } = require('./room');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

const rooms = new Map(); // code -> Room
const socketMeta = new Map(); // socketId -> {roomCode, playerId}

function broadcast(room) {
  for (const p of room.players) {
    if (!p.connected) continue;
    io.to(p.socketId).emit('room:state', room.publicState(p.id));
  }
}

function getRoomOrFail(code) {
  const room = rooms.get(code);
  if (!room) throw new Error('존재하지 않는 방입니다');
  return room;
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ name }, cb) => {
    try {
      const room = new Room();
      const playerId = room.addPlayer(name || '플레이어', socket.id);
      rooms.set(room.code, room);
      socketMeta.set(socket.id, { roomCode: room.code, playerId });
      socket.join(room.code);
      cb({ ok: true, roomCode: room.code, playerId });
      broadcast(room);
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  socket.on('room:join', ({ roomCode, name }, cb) => {
    try {
      const room = getRoomOrFail(roomCode.toUpperCase());
      const playerId = room.addPlayer(name || '플레이어', socket.id);
      socketMeta.set(socket.id, { roomCode: room.code, playerId });
      socket.join(room.code);
      cb({ ok: true, roomCode: room.code, playerId });
      broadcast(room);
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  socket.on('room:rejoin', ({ roomCode, playerId }, cb) => {
    try {
      const room = getRoomOrFail(roomCode.toUpperCase());
      room.reconnectPlayer(playerId, socket.id);
      socketMeta.set(socket.id, { roomCode: room.code, playerId });
      socket.join(room.code);
      cb({ ok: true, roomCode: room.code, playerId });
      broadcast(room);
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  function withRoom(cb) {
    const meta = socketMeta.get(socket.id);
    if (!meta) return null;
    const room = rooms.get(meta.roomCode);
    if (!room) return null;
    return { room, playerId: meta.playerId };
  }

  socket.on('game:start', (_, cb) => {
    const ctx = withRoom();
    if (!ctx) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    try {
      const player = ctx.room.players.find((p) => p.id === ctx.playerId);
      if (!player?.isHost) throw new Error('호스트만 시작할 수 있습니다');
      ctx.room.startRound();
      broadcast(ctx.room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('game:playCard', ({ cardId, chosenFloorId }, cb) => {
    const ctx = withRoom();
    if (!ctx) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    try {
      const result = ctx.room.playCard(ctx.playerId, cardId, chosenFloorId);
      broadcast(ctx.room);
      cb?.({ ok: true, result });
    } catch (e) {
      if (e && e.code === 'NEED_CHOICE') {
        cb?.({ ok: false, needChoice: true, matches: e.matches });
      } else {
        cb?.({ ok: false, error: e.message });
      }
    }
  });

  socket.on('game:playBomb', ({ month }, cb) => {
    const ctx = withRoom();
    if (!ctx) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    try {
      const result = ctx.room.playBomb(ctx.playerId, month);
      broadcast(ctx.room);
      cb?.({ ok: true, result });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('game:declareShake', ({ month }, cb) => {
    const ctx = withRoom();
    if (!ctx) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    try {
      ctx.room.declareShake(ctx.playerId, month);
      broadcast(ctx.room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('game:goStop', ({ decision }, cb) => {
    const ctx = withRoom();
    if (!ctx) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    try {
      const result = ctx.room.goStopDecision(ctx.playerId, decision);
      broadcast(ctx.room);
      cb?.({ ok: true, result });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('game:setPointValue', ({ value }, cb) => {
    const ctx = withRoom();
    if (!ctx) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    try {
      ctx.room.setPointValue(value);
      ctx.room.addLog(`점당 금액이 ${value}원으로 변경되었습니다.`);
      broadcast(ctx.room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('game:endRoundNow', (_, cb) => {
    const ctx = withRoom();
    if (!ctx) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    try {
      const player = ctx.room.players.find((p) => p.id === ctx.playerId);
      if (!player?.isHost) throw new Error('호스트만 판을 종료할 수 있습니다');
      const result = ctx.room.forceEndRound();
      broadcast(ctx.room);
      cb?.({ ok: true, result });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // 방 폭파: 호스트가 방 전체를 완전히 끝내고 모두를 로비로 돌려보낸다
  socket.on('room:destroy', (_, cb) => {
    const ctx = withRoom();
    if (!ctx) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    try {
      const player = ctx.room.players.find((p) => p.id === ctx.playerId);
      if (!player?.isHost) throw new Error('호스트만 방을 폭파할 수 있습니다');
      const code = ctx.room.code;
      io.to(code).emit('room:destroyed');
      for (const p of ctx.room.players) socketMeta.delete(p.socketId);
      const socketsInRoom = io.sockets.adapter.rooms.get(code);
      if (socketsInRoom) {
        for (const sid of socketsInRoom) {
          const s = io.sockets.sockets.get(sid);
          s?.leave(code);
        }
      }
      rooms.delete(code);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('game:nextRound', (_, cb) => {
    const ctx = withRoom();
    if (!ctx) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    try {
      const player = ctx.room.players.find((p) => p.id === ctx.playerId);
      if (!player?.isHost) throw new Error('호스트만 다음 판을 시작할 수 있습니다');
      ctx.room.startRound();
      broadcast(ctx.room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomCode);
    if (room) {
      const p = room.players.find((pl) => pl.id === meta.playerId);
      if (p) p.connected = false;
      broadcast(room);
    }
    socketMeta.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`고스톱 서버 실행중: http://localhost:${PORT}`);
});

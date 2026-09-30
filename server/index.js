const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Room } = require('./room');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 정적 파일(css/js 등)을 브라우저가 캐시해서 수정사항이 안 보이는 문제를 막기 위해 캐시 비활성화
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

const rooms = new Map(); // code -> Room
const socketMeta = new Map(); // socketId -> {roomCode, playerId}

// 접속이 끊긴 사람의 차례에서 게임이 영원히 멈추는 것을 막기 위한 자동 진행 장치.
// 일정 시간 응답이 없으면 서버가 대신 진행한다(손패 아무거나 내기, 고/스톱은 안전하게 스톱).
// 테스트에서는 실제로 몇십 초씩 기다릴 수 없으므로 환경변수로 지연시간을 줄일 수 있게 한다.
const AUTO_PLAY_DELAY_MS = Number(process.env.AUTO_PLAY_DELAY_MS) || 30000;
const autoPlayTimers = new Map(); // room.code -> Timeout
const autoPlayTargets = new Map(); // room.code -> 그 타이머가 기다리고 있는 playerId

function clearAutoPlayTimer(code) {
  const t = autoPlayTimers.get(code);
  if (t) {
    clearTimeout(t);
    autoPlayTimers.delete(code);
  }
  autoPlayTargets.delete(code);
}

// 지금 응답을 기다리는 사람이 접속이 끊긴 상태라면, 잠시 후 서버가 대신 진행하도록 예약한다.
// broadcast() 끝에서 매번 호출되므로, 상대가 재접속했거나 이미 예약이 걸려있으면 그냥 지나간다.
//
// 주의: 타이머는 방(room.code) 단위 하나뿐이라, "지금 기다리는 사람"이 바뀌었는데도
// 예전 타이머가 아직 안 끝났다는 이유만으로 그냥 지나치면 안 된다. 예를 들어 P1의 차례에서
// 접속이 끊겨 P1 앞으로 타이머가 걸려 있는 도중에, 호스트가 "이 판 무효 처리"로 판을 끝내고
// 다음 판을 시작하면(다음 판은 항상 turnOrder[0]부터 시작) 새로 기다려야 할 사람이 P1이 아닌
// 다른 접속 끊긴 사람(예: P0)으로 바뀔 수 있다. 이 경우 예전 타이머는 P1 기준으로 남아있어서,
// 그게 만료될 때까지(최대 AUTO_PLAY_DELAY_MS 전체를 다시 기다려야 함) 새 대상에게는 자동
// 진행이 걸리지 않는 사각지대가 생긴다. 그래서 "이미 예약됨" 여부만 볼 게 아니라 그 예약이
// 지금 기다리는 사람과 같은 대상을 향하고 있는지까지 함께 확인해야 한다.
function scheduleAutoPlayIfNeeded(room) {
  const r = room.round;
  if (!r) { clearAutoPlayTimer(room.code); return; }

  // 주의 2: pendingChoice2(덱에서 뒤집은 카드가 바닥의 같은 월 2장과 매치되어 선택을 기다리는
  // 상태)도 여기서 빠뜨리면 안 된다. 예전에는 `!r.pendingChoice2` 조건 때문에 이 상태에서는
  // waitingPlayerId가 항상 null이 되어(즉 자동 진행 자체가 아예 걸리지 않아) 그 선택을 기다리던
  // 사람이 접속을 끊으면 아무도 대신 선택할 수 없어 게임 전체가 영구히 멈춰버렸다(이 상태는
  // playTurn이 advanceTurn을 아직 안 부른 시점에 세팅되므로, currentActorId()도 여전히 그
  // 사람을 가리켜서 사실 이 조건을 뺄 이유가 없었다). performAutoPlay 쪽에서 이 상태를 구분해
  // "손패를 낸다"가 아니라 "대기 중인 선택을 마무리한다"로 올바르게 처리한다(아래 참고).
  let waitingPlayerId = null;
  if (r.phase === 'playing') {
    waitingPlayerId = room.currentActorId();
  } else if (r.phase === 'await-gostop' && r.pendingGoStop) {
    waitingPlayerId = r.pendingGoStop.playerId;
  }
  const waitingPlayer = waitingPlayerId && room.players.find((p) => p.id === waitingPlayerId);

  if (!waitingPlayer || waitingPlayer.connected) {
    clearAutoPlayTimer(room.code);
    return;
  }
  if (autoPlayTimers.has(room.code)) {
    if (autoPlayTargets.get(room.code) === waitingPlayerId) return; // 같은 사람을 기다리는 중이면 그대로 둠
    clearAutoPlayTimer(room.code); // 기다려야 할 사람이 바뀌었으니 예전 예약은 버리고 다시 건다
  }

  const timer = setTimeout(() => {
    autoPlayTimers.delete(room.code);
    autoPlayTargets.delete(room.code);
    try {
      performAutoPlay(room, waitingPlayerId);
    } catch (e) {
      // 자동 진행이 실패해도(예상 못한 상태 변화 등) 서버 전체가 죽으면 안 되니 로그만 남긴다
      room.addLog(`자동 진행 실패: ${e.message}`);
    }
    broadcast(room); // 재확인 -> 다음 대기자도 여전히 끊겨있으면 알아서 다시 예약된다
  }, AUTO_PLAY_DELAY_MS);
  autoPlayTimers.set(room.code, timer);
  autoPlayTargets.set(room.code, waitingPlayerId);
}

// 접속 끊긴 플레이어를 대신해 한 번 진행한다. 폭탄/흔들기처럼 "선택"이 필요한 행동은 굳이
// 대신 하지 않고, 반드시 해야 하는 최소한의 행동만 한다: 손패가 있으면 아무 카드나 내고
// (짝이 여러 장이면 그중 첫 번째로), 고/스톱 응답 대기 중이면 안전하게 "스톱"으로 마무리한다.
function performAutoPlay(room, playerId) {
  const r = room.round;
  if (!r) return;
  const player = room.players.find((p) => p.id === playerId);
  if (!player || player.connected) return; // 그 사이 재접속했으면 손대지 않는다

  if (r.phase === 'await-gostop' && r.pendingGoStop?.playerId === playerId) {
    room.addLog(`${room.playerName(playerId)}님이 응답이 없어 자동으로 스톱 처리되었습니다.`);
    room.goStopDecision(playerId, 'stop');
    return;
  }
  if (r.phase !== 'playing' || room.currentActorId() !== playerId) return;

  // 덱에서 뒤집은 카드가 바닥의 같은 월 2장과 매치되어(NEED_CHOICE2) 이 사람의 선택을
  // 기다리는 중이라면, 이건 "다음 손패를 낸다"가 아니라 "이미 시작된 턴의 마무리 선택"이라
  // 완전히 다른 행동이다. 첫 번째 후보를 골라 안전하게 진행시킨다(따닥 성립 여부에만 영향).
  if (r.pendingChoice2 && r.pendingChoice2.playerId === playerId) {
    room.addLog(`${room.playerName(playerId)}님이 응답이 없어 자동으로 진행되었습니다.`);
    room.resolveChoice2(playerId, r.pendingChoice2.matches[0].id);
    return;
  }

  const hand = r.hand[playerId];
  room.addLog(`${room.playerName(playerId)}님이 응답이 없어 자동으로 진행되었습니다.`);
  // 손패가 없으면 스킵 턴(폭탄 이후 덱만 뒤집기). 이 경우에도 뒤집은 카드가 바닥 2장과 맞아
  // 선택을 요구받을 수 있어서, 손패가 있을 때와 똑같이 아래 catch를 거치게 한다(예전엔 이
  // 경로만 try 밖에 있어서 "자동 진행 실패"로 한 바퀴(30초) 더 기다린 뒤에야 풀렸다).
  const cardId = hand.length ? hand[0].id : null;
  try {
    room.playCard(playerId, cardId);
  } catch (e) {
    if (e && e.code === 'NEED_CHOICE') {
      room.playCard(playerId, cardId, e.matches[0].id);
    } else if (e && e.code === 'NEED_CHOICE2') {
      room.resolveChoice2(playerId, e.matches[0].id);
    } else {
      throw e;
    }
  }
}

function broadcast(room) {
  for (const p of room.players) {
    if (!p.connected) continue;
    io.to(p.socketId).emit('room:state', room.publicState(p.id));
  }
  scheduleAutoPlayIfNeeded(room);
}

function getRoomOrFail(code) {
  const room = rooms.get(code);
  if (!room) throw new Error('존재하지 않는 방입니다');
  return room;
}

// 클라이언트가 이미 trim/대문자 변환을 하지만, 소켓 이벤트는 원칙적으로 클라이언트를
// 신뢰할 수 없으므로(직접 payload를 조작해서 보낼 수도 있음) 서버에서도 한 번 더 정리한다.
// 특히 방 코드 앞뒤에 공백/개행이 붙어 있으면(복사-붙여넣기 흔한 실수) 방을 못 찾는
// 원인이 되므로 서버 쪽에서도 반드시 trim 후 비교해야 한다.
function cleanRoomCode(code) {
  return String(code || '').trim().toUpperCase();
}
function cleanName(name) {
  return String(name || '').trim() || '플레이어';
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ name }, cb) => {
    try {
      const room = new Room();
      const playerId = room.addPlayer(cleanName(name), socket.id);
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
      const room = getRoomOrFail(cleanRoomCode(roomCode));
      const playerId = room.addPlayer(cleanName(name), socket.id);
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
      const room = getRoomOrFail(cleanRoomCode(roomCode));
      room.reconnectPlayer(playerId, socket.id);
      socketMeta.set(socket.id, { roomCode: room.code, playerId });
      socket.join(room.code);
      cb({ ok: true, roomCode: room.code, playerId });
      broadcast(room);
    } catch (e) {
      cb({ ok: false, error: e.message });
    }
  });

  // 대기방(게임 시작 전)에서 나가기
  socket.on('room:leave', (_, cb) => {
    const ctx = withRoom();
    if (!ctx) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    try {
      const code = ctx.room.code;
      const name = ctx.room.playerName(ctx.playerId); // removePlayer 전에 미리 이름을 기억해둔다
      ctx.room.removePlayer(ctx.playerId);
      socketMeta.delete(socket.id);
      socket.leave(code);
      if (ctx.room.players.length === 0) {
        // 방에 남은 사람이 아무도 없으면(대기방에서 마지막 한 명까지 나간 경우), 이 Room
        // 객체를 그대로 rooms Map에 남겨두지 않고 지운다. room:destroy는 방을 지울 때
        // rooms.delete(code)를 하는데, room:leave로 방이 똑같이 비어도 그 정리가 빠져
        // 있었다(형제 경로 중 하나만 마무리 정리를 빼먹은, 지금까지 반복된 패턴과 같은 종류).
        // 안 지우면 아무도 안 쓰는 빈 방 객체가 서버가 켜져 있는 내내 메모리에 계속
        // 쌓이고, 그 방 코드도 영원히 재사용 못 하게 묶여버린다.
        rooms.delete(code);
        clearAutoPlayTimer(code);
      } else {
        ctx.room.addLog(`${name}님이 방을 나갔습니다.`);
        broadcast(ctx.room);
      }
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
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
      } else if (e && e.code === 'NEED_CHOICE2') {
        // 덱에서 뒤집은 카드가 바닥의 같은 월 2장과 매치되는 드문 경우: 선택 대기
        // (여기까지 오면서 이미 일부 상태가 바뀌었으므로 다른 클라이언트에게도 반영해둔다)
        // 선택이 끝나기 전이라도, 구경하는 다른 플레이어들은 카드가 덱에서 뒤집혀
        // 나오는 애니메이션을 바로 볼 수 있도록 미리 이벤트를 하나 남겨둔다.
        // handCardId도 같이 넘겨야 손패가 "손에서 바닥으로 내려앉는" 장면이 그려진다(없으면
        // 이 카드가 이번 턴의 행위자인지 몰라 그냥 자리만 옮긴 카드 취급을 받는다).
        ctx.room.pushEvent('deck_reveal', ctx.playerId, {
          handCardId: e.handCardId || null, flippedCardId: e.flippedCardId || null,
          bonusDeckIds: e.bonusDeckIds || [],
        });
        // 이 중간 장면이 실제로 화면에 나갔음을 기록 - 선택 후 마무리(resolveChoice2)는 이걸 보고
        // 손패를 "이미 바닥에 있던 카드"로 쓸어갈지, "손에서 곧장 나오는 카드"로 그릴지 정한다.
        if (ctx.room.round && ctx.room.round.pendingChoice2) ctx.room.round.pendingChoice2.revealed = true;
        broadcast(ctx.room);
        cb?.({ ok: false, needChoice2: true, matches: e.matches });
      } else {
        cb?.({ ok: false, error: e.message });
      }
    }
  });

  // NEED_CHOICE2로 대기 중이던 선택(덱카드 vs 바닥 2장 매치)을 마무리
  socket.on('game:resolveChoice2', ({ chosenId }, cb) => {
    const ctx = withRoom();
    if (!ctx) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    try {
      const result = ctx.room.resolveChoice2(ctx.playerId, chosenId);
      broadcast(ctx.room);
      cb?.({ ok: true, result });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // 보너스패를 손패에서 냄: 상대 피 1장씩 획득 + 덱에서 한 장 더 뽑음. 턴은 안 끝남.
  socket.on('game:playBonus', ({ cardId }, cb) => {
    const ctx = withRoom();
    if (!ctx) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    try {
      const result = ctx.room.playBonusCard(ctx.playerId, cardId);
      broadcast(ctx.room);
      cb?.({ ok: true, result });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
    }
  });

  // 9월 국화(열끗) 카드를 열끗<->쌍피로 전환. 언제든(자기 차례가 아니어도) 가능.
  socket.on('game:toggleFlex', ({ cardId }, cb) => {
    const ctx = withRoom();
    if (!ctx) return cb?.({ ok: false, error: '방을 찾을 수 없습니다' });
    try {
      ctx.room.toggleFlex(ctx.playerId, cardId);
      broadcast(ctx.room);
      cb?.({ ok: true });
    } catch (e) {
      cb?.({ ok: false, error: e.message });
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
      // 판돈(점당 금액)은 정산 금액에 직접 영향을 주는 설정이라, 다른 host-only 액션들과
      // 마찬가지로 호스트만 바꿀 수 있어야 한다. 이 체크가 빠져 있으면 호스트가 아닌 누구나
      // (심지어 게임 도중에) 몰래 판돈을 바꿔치기할 수 있었다.
      const player = ctx.room.players.find((p) => p.id === ctx.playerId);
      if (!player?.isHost) throw new Error('호스트만 점당 금액을 바꿀 수 있습니다');
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
      clearAutoPlayTimer(code);
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
      // 이 플레이어가 이 소켓이 끊기기 전에 이미 다른(새) 소켓으로 room:rejoin을 마쳤다면,
      // p.socketId는 그 새 소켓 id로 바뀌어 있다(reconnectPlayer). 그런데 예전 소켓의
      // disconnect 이벤트가 그보다 늦게 도착하면(모바일 백그라운드/포그라운드 전환이나 잠깐의
      // 네트워크 끊김 중 새 연결이 먼저 붙는 경우 흔함) - p.socketId 확인 없이 무조건
      // connected = false로 덮어써버려서, 실제로는 새 소켓으로 멀쩡히 연결돼 있는 사람이
      // 화면에 회색(끊김)으로 표시되고, 심지어 호스트였다면 다른 사람에게 호스트가
      // 넘어가버리는 문제가 있었다. 지금 이 소켓이 여전히 그 플레이어의 "현재" 소켓일
      // 때만 끊김 처리를 한다.
      if (p && p.socketId === socket.id) {
        p.connected = false;
        // 끊긴 사람이 호스트였으면, 접속 중인 다른 사람에게 호스트를 넘겨서 방이 영구히
        // 멈추지 않게 한다(게임 시작/판 무효화/방 폭파/다음 판 시작이 전부 호스트 전용이라,
        // 호스트가 안 돌아오면 아무도 그 버튼들을 못 누르게 되는 문제였다).
        if (p.isHost) {
          const nextHost = room.players.find((pl) => pl.id !== p.id && pl.connected);
          if (nextHost) {
            p.isHost = false;
            nextHost.isHost = true;
            room.addLog(`호스트가 접속을 끊어, ${nextHost.name}님이 새 호스트가 되었습니다.`);
          }
        }
      }
      broadcast(room);
    }
    socketMeta.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`고스톱 서버 실행중: http://localhost:${PORT}`);
});

// 자동 진행 로직(performAutoPlay/scheduleAutoPlayIfNeeded)은 순수하게 Room 인스턴스만
// 받아서 동작하므로(소켓이 필요 없음), room.test.js 스타일의 빠르고 결정적인 단위 테스트로
// 직접 검증할 수 있게 내보낸다. `rooms`(code -> Room)도 함께 내보내서, 빈 방이 실제로
// rooms Map에서 지워지는지(메모리 누수 회귀 테스트) 소켓 왕복만으로는 확인하기 까다로운
// 내부 상태를 테스트에서 직접 들여다볼 수 있게 한다. 이 모듈은 require되는 순간 실제로
// listen()까지 해버리므로(테스트에서도 socket.test.js가 이미 이 방식을 쓰고 있음) 이
// export 자체는 런타임 동작에 영향을 주지 않는다 - 그냥 참조를 추가로 노출할 뿐이다.
module.exports = { performAutoPlay, scheduleAutoPlayIfNeeded, rooms };

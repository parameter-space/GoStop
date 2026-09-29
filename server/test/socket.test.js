// 실제 소켓 레이어(server/index.js)를 그대로 띄워서, room.js 단위 테스트로는 확인할 수 없는
// 부분(누가 호스트인지 같은 권한 체크는 index.js의 소켓 핸들러 쪽에 있다)을 검증한다.
// server/index.js를 재구현하지 않고 그대로 require해서, 실제 배포되는 코드와 테스트가
// 어긋날 위험이 없게 한다.
const assert = require('assert');
const { io: ioClient } = require('socket.io-client');
const { Room } = require('../room');
const { buildDeck } = require('../deck');

const PORT = 39231; // 테스트 전용 고정 포트(충돌 가능성이 낮은 값)
process.env.PORT = String(PORT);
// 접속 끊긴 사람 자동 진행 타이머를 실제로(몇십 초씩) 기다릴 수 없으니 테스트용으로 짧게 줄인다
const AUTO_PLAY_DELAY_MS = 150;
process.env.AUTO_PLAY_DELAY_MS = String(AUTO_PLAY_DELAY_MS);
// performAutoPlay/scheduleAutoPlayIfNeeded는 소켓 없이 Room 인스턴스만으로 동작하는 순수
// 함수라, 실제 소켓 왕복 없이도 이 파일 안에서 직접 단위 테스트할 수 있게 index.js가 내보낸다.
const { performAutoPlay, rooms } = require('../index'); // 이 시점에 실제 server/index.js가 그대로 listen()까지 실행됨

function section(name, fn) {
  return fn()
    .then(() => console.log(`✅ ${name}`))
    .catch((e) => {
      console.error(`❌ ${name}`);
      console.error(e);
      process.exitCode = 1;
    });
}

const url = `http://localhost:${PORT}`;

function connectAndCreate(name) {
  return new Promise((resolve) => {
    const socket = ioClient(url, { transports: ['websocket'] });
    socket.on('connect', () => {
      socket.emit('room:create', { name }, (res) => resolve({ socket, res }));
    });
  });
}
function connectAndJoin(name, roomCode) {
  return new Promise((resolve) => {
    const socket = ioClient(url, { transports: ['websocket'] });
    socket.on('connect', () => {
      socket.emit('room:join', { roomCode, name }, (res) => resolve({ socket, res }));
    });
  });
}
function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

// conn({socket, res})에 실시간으로 들어오는 room:state를 계속 최신값으로 기록해둔다.
// (아주 첫 broadcast 한두 개는 리스너를 붙이기 전에 지나갔을 수 있지만, 이후 것들은
// 전부 잡히므로 "게임 시작 이후, disconnect 이후" 같은 시점의 상태를 확인하기엔 충분하다)
function trackState(conn) {
  conn.latestState = null;
  conn.socket.on('room:state', (s) => { conn.latestState = s; });
}

async function waitUntil(fn, { timeout = 3000, interval = 80 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

(async () => {
  const host = await connectAndCreate('Host');
  const guest = await connectAndJoin('Guest', host.res.roomCode);

  await section('호스트가 아닌 참가자는 점당 금액을 바꿀 수 없다', async () => {
    const res = await emit(guest.socket, 'game:setPointValue', { value: 999999 });
    assert.strictEqual(res.ok, false, '호스트가 아닌데도 점당 금액 변경이 성공하면 안 됨(정산액에 영향을 주는 설정)');
    assert.match(res.error, /호스트/);
  });

  await section('호스트는 점당 금액을 바꿀 수 있다', async () => {
    const res = await emit(host.socket, 'game:setPointValue', { value: 500 });
    assert.strictEqual(res.ok, true);
  });

  await section('호스트가 아닌 참가자는 게임을 시작할 수 없다', async () => {
    const res = await emit(guest.socket, 'game:start', {});
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /호스트/);
  });

  host.socket.close();
  guest.socket.close();

  await section('게임 도중 호스트가 접속을 끊으면 접속 중인 다른 사람에게 호스트가 넘어간다', async () => {
    const h = await connectAndCreate('HostB');
    const g = await connectAndJoin('GuestB', h.res.roomCode);
    trackState(h);
    trackState(g);

    await emit(h.socket, 'game:start', {});
    const started = await waitUntil(() => g.latestState && g.latestState.round);
    assert.ok(started, '게임 시작 상태가 게스트에게 전달되어야 함');

    h.socket.close(); // 호스트가 접속을 끊음

    const reassigned = await waitUntil(() => {
      const p = g.latestState?.players.find((pl) => pl.name === 'GuestB');
      return p?.isHost === true;
    });
    assert.ok(reassigned,
      '호스트가 끊겼는데 아무도 새 호스트가 안 되면, 게임 시작/판 무효화/방 폭파/다음 판 시작을 ' +
      '아무도 못 누르는 방이 영구히 멈춰버린다');

    g.socket.close();
  });

  await section('접속이 끊긴 사람의 차례에서는 서버가 자동으로 진행해 게임이 멈추지 않는다', async () => {
    const h = await connectAndCreate('HostC');
    const g = await connectAndJoin('GuestC', h.res.roomCode);
    trackState(h);
    trackState(g);

    await emit(h.socket, 'game:start', {});
    const started = await waitUntil(() => g.latestState && g.latestState.round);
    assert.ok(started, '게임 시작 상태가 게스트에게 전달되어야 함');

    const state = g.latestState;
    const currentActorId = state.round.currentActor;
    const hostId = state.players.find((p) => p.name === 'HostC').id;
    const isHostTurn = hostId === currentActorId;
    const turnConn = isHostTurn ? h : g;
    const otherConn = isHostTurn ? g : h;

    turnConn.socket.close(); // 지금 차례인 사람이 접속을 끊음

    // 자동 진행(들)이 체이닝될 수 있으므로(카드 낸 직후 바로 고/스톱 자격이 되면 그 응답까지도
    // 자동으로 처리됨), 정확한 횟수를 가정하지 않고 "결국 풀리는지"만 폭넓게 확인한다.
    const unstuck = await waitUntil(() => {
      const st = otherConn.latestState;
      if (!st || !st.round) return false;
      return st.round.currentActor !== currentActorId || st.round.phase === 'round-end';
    }, { timeout: AUTO_PLAY_DELAY_MS * 4 + 2000 });

    assert.ok(unstuck,
      '접속 끊긴 사람 차례에서 일정 시간 뒤 자동으로 진행되지 않으면 상대방은 게임이 영구히 멈춘다');
    assert.ok(otherConn.latestState.log.some((l) => l.message.includes('자동으로')),
      '자동으로 진행됐다는 로그가 남아야 함(플레이어가 뭐가 어떻게 된 건지 알 수 있어야 하므로)');

    otherConn.socket.close();
  });

  await section('덱에서 뒤집은 카드가 바닥 2장과 매치되어(NEED_CHOICE2) 선택을 기다리는 사람이 접속을 끊어도, 자동 진행으로 게임이 풀린다', async () => {
    // 이 상황(pendingChoice2)은 실전에서 무작위 셔플로만 드물게 재현되므로, 소켓 왕복
    // 대신 Room 상태를 직접 구성해 performAutoPlay를 바로 호출하는 결정적 단위 테스트로
    // 검증한다(scheduleAutoPlayIfNeeded/performAutoPlay는 소켓 없이 Room만으로 동작함).
    const deck = buildDeck();
    const byId = Object.fromEntries(deck.map((c) => [c.id, c]));

    const room = new Room();
    room.players.push({ id: 'a', name: 'A', socketId: 's-a', connected: false, isHost: true });
    room.players.push({ id: 'b', name: 'B', socketId: 's-b', connected: true, isHost: false });
    room.ledger.a = 0;
    room.ledger.b = 0;
    room.roundNumber = 1;
    room.round = {
      deck: [],
      hand: { a: [], b: [byId['1-pi-a']] }, // a는 이미 손패를 냈고(그 결과 덱 플립으로 pendingChoice2가 걸림), b는 아직 낼 카드가 있음
      floor: [byId['5-tti'], byId['5-pi-a']],
      players: ['a', 'b'].map((id) => ({
        id, captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [],
        bombCount: 0, hasCalledGo: false, goCount: 0, scoreAtLastGo: 0,
      })),
      turnOrder: ['a', 'b'],
      turnIndex: 0, // advanceTurn이 아직 안 불렸으므로(pendingChoice2 대기 중) 여전히 a 차례
      phase: 'playing',
      pendingChoice: null,
      pendingGoStop: null,
      pendingChoice2: {
        playerId: 'a', flippedCard: byId['5-yeolkkeut'], matches: [byId['5-tti'], byId['5-pi-a']],
        captured: [], events: [], step1Captured: false, step1Month: null,
      },
      resultLog: [],
      lastEvent: null,
    };

    performAutoPlay(room, 'a');

    assert.strictEqual(room.round.pendingChoice2, null,
      'pendingChoice2가 그대로 남아있으면, 이 상태를 풀 수 있는 사람(a)이 끊긴 이상 아무도 다음으로 못 넘어가 게임이 영구히 멈춘다');
    assert.ok(!room.round.floor.some((c) => c.id === '5-tti'),
      '선택된(첫 번째 후보) 바닥 카드가 실제로 제거되어야 함');
    assert.strictEqual(room.currentActorId(), 'b', '선택이 풀린 뒤 턴이 다음 사람(b)에게 넘어가야 함');
    assert.ok(room.log.some((l) => l.message.includes('자동으로')),
      '자동으로 진행됐다는 로그가 남아야 함');
  });

  await section('예전 소켓이 재접속 이후 뒤늦게 끊겨도, 이미 재접속한 사람이 다시 끊김으로 표시되면 안 된다', async () => {
    const h = await connectAndCreate('HostD');
    const g = await connectAndJoin('GuestD', h.res.roomCode);
    trackState(g);

    const oldSocket = h.socket;
    const roomCode = h.res.roomCode;
    const playerId = h.res.playerId;

    // 호스트가 새 소켓으로 재접속(예: 페이지 새로고침, 모바일 백그라운드->포그라운드 전환).
    // 이 시점에 room.js의 player.socketId가 새 소켓으로 바뀐다.
    const newSocket = ioClient(url, { transports: ['websocket'] });
    await new Promise((resolve) => newSocket.on('connect', resolve));
    const rejoinRes = await emit(newSocket, 'room:rejoin', { roomCode, playerId });
    assert.strictEqual(rejoinRes.ok, true);

    const reconnected = await waitUntil(() => {
      const p = g.latestState?.players.find((pl) => pl.id === playerId);
      return p?.connected === true;
    });
    assert.ok(reconnected, '재접속 상태가 게스트에게 전달되어야 함');

    // 예전 소켓이 그제서야 뒤늦게 끊김 - 실제 재접속은 이미 끝난 뒤라 이 disconnect는 낡은 신호다
    oldSocket.close();
    await new Promise((r) => setTimeout(r, 300)); // 낡은 disconnect가 서버에 도착할 시간을 줌

    const p = g.latestState.players.find((pl) => pl.id === playerId);
    assert.strictEqual(p.connected, true,
      '이미 새 소켓으로 재접속한 플레이어가 예전 소켓의 뒤늦은 disconnect 때문에 다시 끊김으로 표시되면 안 됨');
    assert.strictEqual(p.isHost, true, '재접속한 호스트가 낡은 disconnect 때문에 호스트 자리를 잃으면 안 됨');

    newSocket.close();
    g.socket.close();
  });

  await section('대기방에서 마지막 한 명까지 나가면, 그 방이 rooms 목록에서 실제로 지워진다', async () => {
    const h = await connectAndCreate('HostE');
    const roomCode = h.res.roomCode;
    assert.ok(rooms.has(roomCode), '방 생성 직후에는 rooms Map에 있어야 함');

    const leaveRes = await emit(h.socket, 'room:leave', {});
    assert.strictEqual(leaveRes.ok, true);

    assert.ok(!rooms.has(roomCode),
      '마지막 남은 사람까지 나갔는데도 빈 Room 객체가 rooms Map에 그대로 남아있으면, ' +
      '아무도 안 쓰는 방들이 서버가 오래 켜져 있는 동안 계속 쌓여 메모리를 낭비한다');

    h.socket.close();
  });

  console.log('\n소켓 권한 테스트 완료');
  process.exit(process.exitCode || 0); // require('../index')가 서버를 listen 중이라 프로세스가 안 끝나서 명시적으로 종료
})();

// 서버가 떠 있는 상태에서 3명이 방을 만들고, 규칙에 맞는 카드를 무작위로 계속 내면서
// 라운드가 크래시 없이 끝까지(승리 또는 나가리) 진행되는지 확인하는 통합 스모크 테스트.
const { io } = require('socket.io-client');

const URL = process.env.URL || 'http://localhost:3311';
const N = 3;

function connectPlayer(i) {
  return new Promise((resolve) => {
    const socket = io(URL, { transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
  });
}

function emit(socket, event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

(async () => {
  const sockets = [];
  for (let i = 0; i < N; i++) sockets.push(await connectPlayer(i));

  const states = {}; // socket.id -> latest state
  sockets.forEach((s) => s.on('room:state', (st) => { states[s.id] = st; }));

  const create = await emit(sockets[0], 'room:create', { name: 'P0' });
  if (!create.ok) throw new Error('방 생성 실패: ' + create.error);
  const roomCode = create.roomCode;
  console.log('방 생성:', roomCode);

  for (let i = 1; i < N; i++) {
    const res = await emit(sockets[i], 'room:join', { roomCode, name: 'P' + i });
    if (!res.ok) throw new Error('참가 실패: ' + res.error);
  }

  await new Promise((r) => setTimeout(r, 200));

  const startRes = await emit(sockets[0], 'game:start');
  if (!startRes.ok) throw new Error('시작 실패: ' + startRes.error);
  console.log('게임 시작됨');

  let rounds = 0;
  let turns = 0;
  const maxTurns = 500;

  while (rounds < 2 && turns < maxTurns) {
    await new Promise((r) => setTimeout(r, 30));
    turns++;
    const state = states[sockets[0].id];
    if (!state || !state.round) continue;
    const round = state.round;

    if (round.phase === 'round-end') {
      rounds++;
      console.log(`--- ${rounds}번째 라운드 종료: ${round.lastResult.result} ---`);
      if (rounds >= 2) break;
      const nextRes = await emit(sockets[0], 'game:nextRound');
      if (!nextRes.ok) throw new Error('다음 판 시작 실패: ' + nextRes.error);
      continue;
    }

    if (round.pendingGoStop) {
      const actorIdx = round.turnOrder.indexOf(round.pendingGoStop.playerId);
      const decision = round.pendingGoStop.score.total >= 10 || Math.random() < 0.5 ? 'stop' : 'go';
      const res = await emit(sockets[actorIdx], 'game:goStop', { decision });
      if (!res.ok) throw new Error('고스톱 실패: ' + res.error);
      console.log(`  P${actorIdx} ${decision} (점수 ${round.pendingGoStop.score.total})`);
      continue;
    }

    const actorId = round.currentActor;
    const actorIdx = round.turnOrder.indexOf(actorId);
    const actorState = states[sockets[actorIdx].id];
    const myHand = actorState.round.myHand;
    if (!myHand.length) continue;
    const card = myHand[Math.floor(Math.random() * myHand.length)];

    const res = await emit(sockets[actorIdx], 'game:playCard', { cardId: card.id });
    if (res.ok) continue;
    if (res.needChoice) {
      const chosen = res.matches[0];
      const res2 = await emit(sockets[actorIdx], 'game:playCard', { cardId: card.id, chosenFloorId: chosen.id });
      if (!res2.ok) throw new Error('선택 후 실패: ' + res2.error);
    } else {
      throw new Error('플레이 실패: ' + res.error);
    }
  }

  if (rounds < 2) throw new Error('제한 턴 안에 라운드가 끝나지 않았습니다 (턴=' + turns + ')');

  console.log('\n✅ 스모크 테스트 통과: 2개 라운드가 에러 없이 진행됨');
  process.exit(0);
})().catch((e) => {
  console.error('❌ 스모크 테스트 실패:', e);
  process.exit(1);
});

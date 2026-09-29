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

  // playerId(서버가 부여한 nanoid) -> sockets[] 인덱스. sockets[]는 "누가 먼저 접속했는지"
  // (P0=방장, P1, P2 순)로 고정된 순서인데, round.turnOrder는 매 판마다 무작위로 정해지는
  // 선(先)을 기준으로 회전한다(gostop_rules.md/room.js startRound 참고) - 그래서
  // round.turnOrder.indexOf(actorId)가 주는 값은 "이번 판에서 몇 번째로 두는 사람인지"일
  // 뿐, sockets[] 안에서 몇 번째로 접속한 사람인지와는 다른 값이다(선이 P0가 아닌 판이면
  // 둘이 어긋나서 완전히 다른 사람의 소켓으로 명령을 보내버려 "당신의 차례가 아닙니다"가
  // 뜬다 - 실제 게임 로직의 버그가 아니라 이 테스트 스크립트 자체의 버그였다). state.players
  // (참가 순서 그대로, 절대 안 바뀜)로 매번 다시 만들어서 항상 정확한 소켓을 찾는다.
  function socketIndexForPlayerId(state, playerId) {
    return state.players.findIndex((p) => p.id === playerId);
  }

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
      const actorIdx = socketIndexForPlayerId(state, round.pendingGoStop.playerId);
      const decision = round.pendingGoStop.score.total >= 10 || Math.random() < 0.5 ? 'stop' : 'go';
      const res = await emit(sockets[actorIdx], 'game:goStop', { decision });
      if (!res.ok) throw new Error('고스톱 실패: ' + res.error);
      console.log(`  P${actorIdx} ${decision} (점수 ${round.pendingGoStop.score.total})`);
      continue;
    }

    const actorId = round.currentActor;
    const actorIdx = socketIndexForPlayerId(state, actorId);
    const actorState = states[sockets[actorIdx].id];
    const myHand = actorState.round.myHand;
    if (!myHand.length) continue;
    const card = myHand[Math.floor(Math.random() * myHand.length)];

    if (card.type === 'bonus') {
      const bonusRes = await emit(sockets[actorIdx], 'game:playBonus', { cardId: card.id });
      if (!bonusRes.ok) throw new Error('보너스패 실패: ' + bonusRes.error);
      // 보너스패를 내면 같은 사람 차례가 유지되며 정식으로 한 장 더 낸다.
      continue;
    }

    const res = await emit(sockets[actorIdx], 'game:playCard', { cardId: card.id });
    if (res.ok) continue;
    if (res.needChoice) {
      const chosen = res.matches[0];
      const res2 = await emit(sockets[actorIdx], 'game:playCard', { cardId: card.id, chosenFloorId: chosen.id });
      if (!res2.ok && !res2.needChoice2) throw new Error('선택 후 실패: ' + res2.error);
      if (res2.needChoice2) {
        const res3 = await emit(sockets[actorIdx], 'game:resolveChoice2', { chosenId: res2.matches[0].id });
        if (!res3.ok) throw new Error('선택2 후 실패: ' + res3.error);
      }
    } else if (res.needChoice2) {
      const chosen2 = res.matches[0];
      const res2 = await emit(sockets[actorIdx], 'game:resolveChoice2', { chosenId: chosen2.id });
      if (!res2.ok) throw new Error('선택2 후 실패: ' + res2.error);
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

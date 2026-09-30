// Room 클래스 단위 테스트: 보너스패 관련 턴 진행 버그(멈춤 현상) 회귀 테스트.
const assert = require('assert');
const { buildDeck } = require('../deck');
const { Room } = require('../room');

function section(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (e) {
    console.error(`❌ ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

// startRound()의 랜덤 배분을 거치지 않고, 원하는 상태를 직접 구성해서 방을 만든다.
function makeRoomWithRound({ playerIds, hand, floor, deck }) {
  const room = new Room();
  playerIds.forEach((id, i) => {
    room.players.push({ id, name: 'P' + i, socketId: 's' + i, connected: true, isHost: i === 0 });
    room.ledger[id] = 0;
  });
  room.roundNumber = 1;
  room.round = {
    deck,
    hand,
    floor,
    players: playerIds.map((id) => ({
      id,
      captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] },
      shakes: [],
      bombCount: 0,
      hasCalledGo: false,
      goCount: 0,
      scoreAtLastGo: 0,
    })),
    turnOrder: playerIds,
    turnIndex: 0,
    phase: 'playing',
    pendingChoice: null,
    pendingGoStop: null,
    resultLog: [],
    lastEvent: null,
  };
  return room;
}

section('보너스패를 냈는데 덱이 말라 손패가 비면, 턴이 멈추지 않고 다음 사람에게 넘어간다', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const room = makeRoomWithRound({
    playerIds: ['a', 'b'],
    hand: { a: [byId['bonus-1']], b: [byId['1-pi-a']] }, // a는 보너스패 딱 1장만 있음
    floor: [byId['3-gwang']],
    deck: [], // 덱이 비어 있어서 보너스패를 내도 새로 못 뽑음
  });

  const result = room.playBonusCard('a', 'bonus-1');

  assert.strictEqual(room.round.hand.a.length, 0, '보너스패를 내고 나면 a의 손패는 완전히 빔');
  assert.notStrictEqual(result.status, 'continue-same-player', '낼 카드가 없는데 같은 사람 턴으로 유지되면 안 됨(멈춤 버그)');
  assert.strictEqual(room.currentActorId(), 'b', '다음 사람(b)에게 턴이 넘어가야 함');
});

section('폭탄 직후 스킵 턴에는 보너스패를 낼 수 없다', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const room = makeRoomWithRound({
    playerIds: ['a', 'b'],
    hand: { a: [byId['bonus-1'], byId['2-pi-a']], b: [byId['1-pi-a']] },
    floor: [byId['3-gwang']],
    deck: [byId['4-pi-a']],
  });
  room.round.players.find((p) => p.id === 'a').skipNextHandPlay = 1;

  assert.throws(() => room.playBonusCard('a', 'bonus-1'), /스킵 턴/, '스킵 턴 중에는 보너스패 거부');
  assert.strictEqual(room.round.hand.a.length, 2, '거부됐으니 손패는 그대로여야 함');
});

section('보너스패를 내고도 손패가 남아 있으면 여전히 같은 사람 차례로 이어진다(정상 케이스)', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const room = makeRoomWithRound({
    playerIds: ['a', 'b'],
    hand: { a: [byId['bonus-1'], byId['2-pi-a']], b: [byId['1-pi-a']] },
    floor: [byId['3-gwang']],
    deck: [byId['4-pi-a']],
  });

  const result = room.playBonusCard('a', 'bonus-1');
  assert.strictEqual(result.status, 'continue-same-player');
  assert.strictEqual(room.currentActorId(), 'a', '손패가 남아있으니 여전히 a 차례');
  assert.strictEqual(room.round.hand.a.length, 2, '보너스패 제거(-1) + 덱에서 드로우(+1) = 그대로 2장');
});

section('덱 뒤집기 2장 매치 선택 대기 중에는 다른 행동(카드 내기 등)을 할 수 없다', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const room = makeRoomWithRound({
    playerIds: ['a', 'b'],
    // 5월 카드를 내면(무매치) 바로 바닥에 깔리고, 이어서 덱에서 3월이 뒤집혀
    // 바닥의 3월 2장과 매치 -> NEED_CHOICE2로 대기 상태가 된다.
    hand: { a: [byId['5-pi-a'], byId['2-pi-a']], b: [byId['1-pi-a']] },
    floor: [byId['3-gwang'], byId['3-tti']],
    deck: [byId['3-pi-a']],
  });

  let threw = null;
  try {
    room.playCard('a', '5-pi-a');
  } catch (e) {
    threw = e;
  }
  assert.ok(threw && threw.code === 'NEED_CHOICE2');
  assert.ok(room.round.pendingChoice2, '선택 대기 상태가 저장되어야 함');

  // 선택을 마치기 전에 같은 사람이 다른 카드를 또 내려고 하면 거부되어야 한다
  // (거부하지 않으면 pendingChoice2가 가리키는 상태와 어긋나는 중복 진행이 생길 수 있음)
  assert.throws(() => room.playCard('a', '2-pi-a'), /먼저 선택/, '선택 대기 중 카드 내기는 거부되어야 함');
  assert.throws(() => room.playBomb('a', 5), /먼저 선택/, '선택 대기 중 폭탄도 거부되어야 함');
  assert.throws(() => room.declareShake('a', 5), /먼저 선택/, '선택 대기 중 흔들기도 거부되어야 함');

  // 정상적으로 선택을 완료하면 이후에는 다시 정상 진행 가능
  const result = room.resolveChoice2('a', '3-gwang');
  assert.strictEqual(room.round.pendingChoice2, null);
  assert.ok(result);
});

section('선택 대기 중(pendingChoice2)에 호스트가 판을 무효 처리하면, 뒤늦은 선택은 거부되어야 한다', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const room = makeRoomWithRound({
    playerIds: ['a', 'b'],
    hand: { a: [byId['5-pi-a'], byId['2-pi-a']], b: [byId['1-pi-a']] },
    floor: [byId['3-gwang'], byId['3-tti']],
    deck: [byId['3-pi-a']],
  });

  try { room.playCard('a', '5-pi-a'); } catch (e) { /* NEED_CHOICE2로 대기 상태가 됨 */ }
  assert.ok(room.round.pendingChoice2, '선택 대기 상태가 저장되어야 함');

  // 호스트가 "이 판 무효 처리"를 누른 것을 흉내낸다(forceEndRound는 pendingChoice2를 지우지
  // 않고 phase만 round-end로 바꾼다 - 실제 room.forceEndRound()와 동일한 상태)
  room.round.phase = 'round-end';

  assert.throws(() => room.resolveChoice2('a', '3-gwang'), /이미 끝난/,
    '판이 이미 끝났는데도 뒤늦게 도착한 선택을 받아주면, 이미 정산이 끝난 판의 먹은 패/바닥 상태를 ' +
    '사후에 몰래 바꿔버리게 된다(다른 행동들은 assertActionAllowed로 phase를 검사하는데 이 메서드만 빠져 있었음)');
});

section('폭탄으로 손패가 완전히 비어도, 남은 스킵 턴을 건너뛰지 않고 처리한 뒤에야 라운드가 끝난다', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const room = makeRoomWithRound({
    playerIds: ['a', 'b'],
    // a는 5월 카드 3장이 손패 전부라 폭탄을 내면 손패가 완전히 빔. b는 이미 손패가 없음.
    hand: { a: [byId['5-yeolkkeut'], byId['5-tti'], byId['5-pi-a']], b: [] },
    floor: [byId['5-pi-b']], // 5월 네 번째 카드 -> 폭탄 가능
    deck: [],
  });

  const bombResult = room.playBomb('a', 5);
  assert.notStrictEqual(bombResult.status, 'round-end',
    '스킵 턴 빚이 남아있는데 라운드가 먼저 끝나버리면 안 됨(폭탄 낸 사람의 덱 뒤집기 턴이 사라지는 버그)');
  assert.strictEqual(room.round.hand.a.length, 0, '폭탄으로 손패 3장을 전부 냈으니 손패는 빔');
  assert.strictEqual(room.currentActorId(), 'a',
    'b는 더 할 게 없으니, 스킵 턴 빚이 있는 a에게 다시 차례가 와야 함');

  // 손패가 비어 클릭할 카드가 없으므로, 클라이언트는 cardId 없이 스킵 턴을 제출한다
  const skipResult = room.playCard('a', null);
  assert.strictEqual(skipResult.status, 'round-end', '스킵 턴까지 처리하고 나서야 라운드가 끝남(나가리)');
});

section('폭탄을 내면 lastEvent에 손패에서 나간 카드 3장의 id(handCardIds)가 담겨야 한다', () => {
  // client.js의 애니메이션은 evt.handCardId(단수)/flippedCardId로 "이 카드가 어디서 왔는지"를
  // 찾는데, 폭탄은 한 번에 손패 3장이 동시에 나가는 유일한 행동이라 단수 필드로는 표현이 안 된다.
  // 이 필드가 빠져 있으면 클라이언트가 그 3장의 출발점(손패)을 전혀 알 수 없어서, 폭탄으로
  // 먹은 카드들이 이동 애니메이션 없이 그냥 결과 화면에 나타나기만 하는(가장 화려해야 할 순간이
  // 오히려 가장 밋밋해지는) 문제가 있었다.
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const room = makeRoomWithRound({
    playerIds: ['a', 'b'],
    hand: { a: [byId['5-yeolkkeut'], byId['5-tti'], byId['5-pi-a'], byId['1-pi-a']], b: [byId['2-pi-a']] },
    floor: [byId['5-pi-b']], // 5월 네 번째 카드 -> 폭탄 가능
    deck: [byId['3-pi-a']],
  });

  room.playBomb('a', 5);
  const ids = room.round.lastEvent.handCardIds;
  assert.ok(Array.isArray(ids) && ids.length === 3, 'handCardIds는 3장짜리 배열이어야 함');
  assert.deepStrictEqual(
    [...ids].sort(),
    ['5-pi-a', '5-tti', '5-yeolkkeut'].sort(),
    '폭탄으로 실제로 손에서 나간 5월 카드 3장의 id와 정확히 일치해야 함',
  );
});

section('고/스톱 응답을 기다리는 동안에는 카드/폭탄/흔들기를 더 낼 수 없다', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const room = makeRoomWithRound({
    playerIds: ['a', 'b'],
    hand: { a: [byId['1-pi-a']], b: [byId['2-pi-a']] },
    floor: [],
    deck: [],
  });
  // currentActorId()는 여전히 'a'인 채로(턴이 안 넘어감), 고/스톱 응답 대기 상태로 만든다
  room.round.phase = 'await-gostop';
  room.round.pendingGoStop = { playerId: 'a', score: { total: 7 } };

  assert.throws(() => room.playCard('a', '1-pi-a'), /지금은/,
    '고/스톱 응답 대기 중에 카드를 또 낼 수 있으면 안 됨(phase 체크 누락 버그)');
  assert.throws(() => room.playBomb('a', 1), /지금은/);
  assert.throws(() => room.declareShake('a', 1), /지금은/);
});

section('고를 선언하면 scoreAtLastGo는 프롬프트 당시 스냅샷이 아니라 항상 최신 점수로 기록된다', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const room = makeRoomWithRound({
    playerIds: ['a', 'b'],
    hand: { a: [], b: [] },
    floor: [],
    deck: [],
  });
  const rp = room.round.players.find((p) => p.id === 'a');
  // 프롬프트가 뜬 시점엔 1점이었다는 오래된 스냅샷(예: 국화 열끗<->쌍피 전환처럼 "언제든"
  // 가능한 조작이 고/스톱 응답을 기다리는 사이에 끼어들어 실제 점수가 바뀐 상황을 흉내)
  room.round.phase = 'await-gostop';
  room.round.pendingGoStop = { playerId: 'a', score: { total: 1 } };
  rp.captured.tti = [byId['1-tti'], byId['2-tti'], byId['3-tti']]; // 홍단 완성 -> 실제로는 3점

  room.goStopDecision('a', 'go');
  assert.strictEqual(rp.scoreAtLastGo, 3, '스냅샷(1점)이 아니라 최신 점수(3점)를 기준으로 삼아야 함');
});

section('스톱을 선언해 이기면, 더 이상 유효하지 않은 고/스톱 대기 상태가 남아있으면 안 된다', () => {
  // 'go' 분기는 r.pendingGoStop = null을 이미 하고 있었지만 'stop' 분기(-> finishRound)는
  // 안 하고 있었다. 클라이언트는 phase를 안 보고 round.pendingGoStop이 내 것이기만 하면
  // modal-gostop을 띄우는 구조라서, 이걸 안 지우면 방금 스톱을 눌러 이긴 사람 화면에
  // 결과 모달(modal-result)과 고/스톱 모달(modal-gostop)이 동시에 뜨는 문제가 있었다.
  const room = makeRoomWithRound({
    playerIds: ['a', 'b'],
    hand: { a: [], b: [] },
    floor: [],
    deck: [],
  });
  room.round.phase = 'await-gostop';
  room.round.pendingGoStop = { playerId: 'a', score: { total: 7 } };

  room.goStopDecision('a', 'stop');
  assert.strictEqual(room.round.phase, 'round-end');
  assert.strictEqual(room.round.pendingGoStop, null,
    'stop으로 판이 끝났으면 pendingGoStop도 반드시 함께 지워져야 다른 모달과 겹쳐 뜨지 않는다');
});

section('마지막 패(모두 손패 소진)에서 점수가 나면 고/스톱을 묻지 않고 자동으로 스톱(승리)한다', () => {
  // 더 둘 턴이 없는데 고/스톱 창을 띄우면, 고를 누르는 순간 나가리로 처리돼 이긴 판을
  // 날려버릴 수 있었다(실제 고스톱도 막판에는 고를 못 하고 자동 스톱).
  const byId = Object.fromEntries(buildDeck().map((c) => [c.id, c]));
  const room = makeRoomWithRound({
    playerIds: ['a', 'b'],
    hand: { a: [byId['11-pi-a']], b: [] },
    floor: [{ ...byId['11-gwang'], placedBy: 'deck', stuck: false }],
    deck: [],
  });
  const a = room.round.players[0];
  a.captured.gwang.push(byId['1-gwang'], byId['3-gwang'], byId['8-gwang']);
  a.captured.tti.push(byId['1-tti'], byId['2-tti'], byId['3-tti']); // 홍단 3점
  const res = room.playCard('a', '11-pi-a'); // 광 4장(4점) + 홍단(3점) = 7점(맞고 문턱)
  assert.strictEqual(res.status, 'round-end', '마지막 패에서 문턱을 넘으면 곧바로 판이 끝나야 함');
  assert.strictEqual(room.round.lastResult.result, 'win', '나가리가 아니라 승리로 끝나야 함');
  assert.strictEqual(room.round.lastResult.winnerId, 'a');
  assert.strictEqual(room.round.pendingGoStop, null, '고/스톱 대기 상태가 남으면 안 됨');
});

section('고를 부른 뒤 더 점수를 못 낸 채 패가 다 떨어지면 나가리가 아니라 고를 부른 사람이 그대로 이긴다', () => {
  const byId = Object.fromEntries(buildDeck().map((c) => [c.id, c]));
  const room = makeRoomWithRound({
    playerIds: ['a', 'b'],
    hand: { a: [byId['5-pi-a']], b: [] },
    floor: [{ ...byId['9-pi-a'], placedBy: 'deck', stuck: false }],
    deck: [byId['6-pi-a']], // 손패도 뒤집은 패도 짝이 없어 점수가 안 늘어남
  });
  const a = room.round.players[0];
  a.captured.gwang.push(byId['1-gwang'], byId['3-gwang'], byId['8-gwang'], byId['11-gwang']);
  a.captured.tti.push(byId['1-tti'], byId['2-tti'], byId['3-tti']); // 광 4점 + 홍단 3점 = 7점
  a.hasCalledGo = true;
  a.goCount = 1;
  a.scoreAtLastGo = 7;
  room.round.firstGoCallerId = 'a';
  room.round.lastGoCallerId = 'a';
  const res = room.playCard('a', '5-pi-a');
  assert.strictEqual(res.status, 'round-end');
  assert.strictEqual(room.round.lastResult.result, 'win', '나가리가 아니라 승리여야 함');
  assert.strictEqual(room.round.lastResult.winnerId, 'a');
  assert.ok(room.ledger.a > 0 && room.ledger.b < 0, '정산이 실제로 이뤄져야 함');
});

section('아무도 고를 부르지 않았고 아무도 점수를 못 낸 채 패가 다 떨어지면 나가리', () => {
  const byId = Object.fromEntries(buildDeck().map((c) => [c.id, c]));
  const room = makeRoomWithRound({
    playerIds: ['a', 'b'],
    hand: { a: [byId['5-pi-a']], b: [] },
    floor: [{ ...byId['9-pi-a'], placedBy: 'deck', stuck: false }],
    deck: [byId['6-pi-a']],
  });
  const res = room.playCard('a', '5-pi-a');
  assert.strictEqual(res.status, 'round-end');
  assert.strictEqual(room.round.lastResult.result, 'nagari');
});

section('라운드 결과에는 그 판 정산에 실제로 쓰인 점당 금액이 스냅샷으로 남고, 이후 점당 금액이 바뀌어도 그대로 유지된다', () => {
  // setPointValue는 phase를 안 가리고 언제든(라운드 종료 후, 다음 판을 시작하기 전이라도)
  // 호스트가 바꿀 수 있다. client.js의 결과 화면은 이 스냅샷(pointValueAtSettlement)으로
  // 지불액/총 획득을 다시 계산하는데, 만약 서버가 이 값을 안 남기고 클라이언트가 "현재"
  // state.pointValue를 대신 썼다면, 이미 끝난 판의 화면 표시가 그 사이 바뀐 점당 금액
  // 때문에 실제 ledger 반영액과 어긋나 보일 수 있었다(위 발견/수정 참고).
  const room = makeRoomWithRound({
    playerIds: ['a', 'b'],
    hand: { a: [], b: [] },
    floor: [],
    deck: [],
  });
  room.setPointValue(100);
  room.round.phase = 'await-gostop';
  room.round.pendingGoStop = { playerId: 'a', score: { total: 7 } };

  room.goStopDecision('a', 'stop');
  assert.strictEqual(room.round.lastResult.pointValueAtSettlement, 100);

  room.setPointValue(500); // 결과 화면을 보고 있는 동안 호스트가 다음 판 몫으로 미리 바꿈
  assert.strictEqual(room.round.lastResult.pointValueAtSettlement, 100,
    '이미 끝난 판의 결과 스냅샷은 이후 점당 금액 변경의 영향을 받으면 안 된다');
});

section('호스트가 고/스톱 응답 대기 중에 판을 강제 종료해도, 남아있던 고/스톱 대기 상태가 지워진다', () => {
  const room = makeRoomWithRound({
    playerIds: ['a', 'b'],
    hand: { a: [], b: [] },
    floor: [],
    deck: [],
  });
  room.round.phase = 'await-gostop';
  room.round.pendingGoStop = { playerId: 'a', score: { total: 7 } };

  room.forceEndRound();
  assert.strictEqual(room.round.phase, 'round-end');
  assert.strictEqual(room.round.pendingGoStop, null,
    '강제 종료로 판이 끝났으면 pendingGoStop도 함께 지워야 결과 모달과 고/스톱 모달이 동시에 뜨지 않는다');
});

section('3인 이상 판에서, 고박은 이 판에서 "처음" 고를 부른 사람 한 명에게만 적용된다', () => {
  // gostop_rules.md 7장: "고박은... 처음 고를 선언한 사람이 다른 패자들의 몫까지 책임지고
  // 배로 지불한다" - 즉 고박 대상은 이 판에서 가장 먼저 고를 부른 딱 한 명이어야 한다.
  // 3~4인 판에서는 서로 다른 플레이어가 각자 자기 턴에 점수 문턱을 넘겨 고를 부를 수 있는데
  // (a가 먼저 고를 부르고, 그 뒤로 다른 사람이 이어받아 진행하다가 b도 별도로 고를 부르는 식),
  // 예전 코드는 "이 판에서 goCount>0인 사람 전부"를 고박 대상으로 잘못 표시하고 있어서
  // a와 b 둘 다에게 고박이 겹쳐 적용되는 규칙 위반이 있었다.
  const deck = buildDeck();
  const oneCard = (id) => [deck.find((c) => c.id === id)];
  const room = makeRoomWithRound({
    playerIds: ['a', 'b', 'c'],
    // 손패를 하나씩 남겨둬서 isRoundOver()가 참이 되어 goStopDecision('go')가 곧바로
    // 나가리 처리로 새버리지 않게 한다(실제 라운드 진행 흐름은 이 테스트의 관심사가 아님).
    hand: { a: oneCard('1-pi-a'), b: oneCard('2-pi-a'), c: oneCard('3-pi-a') },
    floor: [],
    deck: [],
  });

  room.round.phase = 'await-gostop';
  room.round.pendingGoStop = { playerId: 'a', score: { total: 3 } };
  room.goStopDecision('a', 'go'); // a가 이 판에서 처음으로 고를 부름

  room.round.phase = 'await-gostop';
  room.round.pendingGoStop = { playerId: 'b', score: { total: 3 } };
  room.goStopDecision('b', 'go'); // b도 (a와 별개로) 자기 턴에 고를 부름

  room.round.phase = 'await-gostop';
  room.round.pendingGoStop = { playerId: 'c', score: { total: 3 } };
  const result = room.goStopDecision('c', 'stop'); // c가 스톱을 선언해 승리

  assert.ok(result.settlement.payments.a.reasons.includes('고박'),
    '가장 먼저 고를 부른 a는 고박 대상이어야 함');
  assert.ok(!result.settlement.payments.b.reasons.includes('고박'),
    '나중에 따로 고를 부른 b는 "처음 고를 선언한 사람"이 아니므로 고박 대상이 아니어야 함 ' +
    '(예전엔 goCount>0인 사람 전부가 고박 대상이 되던 버그)');
});

section('게임이 시작된 뒤에는 새 참가자가 들어올 수 없다', () => {
  const room = new Room();
  room.addPlayer('A', 's1');
  room.addPlayer('B', 's2');
  room.startRound();

  assert.throws(() => room.addPlayer('Late', 's3'), /이미 시작/,
    '라운드 시작 후 새 참가자를 받아주면 그 사람은 round.players/turnOrder/hand 어디에도 없는 채로 ' +
    '방 목록에만 추가되어, 클라이언트가 자기 정보를 렌더링하다가(me가 undefined) 뻗어버리는 화면 먹통 버그가 있었다');
  assert.strictEqual(room.players.length, 2, '거부됐으니 참가자 수는 그대로여야 함');
});

section('대기방에서는 나갈 수 있고, 호스트가 나가면 다음 사람에게 호스트가 넘어간다', () => {
  const room = new Room();
  const hostId = room.addPlayer('Host', 's1');
  const guestId = room.addPlayer('Guest', 's2');
  assert.strictEqual(room.players.find((p) => p.id === hostId).isHost, true);

  room.removePlayer(hostId);
  assert.strictEqual(room.players.length, 1, '나간 사람은 목록에서 빠져야 함');
  assert.strictEqual(room.ledger[hostId], undefined, '나간 사람의 정산 기록도 같이 정리되어야 함');
  assert.strictEqual(room.players.find((p) => p.id === guestId).isHost, true,
    '호스트가 나갔으면 남은 사람에게 호스트가 넘어가야 함(안 그러면 아무도 게임을 시작할 수 없는 방이 됨)');
});

section('라운드가 아직 시작되지 않은 방에서 게임 행동을 시도하면, 날것 자바스크립트 에러가 아니라 친절한 메시지로 거부된다', () => {
  // 정상적인 UI로는 라운드가 없을 때 카드 내기/폭탄/흔들기/고스톱/선택/토글 버튼 자체가
  // 안 보이니 도달하지 않지만, 소켓 payload를 직접 조작해 보내는 경우(또는 타이밍 버그로
  // 클라이언트가 화면 전환 전에 이벤트를 먼저 보내는 경우)를 대비한 방어 코드다. 이 가드가
  // 없으면 this.round가 null인 채로 r.phase/r.turnOrder 등에 접근하다가 "Cannot read
  // properties of null" 같은 못 알아들을 에러 문구가 그대로 사용자에게 노출된다.
  const room = new Room();
  room.addPlayer('A', 's1');
  room.addPlayer('B', 's2');
  // 아직 startRound()를 호출하지 않아 room.round === null인 상태

  assert.throws(() => room.playCard('A', 'x'), /진행 중인 판이 없습니다/);
  assert.throws(() => room.playBomb('A', 1), /진행 중인 판이 없습니다/);
  assert.throws(() => room.declareShake('A', 1), /진행 중인 판이 없습니다/);
  assert.throws(() => room.playBonusCard('A', 'x'), /진행 중인 판이 없습니다/);
  assert.throws(() => room.resolveChoice2('A', 'x'), /진행 중인 판이 없습니다/);
  assert.throws(() => room.toggleFlex('A', 'x'), /진행 중인 판이 없습니다/);
  assert.throws(() => room.goStopDecision('A', 'stop'), /진행 중인 판이 없습니다/);
  assert.throws(() => room.forceEndRound(), /진행 중인 판이 없습니다/,
    'forceEndRound도 다른 형제 메서드들과 같은 문구를 써야 하는데, 예전엔 "진행중인"(띄어쓰기 없음)으로 ' +
    '오타가 나 있었고 이미 끝난 판 케이스와 메시지가 뭉뚱그려져 있었다');
});

section('이미 끝난 판을 호스트가 또 강제 종료하려 하면 거부된다', () => {
  const room = new Room();
  room.addPlayer('A', 's1');
  room.addPlayer('B', 's2');
  room.startRound();
  room.round.phase = 'round-end';

  assert.throws(() => room.forceEndRound(), /이미 끝난 판입니다/,
    '판이 없는 경우("진행 중인 판이 없습니다")와 판이 이미 끝난 경우("이미 끝난 판입니다")는 ' +
    'resolveChoice2와 동일하게 서로 다른 문구로 구분되어야 한다');
});

section('이미 진행 중인 판 위에 새 판을 또 시작할 수 없다(중복 클릭/재전송 방지)', () => {
  const room = new Room();
  room.addPlayer('A', 's1');
  room.addPlayer('B', 's2');
  room.startRound();
  const actorBefore = room.currentActorId();

  assert.throws(() => room.startRound(), /이미 진행 중/,
    'game:start/game:nextRound가 호스트 권한만 보고 phase를 안 보면, 중복 호출(더블클릭 등)이 ' +
    '진행 중이던 판을 통째로 덮어써서(turnIndex 리셋) 손패/바닥/점수가 전부 사라지는 문제가 있었다');
  assert.strictEqual(room.currentActorId(), actorBefore, '거부됐으니 진행 중이던 턴 상태는 그대로여야 함');
});

section('판이 끝난 뒤(round-end)에는 다음 판을 정상적으로 시작할 수 있다', () => {
  const room = new Room();
  room.addPlayer('A', 's1');
  room.addPlayer('B', 's2');
  room.startRound();
  room.round.phase = 'round-end'; // 실제로는 finishRound/finishAsNagari/forceEndRound가 이렇게 만듦

  const round2 = room.startRound();
  assert.strictEqual(round2.phase, 'playing', '판이 끝난 뒤에는 다음 판이 정상적으로 시작되어야 함');
  assert.strictEqual(room.roundNumber, 2);
});

section('게임이 시작된 뒤에는 나갈 수 없다', () => {
  const room = new Room();
  const aId = room.addPlayer('A', 's1');
  room.addPlayer('B', 's2');
  room.startRound();

  assert.throws(() => room.removePlayer(aId), /이미 시작/,
    '라운드 중에 this.players에서만 한 명을 빼면 round.players/turnOrder/hand와 어긋나서 정산 등이 깨진다');
  assert.strictEqual(room.players.length, 2);
});

// 사용자 직접 피드백: "항상 방장부터 시작하던데 고쳐봐". 예전엔 startRound()가 매 판마다
// turnOrder를 그냥 this.players 순서(=방 만든 순서, 방장이 항상 맨 앞) 그대로 썼다.
section('새 판마다 선(첫 순서)이 좌석 순서로 한 칸씩 돌아간다', () => {
  const room = new Room();
  room.addPlayer('A', 's1');
  room.addPlayer('B', 's2');
  room.addPlayer('C', 's3');
  const seatIds = room.players.map((p) => p.id);
  const seatIdx = (id) => seatIds.indexOf(id);

  const round1 = room.startRound();
  const dealer1Idx = seatIdx(round1.turnOrder[0]);
  room.round.phase = 'round-end';

  const round2 = room.startRound();
  const dealer2Idx = seatIdx(round2.turnOrder[0]);
  room.round.phase = 'round-end';

  const round3 = room.startRound();
  const dealer3Idx = seatIdx(round3.turnOrder[0]);

  assert.strictEqual(dealer2Idx, (dealer1Idx + 1) % 3, '2판째 선은 좌석 순서로 한 칸 뒤 사람이어야 함');
  assert.strictEqual(dealer3Idx, (dealer1Idx + 2) % 3, '3판째 선은 두 칸 뒤 사람이어야 함');
  // 선만 바뀌는 게 아니라 turnOrder 전체가 그 사람부터 좌석 순서로 이어져야 한다.
  assert.deepStrictEqual(round2.turnOrder, seatIds.map((_, i) => seatIds[(dealer2Idx + i) % 3]));
});

section('방의 첫 판 선(先)은 항상 방장이 아니라 무작위로 정해진다', () => {
  const TRIALS = 200;
  let hostFirstCount = 0;
  for (let i = 0; i < TRIALS; i++) {
    const room = new Room();
    const hostId = room.addPlayer('Host', 's1');
    room.addPlayer('B', 's2');
    room.addPlayer('C', 's3');
    const round = room.startRound();
    if (round.turnOrder[0] === hostId) hostFirstCount++;
  }
  // 완전히 고정(예전 버그)이면 TRIALS와 정확히 같다. 3인 중 무작위 1/3 확률이면 이론치는
  // 약 66.7이고, 통계적 흔들림에 안 깨지도록 넉넉하게 15%~55% 범위로 완화해서 검사한다.
  assert.ok(hostFirstCount < TRIALS,
    '방장이 매번 선이면(예전 버그 재발) 이 값이 항상 TRIALS와 같아야 하는데 그렇지 않아야 정상');
  assert.ok(hostFirstCount > TRIALS * 0.15 && hostFirstCount < TRIALS * 0.55,
    `방장이 선이 되는 비율이 무작위(약 1/3)에서 크게 벗어남: ${hostFirstCount}/${TRIALS}`);
});

console.log('\n방 테스트 완료');

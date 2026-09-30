const assert = require('assert');
const { buildDeck } = require('../deck');
const engine = require('../engine');

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

section('덱은 화투 48장 + 보너스패 2장 = 50장이고 카테고리 합이 맞는다', () => {
  const deck = buildDeck();
  assert.strictEqual(deck.length, 50);
  const byType = {};
  deck.forEach((c) => (byType[c.type] = (byType[c.type] || 0) + 1));
  assert.strictEqual(byType.gwang, 5);
  assert.strictEqual(byType.yeolkkeut, 9);
  assert.strictEqual(byType.tti, 10); // 12월 비띠 포함(색깔 조합엔 미포함이지만 개수엔 포함)
  assert.strictEqual(byType.pi, 24);
  assert.strictEqual(byType.bonus, 2);
  const ids = new Set(deck.map((c) => c.id));
  assert.strictEqual(ids.size, 50, '카드 id 중복 없음');
});

section('가위/피 점수 계산', () => {
  const player = { captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] } };
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));

  // 3광(비광 미포함) = 3점
  player.captured.gwang = [byId['1-gwang'], byId['3-gwang'], byId['8-gwang']];
  let score = engine.computeScore(player);
  assert.strictEqual(score.gwangScore, 3);

  // 비광 포함 3광 = 2점
  player.captured.gwang = [byId['1-gwang'], byId['3-gwang'], byId['12-gwang']];
  score = engine.computeScore(player);
  assert.strictEqual(score.gwangScore, 2);

  // 고도리
  player.captured.gwang = [];
  player.captured.yeolkkeut = [byId['2-yeolkkeut'], byId['4-yeolkkeut'], byId['8-yeolkkeut']];
  score = engine.computeScore(player);
  assert.strictEqual(score.yeolkkeutScore, 5);

  // 청단
  player.captured.yeolkkeut = [];
  player.captured.tti = [byId['6-tti'], byId['9-tti'], byId['10-tti']];
  score = engine.computeScore(player);
  assert.strictEqual(score.ttiScore, 3);

  // 피 10장 이상 (쌍피 포함 계산)
  player.captured.tti = [];
  player.captured.pi = [byId['9-pi-a'], byId['9-pi-b'], byId['11-pi-a'], byId['11-pi-b'], byId['11-pi-c'],
    byId['1-pi-a'], byId['1-pi-b'], byId['2-pi-a'], byId['2-pi-b']]; // 1+1+1+1+2+1+1+1+1=10
  score = engine.computeScore(player);
  assert.strictEqual(score.piScore, 1);
});

section('고 배율 공식', () => {
  assert.deepStrictEqual(engine.goMultiplierInfo(0), { addPoint: 0, multiplier: 1 });
  assert.deepStrictEqual(engine.goMultiplierInfo(1), { addPoint: 1, multiplier: 1 });
  assert.deepStrictEqual(engine.goMultiplierInfo(2), { addPoint: 1, multiplier: 2 });
  assert.deepStrictEqual(engine.goMultiplierInfo(3), { addPoint: 1, multiplier: 4 });
  assert.deepStrictEqual(engine.goMultiplierInfo(4), { addPoint: 1, multiplier: 8 });
});

section('신규 라운드 배분: 인원별 장수 확인 (보너스패 2장 포함 50장)', () => {
  const { deck, hand, floor } = engine.dealNewRound(['a', 'b', 'c']);
  assert.strictEqual(hand.a.length, 7);
  assert.strictEqual(hand.b.length, 7);
  assert.strictEqual(hand.c.length, 7);
  assert.strictEqual(floor.length, 6);
  assert.strictEqual(deck.length, 50 - 21 - 6);
  assert.ok(floor.every((c) => c.type !== 'bonus'), '보너스패는 바닥에 깔리지 않음');

  const two = engine.dealNewRound(['a', 'b']);
  assert.strictEqual(two.hand.a.length, 10);
  assert.strictEqual(two.floor.length, 8);
  assert.strictEqual(two.deck.length, 50 - 20 - 8);
  assert.ok(two.floor.every((c) => c.type !== 'bonus'), '보너스패는 바닥에 깔리지 않음');

  // 4인은 이 프로젝트에서 표준(손패 7장 이하)과 다르게 정한 값(손패 5장/바닥 8장)이라,
  // 2인/3인과 별도로 반드시 확인해야 한다 - 지금까지는 이 조합만 테스트가 없었다.
  const four = engine.dealNewRound(['a', 'b', 'c', 'd']);
  assert.strictEqual(four.hand.a.length, 5);
  assert.strictEqual(four.hand.b.length, 5);
  assert.strictEqual(four.hand.c.length, 5);
  assert.strictEqual(four.hand.d.length, 5);
  assert.strictEqual(four.floor.length, 8);
  assert.strictEqual(four.deck.length, 50 - 20 - 8);
  assert.ok(four.floor.every((c) => c.type !== 'bonus'), '보너스패는 바닥에 깔리지 않음');
});

section('쪽: 무매치 후 뒤집은 패가 방금 낸 패와 일치', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const players = [
    { id: 'a', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [] },
    { id: 'b', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [] },
  ];
  const state = {
    players,
    hand: { a: [byId['5-pi-a']], b: [] },
    floor: [byId['3-gwang']], // 5월과 매치되는 게 없음
    deck: [byId['5-pi-b']], // 뒤집으면 5월과 매치
  };
  const result = engine.playTurn(state, 'a', '5-pi-a');
  assert.ok(result.events.includes('jjok'), '쪽 이벤트 발생해야 함');
  assert.strictEqual(players[0].captured.pi.length, 2);
});

section('뻑: 손패+뒤집은패가 바닥 카드와 3장 겹쳐 보류', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const players = [
    { id: 'a', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [] },
    { id: 'b', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [] },
  ];
  const state = {
    players,
    hand: { a: [byId['7-pi-a']], b: [] },
    floor: [{ ...byId['7-pi-b'], placedBy: 'deck' }],
    deck: [byId['7-tti']], // 같은 월(7월)이 또 뒤집힘 -> 뻑
  };
  const result = engine.playTurn(state, 'a', '7-pi-a');
  assert.ok(result.events.includes('ppeok_formed'));
  assert.strictEqual(players[0].captured.pi.length, 0, '뻑 상태에서는 아무것도 획득하지 않음');
  assert.strictEqual(state.floor.length, 3);
});

section('뻑을 싼(형성한) 사람은 상대에게서 피를 받지 않는다', () => {
  // gostop_rules.md 5장: 피를 받는 건 뻑을 "먹은" 사람(4번째 카드로 걷어간 사람)뿐이다.
  // 뻑을 싼 사람은 먹으려던 카드까지 바닥에 묶이는 손해를 본 쪽이라 받을 게 없다.
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const players = [
    { id: 'a', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [] },
    { id: 'b', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [byId['1-pi-a'], byId['1-pi-b']] }, shakes: [] },
    { id: 'c', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [byId['2-pi-a']] }, shakes: [] },
  ];
  const state = {
    players,
    hand: { a: [byId['7-pi-a']], b: [], c: [] },
    floor: [{ ...byId['7-pi-b'], placedBy: 'deck' }],
    deck: [byId['7-tti']], // 같은 월(7월)이 또 뒤집힘 -> 뻑 형성
  };
  const result = engine.playTurn(state, 'a', '7-pi-a');
  assert.ok(result.events.includes('ppeok_formed'));
  assert.strictEqual(players[0].captured.pi.length, 0, '뻑을 싼 사람은 피를 받지 않는다');
  assert.strictEqual(players[1].captured.pi.length, 2, 'b의 피는 그대로');
  assert.strictEqual(players[2].captured.pi.length, 1, 'c의 피는 그대로');
});

section('뻑을 먹은(4번째 카드로 걷어간) 사람은 상대 전원에게서 피를 1장씩 받는다', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const players = [
    { id: 'a', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [] },
    { id: 'b', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [byId['1-pi-a'], byId['1-pi-b']] }, shakes: [] },
    { id: 'c', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [byId['2-pi-a']] }, shakes: [] },
  ];
  const state = {
    players,
    hand: { a: [byId['7-yeolkkeut']], b: [], c: [] },
    floor: [
      { ...byId['7-pi-a'], placedBy: 'b', stuck: true },
      { ...byId['7-pi-b'], placedBy: 'deck', stuck: true },
      { ...byId['7-tti'], placedBy: 'deck', stuck: true },
    ],
    deck: [byId['3-pi-a']],
  };
  const result = engine.playTurn(state, 'a', '7-yeolkkeut');
  assert.ok(result.events.includes('ppeok_resolved'));
  assert.strictEqual(players[0].captured.pi.length, 2 + 2, '뻑 더미의 피 2장 + 상대 둘에게서 1장씩');
  assert.strictEqual(players[1].captured.pi.length, 1);
  assert.strictEqual(players[2].captured.pi.length, 0);
});

section('덱에서 뒤집은 패가 바닥의 같은 월 2장과 매치되면 선택 대기(NEED_CHOICE2)', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const players = [
    { id: 'a', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [] },
    { id: 'b', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [] },
  ];
  const state = {
    players,
    hand: { a: [byId['1-pi-a']], b: [] },
    floor: [byId['3-gwang'], byId['3-tti']], // 손패로는 무매치, 덱에서 3월 2장과 매치
    deck: [byId['3-pi-a']],
  };
  let threw = null;
  try {
    engine.playTurn(state, 'a', '1-pi-a');
  } catch (e) {
    threw = e;
  }
  assert.ok(threw && threw.code === 'NEED_CHOICE2', 'NEED_CHOICE2 에러가 발생해야 함');
  assert.strictEqual(threw.matches.length, 2);
  assert.ok(state.pendingChoice2, '선택 대기 상태가 저장되어야 함');

  const result = engine.resolveChoice2(state, 'a', byId['3-tti'].id);
  assert.ok(result.captured.some((g) => g.cards.some((c) => c.id === '3-tti')));
  assert.strictEqual(state.floor.find((c) => c.id === '3-tti'), undefined, '선택된 카드는 바닥에서 제거됨');
  assert.ok(state.floor.some((c) => c.id === '3-gwang'), '선택되지 않은 카드는 바닥에 남음');
  assert.strictEqual(state.pendingChoice2, null);
});

section('보너스패를 손패에서 내면 상대 피를 뺏고 덱에서 한 장을 더 뽑는다', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const players = [
    { id: 'a', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [] },
    { id: 'b', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [] },
  ];
  players[1].captured.pi = [byId['1-pi-a'], byId['1-pi-b']];
  const state = {
    players,
    hand: { a: [byId['bonus-1']], b: [] },
    floor: [],
    deck: [byId['2-pi-a']],
  };
  const result = engine.playBonusFromHand(state, 'a', 'bonus-1');
  assert.strictEqual(players[0].captured.pi.length, 2, '보너스패(쌍피) + 상대에게서 뺏은 피 1장');
  assert.ok(players[0].captured.pi.some((c) => c.id === 'bonus-1' && c.piValue === 2), '보너스패는 쌍피로 자기 창고에');
  assert.strictEqual(players[1].captured.pi.length, 1, '상대는 피 1장을 뺏김');
  assert.strictEqual(state.hand.a.length, 1, '덱에서 한 장을 더 뽑아 손패로');
  assert.strictEqual(result.drawnCard.id, '2-pi-a');
  assert.strictEqual(state.deck.length, 0);
});

section('덱을 뒤집다가 보너스패가 나오면 즉시 획득하고 한 장 더 뒤집는다', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const players = [
    { id: 'a', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [] },
    { id: 'b', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [{ ...byId['6-pi-a'] }] }, shakes: [] },
  ];
  const state = {
    players,
    hand: { a: [byId['1-pi-a']], b: [] },
    floor: [byId['3-gwang']], // 1월과 무매치
    deck: [byId['bonus-1'], byId['2-pi-a']], // 보너스 먼저 자동 획득, 그다음 2월(무매치)
  };
  const result = engine.playTurn(state, 'a', '1-pi-a');
  assert.ok(result.events.includes('bonus_deck'), 'bonus_deck 이벤트 발생');
  assert.strictEqual(players[0].captured.pi.some((c) => c.id === 'bonus-1'), true, '보너스패는 자기 창고로');
  assert.ok(!result.events.includes('jjok') && !result.events.includes('sweep'), '이후 무매치라 다른 캡처 이벤트는 없어야 함');
  assert.strictEqual(players[1].captured.pi.length, 1, '덱에서 나온 보너스만으로는 상대 피를 뺏지 않음');
  assert.ok(state.floor.some((c) => c.id === '2-pi-a'), '무매치 카드는 바닥에 남음');
  assert.deepStrictEqual(result.bonusDeckIds, ['bonus-1'],
    '덱에서 뒤집혀 나온 보너스패 id를 알려줘야 클라이언트가 덱->먹은패로 날아가는 모습을 그릴 수 있음');
});

section('따닥은 "같은 월" 4장이 한 턴에 모일 때만 성립해야 한다 (서로 다른 월의 캡처 두 건은 따닥이 아님)', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const players = [
    { id: 'a', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [] },
    { id: 'b', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [] },
  ];
  const state = {
    players,
    hand: { a: [byId['3-tti']], b: [] }, // 3월 카드를 낸다
    // 바닥에 3월 1장(손패와 매치) + 7월 1장(전혀 무관)이 있다
    floor: [{ ...byId['3-gwang'], placedBy: 'deck' }, { ...byId['7-yeolkkeut'], placedBy: 'deck' }],
    deck: [byId['7-tti']], // 뒤집힌 카드는 7월 -> 바닥의 7월 카드와 매치(완전히 별개의 캡처)
  };
  const result = engine.playTurn(state, 'a', '3-tti');
  assert.ok(!result.events.includes('ttadak'),
    '3월 캡처와 7월 캡처가 우연히 한 턴에 겹쳤을 뿐, 같은 월이 아니므로 따닥이 아니다');
  // 두 캡처 자체는 정상적으로 일어나야 한다 (3월 페어 + 7월 페어)
  const capturedIds = result.captured.flatMap((g) => g.cards.map((c) => c.id));
  assert.ok(capturedIds.includes('3-gwang') && capturedIds.includes('7-yeolkkeut'));
});

section('따닥: 바닥에 이미 같은 월 2장이 있는 상태에서 손패+덱까지 같은 월 4장이 모이면 성립', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const players = [
    { id: 'a', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [] },
    { id: 'b', captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [] },
  ];
  const state = {
    players,
    hand: { a: [byId['3-pi-a']], b: [] },
    floor: [{ ...byId['3-gwang'], placedBy: 'deck' }, { ...byId['3-tti'], placedBy: 'deck' }],
    deck: [byId['3-pi-b']], // 같은 3월 4번째 카드가 덱에서 나옴
  };
  const result = engine.playTurn(state, 'a', '3-pi-a', '3-gwang');
  assert.ok(result.events.includes('ttadak'), '진짜 따닥(같은 월 4장)은 여전히 정상 인식되어야 함');
});

section('9월 국화(열끗)는 열끗<->쌍피로 언제든 전환 가능', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const player = { id: 'a', captured: { gwang: [], yeolkkeut: [{ ...byId['9-yeolkkeut'] }], tti: [], pi: [] } };
  const state = { players: [player] };
  let res = engine.toggleFlexCard(state, 'a', '9-yeolkkeut');
  assert.strictEqual(res.movedTo, 'pi');
  assert.strictEqual(player.captured.yeolkkeut.length, 0);
  assert.strictEqual(player.captured.pi.length, 1);
  assert.strictEqual(player.captured.pi[0].piValue, 2);

  res = engine.toggleFlexCard(state, 'a', '9-yeolkkeut');
  assert.strictEqual(res.movedTo, 'yeolkkeut');
  assert.strictEqual(player.captured.yeolkkeut.length, 1);
  assert.strictEqual(player.captured.pi.length, 0);
});

section('독박은 승자 본인의 고 횟수가 아니라 "이 판에 아무도 고를 부르지 않았는지"로 판정해야 한다', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const mkPlayer = (id) => ({ id, captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [], bombCount: 0, hasCalledGo: false });
  const a = mkPlayer('a');
  a.goCount = 1; // a는 이 판 도중 고를 불렀다(승자는 아님)
  const b = mkPlayer('b');
  b.goCount = 0; // 승자: 본인은 한 번도 고를 부른 적 없이 스톱
  const c = mkPlayer('c');
  c.goCount = 0;
  // 홍단 완성, 필요한 3장을 전부 a가 바닥에 깔아줬다 -> 독박 후보는 a
  b.captured.tti = [
    { ...byId['1-tti'], placedBy: 'a' },
    { ...byId['2-tti'], placedBy: 'a' },
    { ...byId['3-tti'], placedBy: 'a' },
  ];
  const state = { players: [a, b, c] };
  const settlement = engine.computeSettlement(state, 'b', 0);
  assert.ok(!settlement.payments.a.reasons.includes('독박'),
    'a가 먼저 고를 불렀던 판이므로(비록 승자 본인은 고를 안 불렀어도) 독박이 성립하면 안 된다');
});

section('2인(맞고)에는 고박이 없다', () => {
  const mkPlayer = (id) => ({ id, captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, shakes: [], bombCount: 0 });
  const a = mkPlayer('a');
  a.goCount = 0;
  const b = mkPlayer('b');
  b.goCount = 1;
  b.hasCalledGo = true; // b가 먼저 고를 불렀다가 a에게 역전당한 상황
  const state = { players: [a, b] };
  const settlement = engine.computeSettlement(state, 'a', 0);
  assert.ok(!settlement.payments.b.reasons.includes('고박'), '2인 맞고에는 고박이 적용되지 않아야 함');
});

// 12월 비띠(ribbonColor:null)는 홍단/청단/초단 등 색깔 조합에는 포함되지 않지만("초단은
// 4,5,7월만" 규칙과 별개), "띠 5장 이상" 순수 개수 조합에는 포함되어야 한다는 걸 사용자가
// 직접 지적해 찾은 버그의 회귀 테스트. (예전엔 computeScore가 scored:false 필드로 12월
// 비띠를 개수 집계에서까지 걸러내고 있었다.)
section('12월 비띠는 초단 등 색깔 조합엔 안 들어가지만 "띠 5장 이상" 개수엔 포함돼야 한다', () => {
  const deck = buildDeck();
  const byId = Object.fromEntries(deck.map((c) => [c.id, c]));
  const player = { captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] } };

  // 초단(4,5,7월) 3장 + 12월 비띠 1장 = 개수는 4장(아직 5장 미만이라 개수점 0점)이지만
  // 초단 3장 조합 자체(3점)는 그대로 인정돼야 한다.
  player.captured.tti = [byId['4-tti'], byId['5-tti'], byId['7-tti'], byId['12-tti']];
  let score = engine.computeScore(player);
  assert.strictEqual(score.detail.ttiCount, 4, '12월 비띠도 개수에 포함되어야 함');
  assert.strictEqual(score.detail.chodan, true, '초단 3장 자체는 그대로 인정');
  assert.strictEqual(score.ttiScore, 3, '초단 3점만(아직 5장 미만이라 개수점 없음)');

  // 초단 3장 + 다른 띠 1장 + 12월 비띠 1장 = 총 5장이 되어 개수점 1점이 초단 3점에 추가돼야 함
  player.captured.tti = [byId['4-tti'], byId['5-tti'], byId['7-tti'], byId['1-tti'], byId['12-tti']];
  score = engine.computeScore(player);
  assert.strictEqual(score.detail.ttiCount, 5, '12월 비띠까지 포함해 5장이어야 함');
  assert.strictEqual(score.ttiScore, 4, '초단 3점 + 5장 개수점 1점 = 4점');
});

console.log('\n엔진 테스트 완료');

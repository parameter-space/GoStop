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

section('덱은 48장이고 카테고리 합이 맞는다', () => {
  const deck = buildDeck();
  assert.strictEqual(deck.length, 48);
  const byType = {};
  deck.forEach((c) => (byType[c.type] = (byType[c.type] || 0) + 1));
  assert.strictEqual(byType.gwang, 5);
  assert.strictEqual(byType.yeolkkeut, 9);
  assert.strictEqual(byType.tti, 10); // 12월 비띠 포함(점수 미인정)
  assert.strictEqual(byType.pi, 24);
  const ids = new Set(deck.map((c) => c.id));
  assert.strictEqual(ids.size, 48, '카드 id 중복 없음');
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
    byId['1-pi-a'], byId['1-pi-b'], byId['2-pi-a']]; // 1+2+1+1+2+1+1+1=10
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

section('신규 라운드 배분: 인원별 장수 확인', () => {
  const { deck, hand, floor } = engine.dealNewRound(['a', 'b', 'c']);
  assert.strictEqual(hand.a.length, 7);
  assert.strictEqual(hand.b.length, 7);
  assert.strictEqual(hand.c.length, 7);
  assert.strictEqual(floor.length, 6);
  assert.strictEqual(deck.length, 48 - 21 - 6);

  const two = engine.dealNewRound(['a', 'b']);
  assert.strictEqual(two.hand.a.length, 10);
  assert.strictEqual(two.floor.length, 8);
  assert.strictEqual(two.deck.length, 48 - 20 - 8);
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

console.log('\n엔진 테스트 완료');

// 고스톱 게임 엔진 (순수 로직, Socket.io/네트워크와 무관)
// 확정 규칙: /mnt/user-data/outputs/gostop_rules.md 참고
const { buildDeck } = require('./deck');

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 인원수별 배분 수치 (표준 3인/2인 + 4인은 이 프로젝트에서 정한 값)
function dealCounts(playerCount) {
  if (playerCount === 2) return { hand: 10, floor: 8 };
  if (playerCount === 4) return { hand: 5, floor: 8 };
  return { hand: 7, floor: 6 }; // 3인 표준
}

// 초기 배분: 바닥에 같은 월 3장이 나오면 하나로 겹침, 4장이면 재분배 필요(호출자가 처리)
function dealNewRound(playerIds) {
  let deck, hand = {}, floor;
  let attempt = 0;
  // 4장 겹침(재분배 필요) 상황이 나오면 다시 섞는다
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    const shuffled = shuffle(buildDeck());
    const counts = dealCounts(playerIds.length);
    hand = {};
    playerIds.forEach((id) => (hand[id] = []));

    // 보너스패(month 없음)는 초기 바닥에 놓이면 아무도 못 가져가는 죽은 패가 되므로,
    // 바닥 몫은 보너스패를 제외한 카드로만 채우고 보너스패는 손패/덱 쪽 풀로 돌린다.
    const bonusCards = shuffled.filter((c) => c.type === 'bonus');
    const nonBonus = shuffled.filter((c) => c.type !== 'bonus');
    floor = nonBonus.slice(0, counts.floor);
    const restPool = shuffle([...nonBonus.slice(counts.floor), ...bonusCards]);

    let idx = 0;
    for (const pid of playerIds) {
      for (let i = 0; i < counts.hand; i++) {
        hand[pid].push(restPool[idx++]);
      }
    }
    deck = restPool.slice(idx);

    const monthCounts = {};
    floor.forEach((c) => (monthCounts[c.month] = (monthCounts[c.month] || 0) + 1));
    const floorHasQuad = Object.values(monthCounts).some((n) => n >= 4);

    // 총통 조건(손패에 같은 월 4장, 또는 광 5장)은 사용하지 않기로 했으므로,
    // 그런 패가 나오면 즉시 무효로 하고 다시 섞어서 재분배한다.
    const handHasTotong = playerIds.some((pid) => {
      const h = hand[pid];
      const byMonth = {};
      h.forEach((c) => (byMonth[c.month] = (byMonth[c.month] || 0) + 1));
      const quad = Object.values(byMonth).some((n) => n >= 4);
      const fiveGwang = h.filter((c) => c.type === 'gwang').length >= 5;
      return quad || fiveGwang;
    });

    // (이전 라운드에 "보너스패 몰빵" 방지용 조건부 재추첨을 추가했었으나, 사용자가 셔플에
    // 편향이 없다는 걸 확인한 뒤 다시 자연 발생하도록 되돌려달라고 요청해 제거함 - 셔플 자체는
    // Fisher-Yates로 편향이 없으므로 몰빵도 순수 확률대로 그냥 일어나게 둔다.)
    if ((!floorHasQuad && !handHasTotong) || attempt > 20) break;
  }
  floor = floor.map((c) => ({ ...c, placedBy: 'deck', stuck: false }));
  return { deck, hand, floor };
}

function resolveMatch(floor, playedCard) {
  const matches = floor.filter((c) => c.month === playedCard.month);
  return { count: matches.length, matches };
}

// 덱에서 한 장 뒤집는다. 보너스패가 나오면 그 자리에서 바로 자기 창고(쌍피)로 가져가고
// 계속 한 장씩 더 뒤집어서, 실제 월 카드가 나오거나 덱이 빌 때까지 반복한다.
// bonusIds에는 이번에 뒤집혀 나와 곧장 가져간 보너스패 id를 순서대로 적는다 - 클라이언트가
// 그 카드를 "덱에서 뒤집혀 먹은패로 들어가는" 모습으로 그리려면 어느 카드였는지 알아야 한다.
function drawFlipSkippingBonus(state, player, events, bonusIds = []) {
  let flippedCard = null;
  while (state.deck.length > 0) {
    const c = state.deck.shift();
    if (c.type === 'bonus') {
      addToCaptured(player, c);
      events.push('bonus_deck');
      bonusIds.push(c.id);
      continue;
    }
    flippedCard = c;
    break;
  }
  return flippedCard;
}

// 캡처된 카드들을 창고에 반영하고, 쪽/뻑해소/싹쓸이 피 보너스까지 정산해서 최종 결과를 만든다.
function finalizeCaptures(state, playerId, player, captured, events, flippedCard, bonusDeckIds = []) {
  for (const group of captured) {
    for (const c of group.cards) {
      addToCaptured(player, c);
    }
  }

  // 피 보너스 지급 대상 파악 (쪽/싹쓸이/뻑형성/뻑해소 각각 1장, 자뻑도 동일)
  // gostop_rules.md 5장("뻑"): "뻑을 먹은 사람은 자신이 뻑을 만들었는지(자뻑) 아닌지
  // 구분 없이, 다른 참여자들에게 동일하게 피 1장씩 받는다" - 즉 3장이 바닥에 쌓여
  // "뻑이 형성되는"(ppeok_formed) 그 순간에도 이미 피를 받아야 하고, 나중에 4번째
  // 카드로 그 더미를 실제로 걷어가는(ppeok_resolved) 순간에도 별도로 또 받는다(둘은
  // 서로 다른 턴/사람에게 일어나는 별개의 사건이라 각자 챙긴다). 이 둘은 playTurn에서
  // 서로 배타적인 분기라 한 호출에서 동시에 발생하지 않는다.
  let piBonusCount = 0;
  if (events.includes('jjok')) piBonusCount += 1;
  if (events.includes('ppeok_formed')) piBonusCount += 1;
  if (events.includes('ppeok_resolved')) piBonusCount += 1;
  const floorEmpty = state.floor.length === 0;
  if (floorEmpty && captured.length > 0) {
    events.push('sweep');
    piBonusCount += 1;
  }

  if (piBonusCount > 0) {
    for (const opp of state.players) {
      if (opp.id === playerId) continue;
      takePiFromPlayer(opp, player, piBonusCount);
    }
  }

  return { events, captured, flippedCard, bonusDeckIds };
}

// 한 턴(손패 내기 + 더미 뒤집기)을 처리한다.
// options: { chosenFloorId } - 매치 후보가 2장일 때 플레이어가 고른 카드 id
// 덱에서 뒤집은 카드가 바닥의 같은 월 2장과 또 매치되는(드문) 경우에는 바로 끝내지 않고
// state.pendingChoice2 에 진행 상황을 저장한 뒤 NEED_CHOICE2 를 던진다.
// 그러면 resolveChoice2()가 호출될 때까지 이 턴은 "결정 대기" 상태로 남는다.
function playTurn(state, playerId, handCardId, chosenFloorId) {
  const player = state.players.find((p) => p.id === playerId);
  const hand = state.hand[playerId];
  const cardIdx = hand.findIndex((c) => c.id === handCardId);
  if (cardIdx === -1) throw new Error('손패에 없는 카드입니다');
  const handCard = hand[cardIdx];
  if (handCard.type === 'bonus') throw new Error('보너스패는 game:playBonus로 내야 합니다');

  const events = [];
  const captured = []; // 이번 턴에 획득한 카드 묶음들 [{cards:[...], reason}]
  let reservedFloorCard = null; // 뻑 판정을 위해 임시로 보류하는 floor 카드
  let step1Captured = false;
  // 따닥은 "같은 월" 4장이 손패+덱에서 한 번에 모일 때만 성립한다. step1에서 실제로
  // 캡처가 일어난 월을 기억해뒀다가, 덱 뒤집기 캡처의 월과 비교해야 오탐(서로 다른 월의
  // 캡처 두 건이 우연히 한 턴에 겹친 경우)을 막을 수 있다.
  let step1Month = null;

  const match1 = resolveMatch(state.floor, handCard);

  if (match1.count === 0) {
    hand.splice(cardIdx, 1);
    state.floor.push({ ...handCard, placedBy: playerId, stuck: false });
  } else if (match1.count === 1) {
    reservedFloorCard = match1.matches[0];
    hand.splice(cardIdx, 1);
  } else if (match1.count === 2) {
    if (!chosenFloorId) {
      throw { code: 'NEED_CHOICE', matches: match1.matches };
    }
    const chosen = match1.matches.find((c) => c.id === chosenFloorId);
    if (!chosen) throw new Error('잘못된 선택입니다');
    state.floor = state.floor.filter((c) => c.id !== chosen.id);
    hand.splice(cardIdx, 1);
    captured.push({ cards: [handCard, chosen], reason: 'normal' });
    step1Captured = true;
    step1Month = handCard.month;
  } else {
    // 3장(뻑 더미) 위에 4번째 카드 -> 즉시 전부 획득 (뻑 해소)
    const stack = match1.matches;
    state.floor = state.floor.filter((c) => c.month !== handCard.month);
    hand.splice(cardIdx, 1);
    captured.push({ cards: [handCard, ...stack], reason: 'ppeok_resolved' });
    events.push('ppeok_resolved');
    step1Captured = true;
    step1Month = handCard.month;
  }

  // 덱 뒤집기 (보너스패는 자동으로 스킵하며 자기 창고로)
  const bonusIds = [];
  const flippedCard = drawFlipSkippingBonus(state, player, events, bonusIds);

  if (flippedCard) {
    if (reservedFloorCard && flippedCard.month === reservedFloorCard.month) {
      // 뻑 성립: 3장이 바닥에 그대로 쌓임 (획득 없음)
      state.floor = state.floor.filter((c) => c.id !== reservedFloorCard.id);
      state.floor.push({ ...reservedFloorCard, stuck: true });
      state.floor.push({ ...handCard, placedBy: playerId, stuck: true });
      state.floor.push({ ...flippedCard, placedBy: 'deck', stuck: true });
      events.push('ppeok_formed');
    } else {
      if (reservedFloorCard) {
        // 보류했던 1:1 매치를 이제 확정
        state.floor = state.floor.filter((c) => c.id !== reservedFloorCard.id);
        captured.push({ cards: [handCard, reservedFloorCard], reason: 'normal' });
        step1Captured = true;
        step1Month = handCard.month;
      }
      const match2 = resolveMatch(state.floor, flippedCard);
      // 따닥 성립 여부: step1에서 캡처된 월과 덱에서 뒤집힌 카드의 월이 같아야 한다.
      // (서로 다른 월의 캡처가 한 턴에 우연히 겹친 경우는 그냥 캡처 두 건일 뿐, 따닥이 아니다)
      const sameMonthAsStep1 = step1Captured && step1Month === flippedCard.month;
      if (match2.count === 0) {
        state.floor.push({ ...flippedCard, placedBy: 'deck', stuck: false });
      } else if (match2.count === 1) {
        const only = match2.matches[0];
        state.floor = state.floor.filter((c) => c.id !== only.id);
        const isJjok = match1.count === 0 && only.placedBy === playerId && only.id === handCard.id;
        captured.push({ cards: [flippedCard, only], reason: isJjok ? 'jjok' : 'normal' });
        if (isJjok) events.push('jjok');
        else if (sameMonthAsStep1) events.push('ttadak');
      } else if (match2.count === 2) {
        // 덱에서 뒤집은 카드가 바닥의 같은 월 2장과 매치 -> 플레이어가 직접 고르게 대기시킨다
        state.pendingChoice2 = {
          playerId, flippedCard, matches: match2.matches, captured, events, step1Captured, step1Month, bonusIds,
        };
        const err = new Error('바닥의 두 카드 중 하나를 선택하세요');
        err.code = 'NEED_CHOICE2';
        err.matches = match2.matches;
        err.flippedCardId = flippedCard.id;
        err.bonusDeckIds = bonusIds;
        throw err;
      } else {
        const stack2 = match2.matches;
        state.floor = state.floor.filter((c) => c.month !== flippedCard.month);
        captured.push({ cards: [flippedCard, ...stack2], reason: 'ppeok_resolved' });
        events.push('ppeok_resolved');
        if (sameMonthAsStep1) events.push('ttadak');
      }
    }
  } else if (reservedFloorCard) {
    // 덱이 떨어져 더 못 뒤집는 경우: 보류했던 매치를 그냥 확정
    state.floor = state.floor.filter((c) => c.id !== reservedFloorCard.id);
    captured.push({ cards: [handCard, reservedFloorCard], reason: 'normal' });
  }

  return finalizeCaptures(state, playerId, player, captured, events, flippedCard, bonusIds);
}

// playTurn 중 NEED_CHOICE2로 대기 중이던 턴을, 플레이어가 고른 floor 카드로 마무리한다.
function resolveChoice2(state, playerId, chosenId) {
  const pending = state.pendingChoice2;
  if (!pending || pending.playerId !== playerId) {
    throw new Error('지금은 선택할 것이 없습니다');
  }
  const chosen = pending.matches.find((c) => c.id === chosenId);
  if (!chosen) throw new Error('잘못된 선택입니다');
  state.floor = state.floor.filter((c) => c.id !== chosen.id);
  pending.captured.push({ cards: [pending.flippedCard, chosen], reason: 'normal' });
  if (pending.step1Captured && pending.step1Month === pending.flippedCard.month) {
    pending.events.push('ttadak');
  }
  state.pendingChoice2 = null;
  const player = state.players.find((p) => p.id === playerId);
  return finalizeCaptures(state, playerId, player, pending.captured, pending.events, pending.flippedCard, pending.bonusIds || []);
}

// 폭탄 이후 스킵 턴 등, 손패 없이 덱만 뒤집는 경우. 보너스패 스킵/2장 매치 대기까지
// playTurn과 동일한 방식으로 처리한다(단, 손패가 없으니 뻑/쪽/따닥은 발생하지 않는다).
function skipDeckFlip(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const events = [];
  const captured = [];
  const bonusIds = [];

  const flippedCard = drawFlipSkippingBonus(state, player, events, bonusIds);
  if (!flippedCard) {
    return finalizeCaptures(state, playerId, player, captured, events, null, bonusIds);
  }

  const match = resolveMatch(state.floor, flippedCard);
  if (match.count === 0) {
    state.floor.push({ ...flippedCard, placedBy: 'deck', stuck: false });
  } else if (match.count === 1) {
    const only = match.matches[0];
    state.floor = state.floor.filter((c) => c.id !== only.id);
    captured.push({ cards: [flippedCard, only], reason: 'normal' });
  } else if (match.count === 2) {
    state.pendingChoice2 = {
      playerId, flippedCard, matches: match.matches, captured, events, step1Captured: false, step1Month: null, bonusIds,
    };
    const err = new Error('바닥의 두 카드 중 하나를 선택하세요');
    err.code = 'NEED_CHOICE2';
    err.matches = match.matches;
    err.flippedCardId = flippedCard.id;
    err.bonusDeckIds = bonusIds;
    throw err;
  } else {
    state.floor = state.floor.filter((c) => c.month !== flippedCard.month);
    captured.push({ cards: [flippedCard, ...match.matches], reason: 'ppeok_resolved' });
    events.push('ppeok_resolved');
  }

  return finalizeCaptures(state, playerId, player, captured, events, flippedCard, bonusIds);
}

// 손패에서 보너스패를 낸다: 상대 각각에게서 피 1장씩 받아오고, 덱에서 한 장을 손패로
// 가져온다. 실제로 한 장 더 내는 것은 별도의 game:playCard 호출(같은 사람 차례 유지)로 이어진다.
function playBonusFromHand(state, playerId, bonusCardId) {
  const player = state.players.find((p) => p.id === playerId);
  const hand = state.hand[playerId];
  const idx = hand.findIndex((c) => c.id === bonusCardId);
  if (idx === -1) throw new Error('손패에 없는 카드입니다');
  const card = hand[idx];
  if (card.type !== 'bonus') throw new Error('보너스패가 아닙니다');

  hand.splice(idx, 1);
  addToCaptured(player, card); // 쌍피로 바로 자기 창고에

  for (const opp of state.players) {
    if (opp.id === playerId) continue;
    takePiFromPlayer(opp, player, 1);
  }

  let drawnCard = null;
  if (state.deck.length > 0) {
    drawnCard = state.deck.shift();
    hand.push(drawnCard);
  }

  return { events: ['bonus_hand'], captured: [], drawnCard };
}

// 9월 국화(열끗) 카드를 열끗<->쌍피 사이에서 전환한다. 자기 창고 안에서만, 언제든 가능.
function toggleFlexCard(state, playerId, cardId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error('플레이어를 찾을 수 없습니다');

  let idx = player.captured.yeolkkeut.findIndex((c) => c.id === cardId && c.flexCard);
  if (idx !== -1) {
    const [card] = player.captured.yeolkkeut.splice(idx, 1);
    card.type = 'pi';
    card.piValue = 2;
    player.captured.pi.push(card);
    return { movedTo: 'pi' };
  }
  idx = player.captured.pi.findIndex((c) => c.id === cardId && c.flexCard);
  if (idx !== -1) {
    const [card] = player.captured.pi.splice(idx, 1);
    card.type = 'yeolkkeut';
    delete card.piValue;
    player.captured.yeolkkeut.push(card);
    return { movedTo: 'yeolkkeut' };
  }
  throw new Error('전환할 수 있는 카드를 찾을 수 없습니다');
}

function addToCaptured(player, card) {
  // 보너스패는 카드 자체의 type은 'bonus'로 유지하되(클라이언트 표시용),
  // 점수/피 개수 계산에는 쌍피로 반영되도록 pi 창고에 담는다.
  const bucket = card.type === 'bonus' ? 'pi' : card.type;
  player.captured[bucket].push(card);
}

// 상대에게서 피를 받아온다 (상대 피가 부족하면 있는 만큼만, 쌍피 우선순위는 낮은 가치부터)
function takePiFromPlayer(fromPlayer, toPlayer, count) {
  const pis = fromPlayer.captured.pi.slice().sort((a, b) => (a.piValue || 1) - (b.piValue || 1));
  for (let i = 0; i < count && pis.length > 0; i++) {
    const card = pis.shift();
    fromPlayer.captured.pi = fromPlayer.captured.pi.filter((c) => c.id !== card.id);
    toPlayer.captured.pi.push(card);
  }
}

// 폭탄: 손에 같은 월 3장 + 바닥에 4번째 카드가 있을 때, 3장을 한번에 내서 4장 획득
function playBomb(state, playerId, month) {
  const player = state.players.find((p) => p.id === playerId);
  const hand = state.hand[playerId];
  const inHand = hand.filter((c) => c.month === month);
  if (inHand.length !== 3) throw new Error('손에 같은 월 카드가 3장이어야 폭탄을 낼 수 있습니다');
  const onFloor = state.floor.filter((c) => c.month === month);
  if (onFloor.length !== 1) throw new Error('바닥에 4번째 카드가 정확히 1장 있어야 폭탄이 가능합니다');

  state.hand[playerId] = hand.filter((c) => c.month !== month);
  state.floor = state.floor.filter((c) => c.month !== month);
  const all = [...inHand, ...onFloor];
  all.forEach((c) => addToCaptured(player, c));

  for (const opp of state.players) {
    if (opp.id === playerId) continue;
    takePiFromPlayer(opp, player, 1);
  }

  player.bombCount = (player.bombCount || 0) + 1;
  player.skipNextHandPlay = (player.skipNextHandPlay || 0) + 1;

  return { events: ['bomb'], captured: all };
}

function declareShake(state, playerId, month) {
  const hand = state.hand[playerId];
  const inHand = hand.filter((c) => c.month === month);
  if (inHand.length !== 3) throw new Error('손에 같은 월 카드가 3장이어야 흔들 수 있습니다');
  const player = state.players.find((p) => p.id === playerId);
  player.shakes = player.shakes || [];
  if (player.shakes.includes(month)) throw new Error('이미 흔든 월입니다');
  player.shakes.push(month);
  return { events: ['shake'] };
}

function computeScore(player) {
  const g = player.captured.gwang;
  // 12월 비띠(ribbonColor:null)도 "띠 5장 이상" 개수에는 포함한다 - 홍단/청단/초단 등 색깔
  // 조합에서는 ribbonColor가 null이라 hasColor()에서 자연히 제외되므로, 여기서 따로 걸러낼
  // 필요가 없다(오히려 걸러내면 개수 집계에서까지 빠져버리는 게 실제 버그였다).
  const t = player.captured.tti;
  const y = player.captured.yeolkkeut;
  const piValue = player.captured.pi.reduce((sum, c) => sum + (c.piValue || 1), 0);

  let gwangScore = 0;
  if (g.length >= 5) gwangScore = 15;
  else if (g.length === 4) gwangScore = 4;
  else if (g.length === 3) {
    const hasRain = g.some((c) => c.isRainGwang);
    gwangScore = hasRain ? 2 : 3;
  }

  let ttiScore = t.length >= 5 ? 1 + (t.length - 5) : 0;
  const hasColor = (color) => ['hong', 'cho', 'cheong']
    .includes(color) && t.filter((c) => c.ribbonColor === color).length >= 3;
  const hongdan = hasColor('hong');
  const chodan = hasColor('cho');
  const cheongdan = hasColor('cheong');
  if (hongdan) ttiScore += 3;
  if (chodan) ttiScore += 3;
  if (cheongdan) ttiScore += 3;

  let yeolkkeutScore = y.length >= 5 ? 1 + (y.length - 5) : 0;
  const godoriMonths = [2, 4, 8];
  const godori = godoriMonths.every((m) => y.some((c) => c.month === m));
  if (godori) yeolkkeutScore += 5;

  let piScore = piValue >= 10 ? 1 + (piValue - 10) : 0;

  return {
    gwangScore,
    ttiScore,
    yeolkkeutScore,
    piScore,
    total: gwangScore + ttiScore + yeolkkeutScore + piScore,
    detail: { gwangCount: g.length, ttiCount: t.length, yeolkkeutCount: y.length, piValue, hongdan, chodan, cheongdan, godori },
  };
}

function scoreThreshold(playerCount) {
  return playerCount === 2 ? 7 : 3;
}

// 고 배율: 1고 = +1점(배율 없음), 2고부터 2배씩 누적 => 2^(goCount-1) (goCount>=2일 때만)
function goMultiplierInfo(goCount) {
  if (goCount <= 0) return { addPoint: 0, multiplier: 1 };
  if (goCount === 1) return { addPoint: 1, multiplier: 1 };
  return { addPoint: 1, multiplier: Math.pow(2, goCount - 1) };
}

// 독박 대상 찾기(단순화 버전): 완성된 족보에 들어간 카드 중, "누가 바닥에 냈었는지"가
// 단 한 명의 상대로만 특정되면 그 사람을 독박 대상으로 본다. 정확한 "마지막 한 장" 순서까지는
// 추적하지 않는 단순화된 판정이다.
function findDokbakTarget(winnerId, comboCards) {
  const contributors = new Set(
    comboCards
      .map((c) => c.placedBy)
      .filter((who) => who && who !== winnerId && who !== 'deck')
  );
  if (contributors.size === 1) return [...contributors][0];
  return null;
}

// 최종 정산 계산
// state.players 각각의 captured/shakes/bombCount 기준으로 승자 winnerId, 승자의 goCount를 받아 계산
function computeSettlement(state, winnerId, goCount) {
  const winner = state.players.find((p) => p.id === winnerId);
  const base = computeScore(winner);
  const { addPoint, multiplier: goMult } = goMultiplierInfo(goCount);
  const shakeBombMult = Math.pow(2, (winner.shakes || []).length + (winner.bombCount || 0));

  const scoreBeforeBak = (base.total + addPoint) * goMult * shakeBombMult;

  const piThreshold = state.players.length === 2 ? 7 : 5;

  // 독박(이 판에서 "아무도" 고를 선언한 적이 없을 때만 성립 - 승자 자신의 고 횟수만 봐서는 안 된다.
  // 승자가 직접 고를 부른 적은 없더라도, 다른 누군가가 먼저 고를 불렀다가 이 승자에게
  // 뒤집힌 경우라면 이미 "고가 있었던 판"이므로 독박이 성립하지 않는다)
  const anyGoThisRound = state.players.some((p) => (p.goCount || 0) > 0);
  let dokbakTarget = null;
  if (!anyGoThisRound) {
    const combos = [];
    if (base.detail.hongdan) combos.push(winner.captured.tti.filter((c) => c.ribbonColor === 'hong'));
    if (base.detail.chodan) combos.push(winner.captured.tti.filter((c) => c.ribbonColor === 'cho'));
    if (base.detail.cheongdan) combos.push(winner.captured.tti.filter((c) => c.ribbonColor === 'cheong'));
    if (base.detail.godori) combos.push(winner.captured.yeolkkeut.filter((c) => [2, 4, 8].includes(c.month)));
    if (base.gwangScore > 0) combos.push(winner.captured.gwang);
    for (const combo of combos) {
      const target = findDokbakTarget(winnerId, combo);
      if (target) { dokbakTarget = target; break; }
    }
  }

  const payments = {};
  for (const p of state.players) {
    if (p.id === winnerId) continue;
    let mult = 1;
    const reasons = [];
    if (base.gwangScore > 0 && p.captured.gwang.length === 0) {
      mult *= 2;
      reasons.push('광박');
    }
    const loserPi = p.captured.pi.reduce((s, c) => s + (c.piValue || 1), 0);
    if (base.piScore > 0 && loserPi <= piThreshold) {
      mult *= 2;
      reasons.push('피박');
    }
    // 고박은 "다른 패자 몫까지 대신 책임진다"는 개념이라 상대가 나 하나뿐인 2인(맞고)에는 없다.
    if (p.hasCalledGo && state.players.length > 2) {
      mult *= 2;
      reasons.push('고박');
    }
    if (dokbakTarget === p.id) {
      mult *= 2;
      reasons.push('독박');
    }
    payments[p.id] = { multiplier: mult, reasons, amount: scoreBeforeBak * mult };
  }

  return {
    winnerId,
    base,
    goCount,
    goAddPoint: addPoint,
    goMultiplier: goMult,
    shakeBombMultiplier: shakeBombMult,
    scoreBeforeBak,
    payments,
  };
}

module.exports = {
  shuffle,
  dealNewRound,
  resolveMatch,
  playTurn,
  resolveChoice2,
  skipDeckFlip,
  playBonusFromHand,
  toggleFlexCard,
  playBomb,
  declareShake,
  computeScore,
  scoreThreshold,
  goMultiplierInfo,
  computeSettlement,
};

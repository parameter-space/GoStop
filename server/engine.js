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
    deck = shuffle(buildDeck());
    const counts = dealCounts(playerIds.length);
    hand = {};
    playerIds.forEach((id) => (hand[id] = []));
    floor = [];

    let idx = 0;
    // 바닥 카드 먼저, 그 다음 손패 순으로 표준 배분 순서를 단순화해서 구현
    for (let round = 0; round < 1; round++) {
      // 바닥
      const floorBatch = Math.min(counts.floor, deck.length - idx);
      for (let i = 0; i < floorBatch; i++) floor.push(deck[idx++]);
      // 손패 (2세트로 나눠 배분하는 절차는 최종 결과가 같으므로 단순화)
      for (const pid of playerIds) {
        for (let i = 0; i < counts.hand; i++) {
          hand[pid].push(deck[idx++]);
        }
      }
    }
    deck = deck.slice(idx);

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

    if ((!floorHasQuad && !handHasTotong) || attempt > 20) break;
  }
  floor = floor.map((c) => ({ ...c, placedBy: 'deck', stuck: false }));
  return { deck, hand, floor };
}

function resolveMatch(floor, playedCard) {
  const matches = floor.filter((c) => c.month === playedCard.month);
  return { count: matches.length, matches };
}

// 한 턴(손패 내기 + 더미 뒤집기)을 처리한다.
// options: { chosenFloorId } - 매치 후보가 2장일 때 플레이어가 고른 카드 id
function playTurn(state, playerId, handCardId, chosenFloorId) {
  const player = state.players.find((p) => p.id === playerId);
  const hand = state.hand[playerId];
  const cardIdx = hand.findIndex((c) => c.id === handCardId);
  if (cardIdx === -1) throw new Error('손패에 없는 카드입니다');
  const handCard = hand[cardIdx];

  const events = [];
  const captured = []; // 이번 턴에 획득한 카드 묶음들 [{cards:[...], reason}]
  let reservedFloorCard = null; // 뻑 판정을 위해 임시로 보류하는 floor 카드
  let step1Captured = false;

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
  } else {
    // 3장(뻑 더미) 위에 4번째 카드 -> 즉시 전부 획득 (뻑 해소)
    const stack = match1.matches;
    state.floor = state.floor.filter((c) => c.month !== handCard.month);
    hand.splice(cardIdx, 1);
    captured.push({ cards: [handCard, ...stack], reason: 'ppeok_resolved' });
    events.push('ppeok_resolved');
    step1Captured = true;
  }

  // 덱이 비어있으면 더 이상 뒤집지 않음
  let flippedCard = null;
  if (state.deck.length > 0) {
    flippedCard = state.deck.shift();
  }

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
      }
      const match2 = resolveMatch(state.floor, flippedCard);
      if (match2.count === 0) {
        state.floor.push({ ...flippedCard, placedBy: 'deck', stuck: false });
      } else if (match2.count === 1) {
        const only = match2.matches[0];
        state.floor = state.floor.filter((c) => c.id !== only.id);
        const isJjok = match1.count === 0 && only.placedBy === playerId && only.id === handCard.id;
        captured.push({ cards: [flippedCard, only], reason: isJjok ? 'jjok' : 'normal' });
        if (isJjok) events.push('jjok');
        else if (step1Captured) events.push('ttadak');
      } else if (match2.count === 2) {
        if (!chosenFloorId || chosenFloorId === handCard.id) {
          // 클라이언트가 2단계 선택을 별도로 안 넘겼다면 첫 번째 후보로 자동 처리(간단화)
        }
        const chosen2 = state.deferredChoice2 || match2.matches[0];
        state.floor = state.floor.filter((c) => c.id !== chosen2.id);
        captured.push({ cards: [flippedCard, chosen2], reason: 'normal' });
        if (step1Captured) events.push('ttadak');
      } else {
        const stack2 = match2.matches;
        state.floor = state.floor.filter((c) => c.month !== flippedCard.month);
        captured.push({ cards: [flippedCard, ...stack2], reason: 'ppeok_resolved' });
        events.push('ppeok_resolved');
        if (step1Captured) events.push('ttadak');
      }
    }
  } else if (reservedFloorCard) {
    // 덱이 떨어져 더 못 뒤집는 경우: 보류했던 매치를 그냥 확정
    state.floor = state.floor.filter((c) => c.id !== reservedFloorCard.id);
    captured.push({ cards: [handCard, reservedFloorCard], reason: 'normal' });
  }

  // 획득한 카드들을 플레이어 창고에 정리
  for (const group of captured) {
    for (const c of group.cards) {
      addToCaptured(player, c);
    }
  }

  // 피 보너스 지급 대상 파악 (쪽/싹쓸이/뻑해소 각각 1장, 자뻑도 동일)
  let piBonusCount = 0;
  if (events.includes('jjok')) piBonusCount += 1;
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

  return { events, captured, flippedCard };
}

function addToCaptured(player, card) {
  player.captured[card.type].push(card);
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
  const t = player.captured.tti.filter((c) => c.scored !== false);
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

  // 독박(고 0회로 즉시 스톱했을 때만 성립)
  let dokbakTarget = null;
  if (goCount === 0) {
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
    if (p.hasCalledGo) {
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
  playBomb,
  declareShake,
  computeScore,
  scoreThreshold,
  goMultiplierInfo,
  computeSettlement,
};

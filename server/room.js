const { nanoid } = require('nanoid');
const engine = require('./engine');

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

class Room {
  constructor() {
    this.code = makeRoomCode();
    this.id = nanoid();
    this.players = []; // {id, name, socketId, connected, isHost}
    this.pointValue = 100; // 점당 금액 (원). 언제든 변경 가능
    this.ledger = {}; // playerId -> 누적 금액
    this.round = null; // 현재 진행중인 판 상태
    this.roundNumber = 0;
    this.log = [];
    this.eventSeq = 0;
    // gostop_rules.md 3장 "선 정하기": 지금까지는 매 판마다 turnOrder를 항상 this.players
    // 순서(=방을 만든 순서, 즉 방장이 항상 맨 앞) 그대로 써서 방장이 영원히 매 판 첫 순서였다.
    // null이면 "아직 안 정해짐"이고, 이 방의 첫 판을 시작할 때 무작위로 한 번 정한 뒤,
    // 매 판이 끝나고 다음 판을 시작할 때마다 좌석 순서로 한 칸씩 돌아가게 한다(startRound 참고).
    this.nextDealerIndex = null;
  }

  // 모든 클라이언트에게 연출(배너/효과음)을 트리거하기 위한 이벤트 기록
  pushEvent(kind, playerId, extra = {}) {
    this.eventSeq += 1;
    if (this.round) {
      this.round.lastEvent = { seq: this.eventSeq, kind, playerId, playerName: this.playerName(playerId), ...extra };
    }
  }

  addPlayer(name, socketId) {
    // 라운드가 이미 시작된 뒤에 새 참가자를 받아주면, 그 사람은 this.players에는 들어가지만
    // this.round.players/turnOrder/hand에는 없는 상태가 된다(라운드는 시작 시점의 인원으로
    // 고정되기 때문). 그 결과 publicState()가 이 사람 몫으로 내려주는 round.players에는
    // 자기 자신이 없고 myHand도 항상 빈 배열이라, 클라이언트가 "내 정보"를 렌더링하다가
    // (me가 undefined인 채로 me.score 등에 접근) 그대로 뻗어버리는 화면 먹통 버그가 있었다.
    // 이 게임은 관전 모드를 지원하지 않으므로, 게임이 이미 시작된 방에는 새로 참가할 수 없게 막는다.
    if (this.round) throw new Error('게임이 이미 시작되어 참가할 수 없습니다');
    if (this.players.length >= 4) throw new Error('최대 4명까지 참여할 수 있습니다');
    const id = nanoid(8);
    const isHost = this.players.length === 0;
    this.players.push({ id, name, socketId, connected: true, isHost });
    this.ledger[id] = 0;
    return id;
  }

  reconnectPlayer(playerId, socketId) {
    const p = this.players.find((pl) => pl.id === playerId);
    if (!p) throw new Error('플레이어를 찾을 수 없습니다');
    p.socketId = socketId;
    p.connected = true;
    return p;
  }

  // 대기방에서 나가기. addPlayer가 라운드 시작 후 참가를 막는 것과 대칭으로, 라운드가 이미
  // 시작된 뒤에는 나가기도 막는다 - round.players/turnOrder/hand는 시작 시점 인원으로 고정돼
  // 있어서, 중간에 한 명을 this.players에서만 빼버리면 그 어긋남 때문에 다른 여러 곳(정산,
  // 다음 턴 계산 등)이 깨진다. 게임 중에 빠지고 싶으면 호스트의 "방 폭파"를 쓰거나 그냥
  // 연결을 끊어두면 된다(연결 끊김은 이미 별도로 처리됨).
  removePlayer(playerId) {
    if (this.round) throw new Error('게임이 이미 시작되어 나갈 수 없습니다');
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx === -1) throw new Error('플레이어를 찾을 수 없습니다');
    const wasHost = this.players[idx].isHost;
    this.players.splice(idx, 1);
    delete this.ledger[playerId];
    // 나간 사람이 호스트였으면 남은 사람 중 가장 먼저 들어온 사람에게 호스트를 넘긴다.
    // 그렇지 않으면 호스트 전용 버튼(게임 시작 등)을 아무도 못 누르는 방이 되어버린다.
    if (wasHost && this.players.length > 0) this.players[0].isHost = true;
  }

  setPointValue(value) {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) throw new Error('올바른 금액이 아닙니다');
    this.pointValue = v;
  }

  addLog(message) {
    this.log.push({ ts: Date.now(), message });
    if (this.log.length > 200) this.log.shift();
  }

  startRound() {
    // 이미 진행 중인(아직 끝나지 않은) 라운드 위에 새 라운드를 덮어씌우면 안 된다.
    // game:start/game:nextRound 소켓 핸들러는 호스트 권한만 확인하고 현재 phase는 보지
    // 않으므로, 이 호출이 중복되면(호스트의 클라이언트가 잠깐 버튼을 두 번 누르거나,
    // 응답 지연 중 재클릭하는 등) turnIndex가 0으로 리셋되며 진행 중이던 판이 통째로
    // 사라지고 - 그 순간 자동 진행 타이머가 이전 라운드의 대기자를 기준으로 걸려 있었다면
    // 그 타이머가 새 대기자를 놓치는 사각지대까지 생길 수 있다. 그래서 여기서 막는다.
    if (this.round && this.round.phase !== 'round-end') {
      throw new Error('이미 진행 중인 판이 있어 새로 시작할 수 없습니다');
    }
    const seatPlayerIds = this.players.map((p) => p.id);
    if (seatPlayerIds.length < 2) throw new Error('최소 2명이 필요합니다');
    // 이 방의 첫 판이면 무작위로 선을 정하고(항상 방장부터 시작하지 않도록), 이후 매 판마다
    // 좌석 순서로 한 칸씩 밀어서 특정 한 사람이 계속 먼저 시작하는 일이 없게 한다.
    if (this.nextDealerIndex == null) {
      this.nextDealerIndex = Math.floor(Math.random() * seatPlayerIds.length);
    }
    const dealerIdx = this.nextDealerIndex % seatPlayerIds.length;
    const playerIds = seatPlayerIds.map((_, i) => seatPlayerIds[(dealerIdx + i) % seatPlayerIds.length]);
    this.nextDealerIndex = (dealerIdx + 1) % seatPlayerIds.length;
    const { deck, hand, floor } = engine.dealNewRound(playerIds);
    this.roundNumber += 1;
    this.round = {
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
      phase: 'playing', // playing | await-choice | await-gostop | round-end
      pendingChoice: null, // { playerId, matches, stage }
      pendingGoStop: null, // playerId
      // gostop_rules.md 7장: 고박은 "처음 고를 선언한 사람"에게만 적용된다(다른 사람이 나중에
      // 또 고를 불렀다고 해서 그 사람까지 고박 대상이 되는 게 아니다). 3~4인 판에서는 서로 다른
      // 플레이어가 각자 자기 턴에 점수 문턱을 넘겨 고를 부를 수 있으므로, "이 판에서 가장 먼저
      // 고를 부른 사람이 누구였는지"를 이 라운드 동안 계속 기억해둬야 finishRound에서 고박
      // 대상을 정확히 그 사람 한 명으로만 좁힐 수 있다.
      firstGoCallerId: null,
      resultLog: [],
      lastEvent: null,
    };
    this.addLog(`${this.roundNumber}판 시작`);
    return this.round;
  }

  currentActorId() {
    const r = this.round;
    return r.turnOrder[r.turnIndex % r.turnOrder.length];
  }

  advanceTurn() {
    const r = this.round;
    const n = r.turnOrder.length;
    for (let step = 1; step <= n; step++) {
      const idx = (r.turnIndex + step) % n;
      const pid = r.turnOrder[idx];
      const rp = r.players.find((p) => p.id === pid);
      if (r.hand[pid].length > 0 || (rp.skipNextHandPlay || 0) > 0) {
        r.turnIndex = idx;
        return pid;
      }
    }
    return null; // 아무도 더 할 게 없음 -> 라운드 종료 처리 필요
  }

  isRoundOver() {
    const r = this.round;
    // 손패가 0장이어도 "폭탄 직후 스킵 턴" 빚(skipNextHandPlay)이 남아있으면 아직 끝난 게 아니다.
    // 이걸 빼먹으면, 손에 남은 카드 전부로 폭탄을 낸 사람의 "덱만 뒤집는" 마지막 턴이
    // 통째로 사라진 채 나가리/정산 처리가 되어버린다.
    return r.turnOrder.every((pid) => {
      const rp = r.players.find((p) => p.id === pid);
      return r.hand[pid].length === 0 && (rp.skipNextHandPlay || 0) === 0;
    });
  }

  // 손패/폭탄/흔들기/보너스패 등 "내 차례에 하는 행동" 공통 유효성 검사.
  // - 차례가 맞는지
  // - 고/스톱 응답 대기 중(await-gostop)이거나 라운드가 끝났는데(round-end) 몰래 카드를 더 내는 건 아닌지
  // - 덱 뒤집기 2장 매치 선택 대기 중(pendingChoice2)인데 그걸 건너뛰고 다른 행동을 하는 건 아닌지
  // 이 검사가 없으면, phase가 'playing'이 아닌 동안에도 currentActorId()가 그대로라서
  // (턴이 아직 안 넘어갔으므로) 서버가 요청을 그냥 받아버리는 문제가 있었다.
  assertActionAllowed(playerId) {
    const r = this.round;
    // this.round가 없을 때(대기방 단계 등) currentActorId()가 r.turnOrder를 그대로 읽으려다
    // "Cannot read properties of null"류의 날것 그대로의 자바스크립트 에러를 던지는 걸 막는다.
    // 정상적인 UI로는 라운드가 없을 때 이 행동 버튼들 자체가 안 보이니 도달하지 않지만, 소켓
    // payload를 직접 조작해 보내는 경우를 대비해 사용자에게 친절한 한국어 메시지로 대신 알려준다.
    if (!r) throw new Error('진행 중인 판이 없습니다');
    if (this.currentActorId() !== playerId) throw new Error('당신의 차례가 아닙니다');
    if (r.phase !== 'playing') throw new Error('지금은 그 행동을 할 수 없습니다');
    if (r.pendingChoice2) throw new Error('덱에서 뒤집힌 카드의 짝을 먼저 선택해주세요');
  }

  playCard(playerId, cardId, chosenFloorId) {
    const r = this.round;
    this.assertActionAllowed(playerId);
    const rp = r.players.find((p) => p.id === playerId);

    let result;
    let handCardId = null; // 손패에서 낸 카드 id (스킵 턴이면 낸 손패가 없으므로 null 유지)
    if ((rp.skipNextHandPlay || 0) > 0) {
      // 폭탄 이후 스킵 턴: 손패 내지 않고 더미만 뒤집음
      rp.skipNextHandPlay -= 1;
      result = engine.skipDeckFlip(r, playerId);
    } else {
      handCardId = cardId;
      result = engine.playTurn(r, playerId, cardId, chosenFloorId);
    }
    this.addLog(this.describeEvents(playerId, result.events));
    // handCardId/flippedCardId를 클라이언트에 넘겨서, "손에서 나가는" 애니메이션과
    // "덱에서 뒤집혀 나오는" 애니메이션을 각각 올바른 출발점에서 재생할 수 있게 한다.
    // chosenFloorId도 함께 넘긴다 - 바닥에 같은 월 카드가 2장 있어서 직접 골라야 했던
    // 경우(NEED_CHOICE2), 클라이언트는 "월이 같다"는 것만으로는 어느 쪽과 맞았는지 알 수
    // 없어(둘 다 월이 같으므로) 실제로 고른 카드가 아닌 다른 후보 쪽으로 애니메이션이
    // 잘못 날아가는 문제가 있었다.
    this.emitPrimaryEvent(playerId, result.events, result.captured, {
      handCardId, flippedCardId: result.flippedCard ? result.flippedCard.id : null,
      chosenFloorId: chosenFloorId || null,
    });
    return this.afterAction(playerId, result);
  }

  // 덱에서 뒤집은 카드가 바닥의 같은 월 2장과 매치되어 대기 중이던 선택을 마무리한다.
  //
  // 주의: 다른 행동들(playCard/playBomb/declareShake)은 전부 assertActionAllowed로 phase를
  // 검사하는데, 이 메서드만 그 검사가 빠져 있었다. pendingChoice2가 세팅된 상태에서 호스트가
  // "이 판 무효 처리"(forceEndRound)로 phase를 round-end로 바꿔버려도, pendingChoice2 자체는
  // 그대로 남아있으니 그 선택을 기다리던 클라이언트가 뒤늦게(모달이 화면에 그대로 떠 있는 채로)
  // 선택을 보내면 이 메서드는 phase를 안 보고 그대로 받아들여, 이미 정산까지 끝난 판의
  // floor/captured를 사후에 몰래 바꿔버릴 수 있었다(정산액 자체는 스냅샷이라 안 바뀌지만,
  // 결과 화면에 보이는 먹은 패 구성이 실제 정산 근거와 어긋나게 된다). round-end 이후에는
  // 거부하도록 phase를 확인한다.
  resolveChoice2(playerId, chosenId) {
    const r = this.round;
    if (!r) throw new Error('진행 중인 판이 없습니다');
    if (r.phase === 'round-end') throw new Error('이미 끝난 판입니다');
    const result = engine.resolveChoice2(r, playerId, chosenId);
    this.addLog(this.describeEvents(playerId, result.events));
    this.emitPrimaryEvent(playerId, result.events, result.captured, {
      flippedCardId: result.flippedCard ? result.flippedCard.id : null,
      chosenFloorId: chosenId,
    });
    return this.afterAction(playerId, result);
  }

  // 보너스패를 손패에서 낸다: 상대 각각 피 1장씩 받고, 덱에서 한 장을 손패로 가져온다.
  // 턴은 끝나지 않고(advanceTurn 없음) 같은 사람이 이어서 정식으로 한 장을 더 낸다.
  playBonusCard(playerId, cardId) {
    const r = this.round;
    this.assertActionAllowed(playerId);
    const rp = r.players.find((p) => p.id === playerId);
    // 폭탄 이후 스킵 턴(손패 내기 금지)에는 보너스패도 낼 수 없다. 그렇지 않으면 스킵 카운트가
    // 소모되지 않은 채로 "정식으로 한 장 더" 차례가 skipDeckFlip으로 새치기당해 카드가 사라진다.
    if ((rp.skipNextHandPlay || 0) > 0) throw new Error('폭탄 이후 스킵 턴에는 보너스패를 낼 수 없습니다');
    const result = engine.playBonusFromHand(r, playerId, cardId);
    this.addLog(`${this.playerName(playerId)}님이 보너스패를 냈습니다! (상대 피 1장씩 획득, 카드 1장 추가로 뽑음)`);
    // handCardId: 보너스패 자신(손에서 먹은패로 날아가는 애니메이션),
    // drawnCardId: 덱에서 새로 뽑아 손패로 들어온 카드(더미에서 뒤집혀 나오는 애니메이션)
    this.pushEvent('bonus_hand', playerId, {
      handCardId: cardId, drawnCardId: result.drawnCard ? result.drawnCard.id : null,
    });
    // 덱이 말라서 새 카드를 못 뽑았고 그 결과 손패가 완전히 비었다면, "정식으로 한 장 더" 낼
    // 카드 자체가 없는 것이므로 여기서 정상적으로 턴을 마무리(점수/나가리/다음 턴 판정)한다.
    // 그렇지 않으면 currentActor가 낼 수 없는 상태로 영구히 멈춰버린다.
    if (r.hand[playerId].length === 0) {
      return this.afterAction(playerId, result);
    }
    return { status: 'continue-same-player', playerId, events: result.events };
  }

  // 9월 국화(열끗) 카드를 열끗<->쌍피로 전환. 자기 차례가 아니어도, 언제든 가능.
  toggleFlex(playerId, cardId) {
    if (!this.round) throw new Error('진행 중인 판이 없습니다');
    return engine.toggleFlexCard(this.round, playerId, cardId);
  }

  // events 배열 중 가장 임팩트 있는 것 하나를 골라 전체 클라이언트 연출용으로 기록
  emitPrimaryEvent(playerId, events, captured, extra = {}) {
    const priority = ['sweep', 'ppeok_resolved', 'ttadak', 'jjok', 'ppeok_formed', 'bonus_deck'];
    const kind = priority.find((k) => events.includes(k));
    if (kind) this.pushEvent(kind, playerId, extra);
    else if (captured && captured.length > 0) this.pushEvent('capture', playerId, extra);
    else this.pushEvent('place', playerId, extra);
  }

  playBomb(playerId, month) {
    const r = this.round;
    this.assertActionAllowed(playerId);
    // engine.playBomb이 손패 배열을 바로 비워버리므로(state.hand[playerId] = hand.filter(...)),
    // 그 전에 폭탄으로 나갈 손패 카드 3장의 id를 먼저 적어둔다. 클라이언트가 이 3장이 정확히
    // 어느 카드였는지 알아야(handCardIds) "손에서 날아가 먹은패로 내려찍히는" 애니메이션을
    // 재생할 수 있다 - 예전에는 이 정보가 전혀 없어서, 4장(손패 3장+바닥 1장)을 한 번에
    // 먹는 폭탄이 오히려 가장 임팩트 없이(손패 3장은 이동 애니메이션 없이 그냥 결과 화면에
    // 나타나기만) 처리되고 있었다.
    const handCardIds = r.hand[playerId].filter((c) => c.month === month).map((c) => c.id);
    const result = engine.playBomb(r, playerId, month);
    this.addLog(`${this.playerName(playerId)}님이 폭탄을 냈습니다!`);
    this.pushEvent('bomb', playerId, { handCardIds });
    return this.afterAction(playerId, result);
  }

  declareShake(playerId, month) {
    const r = this.round;
    this.assertActionAllowed(playerId);
    engine.declareShake(r, playerId, month);
    this.addLog(`${this.playerName(playerId)}님이 흔들었습니다!`);
    this.pushEvent('shake', playerId);
  }

  playerName(id) {
    return this.players.find((p) => p.id === id)?.name || '???';
  }

  describeEvents(playerId, events) {
    const name = this.playerName(playerId);
    const parts = [];
    if (events.includes('jjok')) parts.push('쪽');
    if (events.includes('ppeok_formed')) parts.push('뻑');
    if (events.includes('ppeok_resolved')) parts.push('뻑 해소');
    if (events.includes('ttadak')) parts.push('따닥');
    if (events.includes('sweep')) parts.push('싹쓸이');
    if (events.includes('bonus_deck')) parts.push('보너스');
    if (parts.length === 0) return `${name}님 차례 진행`;
    return `${name}님: ${parts.join(', ')}!`;
  }

  // 카드 실행 후 공통 처리: 점수 체크, 라운드 종료 체크, 다음 턴 진행
  afterAction(playerId, result) {
    const r = this.round;
    const rp = r.players.find((p) => p.id === playerId);
    const score = engine.computeScore(rp);
    const threshold = engine.scoreThreshold(this.players.length);

    const eligible = score.total >= threshold && (!rp.hasCalledGo || score.total > rp.scoreAtLastGo);

    if (this.isRoundOver() && !eligible) {
      // 아무도 못 끝내고 패가 다 떨어짐 -> 나가리
      return this.finishAsNagari();
    }

    if (eligible) {
      r.phase = 'await-gostop';
      r.pendingGoStop = { playerId, score };
      return { status: 'await-gostop', playerId, score, events: result.events };
    }

    if (this.isRoundOver()) {
      return this.finishAsNagari();
    }

    const next = this.advanceTurn();
    if (!next) return this.finishAsNagari();
    return { status: 'continue', next, events: result.events };
  }

  goStopDecision(playerId, decision) {
    const r = this.round;
    if (!r) throw new Error('진행 중인 판이 없습니다');
    if (r.phase !== 'await-gostop' || r.pendingGoStop?.playerId !== playerId) {
      throw new Error('지금은 고/스톱을 선언할 수 없습니다');
    }
    const rp = r.players.find((p) => p.id === playerId);

    if (decision === 'stop') {
      return this.finishRound(playerId, rp.goCount);
    }

    // go: scoreAtLastGo 기준점은 프롬프트가 뜬 시점의 스냅샷(r.pendingGoStop.score)이 아니라
    // 지금 다시 계산한 점수를 써야 한다. 9월 국화(열끗<->쌍피)는 "언제든" 전환 가능하므로,
    // 고/스톱 응답을 기다리는 그 짧은 사이에 전환해서 점수가 바뀌었을 수 있고, 그 경우 옛날
    // 스냅샷을 기준으로 삼으면 다음 고/스톱 자격 판정(score.total > scoreAtLastGo)이 어긋난다.
    const score = engine.computeScore(rp);
    rp.goCount += 1;
    rp.hasCalledGo = true;
    rp.scoreAtLastGo = score.total;
    // 이 판에서 아직 아무도 고를 안 불렀으면 이 사람이 "처음 고를 선언한 사람"이 된다(고박
    // 대상 판정용). 이미 다른 사람이 먼저 불렀다면(firstGoCallerId가 이미 세팅됨) 갱신하지 않는다.
    if (!r.firstGoCallerId) r.firstGoCallerId = playerId;
    this.addLog(`${this.playerName(playerId)}님이 ${rp.goCount}고를 외쳤습니다!`);
    this.pushEvent('go', playerId, { goCount: rp.goCount });
    r.phase = 'playing';
    r.pendingGoStop = null;

    if (this.isRoundOver()) {
      return this.finishAsNagari();
    }
    const next = this.advanceTurn();
    if (!next) return this.finishAsNagari();
    return { status: 'continue', next };
  }

  finishRound(winnerId, goCount) {
    const r = this.round;
    // goStopDecision('stop')이 여기로 바로 오는데, 'go' 분기와 달리 pendingGoStop을 지우지
    // 않고 있었다. 클라이언트는 phase를 안 보고 round.pendingGoStop이 내 것이면 그냥
    // modal-gostop을 띄우는 구조라서, 이걸 안 지우면 방금 스톱을 눌러 이긴 사람 화면에
    // 결과 모달(modal-result)과 고/스톱 모달(modal-gostop)이 동시에 뜨는 문제가 있었다.
    r.pendingGoStop = null;
    // 고박 대상 표시: gostop_rules.md 7장 "처음 고를 선언한 사람이... 배로 지불한다"는 문구대로,
    // 이 판에서 가장 먼저 고를 부른 사람(firstGoCallerId) 단 한 명만 고박 대상이 된다(그 사람이
    // 곧 승자 본인이면 - 자기가 먼저 고를 부르고 그대로 이겼으면 - 아무도 고박이 아니다).
    // 예전에는 여기서 "goCount>0인 모든 사람"을 전부 고박 대상으로 잘못 표시하고 있었는데,
    // 3~4인 판에서는 서로 다른 플레이어가 각자 자기 턴에 고를 부를 수 있어서(먼저 부른 사람과
    // 나중에 따로 부른 사람이 둘 다 패자로 남는 경우), 그 경우 두 사람 모두에게 고박이 겹쳐
    // 적용돼버리는 규칙 위반이었다.
    r.players.forEach((p) => {
      p.hasCalledGo = p.id === r.firstGoCallerId && p.id !== winnerId;
    });
    const settlement = engine.computeSettlement(r, winnerId, goCount);

    for (const [pid, pay] of Object.entries(settlement.payments)) {
      const amount = Math.round(pay.amount * this.pointValue);
      this.ledger[pid] = (this.ledger[pid] || 0) - amount;
      this.ledger[winnerId] = (this.ledger[winnerId] || 0) + amount;
    }

    r.phase = 'round-end';
    // 정산에 실제로 쓰인 점당 금액을 결과에 같이 남겨둔다. setPointValue는 phase를 안 가리고
    // 언제든(라운드 종료 후 다음 판을 누르기 전 포함) 호스트가 바꿀 수 있는데, 클라이언트의
    // 결과 화면이 이 스냅샷 대신 "현재" state.pointValue를 다시 곱해서 보여주면, 그 사이
    // 점당 금액이 바뀌었을 때 화면에 뜨는 지불액/총 획득이 이미 ledger에 반영된 실제 금액과
    // 어긋나 보일 수 있다.
    r.lastResult = {
      result: 'win', winnerId, settlement, ledger: { ...this.ledger }, winnerName: this.playerName(winnerId),
      pointValueAtSettlement: this.pointValue,
    };
    this.addLog(`${this.playerName(winnerId)}님 승리! (${settlement.scoreBeforeBak}점)`);
    this.pushEvent('win', winnerId);
    return { status: 'round-end', ...r.lastResult };
  }

  finishAsNagari() {
    const r = this.round;
    // finishRound와 같은 이유로 방어적으로 정리한다(이 경로로 올 때는 보통 이미 null이지만,
    // 형제 메서드들과 나란히 같은 습관을 유지하기 위해).
    r.pendingGoStop = null;
    r.phase = 'round-end';
    r.lastResult = { result: 'nagari', ledger: { ...this.ledger } };
    this.addLog('나가리! 아무도 점수를 내지 못했습니다.');
    return { status: 'round-end', ...r.lastResult };
  }

  // 호스트가 강제로 판을 종료 (분쟁 상황 등)
  forceEndRound() {
    if (!this.round) throw new Error('진행 중인 판이 없습니다');
    if (this.round.phase === 'round-end') throw new Error('이미 끝난 판입니다');
    // 호스트가 고/스톱 응답을 기다리는 도중에 판을 강제 종료하면, pendingGoStop을 안 지울 때
    // 그 응답을 기다리던 사람 화면에 결과 모달과 고/스톱 모달이 동시에 뜨는 문제가 있었다
    // (finishRound와 동일한 문제, 위 주석 참고).
    this.round.pendingGoStop = null;
    this.round.phase = 'round-end';
    this.round.lastResult = { result: 'forced', ledger: { ...this.ledger } };
    this.addLog('호스트가 판을 강제 종료했습니다.');
    return { status: 'round-end', ...this.round.lastResult };
  }

  // 클라이언트에 보낼 상태 (본인 손패만 노출, 나머지는 장수만)
  publicState(forPlayerId) {
    const r = this.round;
    const base = {
      code: this.code,
      pointValue: this.pointValue,
      ledger: this.ledger,
      roundNumber: this.roundNumber,
      players: this.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected, isHost: p.isHost })),
      log: this.log.slice(-30),
    };
    if (!r) return { ...base, round: null };

    return {
      ...base,
      round: {
        phase: r.phase,
        deckCount: r.deck.length,
        floor: r.floor,
        turnOrder: r.turnOrder,
        currentActor: r.turnOrder[r.turnIndex % r.turnOrder.length],
        pendingGoStop: r.pendingGoStop,
        lastResult: r.lastResult || null,
        lastEvent: r.lastEvent || null,
        players: r.players.map((p) => ({
          id: p.id,
          captured: p.captured,
          handCount: r.hand[p.id].length,
          shakes: p.shakes,
          bombCount: p.bombCount,
          goCount: p.goCount,
          score: engine.computeScore(p).total,
          // 폭탄 직후 "손패 없이 덱만 뒤집는" 스킵 턴을 몇 번 빚지고 있는지. 손패가 0장인
          // 상태에서 이 빚만 남아있으면 낼 카드가 없으니, 클라이언트가 별도 버튼으로
          // 처리할 수 있도록 노출한다.
          skipNextHandPlay: p.skipNextHandPlay || 0,
        })),
        myHand: r.hand[forPlayerId] || [],
      },
    };
  }
}

module.exports = { Room };

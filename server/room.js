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
  }

  // 모든 클라이언트에게 연출(배너/효과음)을 트리거하기 위한 이벤트 기록
  pushEvent(kind, playerId, extra = {}) {
    this.eventSeq += 1;
    if (this.round) {
      this.round.lastEvent = { seq: this.eventSeq, kind, playerId, playerName: this.playerName(playerId), ...extra };
    }
  }

  addPlayer(name, socketId) {
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
    const playerIds = this.players.map((p) => p.id);
    if (playerIds.length < 2) throw new Error('최소 2명이 필요합니다');
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
    return r.turnOrder.every((pid) => r.hand[pid].length === 0);
  }

  playCard(playerId, cardId, chosenFloorId) {
    const r = this.round;
    if (this.currentActorId() !== playerId) throw new Error('당신의 차례가 아닙니다');
    const rp = r.players.find((p) => p.id === playerId);

    let result;
    if ((rp.skipNextHandPlay || 0) > 0) {
      // 폭탄 이후 스킵 턴: 손패 내지 않고 더미만 뒤집음
      rp.skipNextHandPlay -= 1;
      result = this.skipFlip(playerId);
    } else {
      result = engine.playTurn(r, playerId, cardId, chosenFloorId);
    }
    this.addLog(this.describeEvents(playerId, result.events));
    this.emitPrimaryEvent(playerId, result.events, result.captured);
    return this.afterAction(playerId, result);
  }

  // events 배열 중 가장 임팩트 있는 것 하나를 골라 전체 클라이언트 연출용으로 기록
  emitPrimaryEvent(playerId, events, captured) {
    const priority = ['sweep', 'ppeok_resolved', 'ttadak', 'jjok', 'ppeok_formed'];
    const kind = priority.find((k) => events.includes(k));
    if (kind) this.pushEvent(kind, playerId);
    else if (captured && captured.length > 0) this.pushEvent('capture', playerId);
    else this.pushEvent('place', playerId);
  }

  skipFlip(playerId) {
    const r = this.round;
    if (r.deck.length === 0) return { events: [], captured: [] };
    const flipped = r.deck.shift();
    const match = engine.resolveMatch(r.floor, flipped);
    const player = r.players.find((p) => p.id === playerId);
    if (match.count === 0) {
      r.floor.push({ ...flipped, placedBy: 'deck', stuck: false });
      return { events: [], captured: [] };
    }
    if (match.count === 3) {
      r.floor = r.floor.filter((c) => c.month !== flipped.month);
      [flipped, ...match.matches].forEach((c) => player.captured[c.type].push(c));
      return { events: ['ppeok_resolved'], captured: [flipped, ...match.matches] };
    }
    const chosen = match.matches[0];
    r.floor = r.floor.filter((c) => c.id !== chosen.id);
    [flipped, chosen].forEach((c) => player.captured[c.type].push(c));
    return { events: [], captured: [flipped, chosen] };
  }

  playBomb(playerId, month) {
    const r = this.round;
    if (this.currentActorId() !== playerId) throw new Error('당신의 차례가 아닙니다');
    const result = engine.playBomb(r, playerId, month);
    this.addLog(`${this.playerName(playerId)}님이 폭탄을 냈습니다!`);
    this.pushEvent('bomb', playerId);
    return this.afterAction(playerId, result);
  }

  declareShake(playerId, month) {
    const r = this.round;
    if (this.currentActorId() !== playerId) throw new Error('당신의 차례가 아닙니다');
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
    if (r.phase !== 'await-gostop' || r.pendingGoStop?.playerId !== playerId) {
      throw new Error('지금은 고/스톱을 선언할 수 없습니다');
    }
    const rp = r.players.find((p) => p.id === playerId);
    const score = r.pendingGoStop.score;

    if (decision === 'stop') {
      return this.finishRound(playerId, rp.goCount);
    }

    // go
    rp.goCount += 1;
    rp.hasCalledGo = true;
    rp.scoreAtLastGo = score.total;
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
    // 고박 표시: 승자 외 먼저 고를 부른 적 있는 플레이어
    r.players.forEach((p) => {
      p.hasCalledGo = p.id !== winnerId && p.goCount > 0;
    });
    const settlement = engine.computeSettlement(r, winnerId, goCount);

    for (const [pid, pay] of Object.entries(settlement.payments)) {
      const amount = Math.round(pay.amount * this.pointValue);
      this.ledger[pid] = (this.ledger[pid] || 0) - amount;
      this.ledger[winnerId] = (this.ledger[winnerId] || 0) + amount;
    }

    r.phase = 'round-end';
    r.lastResult = { result: 'win', winnerId, settlement, ledger: { ...this.ledger }, winnerName: this.playerName(winnerId) };
    this.addLog(`${this.playerName(winnerId)}님 승리! (${settlement.scoreBeforeBak}점)`);
    this.pushEvent('win', winnerId);
    return { status: 'round-end', ...r.lastResult };
  }

  finishAsNagari() {
    const r = this.round;
    r.phase = 'round-end';
    r.lastResult = { result: 'nagari', ledger: { ...this.ledger } };
    this.addLog('나가리! 아무도 점수를 내지 못했습니다.');
    return { status: 'round-end', ...r.lastResult };
  }

  // 호스트가 강제로 판을 종료 (분쟁 상황 등)
  forceEndRound() {
    if (!this.round || this.round.phase === 'round-end') throw new Error('진행중인 판이 없습니다');
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
        })),
        myHand: r.hand[forPlayerId] || [],
      },
    };
  }
}

module.exports = { Room };

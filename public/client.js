const socket = io();

let myId = null;
let roomCode = null;
let latestState = null;
let selectedHandCardId = null;
let lastSeenEventSeq = 0;
let eventSeqInitialized = false;

const el = (id) => document.getElementById(id);
const show = (id) => el(id).classList.remove('hidden');
const hide = (id) => el(id).classList.add('hidden');

function ribbonClass(card) {
  if (card.type !== 'tti') return '';
  if (card.ribbonColor === 'hong') return 'tti-hong';
  if (card.ribbonColor === 'cho') return 'tti-cho';
  if (card.ribbonColor === 'cheong') return 'tti-cheong';
  return '';
}

const TYPE_BADGE = { gwang: '光', yeolkkeut: '열끗', tti: '띠', pi: '피' };

// 새로 나타난 카드에 등장 애니메이션을 주기 위해 이전에 본 카드 id들을 기억
const seenCardIds = new Set();

// 실제 화투 카드 그림 (48장 전부). 출처: Louie Mantia, Wikipedia "Sakura (card game)" 문서,
// CC BY-SA 4.0 라이선스 (https://creativecommons.org/licenses/by-sa/4.0/). public/assets/cards/*.webp
function cardEl(card, { onClick, selected, mini } = {}) {
  const div = document.createElement('div');
  div.className = `card ${card.type} ${ribbonClass(card)}${mini ? ' mini' : ''}`;
  if (card.piValue === 2) div.classList.add('double');
  if (card.stuck) div.classList.add('stuck');
  if (selected) div.classList.add('selected');
  const seenKey = card.id + ':' + (card.stuck ? 'stuck' : 'flat');
  if (!seenCardIds.has(seenKey)) div.classList.add('pop');
  seenCardIds.add(seenKey);
  div.dataset.id = card.id;
  div.innerHTML = `
    <img class="art-img" src="assets/cards/${card.id}.webp" alt="${card.month}월 ${TYPE_BADGE[card.type] || ''}" draggable="false" />
    <div class="badge badge-type">${TYPE_BADGE[card.type] || ''}</div>
    <div class="badge badge-month">${card.month}월</div>
  `;
  if (onClick) div.addEventListener('click', () => onClick(card));
  return div;
}

function cardBackEl(mini) {
  const div = document.createElement('div');
  div.className = 'card back' + (mini ? ' mini' : '');
  return div;
}

// ---------- 먹은 패 정리 (실제 고스톱처럼 광/열끗/띠/피로 줄 맞춰 정리, 피는 겹쳐서 부채꼴로) ----------
const TYPE_LABEL = { gwang: '광', yeolkkeut: '열끗', tti: '띠', pi: '피' };

// 실제 고스톱에서 먹은 패를 정리하는 방식: 광/열끗/띠/피 종류별로 줄을 나누고,
// 각 줄 안에서는 카드를 겹쳐서(부채꼴처럼) 쌓아 자리를 아낀다 - 피처럼 많이 쌓이는 줄일수록 더 많이 겹친다.
// 먹은 패 정리: 카드 자체는 세운 채로 두고(회전 없음), 광/열끗/띠/피 네 그룹을
// 위아래로 쌓지 않고 왼쪽→오른쪽 한 줄로 나란히 배치한다(정렬 방향 = 가로).
// 각 그룹 안에서도 카드들이 옆으로 겹쳐 쌓인다.
function capturedGroups(captured, { mini } = {}) {
  const overlap = mini
    ? { gwang: -14, yeolkkeut: -16, tti: -16, pi: -18 }
    : { gwang: -32, yeolkkeut: -36, tti: -36, pi: -42 };
  const wrap = document.createElement('div');
  wrap.className = 'cap-groups' + (mini ? ' mini' : '');
  ['gwang', 'yeolkkeut', 'tti', 'pi'].forEach((type) => {
    const cards = captured[type];
    const group = document.createElement('div');
    group.className = `cap-group cap-${type}`;
    const label = document.createElement('span');
    label.className = 'cap-label';
    const count = type === 'pi' ? piValueOf(cards) : cards.length;
    label.textContent = `${TYPE_LABEL[type]} ${count}`;
    group.appendChild(label);
    const cardsWrap = document.createElement('div');
    cardsWrap.className = 'cap-cards';
    cards.forEach((c, i) => {
      const cel = cardEl(c, { mini });
      if (i > 0) cel.style.marginLeft = overlap[type] + 'px';
      cardsWrap.appendChild(cel);
    });
    group.appendChild(cardsWrap);
    wrap.appendChild(group);
  });
  return wrap;
}

// ---------- FLIP 방식 이동 애니메이션 ----------
// 리렌더 전/후 카드 위치를 비교해서, 같은 카드(id)가 다른 위치로 옮겨갔으면
// 그 이동 거리만큼 트랜스폼을 줬다가 원위치로 되돌려 "이동하는 것처럼" 보이게 한다.
function captureCardRects() {
  const map = new Map();
  document.querySelectorAll('.card[data-id]').forEach((elm) => {
    map.set(elm.dataset.id, elm.getBoundingClientRect());
  });
  return map;
}

function runFlipAnimation(oldRects, fallbackOriginRect) {
  requestAnimationFrame(() => {
    document.querySelectorAll('.card[data-id]').forEach((elm) => {
      const now = elm.getBoundingClientRect();
      const old = oldRects.get(elm.dataset.id);
      let dx = 0, dy = 0, isNew = false;
      if (old) {
        dx = old.left - now.left;
        dy = old.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      } else if (fallbackOriginRect) {
        dx = fallbackOriginRect.left - now.left;
        dy = fallbackOriginRect.top - now.top;
        isNew = true;
      } else {
        return;
      }
      elm.style.transition = 'none';
      elm.style.transform = `translate(${dx}px, ${dy}px) scale(${isNew ? 0.5 : 0.94}) rotate(${isNew ? -12 : -4}deg)`;
      elm.style.zIndex = '30';
      // eslint-disable-next-line no-unused-expressions
      elm.offsetWidth; // 강제 리플로우
      elm.style.transition = 'transform 0.32s cubic-bezier(.22,.85,.32,1.15)';
      elm.style.transform = '';
      elm.addEventListener('transitionend', () => { elm.style.zIndex = ''; }, { once: true });
    });
  });
}

// ---------- 사운드 ----------
// 실제로 녹음/제작된 효과음 파일(public/assets/audio/*.mp3, CC0 - "uisfx" 패키지)과
// 저음을 더해주는 합성음을 함께 재생해서 카드가 "탁!" 떨어지는 타격감을 낸다.
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
document.addEventListener('click', () => ensureAudio(), { once: true });

function beep(freq, duration, { type = 'sine', gain = 0.15, delay = 0 } = {}) {
  try {
    const ctx = ensureAudio();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.value = gain;
    osc.connect(g).connect(ctx.destination);
    const t = ctx.currentTime + delay;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  } catch (e) { /* 오디오 미지원 브라우저는 조용히 무시 */ }
}

const sfxCache = {};
function playSfx(file, { volume = 0.6, rate = 1, delay = 0 } = {}) {
  const fire = () => {
    try {
      let base = sfxCache[file];
      if (!base) {
        base = new Audio(`assets/audio/${file}`);
        sfxCache[file] = base;
      }
      const node = base.cloneNode(true); // 겹쳐 재생 가능하도록 매번 복제
      node.volume = volume;
      node.playbackRate = rate;
      node.play().catch(() => {});
    } catch (e) { /* 무시 */ }
  };
  if (delay > 0) setTimeout(fire, delay * 1000);
  else fire();
}

// 카드가 손에서 바닥/더미로 "탁!" 떨어지는 느낌: 실제 녹음된 스냅 소리 + 저음 합성음을 겹친다
function cardSlap(delay = 0) {
  playSfx('card-snap.mp3', { volume: 0.7, delay });
  beep(115, 0.09, { type: 'sine', gain: 0.2, delay });
}

const SOUND = {
  place: () => cardSlap(),
  capture: () => { cardSlap(); playSfx('capture-check.mp3', { volume: 0.5, delay: 0.06 }); },
  jjok: () => { cardSlap(); playSfx('ui-click.mp3', { volume: 0.55, delay: 0.07 }); },
  ppeok: () => { cardSlap(); playSfx('ppeok.mp3', { volume: 0.65, delay: 0.03 }); },
  ttadak: () => { cardSlap(0); cardSlap(0.1); playSfx('ttadak.mp3', { volume: 0.6, delay: 0.02 }); },
  sweep: () => { cardSlap(); playSfx('sweep.mp3', { volume: 0.75, delay: 0.06 }); },
  bomb: () => { cardSlap(0); cardSlap(0.05); cardSlap(0.1); beep(80, 0.35, { type: 'square', gain: 0.2, delay: 0.1 }); },
  shake: () => { [0, 0.09, 0.18].forEach((d) => cardSlap(d)); },
  go: () => playSfx('go.mp3', { volume: 0.7 }),
  win: () => playSfx('win.mp3', { volume: 0.8 }),
};

// 버튼 클릭마다 가벼운 UI 클릭음을 더해 조작감을 살린다 (게임 이벤트 효과음과는 별도)
document.addEventListener('click', (e) => {
  if (e.target.closest('button')) playSfx('ui-click.mp3', { volume: 0.3 });
});

const EVENT_LABEL = {
  jjok: '쪽!', ppeok_formed: '뻑!', ppeok_resolved: '뻑 해소!', ttadak: '따닥!',
  sweep: '싹쓸이!!', bomb: '폭탄!!', shake: '흔들기!', go: '고!', win: '승리!',
};
const EVENT_SOUND = {
  jjok: 'jjok', ppeok_formed: 'ppeok', ppeok_resolved: 'ppeok', ttadak: 'ttadak',
  sweep: 'sweep', bomb: 'bomb', shake: 'shake', go: 'go', win: 'win',
  capture: 'capture', place: 'place',
};

function showBanner(text) {
  const banner = el('event-banner');
  banner.textContent = text;
  banner.classList.remove('show');
  // 리플로우를 강제해서 애니메이션을 재시작
  void banner.offsetWidth;
  banner.classList.remove('hidden');
  banner.classList.add('show');
  setTimeout(() => banner.classList.add('hidden'), 1100);
}

function shakeBoard() {
  const board = document.querySelector('.board');
  if (!board) return;
  board.classList.remove('shake');
  void board.offsetWidth;
  board.classList.add('shake');
}

function handleGameEvent(evt) {
  const label = EVENT_LABEL[evt.kind];
  if (label) showBanner(`${evt.playerName ? evt.playerName + ' ' : ''}${label}`);
  const soundKey = EVENT_SOUND[evt.kind];
  if (soundKey && SOUND[soundKey]) SOUND[soundKey]();
  if (evt.kind === 'bomb' || evt.kind === 'sweep') shakeBoard();
}

// ---------- 화면 전환 ----------
function goScreen(name) {
  ['lobby', 'room', 'game'].forEach((s) => {
    if (s === name) show(`screen-${s}`);
    else hide(`screen-${s}`);
  });
}

// ---------- 로비 ----------
el('btn-create').addEventListener('click', () => {
  const name = el('create-name').value.trim() || '플레이어';
  socket.emit('room:create', { name }, (res) => {
    if (!res.ok) return (el('lobby-error').textContent = res.error);
    onJoined(res.roomCode, res.playerId);
  });
});

el('btn-join').addEventListener('click', () => {
  const name = el('join-name').value.trim() || '플레이어';
  const code = el('join-code').value.trim().toUpperCase();
  socket.emit('room:join', { roomCode: code, name }, (res) => {
    if (!res.ok) return (el('lobby-error').textContent = res.error);
    onJoined(res.roomCode, res.playerId);
  });
});

function onJoined(code, playerId) {
  roomCode = code;
  myId = playerId;
  localStorage.setItem('gostop', JSON.stringify({ roomCode, playerId }));
  history.replaceState(null, '', `?room=${code}`);
}

// 새로고침 대비 자동 재접속
(function tryRejoin() {
  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room');
  const saved = JSON.parse(localStorage.getItem('gostop') || 'null');
  if (saved && (!roomParam || roomParam === saved.roomCode)) {
    socket.emit('room:rejoin', saved, (res) => {
      if (res.ok) onJoined(res.roomCode, res.playerId);
      else if (roomParam) el('join-code').value = roomParam;
    });
  } else if (roomParam) {
    el('join-code').value = roomParam;
  }
})();

// ---------- 대기방 ----------
el('btn-set-point').addEventListener('click', () => {
  const value = Number(el('point-value-input').value);
  socket.emit('game:setPointValue', { value }, (res) => {
    if (!res.ok) alert(res.error);
  });
});

el('btn-start').addEventListener('click', () => {
  socket.emit('game:start', {}, (res) => {
    if (!res.ok) alert(res.error);
  });
});

function destroyRoom() {
  if (!confirm('정말 방을 폭파할까요? 모든 사람이 로비로 돌아갑니다.')) return;
  socket.emit('room:destroy', {}, (res) => {
    if (!res.ok) alert(res.error);
  });
}
el('btn-destroy-room-lobby').addEventListener('click', destroyRoom);
el('btn-destroy-room').addEventListener('click', destroyRoom);

socket.on('room:destroyed', () => {
  localStorage.removeItem('gostop');
  alert('호스트가 방을 폭파했습니다.');
  location.href = location.pathname;
});

function renderRoom(state) {
  el('room-code-label').textContent = state.code;
  const list = el('room-player-list');
  list.innerHTML = '';
  state.players.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = `${p.name}${p.isHost ? ' (호스트)' : ''}${p.connected ? '' : ' - 접속끊김'}`;
    list.appendChild(li);
  });
  const me = state.players.find((p) => p.id === myId);
  if (me?.isHost) {
    show('host-controls');
    el('point-value-input').value = state.pointValue;
  } else {
    hide('host-controls');
  }
}

// ---------- 게임 화면 ----------
let lastSeenRoundNumber = null;
function renderGame(state) {
  const round = state.round;
  const me = round.players.find((p) => p.id === myId);
  const myPlayerMeta = state.players.find((p) => p.id === myId);

  if (lastSeenRoundNumber !== state.roundNumber) {
    lastSeenRoundNumber = state.roundNumber;
    seenCardIds.clear(); // 새 판이 시작되면 카드 등장 애니메이션을 다시 재생
  }

  // 상대 목록 - 손패(뒷면 카드 더미)와 먹은 패(실제 카드)를 눈에 보이게 표시
  const opp = el('opponents');
  opp.innerHTML = '';
  round.players.filter((p) => p.id !== myId).forEach((p) => {
    const meta = state.players.find((s) => s.id === p.id);
    const box = document.createElement('div');
    box.className = 'opponent-card' + (round.currentActor === p.id ? ' current-turn' : '');

    const badges = [
      p.goCount > 0 ? `${p.goCount}고` : '',
      p.shakes.length ? `흔들x${p.shakes.length}` : '',
      p.bombCount ? `폭탄x${p.bombCount}` : '',
    ].filter(Boolean).join(' · ');

    const header = document.createElement('div');
    header.className = 'opp-header';
    header.innerHTML = `
      <span class="name">${meta?.name || '???'}${meta?.connected ? '' : ' (끊김)'}</span>
      <span class="opp-score">${p.score}점${badges ? ' · ' + badges : ''}</span>
    `;
    box.appendChild(header);

    const handRow = document.createElement('div');
    handRow.className = 'opp-hand-row';
    for (let i = 0; i < p.handCount; i++) handRow.appendChild(cardBackEl(true));
    if (p.handCount === 0) {
      const empty = document.createElement('span');
      empty.className = 'opp-empty-label';
      empty.textContent = '손패 없음';
      handRow.appendChild(empty);
    }
    box.appendChild(handRow);

    const anyCaptured = ['gwang', 'yeolkkeut', 'tti', 'pi'].some((t) => p.captured[t].length > 0);
    if (anyCaptured) {
      box.appendChild(capturedGroups(p.captured, { mini: true }));
    } else {
      const empty = document.createElement('div');
      empty.className = 'opp-empty-label';
      empty.textContent = '먹은 패 없음';
      box.appendChild(empty);
    }

    opp.appendChild(box);
  });

  // 바닥
  el('deck-count').textContent = `덱 ${round.deckCount}장 남음`;
  const isMyTurn = round.currentActor === myId && round.phase === 'playing';
  el('turn-indicator').textContent = isMyTurn ? '내 차례!' : `${state.players.find((p) => p.id === round.currentActor)?.name || ''}님 차례`;

  const floorDiv = el('floor');
  floorDiv.innerHTML = '';
  round.floor.forEach((c) => {
    const onClick = isMyTurn && selectedHandCardId ? () => tryPlay(selectedHandCardId, c.id) : null;
    floorDiv.appendChild(cardEl(c, { onClick }));
  });

  // 내 정보
  el('my-score').textContent = `내 점수: ${me.score}점`;
  const capRow = el('my-captured');
  capRow.innerHTML = '';
  capRow.appendChild(capturedGroups(me.captured));

  const handRow = el('my-hand');
  handRow.innerHTML = '';
  round.myHand.forEach((c) => {
    const div = cardEl(c, {
      selected: c.id === selectedHandCardId,
      onClick: () => {
        if (!isMyTurn) return;
        selectedHandCardId = c.id;
        tryPlay(c.id);
      },
    });
    handRow.appendChild(div);
  });

  // 흔들기/폭탄 버튼
  const monthCounts = {};
  round.myHand.forEach((c) => (monthCounts[c.month] = (monthCounts[c.month] || 0) + 1));
  const shakeable = Object.entries(monthCounts).filter(([m, n]) => n === 3 && !me.shakes.includes(Number(m)));
  const bombable = Object.entries(monthCounts).filter(([m, n]) => n === 3 &&
    round.floor.filter((c) => c.month === Number(m)).length === 1);

  if (isMyTurn && shakeable.length) show('btn-shake'); else hide('btn-shake');
  if (isMyTurn && bombable.length) show('btn-bomb'); else hide('btn-bomb');
  el('btn-shake').onclick = () => openMonthModal('modal-shake', 'shake-options', shakeable.map(([m]) => Number(m)), (month) => {
    socket.emit('game:declareShake', { month }, (res) => { if (!res.ok) alert(res.error); });
    hide('modal-shake');
  });
  el('btn-bomb').onclick = () => openMonthModal('modal-bomb', 'bomb-options', bombable.map(([m]) => Number(m)), (month) => {
    socket.emit('game:playBomb', { month }, (res) => { if (!res.ok) alert(res.error); });
    hide('modal-bomb');
  });

  // 고/스톱 모달
  if (round.pendingGoStop && round.pendingGoStop.playerId === myId) {
    el('gostop-score-label').textContent = `현재 ${round.pendingGoStop.score.total}점입니다. 고 하시겠습니까?`;
    show('modal-gostop');
  } else {
    hide('modal-gostop');
  }

  // 라운드 종료 모달
  if (round.phase === 'round-end' && round.lastResult) {
    renderResult(round.lastResult, state, myPlayerMeta?.isHost);
    show('modal-result');
  } else {
    hide('modal-result');
  }

  // 호스트 컨트롤: 방 폭파는 언제나, 판 무효/점당 금액 조정은 라운드 진행 중에만
  if (myPlayerMeta?.isHost) {
    show('host-round-controls');
    if (round.phase !== 'round-end') {
      show('host-active-round-controls');
      if (document.activeElement !== el('point-value-input-game')) {
        el('point-value-input-game').value = state.pointValue;
      }
    } else {
      hide('host-active-round-controls');
    }
  } else {
    hide('host-round-controls');
  }

  // 새 이벤트(뻑/따닥/폭탄 등) 연출 - 처음 접속/새로고침 시점의 과거 이벤트는 재생하지 않음
  if (!eventSeqInitialized) {
    lastSeenEventSeq = round.lastEvent?.seq || 0;
    eventSeqInitialized = true;
  } else if (round.lastEvent && round.lastEvent.seq > lastSeenEventSeq) {
    lastSeenEventSeq = round.lastEvent.seq;
    handleGameEvent(round.lastEvent);
  }

  // 정산 바
  const ledgerBar = el('ledger-bar');
  ledgerBar.innerHTML = '';
  state.players.forEach((p) => {
    const amount = state.ledger[p.id] || 0;
    const span = document.createElement('span');
    span.className = 'ledger-chip ' + (amount > 0 ? 'plus' : amount < 0 ? 'minus' : 'zero');
    span.textContent = `${p.name} ${amount >= 0 ? '+' : ''}${amount.toLocaleString()}원`;
    ledgerBar.appendChild(span);
  });

  // 로그
  const logDiv = el('log-feed');
  logDiv.innerHTML = state.log.map((l) => `<div>${l.message}</div>`).join('');
  logDiv.scrollTop = logDiv.scrollHeight;
}

function piValueOf(piCards) {
  return piCards.reduce((s, c) => s + (c.piValue || 1), 0);
}

function tryPlay(cardId, chosenFloorId) {
  socket.emit('game:playCard', { cardId, chosenFloorId }, (res) => {
    if (res.ok) {
      selectedHandCardId = null;
      hide('modal-choice');
      return;
    }
    if (res.needChoice) {
      openChoiceModal(res.matches, (chosenId) => tryPlay(cardId, chosenId));
    } else {
      alert(res.error);
      selectedHandCardId = null;
    }
  });
}

function openChoiceModal(matches, onPick) {
  const box = el('choice-options');
  box.innerHTML = '';
  matches.forEach((c) => {
    box.appendChild(cardEl(c, { onClick: () => { hide('modal-choice'); onPick(c.id); } }));
  });
  show('modal-choice');
}

function openMonthModal(modalId, optionsId, months, onPick) {
  const box = el(optionsId);
  box.innerHTML = '';
  months.forEach((m) => {
    const btn = document.createElement('button');
    btn.textContent = `${m}월`;
    btn.style.padding = '10px 16px';
    btn.addEventListener('click', () => onPick(m));
    box.appendChild(btn);
  });
  show(modalId);
}

el('shake-cancel').addEventListener('click', () => hide('modal-shake'));
el('bomb-cancel').addEventListener('click', () => hide('modal-bomb'));

el('btn-go').addEventListener('click', () => socket.emit('game:goStop', { decision: 'go' }, (res) => { if (!res.ok) alert(res.error); }));
el('btn-stop').addEventListener('click', () => socket.emit('game:goStop', { decision: 'stop' }, (res) => { if (!res.ok) alert(res.error); }));

el('btn-force-end').addEventListener('click', () => {
  if (!confirm('정말 이번 판을 무효 처리할까요?')) return;
  socket.emit('game:endRoundNow', {}, (res) => { if (!res.ok) alert(res.error); });
});

el('btn-set-point-game').addEventListener('click', () => {
  const value = Number(el('point-value-input-game').value);
  socket.emit('game:setPointValue', { value }, (res) => { if (!res.ok) alert(res.error); });
});

el('btn-next-round').addEventListener('click', () => {
  socket.emit('game:nextRound', {}, (res) => { if (!res.ok) alert(res.error); });
});

function renderResult(result, state, isHost) {
  el('result-title').textContent =
    result.result === 'win' ? `🎉 ${result.winnerName}님 승리!` :
    result.result === 'nagari' ? '나가리 (무효)' : '판 강제 종료';

  const body = el('result-body');
  if (result.result === 'win') {
    const s = result.settlement;
    const rows = Object.entries(s.payments).map(([pid, pay]) => {
      const name = state.players.find((p) => p.id === pid)?.name || pid;
      return `<tr><td>${name}</td><td>${pay.reasons.join(', ') || '-'}</td><td>-${Math.round(pay.amount * state.pointValue).toLocaleString()}원</td></tr>`;
    }).join('');
    body.innerHTML = `
      <p>기본점 ${s.base.total}점 (광${s.base.gwangScore} 띠${s.base.ttiScore} 열${s.base.yeolkkeutScore} 피${s.base.piScore})
      + 고 ${s.goCount}회(가산 ${s.goAddPoint}, 배율 x${s.goMultiplier}) · 흔들기/폭탄 배율 x${s.shakeBombMultiplier}
      = <b>${s.scoreBeforeBak}점</b></p>
      <table><tr><th>플레이어</th><th>박</th><th>지불액</th></tr>${rows}</table>
    `;
  } else {
    body.innerHTML = '<p>다음 판으로 넘어갑니다.</p>';
  }
  if (isHost) show('result-host-actions'); else hide('result-host-actions');
}

// ---------- 소켓 상태 반영 ----------
socket.on('room:state', (state) => {
  if (!state.round) {
    latestState = state;
    goScreen('room');
    renderRoom(state);
    return;
  }

  // 리렌더 직전의 카드 위치를 기록해뒀다가, 리렌더 후 위치 변화만큼 되짚어 애니메이션 -> "집어서 옮기는" 느낌
  const oldRects = captureCardRects();
  latestState = state;
  goScreen('game');
  renderGame(state);
  const deckStack = el('deck-stack');
  runFlipAnimation(oldRects, deckStack ? deckStack.getBoundingClientRect() : null);
});

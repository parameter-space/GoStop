const socket = io();

let myId = null;
let roomCode = null;
let latestState = null;
let selectedHandCardId = null;
let lastSeenEventSeq = 0;
let eventSeqInitialized = false;

const el = (id) => document.getElementById(id);

// 날아다니는 카드들끼리 화면에서 겹칠 때 어느 게 위에 보일지 정하는 값. "몇 ms 뒤에 출발할
// 예정인지"(delay) 값 자체로 z-index를 매겼더니(예전 시도), 아직 실제로는 움직이지 않고
// 원래 자리에 가만히 대기 중인 카드(delay가 커서 나중 페이즈에 출발 예정)가, 그 사이 먼저
// 진짜로 날아가고 있는 카드보다 더 높은 값을 갖게 되는 역전이 생겼다(예: 손패 카드와 함께
// 캡처되는 바닥 카드는 대기 시간이 제일 길어서, 아직 가만히 있을 뿐인데 한창 날아가는 중인
// 덱 카드보다 z-index가 높아져 그 위를 덮어버림). 그래서 "얼마나 나중에 출발하는지"가 아니라
// "실제로 지금 막 움직이기 시작했는지"를 기준으로 삼는다 - 카드가 진짜로 움직이기 시작하는
// 바로 그 순간에만 이 카운터를 하나씩 올려 받아쓰면, 실제 시간 순서대로 항상 최근에 움직인
// 카드가 위에 보인다.
let nextFlightZIndex = 100;

// 카드 이동 애니메이션이 실제 재생 환경(사용자 브라우저)에서 어떻게 동작하는지 원격으로
// 진단하기 위한 스위치. 브라우저 콘솔에서 localStorage.debugAnim='1' 설정 후 새로고침하면
// 매 렌더마다 어떤 카드가 어디서 왔다고 판단됐는지(dx/dy/style/delay)를 콘솔에 남긴다.
const DEBUG_ANIM = (() => {
  try { return localStorage.getItem('debugAnim') === '1'; } catch (e) { return false; }
})();
// 콘솔에 쌓인 로그를 한 줄씩 手동으로 긁어 복사하기 번거로우니, window.__animLog에도 같이
// 모아둔다. 콘솔에서 copy(__animLog.join('\n')) 한 번이면 지금까지 쌓인 전부가 클립보드로
// 복사된다.
window.__animLog = [];
function logAnim(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  window.__animLog.push(line);
  console.log(line);
}

// 플레이어 닉네임은 사용자가 자유롭게 입력한 문자열이라, 그걸 그대로 innerHTML 템플릿에
// 끼워넣으면 다른 사람 화면에서 그대로 스크립트로 실행될 수 있다(예: 이름을
// "<img src=x onerror=...>"로 설정). innerHTML에 넣기 전에는 항상 이 함수로 이스케이프한다.
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
const show = (id) => el(id).classList.remove('hidden');
const hide = (id) => el(id).classList.add('hidden');

// --- 모달 접근성: 포커스 트랩 / ESC 닫기 / 포커스 복원 ---------------------------------
// modal-choice/modal-gostop/modal-result는 렌더가 다시 돌 때마다(다른 플레이어의 행동으로
// 상태가 갱신될 때마다) show/hide가 반복 호출된다. 이미 열려/닫혀 있는데 또 열고/닫는
// 취급을 하면 그때마다 포커스를 빼앗아가서 키보드로 탐색 중인 사용자를 방해하게 되므로,
// 실제로 감춤<->표시 상태가 "전환"될 때만 포커스를 옮기고 복원한다.
let lastFocusedBeforeModal = null;

// ESC로 닫을 수 있는 모달만 등록한다. modal-choice/modal-gostop/modal-result는 사용자가
// 반드시 응답해야 하는 강제 선택지라서 ESC로 그냥 닫아버리면 안 된다.
const MODAL_CANCEL_BUTTON = {
  'modal-rules': 'rules-close',
  'modal-shake': 'shake-cancel',
  'modal-bomb': 'bomb-cancel',
};

function focusablesIn(container) {
  return Array.from(container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )).filter((elm) => !elm.disabled && elm.offsetParent !== null);
}

function showModal(id) {
  const modal = el(id);
  if (!modal.classList.contains('hidden')) return; // 이미 열려 있으면 포커스를 다시 빼앗지 않음
  lastFocusedBeforeModal = document.activeElement;
  modal.classList.remove('hidden');
  const box = modal.querySelector('.modal-box');
  const target = focusablesIn(modal)[0] || box;
  if (box && !box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');
  if (target) target.focus();
}

function hideModal(id) {
  const modal = el(id);
  if (modal.classList.contains('hidden')) return; // 이미 닫혀 있으면 포커스를 복원할 필요 없음
  modal.classList.add('hidden');
  if (lastFocusedBeforeModal && document.body.contains(lastFocusedBeforeModal)
    && typeof lastFocusedBeforeModal.focus === 'function') {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

document.addEventListener('keydown', (e) => {
  const openModal = document.querySelector('.modal:not(.hidden)');
  if (!openModal) return;
  if (e.key === 'Escape') {
    const cancelId = MODAL_CANCEL_BUTTON[openModal.id];
    if (cancelId) { e.preventDefault(); el(cancelId).click(); }
    return;
  }
  if (e.key !== 'Tab') return;
  // 모달이 열려 있는 동안은 Tab이 모달 밖(뒤에 깔린 게임판)으로 빠져나가지 않게 가둔다.
  const focusables = focusablesIn(openModal);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

function ribbonClass(card) {
  if (card.type !== 'tti') return '';
  if (card.ribbonColor === 'hong') return 'tti-hong';
  if (card.ribbonColor === 'cho') return 'tti-cho';
  if (card.ribbonColor === 'cheong') return 'tti-cheong';
  return '';
}

const TYPE_BADGE = { gwang: '光', yeolkkeut: '열끗', tti: '띠', pi: '피', bonus: '보너스' };

// 손패를 월 순으로 정렬해서 찾기 쉽게 한다. 월이 없는 보너스패는 맨 뒤로.
// 같은 월 안에서는 광 > 열끗 > 띠 > 피 순으로 둬서 눈에 잘 들어오게 정리한다.
const HAND_TYPE_ORDER = { gwang: 0, yeolkkeut: 1, tti: 2, pi: 3 };
function sortedHand(cards) {
  return [...cards].sort((a, b) => {
    if (a.month == null && b.month == null) return 0;
    if (a.month == null) return 1;
    if (b.month == null) return -1;
    if (a.month !== b.month) return a.month - b.month;
    return (HAND_TYPE_ORDER[a.type] ?? 9) - (HAND_TYPE_ORDER[b.type] ?? 9);
  });
}

// 새로 나타난 카드에 등장 애니메이션을 주기 위해 이전에 본 카드 id들을 기억
const seenCardIds = new Set();

// 실제 화투 카드 그림 (48장 전부). 출처: Louie Mantia, Wikipedia "Sakura (card game)" 문서,
// CC BY-SA 4.0 라이선스 (https://creativecommons.org/licenses/by-sa/4.0/). public/assets/cards/*.webp
// 보너스패 2장은 실제 상품 이미지가 없어서 자체 디자인(별 무늬 + 텍스트)으로 그린다.
// 카드 한 장을 스크린 리더 등에서 알아들을 수 있는 짧은 설명으로 바꾼다.
// (카드가 전부 div로 그려져 있어서, 이 라벨이 없으면 보조기술 사용자에게는 빈 사각형일 뿐이다)
function cardAriaLabel(card) {
  if (card.type === 'bonus') return '보너스패 (쌍피)';
  // card.name은 deck.js에서 이미 "1월 피"/"송학(광)"처럼 월+종류를 알아볼 수 있게 지어져
  // 있어서 그대로 쓰면 충분하다(월/타입을 따로 덧붙이면 "1월 피 1월 피"처럼 겹쳐서 읽힘).
  return card.name || `${card.month}월 ${TYPE_BADGE[card.type] || ''}`.trim();
}

function cardEl(card, { onClick, selected, mini, onFlexToggle } = {}) {
  const div = document.createElement('div');
  div.className = `card ${card.type} ${ribbonClass(card)}${mini ? ' mini' : ''}`;
  if (card.piValue === 2) div.classList.add('double');
  if (card.stuck) div.classList.add('stuck');
  if (selected) div.classList.add('selected');
  const seenKey = card.id + ':' + (card.stuck ? 'stuck' : 'flat');
  if (!seenCardIds.has(seenKey)) div.classList.add('pop');
  seenCardIds.add(seenKey);
  div.dataset.id = card.id;
  div.setAttribute('aria-label', cardAriaLabel(card));

  if (card.type === 'bonus') {
    div.innerHTML = `
      <div class="bonus-face">
        <div class="bonus-medallion">
          <svg class="bonus-emblem" viewBox="0 0 100 100" aria-hidden="true">
            <polygon points="50,4 61,35 94,35 67,55 78,87 50,67 22,87 33,55 6,35 39,35" />
            <circle cx="50" cy="50" r="14" class="bonus-emblem-core" />
          </svg>
        </div>
        <div class="bonus-text">보너스</div>
        <div class="bonus-sub">쌍피</div>
      </div>
    `;
  } else {
    div.innerHTML = `
      <img class="art-img" src="assets/cards/${card.id}.webp" alt="${card.month}월 ${TYPE_BADGE[card.type] || ''}" draggable="false" />
      <div class="badge badge-type">${TYPE_BADGE[card.type] || ''}</div>
      <div class="badge badge-month">${card.month}월</div>
    `;
  }

  // 9월 국화(열끗) 카드: 열끗<->쌍피 전환 버튼 (자기 창고에 있을 때만 onFlexToggle이 전달됨)
  if (card.flexCard && onFlexToggle) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'flex-toggle';
    btn.textContent = card.type === 'pi' ? '열끗으로' : '쌍피로';
    btn.title = '국화(열끗)는 쌍피로도 계산할 수 있어요. 언제든 전환 가능';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onFlexToggle(card);
    });
    div.appendChild(btn);
  }

  // 지금까지는 클릭 가능한 카드가 전부 div라서 마우스로만 조작할 수 있었다. role/tabindex를
  // 주고 Enter·Space로도 onClick이 똑같이 걸리게 해서, 키보드만 쓰는 사용자도 카드를 낼 수
  // 있게 한다(스크린 리더가 이 요소를 "버튼"으로 읽어주는 효과도 있음).
  if (onClick) {
    div.setAttribute('role', 'button');
    div.tabIndex = 0;
    div.addEventListener('click', () => onClick(card));
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick(card);
      }
    });
  }
  return div;
}

function cardBackEl(mini) {
  const div = document.createElement('div');
  div.className = 'card back' + (mini ? ' mini' : '');
  return div;
}

// ---------- 먹은 패 정리 (실제 고스톱처럼 광/열끗/띠/피로 줄 맞춰 정리, 피는 겹쳐서 부채꼴로) ----------
const TYPE_LABEL = { gwang: '광', yeolkkeut: '열끗', tti: '띠', pi: '피' };

// 먹은패 카드는 한 번 자리잡으면(9월 국화를 열끗<->쌍피로 전환하는 아주 드문 경우 말고는)
// 다시 만들 필요가 없는데, 지금까지는 매 렌더마다 광/열끗/띠/피 전부를 통째로 다시 만들고
// 있었다. 이 더미는 게임이 길어질수록 계속 쌓이기만 하는데, 실측해보니(카드 100장 기준)
// renderGame 한 번에 8~16ms까지 걸렸다(빈 더미의 8~16배) - 매 턴 새로 낸 카드 한두 장
// 때문에 이미 자리잡은 수십 장까지 전부 다시 만드는 건 순전한 낭비이고, 게임이 길어질수록
// (실제로 "찰짐"을 느끼려고 몇 판 계속 플레이해볼 때) 누적되어 매 턴 버벅이는 원인이 된다.
// id+type+피값+mini/interactive 조합이 그대로면 이미 만들어둔 DOM을 그대로 재사용한다
// (엘리먼트를 다른 부모에 append하면 원래 있던 자리에서는 자동으로 빠지므로 안전하다).
const capturedCardCache = new Map();
function cachedCardEl(c, opts) {
  const key = `${c.id}:${c.type}:${c.piValue || ''}:${opts.mini ? 1 : 0}:${opts.interactive ? 1 : 0}`;
  let cel = capturedCardCache.get(key);
  if (!cel) {
    cel = cardEl(c, opts);
    capturedCardCache.set(key, cel);
  }
  return cel;
}

// 실제 고스톱에서 먹은 패를 정리하는 방식: 광/열끗/띠/피 종류별로 줄을 나누고,
// 각 줄 안에서는 카드를 겹쳐서(부채꼴처럼) 쌓아 자리를 아낀다 - 피처럼 많이 쌓이는 줄일수록 더 많이 겹친다.
// 먹은 패 정리: 카드 자체는 세운 채로 두고(회전 없음), 광/열끗/띠/피 네 그룹을
// 위아래로 쌓지 않고 왼쪽→오른쪽 한 줄로 나란히 배치한다(정렬 방향 = 가로).
// 각 그룹 안에서도 카드들이 옆으로 겹쳐 쌓인다.
//
// cachedCardEl만으로는 부족했다 - 카드 엘리먼트 자체는 재사용해도 그걸 담는 그릇(cap-groups/
// cap-group/cap-cards)은 매 렌더마다 새로 만들어서 수십 개 엘리먼트를 새 부모에 다시
// appendChild하고 있었는데, 이 트리 구조 변경 자체가 브라우저 레이아웃 재계산을 강제해서
// 실측상 별 차이가 없었다.
//
// 처음엔 통짜 sig(광+열끗+띠+피 전체를 합친 문자열) 하나로만 "바뀐 게 있는지"를 봤는데,
// 그러면 예를 들어 피 그룹에 한 장만 새로 들어와도 전체 sig가 달라져서 광/열끗/띠 그룹까지
// 전부(그 안의 카드 엘리먼트까지) 새 부모로 다시 appendChild해버렸다 - 실측해보니 이게
// 바로 "캡처 애니메이션이 벌어지는 바로 그 순간에, 방금 캡처와 전혀 무관한 이미 먹은
// 패들까지 우르르 같이 움직이는" 현상의 진짜 원인이었다(그것도 상대방 먹은패뿐 아니라
// 내 먹은패에서도 똑같이 일어났다 - opponent-card 박스 너비 변화 때문이 아니라 이 함수
// 자체의 과잉 리빌드 때문이었다). 이제는 타입(광/열끗/띠/피)별로 각자의 sig를 따로 추적해서,
// 실제로 그 타입에 변화가 있을 때만 그 타입의 그룹만(라벨+카드 다시 붙이기) 건드리고,
// 나머지 세 타입의 그룹은 완전히 그대로 - 재부착조차 안 하고 - 둔다.
const capturedGroupsCache = new Map();
function capturedGroups(captured, { mini, interactive, cacheKey } = {}) {
  const overlap = mini
    ? { gwang: -14, yeolkkeut: -16, tti: -16, pi: -18 }
    : { gwang: -32, yeolkkeut: -36, tti: -36, pi: -42 };
  const types = ['gwang', 'yeolkkeut', 'tti', 'pi'];

  let cached = cacheKey && capturedGroupsCache.get(cacheKey);
  if (!cached) {
    const wrap = document.createElement('div');
    wrap.className = 'cap-groups' + (mini ? ' mini' : '');
    // 누구의 먹은패인지 - 피를 뺏기거나 받을 때 카드가 "다른 사람 더미로 넘어갔는지"를
    // 렌더 전후로 비교하는 데 쓴다(captureCardOwners 참고).
    if (cacheKey) wrap.dataset.owner = cacheKey;
    const groups = {};
    types.forEach((type) => {
      const group = document.createElement('div');
      group.className = `cap-group cap-${type}`;
      const label = document.createElement('span');
      label.className = 'cap-label';
      const cardsWrap = document.createElement('div');
      cardsWrap.className = 'cap-cards';
      group.appendChild(label);
      group.appendChild(cardsWrap);
      wrap.appendChild(group);
      groups[type] = { group, label, cardsWrap, sig: null };
    });
    cached = { wrap, groups };
    if (cacheKey) capturedGroupsCache.set(cacheKey, cached);
  }

  types.forEach((type) => {
    const cards = captured[type];
    const sig = cards.map((c) => `${c.id}:${c.type}:${c.piValue || ''}`).join(',');
    const g = cached.groups[type];
    if (g.sig === sig) return; // 이 타입은 안 바뀌었으면 완전히 그대로 둔다
    g.sig = sig;
    const count = type === 'pi' ? piValueOf(cards) : cards.length;
    g.label.textContent = `${TYPE_LABEL[type]} ${count}`;
    g.cardsWrap.innerHTML = '';
    cards.forEach((c, i) => {
      const cel = cachedCardEl(c, { mini, onFlexToggle: interactive ? toggleFlex : null });
      if (i > 0) cel.style.marginLeft = overlap[type] + 'px';
      g.cardsWrap.appendChild(cel);
    });
  });
  return cached.wrap;
}

function toggleFlex(card) {
  socket.emit('game:toggleFlex', { cardId: card.id }, (res) => {
    if (!res.ok) alert(res.error);
  });
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

// 이번 렌더 직전에 바닥(.floor)에 있던 카드 id들을 기록해둔다. "손패로 낸/덱에서 뒤집은
// 카드가 바닥의 어느 카드와 맞춰졌는지"를 찾을 때(animateNewCards), 그냥 "지금 먹은패에
// 있고 월이 같은 카드"만 보면 이미 예전 턴에 먹어서 먹은패에 쭉 있던 같은 월의 다른 카드
// (예: 광)를 잘못 짚어버릴 수 있다 - id는 월로 시작하니 월만 같으면 다 후보가 되기 때문.
// "이번 턴 직전까지 바닥에 있다가 지금 먹은패로 들어간 카드"만 진짜 짝이므로, 그 조건
// (예전에 바닥에 있었는지)을 추가로 걸러내기 위해 따로 기록한다.
function captureFloorCardIds() {
  const set = new Set();
  document.querySelectorAll('.floor .card[data-id]').forEach((elm) => set.add(elm.dataset.id));
  return set;
}

// 먹은패 카드마다 "누구 더미에 있었는지"를 렌더 직전에 기록해둔다. 쪽/뻑/싹쓸이/폭탄/보너스패로
// 상대에게서 피를 받아오면 그 카드는 상대 더미에서 내 더미로 옮겨가는데, 이걸 모르면 그냥
// "자리만 바뀐 카드"로 보고 180ms짜리 가벼운 미끄러짐만 줘서 피를 뺏어온 순간이 거의 안 보였다.
function captureCardOwners() {
  const map = new Map();
  document.querySelectorAll('.cap-groups[data-owner] .card[data-id]').forEach((elm) => {
    map.set(elm.dataset.id, elm.closest('.cap-groups').dataset.owner);
  });
  return map;
}

// 손패 줄(내 손패/상대방 손패 더미)의 렌더 직전 위치를 기록해둔다. 카드를 낼 때
// "그 손에서 빠져나가는" 애니메이션의 출발점으로 쓴다.
function captureHandRowRects() {
  const map = new Map();
  const mine = el('my-hand');
  if (mine) map.set(myId, mine.getBoundingClientRect());
  document.querySelectorAll('.opp-hand-row[data-player-id]').forEach((row) => {
    map.set(row.dataset.playerId, row.getBoundingClientRect());
  });
  return map;
}

// 렌더 후 새로 나타났거나 위치가 바뀐 카드들에 이동 애니메이션을 준다.
// - 기존에 있던 카드가 자리를 옮겼으면: 이전 위치 -> 새 위치로 부드럽게 이동(기존 FLIP 동작 유지).
// - 이번 턴에 손에서 나온 카드(round.lastEvent.handCardId)면: 그 사람의 손패 줄에서 튀어나오는 것처럼.
// - 이번 턴에 덱에서 뒤집힌/뽑힌 카드(flippedCardId/drawnCardId)면: 더미에서 뒤집혀 나오는 것처럼
//   (rotateY로 살짝 "뒤집는" 느낌을 준다) + 더미 그림 자체도 살짝 들썩인다.
// - 어디서 왔는지 알 수 없는 카드(새 판 초기 배분 등)는 카드 자체의 은은한 등장(pop) 효과만 남긴다.
// 전정기관 장애 등으로 motion을 줄이고 싶어하는 사용자 설정을 감지한다. CSS의
// @media (prefers-reduced-motion: reduce)는 선언적 keyframe 애니메이션(@keyframes)에는
// 자동으로 적용되지만, JS가 직접 DOM에 엘리먼트를 만들어 붙이는 .impact-ring 같은 건
// CSS만으로는 막을 수 없어서(만들어버린 뒤에는 @media가 "그 애니메이션을 재생 안 함"만
// 할 뿐 엘리먼트 자체는 여전히 DOM에 남아 animationend가 영영 안 불려 새게 된다) JS
// 쪽에서도 직접 체크해서 아예 만들지 않아야 한다.
function prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 클래스를 하나 붙여 CSS @keyframes 애니메이션을 재생한다. 같은 클래스가 이미 붙어 있어서
// (예: 같은 카드가 아주 짧은 간격으로 다시 반짝여야 하는 드문 경우) 그냥 add만 하면
// 브라우저가 "이미 붙어있는 클래스"로 보고 애니메이션을 재시작하지 않으므로, 그때만
// remove -> 강제 리플로우(offsetWidth) -> add로 확실히 처음부터 다시 재생시킨다. 클래스가
// 아직 없는 보통의 경우(카드 한 장은 평생 한 번만 캡처되므로 거의 항상 이 경우다)는 강제
// 리플로우 없이 바로 add한다 - 싹쓸이/폭탄처럼 카드 여러 장이 한 틱 안에 동시에 반짝일 때,
// 카드마다 강제 리플로우를 읽어대면(레이아웃 스래싱) 그 자체가 끊김의 원인이 되기 때문이다.
function restartAnimClass(elm, className) {
  if (elm.classList.contains(className)) {
    elm.classList.remove(className);
    // eslint-disable-next-line no-unused-expressions
    elm.offsetWidth;
  }
  elm.classList.add(className);
}

// 카드가 착지하는 순간 한 번 과장되게 찌그러지는 "찰진" 타격 임팩트.
function slamCard(elm) {
  if (prefersReducedMotion()) return;
  restartAnimClass(elm, 'slam');
}

// 착지 순간 카드 자체가 아주 짧게 확 밝아졌다 돌아오는 "히트 플래시" - 액션 게임에서 타격을
// 읽기 쉽게 만드는 가장 확실한 기법 중 하나다. transform 애니메이션(slam)만으로는 눈에 잘 안
// 띄어도, 밝기가 확 튀는 프레임 한두 개는 누구 눈에도 분명히 들어온다.
function hitFlash(elm) {
  if (prefersReducedMotion()) return;
  restartAnimClass(elm, 'hit-flash');
}

// 카드가 착지한 지점에 퍼져나가는 충격 링을 하나 만들어 붙였다가, 애니메이션이 끝나면
// 스스로 지운다(계속 쌓이면 DOM이 새므로 반드시 정리한다).
function spawnImpactRing(elm) {
  if (prefersReducedMotion()) return;
  const rect = elm.getBoundingClientRect();
  const ring = document.createElement('div');
  ring.className = 'impact-ring';
  ring.style.left = `${rect.left + rect.width / 2}px`;
  ring.style.top = `${rect.top + rect.height / 2}px`;
  document.body.appendChild(ring);
  ring.addEventListener('animationend', () => ring.remove(), { once: true });
}

function animateNewCards(state, oldRects, oldHandRowRects, isNewGameEvent, oldFloorIds, oldOwners) {
  const deckStack = el('deck-stack');
  const deckRect = deckStack ? deckStack.getBoundingClientRect() : null;
  const evt = (state.round && state.round.lastEvent) || {};
  // 'bomb'이 빠져 있었다 - 폭탄도 명백히 캡처(손패 3장+바닥 1장이 전부 내 먹은패로 들어감)인데
  // 여기 없어서 willCapture()가 항상 false를 줬다. 그 결과: (1) 바닥의 4번째 카드가 제대로 된
  // 비행 애니메이션(flyCard) 대신 그냥 자리만 슬쩍 옮기는 ambient reposition 취급을 받아
  // 180ms 만에 너무 일찍 도착해버렸고(손패 3장은 520ms), (2) 폭탄으로 들어온 카드 4장
  // 전부(손패 3장 포함) 도착해도 캡처 확인 반짝임(capture-flash)이 아예 안 떴다.
  const captureKinds = ['jjok', 'ttadak', 'ppeok_resolved', 'sweep', 'capture', 'bonus_deck', 'bonus_hand', 'bomb'];
  let deckTapped = false;
  if (DEBUG_ANIM) {
    logAnim('[anim] evt', JSON.stringify(evt), 'oldRects.size', oldRects.size);
  }
  // 이번 렌더에서 이미 "뻑 형성" 반짝임을 준 floor-group을 기억해, 같은 무더기의 카드
  // 두 장(손패로 낸 카드 + 덱에서 뒤집은 카드)이 각각 도착할 때마다 중복으로 반짝이지 않게 한다.
  const formedGroups = new Set();
  // 이번 렌더에서 새로 날아오는 카드들의 Animation 객체를 모아둔다. 예전에는
  // handleGameEvent(효과음+배너+흔들기)가 renderGame 안에서 카드보다 훨씬 먼저(서버
  // 상태가 갱신된 그 즉시) 재생됐는데, 실제 카드는 이 함수가 requestAnimationFrame
  // 한 틱 뒤에야 날아가기 시작해 340~520ms를 더 들여 도착한다. 그래서 소리/배너가
  // 카드보다 늘 먼저 터져 "때리는 느낌"이 아니라 "따로 노는 느낌"이 났다. 이 배열에
  // 모은 Animation들이 전부 끝나는 시점(=카드가 실제로 다 착지한 시점)에 맞춰
  // handleGameEvent를 재생하도록, 아래에서 Promise.all(...).then(...)으로 넘긴다.
  const primaryAnims = [];

  // 이번 턴에 "새로" 캡처되어 들어온 카드인지(=바닥에서 방금 빠져나왔거나, 이번 턴의
  // 행위자 카드 자신)를 구분한다. 예전엔 이 구분이 없어서 그냥 ".cap-cards 안에 있는지"만
  // 봤는데, 그러면 훨씬 전 턴에 이미 먹은패로 들어가 있던 카드까지("이번 턴과 전혀 무관하게
  // 원래 거기 있던 카드") 이번 턴에 캡처된 것처럼 오판해버렸다. 그 결과 캡처가 있는 턴마다
  // (매우 흔함) 두 사람의 먹은패 더미 전체가 - 반대편 플레이어의 손패 수가 바뀌어 그
  // opponent-card 박스 너비가 살짝 변하기만 해도 몇 px씩 밀리는데 - 매번 무거운 비행
  // 애니메이션(히트스톱+충격+캡처 반짝임)으로 재생되고 있었다("카드들이 계속 따로
  // 움직이고 렉이 걸린다"던 증상의 핵심 원인).
  function capturedThisTurn(id) {
    return isPrimaryMover(id) || Boolean(oldFloorIds && oldFloorIds.has(id));
  }

  // 이번 렌더에 다른 사람 더미로 넘어간 먹은패(=쪽/뻑/싹쓸이/폭탄/보너스패로 받아온 피).
  // DOM 순서대로 번호를 매겨 두고, 여러 장이면 한 장씩 차례로 날아오게 한다.
  const transferOrder = new Map();
  if (oldOwners) {
    document.querySelectorAll('.cap-groups[data-owner] .card[data-id]').forEach((elm) => {
      const prev = oldOwners.get(elm.dataset.id);
      if (prev && prev !== elm.closest('.cap-groups').dataset.owner) {
        transferOrder.set(elm.dataset.id, transferOrder.size);
      }
    });
  }

  function maybeFlashCapture(elm) {
    const id = elm.dataset.id;
    const transferred = transferOrder.has(id);
    // 받아온 피는 뻑 형성처럼 "캡처"가 아닌 사건에서도 생기므로 사건 종류와 무관하게 반짝인다.
    if (!transferred && !captureKinds.includes(evt.kind)) return false;
    if (!elm.closest('.cap-cards')) return false;
    if (!transferred && !capturedThisTurn(id)) return false;
    restartAnimClass(elm, 'capture-flash');
    return true;
  }

  // 캡처된 카드가 도착하는 순간, 카드 한 장의 반짝임만으로는 "먹었다"는 무게감이 부족해서
  // 그 카드를 받아들이는 종류별 묶음(cap-group) 그릇 자체도 살짝 튀어오르게 한다.
  //
  // 따닥/뻑 해소/폭탄처럼 한 턴에 4장이 한꺼번에 캡처되면, 그 4장은 보통 광/열끗/띠/피
  // 서로 다른 종류에 나뉘어 들어가서 각자 다른 cap-group이 따로따로 튀어오른다 - 타이밍은
  // 정확히 같아도(실측으로 확인 완료) 화면 여러 곳에서 작은 통통 튐이 각자 따로 일어나니
  // "이 4장이 한 덩어리로 정리됐다"는 느낌 대신 "그냥 여러 개가 우연히 동시에 일어났다"는
  // 느낌이 났다. 이번 렌더에서 같은 먹은패 묶음(cap-groups) 안에 서로 다른 cap-group이
  // 2개 이상 튀어오르면, 그 묶음 전체에도 한 번 더 크고 뚜렷한(multi-punch) 튐+금빛 광을
  // 얹어서 "여러 장이지만 하나의 사건으로 함께 정리됐다"는 걸 분명히 보여준다.
  const punchedGroupsByWrap = new Map();
  function groupPunch(elm) {
    const group = elm.closest('.cap-group');
    if (!group) return;
    restartAnimClass(group, 'group-punch');
    const wrap = group.closest('.cap-groups');
    if (!wrap) return;
    let groups = punchedGroupsByWrap.get(wrap);
    if (!groups) { groups = new Set(); punchedGroupsByWrap.set(wrap, groups); }
    groups.add(group);
    if (groups.size >= 2) restartAnimClass(wrap, 'multi-punch');
  }

  // 뻑이 "형성"되는 순간(카드를 먹지 못하고 바닥에 3장이 묶이는 순간)은 캡처가 아니라서
  // maybeFlashCapture의 대상이 아니지만, 그렇다고 아무 신호도 없으면 방금 일어난 일이
  // 쪽/뻑해소처럼 "먹은" 건지 그냥 평범하게 바닥에 놓인 건지 구분이 안 간다.
  // gostop_rules.md 5장의 그 특별한 순간을, 캡처(금색)와는 다른 색(호박색)으로 표시해서
  // "이 3장이 방금 뻑으로 묶였다"는 걸 바로 알아보게 한다. 이번 턴에 새로 도착한 카드
  // (handCardId/flippedCardId)가 속한 .floor-group을 찾아, 그 무더기 전체(이미 있던
  // 3번째 카드까지 포함해 3장 모두)를 한 번에 반짝인다.
  function maybeFlashFormed(elm) {
    if (evt.kind !== 'ppeok_formed') return;
    if (evt.handCardId !== elm.dataset.id && evt.flippedCardId !== elm.dataset.id) return;
    const group = elm.closest('.floor-group');
    if (!group || formedGroups.has(group)) return;
    formedGroups.add(group);
    group.querySelectorAll('.card').forEach((c) => {
      restartAnimClass(c, 'formed-flash');
    });
  }

  // 카드 한 장을 dx,dy(출발 지점 - 도착 지점) 거리만큼 날아오는 것처럼 재생한다.
  // 예전에는 "인라인 transform으로 순간이동 -> 강제 리플로우 -> transition 활성화"라는
  // CSS transition 트릭 하나로 시작점과 도착점, 딱 두 지점만 오갔는데, 그러다 보니
  // (1) 덱에서 뒤집히는 카드가 회전과 이동이 한꺼번에 재생돼 "뒤집는 느낌"과 "날아가는
  // 느낌"이 뭉개져 보이고, (2) 손에서 내는 카드도 그냥 밋밋하게 직선으로 미끄러져 들어와
  // 손맛이 없다는 문제가 있었다. Web Animations API(element.animate)로 바꿔서 중간 지점을
  // 하나 더 둔 3단 키프레임을 쓰면: 덱 카드는 "제자리에서 먼저 다 뒤집힌 뒤에 활공해 오는"
  // 2단 동작을, 손 카드는 살짝 위로 튕겼다가 내려앉는 포물선을, 각각 선명하게 보여줄 수 있다.
  // delay(ms)는 폭탄처럼 손패 3장이 한꺼번에 나가는 경우, 실제로 손으로 세 장을 연달아
  // "탁탁탁" 내려치는 것처럼 조금씩 시차를 두고 착지시키기 위한 것이다(delay가 있을 때는
  // fill:'both'로 대기 구간에도 시작 transform을 유지시켜, 지연 중 카드가 잠깐 순간이동한
  // 것처럼 보이는 깜빡임을 막는다).
  // 이번 렌더의 이벤트(evt)가 지목하는 "실제로 행동을 일으킨 카드"인지 확인한다 - 방금 낸
  // 손패 카드, 방금 뒤집힌/뽑힌 덱 카드, 폭탄으로 나간 손패 3장. 이 카드만 무거운 타격
  // 연출(찌그러짐/충격링/소리)을 받는다 - 캡처되어 딸려가는 상대 카드나 레이아웃이 밀려
  // 몇 px 이동한 무관한 카드까지 다 반응하면 카드 여러 장이 겹칠 때 버벅였다(12장 참고).
  function isPrimaryMover(id) {
    return id === evt.handCardId || id === evt.flippedCardId || id === evt.drawnCardId
      || (Array.isArray(evt.handCardIds) && evt.handCardIds.includes(id))
      || (Array.isArray(evt.bonusDeckIds) && evt.bonusDeckIds.includes(id));
  }
  // 캡처되어 먹은패 더미(.cap-cards)로 들어가는 카드인지만 순수하게 확인한다(클래스는
  // 안 건드림) - primaryMover는 아니지만(내가 낸 카드도, 덱에서 뒤집힌 카드도 아닌) 그
  // 매치 결과로 딸려서 캡처되는 상대 카드를 가려내는 데 쓴다. 이런 카드는 ③페이즈(손패
  // +덱 페이즈가 모두 끝난 뒤)에 출발시켜야 "맞춰서 가져간다"는 순서가 제대로 보인다.
  function willCapture(elm) {
    return captureKinds.includes(evt.kind) && !!elm.closest('.cap-cards')
      && capturedThisTurn(elm.dataset.id);
  }

  // 이 카드에 새 애니메이션을 걸기 직전에, 혹시 이 "같은 엘리먼트"에 걸려 있던 이전
  // 애니메이션이 있으면 취소한다(finish가 아니라 cancel - 그래야 그 이전 애니메이션의
  // onfinish가 뒤늦게 불려서 이미 다른 일을 하고 있는 이 카드에 엉뚱한 타이밍에 충격
  // 이펙트/효과음이 발동하는 걸 막을 수 있다). 예전엔 렌더할 때마다 페이지의 모든
  // 애니메이션을 통째로 강제 종료시켰는데, 그러면 "이번 턴과 전혀 무관한, 아직 진행 중인
  // 이전 턴의 카드"까지 전부 최종 위치로 순간이동해버려서 - 특히 한 턴의 캡처 시퀀스가
  // 다 끝나기도 전에 다음 상태가 도착하는 흔한 경우(캡처 있는 턴은 1초 넘게 걸림), "맞은
  // 카드끼리 같이 움직이는" 장면 자체가 매번 잘려나가 한 번도 안 보이는 원인이 됐다. 이제는
  // 지금 막 새 애니메이션을 받으려는 그 카드 자신에 대해서만, 꼭 필요한 만큼만 정리한다.
  function cancelPriorAnim(elm) {
    elm.getAnimations().forEach((a) => { try { a.cancel(); } catch (e) { /* 이미 끝났으면 무시 */ } });
    // flyTransfer가 비행 중에만 바꿔두는 기준점 - 중간에 취소되면 onfinish가 안 불려 남는다.
    elm.style.transformOrigin = '';
    // cancel()은 onfinish를 안 불러주므로, 이전 애니메이션이 suspendClip으로 들고 있던
    // 카운터를 그 onfinish 안의 restoreClip이 영영 못 돌려준다 - 여기서 대신 돌려준다.
    if (elm.dataset.clipHeld === '1') restoreClip(elm, elm.closest('.cap-groups'));
    // 이 카드에 남아있을 수 있는 이전 세대(generation)의 예약(효과음/충격 이펙트 setTimeout,
    // z-index 갱신 등)이 뒤늦게 실행되지 않도록 세대 번호를 하나 올려서 돌려준다 - 호출부는
    // 이 번호를 자신의 지연 콜백들에 넣어뒀다가, 실행 시점에 "아직 내 세대가 맞는지" 확인한다.
    const gen = (Number(elm.dataset.flightGen) || 0) + 1;
    elm.dataset.flightGen = String(gen);
    return gen;
  }

  // 캡처되는 카드는 renderGame()이 이미 최종 위치(.cap-cards, 즉 .cap-groups 안)에
  // 넣어둔 채로 FLIP 기법이 먼 곳(바닥/손패)에서 날아오는 것처럼 거꾸로 transform을
  // 건다. 그런데 .cap-groups는 먹은패가 많아지면 가로로 스크롤되게 하려고
  // overflow-x:auto/overflow-y:hidden으로 잘려 있어서(style.css), 카드가 그 좁은 줄
  // 바깥에 있는 동안(=비행의 대부분 구간)은 그냥 클리핑되어 안 보이다가 착지 직전에야
  // 불쑥 나타난다 - "카드가 사라졌다가 나중에 다시 나타난다"는 증상의 진짜 정체가 이거였다
  // (여태까지 고친 건 전부 "언제/어떤 값으로 날아가는지"였지, "그 비행 자체가 보이는지"는
  // 아니었다). 카드가 그 컨테이너 안에서 날아다니는 동안만 일시적으로 클리핑을 풀어준다 -
  // 한 턴에 여러 장이 동시에 같은 더미로 날아들 수 있어(뻑/따닥/싹쓸이) 카운터로 관리하고,
  // 마지막 한 장까지 다 도착해야 원래대로(가로 스크롤 가능하게) 되돌린다.
  function suspendClip(elm) {
    const container = elm.closest('.cap-groups');
    if (!container) return null;
    const count = Number(container.dataset.flightCount || 0) + 1;
    container.dataset.flightCount = String(count);
    container.style.overflow = 'visible';
    // 이 카드가 아직 restoreClip을 못 받은 채로(=카운터를 하나 들고 있는 채로) 있다는
    // 표시. cancelPriorAnim이 이 카드를 다른 애니메이션으로 넘겨받을 때(cancel은 onfinish를
    // 안 불러주므로) 이 표시를 보고 대신 restoreClip을 불러줘야 카운터가 영원히 안 풀리는
    // 채로 남는 걸(=먹은패 줄이 다시는 가로 스크롤 안 되는 걸) 막을 수 있다.
    elm.dataset.clipHeld = '1';
    return container;
  }
  function restoreClip(elm, container) {
    if (!container) return;
    delete elm.dataset.clipHeld;
    const count = Number(container.dataset.flightCount || 1) - 1;
    if (count <= 0) {
      delete container.dataset.flightCount;
      container.style.overflow = '';
    } else {
      container.dataset.flightCount = String(count);
    }
  }

  // 두 값 사이를 t만큼 선형보간한다(t=0이면 a, t=1이면 b, t=1보다 크면 b를 지나쳐 오버슈트).
  function mix(a, b, t) { return a + (b - a) * t; }

  // 카드가 날아가는 한 구간(leg)의 길이. flyCard/페이즈 타이밍 계산이
  // 전부 이 값을 정확히 공유해야 하는데(하나라도 어긋나면 keyframe 경계가 안 맞아 버벅이는
  // 것처럼 보인다). "카드가 너무 빨리 날아가고 쫀득함이 없다"는 피드백을 받아 다시
  // 올렸다(620/450 -> 700/520) - 대기 시간(HOLD/PHASE_GAP)과 이동 속도는 다른 축이라,
  // 대기 시간은 그대로 두고 이동 자체만 더 느긋하게 만든다. 오버슈트/정착 바운스
  // (buildApproachKeyframes, flyCard/flyCardViaMeeting)와 함께 봐야 "쫀득함"이 완성된다.
  function approachDurFor(style) { return style === 'deck' ? 700 : 520; }

  // 마지막(가장 늦은) 페이즈의 카드가 부딪힌 뒤에도, 전역 스윕이 시작되기까지 아주 잠깐
  // 더 멈춰 있는 여유(격투 게임의 히트스톱과 비슷한 "타격의 무게감"을 위한 짧은 정지).
  // 카드가 날아가는 속도 자체(approachDurFor)와는 다른 축이라, "느긋한 모션"은 그대로 두고
  // 이 순수 대기 시간만 줄여서 전체 시퀀스 길이를 단축한다 - 짧을수록 다음 턴이 그 전에
  // 도착해 시퀀스를 끊어버릴 여지도 줄어든다(빠르게 연달아 턴이 진행될 때 특히).
  const HOLD = 110;

  // style별 "던지기/뒤집기" 모양의 keyframe들을 만든다. endDx/endDy는 이 모양이 도착하는
  // 지점(기본 0,0=진짜 최종 위치, 캡처면 "바닥에서 맞춰지는 지점")이고, offsetScale은 이
  // 모양 전체가 차지할 시간 구간의 길이를 전체 애니메이션 대비 비율로 준다(예: 0.4면
  // 전체의 40% 동안 이 모양이 재생됨). 반환값은 { keyframes, easing }.
  function buildApproachKeyframes(style, dx, dy, endDx = 0, endDy = 0, offsetScale = 1) {
    const s = offsetScale;
    if (style === 'deck') {
      return {
        easing: 'cubic-bezier(.18,.85,.3,1)',
        keyframes: [
          { offset: 0, transform: `translate(${dx}px, ${dy}px) scale(0.55) rotateY(180deg)` },
          { offset: s * 0.4, transform: `translate(${mix(dx, endDx, 0.12)}px, ${mix(dy, endDy, 0.12) - 16}px) scale(0.86) rotateY(0deg)` },
          { offset: s * 0.48, transform: `translate(${mix(dx, endDx, 0.12)}px, ${mix(dy, endDy, 0.12) - 16}px) scale(0.86) rotateY(0deg)` },
          { offset: s * 0.8, transform: `translate(${mix(dx, endDx, 1.06)}px, ${mix(dy, endDy, 1.06)}px) scale(1.12) rotateY(0deg)` },
          { offset: s, transform: `translate(${endDx}px, ${endDy}px) scale(1) rotateY(0deg)` },
        ],
      };
    }
    if (style === 'hand') {
      const rot = dx > 0 ? -22 : 22;
      return {
        easing: 'cubic-bezier(.22,.85,.3,1)',
        keyframes: [
          { offset: 0, transform: `translate(${mix(dx, endDx, 0.1)}px, ${mix(dy, endDy, 0.1) + 8}px) scale(0.5) rotate(${rot * 0.5}deg)` },
          { offset: s * 0.12, transform: `translate(${dx}px, ${dy}px) scale(0.46) rotate(${rot}deg)` },
          { offset: s * 0.58, transform: `translate(${mix(dx, endDx, 0.6)}px, ${mix(dy, endDy, 0.6) - 50}px) scale(0.88) rotate(${rot * 0.3}deg)` },
          { offset: s * 0.78, transform: `translate(${mix(dx, endDx, 1.05)}px, ${mix(dy, endDy, 1.05)}px) scale(1.11) rotate(${rot * -0.05}deg)` },
          { offset: s, transform: `translate(${endDx}px, ${endDy}px) scale(1) rotate(0deg)` },
        ],
      };
    }
    return {
      easing: 'cubic-bezier(.2,.85,.3,1)',
      keyframes: [
        { offset: 0, transform: `translate(${dx}px, ${dy}px) scale(0.94) rotate(-4deg)` },
        { offset: s * 0.5, transform: `translate(${mix(dx, endDx, 0.5)}px, ${mix(dy, endDy, 0.5) - 18}px) scale(0.98) rotate(-2deg)` },
        { offset: s * 0.78, transform: `translate(${mix(dx, endDx, 1.05)}px, ${mix(dy, endDy, 1.05)}px) scale(1.09) rotate(2deg)` },
        { offset: s, transform: `translate(${endDx}px, ${endDy}px) scale(1) rotate(0deg)` },
      ],
    };
  }

  // 출발 지점과 도착 지점의 카드 크기가 다를 때(바닥의 보통 카드가 상대방의 작은 먹은패 더미로
  // 들어가는 경우 등) 그 크기 변화를 keyframe에 녹인다. FLIP은 위치만 되짚고 크기는 도착 지점
  // 크기(미니) 그대로라서, 예전엔 상대가 캡처하는 순간 바닥 카드가 제자리에서 뚝 작아진 채로
  // 날아가고, 상대가 낸 손패도 처음부터 작은 크기로 바닥 짝을 때렸다. kAt(offset)은 그
  // 시점의 크기 배율(도착 크기 대비)이고, w/h는 도착 크기다. scale은 카드 중심 기준이라
  // 커진 만큼 translate를 반씩 보정해야 왼쪽 위 모서리가 원래 계산한 자리에 맞는다.
  function resizeKeyframes(keyframes, kAt, w, h) {
    if (!w || !h) return keyframes;
    return keyframes.map((f) => {
      const k = kAt(f.offset);
      if (!f.transform || Math.abs(k - 1) < 0.02) return f;
      let t = f.transform.replace(/translate\(([-\d.e]+)px, ([-\d.e]+)px\)/, (m, x, y) =>
        `translate(${Number(x) + ((k - 1) * w) / 2}px, ${Number(y) + ((k - 1) * h) / 2}px)`);
      t = /scale\(/.test(t) ? t.replace(/scale\(([-\d.e]+)\)/, (m, s) => `scale(${Number(s) * k})`) : `${t} scale(${k})`;
      return { ...f, transform: t };
    });
  }
  const lerp = (a, b) => (o) => a + (b - a) * o;

  // buildApproachKeyframes가 만든 "접근"(막 손/덱에서 튀어나오는 되감기 자세 포함) 뒤에,
  // 착지 직전 정지 구간(히트스톱)과 살짝 눌렸다 튕기는 정착 한 번을 덧붙인다. 손/덱에서
  // 처음 나와 곧장 최종 위치로 가는 "차가운(cold)" 비행(그냥 내기 등)에 쓴다.
  function buildFlightKeyframes(style, dx, dy) {
    const { keyframes: baseFrames, easing } = buildApproachKeyframes(style, dx, dy);
    const overshoot = baseFrames[baseFrames.length - 2];
    const finalFrame = baseFrames[baseFrames.length - 1];
    const holdOffset = Math.min(overshoot.offset + 0.1, 0.97);
    const settleOffset = Math.min(holdOffset + 0.02, 0.99);
    const keyframes = [
      ...baseFrames.slice(0, -1),
      { offset: holdOffset, transform: overshoot.transform },
      { offset: settleOffset, transform: 'translate(0px, 0px) scale(0.95) rotate(0deg)' },
      finalFrame,
    ];
    return { keyframes, easing };
  }

  // buildFlightKeyframes와 같은 착지 연출(히트스톱+정착)이지만, "막 손/덱에서 튀어나오는"
  // 되감기 자세(scale(0.94)/rotate(-4deg) 시작)가 없다 - 이미 짝과 부딪혀서 한 번 멈췄다가
  // 그 자리(scale 1/rotate 0)에서 그대로 이어서 먹은패로 쓸려 들어가는 마지막 구간(스윕)
  // 전용이다. flyCardViaMeeting의 스윕 단계와, 경유지 없이 이 스윕과 정확히 같은 시각에
  // 함께 쓸려 들어가는 바닥 짝(flyCard의 sweepStyle) 둘 다 이 모양을 쓴다 - 그래야 "부딪힌
  // 뒤 가만히 있다가 함께 쓸려간다"는 이어지는 한 동작으로, 서로 정확히 같은 곡선으로
  // 움직인다. 예전엔 flyCardViaMeeting의 스윕이 "접근+대기+스윕"을 하나로 이어붙인 단일
  // easing 곡선의 일부였는데, 그러면 같은 시각에 독자적으로(새 애니메이션으로) 시작하는
  // 바닥 짝의 flyCard(그 카드는 buildFlightKeyframes를 써서 되감기 자세부터 시작)와는
  // 겉보기 타이밍은 같아도 그 순간의 속도 곡선(가속도)이 서로 달랐다 - "도착은 같은데
  // 출발이 다르게 느껴진다"는 게 바로 이 증상이었다.
  function buildSweepKeyframes(dx, dy) {
    return {
      easing: 'cubic-bezier(.2,.85,.3,1)',
      keyframes: [
        { offset: 0, transform: `translate(${dx}px, ${dy}px) scale(1) rotate(0deg)` },
        { offset: 0.5, transform: `translate(${mix(dx, 0, 0.5)}px, ${mix(dy, 0, 0.5) - 18}px) scale(0.98) rotate(-2deg)` },
        { offset: 0.78, transform: `translate(${mix(dx, 0, 1.05)}px, ${mix(dy, 0, 1.05)}px) scale(1.09) rotate(2deg)` },
        { offset: 0.88, transform: `translate(${mix(dx, 0, 1.05)}px, ${mix(dy, 0, 1.05)}px) scale(1.09) rotate(2deg)` },
        { offset: 0.9, transform: 'translate(0px, 0px) scale(0.95) rotate(0deg)' },
        { offset: 1, transform: 'translate(0px, 0px) scale(1) rotate(0deg)' },
      ],
    };
  }

  // 손패에서 낸/덱에서 뒤집은/이미 바닥에 있던 카드가 자기 최종 위치(먹은패 더미 또는
  // 바닥에 그대로)까지 날아가는 한 번의 여행을 재생한다. 착지 직전(약 80~92% 구간)에는
  // 일부러 같은 transform 값을 두 keyframe에 반복해서 "정지 구간(히트스톱)"을 만든다 -
  // 격투 게임에서 타격의 무게감을 표현할 때 쓰는 기법과 같다. JS 타이머로 실제
  // 애니메이션을 pause()/play()하던 예전 방식은 여러 카드가 겹칠 때 그 자체로 버벅임의
  // 원인이 됐는데, keyframe 값 자체를 정지시키면 브라우저가 평소 이동과 완전히 동일한
  // 방식(추가 JS 개입 없이)으로 처리해서 훨씬 매끄럽다. 모든 스타일을 같은 총 시간(DUR)
  // 으로 맞춰서 "덱은 빠르고 손은 느리고..." 식으로 제각각 다르게 느껴지던 것도 없앴다.
  function flyCard(elm, dx, dy, style, delay = 0, primaryMover = false, sweepStyle = false, size = null) {
    elm.classList.remove('pop');
    elm.style.transform = '';
    const myGen = cancelPriorAnim(elm);
    // 화면에서 다른 날아다니는 카드와 겹칠 때 어느 게 위에 보일지는, 그 카드가 "실제로
    // 움직이기 시작하는 순간"에만 z-index를 올려 받는 식으로 정한다(delay가 지난 뒤). delay
    // 값 자체로 미리 z-index를 매겨두면, 아직은 원래 자리에 가만히 대기 중일 뿐인(대기 시간이
    // 긴) 카드가, 그 사이 실제로 날아가고 있는 다른 카드보다 값이 높아 그 위를 덮어버리는
    // 역전이 생긴다(예: 손패 카드와 함께 캡처되는 바닥 카드는 대기 시간이 제일 길어서 아직
    // 가만히 있을 뿐인데, 그 사이 진짜로 날아가는 덱 카드보다 위에 그려져버림 - "덱 카드가
    // 방금 낸 카드 아래로 깔린다"는 증상의 정체가 이거였다). 지금 막 움직이기 시작한 카드만
    // 공용 카운터에서 번호를 하나 받아가게 하면, 실제 시간 순서대로 항상 최근에 움직인
    // 카드가 위에 보인다. (세대 번호를 확인해서, 이 카드가 그 사이 다른 애니메이션으로
    // 넘어갔으면 이 지연 콜백은 조용히 건너뛴다.)
    const bumpZIndex = () => {
      if (elm.dataset.flightGen !== String(myGen)) return;
      elm.style.zIndex = String(nextFlightZIndex++);
    };
    if (delay > 0) setTimeout(bumpZIndex, delay); else bumpZIndex();
    const clipContainer = suspendClip(elm);
    // 애니메이션이 "시작되고 나서" GPU 레이어로 승격되면 그 승격 자체가 첫 프레임 즈음에
    // 한 번 끊기는 원인이 될 수 있다(잘 알려진 브라우저 렌더링 특성). will-change를
    // 애니메이션 시작 "직전"에 걸어두면 브라우저가 미리 레이어를 준비해둬서 이 끊김을
    // 피할 수 있다 - 끝나면 바로 지운다(계속 걸어두면 오히려 메모리를 불필요하게 잡아먹음).
    elm.style.willChange = 'transform';
    // .card 기본 스타일에 hover/선택 카드를 부드럽게 들어올리기 위한
    // `transition: transform 0.12s`가 걸려 있다. WAAPI 애니메이션과 CSS 트랜지션은
    // 스펙상 서로 안 부딪히게 되어 있지만(애니메이션이 끝나 값이 되돌아가는 순간이
    // 트랜지션을 다시 발동시키지 않음), 혹시 모를 상호작용 여지 자체를 없애기 위해
    // 날아다니는 동안은 이 트랜지션을 아예 꺼둔다 - 끝나면 원래대로 복원한다.
    elm.style.transition = 'none';
    const DUR = approachDurFor(style);
    // sweepStyle: 경유지 없이도 이미 부딪혀 짝이 된 채로 캡처되어 함께 쓸려가는 바닥 짝
    // (animateNewCards의 isSweptCapture) - flyCardViaMeeting의 스윕 구간과 정확히 같은
    // 모양(되감기 자세 없음)으로 재생해서 "함께 쓸려 들어간다"는 게 보이게 한다.
    const built = sweepStyle ? buildSweepKeyframes(dx, dy) : buildFlightKeyframes(style, dx, dy);
    const { easing } = built;
    const keyframes = size ? resizeKeyframes(built.keyframes, lerp(size.fromK, 1), size.w, size.h) : built.keyframes;

    const anim = elm.animate(keyframes, { duration: DUR, easing, delay, fill: delay > 0 ? 'both' : 'none' });

    // 이 카드가 "이번 턴의 실제 행위자"(방금 낸/뒤집은/뽑은/폭탄 카드)일 때만 무거운 타격
    // 연출(찌그러짐/충격링/밝기 플래시/타격음)을 준다. 캡처되어 먹은패로 들어가는 상대편
    // 카드(willCapture)는 그 카드를 낸 사람이 아니므로 별도의 "쾅"이 아니라, 더 가벼운
    // capture-flash 반짝임 + groupPunch 정도로만 반응한다. 그 외(레이아웃이 밀려서 몇 px
    // 이동한 무관한 카드들)는 아무 반응도 없이 조용히 미끄러지기만 한다.
    const shouldPunch = primaryMover;

    anim.onfinish = () => {
      elm.style.zIndex = '';
      elm.style.willChange = '';
      elm.style.transition = '';
      restoreClip(elm, clipContainer);
      // 이 elm이 다른 렌더에서 이미 재사용/철거됐으면(예: DOM에서 빠진 detached 상태) 어떤
      // 후처리 효과도 재생하지 않고 조용히 넘어간다 - detached 엘리먼트의
      // getBoundingClientRect()는 전부 0인 사각형을 주므로, 그대로 진행하면 화면 왼쪽 위
      // 구석에 뜬금없는 충격 링이 반짝이는("이펙트 에러") 유령 효과가 생긴다.
      if (!elm.isConnected) return;
      const flashed = maybeFlashCapture(elm);
      if (shouldPunch) {
        slamCard(elm);
        spawnImpactRing(elm);
        hitFlash(elm);
        cardSlap();
      }
      if (flashed) groupPunch(elm);
      maybeFlashFormed(elm);
    };
    return anim;
  }

  // 캡처 전용: 손패에서 낸/덱에서 뒤집은 카드가 곧바로 내 먹은패로 가지 않고, ①공용
  // 필드의 짝이 있던 자리까지 날아가 거기서 부딪히고(타격 연출), ②waitMs만큼 머물다가,
  // ③내 먹은패까지 마저 슬라이드해 들어간다. waitMs는 "손패를 낸다 -> 덱을 뒤집는다 ->
  // 그제서야 맞춰진 카드들이 전부 한꺼번에 쓸려 들어간다"는 순서를 지키기 위해 다른
  // 페이즈의 캡처가 마저 끝날 때까지 기다리는 시간이다(자기 자신의 부딪힘 이후 남는 시간,
  // 호출부의 globalSweepStart 계산 참고).
  //
  // ①+②(접근+대기)와 ③(스윕)은 예전엔 keyframe offset 계산으로 이어붙인 "하나의"
  // 애니메이션이었다. 문제는 이러면 스윕 구간이 "접근부터 시작하는 단일 easing 곡선"의
  // 일부가 되어버려서, 정확히 같은 시각에 독자적으로 새 애니메이션을 시작하는 바닥 짝
  // (경유지 없이 flyCard의 sweepStyle로 캡처되는 카드)과는 도착 시각은 똑같아도 그 구간
  // 동안의 속도 곡선(가속도)이 서로 달라서 "출발이 서로 다르게 느껴진다"는 문제가 있었다.
  // 그래서 ③ 스윕을 별도의(그러나 정확히 이어지는) 두 번째 elm.animate() 호출로 분리해서,
  // flyCard의 sweepStyle과 완전히 동일한 buildSweepKeyframes 곡선을 그대로 재사용한다 -
  // 이러면 바닥 짝과 정확히 같은 시각에 정확히 같은 모양으로 움직인다. 두 애니메이션이
  // 같은 transform 속성을 동시에 건드리는 구간이 생기면 나중에 만든 쪽이 이겨서 먼저
  // 것을 완전히 덮어버리므로(그러면 접근 애니메이션이 안 보이는 버그가 생긴다), ①+②는
  // fill:'backwards'(자기 시작 전만 유지, 끝난 뒤엔 놓음)로, ③은 fill:'forwards'(자기
  // 시작 전엔 아무 효과 없음, 끝난 뒤엔 유지)로 서로 겹치는 구간이 전혀 없게 나눴다.
  function flyCardViaMeeting(elm, dx, dy, style, delay, viaDx, viaDy, waitMs, size = null) {
    elm.classList.remove('pop');
    elm.style.transform = '';
    const myGen = cancelPriorAnim(elm); // flyCard와 동일한 이유(이전 애니메이션이 남긴 예약된 콜백 무효화)
    // flyCard와 동일한 이유(실제로 움직이기 시작하는 순간에만 z-index를 올려 받음, 세대 확인)
    const bumpZIndex = () => {
      if (elm.dataset.flightGen !== String(myGen)) return;
      elm.style.zIndex = String(nextFlightZIndex++);
    };
    if (delay > 0) setTimeout(bumpZIndex, delay); else bumpZIndex();
    elm.style.willChange = 'transform'; // flyCard와 동일한 이유(레이어 승격을 미리 끝내둠)
    elm.style.transition = 'none'; // flyCard와 동일한 이유(기본 .card 트랜지션과의 상호작용 여지 제거)
    const clipContainer = suspendClip(elm); // flyCard와 동일한 이유(.cap-groups의 overflow 클리핑 해제)

    const approachDur = approachDurFor(style);
    const sweepDur = approachDurFor('move'); // 맞춰지는 지점 -> 내 먹은패, 'move' 스타일 재사용
    const phase1Dur = approachDur + waitMs;
    const sweepStart = delay + phase1Dur;

    // ①+②: 접근(도착 지점이 최종 위치가 아니라 맞춰지는 지점(viaDx,viaDy)이 되도록
    // endDx/endDy를 넘긴다) 후, 남은 시간(waitMs) 동안은 같은 값을 유지해 가만히 대기한다
    // (마지막 keyframe이 이미 viaDx,viaDy이므로 별도 keyframe 없이 duration만 늘리면
    // WAAPI가 알아서 그 값을 끝까지 유지한다).
    const approach = buildApproachKeyframes(style, dx, dy, viaDx, viaDy, 1);
    const approachFrames = size
      ? resizeKeyframes(approach.keyframes, lerp(size.fromK, size.viaK), size.w, size.h)
      : approach.keyframes;
    const anim1 = elm.animate(approachFrames, {
      duration: phase1Dur, easing: approach.easing, delay,
      fill: delay > 0 ? 'backwards' : 'none',
    });

    // 맞춰지는 지점 도착 타격(찌그러짐/충격링/플래시/소리) - 실제 keyframe 진행 시각과
    // 정확히 같은 시점(delay + approachDur)에 맞춰 재생한다. 이 setTimeout은 애니메이션
    // 객체와 무관한 별도의 JS 타이머라서, 그 사이 이 카드가 cancelPriorAnim으로 다른
    // 애니메이션에 넘어갔어도(=세대 번호가 바뀌었어도) 이 타이머 자체는 그대로 실행되려
    // 한다 - 세대 번호를 확인해서 넘어간 경우엔 조용히 건너뛴다. 이미 화면에서 빠진
    // (detached) 카드도 마찬가지로 건너뛴다 - 안 그러면 화면 구석에 유령 충격 링이 튀는
    // 것처럼 보인다.
    setTimeout(() => {
      if (elm.dataset.flightGen !== String(myGen) || !elm.isConnected) return;
      slamCard(elm);
      spawnImpactRing(elm);
      hitFlash(elm);
      cardSlap();
    }, delay + approachDur);

    // ③ 스윕: flyCard의 sweepStyle과 완전히 같은 모양(buildSweepKeyframes)을 맞춰지는
    // 지점(viaDx,viaDy) -> 최종 위치(0,0)로 재생한다. anim1이 끝나는 바로 그
    // 순간(sweepStart)에 시작하도록
    // WAAPI 자체 delay로 미리 예약해둔다(정확한 타이밍을 위해 setTimeout으로 나중에
    // 새로 만들지 않고, 지금 한꺼번에 예약함 - 브라우저 컴포지터가 직접 타이밍을 맞춰서
    // JS 타이머 지연/오차가 끼어들 여지가 없다). fill:'forwards'라 anim1이 활성인 동안은
    // 전혀 개입하지 않다가, 정확히 sweepStart부터 넘겨받는다.
    const sweepBuilt = buildSweepKeyframes(viaDx, viaDy);
    const sweepEasing = sweepBuilt.easing;
    const sweepKeyframes = size
      ? resizeKeyframes(sweepBuilt.keyframes, lerp(size.viaK, 1), size.w, size.h)
      : sweepBuilt.keyframes;
    const anim2 = elm.animate(sweepKeyframes, {
      duration: sweepDur, easing: sweepEasing, delay: sweepStart, fill: 'forwards',
    });

    anim2.onfinish = () => {
      elm.style.zIndex = '';
      elm.style.willChange = '';
      elm.style.transition = '';
      restoreClip(elm, clipContainer);
      if (!elm.isConnected) return;
      const flashed = maybeFlashCapture(elm);
      if (flashed) groupPunch(elm);
      maybeFlashFormed(elm);
    };
    return anim2;
  }

  // 상대 더미에서 내 더미로 받아오는 피(또는 내가 넘겨주는 피) 한 장의 비행. 상대 더미는
  // 작은(mini) 카드라 크기가 다르므로, 출발할 때는 원래 크기로 보이도록 scale로 맞춰
  // 시작해서(기준점을 왼쪽 위로 둬야 FLIP 좌표와 모서리가 정확히 겹친다) 포물선을 그리며
  // 새 크기로 커지며 내려앉는다.
  function flyTransfer(elm, old, now, delay) {
    elm.classList.remove('pop');
    const myGen = cancelPriorAnim(elm);
    const bumpZIndex = () => {
      if (elm.dataset.flightGen !== String(myGen)) return;
      elm.style.zIndex = String(nextFlightZIndex++);
    };
    if (delay > 0) setTimeout(bumpZIndex, delay); else bumpZIndex();
    const clipContainer = suspendClip(elm);
    elm.style.willChange = 'transform';
    elm.style.transition = 'none';
    elm.style.transformOrigin = 'top left';
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    const s = old.width && now.width ? old.width / now.width : 1;
    const anim = elm.animate([
      { offset: 0, transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(0deg)` },
      { offset: 0.5, transform: `translate(${mix(dx, 0, 0.5)}px, ${mix(dy, 0, 0.5) - 36}px) scale(${mix(s, 1, 0.6)}) rotate(-6deg)` },
      { offset: 0.82, transform: 'translate(0px, 0px) scale(1.1) rotate(2deg)' },
      { offset: 0.92, transform: 'translate(0px, 0px) scale(0.96) rotate(0deg)' },
      { offset: 1, transform: 'translate(0px, 0px) scale(1) rotate(0deg)' },
    ], { duration: 600, easing: 'cubic-bezier(.2,.85,.3,1)', delay, fill: delay > 0 ? 'both' : 'none' });
    anim.onfinish = () => {
      elm.style.zIndex = '';
      elm.style.willChange = '';
      elm.style.transition = '';
      elm.style.transformOrigin = '';
      restoreClip(elm, clipContainer);
      if (!elm.isConnected) return;
      if (maybeFlashCapture(elm)) groupPunch(elm);
    };
    return anim;
  }

  // 이번 턴의 카드들이 전부 내려앉는 시점에 풀리는 Promise를 돌려준다(고/스톱·결과 창을 그
  // 뒤에 띄우는 데 쓴다 - showDeferredModals 참고).
  return new Promise((resolveTurnDone) => requestAnimationFrame(() => {
    // 한 턴 안에서도 실제로는 "손패를 낸다 -> (짝이 맞으면 탁) -> 덱을 뒤집는다 ->
    // (짝이 맞으면 또 탁) -> 그제서야 먹은 패들이 내 앞으로 쓸려 들어온다"처럼 순서가 있는
    // 사건인데, 예전에는 이 모든 카드가 한 렌더 안에서 전부 동시에 날아가고 있었다(그래서
    // "누가 무엇과 맞았는지"가 한눈에 안 들어오고, 무거운 효과가 동시에 겹쳐 버벅이기도
    // 했다). 아래에서 역할별로 시작 시각을 어긋나게 둬서 실제 턴 진행 순서 그대로 보이게
    // 한다: ①손패 낸 카드(또는 폭탄 3장) -> ②덱에서 뒤집은 카드, 순서로 페이즈를 나눈다.
    const PHASE1_DUR = approachDurFor('move'); // ①손패 페이즈(내가 낸 카드/상대가 낸 카드/폭탄)의 기준 길이
    // 페이즈 사이 호흡 - 손패를 낸 순간과 덱을 뒤집는 순간 사이가 너무 짧아서 부자연스럽다는
    // 피드백을 받아 늘렸다(120 -> 320). 이 값은 순수하게 "손패가 다 부딪힌 뒤 덱 페이즈가
    // 시작하기까지"의 호흡이라, 늘려도 각 카드 자체가 날아가는 속도(approachDurFor)나
    // 부딪힌 뒤 스윕 시작까지의 대기(HOLD)에는 영향이 없다.
    const PHASE_GAP = 320;
    const hasHandPhase = Boolean(evt.handCardId)
      || (Array.isArray(evt.handCardIds) && evt.handCardIds.length > 0);
    const hasDeckPhase = Boolean(evt.flippedCardId || evt.drawnCardId);
    // 폭탄은 손패 3장이 70ms씩 시차를 두고 착지하므로, ①페이즈가 그만큼 더 길어진다.
    const handPhaseDur = PHASE1_DUR
      + (Array.isArray(evt.handCardIds) ? (evt.handCardIds.length - 1) * 70 : 0);
    const deckPhaseStart = hasHandPhase ? handPhaseDur + PHASE_GAP : 0;
    // 덱을 뒤집었더니 보너스패가 나오면 실제로는 "뒤집음 -> 보너스패라 바로 내 앞으로 가져옴 ->
    // 한 장 더 뒤집음" 순서다. 예전엔 서버가 그 보너스패가 어떤 카드인지 안 알려줘서 먹은패에
    // 날아가는 동작 없이 불쑥 나타났다. 이제는 보너스패가 한 장씩 덱에서 뒤집혀 먹은패로 먼저
    // 날아가고, 진짜로 짝을 맞추는 덱 카드는 그만큼 뒤에(BONUS_FLIP_STEP씩) 뒤집힌다.
    const bonusDeckIds = Array.isArray(evt.bonusDeckIds) ? evt.bonusDeckIds : [];
    const BONUS_FLIP_STEP = 550;
    const realDeckStart = deckPhaseStart + bonusDeckIds.length * BONUS_FLIP_STEP;

    // 카드 id는 "3-gwang"처럼 월(月)로 시작한다(보너스패만 예외) - 캡처되는 바닥 카드가
    // 손패로 낸 카드와 짝인지, 덱에서 뒤집힌 카드와 짝인지는 서버가 따로 안 알려주지만,
    // 월만 같으면 짝이었다는 뜻이므로 id 앞자리로 충분히 구분할 수 있다.
    function cardMonth(cid) {
      if (!cid || cid.startsWith('bonus')) return null;
      const n = parseInt(cid.split('-')[0], 10);
      return Number.isNaN(n) ? null : n;
    }
    const handCardMonth = cardMonth(evt.handCardId);
    const flippedCardMonth = cardMonth(evt.flippedCardId);
    // 폭탄(bomb)은 손패 카드가 evt.handCardId(단수)가 아니라 evt.handCardIds(배열)라서
    // handCardMonth로는 못 잡는다 - 폭탄 3장은 항상 같은 월이므로 그 중 아무 거나(첫 장)로
    // 월을 구한다.
    const bombMonth = Array.isArray(evt.handCardIds) && evt.handCardIds.length > 0
      ? cardMonth(evt.handCardIds[0]) : null;
    // 손패로 낸 카드/덱에서 뒤집은 카드가 각각 "바닥의 어느 카드와 맞춰졌는지" - 이번
    // 렌더에 먹은패로 들어간 카드 중 직전 렌더까지 바닥에 있던 카드(=진짜 짝 후보)를 월별로
    // 모아둔다. id는 월로 시작하니 월만 보면 "예전 턴에 이미 먹어서 먹은패에 쭉 있던 같은 월
    // 카드"까지 잡히므로, 직전 바닥에 있었는지(oldFloorIds)를 꼭 같이 본다.
    const partnersByMonth = new Map();
    if (captureKinds.includes(evt.kind)) {
      document.querySelectorAll('.card[data-id]').forEach((partnerElm) => {
        const pid = partnerElm.dataset.id;
        if (isPrimaryMover(pid) || !partnerElm.closest('.cap-cards')) return;
        if (!oldFloorIds || !oldFloorIds.has(pid)) return;
        const m = cardMonth(pid);
        if (m == null) return;
        const rect = oldRects.get(pid);
        if (!rect) return;
        if (!partnersByMonth.has(m)) partnersByMonth.set(m, []);
        partnersByMonth.get(m).push({ pid, rect });
      });
    }
    // 같은 월 후보 중 이 카드가 실제로 때린 짝을 고른다.
    // - 서버가 알려준 선택(chosenFloorId)이 이 카드의 선택이면(chosenFor) 그 카드. 월만 같은
    //   두 후보 중 고르지 않은 쪽으로 날아가던 예전 증상("왼쪽에서 날아온다") 방지.
    // - 따닥(바닥 같은 월 2장 + 손패 + 덱)은 손패가 고른 짝(A)과 덱이 맞춘 짝(B)이 서로
    //   다른 카드다 - 예전엔 둘 다 같은 한 장(A)으로 날아가서 덱 카드가 엉뚱한 자리를
    //   때렸다. 이미 다른 카드가 차지한 짝(excludeId)은 건너뛴다.
    // - 뻑 해소처럼 짝이 3장 묶음이면 그 무더기 맨 끝(가장 오른쪽) 카드 위에 얹는다.
    function pickPartner(month, chosenIsMine, excludeId) {
      if (month == null) return null;
      const list = (partnersByMonth.get(month) || []).filter((p) => p.pid !== excludeId);
      if (!list.length) return null;
      if (chosenIsMine && evt.chosenFloorId) {
        const chosen = list.find((p) => p.pid === evt.chosenFloorId);
        if (chosen) return chosen;
      }
      if (list.length >= 3) return list.reduce((a, b) => (b.rect.left > a.rect.left ? b : a));
      return list[0];
    }
    const handPartner = pickPartner(handCardMonth, evt.chosenFor === 'hand', null);
    const deckPartner = pickPartner(flippedCardMonth, evt.chosenFor === 'deck', handPartner && handPartner.pid);
    const bombPartner = pickPartner(bombMonth, false, null);

    // 짝을 "때리는" 카드는 짝과 완전히 같은 자리가 아니라 살짝 비껴서(실제로 카드를 짝 위에
    // 겹쳐 내려놓듯) 내려앉는다 - 정확히 같은 자리에 포개면 짝이 통째로 가려져서 "방금 무엇과
    // 맞았는지"가 안 보이고, 짝이 사라지고 내 카드만 남은 것처럼 보였다.
    const HIT_DX = 26;
    const HIT_DY = -12;
    function offsetRect(rect, ox, oy) {
      return rect ? { left: rect.left + ox, top: rect.top + oy } : null;
    }

    // "쪽": 손패가 짝 없이 바닥에 내려앉고, 이어서 뒤집은 덱 카드가 바로 그 손패를 맞춰
    // 둘 다 가져가는 경우. 실제로는 손패가 먼저 바닥 빈자리에 "탁" 놓이고, 덱 카드가 그 위를
    // 때린 뒤 둘이 같이 쓸려가야 한다. 그런데 서버 상태는 손패가 바닥을 거친 적 없이 곧장
    // 먹은패로 들어가 있어서, 예전엔 손패가 **손에 1초 가까이 그대로 붙어 있다가** 바닥을
    // 한 번도 안 들르고 먹은패로 곧장 날아갔다("카드를 낸 순간 엔티티 취급을 못 받는다"는
    // 증상). 손패가 내려앉을 바닥 빈자리(마지막 줄 끝 - 가운데 정렬이라 양 옆이 비어 있다)를
    // 계산해서, 손패는 거기로, 덱 카드는 그 손패 위로 날아가게 한다.
    // (handCaptures 조건이 꼭 필요하다 - 뻑 형성(손패+덱이 같은 월이지만 캡처가 아님)까지
    // 이걸로 오인하면, 예전처럼 손패가 손에서 한참 늦게 출발하는 문제가 뻑에서도 생긴다.)
    function floorFreeSpot() {
      const floorEl = el('floor');
      const fr = floorEl ? floorEl.getBoundingClientRect() : null;
      const rects = [];
      if (oldFloorIds) oldFloorIds.forEach((pid) => { const r = oldRects.get(pid); if (r) rects.push(r); });
      if (!rects.length) return fr ? { left: fr.left + fr.width / 2 - 39, top: fr.top + 16 } : null;
      const w = rects[0].width || 78;
      const lastTop = Math.max(...rects.map((r) => r.top));
      const row = rects.filter((r) => Math.abs(r.top - lastTop) < 20);
      const right = Math.max(...row.map((r) => r.left + (r.width || w)));
      if (!fr || right + 12 + w <= fr.right - 8) return { left: right + 12, top: lastTop };
      const left = Math.min(...row.map((r) => r.left));
      return { left: left - 12 - w, top: lastTop };
    }
    // 손패/덱 카드 각각이 "실제로 이번 턴에 캡처됐는지"를, handViaRect/deckViaRect(바닥
    // 경유지를 찾았는지) 같은 간접적인 신호 대신 있는 그대로 확인한다 - willCapture가
    // "이 카드의 새 위치가 먹은패 더미 안인지"를 직접 보므로, 따닥(손패/덱 둘 다 같은 월이라
    // 경유지 찾기 로직이 한쪽만 잡아버림)이나 보너스패(월 정보가 아예 없어 경유지 로직
    // 자체가 적용 안 됨) 같은 경우에도 항상 정확하다 - 앞으로 새로운 캡처 종류가 추가돼도
    // 이 판정만은 깨지지 않는다.
    // 폭탄(bomb)은 손패 카드가 evt.handCardId(단수)가 아니라 evt.handCardIds(배열)에
    // 들어있다 - 그래서 이 단수 id만 보던 handCardElm 찾기는 폭탄일 때 항상 못 찾은
    // 것으로 나와, 폭탄으로 캡처되는 바닥 4번째 카드까지 "손패가 캡처 안 했다"고 잘못
    // 판단해버렸다(globalSweepStart가 폭탄의 실제 도착 시각을 반영 못 함). 폭탄은 항상
    // 4장 전부를 캡처하므로 그냥 true로 둔다.
    const isBomb = Array.isArray(evt.handCardIds) && evt.handCardIds.length > 0;
    const handCardElm = evt.handCardId && document.querySelector(`.card[data-id="${evt.handCardId}"]`);
    const deckCardId = evt.flippedCardId || evt.drawnCardId;
    const deckCardElm = deckCardId && document.querySelector(`.card[data-id="${deckCardId}"]`);
    const handCaptures = isBomb || Boolean(handCardElm && willCapture(handCardElm));
    const deckCaptures = Boolean(deckCardElm && willCapture(deckCardElm));
    const isJjok = hasHandPhase && hasDeckPhase && handCaptures && !handPartner
      && handCardMonth != null && handCardMonth === flippedCardMonth;
    const jjokSpot = isJjok ? floorFreeSpot() : null;
    // "손패를 낸다(짝이 있으면 탁) -> 덱을 뒤집는다(짝이 있으면 또 탁) -> 그제서야 이번
    // 턴에 맞춰진 카드들이 전부 한꺼번에 내 먹은패로 쓸려 들어간다"는 순서를 지키기 위해,
    // 실제로 캡처가 걸린 페이즈들 중 가장 늦게 "탁" 하는 시점(+HOLD)을 전역 스윕 시작
    // 시각으로 삼는다 - 손패만 캡처했으면 손패가 부딪힌 직후에, 손패+덱이 둘 다
    // 캡처했으면 덱까지 부딪힌 뒤에야 다같이 스윕을 시작한다. handPhaseDur를 쓰는 이유는
    // 폭탄이면 손패 페이즈 자체가 3장 시차(70ms씩)만큼 더 길어지기 때문이다(PHASE1_DUR만
    // 쓰면 마지막 폭탄 카드가 아직 도착도 안 했는데 스윕이 시작되는 어긋남이 생긴다).
    const handHitTime = handPhaseDur;
    // 덱 카드가 이미 화면에 있던 경우(바닥 2장 중 고르는 동안 바닥에 펼쳐져 있던 카드를,
    // 선택 후 고른 짝 위로 옮기는 마무리 단계)는 덱에서 새로 뒤집혀 나오는 게 아니라 바닥에서
    // 한 번 더 옮기는 것이라 비행 시간도 그 스타일('move')을 따른다.
    const deckStyleForHit = deckCardId && oldRects.has(deckCardId) ? 'move' : 'deck';
    const deckHitTime = realDeckStart + approachDurFor(deckStyleForHit);
    const globalSweepStart = HOLD + Math.max(
      handCaptures ? handHitTime : 0,
      deckCaptures ? deckHitTime : 0,
    );
    // 캡처되어 먹은패로 딸려가는(=primaryMover는 아니지만 willCapture인) 카드는 손패 짝이든
    // 덱 짝이든 상관없이 전부 이 전역 스윕 시작 시각(globalSweepStart)에 맞춰 동시에
    // 출발한다 - 몇 장이든(2장이든 4장이든) 같은 순간에 함께 움직여서 "맞춰서 가져간다"는
    // 느낌을 준다.
    // 바닥에 남아있는(캡처되지 않는) 다른 카드가 이번 턴에 자리가 밀렸다면, 캡처된 카드가
    // "부딪히는"(그래서 화면에 충격 이펙트가 뜨고 "이 카드는 빠진다"는 신호를 주는) 첫
    // 순간까지만 기다렸다가 그 빈자리를 채운다 - globalSweepStart(다른 페이즈까지 다 끝난
    // 뒤, 훨씬 나중일 수 있음)까지 기다리게 하면, 정작 이 카드와 무관한 다른 페이즈 때문에
    // 화면에 아무 설명 없이 한참(경우에 따라 1초 넘게) 얼어있다가 막판에 갑자기 튀어
    // 들어오는 것처럼 보인다("피가 왼쪽에서 날아온다"는 증상의 정체가 이거였다) - 손패든
    // 덱이든 먼저 부딪힌 쪽에서 이미 "이 자리가 빈다"는 신호가 충분히 나온 뒤이므로,
    // 그 시점에 채워도 자연스럽다(손패가 캡처했으면 손패 쪽 신호를, 손패는 그냥 내고
    // 덱만 캡처했으면 덱 쪽 신호를 기준으로 삼는다).
    // 피를 받아오는 건 실제로도 "먹을 걸 다 먹은 뒤" 상대들이 한 장씩 건네주는 것이므로, 이번
    // 턴의 카드들이 전부 자리에 내려앉은 뒤에(캡처가 있으면 먹은패로 쓸려 들어간 뒤, 뻑 형성처럼
    // 캡처가 없으면 마지막 카드가 바닥에 놓인 뒤) 시작한다. 보너스패를 손에서 낸 경우는 규칙상
    // 피를 먼저 받고 나서 덱에서 한 장을 뽑으므로 덱에서 뽑는 카드는 기다리지 않는다.
    const stealStart = 150 + Math.max(
      (handCaptures || deckCaptures) ? globalSweepStart + approachDurFor('move') : 0,
      hasHandPhase ? handPhaseDur : 0,
      (hasDeckPhase && !evt.drawnCardId) ? deckHitTime : 0,
    );
    const firstHitTime = handCaptures ? handHitTime : (deckCaptures ? deckHitTime : 0);
    const lastDepartureStart = (handCaptures || deckCaptures) ? (HOLD + firstHitTime) : 0;

    // 보통 크기 카드 한 장의 실제 크기(바닥/내 손패 카드) - 미니 카드 크기 보정의 기준.
    const fullCardElm = document.querySelector('.floor .card, #my-hand .card, #my-captured .card');
    const fullRect = fullCardElm ? fullCardElm.getBoundingClientRect() : null;
    const FULL_W = (fullRect && fullRect.width) || 78;

    document.querySelectorAll('.card[data-id]').forEach((elm) => {
      const id = elm.dataset.id;
      const now = elm.getBoundingClientRect();
      const old = oldRects.get(id);
      let dx = 0, dy = 0, style = 'move';
      const primary = isPrimaryMover(id);
      const capturing = primary || willCapture(elm);
      // 폭탄(bomb) 카드는 손패에 있다가 나가는 것이라 old(이전 위치)가 항상 존재해서 아래
      // if(old)/else 분기 중 반드시 if(old) 쪽을 타는데, 예전엔 bombIndex가 else 분기
      // 안에서만(원래 위치를 못 찾은 새 카드 취급하는 경로에서만) 계산돼 실제 폭탄 플레이에서는
      // 한 번도 계산되지 않고 항상 -1로 남아 있었다("탁탁탁" 시차 효과가 실전에서 전혀 발동하지
      // 않던 원인). old/new 여부와 무관하게 handCardIds 배열 안 순서만 보면 되므로 여기서
      // 미리 한 번만 계산한다.
      const bombIndex = Array.isArray(evt.handCardIds) ? evt.handCardIds.indexOf(id) : -1;

      if (old) {
        dx = old.left - now.left;
        dy = old.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
          if (DEBUG_ANIM) logAnim('[anim]', id, 'unchanged, skip');
          maybeFlashCapture(elm); maybeFlashFormed(elm); return;
        }
        if (transferOrder.has(id)) {
          const delay = stealStart + transferOrder.get(id) * 110;
          if (DEBUG_ANIM) logAnim('[anim]', id, 'transfer (피 받기)', { dx, dy, delay });
          flyTransfer(elm, old, now, delay);
          return;
        }
        // 이번 턴의 실제 행위자도 아니고 캡처되는 것도 아닌데 자리만 바뀐 카드 - .floor는
        // justify-content:center로 가운데 정렬돼 있고 .hand-row도 마찬가지라, 카드 한 장이
        // 추가되거나 빠지기만 해도 그 줄의 총 너비가 바뀌어 전혀 상관없는 다른 카드들까지
        // (실측으로 확인: 한 턴에 최대 십수 장) 몇 px~수백 px씩 밀린다. 예전엔 이런 카드도
        // 전부 flyCard(찌그러짐/충격링/히트스톱까지 포함한 무거운 6~9 keyframe 애니메이션)를
        // 걸고 있어서 그 자체로 버벅임의 큰 원인이었지만, 반대로 **아예 애니메이션을 안 만들면**
        // transform이 한 번도 안 걸린 채라 CSS 전환도 못 타서 카드가 슥 밀리는 대신 새
        // 자리로 뚝 끊겨 순간이동해버린다("사라졌다 딴 데서 나타난다"로 보였던 원인이 이거다).
        // 그래서 무거운 효과 없이 아주 짧고 가벼운(2-keyframe) 슬라이드만 살짝 얹어서,
        // 성능 비용은 거의 그대로 두고 순간이동처럼 보이던 것만 없앤다.
        if (!capturing) {
          // 이 카드는 바닥에 그대로 남아있는데, 같은 월의 다른 카드가 이번에 캡처되어
          // 빠져나가는 바람에(justify-content:center) 자리가 밀린 경우일 수 있다. 캡처되는
          // 카드는 자기 짝과 부딪혀 스윕을 시작하는 시점(handSweepStart/deckSweepStart)까지는
          // 실제로 안 움직이고 원래 자리에 가만히 "머물러 있는 척"만 하는데(flyCard의
          // delay+fill:'both'), 이 남은 카드가 지연 없이 즉시 180ms 만에 새 자리로
          // 미끄러져버리면 아직 안 떠난 캡처 카드의 자리를 먼저 밀고 들어와 버려 두 카드가
          // 겹쳐 보인다. 그래서 바닥에서 뭔가 실제로 빠져나가기 시작하는 가장 늦은 시점
          // (lastDepartureStart)까지 이 미끄러짐도 같이 기다린다.
          const isFloorCard = Boolean(elm.closest('.floor'));
          const ambientDelay = isFloorCard ? lastDepartureStart : 0;
          if (DEBUG_ANIM) logAnim('[anim]', id, 'ambient reposition', { dx, dy, ambientDelay });
          elm.classList.remove('pop');
          // 이 엘리먼트에 이전 렌더에서 걸어둔 애니메이션(예: 캡처 비행)이 아직 안 끝났으면
          // 취소한다 - flyCard/flyCardViaMeeting과 같은 이유(그 이전 애니메이션의 onfinish가
          // 뒤늦게 불려서 지금은 그냥 자리만 옮기는 이 카드에 엉뚱하게 충격 이펙트가 발동하는
          // 걸 막는다).
          cancelPriorAnim(elm);
          elm.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }],
            { duration: 180, easing: 'ease-out', delay: ambientDelay, fill: ambientDelay > 0 ? 'both' : 'none' },
          );
          return;
        }
      } else {
        let origin = null;
        if (evt.flippedCardId === id) {
          origin = deckRect; style = 'deck'; deckTapped = true;
        } else if (evt.drawnCardId === id || bonusDeckIds.includes(id)) {
          origin = deckRect; style = 'deck'; deckTapped = true;
        } else if (evt.handCardId === id) {
          origin = oldHandRowRects.get(evt.playerId) || deckRect; style = 'hand';
        } else if (Array.isArray(evt.handCardIds) && evt.handCardIds.includes(id)) {
          // 폭탄(bomb): 손패 3장이 한 번에 나가는 유일한 행동이라 단수 필드(handCardId)로는
          // 표현이 안 돼 handCardIds 배열을 쓴다. 배열 안에서의 순서대로 조금씩 시차를 둬서
          // (아래 flyCard 호출의 delay) 세 장이 동시에 뭉개지듯 나타나지 않고, 실제로 손에서
          // 연달아 "탁탁탁" 내려치는 것처럼 보이게 한다.
          origin = oldHandRowRects.get(evt.playerId) || deckRect; style = 'hand';
        }
        if (!origin) {
          if (DEBUG_ANIM) logAnim('[anim]', id, 'NO OLD RECT + NO ORIGIN -> instant, no animation');
          return; // 출처를 특정할 수 없으면(새 판 초기 배분 등) pop 효과만 남긴다
        }
        dx = origin.left - now.left;
        dy = origin.top - now.top;
        if (DEBUG_ANIM) logAnim('[anim]', id, 'no old rect, origin=', style, { dx, dy });
      }

      // 역할에 따라 어느 페이즈에서 출발할지 정한다: 손패/폭탄 카드는 ①페이즈(즉시,
      // 폭탄이면 카드마다 70ms씩 추가로 어긋남), 덱에서 뒤집힌 카드는 ②페이즈, 캡처되어
      // 먹은패로 쓸려 들어가는(=primaryMover는 아니지만 willCapture인) 카드는 전역 스윕
      // 시각(globalSweepStart)에 맞춰 출발한다. 그 외(레이아웃이 밀려 몇 px 이동한 무관한
      // 카드)는 그냥 즉시 조용히 미끄러진다.
      // 캡처되어 먹은패로 딸려가는(=primaryMover는 아니지만 willCapture인) 바닥 짝은,
      // 경유지가 없어 그냥 flyCard로 곧장 최종 위치까지 가더라도 "막 손에서 던져진" 것이
      // 아니라 "이미 부딪혀서 짝이 된 카드를 그제서야 함께 쓸어담는" 동작이다 - 그래서
      // flyCard에 이 사실을 알려 되감기 자세(wind-up) 없이 바로 이어지는 모양으로
      // 재생하게 한다(sweepStyle, 아래 flyCard 참고) - 정확히 같은 시각에 독자적으로 같은
      // 모양을 타는 flyCardViaMeeting의 스윕 구간과 이 카드가 똑같이 움직이게 하기 위함.
      const isSweptCapture = !primary && willCapture(elm);
      let delay;
      if (style === 'deck') {
        delay = bonusDeckIds.includes(id)
          ? deckPhaseStart + bonusDeckIds.indexOf(id) * BONUS_FLIP_STEP
          : realDeckStart;
      }
      else if (bombIndex > 0) delay = bombIndex * 70;
      else if (isSweptCapture) delay = globalSweepStart;
      else delay = 0;

      // 손패로 낸 카드/덱에서 뒤집은 카드가 실제로 캡처된다면(=바닥에 짝이 있었다면),
      // 곧바로 내 먹은패로 직행하지 않는다: 먼저 "공용 필드"의 그 짝이 있던 자리까지
      // 날아가 거기서 탁 소리와 함께 부딪히고, 다른 페이즈의 캡처까지 전부 끝날 때까지
      // 잠깐 머물다가, 그제서야 이번 턴에 맞춰진 카드들과 다 함께 내 먹은패로 마저 쓸려
      // 들어간다(flyCardViaMeeting, 단일 애니메이션). 짝이 없는 그냥 내기(place)는
      // 원래대로 한 번에 곧장 최종 위치까지 간다(flyCard).
      // 폭탄 3장은 각자 자기 차례(bombIndex*70 시차)에 손에서 나와, 다른 주자와 마찬가지로
      // 바닥의 그 짝(bombViaRect)이 있던 자리까지 먼저 가서 "탁" 부딪힌 뒤 대기하다가,
      // globalSweepStart에 맞춰 바닥 짝과 다 같이 먹은패로 쓸려 들어간다 - 예전엔 이 경로가
      // 아예 없어서(bombIndex는 늘 -1로 계산되던 버그 때문에 이 분기 자체가 죽어있었다) 폭탄
      // 카드 3장이 바닥 짝을 기다리지도 않고 각자 도착 즉시(약 520~660ms) 먹은패로 곧장
      // 가버렸고, 그 뒤 한참(최대 630ms 이상) 지나서야 바닥 짝 혼자 뒤늦게 날아 들어오는
      // 것처럼 보였다("따로따로 움직이고 뒤늦게 날아온다"는 증상이 폭탄에서도 똑같이 났다).
      // 어느 카드가 손패/덱 카드인지는 스타일('deck' 등)이 아니라 id로 판정한다 - 바닥 2장 중
      // 고르는 동안 이미 바닥에 펼쳐져 있던 덱 카드는 이전 위치가 있어 스타일이 'move'라서,
      // 스타일로 보면 덱 카드인 줄 몰라 고른 짝을 들르지 않고 먹은패로 혼자 먼저 가버렸다.
      let viaRect = null;
      if (bombIndex >= 0) {
        viaRect = bombPartner ? offsetRect(bombPartner.rect, 16 * (bombIndex + 1), -8 * (bombIndex + 1)) : null;
      } else if (primary && id === evt.handCardId) {
        viaRect = isJjok ? jjokSpot : (handPartner ? offsetRect(handPartner.rect, HIT_DX, HIT_DY) : null);
      } else if (primary && id === deckCardId) {
        viaRect = isJjok ? offsetRect(jjokSpot, HIT_DX, HIT_DY)
          : (deckPartner ? offsetRect(deckPartner.rect, HIT_DX, HIT_DY) : null);
      }

      // 이 카드가 작은(미니) 카드로 도착하면(상대방 먹은패 더미) 출발/경유 지점에서는 보통
      // 크기로 보이도록 크기 변화를 넘긴다 - 출발은 원래 크기(이전 위치에서의 실제 크기, 없으면
      // 보통 카드), 바닥 짝을 때리는 순간도 보통 크기, 더미에 들어가며 작아진다.
      let size = null;
      if (now.width > 0 && now.width < FULL_W * 0.9) {
        size = {
          fromK: (old && old.width ? old.width : FULL_W) / now.width,
          viaK: FULL_W / now.width,
          w: now.width,
          h: now.height,
        };
      }

      let anim;
      if (viaRect) {
        const viaDx = viaRect.left - now.left;
        const viaDy = viaRect.top - now.top;
        // 이 카드 자신은 이미 부딪혔어도(delay+approachDur 시점), 다른 페이즈(예: 손패는
        // 부딪혔지만 덱은 아직 안 뒤집힌 경우)가 마저 끝날 때까지는 먹은패로 안 쓸려가고
        // 부딪힌 자리에서 대기한다 - waitMs가 그 대기 시간이다.
        const waitMs = Math.max(0, globalSweepStart - (delay + approachDurFor(style)));
        if (DEBUG_ANIM) logAnim('[anim]', id, 'flyCardViaMeeting', { style, delay, dx, dy, viaDx, viaDy, waitMs });
        anim = flyCardViaMeeting(elm, dx, dy, style, delay, viaDx, viaDy, waitMs, size);
      } else {
        if (DEBUG_ANIM) logAnim('[anim]', id, 'flyCard', { style, delay, dx, dy, primary });
        anim = flyCard(elm, dx, dy, style, delay, primary, isSweptCapture, size);
      }
      if (primary || willCapture(elm)) primaryAnims.push(anim);
    });

    // 덱에서 뒤집은 카드가 바닥의 2장과 매치되는 드문 경우(NEED_CHOICE2), 선택이 끝나기 전에
    // 미리 보내는 'deck_reveal' 중계 이벤트는 그 카드가 아직 floor/captured 어디에도 실제로
    // 렌더링되지 않은 상태다(선택 대기 중이라 pendingChoice2 안에 떠 있을 뿐). 그래서 위 루프의
    // deckTapped는 매치할 카드 엘리먼트를 못 찾아 계속 false로 남는데, 그렇다고 더미 들썩임
    // 애니메이션까지 안 나가면 "구경하는 사람도 바로 보게 한다"는 이 이벤트의 존재 의의가
    // 사라진다. 그래서 카드 엘리먼트를 못 찾았어도 evt 자체에 flippedCardId/drawnCardId가
    // 있으면(=덱에서 뭔가 뒤집힌 게 맞으면) 더미 들썩임만큼은 항상 재생한다.
    const deckEventPending = Boolean(evt.flippedCardId || evt.drawnCardId);
    if ((deckTapped || deckEventPending) && deckStack) {
      // 더미 들썩임도 실제 덱 카드가 날아가기 시작하는 ②페이즈 시점에 맞춰 지연시킨다 -
      // 안 그러면 손패 페이즈가 아직 진행 중인데 더미가 먼저 들썩여서 순서가 어긋나 보인다.
      // 보너스패가 나와서 여러 번 뒤집는 턴이면 뒤집을 때마다 한 번씩 들썩인다.
      for (let i = 0; i <= bonusDeckIds.length; i++) {
        setTimeout(() => {
          deckStack.classList.remove('flipping');
          // eslint-disable-next-line no-unused-expressions
          deckStack.offsetWidth;
          deckStack.classList.add('flipping');
        }, deckPhaseStart + i * BONUS_FLIP_STEP);
      }
    }

    // 배너/효과음/보드 흔들기는 카드가 실제로 다 착지한 뒤에 재생한다(위 primaryAnims 주석
    // 참고). 이번 렌더에 날아온 카드가 하나도 없는 이벤트(고/스톱 선언처럼 새로 이동하는
    // 카드가 없는 경우)는 primaryAnims가 비어 있으므로 Promise.all([])이 바로 다음
    // 마이크로태스크에서 풀려 사실상 즉시 재생된다.
    const turnDone = Promise.all(primaryAnims.map((a) => a.finished.catch(() => {})));
    if (isNewGameEvent && evt.kind) turnDone.then(() => handleGameEvent(evt));
    resolveTurnDone(turnDone);
  }));
}

// ---------- 사운드 ----------
// 실제로 녹음/제작된 효과음 파일(public/assets/audio/*.mp3, CC0 - "uisfx" 패키지)과
// 저음을 더해주는 합성음을 함께 재생해서 카드가 "탁!" 떨어지는 타격감을 낸다.

// 효과음 전체 켜기/끄기. 게임 판단(서버 상태)과는 무관한, 순전히 이 브라우저에서의
// 개인 설정이라 localStorage에 저장해도 안전하다(다음에 열어도 그대로 유지됨).
let soundMuted = false;
try { soundMuted = localStorage.getItem('gostop_muted') === '1'; } catch (e) { /* 무시 */ }

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
  if (soundMuted) return;
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
  if (soundMuted) return;
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

// 카드가 손에서 바닥/더미로 "탁!" 떨어지는 느낌: 실제 카드를 테이블에 내려놓는 걸 그대로
// 녹음한 샘플(card-slap-real.mp3, Freesound.org "card.wav" by Zaxtor99, CC0) + 저음
// 합성음 하나만 겹친다. 예전엔 UI 클릭음 팩(card-snap.mp3)에 화이트노이즈 크랙까지 층층이
// 합성해서 흉내내봤지만, "전자음이 지저분하게 섞인 소리"라는 피드백을 받았다 - 애초에
// 범용 UI 클릭 효과음이었던 걸 합성으로 아무리 다듬어도 "카드가 테이블에 놓이는 소리"
// 자체가 될 수는 없었다. 실제로 카드를 내려놓아서 녹음한 샘플 하나를 그대로 쓰는 편이
// 훨씬 정직하고 "카드답게" 들린다. 이제 이 함수가 실제로 낸/뒤집은/뽑은/폭탄 카드에만
// (flyCard의 primaryMover) 불리므로, 캡처로 딸려가는 카드까지 겹쳐 울릴 걱정 없이 한
// 턴에 한두 번만 또렷하게 재생된다.
// 사운드가 서로 겹쳐서 "여러 사건이 동시에 일어난다"는 느낌을 주는 문제 - 턴은 서버가
// 받는 대로 바로바로 진행되고(애니메이션이 다 끝나길 기다려주지 않음), 상대가 조금만
// 빨리 두면 이전 턴의 타격음/확인음이 채 끝나기도 전에 다음 턴의 소리가 그 위에 겹쳐
// 울렸다. 정확한 mp3 길이까지는 몰라도, 각 "사운드 묶음"(카드 착지음 한 번, 또는
// 이벤트 확인음 한 세트)이 대략 얼마나 걸리는지 넉넉히 추정해두고, 그 추정 시각까지는
// 다음 묶음이 시작하지 않도록 전역으로 순서를 매긴다. 묶음 "안"에서 의도적으로 살짝
// 겹쳐 쌓는 효과(예: capture의 체크음+챠임 콤보)는 그대로 유지된다 - 이 게이트는 묶음
// 전체를 한 번에 뒤로 미룰 뿐, 묶음 내부의 상대적 타이밍은 안 건드리기 때문이다.
let audioBusyUntil = 0; // performance.now() 기준, 지금까지 예약된 사운드가 다 끝나는 시각
const SOUND_GAP_MS = 90; // 사운드가 끝난 뒤 다음 사건까지 살짝 두는 틈

// 사운드 묶음 하나를 재생하기 직전에 불러서, "지금 당장 재생해도 되는지 아니면 몇 ms
// 더 기다려야 하는지"를 초 단위로 돌려주고, 그만큼 오디오 점유 구간을 늘려 예약해둔다.
function reserveAudioSlot(estimatedDurationMs) {
  const now = performance.now();
  const extraDelayMs = Math.max(0, audioBusyUntil - now);
  audioBusyUntil = now + extraDelayMs + estimatedDurationMs + SOUND_GAP_MS;
  return extraDelayMs / 1000;
}

function cardSlap(delay = 0) {
  const gate = reserveAudioSlot(Math.max(sfxDurationOf('card-slap-real.mp3'), 120));
  playSfx('card-slap-real.mp3', { volume: 1, rate: 0.95, delay: delay + gate });
  beep(90, 0.12, { type: 'sine', gain: 0.24, delay: delay + gate });
}

// 카드 착지 타격음(cardSlap)은 flyCard의 anim.onfinish에서 이번 턴의 실제 행위자 카드에만
// 직접, 실제로 착지하는 정확한 타이밍에 재생된다(animateNewCards 참고). 그래서 여기 SOUND
// 맵에서 이벤트마다 따로 cardSlap()을 또 부르면 같은 "탁" 소리가 중복으로 겹쳐 울린다.
// 아래 항목들은 그 착지음 위에 "이 사건이 정확히 무엇인지"를 구분해주는 효과음만 남긴다.
// 예외 두 가지: shake(흔들기)는 새로 날아오는 카드가 없는 행동이라 착지음 자체가 아예
// 안 나므로 수동으로 3연타를 흉내내고, bomb(폭탄)은 손패 3장이 handCardIds로 시차를
// 두고 착지하면서 이미 자연스럽게 "탁.. 탁.. 탁"이 울리므로 저음 강조만 더한다.
// reserveAudioSlot에 넘길 "이번 사운드 묶음이 몇 ms 동안 자리를 차지하는지"를 손으로
// 어림잡아 적었더니 (예: capture 650ms로 잡음) 실제 파일 길이를 재보니 여러 항목이
// 그보다 더 길었다(capture의 실제 체감 길이는 delay 0.15s + match-success.mp3 실측
// 493ms = 643ms로 거의 맞았지만, jjok/ttadak/win/bonus는 최대 80ms 가까이 더 길어서
// 그 차이만큼 다음 사건이 아직 안 끝난 소리 위에 계속 겹쳐 울리고 있었다). 그래서
// 각 파일을 로드하자마자 실제 재생 길이(loadedmetadata의 duration)를 재서 정확한
// ms 수치로 게이트를 예약하도록 바꿨다 - 파일이 바뀌어도 추정치가 낡아버릴 일이 없다.
const sfxDurationMs = {};
const FALLBACK_SFX_DUR_MS = 900; // 아직 길이를 못 읽은(로딩 중인) 초반 한두 사건용 안전한 기본값
function sfxDurationOf(file) {
  return sfxDurationMs[file] || FALLBACK_SFX_DUR_MS;
}
['card-slap-real.mp3', 'capture-check.mp3', 'match-success.mp3', 'ppeok.mp3', 'ppeok-resolved.mp3',
  'ttadak.mp3', 'sweep.mp3', 'go.mp3', 'win.mp3', 'bonus-reveal.mp3', 'ui-click.mp3'].forEach((file) => {
  const probe = new Audio(`assets/audio/${file}`);
  probe.addEventListener('loadedmetadata', () => { sfxDurationMs[file] = probe.duration * 1000; });
});
// 사운드 묶음(파일, 그 안에서의 delay 초) 목록을 받아 "그 묶음이 실제로 다 끝나는 시각
// (ms)"을 계산한다 - reserveAudioSlot에 그대로 넘기면 된다.
function soundGroupDurationMs(...parts) {
  return Math.max(...parts.map(([file, delaySec]) => delaySec * 1000 + sfxDurationOf(file)));
}

const COMBO_GAP_MS = 60; // 한 사건 안에서 소리 두 개를 겹치지 않고 순서대로 이어붙일 때의 짧은 틈

// 짝 맞추기 계열(capture/jjok/ppeokResolved/ttadak)은 "체크음 -> 성공 챠임"처럼 소리
// 두 개를 잇는다. 예전엔 "0.06초 뒤, 0.15초 뒤"처럼 두 소리의 시작 시각을 손으로 고정해서
// 일부러 살짝 겹치게(콤보처럼 들리라고) 해뒀는데, 첫 소리가 그보다 실제로 더 길게
// 재생되는 경우(실측상 흔함 - 예: capture-check.mp3는 234ms인데 두 번째 소리는 150ms
// 뒤에 시작했다)까지 겹치면서 "카드 한 장 한 장이 각자 소리를 내는 것처럼" 들렸다.
// 이제는 첫 소리의 실제 길이(sfxDurationOf)를 재서, 그게 다 끝난 뒤로만 두 번째 소리를
// 이어 붙인다 - 완전히 순차적이라 절대 안 겹친다.
function sequentialDelays(firstFile, firstDelaySec, secondFile) {
  const secondDelaySec = firstDelaySec + (sfxDurationOf(firstFile) + COMBO_GAP_MS) / 1000;
  const totalMs = secondDelaySec * 1000 + sfxDurationOf(secondFile);
  return { firstDelaySec, secondDelaySec, totalMs };
}

// 각 항목은 재생 직전에 reserveAudioSlot(estimatedMs)로 "이번 사건의 사운드 묶음이
// 실제로 몇 ms 동안 자리를 차지하는지"를 예약하고 돌려받은 gate(초 단위)를, 이 묶음 안
// 모든 playSfx/beep 호출의 delay에 똑같이 더한다 - 묶음 전체가 통째로 뒤로 밀릴 뿐 묶음
// 내부의 상대적 타이밍(예: capture의 체크음 0.06초 뒤 챠임 0.15초)은 그대로 유지된다.
// shake만 예외로 그 안에서 cardSlap()을 직접 부르는데, cardSlap 자신이 이미 매번
// 게이트를 거니 여기서 또 걸 필요가 없다.
const SOUND = {
  // 그냥 내려놓기(짝 없음): 착지 타격음(cardSlap)이 이제 매 착지마다 이미 재생되므로,
  // 여기서 card-drop.mp3를 또 얹으면 오히려 소리가 흐려진다. 이 이벤트만의 특별한 추가
  // 효과음은 없다(그게 바로 "그냥 내려놓기"의 정의이기도 하다).
  place: () => {},
  // 카드 짝 맞추기: "찰칵(체크) + 성공 챠임"을 겹쳐서 짝이 맞았다는 게 확실히 들리도록 한다
  capture: () => {
    const { firstDelaySec, secondDelaySec, totalMs } = sequentialDelays('capture-check.mp3', 0.06, 'match-success.mp3');
    const gate = reserveAudioSlot(totalMs);
    playSfx('capture-check.mp3', { volume: 0.5, delay: firstDelaySec + gate });
    playSfx('match-success.mp3', { volume: 0.5, delay: secondDelaySec + gate });
  },
  jjok: () => {
    const { firstDelaySec, secondDelaySec, totalMs } = sequentialDelays('ui-click.mp3', 0.07, 'match-success.mp3');
    const gate = reserveAudioSlot(totalMs);
    playSfx('ui-click.mp3', { volume: 0.55, delay: firstDelaySec + gate });
    playSfx('match-success.mp3', { volume: 0.55, delay: secondDelaySec + gate });
  },
  ppeok: () => {
    const gate = reserveAudioSlot(soundGroupDurationMs(['ppeok.mp3', 0.03]));
    playSfx('ppeok.mp3', { volume: 0.65, delay: 0.03 + gate });
  },
  // 뻑 해소: 쌓여서 잠겨있던 패 더미가 "풀리는" 느낌으로 뻑 성립과는 다른 소리를 쓴다
  ppeokResolved: () => {
    const { firstDelaySec, secondDelaySec, totalMs } = sequentialDelays('ppeok-resolved.mp3', 0.03, 'match-success.mp3');
    const gate = reserveAudioSlot(totalMs);
    playSfx('ppeok-resolved.mp3', { volume: 0.7, delay: firstDelaySec + gate });
    playSfx('match-success.mp3', { volume: 0.5, delay: secondDelaySec + gate });
  },
  ttadak: () => {
    const { firstDelaySec, secondDelaySec, totalMs } = sequentialDelays('ttadak.mp3', 0.02, 'match-success.mp3');
    const gate = reserveAudioSlot(totalMs);
    playSfx('ttadak.mp3', { volume: 0.6, delay: firstDelaySec + gate });
    playSfx('match-success.mp3', { volume: 0.55, delay: secondDelaySec + gate });
  },
  sweep: () => {
    const gate = reserveAudioSlot(soundGroupDurationMs(['sweep.mp3', 0.06]));
    playSfx('sweep.mp3', { volume: 0.75, delay: 0.06 + gate });
  },
  // 손패 3장이 handCardIds 순서대로 시차(0/70/140ms)를 두고 착지하면서 각자 cardSlap을
  // 직접 재생하므로, 여기서는 그 위에 겹쳐 울릴 낮고 묵직한 "쿵" 강조음만 더한다
  // (마지막 카드가 착지하는 시점 근처에 맞춘 지연). beep은 길이를 정확히 알고 만드므로
  // 실측 없이 350ms(0.35s) 그대로 쓴다.
  bomb: () => { const gate = reserveAudioSlot(150 + 350); beep(80, 0.35, { type: 'square', gain: 0.22, delay: 0.15 + gate }); },
  shake: () => { [0, 0.09, 0.18].forEach((d) => cardSlap(d)); },
  go: () => {
    const gate = reserveAudioSlot(soundGroupDurationMs(['go.mp3', 0]));
    playSfx('go.mp3', { volume: 0.7, delay: gate });
  },
  win: () => {
    const gate = reserveAudioSlot(soundGroupDurationMs(['win.mp3', 0]));
    playSfx('win.mp3', { volume: 0.8, delay: gate });
  },
  // 보너스패: "예상치 못한 추가 보상"에 정확히 맞는 전용 효과음으로 교체
  bonus: () => {
    const gate = reserveAudioSlot(soundGroupDurationMs(['bonus-reveal.mp3', 0.06]));
    playSfx('bonus-reveal.mp3', { volume: 0.75, delay: 0.06 + gate });
  },
};

// 버튼 클릭마다 가벼운 UI 클릭음을 더해 조작감을 살린다 (게임 이벤트 효과음과는 별도)
document.addEventListener('click', (e) => {
  if (e.target.closest('button')) playSfx('ui-click.mp3', { volume: 0.3 });
});

const EVENT_LABEL = {
  jjok: '쪽!', ppeok_formed: '뻑!', ppeok_resolved: '뻑 해소!', ttadak: '따닥!',
  sweep: '싹쓸이!!', bomb: '폭탄!!', shake: '흔들기!', go: '고!', win: '승리!',
  bonus_hand: '보너스! (피 획득 + 한 장 더)', bonus_deck: '보너스 카드 획득!',
};
const EVENT_SOUND = {
  jjok: 'jjok', ppeok_formed: 'ppeok', ppeok_resolved: 'ppeokResolved', ttadak: 'ttadak',
  sweep: 'sweep', bomb: 'bomb', shake: 'shake', go: 'go', win: 'win',
  capture: 'capture', place: 'place', bonus_hand: 'bonus', bonus_deck: 'bonus',
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

// 폭탄/싹쓸이의 큰 흔들림(shakeBoard)보다 훨씬 작은, 일반 캡처용 "톡" 흔들림. 예전에는 폭탄/
// 싹쓸이 말고는 보드 전체가 아무 반응이 없어서, 훨씬 자주 벌어지는 평범한 캡처(쪽/따닥/뻑
// 해소 포함)에서는 카드 한 장의 반짝임 말고는 판 전체에 아무 타격감도 없었다.
function nudgeBoard() {
  const board = document.querySelector('.board');
  if (!board) return;
  board.classList.remove('nudge');
  void board.offsetWidth;
  board.classList.add('nudge');
}

// 흔든 3장을 화면 가운데에 잠깐 펼쳐 보인다. 이 사본들은 순수 표시용이라 data-id를 떼서,
// 애니메이션 로직이 id로 카드를 찾을 때(.card[data-id]) 진짜 카드 대신 이 사본을 잡는 일이 없게 한다.
function showShakeReveal(cards) {
  if (!Array.isArray(cards) || !cards.length) return;
  document.querySelectorAll('.shake-reveal').forEach((n) => n.remove());
  const wrap = document.createElement('div');
  wrap.className = 'shake-reveal';
  wrap.setAttribute('aria-hidden', 'true');
  cards.forEach((c) => {
    const cel = cardEl(c);
    cel.removeAttribute('data-id');
    cel.classList.remove('pop');
    wrap.appendChild(cel);
  });
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 1900);
}

function handleGameEvent(evt) {
  // 고는 몇 번째 고인지가 중요하다(2고부터 배율이 붙음) - "고!"만 뜨면 알 수 없었다.
  const label = evt.kind === 'go' && evt.goCount ? `${evt.goCount}고!` : EVENT_LABEL[evt.kind];
  if (label) showBanner(`${evt.playerName ? evt.playerName + ' ' : ''}${label}`);
  if (evt.kind === 'shake') showShakeReveal(evt.shakeCards);
  const soundKey = EVENT_SOUND[evt.kind];
  if (soundKey && SOUND[soundKey]) SOUND[soundKey]();
  if (evt.kind === 'bomb' || evt.kind === 'sweep') shakeBoard();
  else if (['capture', 'jjok', 'ttadak', 'ppeok_resolved', 'ppeok_formed'].includes(evt.kind)) nudgeBoard();
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

// 입력칸에서 엔터를 치면 버튼을 누른 것처럼 바로 제출되게 한다. 지금까지는 마우스로
// 버튼을 직접 눌러야만 동작해서, 방 코드를 입력하고 엔터를 쳐도 아무 반응이 없어 헷갈렸다.
function submitOnEnter(inputIds, buttonId) {
  inputIds.forEach((id) => {
    el(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el(buttonId).click();
    });
  });
}
submitOnEnter(['create-name'], 'btn-create');
submitOnEnter(['join-code', 'join-name'], 'btn-join');

// 방 코드는 원래 공백 없이 5글자인데, 붙여넣기로 앞뒤에 공백이 딸려 들어오면(흔한 실수)
// 브라우저가 maxlength를 "붙여넣은 문자열 그대로"에 적용해버려서, 공백이 글자 수를 먼저
// 차지하고 정작 중요한 코드 글자가 통째로 잘려나갈 수 있다. paste 이벤트를 가로채서
// 공백부터 제거한 뒤 직접 넣어주면 이 문제를 원천적으로 피할 수 있다(index.html의
// maxlength도 이런 실수에 대비해 여유 있게 잡아둠). 타이핑 중에도 실시간으로 대문자/공백
// 정리를 해서 "제출해야 비로소 대문자로 바뀌는" 것보다 더 즉각적인 피드백을 준다.
function cleanRoomCodeInput(text) {
  return text.replace(/\s+/g, '').toUpperCase().slice(0, 5);
}
el('join-code').addEventListener('input', (e) => {
  const clean = cleanRoomCodeInput(e.target.value);
  if (clean !== e.target.value) e.target.value = clean;
});
el('join-code').addEventListener('paste', (e) => {
  const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
  e.preventDefault();
  e.target.value = cleanRoomCodeInput(text);
});
submitOnEnter(['point-value-input'], 'btn-set-point');
submitOnEnter(['point-value-input-game'], 'btn-set-point-game');

function onJoined(code, playerId) {
  roomCode = code;
  myId = playerId;
  localStorage.setItem('gostop', JSON.stringify({ roomCode, playerId }));
  history.replaceState(null, '', `?room=${code}`);
}

// 새로고침뿐 아니라 "페이지는 그대로인데 소켓 연결만 잠깐 끊겼다가 자동 재연결되는" 경우에도
// 재접속을 다시 시도해야 한다. Socket.io는 끊기면 새 socket.id로 자동 재연결하는데, 그때마다
// 서버는 완전히 새로운 연결로 취급한다(socketMeta에 이 새 id가 등록돼 있지 않음). 그래서
// 'connect' 시점마다(최초 접속이든 와이파이 끊김 후 자동 재연결이든) room:rejoin을 다시 보내지
// 않으면, 화면은 그대로인데 이 클라이언트가 보내는 모든 game:* 요청이 서버에서 "방을 찾을 수
// 없습니다"로 조용히 실패하는 상태가 되어(새로고침 전까지는 원인도 알 수 없이) 게임이 먹통이 된다.
function tryRejoin() {
  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room');
  const saved = JSON.parse(localStorage.getItem('gostop') || 'null');
  if (saved && (!roomParam || roomParam === saved.roomCode)) {
    socket.emit('room:rejoin', saved, (res) => {
      if (res.ok) {
        onJoined(res.roomCode, res.playerId);
        return;
      }
      // 재입장 실패는 "이 방/플레이어는 더 이상 유효하지 않다"는 확정적인 신호다(호스트가
      // 방을 폭파했거나, 서버가 재시작되어 메모리 속 방 목록이 초기화된 경우 등). room:leave
      // 성공 시나 room:destroyed 수신 시에는 이미 localStorage를 지우는데, 이 실패 경로만
      // 빠져 있어서, 낡은 방 정보를 지우지 않으면 와이파이가 잠깐 끊겼다 자동 재연결될
      // 때마다(그때마다 tryRejoin이 다시 불림) 이미 없는 방으로 계속 조용히 재입장을
      // 재시도하게 된다.
      localStorage.removeItem('gostop');
      if (roomParam) el('join-code').value = roomParam;
    });
  } else if (roomParam) {
    el('join-code').value = roomParam;
  }
}
socket.on('connect', tryRejoin);

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

// 대기방에서 나가기 (게임이 시작되기 전에만 가능 - 서버에서도 동일하게 막아준다)
el('btn-leave-room').addEventListener('click', () => {
  if (!confirm('방에서 나갈까요?')) return;
  socket.emit('room:leave', {}, (res) => {
    if (!res.ok) return alert(res.error);
    localStorage.removeItem('gostop');
    roomCode = null;
    myId = null;
    history.replaceState(null, '', location.pathname);
    goScreen('lobby');
  });
});

// 초대 링크 복사: 방 코드를 말로 불러줄 필요 없이 URL 하나로 바로 참가할 수 있게 한다
el('btn-copy-invite').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${roomCode}`;
  const btn = el('btn-copy-invite');
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = '복사됨!';
  } catch (e) {
    // 클립보드 권한이 없는 환경(오래된 브라우저, http 등)에서는 알림으로라도 보여준다
    window.prompt('아래 링크를 복사해서 공유하세요', url);
    btn.textContent = original;
    return;
  }
  setTimeout(() => { btn.textContent = original; }, 1500);
});

// 효과음 켜기/끄기 (브라우저별 개인 설정, localStorage에 저장)
function updateMuteButton() {
  const btn = el('btn-mute');
  if (!btn) return;
  btn.textContent = soundMuted ? '🔇' : '🔊';
  btn.title = soundMuted ? '효과음 꺼짐 (클릭해서 켜기)' : '효과음 켜짐 (클릭해서 끄기)';
}
el('btn-mute').addEventListener('click', () => {
  soundMuted = !soundMuted;
  try { localStorage.setItem('gostop_muted', soundMuted ? '1' : '0'); } catch (e) { /* 무시 */ }
  updateMuteButton();
});
updateMuteButton();

// 초심자용 규칙 가이드: 대기방/게임 화면 양쪽에서 열 수 있고 닫는 방법도 동일하다
el('btn-rules-lobby').addEventListener('click', () => showModal('modal-rules'));
el('btn-rules-game').addEventListener('click', () => showModal('modal-rules'));
el('rules-close').addEventListener('click', () => hideModal('modal-rules'));

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

// 렌더가 "띄워야 한다"고 판단한 모달들. 실제로 띄우는 건 그 렌더의 카드 애니메이션이 끝난 뒤
// (+ 배너/효과음이 먼저 들리도록 약간의 여유)이다. 그 사이 새 상태가 오면 그 렌더의 판단이
// 이긴다(modalToken) - 이미 필요 없어진 창이 뒤늦게 뜨는 일을 막는다.
const deferredModals = new Set();
let modalToken = 0;
const MODAL_AFTER_LANDING_MS = 450;
function showDeferredModals(turnDone) {
  const token = ++modalToken;
  Promise.resolve(turnDone).then(() => new Promise((r) => setTimeout(r, MODAL_AFTER_LANDING_MS))).then(() => {
    if (token !== modalToken) return;
    deferredModals.forEach((id) => showModal(id));
  });
}
function renderGame(state) {
  const round = state.round;
  const me = round.players.find((p) => p.id === myId);
  const myPlayerMeta = state.players.find((p) => p.id === myId);
  // myId가 이번 판의 플레이어 목록과 어긋난 순간(예상 밖의 재접속 경합 등)에는 me가
  // undefined가 되는데, 그대로 진행하면 바로 아래 me.score 등에서 예외가 터진다. 이
  // 함수 전체가 던지는 예외라서 그 뒤에 이어지는 animateNewCards(카드 비행 애니메이션)
  // 호출까지 통째로 실행이 안 되고 조용히 실패한다 - "카드를 낸 순간 카드가 엔티티
  // 취급을 못 받고(애니메이션 없이) 이상해진다"던 증상이 바로 이 경로였다. 이 화면은
  // "나"를 전제로 그려지므로 me 없이는 그릴 수 없어, 다음 정상 상태가 올 때까지
  // 안전하게 건너뛴다.
  if (!me) {
    console.warn('[renderGame] myId가 현재 판 플레이어 목록에 없어 렌더를 건너뜀', { myId });
    return false;
  }

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
      <span class="name">${escapeHtml(meta?.name || '???')}${meta?.connected ? '' : ' (끊김)'}</span>
      <span class="opp-score">${p.score}점${badges ? ' · ' + escapeHtml(badges) : ''}</span>
    `;
    box.appendChild(header);

    const handRow = document.createElement('div');
    handRow.className = 'opp-hand-row';
    handRow.dataset.playerId = p.id; // 상대가 낸 카드가 "이 손에서" 나가는 애니메이션의 출발점 계산용
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
      box.appendChild(capturedGroups(p.captured, { mini: true, cacheKey: `opp-${p.id}` }));
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
  // 덱에서 뒤집은 카드의 짝을 고르는 중(choicePending)에는 서버가 다른 행동을 전부 거부한다.
  // 이때 바닥에는 표시용으로 뒤집은 카드와 대기 중인 짝이 올라와 있어서, 그걸 보고 폭탄 버튼이
  // 떴다가 누르면 거부당하는 식의 헷갈리는 상황이 생기므로 행동 입력 자체를 막아둔다.
  const canAct = isMyTurn && !round.choicePending;

  // 바닥에 같은 월 카드가 여러 장 있으면(뻑 더미 등) 살짝 겹쳐서 한 무더기처럼 보이게 묶는다
  const floorDiv = el('floor');
  floorDiv.innerHTML = '';
  const floorByMonth = new Map();
  round.floor.forEach((c) => {
    if (!floorByMonth.has(c.month)) floorByMonth.set(c.month, []);
    floorByMonth.get(c.month).push(c);
  });
  [...floorByMonth.keys()].sort((a, b) => a - b).forEach((month) => {
    const group = document.createElement('div');
    group.className = 'floor-group';
    floorByMonth.get(month).forEach((c, i) => {
      const onClick = canAct && selectedHandCardId ? () => tryPlay(selectedHandCardId, c.id) : null;
      const cel = cardEl(c, { onClick });
      if (i > 0) cel.style.marginLeft = '-46px';
      group.appendChild(cel);
    });
    floorDiv.appendChild(group);
  });

  // 내 정보
  el('my-score').textContent = `내 점수: ${me.score}점`;
  const capRow = el('my-captured');
  capRow.innerHTML = '';
  capRow.appendChild(capturedGroups(me.captured, { interactive: true, cacheKey: 'me' }));

  // 폭탄을 낸 다음 순번(들)은 "손패 내기 없이 덱만 뒤집기"인데, 이건 손패가 완전히 빈
  // 경우만이 아니라 폭탄으로 3장만 빠지고 카드가 더 남아있는 경우에도 똑같이 적용된다
  // (서버 room.js의 playCard가 skipNextHandPlay>0이면 cardId를 아예 무시하고 덱만 뒤집기
  // 때문). 이걸 몰랐던 예전 버전은 손패가 남아있으면 평소처럼 클릭할 수 있게 놔둬서,
  // 플레이어가 카드를 골라 냈다고 생각해도 서버가 조용히 무시하고 그 카드는 그대로
  // 손에 남은 채 덱만 뒤집혀버리는 혼란스러운 버그가 있었다. 스킵 빚이 있는 동안에는
  // 손패를 눌러도 아무 일도 일어나지 않게 막고, 전용 버튼으로만 진행하게 한다.
  const hasSkipDebt = (me.skipNextHandPlay || 0) > 0;
  const handRow = el('my-hand');
  handRow.innerHTML = '';
  sortedHand(round.myHand).forEach((c) => {
    const div = cardEl(c, {
      selected: c.id === selectedHandCardId,
      onClick: () => {
        // 보낸 요청의 응답이 오기 전에 또 누르면(더블클릭 등) 두 번째 요청은 이미 차례가 넘어간
        // 뒤라 "당신의 차례가 아닙니다" 알림이 떴다 - 응답 전에는 추가 입력을 받지 않는다.
        if (!canAct || hasSkipDebt || playInFlight) return;
        if (c.type === 'bonus') { playBonus(c.id); return; }
        selectedHandCardId = c.id;
        // 서버 응답(보통 로컬 몇 ms, 배포 환경이면 100~300ms)을 기다리는 동안에도 누른 카드가
        // 바로 손에서 살짝 들려 "이 카드를 냈다"는 반응이 즉시 보이게 한다. 응답이 와서
        // 다시 그려지면 이 들린 자리에서 그대로 날아간다.
        div.classList.add('selected');
        tryPlay(c.id);
      },
    });
    if (isMyTurn && hasSkipDebt) div.classList.add('unplayable');
    handRow.appendChild(div);
  });

  // 흔들기/폭탄 버튼
  const monthCounts = {};
  round.myHand.forEach((c) => (monthCounts[c.month] = (monthCounts[c.month] || 0) + 1));
  const shakeable = Object.entries(monthCounts).filter(([m, n]) => n === 3 && !me.shakes.includes(Number(m)));
  const bombable = Object.entries(monthCounts).filter(([m, n]) => n === 3 &&
    round.floor.filter((c) => c.month === Number(m)).length === 1);

  if (canAct && shakeable.length) show('btn-shake'); else hide('btn-shake');
  if (canAct && bombable.length) show('btn-bomb'); else hide('btn-bomb');

  // 폭탄 직후 스킵 턴(손패가 완전히 비었든, 카드가 더 남아있든 상관없이 서버가 손패 내기
  // 자체를 받지 않음)에는 전용 버튼으로만 "덱만 뒤집기"를 진행할 수 있게 한다.
  const needsSkipHandButton = canAct && hasSkipDebt;
  if (needsSkipHandButton) show('btn-skip-hand'); else hide('btn-skip-hand');
  el('btn-shake').onclick = () => openMonthModal('modal-shake', 'shake-options',
    shakeable.map(([m]) => monthSampleCard(round.myHand, Number(m))), (month) => {
      socket.emit('game:declareShake', { month }, (res) => { if (!res.ok) alert(res.error); });
      hideModal('modal-shake');
    });
  el('btn-bomb').onclick = () => openMonthModal('modal-bomb', 'bomb-options',
    bombable.map(([m]) => monthSampleCard(round.myHand, Number(m))), (month) => {
      socket.emit('game:playBomb', { month }, (res) => { if (!res.ok) alert(res.error); });
      hideModal('modal-bomb');
    });

  // 고/스톱 모달 / 라운드 종료 모달 - 띄우는 건 이번 턴 카드가 다 내려앉은 뒤로 미룬다
  // (showDeferredModals). 예전엔 상태가 도착하자마자 떠서, 방금 먹은 카드들이 아직 날아가는
  // 도중에 창이 판을 가려버렸다 - 실제로는 먹을 걸 다 가져오고 점수를 확인한 뒤에 고/스톱을
  // 정한다. 닫는 건 즉시 한다.
  if (round.pendingGoStop && round.pendingGoStop.playerId === myId) {
    el('gostop-score-label').textContent = `현재 ${round.pendingGoStop.score.total}점입니다. 고 하시겠습니까?`;
    deferredModals.add('modal-gostop');
  } else {
    deferredModals.delete('modal-gostop');
    hideModal('modal-gostop');
  }

  if (round.phase === 'round-end' && round.lastResult) {
    renderResult(round.lastResult, state, myPlayerMeta?.isHost);
    deferredModals.add('modal-result');
  } else {
    deferredModals.delete('modal-result');
    hideModal('modal-result');
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

  // 새 이벤트(뻑/따닥/폭탄 등) 연출이 있었는지만 확인해서 반환한다. 예전에는 여기서 곧장
  // handleGameEvent(효과음+배너+흔들기)를 재생했지만, 이 시점은 "서버 상태가 막 갱신된
  // 순간"일 뿐 "카드가 화면에 실제로 도착한 순간"이 아니다. 카드가 날아오는 애니메이션은
  // 이 함수가 끝난 뒤 animateNewCards가 별도로(그것도 requestAnimationFrame 한 틱 뒤에)
  // 재생하기 때문에, 소리/배너를 여기서 바로 재생하면 카드보다 300~500ms 먼저 터져버려서
  // "때리는 느낌"이 아니라 "따로 노는 느낌"이 났다. 그래서 실제 재생은 호출부
  // (socket.on('room:state', ...))가 이 반환값을 animateNewCards에 넘겨서, 카드가 착지하는
  // 시점(Animation.finished)에 정확히 맞춰 재생하도록 미룬다.
  let isNewGameEvent = false;
  if (!eventSeqInitialized) {
    lastSeenEventSeq = round.lastEvent?.seq || 0;
    eventSeqInitialized = true;
  } else if (round.lastEvent && round.lastEvent.seq > lastSeenEventSeq) {
    lastSeenEventSeq = round.lastEvent.seq;
    isNewGameEvent = true;
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
  logDiv.innerHTML = state.log.map((l) => `<div>${escapeHtml(l.message)}</div>`).join('');
  logDiv.scrollTop = logDiv.scrollHeight;

  return isNewGameEvent;
}

function piValueOf(piCards) {
  return piCards.reduce((s, c) => s + (c.piValue || 1), 0);
}

// 덱에서 뒤집은 카드가 바닥 2장과 맞을 때, 서버는 "손패가 바닥에 내려앉고 덱 카드가 뒤집혀
// 나오는" 중간 장면을 먼저 보내고 곧바로 선택을 요구한다. 선택 창을 바로 띄우면 그 창이 방금
// 뒤집힌 카드를 가려서 무엇이 나왔는지 보지도 못한 채 고르게 된다 - 실제로는 뒤집은 패를 보고
// 나서 고르므로, 덱 카드가 바닥에 내려앉을 만큼(덱 페이즈 시작 840ms + 비행 700ms) 기다린다.
const REVEAL_BEFORE_CHOICE_MS = 1600;

function handlePlayResponse(cardId, res) {
  if (res.ok) {
    selectedHandCardId = null;
    hideModal('modal-choice');
    return;
  }
  if (res.needChoice) {
    openChoiceModal(res.matches, (chosenId) => tryPlay(cardId, chosenId));
  } else if (res.needChoice2) {
    setTimeout(() => openChoiceModal(res.matches, (chosenId) => resolveChoice2(chosenId)), REVEAL_BEFORE_CHOICE_MS);
  } else {
    alert(res.error);
    selectedHandCardId = null;
  }
}

// 카드 내기 요청을 보내고 응답을 기다리는 중인지. 연결이 끊겨 응답(ack)이 영영 안 오면
// 입력이 계속 막혀버리므로, 끊김 시와 일정 시간 뒤에는 무조건 풀어준다.
let playInFlight = false;
let playInFlightTimer = null;
function setPlayInFlight(v) {
  playInFlight = v;
  clearTimeout(playInFlightTimer);
  if (v) playInFlightTimer = setTimeout(() => { playInFlight = false; }, 5000);
}
socket.on('disconnect', () => setPlayInFlight(false));

function tryPlay(cardId, chosenFloorId) {
  setPlayInFlight(true);
  socket.emit('game:playCard', { cardId, chosenFloorId }, (res) => {
    setPlayInFlight(false);
    handlePlayResponse(cardId, res);
  });
}

function resolveChoice2(chosenId) {
  socket.emit('game:resolveChoice2', { chosenId }, (res) => {
    selectedHandCardId = null;
    hideModal('modal-choice');
    if (!res.ok) alert(res.error);
  });
}

// 보너스패를 손패에서 낸다: 상대 피 1장씩 받고 덱에서 한 장 더 뽑음. 턴은 안 끝나서
// 이어서 정식으로 카드 한 장을 더 내야 한다(별도 안내 없이, 그냥 계속 내 차례로 보임).
function playBonus(cardId) {
  setPlayInFlight(true);
  socket.emit('game:playBonus', { cardId }, (res) => {
    setPlayInFlight(false);
    if (!res.ok) alert(res.error);
  });
}

function openChoiceModal(matches, onPick) {
  const box = el('choice-options');
  box.innerHTML = '';
  matches.forEach((c) => {
    box.appendChild(cardEl(c, { onClick: () => { hideModal('modal-choice'); onPick(c.id); } }));
  });
  showModal('modal-choice');
}

// 흔들기/폭탄 대상 월을 대표하는 카드 한 장을 손패에서 찾는다(광/열끗/띠/피 순으로 우선).
// 실제 카드 그림을 보여줘야 어떤 패인지 한눈에 알아보기 쉽다(텍스트로 "5월"만 있으면 헷갈림).
function monthSampleCard(hand, month) {
  return sortedHand(hand).find((c) => c.month === month);
}

function openMonthModal(modalId, optionsId, cards, onPick) {
  const box = el(optionsId);
  box.innerHTML = '';
  cards.forEach((c) => {
    if (!c) return;
    box.appendChild(cardEl(c, { onClick: () => onPick(c.month) }));
  });
  showModal(modalId);
}

el('btn-skip-hand').addEventListener('click', () => {
  // 스킵 턴 전용: 실제로 낼 손패가 없으므로 cardId 없이 보낸다(서버도 이 상태에서는
  // cardId를 쓰지 않고 덱만 뒤집는다). 덱만 뒤집는 턴에도 뒤집은 카드가 바닥 2장과 맞으면
  // 선택을 요구받는데, 예전엔 그 응답을 에러로만 처리해서 "undefined" 알림만 뜨고 선택 창이
  // 안 열려, 서버는 선택을 기다리는데 선택할 방법이 없어 판 전체가 멈춰버렸다.
  socket.emit('game:playCard', { cardId: null }, (res) => handlePlayResponse(null, res));
});

el('shake-cancel').addEventListener('click', () => hideModal('modal-shake'));
el('bomb-cancel').addEventListener('click', () => hideModal('modal-bomb'));

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

// 박 사유를 그냥 이름만 보여주면 왜 그게 붙었는지 알기 어려워서, 짧은 이유를 덧붙인다.
const BAK_REASON_EXPLAIN = {
  '광박': () => '광을 한 장도 못 먹음',
  '피박': (piCount, piThreshold) => `피 ${piCount}장 (${piThreshold}장 이하)`,
  '고박': () => '혼자 고를 선언하고 짐',
  '독박': () => '이 족보를 완성시켜준 패를 혼자 다 냄',
};

function renderResult(result, state, isHost) {
  el('result-title').textContent =
    result.result === 'win' ? `🎉 ${result.winnerName}님 승리!` :
    result.result === 'nagari' ? '나가리 (무효)' : '판 강제 종료';

  const body = el('result-body');
  if (result.result === 'win') {
    const s = result.settlement;
    const d = s.base.detail;
    const piThreshold = state.players.length === 2 ? 7 : 5; // server/engine.js computeSettlement과 동일 기준
    // 호스트는 점당 금액을 phase 상관없이(라운드 종료 후, "다음 판 시작" 누르기 전에도)
    // 바꿀 수 있다. 이 결과 화면은 이미 끝난 판의 지불액을 보여주는 것이므로, 그 사이
    // 바뀌었을 수도 있는 "현재" state.pointValue가 아니라 실제로 이 판의 ledger 반영에
    // 쓰인 값(pointValueAtSettlement, room.js의 finishRound가 정산 시점에 남겨둠)을 써야
    // 화면 숫자가 항상 실제 ledger 변동액과 일치한다.
    const pv = result.pointValueAtSettlement ?? state.pointValue;

    const ttiFlags = [d.hongdan && '홍단', d.chodan && '초단', d.cheongdan && '청단'].filter(Boolean);
    const breakdown = [
      `광 ${d.gwangCount}장 (${s.base.gwangScore}점)`,
      `띠 ${d.ttiCount}장 (${s.base.ttiScore}점${ttiFlags.length ? ' · ' + ttiFlags.join('·') : ''})`,
      `열끗 ${d.yeolkkeutCount}장 (${s.base.yeolkkeutScore}점${d.godori ? ' · 고도리' : ''})`,
      `피 ${d.piValue}장 (${s.base.piScore}점)`,
    ].join(' · ');

    const rows = Object.entries(s.payments).map(([pid, pay]) => {
      const name = state.players.find((p) => p.id === pid)?.name || pid;
      const rp = state.round.players.find((p) => p.id === pid);
      const piCount = rp ? piValueOf(rp.captured.pi) : 0;
      const gwangCount = rp?.captured.gwang.length ?? 0;
      const reasonText = pay.reasons.length
        ? pay.reasons.map((r) => `${r}(${(BAK_REASON_EXPLAIN[r] || (() => ''))(piCount, piThreshold)})`).join(', ')
        : '-';
      const capturedText = `광 ${gwangCount}장 · 피 ${piCount}장`;
      return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(capturedText)}</td><td>${escapeHtml(reasonText)}</td><td>x${pay.multiplier}</td><td>-${Math.round(pay.amount * pv).toLocaleString()}원</td></tr>`;
    }).join('');

    // 각 지불액을 원 단위로 반올림한 "뒤에" 더해야 한다. server/room.js의 finishRound()도
    // 정확히 이 순서(패자별로 각각 Math.round(pay.amount * pointValue)를 계산한 뒤 그 값들을
    // 승자 ledger에 합산)로 실제 돈을 정산한다. 여기서 raw amount를 먼저 합산하고
    // "총합에" 한 번만 반올림해버리면(반올림 순서가 반대), 점당 금액이 정수가 아닌 경우
    // (예: 100/3원처럼 나누어떨어지지 않는 값) 이 결과 화면의 "총 획득"이 실제 정산 막대
    // (ledger-bar, state.ledger 기반)와 다른 숫자로 보일 수 있다.
    const totalReceived = Object.values(s.payments)
      .reduce((sum, p) => sum + Math.round(p.amount * pv), 0);

    body.innerHTML = `
      <p>${escapeHtml(breakdown)}<br/>
      기본점 <b>${s.base.total}점</b>
      + 고 ${s.goCount}회(가산 ${s.goAddPoint}점, 배율 x${s.goMultiplier}) · 흔들기/폭탄 배율 x${s.shakeBombMultiplier}
      = <b>${s.scoreBeforeBak}점</b></p>
      <table><tr><th>플레이어</th><th>남은 패</th><th>박</th><th>배율</th><th>지불액</th></tr>${rows}</table>
      <p class="muted">${escapeHtml(result.winnerName)}님 총 획득: +${totalReceived.toLocaleString()}원</p>
    `;
  } else {
    body.innerHTML = '<p>다음 판으로 넘어갑니다.</p>';
  }
  if (isHost) show('result-host-actions'); else hide('result-host-actions');
}

// ---------- 소켓 상태 반영 ----------
// 이 클라이언트가 게임 화면을 실제로 그린 적이 있는지 여부. 처음 접속/새로고침/재접속 직후의
// 첫 렌더에서는 round.lastEvent가 "예전에 이미 일어난" 이벤트일 수 있는데, 그걸로
// animateNewCards를 돌리면 화면에 있던 카드 중 하나가 뜬금없이 덱/손패에서 날아오는 것처럼
// 보이는 오작동이 생긴다(배너/효과음은 eventSeqInitialized로 이미 막고 있었지만 이동 애니메이션은
// 그 가드가 없었다). 첫 렌더에서는 이동 애니메이션 없이 pop 효과만 나오도록 건너뛴다.
let hasRenderedGameOnce = false;
socket.on('room:state', (state) => {
  if (!state.round) {
    latestState = state;
    goScreen('room');
    renderRoom(state);
    return;
  }

  // 새 상태가 도착했을 때 이전 턴의 카드 애니메이션이 아직 재생 중일 수 있다(캡처가 있으면
  // 한 턴에 1초 넘게 걸리기도 하는데, 상대가 그보다 빨리 다음 수를 두면 겹친다 - 특히 혼자
  // 두 탭을 오가며 테스트할 때 흔하다). 예전엔 여기서 document.getAnimations().forEach(a =>
  // a.finish())로 진행 중인 애니메이션을 전부 즉시 끝내버렸는데, 이게 바로 "맞은 카드끼리
  // 동시에 움직이는 구간이 안 보인다"는 증상의 진짜 원인이었다: 실측해보니 한 턴의 캡처
  // 시퀀스가 다 끝나기도 전에(특히 손패+덱이 둘 다 걸린 턴은 1초 반 넘게 걸리는데) 다음
  // 상태가 도착하는 일이 흔했고, 그때마다 아직 스윕을 시작하지도 않은 카드까지 전부 그
  // 자리에서 최종 위치로 순간이동해버려서 - 정작 "다같이 쓸려 들어가는" 장면 자체를 한
  // 번도 보여주지 못한 채 매번 잘려나가고 있었다.
  //
  // getBoundingClientRect()가 "날아가는 중"인 위치를 그대로 돌려준다는 점 자체는 FLIP
  // 기법에 문제가 안 된다(그 카드가 "지금 실제로 있는 자리"에서 새 목적지까지의 거리만
  // 정확하면 되므로) - 그래서 이제 여기서는 아무것도 강제로 끝내지 않고, 이번 렌더에서
  // 실제로 새 애니메이션을 받을 그 카드 하나만(flyCard/flyCardViaMeeting 안에서) 자기
  // 자신의 이전 애니메이션만 취소한다(다른 카드와 안 겹치게). 이번 턴과 무관한 카드는
  // 이전 턴의 애니메이션이 방해받지 않고 원래 예정대로 끝까지 재생된다.

  // 리렌더 직전의 카드/손패 줄 위치를 기록해뒀다가, 리렌더 후 위치 변화만큼 되짚어 애니메이션
  // -> "손에서 나가서 바닥에 놓이거나 덱에서 뒤집혀 나오는" 것처럼 보이게 한다.
  const oldRects = captureCardRects();
  const oldHandRowRects = captureHandRowRects();
  const oldFloorIds = captureFloorCardIds();
  const oldOwners = captureCardOwners();
  const isFirstRender = !hasRenderedGameOnce;
  latestState = state;
  goScreen('game');
  const isNewGameEvent = renderGame(state);
  const turnDone = isFirstRender
    ? Promise.resolve()
    : animateNewCards(state, oldRects, oldHandRowRects, isNewGameEvent, oldFloorIds, oldOwners);
  showDeferredModals(turnDone);
  hasRenderedGameOnce = true;
});

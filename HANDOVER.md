# GoStop 프로젝트 인수인계서

> 목적: 이 문서 + 이 저장소 폴더만 보고, 다른 AI(또는 사람)가 코드를 처음부터
> 전부 다시 읽지 않고도 데이터 구조·알고리즘·소켓 프로토콜·지금까지의 버그
> 수정 이력·현재 남은 일을 정확히 파악해서 바로 이어서 작업할 수 있게 하는
> 것. 예쁘게 요약하는 게 목적이 아니라 **정보량**이 목적이므로, 아래는 의도적으로
> 코드 수준 디테일(정확한 필드명, 분기 조건, 함수 시그니처)까지 담았다.
> 보기 좋은 요약이 필요하면 6장(하우스 룰)과 10장(기능 목록)만 훑어도 되지만,
> 실제로 코드를 고치기 전에는 4~8장을 꼭 읽을 것.

관련 문서:
- `gostop_rules.md` — 게임 규칙 확정본(1차 근거 문서). 이 문서의 6장은 그걸 요약한 것.
- `claude/improvement_log.md` — 지금까지의 모든 작업을 날짜 없이 시간순으로 쌓아온 원본 로그(이 문서보다 더 세밀한 diff 수준 설명과 검증 방법이 담겨 있음). 이 문서의 12장은 그걸 표로 압축한 것.
- 위 두 문서와 이 문서(HANDOVER.md)는 Claude Project("GoStop")의 프로젝트 문서로도 동일 내용이 올라가 있다. 코드 저장소 폴더 안의 파일과 항상 둘 다 갱신할 것.

---

## 1. 한 줄 요약과 실행

친구들끼리 온라인으로 하는 2~4인용 웹 고스톱(화투). Node.js(Express+Socket.io)
서버가 모든 게임 로직의 권위를 갖고(서버 권위/authoritative), 클라이언트는
순수 바닐라 JS(프레임워크 없음)로 서버가 밀어주는 상태를 그대로 그린다.
git 저장소 아님 — 롤백 안전망이 없으므로 모든 변경은 테스트로 검증한 뒤에만
반영한다.

```bash
npm install
npm start        # http://localhost:3000
npm test         # server/test/engine.test.js && room.test.js && socket.test.js (총 46개)
```

---

## 2. 실행 환경 — 두 개의 파일시스템 (반드시 이해하고 시작할 것)

이 프로젝트는 **물리적으로 서로 다른 두 컴퓨터**에 동시에 존재한다.

| | 경로 | 성격 |
|---|---|---|
| 정본(진짜 사용자 컴퓨터, Windows) | `C:\Users\USER\Desktop\Data\01Programming\GoStop\gostop-online` | 사용자가 실제로 플레이/배포하는 코드. **git 없음.** |
| 클라우드 미러(이 세션의 작업 공간) | `/home/claude/gostop` | 무거운 검증(`npm test`, Playwright)을 돌리기 위한 거울 사본. |

둘은 `mcp__remote-devices__*` 브릿지로만 연결되고 **직접 네트워크 경로가
없다**. 사용자 컴퓨터 쪽 셸(`device_bash`)과 클라우드 쪽 셸(`Bash`)은 완전히
분리된 프로세스/머신이라, 한쪽에서 파일을 고쳤으면 **반드시 다른 쪽도 같이
고쳐서 두 사본을 계속 일치시켜야 한다.**

**동기화 안전 수칙 (여러 세션의 시행착오로 정립됨):**

- **한두 줄짜리 작은 수정**: `device_bash`(사용자 컴퓨터) 또는 `Bash`(클라우드)
  안에서 Python으로 정확 문자열 치환. 치환 전에 반드시
  `assert content.count(old_string) == 1`로 그 문자열이 파일에 정확히 한 번만
  있는지 확인한 뒤 교체. 양쪽 모두 동일하게 적용.
- **파일 전체를 통째로 옮겨야 할 때**(미러가 깨졌거나 처음부터 다시 맞출 때):
  `device_stage_files`로 사용자 컴퓨터의 파일을 클라우드 컨테이너의
  `/mnt/user-data/uploads/...`로 직접 스테이징한 뒤 `cp`로 미러 경로에 복사.
  **수동으로 텍스트를 옮겨 적는 base64 청크 relay는 쓰지 말 것** — 과거에
  복사 도중 글자가 누락/치환되는 사고가 실제로 있었다(20000자여야 할 청크가
  19761자로 잘리는 등).
- 변경 후 `node --check`(문법)와 `npm test`(전체 회귀)를 **양쪽 파일시스템
  모두에서** 통과시키고, 필요하면 `diff -q`로 두 사본이 바이트 단위로
  일치하는지 재확인한다. mp3 파일은 전송 중 ID3v2 패딩이 붙을 수 있는데
  오디오 프레임 자체는 동일해서 무해함(이미 확인됨).
- `device_bash`의 **각 호출은 매번 완전히 새로운 셸**이다. 백그라운드로 띄운
  프로세스(개발 서버 등)는 그 호출이 끝나는 순간 함께 죽는다 — 실측
  확인됨(`setsid nohup node server/index.js & disown` 뒤 같은 호출 안에서는
  `ps aux`로 살아있었지만, 다음 호출에서는 이미 죽어 포트 접속도 거부됨).
  즉 "서버를 띄워두고 브라우저로 여러 번 왕복" 하는 식의 검증(Playwright
  실측 등)은 이 브릿지로는 구조적으로 불가능 — **클라우드 미러 사본**에서
  서버+헤드리스 브라우저를 띄워야 한다.
- `device_commit_files`는 `/mnt/user-data/outputs/` 아래의 파일만
  `stagedPath`로 받아준다 — 반영할 파일은 먼저 그 경로 아래로 복사해두고
  커밋해야 한다.

---

## 3. 저장소 구조

```
server/
  deck.js         화투 48장 + 보너스패 2장 정의                        (97줄)
  engine.js       순수 게임 로직(상태를 인자로 받아 계산만, 부수효과 최소) (551줄)
  room.js         Room 클래스 — 실제 게임 상태 보유 + engine.js 위임    (491줄)
  index.js        Express + Socket.io 서버, 소켓 라우팅                (468줄)
  test/
    engine.test.js  엔진 유닛 테스트 (16개)                            (351줄)
    room.test.js    Room 클래스 통합 테스트 (22개)                     (478줄)
    socket.test.js  실제 socket.io-client 왕복 테스트 (8개)            (248줄)
    smoke.js        3인 실전 통합 스모크(자동 스위트 미포함, 수동용)     (111줄)
public/
  index.html      화면 마크업(로비/대기방/게임 화면 + 6개 모달)         (184줄)
  style.css       전체 스타일(반응형+접근성+애니메이션 keyframe)        (496줄)
  client.js       프론트엔드 전부(렌더링/애니메이션/사운드/소켓)       (1212줄)
  assets/cards/   화투 48장 실사 .webp + back.webp = 49개 파일
  assets/audio/   효과음 mp3 13개
gostop_rules.md               게임 규칙 확정본
claude/improvement_log.md     전체 작업 로그(작업 규율 + 완료 이력 + 백로그)
HANDOVER.md                   이 문서
README.md                     설치/배포/방생성 안내(사용자 대상)
```

---

## 4. 데이터 모델 (가장 중요 — 여기를 정확히 알아야 코드가 읽힌다)

### 4.1 Card 객체 (`server/deck.js`)

```js
function card(id, month, type, name, extra = {}) {
  return { id, month, type, name, ...extra };
}
```

- `id`: 문자열, 카드 이미지 파일명과 1:1 대응(`public/assets/cards/${id}.webp`).
  예: `'1-gwang'`, `'11-pi-a'`, `'bonus-1'`(단, 보너스패는 이미지가 없고
  client.js가 SVG 메달리온을 대신 그림 — 4.5 참고).
- `month`: 1~12 정수, 보너스패만 `null`.
- `type`: `'gwang'`(광) / `'yeolkkeut'`(열끗) / `'tti'`(띠) / `'pi'`(피) /
  `'bonus'`(보너스패). **주의**: 보너스패는 `type: 'bonus'`를 화면 표시용으로
  유지하지만, `addToCaptured()`가 실제로는 `player.captured.pi` 버킷에
  담는다(즉 점수 계산상 카드 타입은 `pi`, 화면 렌더링상 타입은 `bonus`).
- `extra`로 붙는 필드들(카드마다 다름):
  - `ribbonColor`: `'hong'|'cho'|'cheong'|null` — 띠 카드의 색깔 조합용. 12월
    비띠만 `null`(색깔 조합엔 미포함이지만 개수 집계엔 포함 — 8.6절 참고).
  - `piValue`: 피 카드의 가치(기본 1, 쌍피는 2). **없으면 기본값 1로
    취급**(`c.piValue || 1`로 여러 곳에서 읽음).
  - `godori`: 고도리 대상 열끗(2/4/8월)에 표시(실제로는 `computeScore`가
    `godoriMonths = [2,4,8]`로 다시 하드코딩해서 확인하므로 이 플래그 자체는
    장식용에 가까움).
  - `flexCard: true`: 9월 국화(열끗) 카드에만 — 열끗↔쌍피 자유 전환 대상.
  - `isRainGwang: true`: 12월 광(비광)에만 — 비3광(2점) 판정용.
  - `isBonus: true`: 보너스패 2장에만.

카드가 바닥(`floor`)에 놓일 때는 `playTurn`/`skipDeckFlip`이 추가로
`placedBy`(누가 냈는지: playerId 또는 `'deck'`)와 `stuck`(뻑 더미로 쌓여
있는지 boolean)을 덧붙인다. `placedBy`는 독박 판정(`findDokbakTarget`)의
유일한 근거 데이터다.

### 4.2 전체 카드 목록 (50장, `buildDeck()` 순서 그대로)

| 월 | 광(光) | 열끗 | 띠 | 피 |
|---|---|---|---|---|
| 1월 송학 | `1-gwang` | — | `1-tti`(홍단) | `1-pi-a`, `1-pi-b`(각 1) |
| 2월 매조 | — | `2-yeolkkeut`(godori) | `2-tti`(홍단) | `2-pi-a`, `2-pi-b`(각 1) |
| 3월 벚꽃 | `3-gwang` | — | `3-tti`(홍단) | `3-pi-a`, `3-pi-b`(각 1) |
| 4월 흑싸리 | — | `4-yeolkkeut`(godori) | `4-tti`(초단) | `4-pi-a`, `4-pi-b`(각 1) |
| 5월 난초 | — | `5-yeolkkeut` | `5-tti`(초단) | `5-pi-a`, `5-pi-b`(각 1) |
| 6월 모란 | — | `6-yeolkkeut` | `6-tti`(청단) | `6-pi-a`, `6-pi-b`(각 1) |
| 7월 홍싸리 | — | `7-yeolkkeut` | `7-tti`(초단) | `7-pi-a`, `7-pi-b`(각 1) |
| 8월 공산 | `8-gwang` | `8-yeolkkeut`(godori) | (없음) | `8-pi-a`, `8-pi-b`(각 1) |
| 9월 국화 | — | `9-yeolkkeut`(**flexCard**, 열끗↔쌍피 전환) | `9-tti`(청단) | `9-pi-a`, `9-pi-b`(각 1, **둘 다 일반 피** — 9월엔 고정 쌍피 없음) |
| 10월 단풍 | — | `10-yeolkkeut` | `10-tti`(청단) | `10-pi-a`, `10-pi-b`(각 1) |
| 11월 오동 | `11-gwang` | (없음) | (없음) | `11-pi-a`(**쌍피, piValue:2**), `11-pi-b`, `11-pi-c`(각 1) |
| 12월 비 | `12-gwang`(**isRainGwang**) | `12-yeolkkeut` | `12-tti`(**ribbonColor:null**, "비띠") | `12-pi`(**쌍피, piValue:2**) |
| 보너스 | — | — | — | `bonus-1`, `bonus-2`(**isBonus, piValue:2**, month 없음) |

광 5장(`1,3,8,11,12-gwang`), 열끗 9장(2·4·5·6·7·8·9·10·12월 — 1·3·11월엔
열끗이 없음), 띠 **10장**(1~7·9·10·12월,
8월과 11월만 띠가 없음 — **12월 비띠도 물리적으로 존재하는 tti 타입
카드라 여기 포함된다**. `gostop_rules.md` 2장 표는 "9장"이라고 적어뒀는데
이건 그 문서의 오기/누락이고, 실제 `deck.js`와 아래 4.6/5.7절의 "12월
비띠는 개수 집계에 포함" 규칙은 10장 기준으로 정합적이다), 피 24장(1~10월
각 2장=20 + 11월 3장 + 12월 1장) + 보너스 2장 = 정확히 50장.
(`engine.test.js`의 첫 테스트가 이 합계와 카테고리별 개수를 검증한다.)

**쌍피(piValue:2)는 정확히 4곳뿐: `11-pi-a`, `12-pi`, `bonus-1`, `bonus-2`.**
9월 국화(`9-yeolkkeut`)는 기본 상태에선 열끗이고, 자기 창고에서 쌍피로
전환하면 그 순간 `type`이 `pi`로 바뀌고 `piValue:2`가 붙는다(4.6절
`toggleFlexCard` 참고) — 즉 쌍피가 "5번째로" 존재할 수 있는 유일한 동적
경로.

### 4.3 Room 클래스 필드 (`server/room.js`, 방 하나 = Room 인스턴스 하나)

| 필드 | 타입 | 설명 |
|---|---|---|
| `code` | string(5자) | 방 코드(`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`에서 생성, 혼동되는 0/1/O/I 제외) |
| `id` | nanoid | 내부 고유 id(코드와 별개, 거의 안 쓰임) |
| `players` | `[{id, name, socketId, connected, isHost}]` | 방에 있는 사람(라운드 유무와 무관). id는 `nanoid(8)`. |
| `pointValue` | number | 점당 금액(원), 기본 100, 언제든 변경 가능 |
| `ledger` | `{playerId: number}` | 누적 정산 금액(양수=땄음, 음수=잃음). 방이 존재하는 동안 계속 누적 |
| `round` | round 객체 또는 `null` | 대기방 단계면 `null` |
| `roundNumber` | number | 지금까지 시작된 판 수(1부터) |
| `log` | `[{ts, message}]` | 최근 200개까지 보관, 클라이언트엔 최근 30개만 전송 |
| `eventSeq` | number | `pushEvent`마다 증가하는 시퀀스 번호(클라이언트가 같은 이벤트를 중복 처리하지 않도록) |
| `nextDealerIndex` | number 또는 `null` | `null`이면 "이 방의 첫 판 선이 아직 안 정해짐". 첫 `startRound()`에서 무작위로 채워진 뒤 매 판 한 칸씩 회전 |

### 4.4 round 객체 (`this.round`, `startRound()`가 생성)

| 필드 | 타입 | 설명 |
|---|---|---|
| `deck` | Card[] | 남은 뒷면 더미(배열 앞쪽이 다음에 뒤집을 카드 — `shift()`로 꺼냄) |
| `hand` | `{playerId: Card[]}` | 각자의 손패(서버만 전체를 알고, `publicState`는 본인 것만 노출) |
| `floor` | Card[] | 바닥 카드(각 카드에 `placedBy`/`stuck` 붙어 있음) |
| `players` | round-player[] (4.5 참고) | 라운드 시작 시점 인원으로 고정(중도 참가/퇴장 불가) |
| `turnOrder` | playerId[] | 이 판의 진행 순서(선부터). `startRound`가 좌석 순서를 `nextDealerIndex`만큼 회전시켜 만듦 |
| `turnIndex` | number | `turnOrder`에서 현재 차례의 인덱스 |
| `phase` | `'playing' \| 'await-gostop' \| 'round-end'` | **주의**: 주석에는 `'await-choice'`도 나열돼 있지만 실제로 세팅되는 곳이 전혀 없다 — 죽은 상태값이다(4.8절 "코드의 함정" 참고). 바닥 2장 매치(손패 내기 쪽)는 상태로 안 남기고 그 자리에서 바로 `NEED_CHOICE` 에러를 던져 같은 소켓 호출 안에서 재요청받는 방식이라 phase 전이가 필요 없다. |
| `pendingChoice` | `null` 고정 | 위와 같은 이유로 항상 `null`. 실질적으로 죽은 필드. |
| `pendingChoice2` | `null` 또는 `{playerId, flippedCard, matches, captured, events, step1Captured, step1Month}` | **덱 뒤집기**로 나온 카드가 바닥의 같은 월 2장과 매치되는 드문 경우에만 세팅. 이 상태 동안은 `assertActionAllowed`가 다른 모든 행동(카드 내기/폭탄/흔들기)을 거부한다. `resolveChoice2(playerId, chosenId)`로만 풀림. |
| `pendingGoStop` | `null` 또는 `{playerId, score}` | 문턱 점수 달성 직후 고/스톱 응답 대기 |
| `firstGoCallerId` | playerId 또는 `null` | 이 판에서 **처음으로** 고를 선언한 사람(고박 판정의 유일한 근거 — 4.6절 참고) |
| `resultLog` | `[]` | 선언만 돼 있고 실제로 채우는 코드는 없음(죽은 필드로 보임) |
| `lastEvent` | `null` 또는 `{seq, kind, playerId, playerName, ...extra}` | 클라이언트 연출(배너/효과음)용 최신 이벤트 1개 |
| `lastResult` | `null` 또는 결과 객체 | `round-end` 진입 시 세팅(4.7절) |

### 4.5 round.players[i] (라운드 참가자 개인 상태)

```js
{
  id, // playerId
  captured: { gwang: [], yeolkkeut: [], tti: [], pi: [] }, // 종류별 획득 카드 (보너스패도 pi에 들어감)
  shakes: [], // 흔든 월 목록, 예: [4, 7] (같은 월 두 번 흔들기 금지)
  bombCount: 0, // 폭탄 낸 횟수(배율에 2^n으로 곱해짐)
  hasCalledGo: false, // finishRound에서 "이 판의 고박 대상인지"로 재계산됨(4.6 참고)
  goCount: 0, // 이 사람이 이번 판에서 고를 부른 횟수
  scoreAtLastGo: 0, // 직전 고를 부른 시점의 점수(다음 고 자격 판정 기준)
  skipNextHandPlay: 0, // 폭탄 이후 "손패 못 내고 덱만" 남은 턴 수
}
```

### 4.6 정산 관련 규칙과 정확한 코드 근거

- **고박은 "이 판에서 처음 고를 선언한 사람" 단 한 명에게만 적용된다.**
  `goStopDecision`의 `'go'` 분기에서 `if (!r.firstGoCallerId) r.firstGoCallerId = playerId`
  로 딱 한 번만 채워지고, `finishRound()`가
  `p.hasCalledGo = p.id === r.firstGoCallerId && p.id !== winnerId`로 그
  사람 한 명에게만 고박 자격을 부여한다. (예전엔 `goCount > 0`인 모든 패자에게
  겹쳐 적용되던 버그가 있었음 — 12.x 참고.)
- **독박**은 "이 판에서 아무도 고를 선언한 적이 없을 때만" 성립한다
  (`computeSettlement`의 `anyGoThisRound` 체크 — 승자 자신이 고를 한 번도
  안 불렀어도, 다른 누군가 먼저 불렀다가 역전당했다면 그건 이미 "고가 있었던
  판"이라 독박이 아니다). 대상 판정은 `findDokbakTarget`(4.7 하단)이 승자가
  완성한 족보(홍단/청단/초단/고도리/광 중 실제로 점수를 낸 것들만)에 들어간
  카드들의 `placedBy`를 보고, 상대 중 단 한 명으로 특정될 때만 그 사람을
  지목한다(단순화 — 7장 참고).
- **광박**: `base.gwangScore > 0 && p.captured.gwang.length === 0`.
- **피박**: `base.piScore > 0 && loserPi <= piThreshold`(2인은 7, 그 외 5).
- **박은 곱으로 중첩**된다(`mult *= 2`를 조건마다 누적) — 광박+피박 동시
  적용되면 4배.
- 정산 순서(코드 그대로): `scoreBeforeBak = (base.total + goAddPoint) * goMultiplier * shakeBombMultiplier`
  를 먼저 계산한 뒤, 패자별로 그 값에 박 배율(들)을 곱해서 `payments[pid].amount`를 만든다.
  `pointValue`(원/점)는 여기서 곱해지지 않고, `Room.finishRound()`가
  `Math.round(pay.amount * this.pointValue)`로 **각 패자별로 개별
  반올림한 뒤** ledger에 반영한다 — 클라이언트가 "총 획득"을 표시할 때도
  반드시 이 순서(패자별 반올림 → 합산)를 그대로 따라야 한다(안 그러면
  점당 금액이 정수가 아닐 때 어긋남 — 12.x 참고).
- **흔들기·폭탄 배율**: `shakeBombMult = 2^(흔든 횟수 + 폭탄 횟수)`(둘을 합쳐서
  지수로 계산 — 흔들기 1번+폭탄 1번=4배, 흔들기 2번=4배 등).
- **고 배율**: `goMultiplierInfo(goCount)` — `goCount<=0`이면 `{addPoint:0, multiplier:1}`,
  `goCount===1`이면 `{addPoint:1, multiplier:1}`(1고는 그냥 +1점),
  `goCount>=2`면 `{addPoint:1, multiplier: 2^(goCount-1)}`.

### 4.7 라운드 종료 3가지 경로 (모두 `round.phase = 'round-end'` + `round.lastResult` 세팅)

| 경로 | 트리거 | `lastResult.result` |
|---|---|---|
| `finishRound(winnerId, goCount)` | 문턱 점수 달성자가 `'stop'` 선택 | `'win'` |
| `finishAsNagari()` | 아무도 문턱을 못 넘긴 채 손패/덱이 소진(나가리) | `'nagari'` |
| `forceEndRound()` | 호스트가 "이 판 무효 처리" 버튼 | `'forced'` |

세 경로 모두 공통적으로 `pendingGoStop = null`을 지운다(빼먹으면 결과
모달과 고/스톱 모달이 동시에 뜨는 버그가 났던 전례 — 12.x 참고).
`finishRound`만 `settlement`/`ledger`/`pointValueAtSettlement`을
`lastResult`에 채운다 — 나가리/강제종료는 돈이 안 오가므로 `ledger` 스냅샷만
남긴다.

### 4.8 `publicState(forPlayerId)` — 클라이언트에 실제로 나가는 데이터

`Room.publicState`는 상대의 손패를 절대 노출하지 않는다: 다른 사람은
`handCount`(장수)만, 본인은 `round.myHand`(실제 카드 배열)만 받는다.
`round.players[i]`는 `captured`/`handCount`/`shakes`/`bombCount`/`goCount`/
`score`(그 시점 `computeScore().total`)/`skipNextHandPlay`만 노출하고,
`scoreAtLastGo`/`hasCalledGo`/`firstGoCallerId` 같은 서버 내부 판정용 필드는
안 나간다.

**코드의 함정(다른 AI가 헷갈리기 쉬운 부분들)**:
- `round.phase`에 `'await-choice'`가 있다고 주석에 쓰여 있지만 실제로는 절대
  세팅되지 않는 죽은 값이다 — 바닥 2장 매치(손패 내기)는 `NEED_CHOICE`를
  즉시 던져서 같은 소켓 콜백 안에서 처리되고, 서버 상태로 남지 않는다.
  **오직 덱 뒤집기 2장 매치만** `pendingChoice2` + phase 그대로 `'playing'`
  유지로 비동기 대기 상태가 된다. `pendingChoice`(단수) 필드도 항상 `null`.
- 폭탄(`playBomb`)은 **뻑/따닥/쪽/싹쓸이 판정을 전혀 거치지 않는다** — 바로
  4장을 캡처하고 `events: ['bomb']`만 반환. `finalizeCaptures`를 안 거치므로
  피 보너스 로직(`piBonusCount` 집계)도 안 거치고, 대신 `playBomb` 자체
  안에서 상대 전원에게 피 1장씩 직접 받아온다.
- `card.piValue`가 없는 일반 피는 명시적으로 `1`이 저장돼 있지 않고
  `undefined`다 — 합산할 때 항상 `c.piValue || 1`로 방어적으로 읽어야 한다
  (여러 함수에 이 패턴이 반복됨: `computeScore`, `computeSettlement`,
  `takePiFromPlayer`).

---

## 5. engine.js 알고리즘 상세

### 5.1 `shuffle(arr)` / `dealCounts(playerCount)` / `dealNewRound(playerIds)`

- `shuffle`: 표준 Fisher-Yates(끝에서부터 `j = random(0..i)` 스왑). 통계적
  편향 없음 — 여러 차례 몬테카를로(2만 회)로 재검증됨.
- `dealCounts`: 2인=손패10/바닥8(맞고 표준), 4인=손패5/바닥8(**이 프로젝트가
  임의로 정한 값**, 공식 4인 룰이 없어서), 그 외(3인)=손패7/바닥6(표준).
- `dealNewRound` 절차:
  1. 덱 전체를 셔플.
  2. 보너스패(`type==='bonus'`)를 따로 빼둔다 — 초기 바닥에 놓이면 월이
     없어 아무도 못 가져가는 죽은 패가 되기 때문에, 바닥 몫은 **보너스패를
     제외한 카드로만** 채운다.
  3. 바닥에 `counts.floor`장 배분.
  4. 남은 카드 + 보너스패를 다시 한 번 섞어서(`restPool`) 손패/덱 풀로 사용.
  5. 각 플레이어에게 `counts.hand`장씩 순서대로 배분, 나머지가 `deck`.
  6. **재분배 조건**: 바닥에 같은 월 4장이 몰리거나(`floorHasQuad`), 누군가의
     손패에 같은 월 4장 또는 광 5장(총통, `handHasTotong`)이 있으면 처음부터
     다시 섞는다. 최대 20회 시도 후엔 그냥 진행(극히 드문 안전장치).
  7. **보너스패 몰빵 방지 로직은 없다** — 과거에 "보너스패 2장이 같은 사람
     손패에 몰리면 재추첨"하는 조건을 추가했었지만, 사용자가 편향이 없음을
     확인한 뒤 자연 발생 상태로 되돌려달라고 요청해서 제거됨. 지금은 순수
     Fisher-Yates 결과 그대로(3인 기준 몰빵 빈도 약 6.8%, 이론치와 일치).
  8. `floor`의 각 카드에 `placedBy:'deck', stuck:false`를 붙여서 반환.

### 5.2 `playTurn(state, playerId, handCardId, chosenFloorId)` — 한 턴의 전체 로직

이 함수가 게임의 핵심이다. 입력은 "이 손패 카드를 낸다"이고, 그 뒤 덱 뒤집기까지
포함해서 한 턴을 통째로 처리한다. **손패 매치(`match1`)에서 나온 결과값에
따라 분기가 완전히 다르다**:

- **`match1.count === 0`**(짝 없음): 손패에서 빼서 그냥 바닥에
  `placedBy: playerId, stuck: false`로 놓는다. 나중에 "쪽" 판정의 전제 조건이 됨.
- **`match1.count === 1`**: 그 바닥 카드를 `reservedFloorCard`로 **보류**만
  해두고(아직 안 가져감) 손패에서만 뺀다 — 왜 즉시 안 가져가냐면, 덱을
  뒤집었을 때 같은 월이 또 나오면 "뻑"이 성립해야 하기 때문(그러면 3장 다
  바닥에 남아야 함). 확정은 이 함수 뒤쪽에서 덱 뒤집기 결과를 본 뒤에 한다.
- **`match1.count === 2`**: `chosenFloorId`가 없으면 `throw {code:'NEED_CHOICE', matches}`
  로 **즉시 중단**하고 클라이언트에게 "둘 중 골라라"를 요청한다(서버 상태에
  남기지 않음 — 클라이언트가 `chosenFloorId`를 채워서 **같은 소켓 이벤트를
  다시** 보내야 함). 있으면 그 카드로 확정 캡처, `reason:'normal'`.
- **`match1.count >= 3`**(뻑 더미 위에 4번째 카드, "뻑 해소"): 바닥의 그
  월 카드 전부(3장) + 손패 카드까지 즉시 전부 캡처, `events.push('ppeok_resolved')`.

그 다음 **덱 뒤집기**(`drawFlipSkippingBonus` — 보너스패가 연속으로 나오면
자동으로 자기 창고에 넣고 계속 다음 장을 뒤집음, 4.8절 폭탄과 달리 이건
`finalizeCaptures`를 거침):

- **덱이 비어서 못 뒤집었는데 `reservedFloorCard`가 있으면**: 보류했던
  1:1 매치를 그냥 확정(뻑이 될 기회 자체가 없으므로).
- **뒤집은 카드의 월이 `reservedFloorCard`와 같으면**: **뻑 성립**. 3장(보류
  카드+손패 카드+뒤집은 카드) 모두 `stuck:true`로 바닥에 도로 쌓는다(아무도
  못 가져감), `events.push('ppeok_formed')`.
- **아니면**: `reservedFloorCard`가 있었으면 이제 확정 캡처하고,
  뒤집은 카드로 바닥과 다시 매치(`match2`)를 본다:
  - `match2.count === 0`: 그냥 바닥에 놓음.
  - `match2.count === 1`: 캡처. **"쪽" 판정 조건**: `match1.count === 0` (손패
    낼 때 짝이 없어서 그냥 버렸음) **그리고** `only.placedBy === playerId`
    **그리고** `only.id === handCardId`(즉 방금 자기가 낸 그 카드 자체와
    지금 매치됨) — 이 세 조건이 다 맞아야 `jjok`. 아니고 **따닥 조건**(`sameMonthAsStep1`:
    `step1Captured && step1Month === flippedCard.month`, 즉 손패 단계에서
    이미 같은 월로 캡처가 있었는데 덱에서도 또 같은 월이 나옴)이면 `ttadak`.
    **주의**: 서로 다른 월의 캡처 두 건이 한 턴에 우연히 겹친 경우는 따닥이
    아니다(월이 정확히 같아야 함) — 예전에 이 비교가 없어서 오탐이 났던 적이 있음.
  - `match2.count === 2`: **비동기 대기 진입**. `state.pendingChoice2`에
    `{playerId, flippedCard, matches, captured, events, step1Captured, step1Month}`를
    저장하고 `throw {code:'NEED_CHOICE2', matches, flippedCardId}` — 이번엔
    클라이언트가 나중에 별도 이벤트(`game:resolveChoice2`)로 응답할 때까지
    **서버 상태로 남는다**(4.4절 `pendingChoice2` 참고). 이 사이 다른 모든
    행동은 `assertActionAllowed`가 거부한다.
  - `match2.count >= 3`: 뻑 해소(바닥의 그 월 전부 + 뒤집은 카드 캡처),
    `sameMonthAsStep1`이면 따닥도 같이 붙는다.

마지막으로 `finalizeCaptures`가 실제로 카드들을 창고에 넣고(`addToCaptured`),
피 보너스를 계산한다: `jjok`/`ppeok_formed`/`ppeok_resolved` 각각 1장씩
(중복 없이, 이 셋은 같은 호출 안에서 서로 배타적), 그리고 **캡처 후 바닥이
완전히 비면**(`floorEmpty && captured.length > 0`) `sweep`(싹쓸이) 1장을
추가로. 합산된 `piBonusCount`만큼 **상대 전원에게서** 피를 받아온다(3인
이상이면 상대 각각에게서 받으므로 총 획득량은 `piBonusCount × (인원-1)`).

### 5.3 `resolveChoice2(state, playerId, chosenId)`

`pendingChoice2`에 저장해둔 컨텍스트를 그대로 이어받아 확정 캡처하고,
`pending.step1Month === pending.flippedCard.month`면 따닥도 추가한 뒤
`finalizeCaptures`를 호출. `pendingChoice2 = null`로 정리.

### 5.4 `skipDeckFlip(state, playerId)`

폭탄 이후 "손패 없이 덱만 뒤집는" 턴 전용. `playTurn`과 거의 같은 뒤집기
로직이지만 손패가 없으니 뻑/따닥/쪽이 애초에 발생하지 않는다(뻑은 `reservedFloorCard`가
없어서 원천적으로 불가능, 쪽도 마찬가지).

### 5.5 `playBonusFromHand` / `toggleFlexCard`

- 보너스패를 손패에서 내면: 즉시 쌍피로 창고行(`addToCaptured`), 상대
  전원에게서 피 1장씩(`takePiFromPlayer`), 덱에서 1장을 **손패로**
  드로우. **턴은 끝나지 않는다** — `room.js`의 `playBonusCard`가 이후
  `advanceTurn()`을 호출하지 않고, 손패가 남아있으면 `{status: 'continue-same-player'}`
  를 리턴해서 같은 사람이 이어서 정식으로 `game:playCard`를 한 번 더
  보내게 한다(뻑/따닥/쪽/싹쓸이 판정 전부 포함해서). 덱이 말라 드로우를
  못 했고 그 결과 손패가 0장이 되면, 예외적으로 그 자리에서 `afterAction`을
  호출해 정상적으로 턴을 마무리한다(안 그러면 낼 카드가 없는 사람 차례에서
  영구히 멈춤).
- `toggleFlexCard`: 9월 국화 카드(`flexCard:true`)를 자기 창고 안에서
  열끗↔쌍피로 전환. `player.captured.yeolkkeut`에 있으면 꺼내서 `type:'pi', piValue:2`로
  바꿔 `pi` 배열에 넣고, 반대로 `pi`에 있으면 `type:'yeolkkeut'`로 바꾸고
  `piValue` 필드를 `delete`. **자기 차례가 아니어도, 라운드가 끝난
  뒤에도 언제든 가능**(정산은 이미 `lastResult`에 스냅샷으로 고정돼 있어서
  종료 후 토글은 화면 표시에만 영향, 실제 정산액은 안 바뀜 — 의도된 동작).

### 5.6 `playBomb` / `declareShake`

- `playBomb(state, playerId, month)`: 손에 그 월 카드가 **정확히 3장**,
  바닥에 그 월 카드가 **정확히 1장**이어야 함(아니면 에러). 3+1=4장을
  전부 캡처하고, 상대 전원에게서 피 1장씩 직접 받아온다(`finalizeCaptures`를
  안 거침 — 뻑/따닥/쪽 판정 자체가 없음). `player.bombCount += 1`(정산 배율용),
  `player.skipNextHandPlay += 1`(다음 턴은 손패 못 내고 덱만 뒤집게 만듦).
- `declareShake(state, playerId, month)`: 손에 그 월 카드가 정확히 3장
  있어야 하고, 이미 그 월을 흔든 적 있으면 에러(같은 월 중복 흔들기 금지).
  `player.shakes.push(month)`만 하고 카드 이동은 없음(순전히 배율 표시용
  — 실제로 승리 시 이 배열의 길이가 `shakeBombMult` 지수에 들어감).
  **콩알탄(2장 흔들기)은 지원 안 함** — 항상 정확히 3장.

### 5.7 `computeScore(player)` — 정확한 점수 공식

```
gwangScore:
  5장 이상 -> 15
  4장      -> 4
  3장      -> 비광 포함이면 2, 아니면 3
  (그 이하 -> 0)

ttiScore:
  기본 = (5장 이상이면 1 + (장수-5), 아니면 0)
  + hasColor('hong')?3:0 + hasColor('cho')?3:0 + hasColor('cheong')?3:0
  hasColor(color) := ribbonColor===color인 카드가 3장 이상
  (12월 비띠는 ribbonColor:null이라 hasColor에서 자연히 제외되지만,
   장수 집계(t.length)에는 포함된다 — t는 필터링 없는 전체 배열)

yeolkkeutScore:
  기본 = (5장 이상이면 1 + (장수-5), 아니면 0)
  + 고도리(2,4,8월 열끗 카드 3장 전부 보유)면 5

piScore:
  piValue 합계 = 10 이상이면 1 + (합계-10), 아니면 0
```

`total = gwangScore + ttiScore + yeolkkeutScore + piScore`. `detail` 객체에
`gwangCount/ttiCount/yeolkkeutCount/piValue/hongdan/chodan/cheongdan/godori`
불리언들도 같이 반환 — 결과 화면 breakdown과 독박 판정(5.8)에 재사용됨.

### 5.8 `computeSettlement(state, winnerId, goCount)`

4.6절에 이미 상세 서술. 추가로: `findDokbakTarget(winnerId, comboCards)`는
`comboCards.map(c => c.placedBy)`에서 winnerId와 `'deck'`을 제외한
**유일한(Set 크기 1) 상대**가 나올 때만 그 사람을 반환하고, 둘 이상
섞여 있으면 `null`(독박 미적용) — 이게 7장에서 말하는 "단순화"다.

### 5.9 `scoreThreshold` / `goMultiplierInfo`

- `scoreThreshold(playerCount)`: 2인이면 7, 그 외(3~4인)면 3.
- `goMultiplierInfo`: 4.6절 참고.

---

## 6. room.js — 상태 전이와 소켓 핸들러가 호출하는 공개 메서드

### 6.1 phase 상태 기계

```
(대기방, round=null)
   └─ startRound() ─────────────────────────┐
                                             ▼
                                    phase:'playing' ─────┐
                                             │            │ 문턱 점수 달성
                    (매 턴 playCard/         │            ▼
                     playBomb/declareShake/  │   phase:'await-gostop'
                     resolveChoice2 반복)     │   (pendingGoStop 세팅)
                                             │            │
                    나가리(패 소진)◀──────────┘    go ─────┤──── stop
                         │                          │      │
                         ▼                          ▼      ▼
                  phase:'round-end'  ◀── (playing 복귀) phase:'round-end'
                  (finishAsNagari)                      (finishRound)

언제든(위 어느 phase에서도): 호스트의 forceEndRound() -> phase:'round-end'(forced)
```

`round-end`에서 호스트가 `startRound()`(=`game:nextRound`)를 다시 부르면
새 라운드가 시작된다. **`startRound()`는 `this.round && this.round.phase !== 'round-end'`
면 예외를 던진다** — 즉 진행 중인 판 위에 새 판을 덮어씌우는 걸 막는 유일한
가드다(이게 없어서 중복 시작 버그가 났던 전례 있음, 12장 참고).

### 6.2 `assertActionAllowed(playerId)` — 모든 "내 차례 행동"의 공통 관문

`playCard`/`playBonusCard`(스킵 턴 체크는 별도)/`playBomb`/`declareShake`가
전부 이 순서로 호출: (1) `round`가 없으면 거부, (2) `currentActorId() !== playerId`면
"당신의 차례가 아닙니다", (3) `phase !== 'playing'`이면 "지금은 그 행동을
할 수 없습니다", (4) `pendingChoice2`가 있으면 "덱에서 뒤집힌 카드의 짝을
먼저 선택해주세요". **`resolveChoice2`만 이 공통 검사를 안 거치고 별도로
`phase==='round-end'`만 직접 체크한다** — 의도적으로 다른 로직이라
그런 것이지 실수가 아니다(단, 예전엔 그 별도 체크조차 없어서 버그였음).

### 6.3 `afterAction(playerId, result)` — 카드를 낸 뒤 공통 후처리

1. `computeScore`로 현재 점수 계산.
2. `eligible = score.total >= threshold && (!hasCalledGo || score.total > scoreAtLastGo)`
   — 문턱을 넘겼고, 아직 고를 한 번도 안 불렀거나 이미 불렀다면 그 이후로
   점수가 더 올랐어야 다시 고/스톱을 물어봄.
3. 라운드가 끝날 조건(`isRoundOver()`: 모든 사람이 손패 0장이고
   `skipNextHandPlay`도 0)이고 `!eligible`이면 나가리.
4. `eligible`이면 `phase='await-gostop'`으로 전환하고 대기.
5. 그것도 아니고 라운드가 끝났으면 나가리, 아니면 `advanceTurn()`으로 다음
   사람 차례(더 진행할 사람이 없으면 나가리).

### 6.4 `advanceTurn()` / `isRoundOver()`

`advanceTurn`은 `turnOrder`를 한 바퀴 돌면서 **손패가 있거나 `skipNextHandPlay > 0`인**
다음 사람을 찾는다(둘 다 0인 사람은 건너뜀 — 이미 낼 게 없으니). 아무도
없으면 `null` 반환(호출부가 나가리 처리). `isRoundOver`도 동일하게
`skipNextHandPlay`를 같이 봐야 한다 — 손패가 0장이어도 스킵 턴 빚이 남아있으면
아직 끝난 게 아니다(빼먹으면 폭탄으로 손패를 다 쓴 사람의 마지막 "덱만
뒤집기" 턴이 통째로 사라지는 버그가 났던 전례 있음).

### 6.5 `goStopDecision(playerId, 'go'|'stop')`

`'stop'`이면 바로 `finishRound(playerId, rp.goCount)`. `'go'`면: 점수를
**다시 계산**(스냅샷이 아니라 지금 시점 — 9월 국화 전환으로 대기 중 점수가
바뀌었을 수 있으므로), `goCount += 1`, `hasCalledGo = true`,
`scoreAtLastGo = score.total`, `firstGoCallerId`를 아직 안 정해졌으면
채움, `phase` 다시 `'playing'`, `pendingGoStop = null`, 라운드가 안
끝났으면 다음 턴으로.

### 6.6 공개 메서드 목록 (소켓 핸들러가 호출하는 것들)

`addPlayer` · `reconnectPlayer` · `removePlayer` · `setPointValue` ·
`startRound` · `currentActorId` · `advanceTurn` · `isRoundOver` ·
`assertActionAllowed` · `playCard(playerId, cardId, chosenFloorId)` ·
`playBonusCard(playerId, cardId)` · `toggleFlex(playerId, cardId)` ·
`playBomb(playerId, month)` · `declareShake(playerId, month)` ·
`goStopDecision(playerId, decision)` · `resolveChoice2(playerId, chosenId)` ·
`finishRound` · `finishAsNagari` · `forceEndRound` · `publicState(forPlayerId)`

---

## 7. index.js — 소켓 프로토콜 상세

모든 이벤트는 `(payload, callback)` 형태이고 콜백은 `{ok: true, ...}` 또는
`{ok: false, error: string}`(추가로 `needChoice`/`needChoice2` 플래그가 붙는
경우가 있음). 서버는 매 액션 성공 후 `broadcast(room)`으로 방에 있는
**연결된** 모든 플레이어에게 `room:state`(각자 `publicState(playerId)`,
즉 손패가 사람마다 다름)를 개별 전송한다.

| 이벤트 | payload | 성공 콜백 | 실패/특수 콜백 |
|---|---|---|---|
| `room:create` | `{name}` | `{ok:true, roomCode, playerId}` | `{ok:false, error}` |
| `room:join` | `{roomCode, name}` | 위와 동일 | 방 없음/게임 중/정원 초과 시 error |
| `room:rejoin` | `{roomCode, playerId}` | 위와 동일 | 실패 시 클라이언트가 localStorage 정리해야 함(8.6) |
| `room:leave` | `{}` | `{ok:true}` | 라운드 시작 후면 error(`removePlayer` 가드) |
| `room:destroy` | `{}` | `{ok:true}` | 호스트 아니면 error. 성공 시 방 전체에 `room:destroyed` 브로드캐스트 후 `rooms`에서 삭제 |
| `game:start` / `game:nextRound` | `{}` | `{ok:true}` | 호스트 아니면 error. 내부적으로 둘 다 `startRound()` 호출(사실상 동일 핸들러) |
| `game:playCard` | `{cardId, chosenFloorId?}` | `{ok:true, result}` | `{ok:false, needChoice:true, matches}` 또는 `{ok:false, needChoice2:true, matches}`(이 경우 서버가 이미 `deck_reveal` 이벤트를 브로드캐스트해서 구경하는 다른 사람도 카드가 뒤집히는 걸 봄) 또는 일반 error |
| `game:resolveChoice2` | `{chosenId}` | `{ok:true, result}` | error |
| `game:playBonus` | `{cardId}` | `{ok:true, result}` | error |
| `game:toggleFlex` | `{cardId}` | `{ok:true}` | error |
| `game:playBomb` | `{month}` | `{ok:true, result}` | error |
| `game:declareShake` | `{month}` | `{ok:true}` | error |
| `game:goStop` | `{decision:'go'|'stop'}` | `{ok:true, result}` | error |
| `game:setPointValue` | `{value}` | `{ok:true}` | 호스트 아니면 error |
| `game:endRoundNow` | `{}` | `{ok:true, result}` | 호스트 아니면/이미 끝난 판이면 error |
| `disconnect` | (자동) | — | 낡은 소켓이면 무시(8.6 참고), 아니면 `connected=false`, 호스트였으면 다음 접속자에게 이양 |

`room:state` 브로드캐스트가 나갈 때마다 `scheduleAutoPlayIfNeeded(room)`도
호출된다(자동 진행 워치독, 아래 7.1).

### 7.1 자동 진행 워치독(`AUTO_PLAY_DELAY_MS`, 기본 30000ms, 테스트에서는 env로 단축)

`scheduleAutoPlayIfNeeded`는 현재 응답을 기다리는 사람(`waitingPlayerId`)을
계산한다: `phase==='playing'`이면 `currentActorId()`, `phase==='await-gostop'`
이면 `pendingGoStop.playerId`. 그 사람이 `connected===false`면
`AUTO_PLAY_DELAY_MS` 후 `performAutoPlay`를 예약한다. **타이머는
`room.code` 단위 하나뿐이지만, `autoPlayTargets` 맵으로 "지금 기다리는
사람이 누구인지"까지 같이 추적**해서, 대기 대상이 바뀌면(예: 강제종료 후
다음 판) 예전 타이머를 버리고 새로 건다.

`performAutoPlay`는 최소한의 안전한 행동만 대신 한다: 고/스톱 대기 중이면
무조건 `'stop'`, `pendingChoice2` 대기 중이면 첫 번째 후보로
`resolveChoice2`, 손패가 있으면 첫 번째 카드를 그냥 냄(2장 매치가 뜨면
`NEED_CHOICE`/`NEED_CHOICE2`도 첫 번째 후보로 자동 처리), 손패가 0장이면
스킵 턴(`playCard(playerId, null)`). **폭탄/흔들기 같은 "선택이 필요한
이득 행동"은 절대 대신 하지 않는다.**

---

## 8. 클라이언트(public/client.js) 상세

### 8.1 DOM 구조 (index.html)

3개 화면(`screen-lobby`/`screen-room`/`screen-game`, `goScreen(name)`으로
전환하며 나머지엔 `hidden` 클래스)과 6개 모달(`modal-choice`/`modal-gostop`/
`modal-shake`/`modal-bomb`/`modal-result`/`modal-rules`). 게임 화면 핵심
요소: `#opponents`(상대 영역들), `#floor`(바닥), `#deck-stack`+`#deck-count`,
`#turn-indicator`, `#my-score`, `#my-captured`, `#my-hand`, `#ledger-bar`,
`#log-feed`, `#event-banner`(중앙 배너), `#host-round-controls`(호스트 전용
버튼: 판당 점당금액 변경/이 판 무효처리/방 폭파). 죽은 요소: `#score-popups`
— HTML/CSS에는 있지만 client.js 어디서도 실제로 안 씀(8.9절 참고).

### 8.2 렌더링 원칙

클라이언트는 상태를 소유하지 않는다. `socket.on('room:state', state => ...)`가
매번 `renderRoom(state)`(대기방) 또는 `renderGame(state)`(게임 화면)를
그대로 다시 그린다. 점수/정산액을 클라이언트가 재계산하는 곳은 없다 —
전부 서버가 내려주는 값(`p.score`, `result.settlement`, `result.ledger`,
`result.pointValueAtSettlement`)을 그대로 표시(예전에 클라이언트가
재계산하다가 반올림 순서/점당금액 스냅샷 버그가 났던 전례 때문에 이 원칙이
굳어짐).

### 8.3 카드 이동 애니메이션 (FLIP + Web Animations API)

`captureCardRects()`/`captureHandRowRects()`가 렌더 직전에 모든 카드
요소의 현재 화면 좌표(`getBoundingClientRect`)를 `Map<cardId, DOMRect>`로
기록해둔다. 렌더 후 `animateNewCards(state, oldRects, oldHandRowRects, isNewGameEvent)`가
"새로 나타난" 카드(이전 좌표 기록에 없던 것)를 찾아 `flyCard(elm, dx, dy, style, delay)`로
Web Animations API(`element.animate`) 다단 키프레임을 재생한다:
- 덱에서 뒤집힌 카드: 45% 지점까지 제자리에서 `rotateY(180deg)->0deg`로
  다 뒤집힌 뒤, 남은 구간에서 최종 위치까지 활공(뒤집기와 이동을 시간상
  분리 — 동시에 하면 서로 뭉개져 안 보였던 전례가 있음).
- 손에서 낸 카드: 위로 살짝 떴다가 포물선을 그리며 내려앉음.
- 착지 순간(`anim.onfinish`): `slamCard(elm)`(과장된 스쿼시&스트레치,
  가로 1.28배/세로 0.72배까지 찌그러짐) + `spawnImpactRing(elm)`(충격 링
  파티클, `animationend`에 스스로 DOM에서 제거) + `cardSlap()`(효과음,
  8.5절) 트리거.
- 폭탄은 손패 3장이 `handCardIds` 배열 순서대로 각각 0/70/140ms 시차를
  두고(`fill:'both'`로 대기 구간 순간이동 방지) 날아와, 착지마다 자연스럽게
  "탁.. 탁.. 탁" 소리가 겹친다.
- 뻑 "형성" 순간엔 무더기 3장 전체(이미 바닥에 있던 카드 포함)에
  `maybeFlashFormed`가 호박색 반짝임(`formed-flash`, `captureFlash`의
  금색과 구분됨)을 붙인다.

`hasRenderedGameOnce` 가드로 최초 렌더(재접속 등으로 이미 진행 중인 판에
막 들어온 경우)에는 낡은 이벤트로 애니메이션이 오작동하지 않게 막는다.

### 8.4 소리-시각 동기화 (`handleGameEvent`의 호출 타이밍)

`renderGame()`은 `handleGameEvent`(배너+효과음+보드 흔들기)를 **직접
부르지 않는다.** 대신 "새 이벤트가 있었다"는 불리언(`isNewGameEvent`)만
반환하고, 소켓 콜백(`socket.on('room:state', ...)`)이 그 값을
`animateNewCards`에 넘겨서, 새로 날아오는 카드들의 `Animation` 객체를
`primaryAnims` 배열에 모았다가 `Promise.all(primaryAnims.map(a => a.finished))`
가 풀리는 시점(=카드가 실제로 다 착지한 시점)에 맞춰서만 `handleGameEvent`가
재생되도록 되어 있다. (이렇게 재구성하기 전엔 배너/효과음이 항상 카드보다
먼저 터져 "따로 노는" 느낌이 났었음 — 12장 참고. 단, 이 최종 실측 검증은
Playwright로 아직 다 못했음 — 11장 백로그 최우선 항목.)

### 8.5 사운드 시스템

`ensureAudio()`가 최초 사용자 상호작용 시 오디오 컨텍스트를 준비(브라우저
자동재생 정책 대응). `beep(freq, duration, opts)`는 `OscillatorNode`로
합성음을 직접 생성. `playSfx(file, opts)`는 `Audio` 객체를 캐시해두고
`cloneNode()`로 겹쳐 재생(같은 소리가 짧은 간격으로 여러 번 나도 안 끊김).
`cardSlap(delay)`는 실제 녹음 스냅(`card-snap.mp3`) 위에 고음 트랜지언트
(1600Hz 사각파 20ms) + 저음 서브베이스(115Hz + 55Hz 사인파)를 겹친 합성
"찰진" 타격음 — `flyCard`의 `anim.onfinish`가 카드마다 직접 호출(착지
타이밍과 정확히 일치시키기 위해). `SOUND` 맵(이벤트별 "구분 효과음", 착지음
위에 얹히는 보조 사운드)과 `EVENT_LABEL`/`EVENT_SOUND` 매핑:

| kind | 배너 텍스트 | 효과음(SOUND 키) |
|---|---|---|
| `place` | (없음) | `card-drop.mp3`(은은한 드롭음) |
| `capture` | (없음) | `capture-check.mp3` + `match-success.mp3` |
| `jjok` | 쪽! | `ui-click.mp3` + `match-success.mp3` |
| `ppeok_formed` | 뻑! | `ppeok.mp3` |
| `ppeok_resolved` | 뻑 해소! | `ppeok-resolved.mp3` + `match-success.mp3` |
| `ttadak` | 따닥! | `ttadak.mp3` + `match-success.mp3` |
| `sweep` | 싹쓸이!! | `sweep.mp3` (+ `shakeBoard()`) |
| `bomb` | 폭탄!! | 80Hz 저음 강조만(착지음은 handCardIds가 이미 냄) (+ `shakeBoard()`) |
| `shake` | 흔들기! | `cardSlap()` 수동 3연타(0/90/180ms, 착지 카드가 없어서 예외) |
| `go` | 고! | `go.mp3` |
| `win` | 승리! | `win.mp3` |
| `bonus_hand` | 보너스! (피 획득 + 한 장 더) | `bonus-reveal.mp3` |
| `bonus_deck` | 보너스 카드 획득! | `bonus-reveal.mp3` |

전역 `click` 리스너가 모든 `<button>` 클릭에 `ui-click.mp3`(볼륨 0.3)를
추가로 재생(게임 이벤트 효과음과 별개). 효과음 켜기/끄기는
`localStorage`에 브라우저별로 저장(`updateMuteButton`).

### 8.6 재접속 / localStorage

`localStorage['gostop']`에 `{roomCode, playerId}` 저장. 소켓 `'connect'`
이벤트마다 `tryRejoin()`이 자동으로 `room:rejoin`을 시도. **실패하면
(`res.ok===false`) 그 localStorage 항목을 지운다** — 방이 이미 사라졌다는
확정 신호이므로(안 지우면 와이파이 재연결마다 조용히 재시도만 계속함).
`room:leave` 성공/`room:destroyed` 수신 시에도 동일하게 지움.

### 8.7 접근성

카드: `cardEl()`에서 `onClick`이 있으면 `role="button"` + `tabIndex=0` +
Enter/Space 키 핸들러(한 곳만 고치면 손패/바닥/모달 카드 전부에 자동
적용) + `aria-label`(`cardAriaLabel`, 예: "송학(광)", "1월 피"). 모달:
`showModal`/`hideModal` 헬퍼가 6개 모달 전부에 `role="dialog"` +
`aria-modal="true"` + `aria-labelledby` + 포커스 트랩(Tab이 모달 밖으로
안 새게 순환) + 포커스 복원(닫을 때 열기 전 포커스로 되돌림). Escape는
취소 가능한 모달(`rules`/`shake`/`bomb`)만 닫음 — `choice`/`gostop`/`result`는
강제 응답이라 Escape로 안 닫힘. `prefers-reduced-motion: reduce`: 장식용
keyframe(`pop`/`slam`/`capture-flash`/`formed-flash`/`board.shake`/
`event-banner` 팝업/`deck-stack.flipping`)은 `animation: none !important`로
꺼짐 — 단, 콜백이 반드시 필요한 FLIP 트랜지션 자체(카드 이동)는 절대 안
건드림(강제로 끄면 카드가 z-index 30에 낀 채 멈추는 등 더 심각한 문제).
`spawnImpactRing`도 호출부에서 `prefersReducedMotion()`을 직접 체크해서
아예 안 만듦(CSS로 끄면 `animationend`가 안 불려 DOM에 남을 수 있어서).
터치 기기: `:hover` 규칙 전부 `@media (hover: hover) and (pointer: fine)`
안에 있어서(데스크톱만 적용), 탭 이후 hover가 눌어붙지 않음.

### 8.8 폭탄/흔들기 모달, 결과 화면

`openMonthModal`이 해당 월의 손패 카드(광/열끗/띠/피 우선순위로 대표
카드 하나) 실사 이미지를 버튼으로 보여줌(텍스트 "5월" 같은 예전 방식
아님). `renderResult`는 광/띠(홍단·초단·청단)/열끗(고도리)/피 각각 몇 장
몇 점인지 breakdown, 각 패자의 남은 패(광/피 장수)+배율(x2,x4...)+박
사유(광박/피박/고박/독박, 괄호 설명 포함), 승자 총 획득 금액까지 표시.
금액 계산은 반드시 **서버가 준 `pay.amount`를 패자별로 각각 반올림한 뒤
합산**(8.2절 원칙과 동일 이유).

### 8.9 알려진 죽은 코드

`#score-popups`(HTML)와 `.score-popup`+`floatUp` keyframe(CSS)은 어디서도
실제로 생성/사용되지 않는다 — 당장 문제는 없지만("아무 일도 안 함") 나중에
"먹은 점수 팝업" 기능을 붙이거나, 안 쓸 거면 정리하는 게 좋은 후보(11장
백로그 최하단).

---

## 9. 확정 하우스 룰 요약 (전체 근거는 `gostop_rules.md`)

- 2~4인 지원. 승리 점수: 3인 이상 3점 / 2인(맞고) 7점.
- 화투 48장 + 보너스패 2장 = 총 50장.
- 쌍피 구성: **9월 피 1장(국화 열끗은 쌍피 아님) + 11월 쌍피 1장 + 12월
  쌍피 1장**(고정). 9월 국화는 자기 창고에서 언제든 열끗↔쌍피 전환 가능.
- 12월 4번째 카드("비띠")는 **색깔 조합(홍단/청단/초단) 미포함, "띠 5장
  이상" 개수 조합엔 포함**.
- 자뻑 피 = 일반뻑과 동일 1장씩, 따닥 피 0장, 쪽/싹쓸이 각 1장.
- 흔들기는 3장짜리만(콩알탄 없음), 흔들기·폭탄 배율은 지수로 합쳐서 곱
  (`2^(흔든횟수+폭탄횟수)`).
- 고 배율: 1고 +1점(배율 없음), 2고부터 `2^(고횟수-1)`배.
- 비3광 2점 인정(3점 미만이라 자연히 즉시 스톱 불가) / 초단은 4·5·7월만
  (12월 미포함, "비단" 변형 미사용) / 멍박·쓰리뻑·총통(즉시승리형) 미사용.
- 나가리는 배율 없이 그냥 재시작. 총통(초기 手패 몰림)은 무효 처리 후 재분배.
- 고박은 **이 판에서 처음 고를 선언한 사람 단 한 명**에게만(2인엔 고박
  없음). 독박은 **아무도 고를 안 부른 판에서만** 성립.
- 점당 금액은 게임 중 언제든(대기방/게임 화면 모두) 변경 가능하나, 결과
  화면은 **정산 당시 스냅샷**(`pointValueAtSettlement`)으로 표시.
- 매 판 선(先): **그 방의 첫 판만 무작위**, 이후 매 판 좌석 순서로 한 칸씩
  회전(방장이 계속 먼저 하지 않음).
- 보너스패 2장은 셔플 결과 그대로 자연 발생(재추첨 없음 — 최종 결정).
- 바닥에 같은 월 카드 2장(손패 내기든 덱 뒤집기든) 매치되면 플레이어가
  직접 선택.

---

## 10. 지금까지 구현된 기능 (완전판)

**핵심 게임**: 서버 권위 멀티플레이(2~4인), 방 생성/참가/재접속(localStorage
자동)/나가기/폭파, 호스트 이탈 시 자동 이양, 접속 끊긴 플레이어 자동 진행
(30초 워치독), 초대 링크 복사, 점당 금액 실시간 변경(대기방+게임 화면 둘
다), 호스트의 "이 판 무효 처리"/"방 폭파" 분리된 두 버튼, 대기방 최대
4명/최소 2명 가드, 게임 시작 후 참가·퇴장 차단.

**연출**: FLIP+WAAPI 카드 이동 애니메이션(덱 뒤집기 3D 플립, 손패 포물선
착지), 착지 스쿼시&스트레치+임팩트 링, 소리-시각 정밀 동기화(카드 착지
`Animation.finished` 시점에 맞춰 배너/효과음), 실녹음+합성음 레이어드
사운드(13개 mp3 + 다중 합성 beep), 뻑/따닥/쪽/싹쓸이/폭탄/흔들기/고/승리/
보너스별 배너+전용 효과음, 폭탄/싹쓸이 시 보드 흔들림, 상대 손패(뒷면
장수만)/먹은패(실제 그림, 광·열끗·띠·피 줄 정렬, 피는 부채꼴 겹침+합계
표시)까지 실제 카드로 렌더, 화투 48장 전체 실사(CC BY-SA 4.0).

**접근성**: 카드 키보드 조작(role=button+tabIndex+Enter/Space+aria-label),
모달 6개 전부 포커스 트랩/ESC(조건부)/role=dialog/포커스 복원,
prefers-reduced-motion 대응(FLIP 트랜지션 자체는 예외), 터치 기기 :hover
눌어붙음 방지(`hover:hover and pointer:fine`).

**UX**: 초심자용 규칙 가이드 모달(대기방+게임 화면 양쪽 진입점), 결과
화면 상세 breakdown(족보별 점수+박 사유+배율+남은 패), 효과음 토글
(localStorage 저장), 엔터키 제출(이름/방코드/점당금액 입력), 방 코드
입력 자동 정리(공백 제거+대문자화, paste 이벤트도 처리), 모바일 반응형
(375px 기준 점검, `.board-info` 줄바꿈 수정 포함).

**보안/견고성**: 플레이어 이름 XSS 방지(`escapeHtml`, innerHTML 사용처
전수 점검 완료), 모든 액션의 phase 가드 통일(`assertActionAllowed`), 소켓
이벤트 도착 순서 뒤바뀜 방어(재접속 후 낡은 disconnect 무시), 대기방 빈
방 자동 정리(rooms Map 누수 방지), 서버 쪽 방어적 trim(`cleanRoomCode`/
`cleanName`, 클라이언트 우회 대비), 호스트 전용 액션 권한 체크 전부 통일
패턴.

---

## 11. 알려진 단순화 사항 / 제약 (의도된 것, "버그"로 다시 보고하지 말 것)

- **독박 판정 단순화**: 정식 규칙은 "족보를 완성시켜 준 마지막 한 장"까지
  정확히 추적해야 하지만, `findDokbakTarget`은 "완성된 족보에 들어간
  카드들을 상대방 중 누가 바닥에 냈었는지"만 보고 그 상대가 단 한 명으로
  특정될 때만 독박을 적용한다(여러 명이 걸쳐 있으면 미적용).
- **4인 배분(손패5/바닥8)**: 공식 4인 룰이 없어 이 프로젝트가 임의로 정한
  값(주석에 명시, 실전 소켓 플레이로 검증됨).
- **WebSearch가 이 조직(EMIL)에는 비활성화**(`PROXY_REJECTED`/HTTP 403) —
  외부 리서치가 필요한 작업은 이걸 감안하고 대안(기존 라이브러리
  재구성 등)으로 진행.
- `#score-popups` 죽은 마커(8.9절), `round.phase`의 `'await-choice'`/
  `pendingChoice`(단수) 죽은 필드(4.8절) — 둘 다 당장 문제는 없음.

---

## 12. 전체 버그 수정 이력 (요약 표, 발생 순 — 상세 diff/검증법은 improvement_log.md)

| # | 버그 | 근본 원인 요약 |
|---|---|---|
| 1 | 따닥 오탐 | 서로 다른 월의 캡처 두 건을 따닥으로 오판(월 비교 누락) |
| 2 | 독박/2인 고박 오판정 | 규칙 문서와 어긋난 초기 구현 |
| 3 | 재접속 시 낡은 애니메이션 재생 | `hasRenderedGameOnce` 가드 부재 |
| 4 | 폭탄으로 손패 전부 소진 시 라운드 조기 종료 | `isRoundOver`가 skipNextHandPlay 안 봄 |
| 5 | await-gostop 중 행동 허용 누락 | phase 가드 부재 |
| 6 | scoreAtLastGo 스냅샷 오류 | 프롬프트 시점 스냅샷을 씀(전환 가능한 9월 카드 때문에 최신값 필요) |
| 7 | 플레이어 이름 저장형 XSS | innerHTML 직접 삽입 |
| 8 | 재연결 시 새 socket.id 미반영 | reconnectPlayer 누락 |
| 9 | setPointValue 호스트 권한 누락 | 권한 체크 부재 |
| 10 | NEED_CHOICE2 중계 시 덱 애니메이션 미재생 | deck_reveal 이벤트 부재 |
| 11 | 라운드 시작 후 새 참가자 join 시 클라이언트 크래시 | 관전 미지원인데 참가를 안 막음 → `addPlayer`에 `if(this.round) throw` 추가 |
| 12 | 덱 뒤집기 애니메이션이 `.pop`과 transform 충돌로 안 보임 | CSS animation이 인라인 transform보다 우선 |
| 13 | 방 코드 붙여넣기 시 maxlength가 공백까지 세서 코드 잘림 | maxlength 5→16 + trim/uppercase 핸들러 |
| 14 | 폭탄으로 손패 "일부만" 비어도 스킵 버튼 안 뜸 | 스킵 버튼 조건이 `myHand.length===0`만 봄 |
| 15 | `startRound()` 중복 호출로 진행 중인 판이 덮어씌워짐 | phase 가드 부재 |
| 16 | 자동 진행 타이머가 대상 안 가리고 방 단위로만 걸림 | `autoPlayTargets` 맵 추가로 해결 |
| 17 | `resolveChoice2`에 phase 검사 없어 끝난 판에 뒤늦은 선택 반영됨 | 형제 메서드(playCard 등)와 검사 불일치 |
| 18 | `this.round` null 역참조로 날것 에러 노출 | 여러 공개 메서드에 가드 추가 |
| 19 | `forceEndRound()` 오타("진행중인")+메시지 뭉뚱그림 | 문구 통일 |
| 20 | 스톱 승리 시 결과+고스톱 모달 동시 표시 | `'stop'` 분기가 `pendingGoStop` 안 지움 |
| 21 | 결과 화면 "총 획득" 반올림 순서 오류 | 클라이언트가 합산 후 반올림(서버는 개별 반올림 후 합산) |
| 22 | prefers-reduced-motion 미대응 | 장식용 keyframe 전부 무조건 재생 |
| 23 | 뻑 "형성" 순간 피 미지급 | `piBonusCount` 집계에 `ppeok_formed` 누락 |
| 24 | 결과 화면이 "현재" 점당 금액으로 재계산 | `pointValueAtSettlement` 스냅샷 부재 |
| 25 | 재접속 후 낡은 소켓 disconnect가 재접속자를 다시 끊김 표시 | disconnect 핸들러가 `p.socketId===socket.id` 확인 안 함 |
| 26 | 터치 기기 :hover 눌어붙음 | 조건 없는 `:hover` 규칙 |
| 27 | NEED_CHOICE2 대기자 접속 끊김 시 자동진행 워치독 미작동(게임 영구정지) | `scheduleAutoPlayIfNeeded`가 `!pendingChoice2` 조건으로 배제하고 있었음 |
| 28 | `room:rejoin` 실패 시 localStorage 낡은 정보 미삭제 | 형제 경로(room:leave/destroyed)만 지우고 있었음 |
| 29 | 대기방 빈 방이 rooms Map에 영구 잔류 | `room:leave`가 `rooms.delete` 안 함(room:destroy만 함) |
| 30 | 3인 이상 고박이 여러 명에게 겹쳐 적용 | `goCount>0` 전원이 아니라 "처음 고를 부른 사람"만이어야 함 → `firstGoCallerId` 도입 |
| 31 | 폭탄 손패 3장 이동 애니메이션 누락 | 이벤트 payload에 `handCardIds` 필드 자체가 없었음 |
| 32 | 9월에 쌍피가 2장 동시 존재 가능 | `9-pi-b`가 고정 쌍피로 잘못 설정(국화 플렉스카드와 별개로) → 일반 피로 정정 |
| 33 | 11월 쌍피가 실제 카드 이미지와 다른 카드에 배정 | phash+MSE 이미지 대조로 `11-pi-a`가 진짜 쌍피임을 확인, 배정 교체 |
| 34 | 매 판 방장이 항상 선(先) | `turnOrder`가 항상 `this.players` 순서 그대로 → `nextDealerIndex` 회전 도입 |
| 35 | 12월 비띠가 색깔 조합뿐 아니라 개수 집계에서도 제외 | `scored:false` 필드가 두 가지 의미를 동시에 표현 → 필드 제거 |
| 36 | (되돌림) 보너스패 몰빵 방지 조건부 재추첨 제거 | 사용자가 편향 없음을 확인 후 자연 발생으로 복귀 요청 |

**지금까지 반복적으로 나타난 버그 패턴 5가지** (새 코드를 고칠 때마다 대조할 것):

1. 형제 메서드/상태/분기 중 하나만 어떤 처리가 빠져 있음(#5, #17, #27, #31).
2. 형제 경로 중 하나만 마무리 정리(cleanup)를 빼먹음(#20, #28, #29).
3. 클라이언트는 UI로 막아뒀지만 서버가 그 불변식을 스스로 보장하지 않음(#9).
4. 비동기 이벤트 두 개의 도착 순서가 뒤바뀔 수 있는데 나중 이벤트가 무조건
   최신 상태를 덮어씀(#25).
5. 필드 하나가 서로 다른 두 가지 의미를 동시에 표현하다가 둘 다 적용됨(#35).

**이미 검토했지만 "버그 아님"으로 결론 낸 것들** (또 조사하지 말 것 — 전체
근거는 `improvement_log.md` 맨 아래):

고 배율 공식 / 피 뺏어오기 낮은 가치 우선(하우스룰) / 4인 배분 수치(의도됨)
/ 흔들기·폭탄 배율의 결과 화면 반영 / 카드·효과음 에셋 매핑 전체 / 9월
국화 토글을 라운드 종료 후에도 허용(정산은 이미 스냅샷) / "방을 찾을 수
없습니다" vs "존재하지 않는 방입니다"(의도된 구분) / room:rejoin이 playerId
소유권 미검증(캐주얼 게임 설계 트레이드오프) / 광박·피박·독박 조건이 문서와
일치 / FLIP 애니메이션 가드/once 처리 / OS 다크모드 미대응(고정 테마
의도) / 따닥 0피·쪽+싹쓸이 중첩(문서 일치) / ledger-bar 표시(서버값
그대로) / room:leave에 phase 검사 없음(removePlayer 자체가 이미 막음) /
client.js 터치 핸들러 없이 click 기반(모던 브라우저 클릭 합성으로 문제
없음) / room:destroy의 socketMeta 정리·disconnect 중 경합(안전 확인됨) /
engine.js/room.js에 비동기 코드 없음(동시성 문제 구조적으로 없음) / 4인
경계 케이스(addPlayer/startRound 가드로 안전) / `:active` 규칙(터치에서
자연 해제되므로 안전) / innerHTML 사용처 전수(전부 escapeHtml/textContent) /
socket.io-client 재연결 기본값과 AUTO_PLAY_DELAY_MS 간 불일치 없음 / 셔플
편향 없음(Fisher-Yates 확인).

**정정된 과거 결론 2건** (한때 "버그 아님"으로 잘못 결론지었다가 사용자
지적으로 뒤집힌 사례 — 규칙 문서 문구가 모호해서 잘못 읽었던 게 원인):
9월 쌍피 2장 공존(#32), 12월 비띠 개수 집계 전체 제외(#35).

---

## 13. 테스트 카탈로그 (46개 전부, `npm test` 기준)

### engine.test.js (16개)

덱 구성 합계 / 광·띠 등 점수 계산 / 고 배율 공식 / 인원별 배분 장수(보너스
포함 50장) / 쪽 판정 / 뻑 판정 / **뻑 형성 순간 피 지급**(회귀) / 덱 2장
매치 NEED_CHOICE2 / 보너스패 손패에서 내기 / 보너스패 덱에서 뒤집기 /
**따닥 월 일치 검증**(회귀, 서로 다른 월 캡처 오탐 방지) / 따닥 4장 성립 /
9월 국화 전환 / **독박은 승자 고횟수가 아니라 "이 판에 고가 있었는지"로
판정**(회귀) / 2인 고박 없음 / **12월 비띠 개수 집계**(회귀).

### room.test.js (22개)

보너스패 낸 뒤 덱이 말라 손패 비면 턴 넘어감 / 폭탄 직후 스킵 턴엔 보너스패
불가 / 보너스패 내고 손패 남으면 같은 사람 차례 유지 / 덱 2장 매치 선택
대기 중 다른 행동 차단 / **선택 대기 중 강제종료 시 뒤늦은 선택 거부**
(회귀) / 폭탄으로 손패 완전히 비어도 스킵 턴 처리 후 라운드 종료 / **폭탄
lastEvent에 handCardIds 포함**(회귀) / 고스톱 대기 중 다른 행동 차단 /
**고를 선언하면 scoreAtLastGo가 최신값**(회귀) / 스톱 승리 시 고스톱 대기
상태 안 남음(회귀) / **점당 금액 스냅샷 유지**(회귀) / 강제종료 시 고스톱
대기 상태 정리(회귀) / **3인 이상 고박은 처음 고를 부른 사람에게만**(회귀) /
게임 시작 후 새 참가자 차단 / 대기방 나가기+호스트 이양 / round null일 때
친절한 에러 / 이미 끝난 판 재종료 거부 / 진행 중인 판 위 중복 시작 차단
(회귀) / round-end 후 다음 판 정상 시작 / 게임 시작 후 나가기 차단 /
**선(先) 좌석 회전 결정적 검증**(회귀) / **선(先) 무작위 배정 통계적 검증**
(200회, 회귀).

### socket.test.js (8개)

호스트 아닌 사람 점당금액 변경 차단 / 호스트 점당금액 변경 허용 / 호스트
아닌 사람 게임 시작 차단 / 호스트 접속 끊기면 다음 사람에게 이양 / 접속
끊긴 사람 차례 자동 진행 / **NEED_CHOICE2 대기자 접속 끊김도 자동
진행으로 풀림**(회귀) / **재접속 후 낡은 소켓 disconnect 무시**(회귀,
실제 소켓 2개 순서 조작) / **대기방 마지막 1인 퇴장 시 rooms Map에서
실제 삭제**(회귀).

### smoke.js (자동 스위트 미포함)

3인 실전 플레이 통합 시나리오 — 필요시 `node server/test/smoke.js`로
수동 실행.

**검증 원칙(요약, 전체는 improvement_log.md 작업 규율 2~3번)**: 서버 로직
변경은 `npm test` 전부 통과 필수(socket.test.js는 타이밍 의존적이라 드물게
1회 실패 가능 — 연달아 재실행해서 계속 실패하는지 확인). 새 로직은 반드시
회귀 테스트 추가. 소켓 타이밍 버그는 실제 `socket.io-client` 두 개로 순서를
재현하는 테스트를 `socket.test.js`에 정식으로 남길 것(일회성 확인 후 지우지
말 것). UI만 바꾼 경우 Playwright 스모크(pageerror 0건) + 필요시
`newContext({reducedMotion, colorScheme})`/`devices['iPhone 13']`로 미디어쿼리
검증. 임시 검증 스크립트(퍼즈 테스트 등)는 확인 후 삭제, 결과 요약만
improvement_log.md에 남김.

---

## 14. 이 프로젝트를 계속 작업하는 방식 (사용자의 운영 방침)

사용자의 명시적 지시: **"예약 작업(스케줄된 트리거)으로 자동 이어가지 말고,
세션이 살아있는 동안 직접 계획→구현→테스트를 반복하라."**

- 백로그가 있으면 우선순위 높은 것부터. 백로그가 비었으면 **멈추지 말고**
  코드를 처음부터 다시 훑으며 새 버그/개선점을 스스로 찾는다(억지로 지어내지
  말고, 이번엔 없었으면 정직하게 "없었음"으로 기록).
- 한 번에 너무 많이 바꾸지 않는다 — 사용자가 매 실행 결과를 리뷰 없이 바로
  받는 구조이므로, 위험도 낮고 되돌리기 쉬운 단위로 나눠서 진행.
- 작업이 끝나면 `claude/improvement_log.md`의 "완료된 것들"에 요약을
  추가하고 "다음 후보"에서 처리한 항목을 지운다. 코드 저장소 파일과
  Claude Project 문서 둘 다 갱신.
- git이 없으므로 모든 변경은 테스트로 검증된 뒤에만 최종으로 간주.
- 사용자의 최신 의도가 항상 우선이다 — 통계적으로 편향이 없다고 확인된
  현상(#36 보너스패 몰빵)이라도 사용자가 "그래도 되돌려달라"고 하면
  그대로 따른다.

---

## 15. 다음 후보 (백로그)

- **최우선**: 애니메이션/사운드 동기화 재설계(8.4절)의 **실제 브라우저
  실측 검증**(Playwright, 클라우드 미러 사본에서 서버+헤드리스 브라우저로
  진행). 코드 정적 검토는 끝났지만 `device_bash` 구조적 제약으로 실제
  브라우저 검증은 아직 못 함 — 카드 착지 `Animation.finished` 이후에만
  `handleGameEvent`가 불리는지, `.slam`/`.impact-ring`이 실제로 나타났다
  사라지는지, 폭탄 3장 시차 착지가 자연스러운지 확인할 것.
- 게임 중(라운드 시작 후) 모든 플레이어가 접속을 끊은 채 아무도 안 돌아오는
  방이 `rooms` Map에 영구히 남는 문제 — 재접속 가능성 때문에 의도적으로
  안 지우는 것인데, 유예시간 후 정리를 넣을지 여부 검토.
- `room:create` 반복 호출로 빈 방을 대량 생성하는 악용 가능성(인증/레이트
  리밋 없는 캐주얼 게임 설계상 트레이드오프인지, 최소 방어가 필요한지).
- `computeSettlement`의 아직 안 훑은 세부 규칙(고도리 3장 판정 기준, 흔들기
  선언 뒤 그 3장을 실제로 다 못 내는 예외 경로 등).
- (낮은 우선순위, 버그 아님) `#score-popups`/`.score-popup` 죽은 마커 정리
  또는 실제 기능화. `round.phase`의 `'await-choice'`/`pendingChoice`(단수)
  죽은 필드도 정리 후보(제거해도 동작에 영향 없음 — 실제로 세팅되는 곳이
  없으므로).

---

## 16. 배포 / 에셋 라이선스 (README.md 요약)

```bash
npm install
npm start   # http://localhost:3000
```

원격 배포: Render.com 무료 배포(추천, Build: `npm install`, Start:
`npm start`) 또는 `npx cloudflared tunnel --url http://localhost:3000`
(임시 터널, 컴퓨터가 켜져 있어야 하고 켤 때마다 링크 바뀜). 방 생성 시
5자리 코드 발급, `?room=코드` URL로도 참가 가능, 최대 4명.

**에셋 출처(전부 무료/오픈라이선스, 인터넷 연결 없이도 실행 가능하도록
저장소에 파일로 포함)**:
- 카드 그림 48장(뒷면 제외 - 뒷면은 tools/make_card_back.py로 직접 생성): Louie Mantia가 그려 위키백과 "Sakura (card game)"
  문서에 올린 일러스트, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
  (특정 제작사 상품 스캔이 아니라 위키백과용 원본 일러스트라 저작권 문제
  없음). `public/assets/cards/`.
- 효과음: [uisfx](https://uisfx.com) 오픈소스 사운드 팩,
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)(출처 표기
  불필요). `public/assets/audio/`.

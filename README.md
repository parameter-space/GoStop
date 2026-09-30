# 고스톱 온라인 (친구용)

친구들끼리 링크 하나로 접속해서 즐기는 웹 기반 고스톱. 규칙은 `gostop_rules.md`에서 확정한 하우스 룰을 따른다.

## 로컬에서 실행하기

```bash
npm install
npm start
```

브라우저에서 `http://localhost:3000` 접속. 같은 와이파이의 다른 사람은 `http://<내 컴퓨터 IP>:3000`으로 접속 가능.

## 인터넷을 통해 원격 친구들과 하기 (배포)

친구들이 각자 다른 곳에 있으므로, 매번 내 컴퓨터를 켜둘 필요 없이 무료 호스팅에 한 번 올려두는 걸 추천한다.

### Render.com 무료 배포 (추천)

1. 이 프로젝트를 GitHub 저장소에 올린다.
2. [render.com](https://render.com)에 가입 후 "New Web Service" → 방금 올린 저장소 선택.
3. 설정:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. 배포되면 `https://your-app.onrender.com` 같은 링크가 생김. 이 링크를 친구들에게 공유하면 끝.

> 무료 플랜은 일정 시간 접속이 없으면 서버가 잠들었다가, 누가 다시 접속하면 10~30초 정도 후에 깨어난다. 게임 시작 전에 링크를 한 번 열어서 깨워두면 좋다.

### 대안: 로컬 서버 + 임시 터널

무료 호스팅에 올리기 귀찮으면, 플레이할 때만 아래처럼 임시로 열 수도 있다.

```bash
npm start
# 다른 터미널에서
npx cloudflared tunnel --url http://localhost:3000
```

터미널에 뜨는 `https://xxxx.trycloudflare.com` 링크를 그때그때 친구들에게 공유. 내 컴퓨터가 켜져 있어야 하고, 켤 때마다 링크가 바뀐다.

## 방 생성/참가

- 호스트가 "방 만들기"를 누르면 5자리 코드(URL에도 `?room=코드`로 붙음)가 생긴다.
- 친구들은 그 코드나 URL로 "참가하기"만 하면 됨. 새로고침해도 같은 브라우저에서는 자동 재접속된다(localStorage에 저장).
- 최대 4명까지.

## 이번 버전에서 확정한 하우스 룰

`gostop_rules.md`의 "확정된 하우스 룰" 절 참고. 요약:

- 자뻑 피는 일반뻑과 동일 1장씩, 따닥은 피 없음, 쪽/싹쓸이는 1장씩
- 흔들기는 3장짜리만(콩알탄 없음), 흔들기·폭탄 배율은 곱으로 중첩
- 고 배율: 1고 +1점, 2고부터 2^(고횟수-1)배
- 비3광 2점 인정 / 초단은 4·5·7월만 / 멍박·쓰리뻑·총통(즉시승리형) 미사용
- 나가리는 배율 없이 그냥 재시작
- 점당 금액은 게임 중 언제든 변경 가능하고(대기방/게임 화면 둘 다에서 조정 가능), 정산 금액은 방에 계속 누적됨
- 호스트는 "이 판 무효 처리"(현재 판만 취소하고 다음 판으로)와 "방 폭파"(방 전체를 끝내고 모두 로비로) 두 버튼을 따로 가짐
- 바닥에 같은 월 카드가 2장 있는 상태에서 그 월 카드를 내면(또는 덱에서 뒤집은 카드가 바닥의 같은 월 2장과 매치되면) 어느 카드와 짝지을지 직접 선택하는 모달이 뜬다
- 바닥에 같은 월 카드가 여러 장 쌓이면(뻑 더미 등) 살짝 겹쳐서 한 무더기처럼 보이게 표시된다
- 9월 국화(열끗) 카드는 자기 먹은패에 있는 동안 언제든(자기 차례가 아니어도) 열끗↔쌍피로 전환할 수 있다
- 보너스패 2장이 덱에 포함되어 있고(초기 바닥에는 절대 깔리지 않음) 항상 쌍피로 계산된다: 손패에서 내면 상대 전원에게서 피 1장씩 뺏어오고 덱에서 한 장을 손패로 가져온 뒤, 그 한 번의 턴 안에서 정식으로(뻑/따닥/쪽 판정 포함) 카드를 한 장 더 낼 수 있다. 반대로 덱을 뒤집다가 보너스패가 나오면 즉시 자기 먹은패로 가져가고 상대 피는 뺏지 않은 채 덱에서 한 장을 더 뒤집어 이어간다

## 연출(타격감)

- 카드를 내거나 먹을 때 실제로 그 카드가 손패/바닥/더미에서 화면 위 새 위치까지 "집어서 옮기는" 것처럼 이동 애니메이션이 재생된다(FLIP 기법: `public/client.js`의 `captureCardRects`/`runFlipAnimation`). 새로 뒤집힌 더미 카드는 화면 왼쪽 위 더미 그림에서 튀어나오는 것처럼 보인다.
- 카드를 내려놓을 때마다 실제 녹음된 "탁!" 스냅 소리 + 저음 합성음이 겹쳐서 난다(`public/assets/audio/card-snap.mp3`).
- 뻑/따닥/쪽/싹쓸이/폭탄/흔들기/고/승리마다 화면 중앙 배너 텍스트 + 각각 다른 효과음(잠김/더블클릭/스트릭/레벨업/성취 등 실제 녹음된 소리)이 나온다. 버튼을 누를 때도 가벼운 클릭음이 더해진다.
- 폭탄/싹쓸이 시 보드가 살짝 흔들린다.
- 상대방 화면도 텍스트 요약이 아니라 실제 카드로 보인다: 상대 손패는 뒷면 카드 더미(장수만큼), 상대가 먹은 패는 실제 카드 그림으로 광/열끗/띠/피 구분해서 표시된다.
- 먹은 패는 아무렇게나 늘어놓지 않고, 실제 고스톱처럼 광/열끗/띠/피 줄로 정리해서 보여준다. 피는 겹쳐서 부채꼴로 쌓이고 옆에 합계 장수가 표시된다(나와 상대방 모두 동일).
- 카드는 실제 화투 그림(48장 전부)이 들어가 있다. 아래 "에셋 출처" 참고.

## 에셋 출처 (전부 무료/오픈라이선스)

- **카드 그림 48장** (`public/assets/cards/<월>-<종류>.webp`)
  - 작성자: [Louie Mantia](https://commons.wikimedia.org/wiki/User:Louiemantia)
  - 원본: 위키미디어 커먼즈 `File:Hanafuda_<Month>_<Type>.svg` 48장 (예: [Hanafuda_January_Hikari.svg](https://commons.wikimedia.org/wiki/File:Hanafuda_January_Hikari.svg)), 위키백과 ["Sakura (card game)"](https://en.wikipedia.org/wiki/Sakura_(card_game)) 문서에 쓰인 작성자 본인 창작 일러스트
  - 라이선스: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
  - 변경 사항: SVG를 244×400 WebP로 변환하고 파일 이름을 이 게임의 카드 id로 바꿈. 그림 자체는 수정하지 않음.
  - 이 카드 그림 파일들(변환본 포함)은 원본과 같은 CC BY-SA 4.0으로 배포된다.
- **카드 뒷면 무늬** (`public/assets/cards/back.webp`): 전통 물결무늬(세이가이하)를 [`tools/make_card_back.py`](tools/make_card_back.py)로 직접 그려 만든 타일. 외부 이미지를 쓰지 않았다.
- **효과음** (`public/assets/audio/` 중 `card-slap-real.mp3`를 뺀 나머지): [UI SFX](https://uisfx.com) ([romainsimon/uisfx](https://github.com/romainsimon/uisfx), `packages/uisfx/sounds`)의 mechanical/studio 팩. 라이선스: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (출처 표기 의무 없음). 파일별 원본: `capture-check`=mechanical/check, `match-success`=mechanical/success, `ppeok`=mechanical/lock, `ppeok-resolved`=mechanical/unlock, `ttadak`=mechanical/double-click, `ui-click`=mechanical/select, `bonus-reveal`=mechanical/bonus, `card-drop`=mechanical/drop, `card-snap`=mechanical/snap, `press`=mechanical/press, `go`=studio/level-up, `sweep`=studio/streak, `win`=studio/achievement.
- **카드 착지 타격음** (`public/assets/audio/card-slap-real.mp3`): [Freesound.org](https://freesound.org/people/Zaxtor99/sounds/147532/)의 Zaxtor99 `card.wav`. 라이선스: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). WAV를 MP3로 변환함.
- 전부 이 저장소에 파일로 포함되어 있어서 실행할 때 인터넷에서 따로 받을 필요는 없다.

## 알려진 단순화 사항 (완벽한 공식 규칙과 다른 부분)

친구끼리 캐주얼하게 하는 걸 목표로 몇 가지는 단순화했다. 나중에 필요하면 고치면 된다.

- **독박 판정**: 정식 규칙은 "족보를 완성시켜 준 마지막 한 장"까지 정확히 추적해야 하지만, 이 구현은 "완성된 족보에 들어간 카드들을 상대방 중 누가 바닥에 냈었는지"만 보고 그 상대가 단 한 명으로 특정될 때만 독박을 적용한다. 여러 명이 걸쳐 있거나 애매하면 독박을 적용하지 않는다. (`server/engine.js`의 `findDokbakTarget`)
- **4인 플레이 배분(손패 5장/바닥 8장)**: 공식적으로 통일된 4인 룰이 없어서 이 프로젝트에서 임의로 정한 값이다.

## 프로젝트 구조

```
server/
  deck.js     화투 48장 + 보너스패 2장 정의
  engine.js   순수 게임 로직(매칭, 점수, 배율)
  room.js     방/라운드 상태 관리
  index.js    Express + Socket.io 서버
  test/       자동 테스트(엔진 유닛테스트 + 멀티클라이언트 스모크 테스트)
public/
  index.html / style.css / client.js   프론트엔드
```

## 테스트

```bash
node server/test/engine.test.js          # 점수/매칭 로직 유닛 테스트
node server/index.js &                    # 서버 실행
node server/test/smoke.js                 # 3명이 실제로 플레이하는 통합 테스트
```

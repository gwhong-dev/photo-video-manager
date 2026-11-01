# 위치 제안 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 위치 없는 사진에 같은 날 시간 차이 60분 안의 사진 위치를 묶음으로 제안하고, 사용자가 확인한 것만 넣는다.

**Architecture:** 묶음 계산은 순수 함수(`lib/location-suggest.js`), 건너뛴 사진은 작은 JSON 파일(`lib/suggest-skips.js`)이 맡는다. 값 넣기는 기존 `gallery:apply-edit`에 `via: 'suggest'`를 더해 재사용한다. 화면은 격자 대신 `SuggestPanel`을 보여 준다. DB 구조는 그대로다.

**Tech Stack:** Electron 45, `node:sqlite`, React 19, Vite. 새 패키지 없음.

**Spec:** `docs/superpowers/specs/2026-11-02-location-suggest-design.md`

## Global Constraints

- 코드 주석은 한글로 쉽게 쓰고, 파일 맨 위에 "파일 위치 / 역할" 주석을 둔다
- 삭제, 이동, 이름 바꾸기, exiftool 쓰기를 넣지 않는다. 쓰기는 `userData` 안의 DB, 기록 파일, 건너뛴 목록, 로그뿐이다
- 앱이 혼자 값을 넣는 경로를 만들지 않는다. 넣기는 사용자가 버튼을 눌렀을 때만 일어난다
- `lib/`의 새 파일은 `require('electron')`을 하지 않는다. SQL은 `lib/db.js`에만, 값은 매개변수로 넘긴다
- 파일 경로는 화면에 주지 않는다
- 점검은 임시 폴더로만 하고, 실제 사진과 실제 `userData`를 쓰지 않는다
- 색과 글꼴은 `CLAUDE.md` "화면 디자인"을 따른다. 색연필 빨강은 쓰지 않고, 경고 노랑은 "정보 없음"에만 쓴다. 가운뎃점으로 정보 잇기, 버튼 글자 끝의 →, 영어 대문자 라벨 금지
- 버튼 문구: `4장에 이 위치 넣기`, `이 묶음 건너뛰기`, `건너뛴 N장 다시 보기`
- 커밋 메시지는 한글, 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. git은 `git -c safe.directory=*`로 부른다 (전역 설정은 바꾸지 않는다)
- `npm run check`가 실패하면 커밋하지 않는다. 머지는 사용자가 "머지"라고 한 뒤에만

## Review Focus

각 줄의 테스트는 맡은 작업에 들어 있다.

1. 같은 묶음을 두 번 넣기 (버튼 연타, 늦은 응답): 두 번째는 0장이 되고 기록을 남기지 않는다 (작업 3, 4)
2. 시각이 날짜뿐이거나 없는 사진: 오류 없이 근거와 대상에서 빠진다 (작업 1)
3. 위도 0 또는 경도 0인 근거 사진: 값 없음으로 착각하지 않는다 (작업 1)
4. 경로에 한글, 공백, `#`, `%`, 따옴표가 있는 건너뛴 사진: 다시 켜도 그대로 건너뛴다 (작업 2)
5. 제안 탭을 보는 중에 다시 읽기나 되돌리기로 목록이 바뀜: 보던 묶음이 남아 있으면 체크를 유지하고, 없으면 다음 묶음으로 넘어간다 (작업 4)

---

## 파일 구조

| 파일 | 역할 |
|---|---|
| `lib/location-suggest.js` (새) | 묶음 계산 순수 함수 |
| `lib/suggest-skips.js` (새) | 건너뛴 사진 목록 파일 |
| `lib/db.js` | `listSuggestionRows` 조회 추가 |
| `gallery-main.js` | 새 IPC 3개, `apply-edit`의 `via` 처리와 근거 사진 기록 |
| `preload.js`, `src/api.js` | 새 IPC 연결 |
| `src/suggest-view.mjs` (새) | 보여 줄 묶음과 체크 상태 계산 순수 함수 |
| `src/format.mjs` | 버튼 글과 시간 차이 글 |
| `src/components/SuggestPanel.jsx` (새) | 제안 화면 |
| `src/components/Toolbar.jsx`, `DetailPanel.jsx`, `src/App.jsx`, `src/styles.css` | 탭, 읽기 전용 패널, 연결, 모양 |
| `scripts/check-location-suggest.js` (새) | 점검 28~32번. `scripts/check.js`의 ITEMS 끝에 추가 |

---

### Task 1: 묶음 계산

**Files:**
- Create: `lib/location-suggest.js`, `scripts/check-location-suggest.js`
- Modify: `lib/db.js` (`getFilesByIds` 뒤), `scripts/check.js:806` 뒤

**Interfaces:**
- Produces:
  - `db.listSuggestionRows(root) -> [{ id, path, name, mediaType, takenAt, takenDay, lat, lng, locationSource }]`: 이 폴더의, 사라지지 않고 스크린샷이 아닌 파일 전부 (`NOT_SCREENSHOT_SQL`과 `SCREENSHOT_TAG` 재사용)
  - `buildSuggestions(rows, skippedPaths: Set<string>) -> { groups, photoCount, skippedCount }`
  - 묶음: `{ day, source: { id, name, takenAt, mediaType }, targets: [{ id, name, takenAt, mediaType, gapMinutes, path }] }`. `path`는 main 안에서만 쓰고 화면에 주기 전에 뺀다
  - `MAX_GAP_SECONDS = 3600`, `GROUP_KM = 1`
- 파일 모양은 `scripts/check-missing-info.js`를 따른다: `items` 내보내기, 이 파일만 돌리는 실행 부분, `require('./check-gallery')`의 `sub`, `row`, `withDb`, `fillFakeLibrary`

- [ ] **Step 1: 점검 28번 "위치 제안 계산"을 쓴다**

순수 함수 점검은 줄을 직접 만들어서 넘긴다.

| 라벨 | 입력 | 기대 |
|---|---|---|
| 28a 60분 경계 | 근거 14:00:00, 대상 15:00:00과 15:00:01 | 15:00:00만 제안 |
| 28b 다른 날 | 근거 26일 00:10, 대상 25일 23:50 | 묶음 0개 |
| 28c `manual` 근거 제외 | 근거 출처 `manual`뿐 | 묶음 0개 |
| 28d 건너뛴 대상 | 대상 경로가 `skippedPaths`에 있음 | 제안 없음, `skippedCount` 1 |
| 28e 같은 시간 차이 | 대상 앞뒤 10분에 근거 2개 (id 큰 쪽이 이름) | 이른 사진이 기준. 같은 시각이면 id 작은 쪽 |
| 28f 시각 없음 (Review 2) | `takenAt`이 null, `'2026-10-25'` | 근거와 대상 모두 안 쓰임, 오류 없음 |
| 28g 0도 위치 (Review 3) | 근거 `lat: 0, lng: 0` | 그 근거로 제안됨 |
| 28h 묶음 나누기 | 같은 날 위치가 0.5km, 3km 떨어진 근거 | 0.5km는 한 묶음, 3km는 다른 묶음. 묶음의 모든 대상 기준은 첫 근거 |
| 28i 묶음 순서 | 장수 3개, 1개, 같은 장수의 다른 날 | 장수 많은 순, 같으면 최근 날짜, 그다음 기준 id |
| 28j 시간 차이 값 | 대상과 기준 12분 차이 | `gapMinutes` 12, `photoCount`가 모든 대상 수와 같음 |
| 28k DB 조회 | `withDb`에 다른 root, `missing`, 스크린샷 태그 파일 | `listSuggestionRows`에 나오지 않음 |
| 28l 가짜 6만 건 | `fillFakeLibrary` | 계산 시간 표시, 2초를 넘으면 실패 (목표 0.5초) |

- [ ] **Step 2: 실행해서 실패를 확인한다**

Run: `node scripts/check-location-suggest.js`
Expected: `lib/location-suggest` 모듈을 찾을 수 없다는 오류

- [ ] **Step 3: `buildSuggestions`와 `listSuggestionRows`를 만든다**

시각은 `lib/manual-edit.js`처럼 `Date.UTC`만 빌려 글자 앞 19자를 초로 바꾼다. 날짜별 근거 목록을 먼저 만든다. 묶음 규칙은 그대로 옮긴다.

```js
// 한 날의 대상을 시각, id 순서로 보면서
const near = nearestSource(target);            // 차이 > 3600초면 null
if (!near) continue;
let group = dayGroups.find((g) => km(g.source, near) <= GROUP_KM);
if (!group) dayGroups.push(group = { day, source: near, targets: [] });
group.targets.push({ ...target, gapMinutes: Math.round(Math.abs(secOf(target) - secOf(group.source)) / 60) });
```

대상은 `lat === null`이고 시각이 있는 파일이다. 근거는 `lat`, `lng`가 모두 숫자, 시각이 있고, `locationSource !== 'manual'`인 파일이다. 건너뛴 대상은 `skippedCount`에 세고 제안하지 않는다.

- [ ] **Step 4: 통과를 확인한다**

Run: `node scripts/check-location-suggest.js`
Expected: 28번 모두 ✅

- [ ] **Step 5: 커밋한다**

`feat: 위치 제안 묶음 계산`

---

### Task 2: 건너뛴 사진 목록

**Files:**
- Create: `lib/suggest-skips.js`
- Modify: `scripts/check-location-suggest.js`

**Interfaces:**
- Produces: `createSkips(filePath, { onError(what, err) }) -> { paths(): Set<string>, add(paths: string[]) -> boolean, clear() -> boolean }`. 돌려주는 값은 파일 저장 성공 여부다. 실패해도 메모리 값은 바뀌고 던지지 않는다

- [ ] **Step 1: 점검 29번 "건너뛴 사진 목록"을 쓴다**

- 29a 새로 만들어 `add` 후 새 도구로 열면 그대로 있음. 경로는 `D:\사진 폴더\a#1%20'b".jpg` (Review 4)
- 29b `add`를 겹쳐도 하나로 셈, `clear` 후 새 도구로 열면 비어 있음
- 29c 깨진 파일: 빈 목록으로 시작, `suggest-skips.json.broken-`으로 시작하는 파일이 남음, `onError` 호출
- 29d 쓰기 실패 (파일 경로의 부모를 파일로 만듦): `add`가 `false`, `paths()`에는 있음, 던지지 않음
- 29e 파일 모양이 `{ "paths": [...] }`이고 쓰는 중 만든 임시 파일이 남지 않음

- [ ] **Step 2: 실행해서 실패를 확인한다**

Run: `node scripts/check-location-suggest.js`
Expected: 29번에서 모듈 없음 오류

- [ ] **Step 3: `createSkips`를 만든다**

임시 파일 `<파일>.tmp`에 쓰고 `fs.renameSync`로 바꾼다. 처음 열 때 한 번만 읽는다.

- [ ] **Step 4: 통과를 확인한다**

Run: `node scripts/check-location-suggest.js`
Expected: 28, 29번 모두 ✅

- [ ] **Step 5: 커밋한다**

`feat: 건너뛴 사진 목록 파일`

---

### Task 3: main 연결

**Files:**
- Modify: `gallery-main.js:28-29`, `:306-317`, `:342-355`, `:377-400`, `preload.js:55-56`, `src/api.js:25-26`, `scripts/check-location-suggest.js`

**Interfaces:**
- Consumes: `buildSuggestions`, `db.listSuggestionRows`, `createSkips`
- Produces:
  - `gallery:list-suggestions() -> { groups, photoCount, skippedCount }` (`target.path` 없음)
  - `gallery:skip-suggestions(ids) -> { saved: boolean }`
  - `gallery:clear-suggestion-skips() -> { saved: boolean }`
  - `gallery:apply-edit`의 결과에 `dropped: number` 추가 (그 사이 위치가 생겨 뺀 장수)
  - `api.listSuggestions()`, `api.skipSuggestions(ids)`, `api.clearSuggestionSkips()`
  - 넣기 `edit`: `{ source: 'copy', sourceId, date: false, time: false, location: true, via: 'suggest' }`

- [ ] **Step 1: 점검 30번 "위치 제안 연결"을 쓴다**

`scripts/check-missing-info.js` 24번(969~1100줄)처럼 가짜 `ipcMain`으로 `setupGallery`를 띄운다. 필요하면 그 준비 부분을 `check-missing-info.js`에서 함수로 빼서 함께 쓴다.

- 30a `list-suggestions` 응답 JSON 어디에도 파일 경로가 없음
- 30b 넣기 뒤 대상이 묶음에서 빠지고, 넣은 값이 다음 제안의 근거가 되지 않음
- 30c 되돌리면 다시 제안에 나옴. 건너뛴 사진은 건너뛴 채로 남음
- 30d 건너뛰기가 앱을 다시 띄워도 남고, `clear-suggestion-skips`로 비워짐. 다른 폴더 id는 더해지지 않음
- 30e `via: 'suggest'` 거절: 기준 출처가 `manual`, 대상과 기준의 날이 다름, `via`가 모르는 값
- 30f 그 사이 위치가 생긴 대상은 값이 그대로이고 `dropped` 1
- 30g 같은 묶음을 두 번 넣기: 두 번째 `count` 0, 기록 파일 줄이 늘지 않음 (Review 1)
- 30h 기록 파일 `apply` 줄: 제안은 `via: 'suggest'`와 기준의 `sourcePath`, 붙여넣기는 `via: 'copy'`와 `sourcePath`, 직접 넣기는 `via: 'direct'`와 `sourcePath: null`
- 30i 새 칸이 없는 옛 기록 파일과 새 줄이 섞여도 복구 뒤 값이 같음
- 30j 로그 머리글에 방법과 근거 사진 경로가 있음. 가져오기 중에는 `list-suggestions`가 거절됨
- 30k 사진 파일의 지문, 크기, 수정 시각이 전후로 같음

- [ ] **Step 2: 실행해서 실패를 확인한다**

Run: `node scripts/check-location-suggest.js`
Expected: 30번에서 처리기가 없다는 오류

- [ ] **Step 3: IPC를 만든다**

`createSkips(path.join(userDir(), 'suggest-skips.json'), { onError: errorLog })`로 만든다. 세 처리기 모두 맨 앞에서 `editReady()`로 검사한다. `skip`은 `checkIds` 뒤 `getFilesByIds`로 지금 폴더의 경로만 더한다.

- [ ] **Step 4: `apply-edit`를 고친다**

`via`가 `undefined`나 `'suggest'`가 아니면 거절한다. `'suggest'`면 `computePlan` 전에 다음을 한다. 기준 출처가 `manual`이면 거절, 대상 중 `takenDay`가 기준과 다른 것이 있으면 거절, 이미 위도가 있는 대상은 빼고 `dropped`로 센다. 기록 파일과 로그에는 `via`(`suggest` | `copy` | `direct`)와 `sourcePath`를 넣는다. `finishEdit`의 머리글에 `방법`과 `근거` 줄을 더한다. 근거 경로는 로그와 기록 파일에만 쓰고 응답에는 넣지 않는다. 복구 코드와 `validLine`은 고치지 않는다.

- [ ] **Step 5: 통과를 확인한다**

Run: `node scripts/check-location-suggest.js`, 이어서 `npm run check`
Expected: 30번 모두 ✅, 기존 점검도 모두 통과

- [ ] **Step 6: 커밋한다**

`feat: 위치 제안 main 연결과 근거 사진 기록`

---

### Task 4: 화면

**Files:**
- Create: `src/suggest-view.mjs`, `src/components/SuggestPanel.jsx`
- Modify: `src/format.mjs`, `src/components/Toolbar.jsx:17-22, 24, 60-79`, `src/components/DetailPanel.jsx`, `src/App.jsx`, `src/styles.css`, `scripts/check-location-suggest.js`

**Interfaces:**
- Consumes: 작업 3의 `api.*`, 넣기 `edit` 모양
- Produces:
  - `groupKey(group) -> string` (`${day}:${source.id}`)
  - `settleView(groups, current: { key, unchecked: Set<number> } | null) -> { key, unchecked }`: 보던 묶음이 있으면 유지하고 사라진 id를 `unchecked`에서 빼요. 없으면 첫 묶음, 빈 `unchecked`. 묶음이 없으면 `null`
  - `suggestApplyLabel(n) -> '4장에 이 위치 넣기'`, `gapText(minutes) -> '1분 안' | '12분 차이' | '1시간 5분 차이'`
  - `SuggestPanel({ gen, focusId, onFocus, onApplied, onNotice })`
  - `DetailPanel`에 `readOnly` 추가: 값 넣기 버튼과 복사한 값 칸을 그리지 않음

- [ ] **Step 1: 점검 31번 "위치 제안 보기 계산과 문구"를 쓴다** (Review 5)

`settleView`: 보던 묶음이 남으면 체크 유지, 사라진 id는 정리, 묶음이 사라지면 첫 묶음과 빈 체크, 빈 목록이면 `null`. `gapText`: 0→`1분 안`, 12→`12분 차이`, 65→`1시간 5분 차이`. `suggestApplyLabel(1234)`→`1,234장에 이 위치 넣기`.

- [ ] **Step 2: 실행해서 실패를 확인한다**

Run: `node scripts/check-location-suggest.js`
Expected: 31번에서 모듈 없음 오류

- [ ] **Step 3: `suggest-view.mjs`와 글 함수를 만들고 통과를 확인한다**

Run: `node scripts/check-location-suggest.js`
Expected: 31번 모두 ✅

- [ ] **Step 4: 탭과 패널 연결을 만든다**

`App`에 `filter.info`를 쓰지 않고 `suggestOpen` 상태를 따로 둔다. 필터에 넣으면 격자 목록을 헛되이 읽기 때문이다.

- `Toolbar`: "위치 제안" 탭을 더하고, 열려 있으면 검색, 정렬, 목록 전체 선택을 숨긴다. 다른 탭을 누르거나 화면을 바꾸면 닫는다
- 탭을 열 때 선택을 비운다
- `center`: `state.total === 0` 갈래 뒤, `daysError` 갈래 앞에 `suggestOpen`이면 `SuggestPanel`
- `manualTab`은 `!suggestOpen`일 때만 참이다
- `DetailPanel`: `suggestOpen`이면 `readOnly`와 `selectedId={focusId}`
- 넣은 뒤에는 기존 `onApplied`를 쓴다 (되돌리기 줄과 `gen` 갱신이 그대로 동작한다)

- [ ] **Step 5: `SuggestPanel`을 만든다**

- `gen`이 바뀔 때마다 `listSuggestions`를 부르고, 요청 번호로 늦은 응답을 버린다 (`EditDialog`와 같은 방식)
- 받은 뒤 `settleView`로 보여 줄 묶음과 체크를 정한다
- 위쪽 줄: `남은 묶음 505개, 2,054장`과, 건너뛴 사진이 있으면 `건너뛴 N장 다시 보기`
- 근거 사진: `pvm://preview/<id>` (영상이면 `pvm://thumb/<id>`), 실패하면 "미리보기 없음". 날짜와 시각은 `formatTakenAt`
- 대상 사진: 격자 썸네일 `pvm://thumb/<id>`와 `gapText`. 사진을 누르면 `onFocus(id)`, 모서리 체크 칸을 누르면 체크 토글
- 넣기: 체크된 id로 `applyEdit`, 이어서 뺀 id로 `skipSuggestions`. 넣는 중에는 ref로 막아 연타해도 한 번만 부른다 (Review 1). 결과의 `dropped`가 있으면 `onNotice('그 사이 위치가 생긴 N장은 빼고 넣었어요.')`
- 건너뛰기: 묶음의 모든 id로 `skipSuggestions` 뒤 목록을 다시 읽는다
- `saved: false`면 `onNotice('건너뛴 사진을 파일에 저장하지 못했어요. 이번 실행 동안만 기억해요.')`
- 넣기가 거절되면 (근거 사진이 사라짐 등) 이유를 `onNotice`로 알리고 목록을 다시 읽는다
- 목록을 못 읽은 오류는 탭 안에 `EmptyState`로, 묶음이 없으면 제목 "제안할 사진이 없어요"
- 체크가 0장이면 넣기 버튼을 끈다

CSS는 기존 변수와 격자 칸 모양을 쓴다.

- [ ] **Step 6: 점검 32번 "위치 제안 화면 열기"를 쓰고 돌린다**

27번(`launchCheck`, 임시 `PVM_USER_DATA`) 방식으로 샘플 DB를 띄워, 탭을 눌러 `남은 묶음`, `장에 이 위치 넣기`, `이 묶음 건너뛰기` 글자가 보이고 화면 오류가 없는지 본다.

Run: `npm run check`
Expected: 모든 점검 통과

- [ ] **Step 7: 커밋한다**

`feat: 위치 제안 화면`

---

### Task 5: 실제 목록 복사본 확인과 문서

**Files:**
- Modify: `docs/실사용-테스트.md`, `docs/개발개요-v3.md:79`, `PROGRESS.md`

- [ ] **Step 1: 실제 목록 복사본으로 앱을 띄운다**

임시 폴더에 `library.db`와 설정 복사본을 두고 `PVM_USER_DATA`로 실행한다. 실제 `userData`를 쓰지 않는다. 먼저 `npm run build`가 필요한지 `docs/실사용-테스트.md` 9절 절차를 따른다.

Expected: 약 2,054장, 약 505묶음 (복사본의 현재 값에 따라 조금 다를 수 있다. 크게 다르면 원인을 찾는다)

- [ ] **Step 2: 앱 안에서 해 본다**

묶음 넣기, 체크에서 빼고 넣기, 건너뛰기, 다시 보기, 되돌리기, 앱을 껐다 켜기를 각각 한 번 이상 하고 숫자가 맞는지 본다. 넣은 값 일부를 임시 DB에서 근거 사진 값과 비교한다.

- [ ] **Step 3: 사진 폴더 전후를 비교한다**

경로, 크기, 수정 시각이 전후로 같아야 한다. 차이 0이 아니면 멈추고 사용자에게 알린다.

- [ ] **Step 4: 문서를 고친다**

`실사용-테스트.md`에 절차, 결과, 사용자 확인 항목(기기 정보 없는 사진의 제안 표본, 사용감)을 쓴다. 이름과 위치는 적지 않고 개수만 적는다. 개요 79줄의 상태를 "복사 붙여넣기, 위치 제안, DB 저장 구현, 지도와 파일 기록 남음"으로 고친다. `PROGRESS.md`는 20줄 안팎으로 맞춘다.

- [ ] **Step 5: 커밋하고 올린다**

`docs: 위치 제안 확인 결과와 진행 상황`. 이어서 `npm run check` 통과 후 push, PR, CI 확인, 독립 검증(M 등급 1회), 지적 반영. 머지는 사용자가 "머지"라고 한 뒤에만 한다.

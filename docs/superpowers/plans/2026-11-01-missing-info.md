# 정보 없는 사진 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 위치나 날짜가 없는 사진을 모아 보고, 사용자가 고른 값을 미리보기 후 여러 장에 DB로만 넣고 되돌릴 수 있게 한다.

**Architecture:** `files` 표는 계속 "화면에 보일 값"을 담고, 직접 넣은 값은 경로로 잇는 `manual_values` 표와 `userData/manual-edits.jsonl` 기록 파일에 따로 보관한다. 값 계산은 순수 함수(`lib/manual-edit.js`), 저장 순서(기록 파일 → DB)는 `gallery-main.js`가 맡는다. 화면은 기존 격자에 필터와 여러 장 선택을 더한다.

**Tech Stack:** Electron 45, `node:sqlite`, React 19, Vite. 새 패키지 없음.

**Spec:** `docs/superpowers/specs/2026-11-01-missing-info-design.md`

## Global Constraints

- 코드 주석은 한글로 쉽게 쓰고, 파일 맨 위에 "파일 위치 / 역할" 주석을 둔다
- 이 PR에는 사진 파일의 삭제, 이동, 이름 바꾸기, exiftool 쓰기를 넣지 않는다. 쓰기는 `userData` 안의 DB, 기록 파일, 썸네일, 로그뿐이다
- `lib/`의 새 파일은 `require('electron')`을 하지 않는다
- SQL은 `lib/db.js`에만, 값은 항상 매개변수로 넘긴다
- 파일 경로는 화면에 주지 않는다
- 점검은 임시 폴더로만 하고, 실제 사진과 실제 `userData`를 쓰지 않는다
- 색과 글꼴은 `CLAUDE.md` "화면 디자인"을 따른다. 경고 노랑 #E3B341은 "정보 없음"에 관한 표시에만, 색연필 빨강은 쓰지 않는다. 가운뎃점으로 정보 잇기, 버튼 글자 끝의 →, 영어 대문자 라벨 금지
- 버튼 문구는 결과를 말한다 ("124장에 위치 넣기")
- 커밋 메시지는 한글, 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 이 작업 폴더의 git은 `git -c safe.directory=*`로 부른다 (전역 설정은 바꾸지 않는다)
- `npm run check`가 실패하면 커밋하지 않는다. 머지는 사용자가 "머지"라고 한 뒤에만

## Review Focus

각 줄의 테스트는 맡은 작업에 들어 있다.

1. 위치가 위도 0 또는 경도 0인 사진: 값 없음으로 착각하지 않고 복사된다 (작업 1, 3)
2. 고른 뒤 다시 읽기로 사라졌거나 다른 백업 폴더 소속인 id: 오류로 멈추지 않고 대상에서 빠진다 (작업 3, 5)
3. 미리보기와 넣기 사이에 파일 정보가 바뀜: 넣기 때 다시 계산한 값을 저장한다 (작업 5)
4. 경로에 한글, 공백, `#`, `%`, 따옴표가 있는 파일: 기록 파일에서 그대로 복구된다 (작업 4)
5. 바꿀 사진이 0장인 미리보기: 넣기 버튼이 꺼지고 기록을 남기지 않는다 (작업 3, 5, 7)

---

## 파일 구조

| 파일 | 역할 |
|---|---|
| `lib/db.js` (수정) | 구조 버전 2, 값 적용과 되돌리기, 새 필터와 개수 |
| `lib/manual-edit.js` (새) | 화면 요청 검사, 미리보기 계산. 순수 함수 |
| `lib/manual-journal.js` (새) | 기록 파일 쓰기, 읽기, DB에 복구 |
| `gallery-main.js`, `preload.js`, `src/api.js` (수정) | 새 IPC |
| `src/selection.mjs` (새) | 여러 장 선택 계산. 순수 함수 |
| `src/format.mjs` (수정) | 버튼 문구 |
| `src/App.jsx`, `Sidebar`, `Toolbar`, `DayGrid`, `DetailPanel`, `styles.css` (수정) | 화면 |
| `src/components/ContextMenu.jsx`, `EditDialog.jsx`, `UndoBar.jsx` (새) | 우클릭 메뉴, 미리보기 창, 되돌리기 줄 |
| `scripts/check-missing-info.js` (새), `scripts/check.js` (수정) | 점검 20번부터 |
| `docs/실사용-테스트.md`, `docs/개발개요-v3.md`, `PROGRESS.md` (수정) | 문서 |

---

### 작업 1: DB 구조 2와 직접 넣은 값 저장

**Files:**
- Modify: `lib/db.js`, `scripts/check.js:804`
- Create: `scripts/check-missing-info.js`

**Interfaces:**
- Produces (`makeApi`에 추가):
  - `ManualValue = { takenAt: string|null, takenOffset: string|null, lat: number|null, lng: number|null }`
  - `getManual(path) → ManualValue|null`
  - `applyManualBatch({ id, root, kind, createdAt, items: [{ path, before: ManualValue|null, after: ManualValue }] })` 한 트랜잭션
  - `undoBatch(id, undoneAt)` 한 트랜잭션. 그 root의 마지막 묶음이 아니면 오류
  - `lastBatch(root) → { id, kind, count, createdAt }|null` (되돌리지 않은 것 중 마지막. `rowid` 내림차순)
  - `batchStatus(id) → 'none'|'applied'|'undone'`
  - `getFilesByIds(ids) → 전체 값 한 줄씩` (없는 id는 건너뜀, 태그 없음)
- `scripts/check-missing-info.js`는 `{ items }`를 내보내고, 바로 실행하면 `os.tmpdir()`의 `pvm-check-` 임시 폴더로 전체 항목을 돌린다 (`node scripts/check-missing-info.js`). 항목 모양은 `check-gallery.js`와 같고 번호는 20부터. `row()`와 `fillFakeLibrary`는 필요한 만큼 `check-gallery.js`에서 내보내 함께 쓴다.

- [ ] **Step 1: 의존성 설치와 기준 확인**

이 작업 폴더에는 `node_modules`가 없다. Run: `npm ci` 그다음 `npm run check`. Expected: `✅ 모두 통과`. 실패하면 멈추고 알린다.

- [ ] **Step 2: 실패하는 점검 쓰기 (20번 "직접 넣은 값 저장")**

```js
// 20a 버전 1 파일을 열면 값은 그대로, user_version 2, 새 표 3개
// 20b 값 넣기: files 값과 출처가 manual, 다른 칸은 그대로
apply({ path: 'R1/a.jpg', after: { takenAt: null, takenOffset: null, lat: 37.5, lng: 127 } });
assert(file.lat === 37.5 && file.locationSource === 'manual' && file.takenAtSource === 'exif');
// 20c 위도 0, 경도 0도 값으로 저장 (Review Focus 1)
// 20d 같은 파일을 다시 읽어도(upsertFiles) 직접 넣은 값이 남고, 찍은 시각이 바뀌면 orig가 새 값
// 20e 파일이 사라져도(setMissing) manual_values는 남음
// 20f 되돌리기: 파일 값으로 돌아가고 출처도 원래대로. thumb_state는 그대로
// 20g 두 묶음이 겹친 파일: 뒤 묶음을 되돌리면 앞 묶음 값, 다시 되돌리면 파일 값
// 20h 마지막이 아닌 묶음을 undoBatch하면 오류. lastBatch는 root별로 따로
// 20i files 줄이 없을 때 넣은 값: orig_known 0. 나중에 upsertFiles하면 파일 값 저장 뒤 직접 넣은 값 적용
// 20j 저장 중 오류가 나면 전부 되돌려짐 (같은 id로 두 번 applyManualBatch하면 오류, 값은 첫 번째 그대로)
```

- [ ] **Step 3: 실패 확인**

Run: `node scripts/check-missing-info.js`. Expected: 20번 ❌ (`applyManualBatch is not a function`).

- [ ] **Step 4: `lib/db.js` 구현**

- `SCHEMA_VERSION = 2`. `TABLES`에 설계서 4절의 표 3개를 더한다 (`IF NOT EXISTS`). 칸 확인 SELECT도 더한다.
- 내부 함수 `writeManual(path, root, value)`: 값이 null이면 줄을 지운다. `files`의 날짜는 값의 `takenAt`이 있으면 그 값(`taken_day`는 앞 10글자, 출처 `manual`), 없으면 `orig_` 값. 위치도 따로 같은 규칙. 비교는 항상 `=== null`로 한다.
- 첫 저장 때 `files` 줄이 있으면 지금 값을 `orig_`에 보관하고 `orig_known = 1`.
- `upsertFiles`: 줄을 저장한 직후 `manual_values`가 있으면 `orig_`를 그 줄의 파일 값으로 고치고 다시 적용한다.
- `getFile`이 돌려주는 값은 바꾸지 않는다.

- [ ] **Step 5: 통과 확인**

Run: `node scripts/check-missing-info.js`. Expected: 20번 ✅.

- [ ] **Step 6: 커밋**

`scripts/check.js`의 목록에 `...require('./check-missing-info').items`를 더하고 `npm run check` 통과 후 `feat: 직접 넣은 날짜와 위치를 저장하는 DB 구조 추가`로 커밋.

---

### 작업 2: 정보 없음 필터와 개수

**Files:**
- Modify: `lib/db.js`, `scripts/check-missing-info.js`

**Interfaces:**
- Consumes: 작업 1의 저장 함수
- Produces:
  - `filter.info`: `'noLocation'|'noDate'|'manual'|undefined` (`buildWhere`, 그래서 `listDays`, `listFiles`)
  - `listIds(root, filter) → number[]` (정렬은 `listDays`, `listFiles`와 같은 순서)
  - `summary(root)`에 더함: `noLocation`, `noInfo`, `manualCount`

- [ ] **Step 1: 실패하는 점검 쓰기 (21번 "정보 없음 목록")**

```js
// 샘플: 위치 있음, 위치 없음, 스크린샷(위치 없음), 날짜 없음(위치 있음), 사라진 파일(위치 없음), 직접 넣은 파일
// 21a noLocation은 스크린샷과 사라진 파일을 뺌
// 21b noDate는 날짜 없는 파일만 (스크린샷 포함)
// 21c manual은 날짜나 위치의 출처가 manual인 것만
// 21d noInfo = 날짜 없음 또는 위치 없음(스크린샷 제외). 둘 다 없는 파일은 한 번만 셈
// 21e 위치를 넣으면 noLocation에서 빠지고, 되돌리면 돌아옴
// 21f info와 검색어, 태그를 함께 쓸 수 있음
// 21g listIds 개수 = listDays 합계
// 21h 가짜 6만 건에서 noLocation listDays, listFiles 0.2초 목표, 1초 넘으면 실패 (시간을 detail에 적음)
```

- [ ] **Step 2: 실패 확인**

Run: `node scripts/check-missing-info.js`. Expected: 21번 ❌.

- [ ] **Step 3: `buildWhere`, `listIds`, `summary` 구현**

스크린샷 판단은 `buildWhere`의 기존 `NOT EXISTS` 조건을 재사용한다. 21h가 1초를 넘을 때만 색인을 더한다.

- [ ] **Step 4: 통과 확인 후 커밋**

Run: `node scripts/check-missing-info.js`, `npm run check`. Expected: ✅. 커밋 `feat: 정보 없는 사진 필터와 개수 추가`.

---

### 작업 3: 미리보기 계산

**Files:**
- Create: `lib/manual-edit.js`
- Modify: `scripts/check-missing-info.js`

**Interfaces:**
- Produces:
  - `normalizeRequest(raw, { sourceRow, year }) → Resolved`. 잘못된 값이면 사람이 읽을 글자로 `Error`
    - raw: 설계서 9절의 `edit` 모양
    - `Resolved = { kind: 'date'|'location'|'both', date: { day, time|null, offset|null }|null, location: { lat, lng }|null, sourceId: number|null }`
  - `planEdit(rows, resolved, manualOf) → { kind, items, counts }`
    - rows: `getFilesByIds` 결과, `manualOf(path) → ManualValue|null`
    - items: `{ id, path, name, status: 'changed'|'same', hadValue, beforeManual, afterManual, before: { takenAt, lat, lng }, after: { takenAt, lat, lng } }`
    - counts: `{ changed, same, overwrite, excluded }`
  - `toPreview(plan) → 경로와 manual 값을 뺀 화면용 값` (앞 100줄 + `more`)
  - `MAX_TARGETS = 20000`

- [ ] **Step 1: 실패하는 점검 쓰기 (22번 "미리보기 계산")**

```js
// 22a 날짜+시간: 기준 14:00:30, 대상 3장 → 14:00:30, :31, :32. 순서는 찍은 시각, 이름, id (날짜 없는 파일은 맨 뒤)
// 22b 23:59:59부터 넘어가면 다음 날 00:00:00, day도 바뀜
// 22c 날짜만: 각 파일 시각과 시간대 유지. 시각이 없으면 12:00:00과 기준 시간대
// 22d 직접 넣기: 시간대 +09:00, 시간 기본 12:00:00, +1초 규칙 같음
// 22e 위치: lat 0, lng 0도 복사 (Review Focus 1). 기준에 위치가 없는데 location 고르면 오류
// 22f 기준에 날짜가 없는데 date 고르면 오류. date 없이 time만 고르면 오류. 아무것도 안 고르면 오류
// 22g 기준 사진 자신과 missing, 다른 root 줄은 빠지고 excluded에 셈 (Review Focus 2)
// 22h 값이 같으면 same. 다른 값이 있던 파일은 overwrite와 hadValue. 위치만 넣을 때 날짜값은 비교하지 않음
// 22i afterManual은 이전 직접 넣은 값과 합침: 날짜를 넣은 파일에 위치를 넣으면 둘 다 있음
// 22j 전부 same이면 changed 0 (Review Focus 5)
// 22k 날짜 모양 거절: 2026-02-30, 1899-12-31, 내년, '2026-1-1', 시각 25:00:00, 위도 91
// 22l toPreview 결과에 path 없음, 101장이면 100줄과 more 1
```

- [ ] **Step 2: 실패 확인**

Run: `node scripts/check-missing-info.js`. Expected: 22번 ❌ (모듈 없음).

- [ ] **Step 3: `lib/manual-edit.js` 구현**

시각 계산은 `Date.UTC`로 시간대 없이 글자를 다룬다 (`formatTakenAt`처럼 현지 시각을 그대로). 연도 상한은 `year` 인자로 받는다.

- [ ] **Step 4: 통과 확인 후 커밋**

Run: `node scripts/check-missing-info.js`, `npm run check`. Expected: ✅. 커밋 `feat: 날짜와 위치 넣기 미리보기 계산 추가`.

---

### 작업 4: 기록 파일과 복구

**Files:**
- Create: `lib/manual-journal.js`
- Modify: `scripts/check-missing-info.js`

**Interfaces:**
- Consumes: `applyManualBatch`, `undoBatch`, `batchStatus`
- Produces:
  - `createJournal(filePath) → { append(line), read() → { lines, skipped } }`. `append`는 한 줄씩 동기로 더하고 실패하면 오류
  - `recover(db, journal) → { applied, undone, skipped }`

- [ ] **Step 1: 실패하는 점검 쓰기 (23번 "기록 파일과 복구")**

```js
// 23a apply, undo 줄을 쓰고 새 DB에 recover → 값과 되돌림 상태가 같음, 다시 읽은 뒤에도 같음
// 23b 경로 'R1/한글 #1 %20 "따옴표".jpg' 그대로 복구 (Review Focus 4)
// 23c 이미 DB에 있는 묶음은 건너뜀 (recover를 두 번 해도 같음)
// 23d apply 줄만 있고 DB에 없음(저장 전에 꺼짐) → 적용됨
// 23e void of apply: 그 묶음을 적용하지 않음. void of undo: 묶음은 적용하고 되돌림은 취소
// 23f 끝 줄이 잘린 파일과 깨진 가운데 줄: 건너뛰고 skipped에 셈, 나머지는 복구
// 23g 파일이 없으면 빈 결과. 읽기 전용 경로에 append하면 오류
```

- [ ] **Step 2: 실패 확인**

Run: `node scripts/check-missing-info.js`. Expected: 23번 ❌.

- [ ] **Step 3: `lib/manual-journal.js` 구현**

`recover`는 먼저 줄 목록에서 `void`를 그 앞의 같은 `batchId`, 같은 `of` 줄과 함께 지우고, 남은 줄을 순서대로 적용한다. `apply`는 `batchStatus`가 `none`일 때만, `undo`는 `applied`일 때만.

- [ ] **Step 4: 통과 확인 후 커밋**

Run: `node scripts/check-missing-info.js`, `npm run check`. Expected: ✅. 커밋 `feat: 직접 넣은 값 기록 파일과 복구 추가`.

---

### 작업 5: main 연결

**Files:**
- Modify: `gallery-main.js`, `preload.js`, `src/api.js`, `scripts/check-missing-info.js`

**Interfaces:**
- Consumes: 작업 1~4
- Produces (IPC, `api`의 같은 이름):
  - `listIds(filter) → number[]` (`gallery:list-ids`)
  - `getCopySource(id) → { id, name, takenAt, lat, lng }|null` (`gallery:get-copy-source`)
  - `previewEdit(ids, edit) → toPreview 결과` (`gallery:preview-edit`)
  - `applyEdit(ids, edit) → { batchId, kind, count }` (`gallery:apply-edit`). 바꿀 것이 0장이면 `{ batchId: null, kind, count: 0 }`
  - `undoLast() → { kind, count }|null` (`gallery:undo-last`)
  - `getState`에 더함: `noLocation`, `noInfo`, `manualCount`, `lastBatch`
  - `cleanFilter`에 `info` 허용

- [ ] **Step 1: 실패하는 점검 쓰기 (24번 "넣기와 되돌리기 연결")**

기존 18d처럼 가짜 `ipcMain`, `protocol`로 `setupGallery`를 띄우고, 임시 폴더에 작은 파일을 둔다.

```js
// 24a 미리보기 뒤 넣기: DB와 기록 파일에 값, library-changed 알림, 로그 파일 생김
// 24b 넣기와 되돌리기 전후 임시 폴더 파일의 지문, 크기, 수정 시각 같음
// 24c 미리보기와 넣기 사이에 기준 사진 값이 바뀌면 새 값으로 저장 (Review Focus 3)
// 24d isRunning이 true면 미리보기, 넣기, 되돌리기 모두 거절
// 24e 이상한 id(문자, 0, 소수, 20,001개)와 이상한 edit 거절. 없는 id와 다른 root의 id는 빠짐 (Review Focus 2)
// 24f 바꿀 것이 0장이면 count 0, 기록 파일과 묶음 그대로 (Review Focus 5)
// 24g 기록 파일에 못 쓰면 거절, DB 그대로
// 24h DB 저장이 실패하면 void 줄이 생기고, 다시 켜서 복구해도 값이 들어가지 않음
// 24i setupGallery를 켤 때 복구: library.db를 지우고 다시 켜면 값이 돌아옴
// 24j 응답 어디에도 파일 경로가 없음 (JSON에 root 글자가 없는지 확인)
// 24k 3,277장 넣기 시간을 재서 detail에 적음 (10초 넘으면 실패)
// 24l 기준 사진이 사라졌으면 미리보기 거절 ('다시 복사해 주세요' 글자 포함)
// 24m 백업 폴더가 연결되지 않아도 넣기와 되돌리기가 동작함
```

- [ ] **Step 2: 실패 확인**

Run: `node scripts/check-missing-info.js`. Expected: 24번 ❌.

- [ ] **Step 3: `setupGallery` 구현**

- DB를 연 직후 `manual-edits.jsonl`을 `recover`하고 결과를 `startupLog`에 남긴다. 복구 실패는 갤러리를 끄지 않고 `errorLog`만 남긴다.
- 넣기 순서: 검사 → 다시 계산 → 기록 파일 → `applyManualBatch` → 실패하면 `void` → 로그(`manual-edit` 머리글, 파일별 전후 값) → `library-changed`. 되돌리기도 같은 순서.
- 묶음 id는 `crypto.randomUUID()`. 대상은 `rootNow()` 소속만.
- `busy()`면 `'가져오기가 끝난 뒤에 할 수 있어요'`로 거절.

- [ ] **Step 4: 통과 확인 후 커밋**

Run: `node scripts/check-missing-info.js`, `npm run check`. Expected: ✅. 커밋 `feat: 날짜와 위치 넣기, 되돌리기를 화면과 연결`.

---

### 작업 6: 화면 전환과 여러 장 선택

**Files:**
- Create: `src/selection.mjs`
- Modify: `src/App.jsx`, `src/components/Sidebar.jsx`, `Toolbar.jsx`, `DayGrid.jsx`, `src/styles.css`, `scripts/check-missing-info.js`

**Interfaces:**
- Consumes: 작업 5의 `listIds`, `getState` 새 값
- Produces:
  - `nextSelection(sel, { id, ctrl, shift, dayFiles }) → sel`. `sel = { ids: Set<number>, anchor: number|null, focus: number|null }`
  - App 상태: `screen: 'gallery'|'missing'`, `filter.info`, `selection`
  - `DayGrid`의 props: `selection`, `onCellClick(file, event, dayFiles)`, `onCellMenu(file, event)`, `onSelectDay(day)`

- [ ] **Step 1: 실패하는 점검 쓰기 (25번 "선택 계산", `grid-layout.mjs` 점검처럼 동적 import)**

```js
// 25a 클릭: 한 장만, focus 그 파일. 25b Ctrl+클릭: 더하기, 다시 하면 빼기
// 25c Shift+클릭: 같은 날 anchor부터 범위. 다른 날이면(anchor가 dayFiles에 없음) 그 칸 한 장으로
// 25d 앞뒤 어느 방향이든 범위가 같음. 25e 고른 것이 없을 때 Shift+클릭은 한 장
```

- [ ] **Step 2: 실패 확인**

Run: `node scripts/check-missing-info.js`. Expected: 25번 ❌.

- [ ] **Step 3: `selection.mjs`와 화면 구현**

- `Sidebar`: "정보 없는 사진"을 켜고 숫자는 `noInfo`. 갤러리 메뉴로 돌아올 수 있게 한다.
- `Toolbar`: `screen === 'missing'`이면 탭이 "위치 없음 n", "날짜 없음 n", "내가 넣은 정보 n". 도구줄에 "목록 전체 선택" 버튼. 정보 없는 사진 화면을 처음 열면 `info: 'noLocation'`.
- `DayGrid`: `Cell`에 Ctrl, Shift, 우클릭을 넘기고, `DayLabel`에 "이 날 모두 선택". 칸의 `memo`가 유지되도록 `selected`는 불리언으로 넘긴다.
- `App`: 탭, 필터, 화면이 바뀌면 선택을 비운다. 탭이 비면 `EmptyState`로 "날짜 없는 사진이 없어요", "위치 없는 사진이 없어요", "직접 넣은 정보가 아직 없어요". `selectedId`는 `selection.focus`로 바꾼다.
- 이때 `gallery:open-screen`은 건드리지 않는다. 같은 창 안의 화면 전환이다.

- [ ] **Step 4: 통과 확인**

Run: `npm run check`. Expected: ✅ (18번 화면 점검 포함).

- [ ] **Step 5: 화면 확인**

임시 `userData`(`PVM_USER_DATA`)에 샘플 복사본을 백업 폴더로 두고 앱을 띄워 메뉴, 탭 개수, Ctrl과 Shift 선택, 탭 전환 시 선택 비움을 확인한다. 진짜 설정과 DB는 쓰지 않는다.

- [ ] **Step 6: 커밋**

`feat: 정보 없는 사진 화면과 여러 장 선택 추가`.

---

### 작업 7: 복사, 붙여넣기, 미리보기, 되돌리기 화면

**Files:**
- Create: `src/components/ContextMenu.jsx`, `EditDialog.jsx`, `UndoBar.jsx`
- Modify: `src/App.jsx`, `src/components/DetailPanel.jsx`, `src/format.mjs`, `src/styles.css`, `scripts/check-missing-info.js`

**Interfaces:**
- Consumes: 작업 5의 `getCopySource`, `previewEdit`, `applyEdit`, `undoLast`, 작업 6의 `selection`
- Produces:
  - `applyLabel(count, kind) → '124장에 위치 넣기'`, 0장이면 빈 글자. kind별 말: `date` 날짜, `location` 위치, `both` 날짜와 위치
  - `undoLabel(count, kind) → '124장 위치 되돌리기'`

- [ ] **Step 1: 실패하는 점검 쓰기 (26번 "버튼 문구", `format.mjs`를 동적 import)**

```js
// 26a applyLabel(1234,'location') === '1,234장에 위치 넣기'
// 26b applyLabel(3,'both') === '3장에 날짜와 위치 넣기'
// 26c applyLabel(0,'date') === '' (Review Focus 5: 화면은 빈 글자면 버튼을 끄고 "바꿀 사진이 없어요"를 보임)
// 26d undoLabel(2,'date') === '2장 날짜 되돌리기'
```

- [ ] **Step 2: 실패 확인**

Run: `node scripts/check-missing-info.js`. Expected: 26번 ❌.

- [ ] **Step 3: 구현**

- `ContextMenu`: 설계서 8절의 세 항목. 선택에 없는 칸을 우클릭하면 그 칸만 선택. 바깥 클릭과 Esc로 닫기. 창 끝에서 잘리지 않게 위치를 맞춘다.
- `EditDialog`: 붙여넣기(날짜, 시간, 위치 칸. 기준에 없는 값은 꺼짐) 또는 직접 넣기(`<input type="date">`, `<input type="time" step="1">`, 기본 12:00:00). 칸이 바뀔 때마다 `previewEdit`를 다시 부르고 늦은 응답은 버린다. 바뀜, 그대로, 원래 값이 있음(경고 노랑), 전 → 후 목록, "외 N장", 그만두기, Esc.
- `UndoBar`: `state.lastBatch`가 있으면 "내가 넣은 정보" 탭 위쪽과, 넣은 직후 `ScanBanner` 아래에 보인다. 넣은 직후 줄은 닫을 수 있다.
- `App`: 복사한 값(`copySource`)은 화면이 바뀌어도 남긴다. 넣은 뒤 선택을 비운다. 오류는 기존 `notice`로 보인다.
- `DetailPanel`: 여러 장이면 "N장 선택함"과 같은 버튼들. 복사한 값 요약. `SOURCE_TEXT`에 `manual: '내가 넣은 값'`을 더하고 위치에도 출처를 보인다.
- Figma "정보 없는 사진"을 다시 시도하고, 안 되면 지금 갤러리 화면에 맞춘 뒤 PR에 적는다.

- [ ] **Step 4: 통과 확인**

Run: `npm run check`. Expected: ✅.

- [ ] **Step 5: 화면 확인**

작업 6과 같은 임시 환경에서 복사 → 여러 장 선택 → 붙여넣기 → 미리보기 → 넣기 → 패널에 "내가 넣은 값" → 되돌리기, 그리고 다시 켜서 값 유지를 확인한다. 임시 폴더 파일 전후 비교도 한다.

- [ ] **Step 6: 커밋**

`feat: 복사 붙여넣기와 되돌리기 화면 추가`.

---

### 작업 8: 실제 DB 복사본 확인, 문서, PR

**Files:**
- Modify: `docs/실사용-테스트.md`, `docs/개발개요-v3.md`, `PROGRESS.md`, `PROGRESS-LOG.md`

- [ ] **Step 1: 실제 DB 복사본으로 확인**

임시 `userData`에 진짜 설정, `library.db`, `thumbs` 폴더를 복사해 띄운다 (썸네일 상태가 `ready`로 들어 있어 `thumbs`가 없으면 그림이 비어 보인다). 앱은 백업 폴더를 읽기만 하며, 값은 임시 `userData`에만 저장된다. 확인: 버전 2로 옮겨짐, 위치 없음 3,277, 같은 날 사진 찾기와 복사 흐름, 몇 장 넣고 되돌리기, 사진 폴더 전후 비교(경로, 크기, 수정 시각). 3,277장 처리 흐름이 불편하면 그 내용을 PR에 적고 사용자에게 알린다.

- [ ] **Step 2: 문서 갱신**

`실사용-테스트.md`에 절차와 결과를, `개발개요-v3.md` 단계 3 상태를 "복사 붙여넣기와 DB 저장 구현, 지도와 파일 기록 남음"으로 고친다. `PROGRESS.md`는 20줄 안팎으로, 남은 일(지도, 파일 기록)을 "나중에 할 일"에 쓴다. PR #4 머지 뒤 달라진 내용이 있으면 main을 합친 뒤 고친다.

- [ ] **Step 3: 최종 점검**

Run: `npm run check`. Expected: `✅ 모두 통과`. 코드에 사진 파일 쓰기가 없는지 `grep`으로 확인: 새 코드에 `et.write`, `fs.rename`, `fs.unlink`, `fs.rm`, `shell.trashItem`이 없어야 한다.

- [ ] **Step 4: push와 PR**

`feature/missing-info`를 push하고 PR을 만든다. PR에 측정 시간, 확인 못 한 것, Figma 확인 여부를 적는다.

- [ ] **Step 5: 검증 에이전트 (L 등급)**

작업 내용을 모르는 새 에이전트에게 PR의 변경 파일과 호출부만 검토시키고, `CLAUDE.md` 3절의 표 형식으로 PR 댓글 1개를 남긴다. 지적 반영은 같은 댓글의 "조치" 열만 갱신한다. 머지는 사용자가 "머지"라고 한 뒤에만 한다.

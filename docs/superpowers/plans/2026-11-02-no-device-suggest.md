# 기기 정보 없는 사진 처음엔 체크 끄기 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 위치 제안에서 기기 정보(`files.model`) 없는 사진은 처음에 체크를 꺼 두고, 기기 정보 있는 사진이 든 묶음을 먼저 보여 준다.

**Architecture:** 계산(`lib/location-suggest.js`)이 사진마다 `noDevice`를 붙이고 묶음 순서를 바꾼다. 체크 상태는 `src/suggest-view.mjs`의 순수 함수가 "처음 상태와 다르게 바꾼 사진 번호(`flipped`)"로 다룬다. `SuggestPanel`은 그 함수만 부른다. `gallery-main.js`는 바꾸지 않는다 (`noDevice`는 기존 경로 빼기 뒤에도 그대로 화면에 간다).

**Tech Stack:** Electron, Node, React, better-sqlite3

**Spec:** `docs/superpowers/specs/2026-11-02-location-suggest-design.md` 12절 (나머지 절은 그대로)

## Global Constraints

- 등급 M, 검증 1회. DB 구조, 새 패키지 없음
- 기기 정보 없음 = `model`이 `null`이거나 공백뿐인 글자
- 처음 체크되는 사진은 기기 정보 있는 사진뿐
- 처음부터 꺼져 있던 사진은 넣기를 눌러도 건너뛴 목록에 넣지 않는다. 사람이 직접 끈 기기 정보 있는 사진만 기억한다
- 문구: `기기 정보 없음`, `N장 모두 체크하기` (N은 천 단위 쉼표). 노랑(#E3B341)과 빨강은 쓰지 않는다 (보조 글자색)
- 코드 주석은 한글로 쉽게

## Review Focus

1. 같은 묶음이 다시 받은 목록에서 사진이 늘어난 경우 (되돌리기): 새 사진은 처음 상태(기기 정보 있으면 체크)여야 함 → 31k
2. 기기 정보 없는 사진을 켰다가 다시 끈 경우: 처음 상태로 돌아간 것이므로 기억하지 않음 → 31i
3. 섞인 묶음에서 넣기: 보지 않은 기기 정보 없는 사진이 건너뛴 목록으로 사라지지 않음 → 31i
4. `model`이 빈 글자 `''`인 사진: 기기 정보 없음으로 봄 → 28o
5. 체크 0장 묶음(348개): 넣기 버튼이 꺼지고 `모두 체크하기`는 켜져 있음 → 32a (화면 글자)

---

### Task 1: 계산에 기기 정보와 묶음 순서 더하기

**Files:**
- Modify: `lib/db.js:594-608` (`listSuggestionRows`가 `f.model`을 읽어 `model`로 돌려줌)
- Modify: `lib/location-suggest.js` (`buildSuggestions`)
- Test: `scripts/check-location-suggest.js` 28번 항목

**Interfaces:**
- Produces: 묶음의 `targets[]`에 `noDevice: boolean`. 묶음 순서 = 기기 정보 있는 사진이 하나라도 든 묶음 먼저, 그 안에서는 기존 순서(장수, 최근 날짜, 기준 id)

- [ ] **Step 1: 점검 추가 (실패 확인용)**
  - `28o 기기 정보 없음 표시`: `model: null`, `model: ''`, `model: '  '` → `noDevice === true`, `model: 'iPhone 12'` → `false`
  - `28p 기기 정보 있는 묶음이 먼저`: 기기 정보 없는 5장 묶음, 기기 정보 있는 1장 묶음, 섞인 2장 묶음(다른 날) → 순서가 [섞인 2장, 있는 1장, 없는 5장]
  - `28q 조회에 기기 정보가 있음`: 28n처럼 `withDb`로 `row({ model: 'X' })` 넣고 `listSuggestionRows` 결과 `model === 'X'`
- [ ] **Step 2:** `node scripts/check-location-suggest.js` → 28o, 28p, 28q 실패
- [ ] **Step 3:** 구현. `noDevice = !(typeof f.model === 'string' && f.model.trim())`. 정렬 비교 맨 앞에 `hasDevice(b) - hasDevice(a)`
- [ ] **Step 4:** 같은 명령 → 28번 전부 통과
- [ ] **Step 5:** 커밋 `feat: 위치 제안에 기기 정보 유무와 묶음 순서 더하기`

### Task 2: 체크 상태 계산 (화면 없이)

**Files:**
- Modify: `src/suggest-view.mjs`
- Modify: `src/format.mjs` (`checkAllLabel`)
- Test: `scripts/check-location-suggest.js` 31번 항목 (31a, 31b를 새 모양으로 고침)

**Interfaces:**
- Consumes: Task 1의 `target.noDevice`
- Produces (view 모양이 `{ key, unchecked }` → `{ key, flipped }`로 바뀜):
  - `isChecked(target, flipped: Set) → boolean` = `!target.noDevice` 와 `flipped.has(id)`의 XOR
  - `checkedIds(group, flipped) → number[]`
  - `rememberIds(group, flipped) → number[]` = 기기 정보 있고 꺼진 사진 (건너뛴 목록에 넣을 것)
  - `checkAll(group) → Set` = 기기 정보 없는 사진 번호들 (모두 체크된 상태)
  - `settleView(groups, current) → { key, flipped } | null` (기존 규칙, `flipped`에서 사라진 번호만 지움)
  - `checkAllLabel(n) → string` = `'1,234장 모두 체크하기'`

- [ ] **Step 1: 점검 추가/수정**
  - `31a/31b`: `unchecked` → `flipped`로 바꿔 같은 뜻 유지
  - `31h 처음엔 기기 정보 있는 사진만 체크`: `checkedIds(g, new Set())`가 기기 정보 있는 사진만
  - `31i 기억할 사진`: 기기 정보 있는 사진 하나를 끄고, 기기 정보 없는 사진 하나는 켰다가 끈(=flipped에 없음) 상태 → `rememberIds`는 앞의 하나뿐. 아무것도 안 바꾸면 빈 배열
  - `31j 모두 체크`: `checkedIds(g, checkAll(g))`가 전부, `rememberIds`는 빈 배열
  - `31k 같은 묶음에 사진이 늘면 새 사진은 처음 상태`: settleView 후 새 기기 정보 있는 사진 체크, 새 기기 정보 없는 사진 꺼짐
  - `31l 모두 체크 글`: `checkAllLabel(1234) === '1,234장 모두 체크하기'`
- [ ] **Step 2:** `node scripts/check-location-suggest.js` → 31번 실패
- [ ] **Step 3:** 구현
- [ ] **Step 4:** 같은 명령 → 31번 통과
- [ ] **Step 5:** 커밋 `feat: 위치 제안 체크 상태를 처음 상태 기준으로 계산`

### Task 3: 화면

**Files:**
- Modify: `src/components/SuggestPanel.jsx` (머리 주석, `toggle`, `apply`, `TargetCell`, 버튼 줄)
- Modify: `src/styles.css` 근처 `.suggest-gap` (`.suggest-nodevice` 한 줄, 보조 글자색)
- Test: `scripts/check-location-suggest.js` 32번 항목

**Interfaces:**
- Consumes: Task 2 함수 전부

- [ ] **Step 1: 점검 수정** `32a`: `남은 묶음`, `이 묶음 건너뛰기`, `모두 체크하기`가 보이고, 넣기 버튼 글은 `장에 이 위치 넣기` 또는 `넣을 사진을 골라 주세요` (샘플의 기기 정보에 따라 다름)
- [ ] **Step 2:** 구현
  - 칸: 체크 여부는 `isChecked`, 기기 정보 없으면 시간 차이 아래에 `기기 정보 없음`
  - `toggle(id)`: `flipped`에 넣거나 빼기
  - 버튼 줄: `넣기` / `N장 모두 체크하기` (모두 체크면 꺼짐) / `이 묶음 건너뛰기`. 모두 체크도 `isRepeatClick` 처리
  - `apply`: `checkedIds`로 넣고 `rememberIds`만 `skip`
- [ ] **Step 3:** `npm run build` 후 `npm run check` → 모두 통과 (앱 창 항목이 실패하면 `ELECTRON_RUN_AS_NODE`를 지우고 다시)
- [ ] **Step 4:** 커밋 `feat: 기기 정보 없는 사진은 처음에 체크를 꺼 두기`

### Task 4: 문서

**Files:**
- Modify: 설계서 12절 제목에서 "아직 만들지 않음" 빼기
- Modify: `docs/실사용-테스트.md` 위치 제안 항목에 "처음 157묶음이 먼저 나오고 1,007장만 체크되는지, 348묶음은 넣기가 꺼져 있는지" 추가
- Modify: `PROGRESS.md` 상단 (머지 뒤)

- [ ] **Step 1:** 수정, 커밋 `docs: 기기 정보 없는 사진 처리 반영`
- [ ] **Step 2:** push, 초안 PR, 검증 에이전트 1회 (PR 댓글 표)

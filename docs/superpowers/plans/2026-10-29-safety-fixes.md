# 안전 수정 (feature/safety-fixes) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run check`(12개 항목)를 먼저 만들고, 안전 수정 ①~⑥으로 ❌ 항목을 하나씩 ✅로 바꾼다.

**Architecture:** main.js 안에 있던 실행·로그·원본 정리 코드를 `lib/`로 옮겨 Electron 없이 Node로 시험할 수 있게 한다. 점검 스크립트는 샘플을 임시 폴더에 복사해 실제 처리 흐름(makePlan → JobStore → runBatch → cleanOriginals)을 돌리고, 휴지통·드라이브 종류·디스크 공간은 가짜 함수로 바꿔 끼워 시험한다(실제 휴지통은 건드리지 않음).

**Tech Stack:** Node 24 / Electron 38 (CommonJS), exiftool 13.59, ImageMagick 7.1.2 (HEIC 읽기 전용), FFmpeg 9.0.2. 새 라이브러리 없음.

**Spec:** `docs/기능명세-가져오기-변환-v1.1.md`, `docs/개발개요-v3.md` 4-0-1, `docs/점검-푸시-절차.md`

## Global Constraints

- 영구 삭제 금지. 코드 어디에도 원본에 대한 `unlink`/`rm` 경로를 만들지 않는다 (임시 `__tmp__` 파일 정리만 예외)
- 영상 촬영일은 `Keys:CreationDate` 우선 (`creation_time`/`QuickTime:CreateDate`는 전송 시각)
- 중복 판단: 해시 → 애플 ID(PhotoIdentifier → ImageUniqueID → ContentIdentifier) → `_1`. GPS·기기 정보는 판단에 쓰지 않고 로그 참고용
- 휴지통 없는 드라이브(USB·SD·네트워크·종류 모름) → `가져올 폴더\_정리완료원본`으로 이동 (폴더 구조 유지)
- 남은 공간: 이번 회차 예상 용량보다 적으면 중단, 사용률 80% 넘으면 경고
- 점검은 `test/samples`를 **임시 폴더에 복사한 뒤** 그 복사본으로만 실행. `test/samples/manual/`은 git 제외, 없으면 해당 검사 ⏭
- 경로는 `path` 모듈만 사용, OS 전용 코드는 `lib/platform.js`에만
- 주석은 한글로 쉽게, 기존 코드 말투(“~해요”)를 따른다
- 로그 이름: 원본 정리 로그는 `clean_*.txt` (결정 필요 — 아래 "결정할 것" 참고)

## Review Focus

1. 한글·공백이 들어간 경로 (`여행 사진\`) → 다른 파일과 똑같이 처리돼야 함 → Task 1 샘플에 포함, 항목 4·5에서 확인
2. `_정리완료원본`에 같은 이름 파일이 이미 있음 → 덮어쓰지 않고 `_1` → Task 7 항목 12a
3. 드라이브 종류를 못 알아냄(PowerShell 실패) → 휴지통 없는 쪽으로 처리(이동) → Task 7 항목 12f
4. 다시 가져오기 할 때 `_정리완료원본` 안의 파일 → 스캔에서 빠져야 함 → Task 7 항목 12e
5. 같은 값을 다시 쓸 때 exiftool이 "unchanged"라고 답함 → 실패로 보지 않음 → Task 4 항목 7

---

## 파일 구조

| 파일 | 역할 | 상태 |
|---|---|---|
| `lib/logger.js` | 로그 파일 만들기 (`createLogger`) | 새로 (main.js에서 옮김) |
| `lib/runner.js` | 계획 로그, 남은 공간 확인, N개 실행 (`writePlanLog`, `checkSpace`, `runBatch`) | 새로 (main.js에서 옮김) |
| `lib/cleaner.js` | 원본 정리 대상 고르기 + 휴지통/이동 (`cleanCandidates`, `cleanTargets`, `cleanInfo`, `cleanOriginals`) | 새로 (main.js·job.js에서 옮김) |
| `lib/platform.js` | 드라이브 종류 (`driveKind`, `canUseRecycleBin`) | 새로 |
| `lib/planner.js` | ① sameShot, ⑤ Keys 읽기, `_정리완료원본` 건너뛰기, `fileHash`·`MOVED_DIR` 내보내기 | 수정 |
| `lib/dates.js` | ⑤ 영상 날짜 순서 | 수정 |
| `lib/processor.js` | ⑥ XMP·Keys 복사 | 수정 |
| `lib/exiftool.js` | "unchanged"는 성공으로 | 수정 |
| `lib/job.js` | `canTrash` 제거 (cleaner로 이동) | 수정 |
| `main.js`, `preload.js`, `index.html` | lib 호출로 교체, 공간 확인·정리 방법 표시 | 수정 |
| `scripts/make-samples.js` | `test/samples/auto/` 만들기 (`npm run samples`) | 새로 |
| `scripts/check.js` | 12개 항목 점검 (`npm run check`) | 새로 |
| `scripts/launch-check.js` | 항목 1: 앱 창 띄우고 화면 글자·오류 읽기 | 새로 (scratchpad에서 옮김) |
| `test/samples/auto/` | 자동 샘플 (커밋, 수백 KB) | 새로 |
| `.gitignore`, `package.json`, `README.md` | manual 제외, 스크립트, 점검 방법 | 수정 |

## 자동 샘플과 기대 결과 (`test/samples/auto/`)

| 샘플 | 만드는 법 | 기대 결과 (백업 폴더 기준) | 검사 |
|---|---|---|---|
| `IMG_0101.jpg` | magick 그림 + `DateTimeOriginal=2026:10:28 13:40:58`, `Model=iPhone 18 Pro` | `2026\10\28\2026-10-28_134058_IMG_0101.jpg` | 4, 5 |
| `dup\IMG_0101.jpg` | 위 파일과 바이트까지 같음 | 둘 중 하나 `done`, 하나 `dup` | 8 |
| `other\IMG_0101.jpg` | 다른 그림, 같은 날짜·같은 기기, 애플 ID 없음 | `2026\10\28\2026-10-28_134058_IMG_0101_1.jpg` | 8 (①) |
| `여행 사진\2026-10-28_13-41-05_여행.jpg` | `DateTimeOriginal=2026:10:28 13:41:05` | `2026\10\28\2026-10-28_134105_여행.jpg` (B 규칙) | 5 |
| `KakaoTalk_20261028_210941.jpg` | 촬영 정보 없음 | `2026\10\28\2026-10-28_210941_KakaoTalk_20261028_210941.jpg` | 5 |
| `IMG_0102.PNG` (스크린샷) | `XMP-exif:DateTimeOriginal=2026:10:27 09:15:00`, `XMP-dc:Subject=스크린샷` | `2026\10\27\2026-10-27_091500_IMG_0102.png` | 4 |
| `IMG_0103.MOV` | ffmpeg 1초 h264 + `Keys:CreationDate=2026:10:28 13:41:13+09:00`, `QuickTime:CreateDate=2026:10:29 02:00:00`(전송 시각), `XMP-exif:DateTimeOriginal=2026:10:29 11:00:00`(잘못된 날짜), `XMP-dc:Subject=비디오, 수원시` | `2026\10\28\2026-10-28_134113_IMG_0103.mp4`, 영상 코덱 h264 그대로, `XMP-dc:Subject`·`Keys:CreationDate` 남아 있음 | 6 (⑤), 7 (⑥) |
| `noinfo.jpg` | 촬영 정보 없음, 이름에 날짜 없음 | `_날짜없음\noinfo.jpg` | 9 |

수동 샘플 (`test/samples/manual/`, git 제외): `*.HEIC` 1장 이상, 라이브 포토 = 같은 이름의 `.HEIC` + `.MOV`. 없으면 항목 7의 HEIC 부분과 라이브 포토 확인은 `⏭ 건너뜀 (수동 샘플 없음)`.

## 점검 항목 (`npm run check`)

결과 표: `✅` / `❌ 이유` / `⏭ 건너뜀 (이유)`. ❌가 하나라도 있으면 종료 코드 1. ⏭은 실패가 아님.

| # | 확인 방법 |
|---|---|
| 1 | `launch-check`: 창 제목 "사진/영상 관리 프로그램", 화면 콘솔 오류 0, 화면에 `✅ exiftool`·`✅ ImageMagick`·`✅ FFmpeg`, 정상 종료 |
| 2 | `detectTools({}, 앱폴더)` → 4개 모두 ok, `magick -list format`의 HEIC 줄에 `r` |
| 3 | 샘플을 `%TEMP%\pvm-check-<시각>\source`로 복사 → 전체 처리 → `fail` 0개, `test/samples` 원본 해시가 실행 전후 같음 |
| 4 | 모든 결과가 `YYYY\MM\DD\` 또는 `_날짜없음\` 아래, 위 표의 폴더와 일치 |
| 5 | 위 표의 파일 이름과 정확히 일치 (B 규칙, 카톡 이름 포함) |
| 6 | `IMG_0103.MOV` → `2026\10\28\...134113...mp4` (전송 시각 10-29가 아니면 ✅) |
| 7 | MP4: ffprobe 영상 코덱 = 원본 코덱, `XMP-dc:Subject` = `비디오, 수원시`, `Keys:CreationDate` 있음 / HEIC(수동): JPG 생성, `Orientation`=1, `DateTimeOriginal` 원본과 같음 / 라이브 포토(수동): JPG·MP4 둘 다 생성 |
| 8 | 같은 내용 쌍: done 1 + dup 1 / `other\IMG_0101.jpg` → `_1`로 저장 |
| 9 | `noinfo.jpg` → `_날짜없음\noinfo.jpg` |
| 10 | 새 복사본에서 `batchSize=3`으로 1회 → JobStore를 디스크에서 다시 불러와 나머지 실행 → 모든 파일이 정확히 한 번만 `done`/`dup`, 남은 `todo` 0 |
| 11 | 로그 폴더(임시)에 `plan_*.txt`, `run_*.txt` 있음 |
| 12 | a) 드라이브 `removable` → 휴지통 함수 호출 0번, 원본이 `source\_정리완료원본\<원래 상대 경로>`로 이동, 이미 같은 이름 있으면 `_1` / b) `fixed` → 가짜 휴지통 함수가 대상 수만큼 호출 / c) 정리 대상: 같은 해시 파일이 백업에 있는 dup만, `check`(확인 필요) dup·결과 파일 지운 dup 제외 / d) 가짜 디스크 남은 공간 1KB → 0개 처리하고 `stopped`, 사용률 80% 넘는 경우 `warning` / e) 이동 뒤 다시 미리보기 → `_정리완료원본` 파일 0개 / f) 드라이브 종류 `unknown` → 이동 |

---

### Task 1: 점검 도구와 샘플 (코드 동작은 그대로)

**Files:**
- Create: `lib/logger.js`, `lib/runner.js`, `scripts/make-samples.js`, `scripts/check.js`, `scripts/launch-check.js`, `test/samples/auto/*`
- Modify: `main.js` (start-job·run-batch가 runner 호출), `package.json`, `.gitignore`, `README.md`

**Interfaces:**
- Produces:
  - `createLogger(logDir: string) → { newLog(prefix: string, header: string) → { path: string, write(line: string) } }`
  - `writePlanLog(job, logger) → string` (로그 경로)
  - `runBatch({ job, store, batchSize: number, ctx, logger, statfs?, shouldPause?: () => boolean, onProgress?: (p) => void }) → Promise<{ done, dup, fail, handled, paused: boolean, stopped: string|null, spaceWarning: string|null, logPath }>` (이 Task에서는 공간 확인 없이 기존 동작 그대로, `stopped`·`spaceWarning`은 항상 null)
  - check.js 항목 함수: `async (ctx) → { status: 'ok'|'fail'|'skip', detail: string }`

- [ ] **Step 1:** 브랜치 `feature/safety-fixes` 만들기 (`feature/import-convert`에서), `.gitignore`에 `test/samples/manual/` 추가, 이 계획 파일 포함
- [ ] **Step 2:** `scripts/make-samples.js` 작성 → `npm run samples` 실행 → 위 표의 8개 파일 생성, 각 파일을 exiftool로 읽어 넣은 값이 들어갔는지 확인
- [ ] **Step 3:** `main.js`의 `stamp/newLog/now`, 계획 로그, run-batch 반복문을 `lib/logger.js`, `lib/runner.js`로 옮김 (동작 변경 없음)
- [ ] **Step 4:** `scripts/launch-check.js`(scratchpad 버전을 함수 `launchCheck(appDir) → Promise<{ ok, title, text, errors, exitCode }>`로), `scripts/check.js` 작성. 항목 12는 `lib/cleaner.js`가 없으면 `❌ 아직 없음`
- [ ] **Step 5:** `npm run check` 실행 → 예상: 1·2·3·4·5·9·10·11 ✅, **6·7·8·12 ❌**, 7의 HEIC·라이브 포토 부분 ⏭. 결과 표를 사용자에게 보여줌
- [ ] **Step 6:** 앱을 켜서 v1.1 화면이 예전처럼 뜨는지(항목 1) 확인 → 커밋 `test: npm run check와 자동 샘플 추가, 실행 코드를 lib로 분리`

### Task 2: ① 중복 판단에서 기기 정보 제거

**Files:** Modify `lib/planner.js` (`sameShot`)
**Interfaces:** `sameShot(a, b) → boolean` — 두 쪽 모두 애플 ID가 있을 때만 비교, 없으면 false. `Model`·`SubSecTimeOriginal`은 로그용으로 계속 읽음.

- [ ] **Step 1:** `npm run check` → 항목 8 ❌ ("other\IMG_0101.jpg가 dup로 처리됨") 확인
- [ ] **Step 2:** `sameShot` 수정 (processor.js의 실행 직전 확인도 같은 함수를 써서 함께 바뀜)
- [ ] **Step 3:** `npm run check` → 8 ✅, 앞서 ✅였던 항목 그대로
- [ ] **Step 4:** 커밋 `fix: 중복 판단에서 기기 정보 제거 (명세대로 해시 → 애플 ID)`

### Task 3: ⑤ 영상 날짜는 Keys:CreationDate 먼저

**Files:** Modify `lib/planner.js`, `lib/dates.js`
**Interfaces:**
- 영상 파일만 한 번 더 읽기: `et.read(videoPaths, ['Keys:CreationDate'])` → 결과의 `CreationDate`를 `meta.KeysCreationDate`로 저장 (exiftool `-j`는 그룹 이름을 빼고 돌려주므로, 그룹을 섞지 않으려고 따로 읽음)
- `dateFromMeta(meta) → { parts, from }` — `meta.KeysCreationDate`가 있으면 가장 먼저, 그다음 기존 순서

- [ ] **Step 1:** 항목 6 ❌ ("10-29로 분류됨") 확인
- [ ] **Step 2:** 수정 → 항목 6 ✅, 나머지 그대로
- [ ] **Step 3:** 커밋 `fix: 영상 날짜를 Keys:CreationDate 우선으로 읽기`

### Task 4: ⑥ MOV→MP4 뒤 XMP 태그 복사

**Files:** Modify `lib/planner.js` (`XMP-dc:Subject` 읽어 `item.subject`에 저장), `lib/processor.js` (`convertVideo` 끝), `lib/exiftool.js` (`write`)
**Interfaces:**
- convertVideo 뒤: 원본에 `subject` 또는 `KeysCreationDate`가 있으면 `et.write(['-overwrite_original', '-tagsFromFile', src, '-XMP:all', '-Keys:CreationDate', tmp])`
- `ExifTool.write`: 출력에 `image files unchanged`가 있으면 성공으로 봄

- [ ] **Step 1:** 항목 7 ❌ ("XMP-dc:Subject 없음") 확인
- [ ] **Step 2:** 수정 → 항목 7 ✅ (HEIC 부분은 ⏭ 가능), 나머지 그대로
- [ ] **Step 3:** 커밋 `fix: MP4 변환 뒤 XMP 태그와 Keys 촬영일 복사`

### Task 5: ④ 실행 전 남은 공간 확인

**Files:** Modify `lib/runner.js`, `main.js` (새 IPC `space-info`), `preload.js` (`spaceInfo(batchSize)`), `index.html` (실행 확인 창에 경고·중단 표시)
**Interfaces:**
- `checkSpace(items, backupRoot, statfs = fs.statfsSync) → { ok: boolean, estimateBytes, freeBytes, usedRatioAfter, warning: string|null }` — 예상 용량: HEIC→JPG는 원본 크기 × 2, 나머지는 × 1. `freeBytes < estimateBytes`면 ok=false, `usedRatioAfter > 0.8`이면 warning
- `runBatch`는 처음에 `checkSpace` → ok=false면 0개 처리하고 `stopped: '공간 부족'`

- [ ] **Step 1:** 항목 12d 시험 추가 → ❌ 확인
- [ ] **Step 2:** 구현 → 12d ✅
- [ ] **Step 3:** 커밋 `feat: 실행 전 백업 폴더 남은 공간 확인`

### Task 6: ② 중복 건너뜀 파일은 같은 해시가 있을 때만 정리

**Files:** Create `lib/cleaner.js` (대상 고르기 부분), Modify `lib/job.js` (`canTrash` 제거), `lib/planner.js` (`fileHash` 내보내기), `main.js` (`trashList` → cleaner)
**Interfaces:**
- `cleanCandidates(job) → item[]` — 빠른 확인(파일 있음, `check` 아님). 배너 숫자용
- `cleanTargets(job, { hashOf = fileHash } = {}) → Promise<item[]>` — `done`: 결과 파일 있음(지금과 같음) / `dup`: `check`가 아니고, 남길 파일(finalPath → dupOf → dupOfItem의 finalPath)이 있고, **해시가 원본과 같을 때만**. 변환 파일 중복(HEIC·MOV)은 해시가 같을 수 없어 대상에서 빠짐

- [ ] **Step 1:** 항목 12c 시험 추가 → ❌ 확인
- [ ] **Step 2:** 구현 → 12c ✅
- [ ] **Step 3:** 커밋 `fix: 중복 건너뜀 원본은 같은 해시 파일이 있을 때만 정리`

### Task 7: ③ 휴지통 없는 드라이브는 _정리완료원본으로 이동

**Files:** Create `lib/platform.js`, Modify `lib/cleaner.js`, `lib/planner.js` (`MOVED_DIR` 건너뛰기), `main.js` (trash-info·trash-originals가 cleaner 호출, `shell.trashItem`을 넘겨줌), `index.html` (확인 창에 드라이브별 방법, 버튼 "🧹 원본 정리")
**Interfaces:**
- `driveKind(p) → Promise<'fixed'|'removable'|'network'|'cdrom'|'unknown'>` — `\\`로 시작하면 network, 드라이브 문자는 PowerShell `Win32_LogicalDisk.DriveType`(2 removable, 3 fixed, 4 network, 5 cdrom), 실패·그 밖은 unknown, 드라이브별로 기억. Windows 아닌 OS는 unknown
- `canUseRecycleBin(kind) → kind === 'fixed'`
- `MOVED_DIR = '_정리완료원본'` (planner.js에서 내보냄)
- `cleanInfo(job, targets, { driveKindOf = driveKind } = {}) → Promise<{ count, bytes, drives: [{ root, kind, method: 'trash'|'move', count, bytes }], warnings: string[] }>` (기존 휴지통 5% 경고 포함)
- `cleanOriginals({ job, store, targets, logger, trash, driveKindOf = driveKind, onProgress }) → Promise<{ trashed, moved, fail, logPath }>` — `fixed`면 `trash(src)`, 아니면 `fs.rename`으로 `job.source\_정리완료원본\<상대 경로>` (이미 있으면 `_1`). store에 `{ trashed: true }` 또는 `{ movedTo }` 기록. 로그 `clean_*.txt`

- [ ] **Step 1:** 항목 12a·b·e·f 시험 추가 → ❌ 확인
- [ ] **Step 2:** 구현 → 항목 12 전체 ✅
- [ ] **Step 3:** 앱을 켜서 원본 정리 확인 창 문구만 확인 (실행 버튼은 누르지 않음)
- [ ] **Step 4:** 커밋 `fix: 휴지통 없는 드라이브는 _정리완료원본으로 이동 (영구 삭제 방지)`

### Task 8: 문서 정리, 최종 점검, 푸시

**Files:** Modify `docs/개발개요-v3.md` (4-0 상태, 4-0-1에 ✅, 열린 질문 4 답, 바로 다음 할 일), `docs/점검-푸시-절차.md` (기록), `README.md` (원본 정리 설명 갱신)

- [ ] **Step 1:** `npm run check` → ❌ 0개 (⏭는 수동 샘플 부분만)
- [ ] **Step 2:** 문서 갱신, 비밀 파일 확인, 커밋 `docs: 안전 수정 결과 반영`
- [ ] **Step 3:** `git push -u origin feature/safety-fixes`, 기록 표 한 줄

---

## 결정할 것 (시작 전에)

1. **원본 정리 로그 이름:** `clean_*.txt` 추천 (명세와 같고, 휴지통과 이동을 둘 다 담음)
2. **중간 커밋:** Task마다 이 PC에만 커밋하고(그 Task 항목 ✅ + 이전 ✅ 유지 확인), **푸시는 전체 ✅일 때 한 번** — 절차 문서의 "점검 통과 후 커밋"을 이렇게 해석해도 되는지
3. **변환 파일 중복(HEIC·MOV)의 원본:** ② 규칙 때문에 정리되지 않고 남음 → 로그에 "확인 필요"로 남기고 사용자가 직접 확인

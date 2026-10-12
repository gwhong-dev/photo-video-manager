# 📸 photo-video-manager

아이폰/아이클라우드에서 받은 사진·영상을 **변환하고, 찍은 날짜로 이름과 폴더를 정리**하는 Windows 데스크톱 프로그램 (Electron)

## 주요 기능

| 기능 | 설명 |
|---|---|
| 🔄 변환 | HEIC → JPG, MOV → MP4 (영상은 재압축 없이 → 빠르고 화질 그대로) |
| 📅 날짜 찾기 | 촬영 정보 → 파일 이름 속 날짜 → 없으면 `_날짜없음` (수정 날짜는 안 씀) |
| 🏷️ 이름 | `2025-03-28_200653_IMG_0433.jpg` (찍은날짜_원본이름) |
| 🗂️ 폴더 | `백업폴더\2025\03\28\` (없으면 새로 만듦) |
| 🕒 파일 날짜 | 만든 날짜/수정한 날짜 = 찍은 날짜 |
| ⏭️ 중복 | 파일 지문(해시) → 애플 고유 ID 비교 → 같으면 건너뜀, 다르면 `_1` |
| ⏸️ 나눠서 작업 | 한 번에 N개(기본 2,000) + 일시정지 + 다음에 켜면 이어하기 |
| 🗑️ 원본 정리 | 회차가 끝날 때마다 물어보고 휴지통으로 (실패한 건 남김) |
| 📝 로그 | 계획 / 실행 / 휴지통 기록을 모두 파일로 저장 |

## 안전 규칙

- 원본은 처리 중에 **절대 안 건드림** (백업 폴더에 새로 만듦)
- 원본 삭제는 **물어본 뒤 휴지통으로만** (결과 파일이 있는 것만)
- `2025년도` 같은 후가공 폴더는 **절대 안 건드림**
- 작업 중 파일은 `이름.__tmp__.jpg` 로 만들었다가 끝나면 진짜 이름으로 → 꺼져도 안전

## 필요한 프로그램 (무료)

| 프로그램 | 용도 | 설치 |
|---|---|---|
| exiftool | 날짜·정보 읽기/쓰기 | exiftool.org → 압축 풀기 (exe + exiftool_files 폴더) |
| ImageMagick | HEIC → JPG | imagemagick.org (설치 때 "Add to PATH" 체크) |
| FFmpeg | MOV → MP4 | `winget install Gyan.FFmpeg` |

프로그램을 켜면 위쪽 🧰 도구 칸에 ✅/❌ 로 보여요. ❌ 이면 **위치 지정** 버튼으로 exe 파일을 골라 주세요.

> 💡 나중에 exe로 만들 때는 `tools\exiftool\`, `tools\imagemagick\`, `tools\ffmpeg\bin\` 에 넣으면 자동으로 찾아요.

## 실행 방법

```
npm install
npm start
```

## 사용 순서

1. 📥 가져올 폴더 / 💾 백업 폴더 선택 (다음부터 기억)
2. 👀 미리보기 → 표로 확인 (아직 아무것도 안 바뀜)
3. ✅ 실행 → N개 처리
4. 끝나면 "원본 휴지통으로 보낼까요?" → 선택
5. 남은 작업은 📌 배너의 **다음 실행** 버튼으로 (프로그램을 껐다 켜도 됨)

## 폴더 구조

```
photo-video-manager
├─ main.js        ← 프로그램의 뇌 (창 + 화면 부탁 처리)
├─ preload.js     ← 화면과 뇌를 이어주는 다리
├─ index.html     ← 화면
├─ lib
│  ├─ exiftool.js ← exiftool 계속 켜 두고 쓰기 (빠름)
│  ├─ tools.js    ← 외부 프로그램 찾기/실행
│  ├─ dates.js    ← 찍은 날짜 찾기
│  ├─ planner.js  ← 미리보기 계획 (이름, 위치, 중복)
│  ├─ processor.js← 파일 1개 처리 (변환 → 날짜 → 저장)
│  └─ job.js      ← 작업 목록 저장 & 이어하기
└─ package.json
```

## 데이터 저장 위치

`%APPDATA%\photo-video-manager\`

- `settings.json` — 폴더 경로, 도구 위치, 한 번에 처리할 개수
- `jobs\` — 진행 중인 작업 (이어하기용)
- `logs\` — `plan_*.txt` / `run_*.txt` / `trash_*.txt`

## 기술 스택

- Electron, Node.js (`fs`, `crypto`, `child_process`)
- exiftool (stay_open 모드), ImageMagick, FFmpeg

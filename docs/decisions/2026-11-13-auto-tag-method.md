# 결정 기록: 사람 / 동물 / 풍경 자동 분류 방식 (조사)

- 날짜: 2026-11-13 · 등급 S (문서만, 코드 변경 없음) · 상태: **조사 끝, 사용자 선택 대기** (5절)
- 조건 (사용자 승인): 유료 클라우드 AI 안 씀, 사진을 인터넷으로 보내지 않고 이 PC 안에서만 처리. 시안 4-1 · 4-2 (갤러리 왼쪽 "PC가 분류한 것" 묶음 · 사진별 확신도 · 틀린 분류 고치기 · 진행바 · 이어하기 · 확신 70% 미만은 보류 목록에서 직접 고르기)
- 표기: **미확인** = 이번 조사에서 출처로 확인 못 함. 처리 시간은 이 PC 에서 재 본 적이 없어 숫자를 쓰지 않음 (측정 방법은 2절 PR 1)
- 사용자 사진은 열지 않았고, 아래 정확도 평가는 모두 "기대치(공개 자료 · 일반 경향)"이지 이 라이브러리에서 잰 값이 아님

## 1. 후보 방식 비교

### 후보 A. CLIP 계열 "글로 물어보는" 분류 (onnxruntime-node, 이 PC 안 실행)
사진 한 장을 숫자 묶음(임베딩)으로 바꾸고, "사람 사진 / 동물 사진 / 풍경 사진 / 기타" 같은 문장의 숫자와 가까운 정도로 분류. 문장 쪽 숫자는 미리 한 번 계산해 앱에 넣어 두면 실행 중엔 이미지 모델만 돈다.
- 정확도 기대치: 한 모델로 네 묶음을 모두 다룸. 사진 전체 분위기(풍경 · 음식 · 문서 · 동물)에 강하고, 사진 구석의 작은 사람 · 애매한 사진(실내 풍경 속 사람 한 명)에서 흔들림. 확신도는 문장 간 상대 비교값이라 "70% 미만 보류" 기준은 실제 사진으로 보정이 필요 (**미확인**: 정확도 수치)
- 모델: OpenAI CLIP ViT-B/32 의 ONNX 변환본 `Xenova/clip-vit-base-patch32` 의 양자화 이미지 모델 약 89.1 MB (원본 606 MB, fp16 304 MB). 출처: [HF 파일 목록 검색 결과](https://huggingface.co/Xenova/clip-vit-base-patch32/tree/main/onnx)
- 라이선스: 원본 OpenAI CLIP 은 MIT 로 확인됨(제3자 변환 카드 기준, 출처 [JONNYVERSE 카드](https://huggingface.co/JONNYVERSE/clip-vit-base-patch32)). Xenova 저장소 자체의 라이선스 표기는 **미확인** → 구현 전 저장소 LICENSE 직접 확인 필요. MIT 이므로 개인 · 상업 모두 가능
- 더 작은 대안 MobileCLIP(양자화 이미지 모델 약 36.7 MB)은 Apple AMLR 라이선스로 **연구 목적만**(출처 [HF apple/MobileCLIP 카드 검색](https://huggingface.co/apple/MobileCLIP-B-LT-OpenCLIP/discussions/3/files)). 이 프로그램은 공개 저장소 + 포트폴리오 용도라 상업 해석 여지가 있어 **쓰지 않음**
- 설치 난이도(Windows + Electron): `onnxruntime-node` 는 미리 빌드된 바이너리를 내려받음(직접 컴파일 불필요). npm 패키지 풀린 크기 약 218 MB (1.21.1 기준, 플랫폼별 분해는 **미확인**), CUDA 바이너리를 건너뛰는 설치 옵션이 README 에 있음. Electron 15+ 지원, 28+ 권장 → 이 프로젝트는 Electron 45 라 범위 안. 출처 [npm](https://npmjs.com/package/onnxruntime-node), [README](https://sources.debian.org/src/onnxruntime/1.23.2%2Bdfsg-6/js/node/README.md). `.node` 는 electron-builder 가 자동 압축 해제(asarUnpack), DLL · `.onnx` 모델은 `asarUnpack` 에 추가해야 함 ([문서](https://www.mintlify.com/electron-userland/electron-builder/concepts/application-contents)). 지금 `sharp` 도 같은 방식(`package.json` build.asarUnpack)이라 폴더형 exe 와 같은 길. 단, 윈도 Smart App Control 이 새 네이티브 DLL 을 막는지는 **미확인**(실제 exe 로 시험 필요)
- 입력: 이미 있는 320px WebP 썸네일(`lib/thumbs.js`)을 `sharp` 로 224×224 로 줄여 쓰면 원본 HEIC 를 다시 디코딩하지 않아도 됨
- CPU 3만 장 처리 시간: **미확인** (이 PC 에서 측정 전). PR 1 에서 샘플 수백 장으로 장당 시간을 재서 3만 장 환산값을 PR 본문에 기록
- 오프라인: 모델 파일을 앱에 넣으면 인터넷 없이 동작. 다만 transformers.js 의 기본 설정은 첫 실행 때 모델을 인터넷에서 받으므로 쓰지 않고, **파일을 직접 넣고 onnxruntime-node 로 읽는다**

### 후보 B. 얼굴 검출 소형 모델 + 장면 분류 모델 조합
사람 = 얼굴 검출(YuNet), 동물 = ImageNet 분류기(MobileNetV2), 풍경 = 장면 분류기(Places365 ResNet18), 순서대로 돌려 합침. 실행은 후보 A 와 같은 onnxruntime-node.
- 정확도 기대치: 사람(얼굴 보이는 경우)은 가장 믿을 만함. 뒷모습 · 작은 얼굴 · 옆모습은 놓칠 수 있음. 동물은 ImageNet 에 개 · 고양이 품종이 많아 강하나 "동물인지"는 여러 클래스를 묶어 판단해야 함. 풍경은 Places365 365개 장면 → 4묶음 대응표를 직접 만들어야 함. 모델 3개의 확신도 척도가 달라 "70%" 하나로 합치기 어려움 (**미확인**: 정확도 수치)
- 모델: YuNet 약 230 KB(229,738 바이트, [HF 검색](https://huggingface.co/pollen-robotics/face_detection_yunet_2026may) · [LearnOpenCV](https://www.learnopencv.com/face-detection-opencv/), 공식 목록 확인은 미확인), MobileNetV2 ONNX 약 14 MB(제3자 설명, [HF Heliosoph](https://huggingface.co/Heliosoph/mobilenetv2-onnx)), Places365 ResNet18 은 공식 ONNX 가 **미확인**(공식은 PyTorch 가중치, 22.8 MB 는 LiteRT fp16 변환본, [출처](https://huggingface.co/litert-community/Places365-ResNet18-LiteRT)) → 직접 ONNX 변환해야 함
- 라이선스: YuNet MIT(OpenCV Zoo README, 출처 [HF](https://huggingface.co/opencv/face_detection_yunet/blob/main/README.md)), MobileNetV2 Apache-2.0(제3자 표기, 미확인), Places365 가중치는 CC BY(출처 표기 필요, 소스마다 달라 LICENSE 확인 필요). 얼굴 쪽 다른 후보 SCRFD(InsightFace)는 비상업 연구용 표기가 있어 제외(2차 출처, [HF](https://huggingface.co/mudler/face-detect-gguf))
- 설치 난이도: 런타임은 A 와 같음. 모델 3개 확보 · 변환 · 라이선스 3종 관리가 더 번거로움
- 처리 시간: 모델 3번 실행이라 A 보다 장당 느릴 가능성이 크지만 **미확인** (YuNet 은 매우 작음)
- 오프라인: 가능

### 후보 C. Electron 안에서 transformers.js / onnxruntime-web (브라우저 방식)
화면 쪽(React)에서 WebAssembly 로 같은 CLIP 모델을 돌림.
- 정확도 · 모델 · 라이선스: A 와 같은 모델을 쓸 수 있음 (같은 값)
- 설치 난이도: 네이티브 모듈은 필요 없음. 대신 화면 창을 오래 붙잡고 돌려야 하고, 창 · 네트워크 막기(`lib/window-guard.js` · `lib/map-net.js`)와 부딪힘. 모델 로딩이 기본적으로 인터넷 경로(캐시)를 전제
- 처리 시간: WebAssembly 는 보통 네이티브 런타임보다 느림 (이 PC 에서 측정 전, **미확인**)
- 오프라인: 설정을 막아야 가능

## 2. 추천과 버린 안

**추천: 후보 A (CLIP ViT-B/32 양자화 + onnxruntime-node, 메인 프로세스 별도 작업)**
- 이유 ① 모델 하나, 확신도 하나 → 시안의 "확신 70% 미만 보류"를 그대로 구현 가능
  ② 분류 이름을 문장으로 정하므로 "사람 · 동물 · 풍경 · 기타"를 나중에 "음식 · 문서 · 스크린샷" 등으로 늘릴 때 모델 교체 없이 문장 숫자만 다시 계산
  ③ MIT 라 저장소 공개 · 포트폴리오에도 안전
  ④ `sharp` 와 같은 배포 방식(asarUnpack)이라 폴더형 exe 흐름에 맞음
  ⑤ 앱에 있는 썸네일로 입력을 만들어 사진 원본을 거의 다시 읽지 않음 (외장 HDD 부담 적음)
- 위험: 실제 정확도 · 처리 시간 · exe 에서 DLL 이 막히는지가 **미확인**. 그래서 구현 첫 PR 을 "측정"으로 잡음 (3절)
- 얼굴이 꼭 필요해지면 나중에 YuNet(230 KB)만 보조로 얹을 수 있음 (후보 B 의 일부만 가져옴)

**버린 안**
- B 전체: 모델 3개 · 라이선스 3종 · 확신도 3척도라 관리 부담 ↔ 이득이 작음 (사람 정확도만 좋음)
- C: 창에 매여 오래 돌리기 어렵고 보안 막기와 부딪힘, 속도 불리 예상
- MobileCLIP: 연구용 라이선스
- InsightFace/SCRFD: 비상업 표기
- 유료 클라우드 AI · 사진을 서버로 보내는 방식: 조건 위반

## 3. 저장 초안 (코드는 아직 안 바꿈, `lib/db.js` 를 읽고 쓴 것)

현재 구조 읽은 결과: `tags`(이름) · `file_tags`(file_id, tag_id, source) 가 보이는 태그, `manual_tags`(path, root, name)가 "내가 붙인 태그" 원본. 파일을 다시 읽을 때마다 `file_tags` 는 지워 다시 만들고(db.js 495~501 근처) `manual_tags` 에서 `source='manual'` 로 복구. `photo_hashes` 는 경로 + 크기 + 수정 시각이 같을 때만 유효한 "언제든 다시 만들 수 있는 값" 표이고 구조 버전은 올리지 않음(`SCHEMA_VERSION = 2` 유지).

**제안: `file_tags` 에 넣지 않고 새 표 `auto_classes` 를 `photo_hashes` 와 같은 방식으로 추가**
```
auto_classes (
  path TEXT PRIMARY KEY,      -- files 와 경로로 이음 (다시 읽어도 유지)
  root TEXT NOT NULL,
  size INTEGER NOT NULL,      -- 파일이 바뀌면 다시 분류하려고 (photo_hashes 와 같은 방식)
  mtime_ms INTEGER NOT NULL,
  kind TEXT,                  -- 'person' | 'animal' | 'landscape' | 'other' (분류 못 하면 NULL)
  score REAL,                 -- 0~1 확신도
  model TEXT NOT NULL,        -- 모델 · 문장 버전 (바뀌면 일부만 다시 분류)
  classified_at TEXT NOT NULL,
  user_kind TEXT              -- 사용자가 고친 분류. 있으면 kind 보다 우선, 다시 분류해도 덮어쓰지 않음
)
```
- 이유: (1) `file_tags` 에 넣으면 다시 읽기마다 지워지고 태그 목록 · 장수 세기(`tagCount`, `manualTags`)에 섞여 "내가 붙인 태그"와 구분이 깨짐 (2) 시안의 "PC가 분류한 것"은 따로 묶음이라 별도 표가 자연스러움 (3) 구조 버전을 안 올려 옛 빌드도 이 표를 모르고 지나감 (`photo_hashes` · `manual_tags` 와 같은 이유)
- 사용자가 고친 값(`user_kind`)은 `manual_tags` 처럼 DB 가 지워져도 되살릴 수 있게 기록 파일(`manual-journal.js` 방식)에 남길지는 사용자 선택 (5절 ④)
- "이어하기": 분류가 아직 안 된 사진 = `files LEFT JOIN auto_classes` 에서 줄이 없거나 크기 · 수정 시각 · model 이 다른 것. 진행바 = 분류된 수 / 전체 사진 수. 별도 진행 상태 표 불필요
- "보류 목록": `score < 0.7 AND user_kind IS NULL` (기준값은 실제 사진으로 보정, 5절 ③)
- 사진 수가 많아 색인 필요: `(root, kind)`

## 4. PR 분할과 등급 (CLAUDE.md 4절 기준)

| 순서 | 내용 | 등급 | 근거 |
|---|---|---|---|
| 1 | 측정용 PR: `onnxruntime-node` 추가, 모델 파일 넣는 곳 · 설치 확인 스크립트, 샘플 사진(자동 샘플 `test/samples/auto`)으로 장당 시간 · 대략 정확도 측정, 폴더형 exe 에서 DLL 이 도는지 | **L** | `package.json` · `package-lock.json` (의존성), 배포(asarUnpack, 필요 시 `scripts/build-exe.bat` 확인) |
| 2 | DB: `auto_classes` 표 추가 + 읽기 · 쓰기 함수 + 점검 항목 | **L** | `lib/db.js` (DB 구조) |
| 3 | 분류 작업 본체: 썸네일 → 입력 → 분류 → 저장, 백그라운드 · 진행 · 이어하기 · 멈추기 | M | 새 `lib/` 파일 + `main.js` 연결 (휴지통 · 정리 연결은 안 건드림). 네트워크로 모델을 받지 않음을 확인하는 점검 포함 |
| 4 | 화면: 갤러리 왼쪽 "PC가 분류한 것" 묶음 · 확신도 표시 · 실행 화면(진행바) | M | `src/` |
| 5 | 틀린 분류 고치기 + 확신 70% 미만 보류 목록 직접 고르기 (`user_kind` 저장) | M | `src/` + 저장 함수. 고친 값 기록 파일 방식을 고르면 `lib/` 파일 추가 (경로가 L 목록이면 L) |
- 1 → 2 순서 고정(1 에서 방식이 안 맞으면 여기서 멈춤). 3 은 2 에 기대고, 4 · 5 는 3 에 기댐. 2 와 3 의 일부는 같은 파일을 만지지 않으므로 병렬 가능하나 같은 PC 에서 `npm run check` 는 2개 이하
- L 은 PR 까지 만들고 사용자 "머지" 승인 뒤 머지
- 이 앞 단계(방식 선택)는 이 문서가 끝. 선택이 바뀌면 PR 1 부터 다시 정함

## 5. 사용자가 골라야 할 것
1. **방식**: 추천 A(CLIP 한 모델) 로 갈지, 사람 정확도를 위해 B(얼굴 + 장면) 로 갈지
2. **분류 묶음**: 사람 · 동물 · 풍경 · 기타 네 개로 시작할지 (A 면 나중에 문장만 늘려 음식 · 문서 등 추가 가능). "사람이 있는 풍경"처럼 겹칠 때 한 가지만 줄지, 여러 개 붙일지
3. **70% 기준**: 시안대로 70% 로 시작하되, CLIP 확신도는 상대값이라 실제 사진으로 보정 후 바뀔 수 있음을 받아들일지 (PR 1 측정 결과를 보고 다시 정해도 됨)
4. **고친 분류 보관**: DB 에만 둘지, 태그 기록처럼 별도 파일에도 남겨 DB 를 새로 만들어도 살릴지 (갤러리 DB 는 백업 폴더별이라 폴더를 옮기면 따라오지 않음)
5. **처리 시점과 시간**: 3만 장을 한 번에 돌릴지 (처리 시간은 PR 1 측정 뒤 확정, 지금 **미확인**), 아니면 갤러리에서 보이는 것부터 / 한가할 때 자동으로
6. **앱 크기**: 모델 약 89 MB + onnxruntime 바이너리가 폴더형 exe 에 늘어나도 괜찮은지 (정확한 증가량은 **미확인**, PR 1 에서 측정해 보고)
7. **영상**: 영상은 대표 장면(썸네일)으로 같이 분류할지, 사진만 할지

## 출처 (확인일 2026-11-13)
- https://huggingface.co/Xenova/clip-vit-base-patch32/tree/main/onnx
- https://huggingface.co/JONNYVERSE/clip-vit-base-patch32
- https://huggingface.co/apple/MobileCLIP-B-LT-OpenCLIP/discussions/3/files
- https://npmjs.com/package/onnxruntime-node
- https://sources.debian.org/src/onnxruntime/1.23.2%2Bdfsg-6/js/node/README.md
- https://www.mintlify.com/electron-userland/electron-builder/concepts/application-contents
- https://huggingface.co/opencv/face_detection_yunet/blob/main/README.md
- https://www.learnopencv.com/face-detection-opencv/
- https://huggingface.co/litert-community/Places365-ResNet18-LiteRT
- https://huggingface.co/Heliosoph/mobilenetv2-onnx
- https://huggingface.co/mudler/face-detect-gguf

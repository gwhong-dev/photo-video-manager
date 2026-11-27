// 파일 위치: lib/similar-ai.js
// 역할: PC 안 AI 로 사진 특징값(임베딩) 만들기 — "비슷한 사진"의 같은 장면 가리기 (2026-11-16 사용자 승인, ④)
//   - 모델: OpenAI CLIP ViT-B/32 이미지 부분의 ONNX 양자화본 (Xenova/clip-vit-base-patch32, MIT, 89MB)
//     나중에 사람 / 동물 / 풍경 자동 분류가 같은 특징값을 다시 써요 (docs/decisions/2026-11-13-auto-tag-method.md 추천 A)
//   - 실행: onnxruntime-node (PC 안, CPU). 유료 클라우드 AI 를 쓰지 않고 사진을 인터넷으로 보내지 않아요
//   - 모델 파일은 앱에 넣지 않고, 사용자가 화면에서 확인을 누르면 정해진 주소 하나에서 한 번 받아요 (2026-11-16 사용자 결정)
//     받은 파일은 SHA-256 이 맞을 때만 설정 폴더 models\ 에 둬요. 나가는 것은 파일 요청뿐 (사진 · 파일 이름 · 폴더 경로 없음)
//     자동으로 다시 받지 않아요 (실패하면 사용자가 다시 눌러요). 로그에는 상태 코드 · 오류 이름만
//   - 입력: 갤러리 썸네일(긴 변 320px)을 224×224 로 가운데 맞춰 자른 것 (사진 원본은 다시 읽지 않아요)
//   - 저장: 512칸 단위 벡터를 -127~127 정수(1바이트)로 줄여 photo_embeds 표에 (한 장 512바이트, 5.5만 장 약 28MB)
//   - Electron은 쓰지 않아요 (lib/ 규칙). fetch 는 밖에서 받아요 (gallery-main.js 가 net.fetch 를 넘겨요)
//
// 모양
//   MODEL: { id, file, url, sha256, bytes, label }
//   modelPath(base) → 설정 폴더 안 모델 파일 경로
//   modelReady(base) → 모델 파일이 있고 크기가 맞는지
//   downloadModel({ fetchImpl, base, onProgress(got, total), timeoutMs, signal }) → Promise<경로> (실패는 사람이 읽을 글자의 Error)
//     signal: 프로그램을 끌 때 받기를 멈추는 신호. 지난번에 끊겨 남은 임시 파일은 받기 시작할 때 치워요
//   verifyModel(base) → Promise<boolean> 모델 파일 SHA-256 이 맞는지. 다르면 파일을 옆 이름(.broken-시각)으로 치워요 (다시 받게)
//   toInt8(Float32Array) → Buffer(512), cosine(a, b) → -1~1 (Buffer/Int8Array 끼리)
//   createEmbedder({ db, thumbs, base, loadSession, inputOf, threads }) → { run(root, onProgress, { readyOnly, isBusy }) → Promise<{ made, failed, skipped }>, stop() }
//     loadSession(모델 경로, 스레드 수) → Promise<{ run(Float32Array 3×224×224) → Promise<Float32Array 512>, release() }> (기본 onnxruntime-node)
//     inputOf(썸네일 경로) → Promise<Float32Array> (기본 sharp)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODEL = {
  id: 'clip-vit-b32-q8', // 바뀌면 특징값을 다시 만들어요
  file: 'clip-vit-base-patch32-vision-quantized.onnx',
  url: 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx',
  sha256: '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299',
  bytes: 89117001,
  label: 'CLIP ViT-B/32 이미지 모델 (MIT)',
};
const SIZE = 224; // 모델 입력 크기
const MEAN = [0.48145466, 0.4578275, 0.40821073]; // CLIP 입력 맞추기 값 (preprocessor_config.json)
const STD = [0.26862954, 0.26130258, 0.27577711];
const EMBED_BATCH = 8; // 한 번에 할 일로 가져오는 수 (한 장씩 차례로 돌려요)
const THREADS = 2; // 뒤에서 조용히 (2스레드 한 장 약 60ms, 5.5만 장 약 55분 실측)
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000; // 받기 제한시간 20분
const BUSY_WAIT_MS = 500;
const PROGRESS_GAP_MS = 1500;

const modelDir = (base) => path.join(base, 'models');
const modelPath = (base) => path.join(modelDir(base), MODEL.file);

function modelReady(base) {
  try {
    return fs.statSync(modelPath(base)).size === MODEL.bytes;
  } catch (e) {
    return false;
  }
}

// 모델 받기: 임시 이름으로 받으면서 SHA-256 을 재고, 크기와 SHA-256 이 맞을 때만 진짜 이름으로 바꿔요
// 지난번에 끊겨 남은 임시 파일 치우기 (이 모델 이름의 .tmp- 파일만)
function sweepTemp(base) {
  let names = [];
  try {
    names = fs.readdirSync(modelDir(base));
  } catch (e) {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(`${MODEL.file}.tmp-`)) continue;
    try { fs.rmSync(path.join(modelDir(base), n), { force: true }); } catch (e) { /* 잡혀 있으면 다음에 */ }
  }
}

async function downloadModel({ fetchImpl, base, onProgress, timeoutMs = DOWNLOAD_TIMEOUT_MS, signal }) {
  if (typeof fetchImpl !== 'function') throw new Error('인터넷 연결을 쓸 수 없어요');
  fs.mkdirSync(modelDir(base), { recursive: true });
  sweepTemp(base);
  const dest = modelPath(base);
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  const timeout = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetchImpl(MODEL.url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'follow' });
  } catch (e) {
    throw new Error('AI 모델을 받지 못했어요. 인터넷 연결을 확인한 뒤 다시 눌러 주세요.');
  }
  if (!res || !res.ok || !res.body) throw new Error(`AI 모델을 받지 못했어요 (HTTP ${res ? res.status : '없음'}). 잠시 뒤 다시 눌러 주세요.`);
  const hash = crypto.createHash('sha256');
  const out = fs.openSync(tmp, 'w');
  let got = 0;
  let lastNote = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > MODEL.bytes) throw new Error('받은 파일이 예상보다 커요');
      hash.update(value);
      fs.writeSync(out, value);
      if (onProgress && Date.now() - lastNote > 300) {
        lastNote = Date.now();
        try { onProgress(got, MODEL.bytes); } catch (e) { /* 알림 실패는 무시 */ }
      }
    }
    fs.closeSync(out);
    const sum = hash.digest('hex');
    if (got !== MODEL.bytes || sum !== MODEL.sha256) throw new Error('받은 파일이 원래 모델과 달라요');
    fs.renameSync(tmp, dest);
    if (onProgress) {
      try { onProgress(got, MODEL.bytes); } catch (e) { /* 무시 */ }
    }
    return dest;
  } catch (e) {
    try { fs.closeSync(out); } catch (e2) { /* 이미 닫힘 */ }
    try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* 임시 파일 */ }
    const why = e && /예상보다|원래 모델/.test(e.message) ? e.message : '받는 중에 끊겼어요';
    throw new Error(`AI 모델을 받지 못했어요 (${why}). 다시 눌러 주세요.`);
  }
}

// 모델 파일이 원래 것인지 (크기 · SHA-256). 다르면 옆 이름으로 치워서 화면에 "받기"가 다시 보이게 해요
async function verifyModel(base) {
  const file = modelPath(base);
  try {
    if (fs.statSync(file).size !== MODEL.bytes) throw new Error('크기');
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', resolve).on('error', reject);
    });
    if (hash.digest('hex') === MODEL.sha256) return true;
  } catch (e) {
    if (!fs.existsSync(file)) return false;
  }
  try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch (e) { /* 못 치우면 그대로 (다음 실행에 다시 확인) */ }
  return false;
}

// ---------- 특징값 ----------
// 단위 벡터 → -127~127 정수 (코사인 계산은 거의 그대로예요)
function toInt8(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  const n = Math.sqrt(s) || 1;
  const out = Buffer.alloc(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const v = Math.max(-127, Math.min(127, Math.round((vec[i] / n) * 127)));
    out.writeInt8(v, i);
  }
  return out;
}

const asInt8 = (b) => (b instanceof Int8Array ? b : new Int8Array(b.buffer, b.byteOffset, b.byteLength));

// 두 특징값의 코사인 유사도 (같은 장면일수록 1에 가까워요). 모양이 틀리면 null
function cosine(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return null;
  const x = asInt8(a);
  const y = asInt8(b);
  let dot = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < x.length; i++) {
    dot += x[i] * y[i];
    nx += x[i] * x[i];
    ny += y[i] * y[i];
  }
  if (!nx || !ny) return null;
  return dot / Math.sqrt(nx * ny);
}

// 썸네일 → 모델 입력 (가운데 224×224, RGB 채널별로 맞춤)
async function sharpInput(thumbPath) {
  const sharp = require('sharp');
  const { data } = await sharp(thumbPath).removeAlpha().resize(SIZE, SIZE, { fit: 'cover', kernel: 'cubic' }).raw().toBuffer({ resolveWithObject: true });
  const plane = SIZE * SIZE;
  const t = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) t[c * plane + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  return t;
}

// onnxruntime-node 로 모델 열기 (처음 쓸 때만 불러와요. 앱을 켤 때 느려지지 않게)
async function ortSession(file, threads) {
  const ort = require('onnxruntime-node');
  const sess = await ort.InferenceSession.create(file, { graphOptimizationLevel: 'all', intraOpNumThreads: threads, interOpNumThreads: 1, executionProviders: ['cpu'] });
  return {
    async run(input) {
      const x = new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]);
      const out = await sess.run({ pixel_values: x });
      return out.image_embeds.data;
    },
    async release() {
      try { await sess.release(); } catch (e) { /* 이미 닫힘 */ }
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createEmbedder({ db, thumbs, base, loadSession = ortSession, inputOf = sharpInput, threads = THREADS }) {
  let stopped = false;
  let running = null;

  async function pass(root, onProgress, { readyOnly = false, isBusy = () => false } = {}) {
    const count = { made: 0, failed: 0, skipped: 0 };
    if (!modelReady(base)) return count;
    let session = null;
    let after = null; // 지난 묶음의 마지막 자리 (최근 촬영일부터 나아가요)
    let lastNote = 0;
    try {
      while (!stopped) {
        if (isBusy()) { // 가져오기 중이면 쉬어요
          await sleep(BUSY_WAIT_MS);
          continue;
        }
        const jobs = db.embedJobs(root, EMBED_BATCH, after, MODEL.id, { readyOnly });
        if (!jobs.length) break;
        after = db.jobCursor(jobs);
        if (!session) session = await loadSession(modelPath(base), threads); // 할 일이 있을 때만 모델을 열어요 (약 270MB)
        for (const f of jobs) {
          if (stopped) break;
          let thumb = null;
          try {
            thumb = await thumbs.request(f.id);
          } catch (e) {
            thumb = null;
          }
          if (!thumb) {
            const now = db.getFile(f.id);
            if (now && now.thumbState === 'failed') {
              db.setEmbed(f.path, f.size, f.mtimeMs, MODEL.id, null);
              count.failed++;
            } else count.skipped++;
            continue;
          }
          let input = null;
          try {
            input = await inputOf(thumb);
          } catch (e) {
            count.skipped++; // 썸네일이 잠깐 잠김 → 다음 회차에 다시
            continue;
          }
          if (stopped) break;
          let vec = null;
          try {
            vec = await session.run(input);
          } catch (e) {
            vec = null;
          }
          if (stopped) break; // 끄는 중이면 DB 에 쓰지 않아요 (DB 가 먼저 닫혀요)
          if (vec) {
            db.setEmbed(f.path, f.size, f.mtimeMs, MODEL.id, toInt8(vec));
            count.made++;
          } else {
            db.setEmbed(f.path, f.size, f.mtimeMs, MODEL.id, null);
            count.failed++;
          }
        }
        if (onProgress && Date.now() - lastNote >= PROGRESS_GAP_MS) {
          lastNote = Date.now();
          try { onProgress(db.embedProgress(root, MODEL.id)); } catch (e) { /* 무시 */ }
        }
      }
    } finally {
      if (session) await session.release(); // 다 끝나면 메모리를 돌려줘요
    }
    return count;
  }

  function run(root, onProgress, opts) {
    if (stopped) return Promise.resolve({ made: 0, failed: 0, skipped: 0 });
    if (running) return running;
    const p = pass(root, onProgress, opts);
    running = p;
    const clear = () => { if (running === p) running = null; };
    p.then(clear, clear);
    return p;
  }

  async function stop() {
    stopped = true;
    if (running) await running.catch(() => {});
  }

  return { run, stop };
}

module.exports = { MODEL, modelPath, modelReady, downloadModel, verifyModel, toInt8, cosine, createEmbedder, sharpInput };


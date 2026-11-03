// 파일 위치: lib/similar.js
// 역할: 비슷한 사진 묶기 (단계 4, docs/개발개요-v3.md 4-2)
//   - 지문(dHash): 썸네일을 흑백 9×8로 줄이고, 옆 칸보다 밝으면 1 → 64칸 (16글자 16진수). PC 안에서만 계산해요
//   - 묶는 규칙 (둘 중 하나면 같은 묶음, 이어지면 한 묶음)
//       ① 시간: 찍은 시각이 3초 안이고, 두 지문이 다 있으면 거리 24 이하 (전혀 다른 장면을 3초 안에 찍은 것은 빼요)
//       ② 모양: 날짜와 상관없이 지문 거리 6 이하 (필터만 다른 사진, 복사본)
//          거의 한 색인 사진(지문의 1이 2개 이하 또는 62개 이상)은 모양으로 묶지 않아요 (까만 화면끼리 묶이지 않게)
//   - 남길 사진(처음 선택): 가로×세로가 가장 큰 것 → 파일 크기가 큰 것 → 먼저 찍은 것 → 번호가 작은 것
//   - 사진 파일은 읽기만 해요 (지문은 썸네일 파일에서 계산). 버리기는 이 파일이 하지 않아요
//   - Electron은 쓰지 않아요 (lib/ 규칙)
//
// 모양
//   dhashOf(gray9x8: Buffer 72바이트) → '0123456789abcdef'
//   distance(a, b) → 0~64 (다른 칸 수)
//   buildGroups(rows, opts) → [{ ids: [...], keepId, takenAt }] (2장 이상인 묶음만, 최근 것부터)
//     rows: db.similarRows() 모양 [{ id, name, takenAt, width, height, size, model, dhash }]
//   createHasher({ db, thumbs, grayOf }) → { run(root, onProgress) → Promise<{ made, failed, skipped }>, stop() }
//     thumbs.request(id) → 썸네일 경로|null (lib/thumbs.js). grayOf(경로) → Promise<Buffer 72바이트> (기본 sharp)

const TIME_GAP_SEC = 3; // 연속 촬영으로 보는 간격 (개발개요 열린 질문 3: 3초로 시작)
const TIME_MAX_DIST = 24; // 시간으로 묶을 때도 이보다 다르면 다른 장면
const SHAPE_MAX_DIST = 6; // 날짜와 상관없이 모양만으로 묶는 거리
const FLAT_BITS = 2; // 지문의 1이 이만큼 이하(또는 64-이만큼 이상)면 거의 한 색 → 모양으로 묶지 않음
const HASH_BATCH = 16; // 지문을 한 번에 만드는 수
const BUCKET_LIMIT = 2000; // 모양 비교 열쇠 하나에 이보다 많으면 건너뜀 (2000장끼리 비교 = 약 200만 번)

// ---------- 지문 ----------
// 흑백 9×8 픽셀(가로 9, 세로 8) → 각 줄에서 왼쪽이 오른쪽보다 밝으면 1
function dhashOf(gray) {
  if (!gray || gray.length < 72) throw new Error('지문 계산용 그림 크기가 맞지 않아요');
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) {
      const i = y * 9 + x;
      byte = (byte << 1) | (gray[i] > gray[i + 1] ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

// 1의 개수 (32비트 정수)
function popcount32(n) {
  let v = n >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

const validHash = (h) => typeof h === 'string' && /^[0-9a-f]{16}$/.test(h);
const halves = (h) => [parseInt(h.slice(0, 8), 16), parseInt(h.slice(8), 16)];

// 두 지문의 다른 칸 수
function distance(a, b) {
  const [a1, a2] = halves(a);
  const [b1, b2] = halves(b);
  return popcount32(a1 ^ b1) + popcount32(a2 ^ b2);
}

// 'YYYY-MM-DDTHH:MM:SS' → 초 (시간대는 무시. 같은 기기의 연속 촬영 간격만 보면 돼요). 모양이 틀리면 null
function secondsOf(takenAt) {
  const m = typeof takenAt === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(takenAt);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
}

// ---------- 묶기 ----------
// 남길 사진 고르기: 가로×세로 → 파일 크기 → 먼저 찍은 것 → 번호
function pickKeep(members) {
  const area = (r) => (Number(r.width) > 0 && Number(r.height) > 0 ? r.width * r.height : 0);
  const t = (r) => {
    const s = secondsOf(r.takenAt);
    return s === null ? Infinity : s;
  };
  return [...members].sort((a, b) => area(b) - area(a) || (b.size || 0) - (a.size || 0) || t(a) - t(b) || a.id - b.id)[0];
}

function buildGroups(rows, opts = {}) {
  const gapSec = opts.timeGapSec ?? TIME_GAP_SEC;
  const timeMax = opts.timeMaxDist ?? TIME_MAX_DIST;
  const shapeMax = opts.shapeMaxDist ?? SHAPE_MAX_DIST;
  const list = rows.filter((r) => r && Number.isSafeInteger(r.id));
  const n = list.length;
  // 합치기 표 (union-find): 이어진 사진들을 한 묶음으로
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const join = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const hashOk = list.map((r) => validHash(r.dhash));

  // ① 시간: 찍은 시각 순으로 늘어놓고 바로 앞 사진과 3초 안이면 이어요
  const timed = [];
  for (let i = 0; i < n; i++) {
    const s = secondsOf(list[i].takenAt);
    if (s !== null) timed.push({ i, s });
  }
  timed.sort((a, b) => a.s - b.s || list[a.i].id - list[b.i].id);
  for (let k = 1; k < timed.length; k++) {
    const a = timed[k - 1];
    const b = timed[k];
    if (b.s - a.s > gapSec) continue;
    if (hashOk[a.i] && hashOk[b.i] && distance(list[a.i].dhash, list[b.i].dhash) > timeMax) continue;
    join(a.i, b.i);
  }

  // ② 모양: 64칸을 8칸씩 8조각으로 나눠요. 거리가 6 이하면 8조각 중 적어도 2조각은 똑같아요
  //    → "조각 두 개" 짝을 열쇠로 같은 열쇠끼리만 비교해요 (6만 장도 전부 짝지어 비교하지 않아요)
  //    한 열쇠에 사진이 너무 많으면(BUCKET_LIMIT, 밋밋한 그림이 흔한 값) 그 열쇠는 건너뛰어요. 다른 짝 열쇠에서 대부분 만나요
  if (shapeMax <= 6) {
    // 지문을 숫자 두 개로 미리 바꿔 둬요 (비교할 때마다 글자를 읽지 않게)
    const hi = new Int32Array(n);
    const lo = new Int32Array(n);
    let count = 0;
    const use = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!hashOk[i]) continue;
      const [h1, h2] = halves(list[i].dhash);
      const ones = popcount32(h1) + popcount32(h2);
      if (ones <= FLAT_BITS || ones >= 64 - FLAT_BITS) continue;
      hi[i] = h1;
      lo[i] = h2;
      use[i] = 1;
      count++;
    }
    // 열쇠 × 2^24 + 사진 순번 을 한 숫자로 만들어 정렬하면, 같은 열쇠끼리 붙어서 나와요 (Map보다 훨씬 빨라요)
    const PAIRS = 28;
    const packed = new Float64Array(count * PAIRS);
    let k = 0;
    const bytes = new Array(8);
    for (let i = 0; i < n; i++) {
      if (!use[i]) continue;
      for (let c = 0; c < 4; c++) {
        bytes[c] = (hi[i] >>> (24 - c * 8)) & 0xff;
        bytes[c + 4] = (lo[i] >>> (24 - c * 8)) & 0xff;
      }
      let pair = 0;
      for (let a = 0; a < 8; a++) {
        for (let b = a + 1; b < 8; b++) {
          const key = pair * 65536 + bytes[a] * 256 + bytes[b];
          packed[k++] = key * 16777216 + i;
          pair++;
        }
      }
    }
    packed.sort();
    const near = (x, y) => popcount32(hi[x] ^ hi[y]) + popcount32(lo[x] ^ lo[y]) <= shapeMax;
    for (let from = 0; from < k;) {
      const key = Math.floor(packed[from] / 16777216);
      let to = from + 1;
      while (to < k && Math.floor(packed[to] / 16777216) === key) to++;
      const size = to - from;
      if (size >= 2 && size <= BUCKET_LIMIT) {
        for (let x = from; x < to; x++) {
          const ix = packed[x] % 16777216;
          for (let y = x + 1; y < to; y++) {
            const iy = packed[y] % 16777216;
            if (near(ix, iy) && find(ix) !== find(iy)) join(ix, iy);
          }
        }
      }
      from = to;
    }
  }

  // 묶음으로 모으기 (2장 이상만)
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(list[i]);
  }
  const out = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => {
      const sa = secondsOf(a.takenAt);
      const sb = secondsOf(b.takenAt);
      return (sa ?? Infinity) - (sb ?? Infinity) || a.id - b.id;
    });
    const keep = pickKeep(members);
    const firstTaken = sorted.find((r) => secondsOf(r.takenAt) !== null);
    out.push({ ids: sorted.map((r) => r.id), keepId: keep.id, takenAt: firstTaken ? firstTaken.takenAt : null });
  }
  // 최근 것부터, 날짜 없는 묶음은 맨 뒤, 같으면 첫 번호
  out.sort((a, b) => {
    if (a.takenAt === b.takenAt) return a.ids[0] - b.ids[0];
    if (a.takenAt === null) return 1;
    if (b.takenAt === null) return -1;
    return a.takenAt < b.takenAt ? 1 : -1;
  });
  return out;
}

// ---------- 지문 만들기 (썸네일에서) ----------
async function sharpGray(thumbPath) {
  const sharp = require('sharp');
  return sharp(thumbPath).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
}

function createHasher({ db, thumbs, grayOf = sharpGray }) {
  let stopped = false;
  let running = null;

  async function pass(root, onProgress) {
    // 번호 순서로 앞으로만 나아가요. 썸네일을 못 얻은 사진(원본을 읽을 수 없음 등)은 이번 회차엔 다시 안 잡아요
    let lastId = 0;
    let made = 0;
    let failed = 0;
    let skipped = 0;
    while (!stopped) {
      const jobs = db.hashJobs(root, HASH_BATCH, lastId);
      if (!jobs.length) break;
      lastId = jobs[jobs.length - 1].id;
      await Promise.all(jobs.map(async (f) => {
        let thumb = null;
        try {
          thumb = await thumbs.request(f.id);
        } catch (e) {
          thumb = null;
        }
        if (stopped) return;
        if (!thumb) {
          // 썸네일이 "만들 수 없음"으로 끝났으면 지문도 없음으로 적어요. 원본을 못 읽은 경우는 적지 않고 다음에 다시
          const now = db.getFile(f.id);
          if (now && now.thumbState === 'failed') {
            db.setHash(f.path, f.size, f.mtimeMs, null);
            failed++;
          } else {
            skipped++;
          }
          return;
        }
        let gray = null;
        try {
          gray = await grayOf(thumb);
        } catch (e) {
          // 썸네일을 그 사이 지웠거나 잠깐 잠긴 경우도 있어요 → 없음으로 적지 않고 다음 회차에 다시
          skipped++;
          return;
        }
        if (stopped) return;
        try {
          db.setHash(f.path, f.size, f.mtimeMs, dhashOf(gray));
          made++;
        } catch (e) {
          db.setHash(f.path, f.size, f.mtimeMs, null);
          failed++;
        }
      }));
      if (onProgress) {
        try {
          onProgress(db.hashProgress(root));
        } catch (e) { /* 알림 실패는 무시 */ }
      }
    }
    return { made, failed, skipped };
  }

  // 같은 때 두 번 부르면 돌고 있는 것을 돌려줘요
  function run(root, onProgress) {
    if (stopped) return Promise.resolve({ made: 0, failed: 0, skipped: 0 });
    if (running) return running;
    const p = pass(root, onProgress);
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

module.exports = { dhashOf, distance, buildGroups, pickKeep, createHasher, secondsOf, TIME_GAP_SEC, SHAPE_MAX_DIST, TIME_MAX_DIST };

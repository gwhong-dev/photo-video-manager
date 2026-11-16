// 파일 위치: lib/similar.js
// 역할: 비슷한 사진 묶기 (단계 4, docs/개발개요-v3.md 4-2)
//   - 지문(dHash): 썸네일을 흑백 9×8로 줄이고, 옆 칸보다 밝으면 1 → 64칸 (16글자 16진수). PC 안에서만 계산해요
//   - 묶는 규칙 (둘 중 하나면 같은 묶음, 이어지면 한 묶음)
//       ① 시간: 묶음의 마지막 사진과 3초 안이고, 그 묶음의 남길 사진과 지문 거리 24 이하 (장면이 바뀌면 새 묶음)
//          지문이 없는 사진은 3초 안의 가장 가까운 지문 있는 사진 한 장에만 붙어요 (두 묶음을 잇지 않아요)
//       ② 모양: 날짜와 상관없이 지문 거리 6 이하 (필터만 다른 사진, 복사본)
//          거의 한 색인 사진(지문의 1이 2개 이하 또는 62개 이상)은 모양으로 묶지 않아요 (까만 화면끼리 묶이지 않게)
//       ③ 이어 찍기 (2026-11-16 사용자 결정): 같은 날, 같은 기기(model)로 앞 사진과 60초 안에 찍은 사진들 (사슬로 이어져요)
//          지문으로는 못 가리는 같은 장면 여러 장(예: 안경 사진 5장, 간격 2·4·11·15초)을 한 묶음 후보로 보여 줘요
//          ①②로 만든 묶음과 겹치면 하나로 합쳐요
//          PC 안 AI 특징값(vec, lib/similar-ai.js)이 두 사진 모두 있고 유사도 0.78 이상일 때만 이어요 (장면이 같을 때만)
//          특징값이 없으면(모델을 아직 안 받음 · 아직 안 만듦) 이어 찍기로 잇지 않고 ①②만 써요 (2026-11-16 실사용 지적:
//          시간만으로 묶으면 피규어 두 장 · 꽃과 거울 공처럼 다른 장면이 한 묶음이 됨)
//          G: 실측: 같은 장면 이웃은 대체로 0.79~0.96, 다른 장면은 0.48~0.71 (docs/decisions/2026-11-16-similar-ai.md 8절)
//          묶음의 모든 사진에 특징값이 있으면 aiChecked (화면에 "AI 로 같은 장면 확인")
//   - 추천(처음에 남길 1장, pickBest) — 2026-11-16 사용자 결정: 정리의 목적은 버리기라서 가장 좋은 1장만 남기고 나머지는 처음엔 버림
//     (모두 버릴지 · 다시 고를지 · 여러 장 남길지는 사용자가 화면에서 정해요. 옮기기는 확인 창을 거쳐요)
//     ① 흐리지 않은 것 ② 노출이 묶음 가운데값에서 크게 벗어나지 않은 것 ③ 가로×세로가 큰 것(줄인 사본보다 원본)
//     ④ 더 선명한 것(흐림 점수가 0.03 넘게 낮은 것) ⑤ AI 특징값으로 묶음 대표에 가까운 것 ⑥ 파일 크기가 큰 것 ⑦ 먼저 찍은 것 ⑧ 번호가 작은 것
//     까닭 한 줄(keepReason, 예: "흐린 사진 2장을 빼고 파일이 가장 큰 사진")을 같이 줘요
//     지문도 AI 특징값도 없는 사진(softIds)만 비슷한지 판단할 정보가 없어서 처음엔 남김이에요
//     (흐림 점수만 없는 사진은 지문이나 AI 로 비슷하다고 본 것이라 처음엔 버림. 추천은 정보가 다 있는 사진에서 골라요, 2026-11-16 사용자 지적)
//   - 묶음을 나눌 때 쓰는 기준 사진(pickKeep, ①의 24 거리 비교)은 예전 그대로 가로×세로 → 파일 크기 순이에요 (묶음 모양이 바뀌지 않게)
//   - 흐림 점수(blurOf): 썸네일 흑백을 한 번 더 흐리게 했을 때 이웃 칸 차이가 얼마나 그대로인지 (Crete 방식, 0~1, 클수록 흐림)
//     이미 흐린 사진은 더 흐리게 해도 별로 안 바뀌어요. 어두운 사진 · 하늘처럼 밋밋한 사진에 덜 속아요
//     BLUR_LIMIT(0.5) 이상이면 화면에 "흐림" 표시 (실측 docs/decisions/2026-11-16-similar-burst-blur.md)
//   - 사진 파일은 읽기만 해요 (지문과 흐림 점수는 썸네일 파일에서 계산). 버리기는 이 파일이 하지 않아요
//   - Electron은 쓰지 않아요 (lib/ 규칙)
//
// 모양
//   dhashOf(gray9x8: Buffer 72바이트) → '0123456789abcdef'
//   distance(a, b) → 0~64 (다른 칸 수)
//   buildGroups(rows, opts) → [{ ids: [...], keepId, keepReason, softIds: [처음엔 남김], timeOnly, aiChecked, takenAt }] (2장 이상인 묶음만, 최근 것부터)
//     rows: db.similarRows() 모양 [{ id, name, takenAt, takenAtSource, width, height, size, model, dhash, blur, light, vec, embedModel }]
//     timeOnly: 이어 찍기(③)로만 묶인 묶음
//   pickBest(members) → { keep, reason } (추천 1장과 까닭)
//     opts.aiLink: 이어 찍기를 잇는 AI 유사도 하한 (기본 0.78, 특징값이 없으면 잇지 않음)
//     opts.burstSec: 이어 찍기 간격 (기본 60, 0이면 ③을 쓰지 않아요)
//   blurOf({ data, width, height }) → 0~1 (흑백 한 칸 = 1바이트). 너무 작으면 null
//   createHasher({ db, thumbs, grayOf, blurGrayOf }) → { run(root, onProgress, { readyOnly, isBusy }) → Promise<{ made, failed, skipped }>, stop() }
//     지문과 흐림 점수를 같이 만들어요 (둘 중 없는 것만)
//     thumbs.request(id) → 썸네일 경로|null (lib/thumbs.js). grayOf(경로) → Promise<Buffer 72바이트> (기본 sharp)
//     blurGrayOf(경로) → Promise<{ data, width, height }> (썸네일 크기 흑백, 기본 sharp)
//     readyOnly: 참이면 썸네일이 이미 있는 사진만 (뒤에서 미리 계산할 때. 썸네일 만들기는 lib/thumbs.js 백그라운드가 해요)
//     isBusy(): 참이면 가져오기 중 → 끝날 때까지 쉬어요 (가져오기를 느리게 하지 않게)

const TIME_GAP_SEC = 3; // 연속 촬영으로 보는 간격 (개발개요 열린 질문 3: 3초로 시작)
const TIME_MAX_DIST = 24; // 시간으로 묶을 때도 이보다 다르면 다른 장면
const SHAPE_MAX_DIST = 6; // 날짜와 상관없이 모양만으로 묶는 거리
const FLAT_BITS = 2; // 지문의 1이 이만큼 이하(또는 64-이만큼 이상)면 거의 한 색 → 모양으로 묶지 않음
const HASH_BATCH = 16; // 지문을 한 번에 만드는 수
const BUCKET_LIMIT = 2000; // 모양 비교 열쇠 하나에 이보다 많으면 건너뜀 (2000장끼리 비교 = 약 200만 번)
const TIME_WINDOW = 50; // 시간 비교는 앞의 50장까지 (시계가 멈춘 기기처럼 같은 시각이 수천 장이어도 느려지지 않게)
const BURST_SEC = 60; // 이어 찍기: 같은 날 · 같은 기기로 앞 사진과 이 초 안이면 한 묶음 후보 (2026-11-16 사용자 결정)
const AI_LINK = 0.78; // 이어 찍기는 두 사진 모두 AI 특징값이 있고 이 유사도 이상일 때만 이어요 (docs/decisions/2026-11-16-similar-ai.md)
const BLUR_LIMIT = 0.5; // 흐림 점수가 이 값 이상이면 "흐림" 표시 (G: 표본 1,500장 중 6장, 모두 눈으로 봐도 흐림)
const BLUR_RADIUS = 4; // 흐림 계산에서 한 번 더 흐리게 할 때 앞뒤 칸 수 (9칸 평균)
const BUSY_WAIT_MS = 500; // 가져오기 중이면 이만큼 쉬고 다시 봐요
const PROGRESS_GAP_MS = 1500; // 지문 진행 알림 간격
const { cosine } = require('./similar-ai');


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

// ---------- 흐림 점수 ----------
// Crete 방식 (2007): 사진을 세로 · 가로로 9칸 평균을 내서 한 번 더 흐리게 한 뒤, 이웃 칸 차이가 얼마나 줄었는지 봐요
//   선명한 사진은 차이가 많이 줄어요(점수 낮음). 이미 흐린 사진은 더 흐리게 해도 거의 그대로예요(점수 높음)
//   세로와 가로 중 더 흐린 쪽을 써요 (한쪽으로 흔들린 사진도 잡게)
function blurOf(img) {
  const { data, width: w, height: h } = img || {};
  if (!data || !(w >= 8) || !(h >= 8) || data.length < w * h) return null;
  const r = BLUR_RADIUS;
  const k = r * 2 + 1;
  const px = (x, y) => data[(y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)];
  const bv = new Float32Array(w * h); // 세로로 흐리게
  const bh = new Float32Array(w * h); // 가로로 흐리게
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      let b = 0;
      for (let d = -r; d <= r; d++) {
        a += px(x, y + d);
        b += px(x + d, y);
      }
      bv[y * w + x] = a / k;
      bh[y * w + x] = b / k;
    }
  }
  let sFv = 0;
  let sVv = 0;
  let sFh = 0;
  let sVh = 0;
  for (let y = 1; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const i = y * w + x;
      const dFv = Math.abs(data[i] - data[i - w]);
      const dBv = Math.abs(bv[i] - bv[i - w]);
      sFv += dFv;
      if (dFv > dBv) sVv += dFv - dBv;
      const dFh = Math.abs(data[i] - data[i - 1]);
      const dBh = Math.abs(bh[i] - bh[i - 1]);
      sFh += dFh;
      if (dFh > dBh) sVh += dFh - dBh;
    }
  }
  // 차이가 하나도 없는 한 색 그림은 "흐림"으로 봐요 (보여 줄 것이 없음)
  const v = sFv ? (sFv - sVv) / sFv : 1;
  const hz = sFh ? (sFh - sVh) / sFh : 1;
  return Math.round(Math.max(v, hz) * 1000) / 1000;
}

const isBlurry = (b) => typeof b === 'number' && b >= BLUR_LIMIT;

// 밝기 (흑백 평균 0~1). 노출 비교용
function lightOf(img) {
  const { data, width: w, height: h } = img || {};
  if (!data || !(w > 0) || !(h > 0) || data.length < w * h) return null;
  let s = 0;
  for (let i = 0; i < w * h; i++) s += data[i];
  return Math.round((s / (w * h) / 255) * 1000) / 1000;
}

// ---------- 추천 1장 고르기 ----------
const LIGHT_GAP = 0.15; // 묶음 가운데 밝기에서 이만큼 넘게 벗어나면 "노출 벗어남" (밤 사진처럼 모두 어두우면 가운데값도 어두워서 괜찮아요)
const SHARP_GAP = 0.03; // 흐림 점수가 이만큼 넘게 차이 나야 "더 선명함"으로 봐요 (같은 장면 썸네일끼리 작은 차이는 무시)
const areaOf = (r) => (Number(r.width) > 0 && Number(r.height) > 0 ? r.width * r.height : 0);
const known = (v) => typeof v === 'number' && Number.isFinite(v);
function median(nums) {
  const s = nums.filter(known).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

// 기준 하나 = { name: 이긴 까닭 글, cmp(a, b) → 음수면 a 가 나음 }. extra 는 앞에 끼워 넣을 기준 (AI 대표 등)
function bestCriteria(members, extra = []) {
  const mid = median(members.map((r) => r.light));
  const offLight = (r) => (mid !== null && known(r.light) && Math.abs(r.light - mid) > LIGHT_GAP ? 1 : 0);
  const t = (r) => {
    const s = secondsOf(r.takenAt);
    return s === null ? Infinity : s;
  };
  const sharpCmp = (a, b) => {
    if (!known(a.blur) || !known(b.blur)) return 0;
    const d = a.blur - b.blur;
    return Math.abs(d) > SHARP_GAP ? d : 0;
  };
  // 지문 · 흐림 점수가 있는 사진을 먼저 (정보가 없는 사진은 판단할 수 없어요)
  const missing = (r) => (validHash(r.dhash) ? 0 : 1) + (known(r.blur) ? 0 : 1);
  return [
    { name: 'blur', cmp: (a, b) => (isBlurry(a.blur) ? 1 : 0) - (isBlurry(b.blur) ? 1 : 0) },
    { name: 'light', cmp: (a, b) => offLight(a) - offLight(b) },
    { name: 'info', cmp: (a, b) => missing(a) - missing(b) },
    { name: 'area', cmp: (a, b) => areaOf(b) - areaOf(a) },
    { name: 'sharp', cmp: sharpCmp },
    ...extra,
    { name: 'size', cmp: (a, b) => (b.size || 0) - (a.size || 0) },
    { name: 'time', cmp: (a, b) => t(a) - t(b) },
    { name: 'id', cmp: (a, b) => a.id - b.id },
  ];
}

const REASON = {
  info: '지문과 흐림 점수가 있는 사진',

  area: '가장 큰 사진',
  sharp: '가장 선명한 사진',
  size: '파일이 가장 큰 사진',
  time: '가장 먼저 찍은 사진',
  id: '첫 사진',
};

// 추천 1장과 까닭. 흐림 · 노출로 빠진 사진 수를 앞에 붙이고, 남은 사진 중 가른 기준을 뒤에 써요
function pickBest(members, extra = []) {
  const crit = bestCriteria(members, extra);
  const cmp = (a, b) => {
    for (const c of crit) {
      const v = c.cmp(a, b);
      if (v) return v;
    }
    return 0;
  };
  const sorted = [...members].sort(cmp);
  const keep = sorted[0];
  const blurOut = members.filter((r) => r !== keep && crit[0].cmp(keep, r) < 0).length;
  const lightOut = members.filter((r) => r !== keep && !crit[0].cmp(keep, r) && crit[1].cmp(keep, r) < 0).length;
  // 남은 사진(흐림 · 노출이 같은) 중 2등과 가른 기준
  const rest = sorted.slice(1).find((r) => !crit[0].cmp(keep, r) && !crit[1].cmp(keep, r));
  let decide = '';
  if (rest) {
    const c = crit.slice(2).find((x) => x.cmp(keep, rest) !== 0);
    decide = c ? (REASON[c.name] || c.reason || '') : '';
  }
  const parts = [];
  if (blurOut) parts.push(`흐린 사진 ${blurOut}장`);
  if (lightOut) parts.push(`너무 어둡거나 밝은 사진 ${lightOut}장`);
  let reason;
  if (!rest) reason = blurOut && !lightOut ? '흐리지 않은 사진' : lightOut && !blurOut ? '노출이 알맞은 사진' : '흐리지 않고 노출이 알맞은 사진';
  else reason = decide || '가장 먼저 찍은 사진';
  if (parts.length && rest) reason = `${parts.join(', ')}을 빼고 ${reason}`;
  return { keep, reason };
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

// 이어진 사진끼리 모으기 → { comps: [[줄...]], softParent: Map(지문 없는 줄 → 붙은 지문 있는 줄) }
function components(list, { gapSec, timeMax, shapeMax }) {
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

  // ① 시간: 찍은 시각 순으로 늘어놓고, 지문이 있는 사진은 "열린 묶음"의 남길 사진과 비교해요 (2026-11-04 사용자 결정)
  //    열린 묶음 = 마지막 사진이 3초 안인 묶음. 그 묶음의 남길 사진과 거리 24 이하면 들어가요 (가장 가까운 묶음 하나)
  //    바로 앞 사진끼리만 이으면 장면이 조금씩 바뀌는 1시간 연속 촬영이 한 묶음이 돼요 → 남길 사진과 직접 비교해서 끊어요
  //    사이에 낀 다른 한 장은 다른 묶음을 열 뿐이라 원래 묶음을 끊지 않아요
  const timed = [];
  for (let i = 0; i < n; i++) {
    const s = secondsOf(list[i].takenAt);
    if (s !== null) timed.push({ i, s });
  }
  timed.sort((a, b) => a.s - b.s || list[a.i].id - list[b.i].id);
  let open = []; // [{ root, keep: 남길 사진 순번, last: 마지막 사진의 초 }]
  for (const b of timed) {
    if (!hashOk[b.i]) continue;
    open = open.filter((g) => b.s - g.last <= gapSec);
    if (open.length > TIME_WINDOW) open = open.slice(-TIME_WINDOW);
    let best = null;
    let bestDist = Infinity;
    for (const g of open) {
      const d = distance(list[g.keep].dhash, list[b.i].dhash);
      if (d <= timeMax && d < bestDist) {
        best = g;
        bestDist = d;
      }
    }
    if (best) {
      join(best.root, b.i);
      best.root = find(b.i);
      best.last = b.s;
      if (pickKeep([list[best.keep], list[b.i]]) === list[b.i]) best.keep = b.i;
    } else {
      open.push({ root: b.i, keep: b.i, last: b.s });
    }
  }
  //    지문이 없는 사진: 3초 안에서 가장 가까운 "지문 있는" 사진 한 장에만 붙여요
  const softParent = new Map();
  //    (시간만으로는 장면을 알 수 없어서, 두 장면을 잇는 다리가 되지 않게 해요. 처음엔 "남김"으로 보여요)
  for (let k = 0; k < timed.length; k++) {
    const b = timed[k];
    if (hashOk[b.i]) continue;
    let best = -1;
    let bestGap = Infinity;
    for (let j = k - 1; j >= 0 && k - j <= TIME_WINDOW; j--) {
      const gap = b.s - timed[j].s;
      if (gap > gapSec || gap > bestGap) break;
      if (hashOk[timed[j].i]) {
        best = timed[j].i;
        bestGap = gap;
        break;
      }
    }
    for (let j = k + 1; j < timed.length && j - k <= TIME_WINDOW; j++) {
      const gap = timed[j].s - b.s;
      if (gap > gapSec || gap >= bestGap) break; // 같은 간격이면 먼저 찍은 쪽
      if (hashOk[timed[j].i]) {
        best = timed[j].i;
        break;
      }
    }
    if (best >= 0) {
      join(best, b.i);
      softParent.set(list[b.i], list[best]);
    }
  }

  // ② 모양: 64칸을 8칸씩 8조각으로 나눠요. 거리가 6 이하면 8조각 중 적어도 2조각은 똑같아요
  //    → "조각 두 개" 짝을 열쇠로 같은 열쇠끼리만 비교해요 (6만 장도 전부 짝지어 비교하지 않아요)
  //    한 열쇠에 사진이 너무 많으면(BUCKET_LIMIT, 밋밋한 그림이 흔한 값) 그 열쇠는 건너뛰어요. 다른 짝 열쇠에서 대부분 만나요
  //    이 방식은 거리 6까지만 맞아요 (7 이상이면 같은 조각이 2개보다 적을 수 있어요) → 더 큰 값은 오류로 알려요
  {
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

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(list[i]);
  }
  return { comps: [...groups.values()], softParent };
}

// 'YYYY-MM-DD' 부분 (같은 날 비교용). 모양이 틀리면 null
const dayOf = (t) => (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(t) ? t.slice(0, 10) : null);

// ③ 이어 찍기: ①②로 만든 묶음(made)을 이어 찍기 사슬로 넓히고 합쳐요
//   → [{ members: [줄...], keep: 남길 사진 줄, soft: [처음엔 남김 줄...], timeOnly }]
//   기기마다 바로 앞 사진과 비교해요. 다른 기기 사진이 사이에 끼어도 같은 기기 사슬은 이어지고, 다른 기기끼리는 잇지 않아요
//   기기 정보가 없는 사진끼리는 같은 기기로 봐요
//   찍은 시각이 촬영 정보(exif)에서 온 사진만 이어요. 파일 이름 · 직접 넣은 날짜는 같은 시각이 많아서
//   하루가 통째로 한 묶음이 될 수 있어요 (#117 검증 지적)
// 두 사진을 AI 로 볼 때 같은 장면인지: 둘 다 같은 모델의 특징값이 있고 유사도가 aiLink 이상일 때만 참
//   특징값이 없으면 거짓 → 이어 찍기로 잇지 않아요 (시간만으로는 다른 장면이 묶여요, 2026-11-16 실사용 지적)
function aiSame(a, b, aiLink) {
  if (!a.vec || !b.vec || !a.embedModel || a.embedModel !== b.embedModel) return false;
  const c = cosine(a.vec, b.vec);
  return c !== null && c >= aiLink;
}
const hasVec = (r) => !!(r.vec && r.vec.length && r.embedModel);
// 묶음의 모든 사진에 같은 모델의 특징값이 있는지
const allVec = (list) => list.length > 0 && list.every(hasVec) && list.every((r) => r.embedModel === list[0].embedModel);

// 추천 기준 ⑤: AI 로 본 묶음 대표에 가까운 사진 (다른 사진들과의 유사도 평균이 높은 것). 3장 이상 · 같은 모델일 때만
//   0.01 넘게 차이 날 때만 가려요 (작은 차이는 다음 기준으로)
function aiCriteria(members) {
  const withVec = members.filter(hasVec);
  if (withVec.length < 3) return [];
  const model = withVec[0].embedModel;
  const same = withVec.filter((r) => r.embedModel === model);
  if (same.length < 3) return [];
  const center = new Map();
  for (const r of same) {
    let s = 0;
    for (const q of same) if (q !== r) s += cosine(r.vec, q.vec) || 0;
    center.set(r, s / (same.length - 1));
  }
  return [{
    name: 'ai',
    reason: 'AI 가 본 대표 장면에 가장 가까운 사진',
    cmp: (a, b) => {
      const x = center.get(a);
      const y = center.get(b);
      if (x === undefined || y === undefined) return 0;
      const d = y - x;
      return Math.abs(d) > 0.01 ? d : 0;
    },
  }];
}

function mergeBursts(rows, made, burstSec, aiLink = AI_LINK) {
  const m = made.length;
  const groupOf = new Map(); // 줄 → made 번호
  made.forEach((g, k) => g.members.forEach((r) => groupOf.set(r, k)));
  const parent = Array.from({ length: m }, (_, i) => i);
  const loose = new Map(); // ①②에 없던 줄 → 노드 번호 (m 부터)
  const looseRows = [];
  const nodeOf = (r) => {
    if (groupOf.has(r)) return groupOf.get(r);
    let n = loose.get(r);
    if (n === undefined) {
      n = parent.length;
      parent.push(n);
      loose.set(r, n);
      looseRows[n] = r;
    }
    return n;
  };
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
  if (burstSec > 0) {
    const timed = [];
    for (const r of rows) {
      if (r.takenAtSource !== 'exif') continue;
      const s = secondsOf(r.takenAt);
      const d = dayOf(r.takenAt);
      if (s !== null && d) timed.push({ r, s, d });
    }
    timed.sort((a, b) => a.s - b.s || a.r.id - b.r.id);
    const last = new Map(); // 기기 → 그 기기의 바로 앞 사진
    for (const x of timed) {
      const key = String(x.r.model || '');
      const p = last.get(key);
      if (p && p.d === x.d && x.s - p.s <= burstSec && aiSame(p.r, x.r, aiLink)) join(nodeOf(p.r), nodeOf(x.r));
      last.set(key, x);
    }
  }
  // 이어진 것끼리 모으기
  const byRoot = new Map();
  const at = (n) => {
    const root = find(n);
    let c = byRoot.get(root);
    if (!c) byRoot.set(root, (c = { groups: [], loose: [] }));
    return c;
  };
  for (let k = 0; k < m; k++) at(k).groups.push(made[k]);
  for (const [r, n] of loose) at(n).loose.push(r);
  const out = [];
  for (const c of byRoot.values()) {
    if (!c.groups.length) {
      // 이어 찍기로만 묶인 묶음 (추천 1장은 buildGroups 가 다시 골라요)
      if (c.loose.length < 2) continue;
      const hashed = c.loose.filter((r) => validHash(r.dhash));
      out.push({ members: c.loose, keep: pickKeep(hashed.length ? hashed : c.loose), soft: [...c.loose], timeOnly: true, aiChecked: allVec(c.loose) });
      continue;
    }
    const keep = pickKeep(c.groups.map((g) => g.keep));
    const members = [];
    const soft = [];
    for (const g of c.groups) {
      members.push(...g.members);
      soft.push(...g.soft);
      if (g.keep !== keep) soft.push(g.keep);
    }
    members.push(...c.loose);
    soft.push(...c.loose);
    out.push({ members, keep, soft, timeOnly: false, aiChecked: c.loose.length > 0 && allVec(members) });

  }
  return out;
}

function buildGroups(rows, opts = {}) {
  const o = {
    gapSec: opts.timeGapSec ?? TIME_GAP_SEC,
    timeMax: opts.timeMaxDist ?? TIME_MAX_DIST,
    shapeMax: opts.shapeMaxDist ?? SHAPE_MAX_DIST,
    burstSec: opts.burstSec ?? BURST_SEC,
    aiLink: opts.aiLink ?? AI_LINK,
    extraCriteria: opts.extraCriteria || null, // (묶음 줄들) → 추천 기준 더하기 (없으면 AI 대표, aiCriteria)

  };
  if (!(o.shapeMax <= 6)) throw new Error('모양 거리는 6 이하만 쓸 수 있어요');
  // 묶음마다 남길 사진과 지문 거리 24 이하인 사진만 남겨요 (모양 ②로 한 칸씩 이어져도 끝없이 커지지 않게)
  //   멀어서 빠진 사진은 그 사진들끼리 다시 묶어요. 지문 없는 사진은 붙었던 사진을 따라가요
  let pending = rows.filter((r) => r && Number.isSafeInteger(r.id));
  const found = [];
  while (pending.length) {
    const { comps, softParent } = components(pending, o);
    const next = [];
    for (const members of comps) {
      if (members.length < 2) continue;
      const hashed = members.filter((r) => validHash(r.dhash));
      if (!hashed.length) {
        found.push(members);
        continue;
      }
      const keep = pickKeep(hashed);
      const near = new Set(hashed.filter((r) => distance(r.dhash, keep.dhash) <= o.timeMax));
      const mine = members.filter((r) => near.has(r) || (!validHash(r.dhash) && near.has(softParent.get(r))));
      found.push(mine);
      if (mine.length < members.length) {
        const keepSet = new Set(mine);
        next.push(...members.filter((r) => !keepSet.has(r)));
      }
    }
    pending = next;
  }

  // ①②로 만든 묶음 (2장 이상만): 남길 사진은 지문 있는 사진 중에서 골라요
  //   지문 없는 사진(soft)은 시간만으로 들어온 것이라 처음엔 남김으로 보여요
  const made = found.filter((m) => m.length >= 2).map((members) => {
    const hashed = members.filter((r) => validHash(r.dhash));
    const keep = pickKeep(hashed.length ? hashed : members);
    return { members, keep, soft: members.filter((r) => !validHash(r.dhash)) };
  });

  // ③ 이어 찍기로 묶음을 넓혀요 (같은 날 · 같은 기기 · 앞 사진과 burstSec 초 안 · AI 로 같은 장면, 사슬)
  //   ①②의 묶음끼리 이어지면 하나로 합쳐요. 처음 표시(추천 1장만 남김)는 아래에서 다시 정해요
  const clusters = mergeBursts(rows.filter((r) => r && Number.isSafeInteger(r.id)), made, o.burstSec, o.aiLink);

  // 묶음으로 내보내기: 추천 1장(pickBest)만 남김, 나머지는 처음엔 버림 (2026-11-16 사용자 결정)
  //   지문도 AI 특징값도 없는 사진(3초 안에 찍어 붙은 사진)만 비슷한지 판단할 정보가 없어서 처음엔 남김(softIds)
  const out = [];
  for (const c of clusters) {
    const sorted = [...c.members].sort((a, b) => {
      const sa = secondsOf(a.takenAt);
      const sb = secondsOf(b.takenAt);
      return (sa ?? Infinity) - (sb ?? Infinity) || a.id - b.id;
    });
    const { keep, reason } = pickBest(c.members, o.extraCriteria ? o.extraCriteria(c.members) : aiCriteria(c.members));
    const firstTaken = sorted.find((r) => secondsOf(r.takenAt) !== null);
    const softIds = sorted.filter((r) => r !== keep && !validHash(r.dhash) && !hasVec(r)).map((r) => r.id);
    out.push({ ids: sorted.map((r) => r.id), keepId: keep.id, keepReason: reason, softIds, timeOnly: c.timeOnly, aiChecked: c.aiChecked, takenAt: firstTaken ? firstTaken.takenAt : null });
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

// ---------- 지문 · 흐림 점수 만들기 (썸네일에서) ----------
async function sharpGray(thumbPath) {
  const sharp = require('sharp');
  return sharp(thumbPath).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
}

// 흐림 점수용: 썸네일 크기 그대로 흑백 (긴 변 320px)
async function sharpBlurGray(thumbPath) {
  const sharp = require('sharp');
  const { data, info } = await sharp(thumbPath).grayscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createHasher({ db, thumbs, grayOf = sharpGray, blurGrayOf = sharpBlurGray }) {
  let stopped = false;
  let running = null;

  // 사진 한 장: 없는 값(지문, 흐림 점수)만 만들어요 → 'made' | 'failed' | 'skipped'
  async function one(f) {
    let thumb = null;
    try {
      thumb = await thumbs.request(f.id);
    } catch (e) {
      thumb = null;
    }
    if (stopped) return 'skipped';
    if (!thumb) {
      // 썸네일이 "만들 수 없음"으로 끝났으면 없음으로 적어요. 원본을 못 읽은 경우는 적지 않고 다음에 다시
      const now = db.getFile(f.id);
      if (now && now.thumbState === 'failed') {
        if (f.needHash) db.setHash(f.path, f.size, f.mtimeMs, null);
        if (f.needBlur) db.setBlur(f.path, f.size, f.mtimeMs, null);
        return 'failed';
      }
      return 'skipped';
    }
    // 썸네일을 그 사이 지웠거나 잠깐 잠긴 경우도 있어요 → 못 읽은 쪽은 없음으로 적지 않고 다음 회차에 다시
    //   한쪽만 못 읽으면 읽은 쪽은 저장해요 (#117 검증 지적)
    let gray = null;
    let big = null;
    let missed = false;
    if (f.needHash) {
      try {
        gray = await grayOf(thumb);
      } catch (e) {
        missed = true;
      }
    }
    if (f.needBlur) {
      try {
        big = await blurGrayOf(thumb);
      } catch (e) {
        missed = true;
      }
    }
    if (stopped) return 'skipped';
    let bad = false;
    if (f.needHash && gray) {
      try {
        db.setHash(f.path, f.size, f.mtimeMs, dhashOf(gray));
      } catch (e) {
        db.setHash(f.path, f.size, f.mtimeMs, null);
        bad = true;
      }
    }
    if (f.needBlur && big) {
      let b = null;
      try {
        b = blurOf(big);
      } catch (e) {
        b = null;
      }
      db.setBlur(f.path, f.size, f.mtimeMs, b, b === null ? null : lightOf(big));
      if (b === null) bad = true;
    }
    if (missed) return 'skipped';
    return bad ? 'failed' : 'made';
  }

  async function pass(root, onProgress, { readyOnly = false, isBusy = () => false } = {}) {
    // 번호 순서로 앞으로만 나아가요. 썸네일을 못 얻은 사진(원본을 읽을 수 없음 등)은 이번 회차엔 다시 안 잡아요
    let lastId = 0;
    const count = { made: 0, failed: 0, skipped: 0 };
    let lastNote = 0;
    while (!stopped) {
      // 가져오기 중이면 쉬어요 (가져오기를 느리게 하지 않게. 가져오는 중에 고르거나 지우지도 않아요)
      if (isBusy()) {
        await sleep(BUSY_WAIT_MS);
        continue;
      }
      const jobs = db.hashJobs(root, HASH_BATCH, lastId, { readyOnly });
      if (!jobs.length) break;
      lastId = jobs[jobs.length - 1].id;
      const results = await Promise.all(jobs.map((f) => one(f)));
      for (const r of results) count[r]++;
      // 진행 알림은 1.5초에 한 번만 (5.5만 장이면 진행 조회 한 번이 약 70ms 라 묶음마다 하면 main 이 자주 멈춰요, #117 검증 지적)
      if (onProgress && Date.now() - lastNote >= PROGRESS_GAP_MS) {
        lastNote = Date.now();
        try {
          onProgress(db.hashProgress(root));
        } catch (e) { /* 알림 실패는 무시 */ }
      }
    }
    return count;
  }

  // 같은 때 두 번 부르면 돌고 있는 것을 돌려줘요
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

module.exports = { dhashOf, distance, buildGroups, pickKeep, pickBest, lightOf, createHasher,
 secondsOf, blurOf, isBlurry, TIME_GAP_SEC, SHAPE_MAX_DIST, TIME_MAX_DIST, BURST_SEC, BLUR_LIMIT, AI_LINK };

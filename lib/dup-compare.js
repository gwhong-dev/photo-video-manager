// 파일 위치: lib/dup-compare.js
// 역할: 원본 정리 확인 창의 "중복 비교" (2026-11-18 사용자 요청, docs/decisions/2026-11-18-dup-compare.md)
//   중복(dup)이라 정리될 원본마다 한 줄: 왼쪽 = 라이브러리(백업 폴더)에 남는 파일, 오른쪽 = 휴지통으로 갈 원본
//   줄마다 "남기기"(체크 풀기)를 하면 이번 정리에서 빼고, 작업 기록에 까닭 "사용자가 남김"을 남겨요
//     → 다음 정리 창에서 또 묻지 않아요 (규칙에 걸려 남긴 것과 같은 방식, lib/cleaner.js cleanSkip)
//     → 되돌리기: 가져오기 미리보기를 새로 하면 새 작업이라 다시 물어요
//   방금 변환 · 이름 바꿔 옮긴 원본(done)은 비교하지 않고 지금처럼 같이 정리해요 (개수만 알려요)
//
//   화면에는 이름 · 폴더(백업 · 가져올 폴더 안의 위치) · 크기 · 촬영 시각 · 까닭만 보내요. 파일을 열거나 그림을 만들 때는 번호(key)로만 부탁해요
//   작은 그림은 메모리에만 두고, 만들 때 쓰는 임시 파일은 설정 폴더 아래(tempDir)에만 만들어요 (사진 폴더에는 아무것도 쓰지 않아요)

const fs = require('fs');
const path = require('path');
const { keepPathOf } = require('./cleaner');
const { isVideoPath } = require('./planner');

const USER_KEPT = '사용자가 남김'; // 작업 기록 cleanSkip 에 적는 까닭
const PAGE_SIZE = 100; // 한 번에 화면에 보내는 줄 수 (수천 개여도 창이 멈추지 않게 "더 보기"로 나눠요)
const THUMB_PX = 240; // 작은 그림 긴 변
const THUMB_LIMIT = 2; // 동시에 만드는 그림 수 (HEIC · 영상은 ImageMagick · FFmpeg 를 써서 무거워요)
const THUMB_CACHE = 300; // 메모리에 기억하는 그림 수
const FFMPEG_TIMEOUT_MS = 30000;

// 정리 대상(cleanTargets 결과)에서 비교할 중복 원본 고르기
//   돌려주는 값: { items: [{ i, src, keep }], done: 비교 없이 같이 정리하는 완료 원본 수 }
//   (경로는 main 에만 두고 화면에는 보내지 않아요)
function comparePool(job, targets) {
  const items = [];
  let done = 0;
  for (const it of targets || []) {
    if (it.status !== 'dup') {
      done++;
      continue;
    }
    const keep = keepPathOf(job, it);
    if (keep) items.push({ i: it.i, src: it.src, keep });
  }
  return { items, done };
}

// 폴더 안의 위치 (예: 2026\10\28). 폴더 밖이면 바로 위 폴더 이름만 (전체 경로는 보내지 않아요)
function placeOf(root, p) {
  const dir = path.dirname(p);
  if (root) {
    const rel = path.relative(root, dir);
    if (!rel) return '맨 위';
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return path.basename(dir);
}

// "2026:01:04 23:19:48+09:00" → "2026-01-04 23:19:48" (모양이 다르면 그대로)
function shotText(date) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})/.exec(String(date || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}` : '';
}

// 화면에 보낼 줄 (offset 부터 PAGE_SIZE 개)
//   크기는 지금 파일 정보로 읽어요 (못 읽으면 null). 여러 개를 동시에 읽어 기다리는 시간을 줄여요
//   statOf: 점검 때 바꿔 끼울 수 있게
async function compareRows(job, pool, offset = 0, { limit = PAGE_SIZE, statOf = (p) => fs.promises.stat(p).catch(() => null) } = {}) {
  const list = (pool && pool.items) || [];
  const start = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const page = list.slice(start, start + limit);
  const rows = await Promise.all(page.map(async (c, n) => {
    const it = (job && job.items[c.i]) || {};
    const [ss, ks] = await Promise.all([statOf(c.src), statOf(c.keep)]);
    return {
      key: start + n,
      keepName: path.basename(c.keep),
      keepPlace: placeOf(job && job.backupRoot, c.keep),
      keepSize: ks ? Number(ks.size) : null,
      srcName: path.basename(c.src),
      srcPlace: placeOf(job && job.source, c.src),
      srcSize: ss ? Number(ss.size) : null,
      shot: shotText(it.date),
      why: it.note || '같은 파일',
      video: isVideoPath(c.src) || isVideoPath(c.keep),
    };
  }));
  return { rows, total: list.length, done: (pool && pool.done) || 0, next: start + page.length < list.length ? start + page.length : null };
}

// 화면이 보낸 번호로 파일 찾기 (side: 'keep' 남는 파일 / 'src' 정리될 원본). 번호가 이상하면 null
function compareFile(pool, key, side) {
  const list = pool && pool.items;
  if (!Array.isArray(list) || !Number.isInteger(key) || key < 0 || key >= list.length) return null;
  if (side === 'keep') return list[key].keep;
  if (side === 'src') return list[key].src;
  return null;
}

// "남기기"한 번호 → 작업 목록 번호(i). 번호가 하나라도 이상하면 오류 (무엇을 남길지 모르는 채로 정리하지 않게)
function keptItems(pool, keys) {
  if (keys == null) return [];
  if (!Array.isArray(keys)) throw new Error('비교 목록을 다시 열어 주세요');
  const list = (pool && pool.items) || [];
  const out = new Set();
  for (const k of keys) {
    if (!Number.isInteger(k) || k < 0 || k >= list.length) throw new Error('비교 목록을 다시 열어 주세요');
    out.add(list[k].i);
  }
  return [...out].sort((a, b) => a - b);
}

// 남기기한 원본을 작업 기록에 적기 (원본 파일은 건드리지 않아요). 이미 정리된 원본은 건너뛰어요
//   돌려주는 값: 적은 항목들
function markUserKept(job, store, indexes) {
  const out = [];
  for (const i of indexes || []) {
    const it = job && job.items[i];
    if (!it || it.trashed || it.movedTo || it.status !== 'dup') continue;
    store.mark(job, i, { cleanSkip: USER_KEPT });
    out.push(it);
  }
  return out;
}

// 줄에 보일 작은 그림 만들기 (메모리에만 기억, 동시에 THUMB_LIMIT 개)
//   tempDir: ImageMagick · FFmpeg 임시 파일을 만들 곳 (설정 폴더 아래). getTools(): detectTools 결과
//   make(경로, { tools, tempBase }) → webp 내용(Buffer). 점검 때 바꿔 끼울 수 있게
//   get(경로) → 'data:image/webp;base64,...' 또는 null (못 만들면). clear(): 기다리는 것 · 기억한 것 버리기
function createCompareThumbs({ tempDir, getTools = () => ({}), make = defaultMake, limit = THUMB_LIMIT, max = THUMB_CACHE } = {}) {
  const cache = new Map(); // 경로 → data 주소 (오래된 것부터 버려요)
  const waiting = new Map(); // 경로 → 만드는 중인 Promise (같은 그림을 두 번 만들지 않게)
  const queue = [];
  let active = 0;
  let seq = 0;
  let gen = 0; // clear() 하면 늘어요 → 그 전에 시작한 것은 기억하지 않아요

  // 앱이 그림을 만드는 도중에 꺼지면 임시 파일(cmp-*)이 남을 수 있어요 → 처음 만들 때 한 번 치워요 (#125 검증 ⚠️)
  //   tempDir 은 이 기능만 쓰는 설정 폴더 아래 폴더예요. 이름이 cmp- 로 시작하는 파일만 지워요
  try {
    for (const name of fs.readdirSync(tempDir)) {
      if (name.startsWith('cmp-')) fs.rmSync(path.join(tempDir, name), { force: true });
    }
  } catch (e) {
    // 폴더가 아직 없거나 못 읽으면 넘어가요
  }

  const pump = () => {
    while (active < limit && queue.length) {
      const job = queue.shift();
      active++;
      const myGen = gen;
      (async () => {
        let url = null;
        try {
          fs.mkdirSync(tempDir, { recursive: true });
          const buf = await make(job.p, { tools: getTools() || {}, tempBase: path.join(tempDir, `cmp-${process.pid}-${++seq}`) });
          if (buf && buf.length) url = `data:image/webp;base64,${Buffer.from(buf).toString('base64')}`;
        } catch (e) {
          url = null; // 깨진 파일 · 도구 없음 → 그림 없이 이름만 보여요
        }
        if (myGen === gen && url) {
          cache.set(job.p, url);
          while (cache.size > max) cache.delete(cache.keys().next().value);
        }
        // clear() 뒤에 같은 그림을 새로 부탁했으면 그 기다림은 지우지 않아요 (내 것일 때만, #125 검증 ⚠️)
        if (waiting.get(job.p) === job.pr) waiting.delete(job.p);
        job.resolve(url);
      })().finally(() => {
        active--;
        pump();
      });
    }
  };

  const get = (p) => {
    if (!p) return Promise.resolve(null);
    if (cache.has(p)) {
      const url = cache.get(p);
      cache.delete(p);
      cache.set(p, url); // 최근에 쓴 것으로
      return Promise.resolve(url);
    }
    if (waiting.has(p)) return waiting.get(p);
    const job = { p, resolve: null, pr: null };
    const pr = new Promise((resolve) => {
      job.resolve = resolve;
    });
    job.pr = pr;
    queue.push(job);
    waiting.set(p, pr);
    pump();
    return pr;
  };

  const clear = () => {
    gen++;
    for (const job of queue.splice(0)) {
      waiting.delete(job.p);
      job.resolve(null);
    }
    cache.clear();
  };

  return { get, clear, stats: () => ({ cached: cache.size, waiting: queue.length, active }) };
}

// 실제 그림 만들기: 사진은 sharp(못 열면 ImageMagick), 영상은 FFmpeg 로 1초 지점 장면 (갤러리 썸네일과 같은 방법)
async function defaultMake(p, { tools, tempBase }) {
  const { photoBuffer, videoBuffer } = require('./thumbs');
  if (isVideoPath(p)) return videoBuffer({ path: p, durationSec: 1 }, tools, tempBase, FFMPEG_TIMEOUT_MS);
  return photoBuffer({ path: p }, THUMB_PX, tools, tempBase);
}

module.exports = { USER_KEPT, PAGE_SIZE, comparePool, compareRows, compareFile, keptItems, markUserKept, createCompareThumbs, shotText, placeOf };

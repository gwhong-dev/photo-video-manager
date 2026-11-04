// 파일 위치: lib/library.js
// 역할: 백업 폴더를 읽어서 갤러리 DB(lib/db.js)를 채우기 (docs/superpowers/specs/2026-11-01-gallery-design.md 6절)
//   - 새 파일, 바뀐 파일만 exiftool로 읽어요 (경로, 크기, 수정 시각이 같으면 건너뜀)
//   - 폴더에서 사라진 파일은 지우지 않고 missing 표시만 해요
//   - ⚠️ 사진 폴더에는 아무것도 쓰지 않아요 (읽기만). 쓰는 건 DB와 로그뿐이에요
//   - ⚠️ missing 표시는 "폴더를 끝까지 읽었다"고 확신할 때만 해요 (연결이 끊긴 외장 드라이브를 "사진이 다 사라짐"으로 착각하지 않게)
//
// 모양: createLibrary({ db, getEt, logger, isBusy, onProgress, onChanged, walkFn, chunkSize })
//        → { scan(root, { retryErrors }) → Promise<{ status, read, skipped, missing, failedDirs }>, isScanning() }
//   status: done | disconnected | no-exiftool | error | superseded
//   scan(root, { retryErrors, changed }): 읽는 중에 다른 요청이 오면 한 번만 기억해 두었다가 이어서 다시 읽어요
//     같은 요청이면 같은 Promise, 다른 root면 지금 읽기를 다음 묶음 전에 멈추고(superseded) 새 root를 읽어요

const fs = require('fs');
const path = require('path');
const planner = require('./planner');
const D = require('./dates');
const { now } = require('./logger');
const { tidyTagName } = require('./manual-tags');

// XMP-dc:Subject 값 중 "사진 종류"를 뜻하는 이름 (나머지는 앨범 이름). 실제 샘플에서 다른 값이 나오면 여기에 추가해요
const MEDIA_TYPE_TAGS = ['사진', '비디오', '스크린샷'];

const CHUNK_SIZE = 500;      // exiftool로 한 번에 읽는 개수 (묶음마다 DB에 저장)
const BUSY_POLL_MS = 1000;   // 가져오기가 끝났는지 확인하는 간격

// 읽어 올 정보: 가져오기와 같은 것 + 길이, 크기, 시간대
const READ_TAGS = [...planner.META_TAGS, 'Duration#', 'ImageWidth', 'ImageHeight', 'OffsetTimeOriginal'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 폴더인지 (연결이 끊긴 드라이브는 여기서 false)
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

// 폴더 안 내용을 볼 수 있는지 (없어짐 표시 직전 마지막 확인용)
function canList(p) {
  try {
    fs.readdirSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

// 경로 열쇠(key)가 폴더 열쇠(dirKey) 안인지. 끝에 \ 를 붙여 비교해서 a\b2 가 a\b 안이라고 착각하지 않아요
function isUnder(key, dirKey) {
  const prefix = dirKey.endsWith(path.sep) ? dirKey : dirKey + path.sep;
  return key.startsWith(prefix);
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const OFFSET_RE = /([+-]\d{2}:\d{2})$/;

// 파일 한 개 + exiftool 정보 → DB에 넣을 한 줄. meta가 없으면 읽기 실패로 적고 파일 이름 날짜만 써 봐요
function buildRow(root, f, meta) {
  const name = path.basename(f.path);
  const row = {
    root, path: f.path, name, mediaType: f.isVideo ? 'video' : 'photo', size: f.size, mtimeMs: f.mtimeMs,
    takenAt: null, takenOffset: null, takenDay: null, takenAtSource: null,
    lat: null, lng: null, locationSource: null, model: null,
    width: null, height: null, durationSec: null, readError: null, tags: [],
  };
  if (!meta) row.readError = '읽지 못함 (exiftool 결과에 없음)';
  else if (meta.Error) row.readError = `exiftool: ${String(meta.Error)}`;

  // 날짜: 촬영 정보 → 파일 이름. 파일 수정 날짜는 쓰지 않아요
  const shot = D.dateFromMeta(meta);
  const found = shot || D.dateFromName(name);
  if (found) {
    const exif = D.toExif(found.parts); // 2026:10:28 13:41:13
    row.takenDay = exif.slice(0, 10).replace(/:/g, '-');
    row.takenAt = `${row.takenDay}T${exif.slice(11)}`;
    row.takenAtSource = shot ? 'exif' : 'filename';
  }
  if (shot) {
    const m = OFFSET_RE.exec(String(shot.raw));
    const alt = OFFSET_RE.exec(String(meta.OffsetTimeOriginal || ''));
    row.takenOffset = m ? m[1] : alt ? alt[1] : null;
  }

  if (meta) {
    const lat = finite(meta.GPSLatitude);
    const lng = finite(meta.GPSLongitude);
    if (lat !== null && lng !== null) Object.assign(row, { lat, lng, locationSource: 'exif' });
    if (meta.Model != null && String(meta.Model).trim()) row.model = String(meta.Model).trim();
    row.width = finite(meta.ImageWidth);
    row.height = finite(meta.ImageHeight);
    row.durationSec = finite(meta.Duration);
    const seen = new Set();
    for (const v of meta.Subject != null ? [].concat(meta.Subject) : []) {
      const tag = tidyTagName(v); // 띄어쓰기 글자가 달라도 같은 태그로
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      row.tags.push({ name: tag, source: MEDIA_TYPE_TAGS.includes(tag) ? 'mediaType' : 'album' });
    }
  }
  return row;
}

function createLibrary({ db, getEt, logger, isBusy, onProgress, onChanged, walkFn, chunkSize }) {
  const walk = walkFn || planner.walkAsync; // 동기 walkFn(점검용)도 await로 같이 다뤄요
  const size = chunkSize || CHUNK_SIZE;
  let running = null; // 지금 읽는 중인 요청 { root, retryErrors, superseded, promise }
  let pending = null; // 읽는 중에 들어온 요청 (하나로 합침) { req, promise, resolve }

  // 화면 알림이 실패해도 읽기는 멈추지 않아요
  const safe = (fn, arg) => {
    try {
      if (fn) fn(arg);
    } catch (e) { /* 알림 실패는 무시 */ }
  };
  const busy = () => {
    try {
      return !!(isBusy && isBusy());
    } catch (e) {
      return false;
    }
  };

  async function run({ root, retryErrors }, state) {
    const result = { status: 'done', read: 0, skipped: 0, missing: 0, failedDirs: [] };
    let log = null;
    try {
      if (logger) log = logger.newLog('gallery-scan', `갤러리 폴더 읽기 ${now()}\n폴더: ${root}`);
    } catch (e) { /* 로그를 못 만들어도 읽기는 계속 */ }
    const say = (line) => {
      try {
        if (log) log.write(line);
      } catch (e) { /* 무시 */ }
    };
    const finish = (status, why) => {
      result.status = status;
      say(`결과: ${status}${why ? ` (${why})` : ''}`);
      return result;
    };

    try {
      const et = getEt();
      if (!et) return finish('no-exiftool', 'exiftool이 없어서 읽지 않음');
      if (!root || !isDir(root)) return finish('disconnected', '백업 폴더가 없음');

      // 1) 파일 찾기 (못 읽은 폴더는 따로 모아요)
      safe(onProgress, { phase: 'finding', done: 0, total: 0 });
      const failed = new Map(); // 폴더 열쇠 → 폴더
      const found = await walk(root, true, [], (n) => safe(onProgress, { phase: 'finding', done: n, total: 0 }),
        (dir) => failed.set(planner.keyOf(dir), dir));
      if (state.superseded) return finish('superseded', '다른 폴더 읽기 요청이 와서 멈춤');
      const files = [...found].sort((a, b) => a.path.localeCompare(b.path));
      result.failedDirs = [...failed.values()];
      say(`찾음 ${files.length}개`);
      if (result.failedDirs.length) say(`못 읽은 폴더 ${result.failedDirs.length}개: ${result.failedDirs.join(' | ')}`);

      // 찾은 게 0개인데 보이는 파일이 DB에 있으면 연결 문제로 봐요 (아무것도 표시하지 않음)
      const known = db.knownFiles(root);
      if (files.length === 0 && [...known.values()].some((k) => !k.missing)) {
        return finish('disconnected', '찾은 파일이 0개인데 DB에는 파일이 있음');
      }

      // 2) DB와 비교: 같으면 건너뜀, 새 파일이나 바뀐 파일만 읽음
      const toRead = [];
      const restore = []; // 사라졌다가 같은 모습으로 돌아온 파일 (다시 읽지 않고 되돌림)
      for (const f of files) {
        const k = known.get(f.path);
        const same = k && k.size === f.size && k.mtimeMs === f.mtimeMs;
        if (!same || (k.readError && retryErrors)) {
          toRead.push(f);
          continue;
        }
        result.skipped++;
        if (k.missing) restore.push(f.path);
      }
      if (restore.length) {
        db.setMissing(restore, false);
        safe(onChanged);
      }
      say(`건너뜀 ${result.skipped}개 (되돌림 ${restore.length}개), 새로 읽을 파일 ${toRead.length}개`);

      // 3) 묶음마다 읽고 저장 (가져오기가 돌고 있으면 묶음 사이에서 기다림)
      let errors = 0;
      safe(onProgress, { phase: 'reading', done: 0, total: toRead.length });
      for (let i = 0; i < toRead.length; i += size) {
        while (busy() && !state.superseded) await sleep(BUSY_POLL_MS);
        if (state.superseded) return finish('superseded', '다른 폴더 읽기 요청이 와서 멈춤');
        const chunk = toRead.slice(i, i + size);
        const metas = await planner.readMetaWithKeys(getEt() || et, chunk, READ_TAGS); // 도구를 다시 찾았으면 새 것을 써요 (닫힌 옛 것은 거절돼서 읽기가 error로 끝나요)
        // 읽는 도중 연결이 끊기면 exiftool은 오류 없이 빈 결과를 줘요 (없는 파일은 결과에서 빠질 뿐 오류 항목도 없어요).
        // 영상은 두 번 읽는데(촬영 정보, Keys 날짜) 그 사이에 끊기면 모든 파일에 값이 있어도 영상 날짜가 틀려요
        // → 저장하기 직전에 항상 폴더가 보이는지 확인하고, 안 보이면 이 묶음은 저장하지 않아요
        if (!canList(root)) return finish('disconnected', '읽는 도중 백업 폴더 연결이 끊김');
        const rows = chunk.map((f) => buildRow(root, f, metas.get(planner.keyOf(f.path))));
        errors += rows.filter((r) => r.readError).length;
        db.upsertFiles(rows);
        result.read += rows.length;
        safe(onChanged);
        safe(onProgress, { phase: 'reading', done: result.read, total: toRead.length });
      }
      say(`읽음 ${result.read}개 (읽기 실패 ${errors}개)`);

      // 4) 없어진 파일 표시: 여기까지 오류 없이 왔고 폴더를 지금도 볼 수 있을 때만
      if (state.superseded) return finish('superseded', '다른 폴더 읽기 요청이 와서 멈춤');
      if (!canList(root)) return finish('disconnected', '읽는 사이에 백업 폴더가 사라짐');
      const present = new Set(files.map((f) => f.path));
      const failedKeys = [...failed.keys()];
      const gone = [];
      for (const [p, k] of known) {
        if (k.missing || present.has(p)) continue;
        const key = planner.keyOf(p);
        if (failedKeys.some((d) => isUnder(key, d))) continue; // 못 읽은 폴더 안은 판단 보류
        gone.push(p);
      }
      if (gone.length) {
        db.setMissing(gone, true);
        safe(onChanged);
      }
      result.missing = gone.length;
      say(`없어진 파일 ${gone.length}개`);
      return finish('done');
    } catch (e) {
      // 읽는 도중 오류: 이번 회차에는 missing 표시를 하지 않아요 (이미 저장한 묶음은 그대로 둠)
      result.error = e && e.message ? e.message : String(e);
      return finish('error', result.error);
    }
  }

  // 요청 하나를 시작해요. 끝나면 기다리던 요청이 있을 때 바로 이어서 시작해요 (isScanning은 계속 true)
  function launch(req) {
    const state = { root: req.root, retryErrors: !!req.retryErrors, superseded: false };
    running = state;
    state.promise = Promise.resolve().then(() => run(req, state)).finally(() => {
      const next = pending;
      pending = null;
      if (next) next.resolve(launch(next.req));
      else running = null;
    });
    return state.promise;
  }

  return {
    // 같은 요청이면 같은 Promise를 돌려줘요 (겹쳐 읽지 않음).
    // 다른 root, 새로 켜진 retryErrors, changed(읽는 사이에 바뀐 게 있음)는 한 번의 다시 읽기로 기억해 두었다가 이어서 해요
    scan(root, { retryErrors = false, changed = false } = {}) {
      if (!running) return launch({ root, retryErrors, changed });
      if (pending) {
        const r = pending.req;
        pending.req = { root, retryErrors: r.retryErrors || retryErrors, changed: r.changed || changed };
      } else if (root === running.root && (!retryErrors || running.retryErrors) && !changed) {
        return running.promise;
      } else {
        let resolve;
        const promise = new Promise((res) => { resolve = res; });
        pending = { req: { root, retryErrors, changed }, promise, resolve };
      }
      if (pending.req.root !== running.root) running.superseded = true;
      return pending.promise;
    },
    isScanning: () => running !== null,
  };
}

module.exports = { createLibrary, buildRow, MEDIA_TYPE_TAGS };

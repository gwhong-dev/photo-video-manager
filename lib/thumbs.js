// 파일 위치: lib/thumbs.js
// 역할: 갤러리 썸네일 만들기 + 대기열 + 오른쪽 패널 미리보기 (docs/superpowers/specs/2026-11-01-gallery-design.md 7절)
//   - 썸네일은 thumbDir/<앞 2글자>/<경로+크기+수정시각의 sha1>.webp 에만 만들어요. 사진 폴더에는 아무것도 쓰지 않아요
//   - 사진: sharp (회전 정보 반영). sharp가 못 여는 사진은 ImageMagick으로 임시 jpg를 만들어 다시 처리
//   - 영상: FFmpeg로 1초 지점 장면을 임시 jpg로 뽑고 sharp로 webp 변환 (1초보다 짧으면 첫 장면)
//   - 임시 이름으로 만든 뒤 이름을 바꿔요 → 중간에 꺼져도 깨진 썸네일이 남지 않아요 (임시 파일은 썸네일로 안 침)
//   - 읽을 수는 있는데 만들지 못하면(깨진 파일 등) thumb_state='failed'로 두고 null을 돌려줘요. request()는 파일 하나가 실패했다고 거절(reject)하지 않아요
//   - 원본을 읽을 수 없으면(USB를 뺐거나 파일이 없어짐) 상태를 바꾸지 않고 null만 돌려줘요 → 'none'으로 남아서 다시 연결하면 이어서 만들어요
//   - Electron은 쓰지 않아요 (lib/ 규칙). 화면에 전달하는 일은 gallery-main.js 와 lib/media-protocol.js 가 해요
//
// 모양: createThumbs({ db, thumbDir, getTools, isBusy, logger, maker })
//        → { request(id) → Promise<경로|null>, preview(id) → Promise<{ buffer, type }|null>,
//            startBackground(root), stop() → Promise, retryFailed(root), pruneOrphans() → Promise<지운 개수> }
//   getTools(): detectTools 결과와 같은 모양 { magick: {ok, path}, ffmpeg: {ok, path} } (없거나 ok가 아니면 못 쓰는 걸로 봐요)
//   isBusy(): 참이면 가져오기 중 → 백그라운드 만들기는 쉬어요 (화면에 보이는 요청은 계속 만들어요)
//   maker({ file, tmpPath, tools }): 점검용 선택 인자. 실제 만들기를 대신해서 tmpPath에 파일을 써요
//   ffmpegTimeoutMs: FFmpeg 제한 시간 (기본 60초, 점검에서 짧게 줄여 써요)
//   처음 쓸 때 한 번, 꺼지는 바람에 남은 임시 파일(thumbDir 안의 *.tmp-* 와 preview-*)을 지워요
//   pruneOrphans(): DB의 어느 파일과도 이름이 맞지 않는 옛 썸네일(.webp)을 지워요 (파일이 바뀌면 이름이 달라져서 옛 것이 남아요)
//     DB에 있는 파일은 폴더에서 사라졌어도(USB를 뺐을 때 등) 썸네일을 남겨요. 정리를 시작한 뒤 생긴 썸네일은 건드리지 않아요
//   pruneAllowed({ thumbDir, markerPath, freshDb }) → { allowed: 옛 썸네일 정리를 해도 되는지, markedNow: 이번에 끈 것인지 } (2026-11-04 사용자 결정)
//     library.db를 새로 만들었는데(처음 켬, 깨져서 다시 만듦) 썸네일 폴더에 이미 썸네일이 있으면,
//     새 DB는 다른 백업 폴더 기록을 몰라서 그 폴더 썸네일까지 지워요 (다시 만들면 54분) → 정리를 끄고 표시 파일을 남겨요
//     표시 파일이 있으면 그 뒤로도 정리하지 않아요 (썸네일 폴더가 조금 커지는 대신 다시 만들 일이 없어요)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runCmd } = require('./tools');
const { now } = require('./logger');

const THUMB_SIZE = 320;        // 썸네일 긴 변(px)
const PREVIEW_SIZE = 1200;     // 패널 미리보기 긴 변(px)
const WEBP_QUALITY = 75;
const FFMPEG_TIMEOUT_MS = 60000;  // FFmpeg가 멈춘 영상에 매달리지 않게
const MAGICK_TIMEOUT_MS = 60000;
const VISIBLE_LIMIT = 4;       // 화면에 보이는 요청 동시 개수
const BACKGROUND_LIMIT = 2;    // 백그라운드 동시 개수
const BACKGROUND_BATCH = 20;   // 백그라운드가 한 번에 대기열에서 가져오는 개수
const BUSY_POLL_MS = 500;      // 가져오기가 끝났는지 확인하는 간격
const MAGICK_TEMP_SIZE = 1280; // ImageMagick이 만드는 임시 jpg의 긴 변 (썸네일과 미리보기 둘 다 여기서 줄여요)

// sharp는 처음 쓸 때 불러와요. 파일 열기 캐시는 꺼서 점검 뒤 임시 폴더를 지울 때 파일이 잡혀 있지 않게 해요
let sharpLib = null;
function getSharp() {
  if (!sharpLib) {
    sharpLib = require('sharp');
    sharpLib.cache(false);
  }
  return sharpLib;
}

// 썸네일 파일 위치: <앞 2글자>/<sha1(path|size|mtimeMs)>.webp (파일이 바뀌면 이름이 달라져서 새로 만들어요)
function thumbPath(thumbDir, file) {
  const h = crypto.createHash('sha1').update(`${file.path}|${file.size}|${file.mtimeMs}`).digest('hex');
  return path.join(thumbDir, h.slice(0, 2), `${h}.webp`);
}

// DB의 파일 경로는 항상 절대 경로예요. 상대 경로면 작업 폴더 기준으로 엉뚱한 파일을 읽을 수 있어서 막아요 (썸네일, 미리보기 공통)
function assertAbsolute(file) {
  if (!path.isAbsolute(file.path)) throw new Error('원본 경로가 절대 경로가 아니에요');
}

// 원본 파일 정보를 읽을 수 있나 (연결이 끊겼거나 파일이 없으면 false)
function sourceReadable(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

// 폴더를 열어 볼 수 있나 (USB를 뺐거나 이름이 바뀌면 false)
function dirListable(p) {
  try {
    fs.opendirSync(p).closeSync();
    return true;
  } catch (e) {
    return false;
  }
}

// 내용이 있는 진짜 파일인가
function hasData(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0;
  } catch (e) {
    return false;
  }
}

// 임시 파일 지우기. 윈도우에서는 막 꺼진 프로그램이 잠깐 파일을 잡고 있을 수 있어서 몇 번 다시 시도해요
const removeQuiet = (p) => fs.promises.rm(p, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});

// 이미지(사진 또는 임시 jpg) → 긴 변 size 이하의 webp 내용. 회전 정보를 반영해요
function toWebpBuffer(input, size) {
  return getSharp()(input, { failOn: 'none' })
    .rotate()
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();
}

// ImageMagick으로 임시 jpg 만들기 (sharp가 못 여는 형식용). 성공하면 true
async function magickToJpg(tools, srcPath, jpgPath) {
  if (!tools.magick || !tools.magick.ok) return false;
  const size = `${MAGICK_TEMP_SIZE}x${MAGICK_TEMP_SIZE}>`;
  const r = await runCmd(tools.magick.path, [`${srcPath}[0]`, '-auto-orient', '-resize', size, '-quality', '90', jpgPath], { timeoutMs: MAGICK_TIMEOUT_MS });
  return !r.timedOut && r.code === 0 && hasData(jpgPath);
}

// 사진 → webp 내용. sharp가 실패하면 ImageMagick 임시 jpg로 다시 해요 (임시 jpg는 tempBase 옆에 만들고 꼭 지워요)
async function photoBuffer(file, size, tools, tempBase) {
  try {
    return await toWebpBuffer(file.path, size);
  } catch (firstError) {
    const jpg = `${tempBase}.magick.jpg`;
    try {
      if (!(await magickToJpg(tools, file.path, jpg))) throw firstError;
      return await toWebpBuffer(jpg, size);
    } finally {
      await removeQuiet(jpg);
    }
  }
}

// FFmpeg로 장면 한 장을 jpg로 뽑기 → 'ok' | 'timeout' | 'fail'
async function grabFrame(ffmpeg, videoPath, jpgPath, seek, timeoutMs) {
  await removeQuiet(jpgPath);
  const args = ['-nostdin', '-v', 'error', '-y']; // -nostdin: 키보드 입력을 기다리지 않게
  if (seek) args.push('-ss', '1'); // 입력 앞에 두면 빨리 건너뛰어요
  args.push('-i', videoPath, '-frames:v', '1', '-update', '1', jpgPath);
  const r = await runCmd(ffmpeg, args, { timeoutMs });
  if (r.timedOut) return 'timeout';
  return r.code === 0 && hasData(jpgPath) ? 'ok' : 'fail';
}

// 영상 → webp 내용: 길이가 1초 이상이면 1초 지점, 결과가 없으면 -ss 없이 한 번 더
async function videoBuffer(file, tools, tempBase, ffmpegTimeoutMs) {
  if (!tools.ffmpeg || !tools.ffmpeg.ok) throw new Error('FFmpeg를 쓸 수 없어요');
  const jpg = `${tempBase}.frame.jpg`;
  try {
    const seek = file.durationSec >= 1;
    let got = await grabFrame(tools.ffmpeg.path, file.path, jpg, seek, ffmpegTimeoutMs);
    if (got === 'fail' && seek) got = await grabFrame(tools.ffmpeg.path, file.path, jpg, false, ffmpegTimeoutMs);
    if (got === 'timeout') throw new Error('FFmpeg 시간 초과');
    if (got !== 'ok') throw new Error('영상에서 장면을 뽑지 못했어요');
    return await toWebpBuffer(jpg, THUMB_SIZE);
  } finally {
    await removeQuiet(jpg);
  }
}

// 실제 썸네일 만들기: tmpPath에 webp를 써요
async function defaultMaker({ file, tmpPath, tools, ffmpegTimeoutMs }) {
  const buf = file.mediaType === 'video'
    ? await videoBuffer(file, tools, tmpPath, ffmpegTimeoutMs)
    : await photoBuffer(file, THUMB_SIZE, tools, tmpPath);
  await fs.promises.writeFile(tmpPath, buf);
}

// 꺼지는 바람에 남은 임시 파일 치우기: thumbDir 바로 아래의 preview-* 와, 두 글자 폴더 안의 *.tmp-* 만 지워요 (진짜 .webp는 건드리지 않아요)
//   → 지운 개수
function sweepTemps(thumbDir) {
  let n = 0;
  const remove = (p) => {
    try {
      fs.rmSync(p, { force: true, maxRetries: 5, retryDelay: 100 });
      n++;
    } catch (e) { /* 못 지워도 넘어가요 */ }
  };
  let entries;
  try {
    entries = fs.readdirSync(thumbDir, { withFileTypes: true });
  } catch (e) {
    return 0; // 폴더가 아직 없음
  }
  for (const e of entries) {
    if (e.isFile() && e.name.startsWith('preview-')) {
      remove(path.join(thumbDir, e.name));
    } else if (e.isDirectory() && /^[0-9a-f]{2}$/.test(e.name)) {
      let inner = [];
      try {
        inner = fs.readdirSync(path.join(thumbDir, e.name), { withFileTypes: true });
      } catch (e2) { /* 읽을 수 없음 */ }
      for (const f of inner) {
        if (f.isFile() && f.name.includes('.tmp-')) remove(path.join(thumbDir, e.name, f.name));
      }
    }
  }
  return n;
}

// 옛 썸네일 지우기: thumbDir/<두 글자>/<이름>.webp 중 keep(이름 Set)에 없고 before(ms)보다 먼저 만든 것만 → 지운 개수
//   썸네일 폴더 안의 .webp만 봐요. 다른 파일, 다른 깊이는 건드리지 않아요. 하나를 못 지워도 계속해요
async function pruneOrphanThumbs(thumbDir, keep, before) {
  let removed = 0;
  let dirs;
  try {
    dirs = await fs.promises.readdir(thumbDir, { withFileTypes: true });
  } catch (e) {
    return 0; // 썸네일 폴더가 아직 없음
  }
  for (const d of dirs) {
    if (!d.isDirectory() || !/^[0-9a-f]{2}$/.test(d.name)) continue;
    const sub = path.join(thumbDir, d.name);
    let files;
    try {
      files = await fs.promises.readdir(sub, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !/^[0-9a-f]{40}\.webp$/.test(f.name) || keep.has(f.name)) continue;
      const full = path.join(sub, f.name);
      try {
        const st = await fs.promises.stat(full);
        if (st.mtimeMs >= before) continue; // 정리하는 동안 새로 만든 것
        await fs.promises.unlink(full);
        removed++;
      } catch (e) { /* 이미 없거나 잠겨 있으면 다음 기회에 */ }
    }
  }
  return removed;
}

// 썸네일 폴더에 썸네일(.webp)이 하나라도 있는지
function hasAnyThumb(thumbDir) {
  let dirs;
  try {
    dirs = fs.readdirSync(thumbDir, { withFileTypes: true });
  } catch (e) {
    return false;
  }
  for (const d of dirs) {
    if (!d.isDirectory() || !/^[0-9a-f]{2}$/.test(d.name)) continue;
    try {
      if (fs.readdirSync(path.join(thumbDir, d.name)).some((n) => /^[0-9a-f]{40}\.webp$/.test(n))) return true;
    } catch (e) { /* 못 읽는 폴더는 건너뜀 */ }
  }
  return false;
}

// 옛 썸네일 정리를 해도 되는지. 끌 때는 표시 파일을 남겨요 (못 남기면 onError로 알리고 이번 실행만 꺼요)
function pruneAllowed({ thumbDir, markerPath, freshDb, onError = () => {} }) {
  if (fs.existsSync(markerPath)) return { allowed: false, markedNow: false };
  if (!freshDb || !hasAnyThumb(thumbDir)) return { allowed: true, markedNow: false };
  try {
    fs.writeFileSync(markerPath, JSON.stringify({
      since: new Date().toISOString(),
      reason: 'library.db를 새로 만들 때 썸네일이 이미 있었어요. 다른 백업 폴더 썸네일을 지우지 않게 옛 썸네일 정리를 껐어요',
    }), 'utf8');
  } catch (e) {
    onError('옛 썸네일 정리 끄기 표시 쓰기', e);
  }
  return { allowed: false, markedNow: true };
}

function createThumbs({ db, thumbDir, getTools, isBusy, logger, maker, ffmpegTimeoutMs = FFMPEG_TIMEOUT_MS }) {
  let stopped = false;
  let swept = false;
  let seq = 0;
  const queue = [];            // 보이는 요청 대기열 (뒤에 들어온 것부터 꺼내요)
  let active = 0;
  const inflight = new Map();  // id → Promise (같은 사진을 두 번 만들지 않게)
  const running = new Set();   // 지금 하는 일 (stop이 끝나길 기다려요)
  let log = null;
  let bgRoot = null;
  let bgPromise = null;
  let bgAgain = false;
  let wakeBg = null;

  const toolsNow = () => {
    try {
      return (getTools && getTools()) || {};
    } catch (e) {
      return {};
    }
  };
  const busyNow = () => {
    try {
      return !!(isBusy && isBusy());
    } catch (e) {
      return false;
    }
  };
  const writeLog = (line) => {
    try {
      if (!logger) return;
      if (!log) log = logger.newLog('gallery-thumbs', `갤러리 썸네일 ${now()}\n썸네일 폴더: ${thumbDir}`);
      log.write(`[${now()}] ${line}`);
    } catch (e) { /* 로그를 못 써도 썸네일은 계속 */ }
  };
  // 처음 쓸 때 한 번만: 이전에 꺼지다 남은 임시 파일을 치워요
  const ensureSwept = () => {
    if (swept) return;
    swept = true;
    const n = sweepTemps(thumbDir);
    if (n > 0) writeLog(`남아 있던 임시 파일 ${n}개를 지웠어요`);
  };
  const setState = (id, state) => {
    try {
      db.setThumbState(id, state);
    } catch (e) {
      writeLog(`상태 저장 실패 (id ${id}, ${state}): ${e.message}`);
    }
  };
  const stateOf = (id) => {
    try {
      const f = db.getFile(id);
      return f ? f.thumbState : null;
    } catch (e) {
      return null;
    }
  };
  const track = (p) => {
    running.add(p);
    const done = () => running.delete(p);
    p.then(done, done);
    return p;
  };

  // 파일 한 개의 썸네일을 만들어요 → 경로 또는 null. 절대 거절(reject)하지 않아요
  async function produceFile(file) {
    try {
      const dest = thumbPath(thumbDir, file);
      if (hasData(dest)) { // 이미 있으면 다시 만들지 않고 ready로 (낡은 임시 파일은 이름이 달라서 여기에 안 걸려요)
        setState(file.id, 'ready');
        return dest;
      }
      assertAbsolute(file);
      let st;
      try {
        st = fs.statSync(file.path);
      } catch (e) {
        // 원본을 읽을 수 없는 건 사진 탓이 아니라 연결 문제일 수 있어서 failed로 기록하지 않아요 (none으로 두면 다시 연결한 뒤 이어서 만들어요)
        writeLog(`원본을 읽을 수 없어 건너뜀: ${file.path} (${e.code || e.message})`);
        return null;
      }
      if (!st.isFile() || st.size === 0) throw new Error('원본 파일이 비어 있어요');
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      const tmpPath = `${dest}.tmp-${process.pid}-${++seq}`;
      try {
        await (maker || defaultMaker)({ file, tmpPath, tools: toolsNow(), ffmpegTimeoutMs });
        if (!hasData(tmpPath)) throw new Error('썸네일이 만들어지지 않았어요');
        await fs.promises.rename(tmpPath, dest);
      } finally {
        await removeQuiet(tmpPath);
      }
      setState(file.id, 'ready');
      return dest;
    } catch (e) {
      // 만드는 도중에 연결이 끊긴 경우도 failed로 남기지 않아요
      if (path.isAbsolute(file.path) && !sourceReadable(file.path)) {
        writeLog(`만들다가 원본을 읽을 수 없게 돼 건너뜀: ${file.path} (${e.message})`);
        return null;
      }
      setState(file.id, 'failed');
      writeLog(`썸네일 실패: ${file.path} (${e.message})`);
      return null;
    }
  }

  // id로 찾아서 만들어요 (없거나 폴더에서 사라진 파일이면 null, 상태는 그대로)
  async function produceById(id) {
    let file;
    try {
      file = db.getFile(id);
    } catch (e) {
      return null;
    }
    if (!file || file.missing) return null;
    return produceFile(file);
  }

  // ---------- 화면에 보이는 요청: 동시에 4개, 나중에 온 요청부터 ----------
  function pump() {
    while (!stopped && active < VISIBLE_LIMIT && queue.length) {
      const job = queue.pop(); // 스크롤로 지나간 요청은 뒤로 밀려요
      active++;
      const p = Promise.resolve().then(job.run).then(job.resolve, () => job.resolve(null));
      track(p);
      p.then(() => {
        active--;
        pump();
      });
    }
  }
  function enqueue(run) {
    return new Promise((resolve) => {
      if (stopped) {
        resolve(null);
        return;
      }
      queue.push({ run, resolve });
      pump();
    });
  }

  function request(id) {
    if (stopped) return Promise.resolve(null);
    ensureSwept();
    const hit = inflight.get(id);
    if (hit) return hit;
    const p = enqueue(() => produceById(id));
    inflight.set(id, p);
    const clear = () => {
      if (inflight.get(id) === p) inflight.delete(id);
    };
    p.then(clear, clear);
    return p;
  }

  // 오른쪽 패널 미리보기: 사진은 긴 변 1200px을 그때그때 만들어 보내고 저장하지 않아요. 영상은 썸네일 파일 내용
  async function preview(id) {
    if (stopped) return null;
    ensureSwept();
    try {
      const file = db.getFile(id);
      if (!file || file.missing) return null;
      if (file.mediaType === 'video') {
        const p = await request(id);
        return p ? { buffer: await fs.promises.readFile(p), type: 'image/webp' } : null;
      }
      return await enqueue(async () => {
        const tempBase = path.join(thumbDir, `preview-${process.pid}-${++seq}`);
        try {
          assertAbsolute(file); // 썸네일 만들기와 같은 확인 (상대 경로는 작업 폴더 기준으로 읽혀버려요)
          await fs.promises.mkdir(thumbDir, { recursive: true });
          return { buffer: await photoBuffer(file, PREVIEW_SIZE, toolsNow(), tempBase), type: 'image/webp' };
        } catch (e) {
          writeLog(`미리보기 실패: ${file.path} (${e.message})`);
          return null;
        }
      });
    } catch (e) {
      writeLog(`미리보기 실패 (id ${id}): ${e.message}`);
      return null;
    }
  }

  // ---------- 백그라운드: 쉬는 동안 동시에 2개씩, 가져오기 중에는 쉬어요 ----------
  const bgSleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(() => {
      wakeBg = null;
      resolve();
    }, ms);
    wakeBg = () => {
      clearTimeout(t);
      wakeBg = null;
      resolve();
    };
  });

  // 대기열(none)의 파일을 보이는 요청과 같은 id면 합쳐서 만들어요
  function produceTracked(file) {
    const hit = inflight.get(file.id);
    if (hit) return hit;
    const p = track(produceFile(file).catch(() => null));
    inflight.set(file.id, p);
    const clear = () => {
      if (inflight.get(file.id) === p) inflight.delete(file.id);
    };
    p.then(clear, clear);
    return p;
  }

  async function backgroundPass(root) {
    const tried = new Set(); // 이번 회차에 시도한 파일 (같은 파일을 끝없이 다시 잡지 않게)
    const stuck = new Set(); // 시도했는데 원본을 읽을 수 없어 none으로 남은 파일 (계속 대기열 앞에 남아서, 그만큼 더 가져와야 뒤의 파일까지 닿아요)
    let made = 0;
    let failed = 0;
    writeLog(`백그라운드 시작: ${root}`);
    try {
      while (!stopped && bgRoot === root) {
        if (busyNow()) { // 가져오기 우선
          await bgSleep(BUSY_POLL_MS);
          continue;
        }
        // 폴더가 안 열리면(USB를 뺐거나 이름이 바뀜) 멈춰요. 남은 파일은 none 그대로 두고, 다시 연결해서 읽으면 갤러리가 새로 시작해요
        if (!dirListable(root)) {
          writeLog(`백업 폴더를 열 수 없어 백그라운드를 멈춰요: ${root}`);
          break;
        }
        const jobs = db.nextThumbJobs(root, BACKGROUND_BATCH + stuck.size).filter((j) => !tried.has(j.id)).slice(0, BACKGROUND_BATCH);
        if (!jobs.length) break;
        let next = 0;
        const worker = async () => {
          while (!stopped && bgRoot === root && next < jobs.length) {
            if (busyNow()) return;
            const job = jobs[next++];
            tried.add(job.id);
            if (await produceTracked(job)) made++;
            else if (stateOf(job.id) === 'none') stuck.add(job.id);
            else failed++;
          }
        };
        await Promise.all(Array.from({ length: BACKGROUND_LIMIT }, worker));
      }
    } catch (e) {
      writeLog(`백그라운드 오류: ${e.message}`);
    }
    writeLog(`백그라운드 끝: 만듦 ${made}개, 실패 ${failed}개, 원본을 읽을 수 없어 건너뜀 ${stuck.size}개${stopped ? ' (중지됨)' : ''}`);
  }

  function startBackground(root) {
    if (stopped) return bgPromise || Promise.resolve();
    ensureSwept();
    bgRoot = root;
    if (bgPromise) { // 이미 돌고 있으면 한 번 더 훑어 달라고만 표시
      bgAgain = true;
      if (wakeBg) wakeBg();
      return bgPromise;
    }
    const p = (async () => {
      do {
        bgAgain = false;
        await backgroundPass(bgRoot);
      } while (bgAgain && !stopped);
    })();
    bgPromise = p;
    track(p);
    p.then(() => {
      if (bgPromise === p) bgPromise = null;
    });
    return p;
  }

  // 실패했던 파일을 다시 대기로. 백그라운드가 이 root를 돌고 있으면 이어서 다시 만들어요
  function retryFailed(root) {
    db.resetFailedThumbs(root);
    if (!stopped && bgPromise && bgRoot === root) startBackground(root);
  }

  // 만들던 것은 끝내고(임시 파일 안 남김), 기다리던 요청은 null로 끝내요. 이후 요청도 null
  async function stop() {
    stopped = true;
    for (const job of queue.splice(0)) job.resolve(null);
    if (wakeBg) wakeBg();
    await Promise.allSettled([...running]);
  }

  // 옛 썸네일 정리. 실행 중에 한 번에 하나만 돌아요 (겹쳐 부르면 돌고 있는 것을 돌려줘요). 절대 거절(reject)하지 않아요
  let prunePromise = null;
  function pruneOrphans() {
    if (stopped) return Promise.resolve(0);
    if (prunePromise) return prunePromise;
    const p = (async () => {
      const startedAt = Date.now() - 1000; // 파일 시각의 오차만큼 여유를 둬요
      try {
        const keep = new Set(db.thumbKeys().map((f) => path.basename(thumbPath(thumbDir, f))));
        const n = await pruneOrphanThumbs(thumbDir, keep, startedAt);
        if (n > 0) writeLog(`쓰지 않는 옛 썸네일 ${n}개를 지웠어요`);
        return n;
      } catch (e) {
        writeLog(`옛 썸네일 정리 실패: ${e.message}`);
        return 0;
      }
    })();
    prunePromise = p;
    track(p);
    p.then(() => { prunePromise = null; });
    return p;
  }

  return { request, preview, startBackground, stop, retryFailed, pruneOrphans };
}

module.exports = { createThumbs, thumbPath, pruneOrphanThumbs, pruneAllowed, THUMB_SIZE, PREVIEW_SIZE };

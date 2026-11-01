// 파일 위치: gallery-main.js
// 역할: 갤러리를 main.js에 연결 — DB 열기, 폴더 읽기 시작 시점, 화면의 부탁(IPC), pvm:// 이미지 전달
//   실제 일은 lib/ 의 파일들이 해요: lib/db.js, lib/library.js, lib/thumbs.js, lib/media-protocol.js
//   (docs/superpowers/specs/2026-11-01-gallery-design.md 4, 7, 8절)
//
// ⚠️ 사진 파일은 읽기만 해요. 쓰는 곳은 userData 안의 library.db, thumbs 폴더, logs 폴더뿐이에요.
// ⚠️ 이 파일은 Electron을 쓰지만, 필요한 것은 모두 main.js가 넘겨줘요 (net만 pvm:// 응답할 때 직접 불러와요)
//
// 모양: registerScheme(protocol)  — app.whenReady 전에 한 번 (pvm:// 를 안전한 주소로 등록)
//       setupGallery({ ipcMain, protocol, getWin, getSettings, getTools, getEt, isRunning, logger, userDir,
//                      loadScreen, getJobPending, net })
//         → { onWindowReady(), onBatchDone(), onRootChanged(), close() }
//   loadScreen(name): 'import' | 'gallery' 화면으로 창을 바꿔요 (main.js가 해요)
//   getJobPending(): 이어할 가져오기 작업이 있는지
//   net: 점검용으로 바꿔 끼우는 선택 인자 (기본은 electron의 net)

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { openDb } = require('./lib/db');
const { createLibrary } = require('./lib/library');
const { createThumbs } = require('./lib/thumbs');
const { handleMedia } = require('./lib/media-protocol');
const { now } = require('./lib/logger');

const SCHEME = 'pvm';
const TABS = ['all', 'photo', 'video', 'screenshot'];
const SORTS = ['newest', 'oldest'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PROGRESS_GAP_MS = 100; // 읽기 진행 알림 최소 간격 (파일 찾는 동안 수천 번 보내지 않게)

// pvm:// 주소를 쓰려면 앱이 준비되기 전에 한 번 등록해야 해요 (app.whenReady 전에 불러요)
//   standard + secure = 일반 주소처럼 다뤄요(호스트 thumb/preview 를 읽을 수 있어요), supportFetchAPI = fetch 로도 가능
function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

// 화면에서 온 filter를 정해진 값만 남겨요 (SQL에는 어차피 매개변수로 가지만, 이상한 값은 처음부터 거르기)
function cleanFilter(f) {
  const x = f && typeof f === 'object' ? f : {};
  return {
    tab: TABS.includes(x.tab) ? x.tab : 'all',
    sort: SORTS.includes(x.sort) ? x.sort : 'newest',
    query: typeof x.query === 'string' ? x.query.slice(0, 200) : '',
    tag: typeof x.tag === 'string' && x.tag ? x.tag.slice(0, 200) : null,
  };
}

function setupGallery({ ipcMain, protocol, getWin, getSettings, getTools, getEt, isRunning, logger, userDir, loadScreen, getJobPending, net }) {
  const base = typeof userDir === 'function' ? userDir() : userDir;
  const rootNow = () => String((getSettings() && getSettings().backupRoot) || '').trim();
  const busy = () => {
    try {
      return !!isRunning();
    } catch (e) {
      return false;
    }
  };

  // 시작할 때 일어난 일(DB 새로 만듦, 열기 실패)을 로그 한 파일에 남겨요
  function startupLog(lines) {
    try {
      const log = logger.newLog('gallery-start', `갤러리 시작 ${now()}`);
      for (const l of lines) log.write(l);
    } catch (e) { /* 로그를 못 써도 프로그램은 계속 */ }
  }

  // ---------- DB 열기 ----------
  // 깨진 파일은 openDb가 이름을 바꿔 보관하고 새로 만들어요(recovered). 그 밖의 오류(잠김 등)는 갤러리만 끄고 가져오기는 그대로 써요
  let db = null;
  let dbError = '';
  let recoveredOnce = false; // getState가 한 번만 알려 줘요
  try {
    const r = openDb(path.join(base, 'library.db'));
    db = r.db;
    if (r.recovered) {
      recoveredOnce = true;
      startupLog(['library.db가 깨져 있어서 이름을 바꿔 보관하고 새로 만들었어요 (폴더를 처음부터 다시 읽어요)']);
    }
  } catch (e) {
    dbError = `목록 파일(library.db)을 열지 못했어요: ${e && e.message ? e.message : e}`;
    startupLog([dbError]);
  }

  // ---------- 화면에 알리기 ----------
  const send = (ch, data) => {
    const win = getWin();
    if (win && !win.isDestroyed()) win.webContents.send(ch, data);
  };
  const scan = { scanning: false, phase: '', done: 0, total: 0 };
  let lastSent = 0;
  const pushScan = (force) => {
    const t = Date.now();
    if (!force && t - lastSent < PROGRESS_GAP_MS) return;
    lastSent = t;
    send('gallery:scan-progress', { ...scan });
  };
  let lastStatus = ''; // 마지막 읽기 결과 (done, disconnected, no-exiftool, error ...)

  // ---------- 읽기와 썸네일 ----------
  let library = null;
  let thumbs = null;
  if (db) {
    thumbs = createThumbs({ db, thumbDir: path.join(base, 'thumbs'), getTools, isBusy: busy, logger });
    library = createLibrary({
      db,
      getEt,
      logger,
      isBusy: busy,
      onProgress: (p) => {
        const phaseChanged = p.phase !== scan.phase;
        scan.scanning = true;
        scan.phase = p.phase;
        scan.done = p.done;
        scan.total = p.total;
        pushScan(phaseChanged);
      },
      onChanged: () => send('gallery:library-changed'),
    });
  }

  // 폴더 읽기 시작. 같은 요청은 library가 합쳐 줘요. 끝까지 읽었을 때(done)만 썸네일 백그라운드를 시작해요
  async function runScan(root, options) {
    if (!library) return { status: 'no-db' };
    if (!root) return { status: 'no-root' };
    scan.scanning = true;
    pushScan(true);
    let result;
    try {
      result = await library.scan(root, options);
    } catch (e) {
      result = { status: 'error', error: e && e.message ? e.message : String(e) };
    }
    lastStatus = result.status;
    if (!library.isScanning()) { // 이어서 읽을 요청이 없을 때만 "읽는 중" 끝
      scan.scanning = false;
      scan.phase = '';
    }
    pushScan(true);
    if (result.status === 'done' && root === rootNow() && thumbs) thumbs.startBackground(root);
    return result;
  }

  // ---------- 화면의 부탁 ----------
  ipcMain.handle('gallery:get-state', () => {
    const root = rootNow();
    const t = getTools() || {};
    const out = {
      root,
      connected: !!root && isDir(root),
      total: 0,
      noDate: 0,
      tagCount: 0,
      tags: [],
      scan: { ...scan },
      scanStatus: lastStatus,
      tools: { exiftool: !!(t.exiftool && t.exiftool.ok), ffmpeg: !!(t.ffmpeg && t.ffmpeg.ok) },
      jobPending: !!(getJobPending && getJobPending()),
    };
    if (dbError) out.dbError = dbError;
    if (recoveredOnce) {
      out.recovered = true;
      recoveredOnce = false;
    }
    if (db && root) {
      try {
        Object.assign(out, db.summary(root));
      } catch (err) {
        out.dbError = `목록을 읽지 못했어요: ${err && err.message ? err.message : err}`;
      }
    }
    return out;
  });

  ipcMain.handle('gallery:list-days', (e, filter) => {
    const root = rootNow();
    return db && root ? db.listDays(root, cleanFilter(filter)) : [];
  });

  ipcMain.handle('gallery:list-files', (e, day, filter) => {
    if (day !== null && !(typeof day === 'string' && DAY_RE.test(day))) throw new Error('날짜 모양이 올바르지 않아요');
    const root = rootNow();
    return db && root ? db.listFiles(root, day, cleanFilter(filter)) : [];
  });

  // 패널에 보일 정보. 파일 경로(path, root)는 화면에 주지 않아요 (화면은 경로를 몰라도 돼요)
  ipcMain.handle('gallery:get-file', (e, id) => {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('파일 번호가 올바르지 않아요');
    const f = db ? db.getFile(id) : null;
    if (!f) return null;
    const { path: ignoredPath, root: ignoredRoot, ...safe } = f;
    return safe;
  });

  // 다시 읽기: 실패했던 썸네일을 대기로 돌리고, 읽기 실패했던 파일도 다시 읽어요
  ipcMain.handle('gallery:rescan', async () => {
    const root = rootNow();
    if (!db || !root) return { status: db ? 'no-root' : 'no-db' };
    thumbs.retryFailed(root);
    const r = await runScan(root, { retryErrors: true });
    return { status: r.status };
  });

  ipcMain.handle('gallery:open-screen', async (e, name) => {
    if (name !== 'import' && name !== 'gallery') throw new Error('알 수 없는 화면이에요');
    if (busy()) throw new Error('작업이 끝난 뒤에 화면을 바꿀 수 있어요');
    await loadScreen(name);
    return true;
  });

  // ---------- pvm:// 이미지 전달 ----------
  //   화면은 pvm://thumb/<id>, pvm://preview/<id> 로만 요청해요. 판단은 lib/media-protocol.js 가 해요 (이상한 주소는 404)
  const notFound = () => new Response(null, { status: 404 });
  protocol.handle(SCHEME, async (request) => {
    try {
      if (!db) return notFound();
      const r = await handleMedia(request.url, { db, thumbs });
      if (r.status !== 200) return notFound();
      // 같은 id의 사진이 바뀌면 썸네일도 바뀌니 화면이 옛 그림을 붙들지 않게 해요
      const headers = { 'Content-Type': r.type, 'Cache-Control': 'no-cache' };
      if (r.buffer) return new Response(r.buffer, { status: 200, headers });
      // 한글, #, % 가 든 경로도 안전하게 file:// 주소로 바꿔요
      const netFetch = (net || require('electron').net).fetch;
      const res = await netFetch(pathToFileURL(r.path).toString());
      if (!res.ok) return notFound();
      return new Response(res.body, { status: 200, headers });
    } catch (e) {
      return notFound();
    }
  });

  // ---------- main.js가 부르는 것들 ----------
  let started = false;
  return {
    // 창이 처음 열리면: 백업 폴더가 있으면 읽기 시작
    onWindowReady() {
      if (started) return;
      started = true;
      const root = rootNow();
      if (root) runScan(root, {});
    },
    // 가져오기 묶음이 끝나면: 읽는 중이어도 새 파일을 놓치지 않게 changed 로 다시 읽어요
    onBatchDone() {
      const root = rootNow();
      if (root) runScan(root, { changed: true });
    },
    // 설정에서 백업 폴더가 바뀌면: 새 폴더를 읽어요 (읽던 다른 폴더는 library가 멈춰요)
    onRootChanged() {
      send('gallery:library-changed');
      const root = rootNow();
      if (root) runScan(root, {});
    },
    // 프로그램을 끌 때: 진행 중인 FFmpeg를 기다리지 않고 멈추라고만 하고 DB를 닫아요
    close() {
      try {
        if (thumbs) thumbs.stop().catch(() => {});
      } catch (e) { /* 끄는 중이라 무시 */ }
      try {
        if (db) db.close();
      } catch (e) { /* 이미 닫힘 */ }
    },
  };
}

module.exports = { setupGallery, registerScheme };

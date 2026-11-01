// 파일 위치: gallery-main.js
// 역할: 갤러리를 main.js에 연결 — DB 열기, 폴더 읽기 시작 시점, 화면의 부탁(IPC), pvm:// 이미지 전달
//   실제 일은 lib/ 의 파일들이 해요: lib/db.js, lib/library.js, lib/thumbs.js, lib/media-protocol.js
//   (docs/superpowers/specs/2026-11-01-gallery-design.md 4, 7, 8절)
//   날짜와 위치 직접 넣기: lib/manual-edit.js (미리보기 계산), lib/manual-journal.js (기록 파일, 복구)
//   (docs/superpowers/specs/2026-11-01-missing-info-design.md 5, 6, 7, 9, 10절)
//
// ⚠️ 사진 파일은 읽기만 해요. 쓰는 곳은 userData 안의 library.db, manual-edits.jsonl, thumbs 폴더, logs 폴더뿐이에요.
// ⚠️ Electron이 필요한 것은 모두 main.js에서 받아요 (net만 pvm:// 파일 응답 때 그때그때 불러와서, 일반 Node에서도 이 파일을 불러올 수 있어요)
// ⚠️ 인터넷에 나가는 예외는 지도 하나예요: 지도 그림(pvm://tile)과 장소 검색(gallery:search-place)을 lib/map-net.js 가 대신 받아 와요.
//    나가는 것은 지도 번호, 검색어, 앱 이름표뿐이에요 (사진, 파일 이름, 경로, 좌표 목록은 안 나가요). 창을 열거나 목록을 읽을 때는 나가지 않아요
//    지도 출처 링크는 gallery:open-map-credit 이 고정 주소 하나만 기본 브라우저로 열어요
//    (docs/superpowers/specs/2026-11-02-map-pick-design.md 4, 5절)
//
// 모양: registerScheme(protocol)  — app.whenReady 전에 한 번 (pvm:// 를 안전한 주소로 등록)
//       setupGallery({ ipcMain, protocol, getWin, getSettings, getTools, getEt, isRunning, logger, userDir,
//                      loadScreen, getJobPending, isPlanning, mapFetch, openExternal, appVersion })
//         → { onWindowReady(), onBatchDone(), onRootChanged(), onToolsChanged(), close() }
//   loadScreen(name): 'import' | 'gallery' 화면으로 창을 바꿔요 (main.js가 해요)
//   getJobPending(): 이어할 가져오기 작업이 있는지
//   isPlanning(): 미리보기를 만드는 중인지 (중이면 화면 전환을 막아요)
//   mapFetch(url, init): 지도용 인터넷 요청 (main.js 가 net.fetch 를 넘겨요). 없으면 지도를 쓸 때만 실패해요
//   openExternal(url): 기본 브라우저로 열기 (main.js 가 shell.openExternal 을 넘겨요)
//   appVersion: 앱 버전 글자 (지도 서버에 보내는 앱 이름표에 들어가요)

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { openDb } = require('./lib/db');
const { createLibrary } = require('./lib/library');
const { createThumbs } = require('./lib/thumbs');
const { handleMedia } = require('./lib/media-protocol');
const { now } = require('./lib/logger');
const { normalizeRequest, planEdit, toPreview, MAX_TARGETS } = require('./lib/manual-edit');
const { createJournal, recover } = require('./lib/manual-journal');
const { buildSuggestions } = require('./lib/location-suggest');
const { createSkips } = require('./lib/suggest-skips');
const { createMapNet } = require('./lib/map-net');

const SCHEME = 'pvm';
const TABS = ['all', 'photo', 'video', 'screenshot'];
const SORTS = ['newest', 'oldest'];
const INFOS = ['noLocation', 'noDate', 'manual']; // 정보 없는 사진 화면의 탭
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAP_CREDIT_URL = 'https://www.openstreetmap.org/copyright'; // 지도 출처 링크 (고정 주소. 화면이 주소를 정하지 못해요)
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
    info: INFOS.includes(x.info) ? x.info : null,
  };
}

// 화면에서 온 id 배열 검사: 1 이상의 안전한 정수만, 한 번에 최대 MAX_TARGETS개
function checkIds(ids) {
  // 너무 많이 골랐을 때는 이유를 그대로 알려 줘요
  if (Array.isArray(ids) && ids.length > MAX_TARGETS) {
    throw new Error(`한 번에 ${MAX_TARGETS.toLocaleString('en-US')}장까지만 넣을 수 있어요. 선택을 줄여 주세요.`);
  }
  if (!Array.isArray(ids) || !ids.every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('파일 번호 목록이 올바르지 않아요');
  }
  return ids;
}

// 화면에 보여 줄 오류 글에는 파일 경로가 들어가면 안 돼요. 원래 오류 글(경로가 섞여 있을 수 있어요)은 로그에만 남기고,
// 화면에는 정해진 문장과 오류 코드(EISDIR, EACCES 같은 짧은 영문 대문자)만 보여요
const codeNote = (e) => (e && typeof e.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(e.code) ? ` (${e.code})` : '');

function setupGallery({ ipcMain, protocol, getWin, getSettings, getTools, getEt, isRunning, logger, userDir, loadScreen, getJobPending, isPlanning, mapFetch, openExternal, appVersion }) {
  const base = typeof userDir === 'function' ? userDir() : userDir;
  // 백업 폴더 경로. 끝의 \ 나 / 가 달라도 같은 폴더로 보게 path.resolve 로 한 번만 다듬어요 (대소문자는 그대로 둬요).
  //   DB의 root 열쇠가 되니 모든 곳이 이 함수 하나를 써요
  const rootNow = () => {
    const raw = String((getSettings() && getSettings().backupRoot) || '').trim();
    return raw ? path.resolve(raw) : '';
  };
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

  // 기다리지 않는 일(runScan 등)이 실패해도 프로그램이 멈추지 않게 로그만 남겨요
  function errorLog(where, e) {
    try {
      logger.newLog('gallery-error', `갤러리 오류 ${now()}\n${where}: ${e && e.message ? e.message : e}`);
    } catch (err) { /* 로그를 못 써도 프로그램은 계속 */ }
  }

  // ---------- 지도 인터넷 연결 ----------
  //   만들기만 해서는 인터넷에 나가지 않아요 (지도 그림이나 검색을 요청받을 때만 나가요)
  //   로그에는 어디서(where)와 상태 코드만 남겨요. 검색어와 설정 주소 값은 map-net 이 넘기지 않아요
  const mapNet = createMapNet({
    fetchImpl: (...a) => mapFetch(...a), // mapFetch 가 없으면 쓸 때 오류가 나고, map-net 이 실패로 처리해요
    getSettings,
    version: appVersion,
    onError: (where, code) => errorLog(`지도 ${where}`, code),
  });

  // ---------- 직접 넣은 값의 기록 파일 ----------
  //   userData/manual-edits.jsonl 에 넣기와 되돌리기를 먼저 적어 둬요. DB가 새로 만들어져도 켤 때 여기서 값을 되살려요
  const journal = createJournal(path.join(base, 'manual-edits.jsonl'));
  if (db) {
    // 복구가 실패해도 갤러리는 켜요 (오류 로그만 남김). recover 는 줄 하나가 틀려도 던지지 않지만 혹시 몰라 한 번 더 감싸요
    try {
      const r = recover(db, journal);
      if (r.applied || r.undone || r.skipped) {
        // 건너뛴 이유도 같이 남겨요 (묶음 번호, 종류, 이유). 사진 파일 경로는 안 들어가는 글만이에요
        const why = (r.errors || []).map((x) => `  건너뜀: ${x.batchId ? `묶음 ${x.batchId} ` : ''}(${x.type}) ${x.message}`);
        startupLog([`기록 파일에서 직접 넣은 값을 복구했어요: 넣기 ${r.applied}개, 되돌리기 ${r.undone}개, 건너뜀 ${r.skipped}개`, ...why]);
      }
    } catch (e) {
      errorLog('직접 넣은 값 복구', e);
    }
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
      noLocation: 0,
      noInfo: 0,
      manualCount: 0,
      lastBatch: null,
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
        out.lastBatch = db.lastBatch(root); // { id, kind, count, createdAt } 또는 null (되돌리기 버튼용)
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

  // 조건에 맞는 파일 id 전체 ("목록 전체 선택"용). 순서는 화면 목록과 같아요
  ipcMain.handle('gallery:list-ids', (e, filter) => {
    const root = rootNow();
    return db && root ? db.listIds(root, cleanFilter(filter)) : [];
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
    // 미리보기가 늦게 끝나 다른 화면에서 만든 계획을 덮어쓰지 않게, 미리보기 중에도 막아요
    let planningNow = false;
    try {
      planningNow = !!(isPlanning && isPlanning());
    } catch (err) { /* 모르면 막지 않아요 */ }
    if (planningNow) throw new Error('미리보기가 끝난 뒤에 화면을 바꿀 수 있어요');
    await loadScreen(name);
    return true;
  });

  // ---------- 날짜와 위치 직접 넣기 ----------
  //   순서: 검사 → 다시 계산 → 기록 파일에 먼저 적기 → DB 저장 → (저장이 실패하면 void) → 로그 → 화면 알림
  //   화면이 본 미리보기는 믿지 않고, 넣을 때 main이 처음부터 다시 계산해서 저장해요.
  //   ⚠️ 사진 파일은 건드리지 않아요. 쓰는 곳은 DB, 기록 파일(manual-edits.jsonl), 로그뿐이에요.
  //   백업 폴더가 연결되지 않아도 돼요 (DB와 기록 파일만 쓰므로)

  // 가져오기 중이거나 DB, 백업 폴더가 없으면 못 해요. 준비됐으면 지금 백업 폴더(root)를 돌려줘요
  function editReady() {
    if (busy()) throw new Error('가져오기가 끝난 뒤에 할 수 있어요');
    // 원인(경로가 섞일 수 있음)은 시작 로그에 있어서 화면에는 정해진 문장만 보여요
    if (!db) throw new Error('목록 파일(library.db)을 열지 못해서 할 수 없어요. 프로그램을 다시 켜 보세요');
    const root = rootNow();
    if (!root) throw new Error('백업 폴더를 먼저 정해 주세요');
    return root;
  }

  // 검사하고 다시 계산해요: ids, edit 모양 → 기준 사진 확인 → 미리보기 계산 (DB는 읽기만)
  //   기준 사진이 없거나 사라졌거나(missing) 다른 폴더 것이면 sourceRow 를 비워서 "다시 복사해 주세요"로 거절돼요
  function computePlan(root, ids, edit) {
    checkIds(ids);
    let sourceRow = null;
    if (edit && typeof edit === 'object' && edit.source === 'copy' && Number.isSafeInteger(edit.sourceId) && edit.sourceId > 0) {
      const s = db.getFile(edit.sourceId);
      if (s && !s.missing && s.root === root) sourceRow = s;
    }
    const resolved = normalizeRequest(edit, { sourceRow, year: new Date().getFullYear() });
    return planEdit(db.getFilesByIds(ids), resolved, (p) => db.getManual(p), root);
  }

  // DB에 저장하는 일만 try 로 감싸요. 실패하면 기록 파일에 void 를 적어서 다음에 켤 때 이 작업이 다시 적용되지 않게 해요.
  //   (저장이 끝난 뒤의 로그, 알림이 실패한 것을 void 로 적으면 안 되니까 저장 한 줄만 이 안에 둬요)
  //   void 마저 적지 못하면 그 사실을 오류 글에 같이 알려요
  //   오류 글에는 정해진 문장과 오류 코드만 써요 (원래 오류 글은 경로가 섞일 수 있어서 로그에만 남겨요)
  //   of: 'apply' | 'undo', what: 오류 글에 쓸 이름
  function saveOrVoid(of, batchId, what, save) {
    try {
      save();
    } catch (err) {
      let voidNote = '';
      try {
        journal.append({ type: 'void', of, batchId });
      } catch (err2) {
        errorLog(`${what} 취소 표시(void) 쓰기`, err2);
        voidNote = ` 취소 표시도 기록 파일에 남기지 못해서, 다음에 프로그램을 켜면 이 ${what}가 다시 적용될 수 있어요.`;
      }
      errorLog(`${what} DB 저장`, err);
      throw new Error(`${what}를 저장하지 못했어요${codeNote(err)}. 자세한 내용은 로그 폴더의 오류 로그에 있어요.${voidNote}`);
    }
  }

  // 저장이 끝난 뒤의 마무리: 로그 파일(묶음 번호, 개수, 파일별 전후 값)과 화면 알림. 실패해도 이미 저장된 작업은 그대로예요
  //   파일별 줄은 makeLines()로 이 try 안에서 만들어요 (만들다 던져도 저장된 작업을 실패로 만들지 않게)
  //   note: 머리글에 더할 줄 (값 넣기의 방법과 근거 사진)
  function finishEdit(title, batchId, kind, count, makeLines, note = '') {
    try {
      const lines = makeLines();
      const log = logger.newLog('manual-edit', `${title} ${now()}\n묶음 ${batchId}\n종류 ${kind}\n개수 ${count}${note}`);
      if (lines.length) log.write(lines.join('\n')); // 수천 줄도 한 번에 써요
    } catch (err) {
      errorLog(`${title} 로그`, err);
    }
    try {
      send('gallery:library-changed');
    } catch (err) {
      errorLog(`${title} 화면 알림`, err);
    }
  }

  const locText = (v) => (!v || v.lat === null || v.lat === undefined ? '없음' : `${v.lat},${v.lng}`);
  const dateText = (v) => (v && v.takenAt ? v.takenAt : '없음');

  // 복사할 기준 사진의 값 요약 (파일 경로 없음). 없거나 사라졌거나 다른 폴더 것이면 null
  ipcMain.handle('gallery:get-copy-source', (e, id) => {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('파일 번호가 올바르지 않아요');
    const root = rootNow();
    if (!db || !root) return null;
    const f = db.getFile(id);
    if (!f || f.missing || f.root !== root) return null;
    return { id: f.id, name: f.name, takenAt: f.takenAt, lat: f.lat, lng: f.lng };
  });

  // 미리보기: 아무것도 저장하지 않아요
  ipcMain.handle('gallery:preview-edit', (e, ids, edit) => {
    const root = editReady();
    return toPreview(computePlan(root, ids, edit));
  });

  // 위치 제안으로 넣기 전의 검사: 화면이 보낸 값을 믿지 않아요
  //   위치만 넣는지, 근거 사진이 그대로 있고 파일에서 읽은 위치인지, 대상이 같은 날인지 봐요.
  //   그 사이 위치가 생긴 대상은 덮어쓰지 않고 빼요. 돌려주는 값: { ids: 넣을 번호들, dropped: 뺀 장수 }
  function checkSuggestEdit(root, ids, edit) {
    checkIds(ids);
    if (edit.source !== 'copy' || edit.location !== true || edit.date === true || edit.time === true) {
      throw new Error('위치 제안은 위치만 넣을 수 있어요.');
    }
    const source = Number.isSafeInteger(edit.sourceId) && edit.sourceId > 0 ? db.getFile(edit.sourceId) : null;
    if (!source || source.missing || source.root !== root) throw new Error('근거 사진을 찾을 수 없어요. 제안 목록을 다시 확인해 주세요.');
    if (source.locationSource === 'manual') throw new Error('근거 사진의 위치가 직접 넣은 값으로 바뀌었어요. 제안 목록을 다시 확인해 주세요.');
    const rows = db.getFilesByIds(ids);
    if (rows.some((r) => r.takenDay !== source.takenDay)) throw new Error('근거 사진과 다른 날에 찍은 사진에는 넣을 수 없어요.');
    const empty = rows.filter((r) => r.lat === null || r.lat === undefined);
    return { ids: empty.map((r) => r.id), dropped: rows.length - empty.length };
  }

  // 넣기: 다시 계산해서 바뀌는 파일만 저장해요. 바꿀 것이 없으면 아무것도 쓰지 않고 count 0
  //   기록 파일과 로그에는 어떻게 넣었는지(via)와 근거 사진(sourcePath)을 같이 남겨요
  ipcMain.handle('gallery:apply-edit', (e, ids, edit) => {
    const root = editReady();
    const suggested = !!edit && typeof edit === 'object' && edit.via === 'suggest';
    if (edit && typeof edit === 'object' && edit.via !== undefined && !suggested) throw new Error('넣는 방법이 올바르지 않아요.');
    const checked = suggested ? checkSuggestEdit(root, ids, edit) : { ids, dropped: 0 };
    const plan = computePlan(root, checked.ids, edit);
    const changed = plan.items.filter((it) => it.status === 'changed');
    if (!changed.length) return { batchId: null, kind: plan.kind, count: 0, dropped: checked.dropped };

    const batchId = crypto.randomUUID();
    const at = new Date().toISOString();
    const items = changed.map((it) => ({ path: it.path, before: it.beforeManual, after: it.afterManual }));
    const via = suggested ? 'suggest' : edit.source === 'direct' ? 'direct' : edit.source === 'pin' ? 'map' : 'copy';
    const sourcePath = edit.source !== 'copy' ? null : db.getFile(edit.sourceId).path; // 직접 넣기와 지도 핀은 근거 사진이 없어요. 복사는 computePlan이 이미 확인했어요

    // 1) 기록 파일에 먼저. 못 쓰면 거절하고 DB는 바꾸지 않아요
    try {
      journal.append({ type: 'apply', batchId, at, root, kind: plan.kind, via, sourcePath, items });
    } catch (err) {
      errorLog('값 넣기 기록 파일 쓰기', err);
      throw new Error(`기록 파일에 쓰지 못해서 값을 넣지 않았어요${codeNote(err)}. 자세한 내용은 로그 폴더의 오류 로그에 있어요.`);
    }
    // 2) DB 저장 (실패하면 void)
    saveOrVoid('apply', batchId, '값 넣기', () => db.applyManualBatch({ id: batchId, root, kind: plan.kind, createdAt: at, items }));
    // 3) 로그와 알림
    finishEdit(suggested ? '위치 제안 넣기' : via === 'map' ? '지도로 넣기' : '직접 넣기', batchId, plan.kind, changed.length, () => changed.map((it) =>
      `${it.path}\t날짜 ${dateText(it.before)} → ${dateText(it.after)}\t위치 ${locText(it.before)} → ${locText(it.after)}`),
    `\n방법 ${via}\n근거 ${sourcePath === null ? '없음' : sourcePath}`);
    return { batchId, kind: plan.kind, count: changed.length, dropped: checked.dropped };
  });

  // ---------- 위치 제안 ----------
  //   계산만 하고 값은 넣지 않아요. 넣기는 사용자가 버튼을 누르면 위의 apply-edit 로 와요
  const skips = createSkips(path.join(base, 'suggest-skips.json'), { onError: errorLog });

  // 제안 묶음 목록. 파일 경로는 화면에 주지 않아요
  ipcMain.handle('gallery:list-suggestions', () => {
    const root = editReady();
    const r = buildSuggestions(db.listSuggestionRows(root), skips.paths());
    return {
      ...r,
      groups: r.groups.map((g) => ({ ...g, targets: g.targets.map(({ path: _path, ...t }) => t) })),
    };
  });

  // 건너뛰기: 번호를 경로로 바꿔 지금 백업 폴더의 사진만 더해요. saved = 파일에 저장했는지
  ipcMain.handle('gallery:skip-suggestions', (e, ids) => {
    const root = editReady();
    checkIds(ids);
    const paths = db.getFilesByIds(ids).filter((f) => f.root === root).map((f) => f.path);
    return { saved: skips.add(paths) };
  });

  // 건너뛴 사진 다시 보기: 목록을 비워요. 사진 파일과 값에는 영향이 없어요
  ipcMain.handle('gallery:clear-suggestion-skips', () => {
    editReady();
    return { saved: skips.clear() };
  });

  // 되돌리기: 이 백업 폴더의 마지막 묶음만. 없으면 null
  //   화면이 버튼에 적힌 묶음의 번호(batchId)를 같이 보내요. 마지막 묶음이 그 사이 바뀌었으면 거절해요
  //   (두 번 눌러서 이미 되돌린 줄 모르고 그 앞 묶음까지 되돌리는 일을 막으려고. 기록 파일도 DB도 건드리지 않아요)
  ipcMain.handle('gallery:undo-last', (e, batchId) => {
    const root = editReady();
    if (typeof batchId !== 'string' || !batchId || batchId.length > 100) throw new Error('되돌릴 작업 번호가 올바르지 않아요.');
    const last = db.lastBatch(root);
    if (!last) return null;
    if (last.id !== batchId) throw new Error('마지막으로 넣은 작업이 바뀌었어요. 화면을 확인하고 다시 눌러 주세요.');
    const at = new Date().toISOString();
    try {
      journal.append({ type: 'undo', batchId: last.id, at });
    } catch (err) {
      errorLog('되돌리기 기록 파일 쓰기', err);
      throw new Error(`기록 파일에 쓰지 못해서 되돌리지 않았어요${codeNote(err)}. 자세한 내용은 로그 폴더의 오류 로그에 있어요.`);
    }
    saveOrVoid('undo', last.id, '되돌리기', () => db.undoBatch(last.id, at));
    // 되돌리기 로그: 파일별로 "되돌리기 전(넣었던 값) → 되돌린 뒤(그 전 값, 직접 넣은 값이 없었으면 없음)"
    finishEdit('직접 넣은 값 되돌리기', last.id, last.kind, last.count, () => db.batchItems(last.id).map((it) =>
      `${it.path}\t직접 넣은 날짜 ${dateText(it.after)} → ${dateText(it.before)}\t직접 넣은 위치 ${locText(it.after)} → ${locText(it.before)}`));
    return { kind: last.kind, count: last.count };
  });

  // ---------- 장소 검색과 지도 출처 ----------
  //   검색어 검사와 실패 문장은 map-net 이 정해요. 거절 문장을 그대로 화면에 넘겨요 (검색어는 로그에 안 남아요)
  ipcMain.handle('gallery:search-place', (e, query) => mapNet.search(query));

  // 지도 출처 링크: 화면은 주소를 보내지 않고, 고정 주소 하나만 기본 브라우저로 열어요
  ipcMain.handle('gallery:open-map-credit', async () => {
    try {
      await openExternal(MAP_CREDIT_URL);
    } catch (err) {
      errorLog('지도 출처 링크 열기', err);
      throw new Error('브라우저를 열지 못했어요.');
    }
    return true;
  });

  // ---------- pvm:// 이미지 전달 ----------
  //   화면은 pvm://thumb/<id>, pvm://preview/<id> 로만 요청해요. 판단은 lib/media-protocol.js 가 해요 (이상한 주소는 404)
  //   pvm://tile/<z>/<x>/<y> 는 지도 그림이에요. 사진 번호를 쓰지 않아서 DB가 없어도 되고, map-net 이 인터넷에서 받아 와요
  const notFound = () => new Response(null, { status: 404 });
  protocol.handle(SCHEME, async (request) => {
    try {
      if (new URL(request.url).hostname === 'tile') {
        const t = await mapNet.tile(request.url);
        if (t.status !== 200) return notFound();
        return new Response(t.buffer, { status: 200, headers: { 'Content-Type': t.type, 'Cache-Control': 'no-cache' } });
      }
      if (!db) return notFound();
      const r = await handleMedia(request.url, { db, thumbs });
      if (r.status !== 200) return notFound();
      // 같은 id의 사진이 바뀌면 썸네일도 바뀌니 화면이 옛 그림을 붙들지 않게 해요
      const headers = { 'Content-Type': r.type, 'Cache-Control': 'no-cache' };
      if (r.buffer) return new Response(r.buffer, { status: 200, headers });
      // 한글, #, % 가 든 경로도 안전하게 file:// 주소로 바꿔요
      const netFetch = require('electron').net.fetch;
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
      if (root) runScan(root, {}).catch((e) => errorLog('시작 읽기', e));
    },
    // 가져오기 묶음이 끝나면: 읽는 중이어도 새 파일을 놓치지 않게 changed 로 다시 읽어요
    onBatchDone() {
      const root = rootNow();
      if (root) runScan(root, { changed: true }).catch((e) => errorLog('가져오기 뒤 다시 읽기', e));
    },
    // 설정에서 백업 폴더가 바뀌면: 새 폴더를 읽어요 (읽던 다른 폴더는 library가 멈춰요)
    onRootChanged() {
      send('gallery:library-changed');
      const root = rootNow();
      if (root) runScan(root, {}).catch((e) => errorLog('백업 폴더 바뀐 뒤 읽기', e));
    },
    // 도구(exiftool)를 새로 찾아 바뀌었으면: 옛 도구로 읽다 오류로 끝났거나 'exiftool 없음'이던 읽기를 한 번 다시 해요
    //   읽는 중이면 library가 이어서 한 번 더 읽도록 합쳐 줘요
    onToolsChanged() {
      const root = rootNow();
      if (root) runScan(root, { changed: true }).catch((e) => errorLog('도구 다시 찾은 뒤 읽기', e));
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

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
//    장소 이름(gallery:place-name)은 사용자가 "장소 이름 보기"를 누른 사진 한 장의 좌표만, 소수점 3자리로 줄여 보내요. 받은 이름은 DB에 두고 다시 보내지 않아요
//    지도 출처 링크는 gallery:open-map-credit 이 고정 주소 하나만 기본 브라우저로 열어요
//    (docs/superpowers/specs/2026-11-02-map-pick-design.md 4, 5절)
//
// 모양: registerScheme(protocol)  — app.whenReady 전에 한 번 (pvm:// 를 안전한 주소로 등록)
//       setupGallery({ ipcMain, protocol, getWin, getSettings, getTools, getEt, isRunning, logger, userDir,
//                      loadScreen, getJobPending, isPlanning, mapFetch, openExternal, appVersion, trash, makeDriveKindOf })
//         → { onWindowReady(), onBatchDone(), onRootChanged(), onToolsChanged(), close() }
//   loadScreen(name): 'import' | 'gallery' 화면으로 창을 바꿔요 (main.js가 해요)
//   getJobPending(): 이어할 가져오기 작업이 있는지
//   isPlanning(): 미리보기를 만드는 중인지 (중이면 화면 전환을 막아요)
//   mapFetch(url, init): 지도용 인터넷 요청 (main.js 가 net.fetch 를 넘겨요). 없으면 지도를 쓸 때만 실패해요
//   openExternal(url): 기본 브라우저로 열기 (main.js 가 shell.openExternal 을 넘겨요)
//   appVersion: 앱 버전 글자 (지도 서버에 보내는 앱 이름표에 들어가요)
//   trash(경로): 휴지통으로 보내기 (main.js 가 shell.trashItem 을 넘겨요). 없으면 비슷한 사진 버리기는 이동만 해요
//   makeDriveKindOf(): 드라이브 종류 판단기 만들기 (기본 lib/platform.js). 버리기 때마다 새로 만들어요 (확인 창 미리보기만 잠깐 다시 써요)
//   비슷한 사진: lib/similar.js (지문, 묶기), lib/similar-discard.js (버리기 확인과 옮기기). 버리기만 사진 파일을 옮겨요 (휴지통 또는 _정리완료원본)
//   내가 붙이는 태그: lib/manual-tags.js (규칙). 값 넣기와 같은 순서(기록 파일 → DB → 로그)로 저장하고 같은 되돌리기 줄로 되돌려요. 사진 파일에는 안 써요

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { openDb } = require('./lib/db');
const { createLibrary } = require('./lib/library');
const { createThumbs, pruneAllowed } = require('./lib/thumbs');
const { handleMedia } = require('./lib/media-protocol');
const { now } = require('./lib/logger');
const { normalizeRequest, planEdit, toPreview, MAX_TARGETS } = require('./lib/manual-edit');
const { createJournal, recover } = require('./lib/manual-journal');
const { buildSuggestions, pickSuggestions } = require('./lib/location-suggest');
const { createSkips } = require('./lib/suggest-skips');
const { createMapNet, roundCoord, roundCity } = require('./lib/map-net');
const { buildGroups, createHasher, isBlurry } = require('./lib/similar');
const ai = require('./lib/similar-ai');
const { checkDiscard, checkSelected, discardInfo, discardFiles } = require('./lib/similar-discard');
const { createDriveKindOf } = require('./lib/platform');
const { createPreviewDrive } = require('./lib/preview-drive');
const { historyFromJobs, planFill, toFillPreview, runFill, undoFill, lastFillRun } = require('./lib/fill-nodate');
const { isTagKind, normalizeTagEdit, planTagEdit, toTagPreview, cleanTagName, cleanHotkey, normalizeRename, planTagRename } = require('./lib/manual-tags');
const { readCleanHistory, cleanedFolders, cleanedDirOf } = require('./lib/clean-history');
const { rotateFile, rotateKind, TURNS } = require('./lib/media-edit');

const SCHEME = 'pvm';
const TABS = ['all', 'photo', 'video', 'screenshot'];
const SORTS = ['newest', 'oldest'];
const INFOS = ['noLocation', 'noDate', 'manual']; // 정보 없는 사진 화면의 탭
const MAX_AREA_RECTS = 16; // 지도 묶음 하나는 칸 9개까지 (src/places-view.mjs), 넉넉히
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAP_CREDIT_URL = 'https://www.openstreetmap.org/copyright'; // 지도 출처 링크 (고정 주소. 화면이 주소를 정하지 못해요)
const PROGRESS_GAP_MS = 100; // 읽기 진행 알림 최소 간격 (파일 찾는 동안 수천 번 보내지 않게)

// pvm:// 주소를 쓰려면 앱이 준비되기 전에 한 번 등록해야 해요 (app.whenReady 전에 불러요)
//   standard + secure = 일반 주소처럼 다뤄요(호스트 thumb/preview 를 읽을 수 있어요), supportFetchAPI = fetch 로도 가능
function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    // stream: 라이브 포토 영상(pvm://live/<id>)을 <video> 로 재생하려면 필요해요 (2026-11-21)
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
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
    area: cleanArea(x.area),
  };
}

// 지도에서 고른 곳: 칸 { s, w, n, e } 목록과 연도. 숫자가 아니거나 뒤집힌 칸은 버려요 (남는 칸이 없으면 필터 없음)
//   경계는 지도 끝 칸을 위해 위도 ±91, 경도 ±181까지 받아요 (src/places-view.mjs)
function cleanArea(a) {
  if (!a || typeof a !== 'object' || !Array.isArray(a.rects)) return null;
  const ok = (r) => r && typeof r === 'object'
    && [r.s, r.w, r.n, r.e].every((v) => typeof v === 'number' && Number.isFinite(v))
    && r.s >= -91 && r.n <= 91 && r.s < r.n && r.w >= -181 && r.e <= 181 && r.w < r.e;
  const rects = a.rects.slice(0, MAX_AREA_RECTS).filter(ok).map((r) => ({ s: r.s, w: r.w, n: r.n, e: r.e }));
  if (!rects.length) return null;
  const year = Number.isInteger(a.year) && a.year >= 1800 && a.year <= 2200 ? a.year : null;
  return { rects, year };
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

function setupGallery({ ipcMain, protocol, getWin, getSettings, getTools, getEt, isRunning, logger, userDir, loadScreen, getJobPending, isPlanning, mapFetch, openExternal, openPath, appVersion, trash, pickFolder, makeDriveKindOf = createDriveKindOf }) {
  const base = typeof userDir === 'function' ? userDir() : userDir;
  // 백업 폴더 경로. 끝의 \ 나 / 가 달라도 같은 폴더로 보게 path.resolve 로 한 번만 다듬어요 (대소문자는 그대로 둬요).
  //   DB의 root 열쇠가 되니 모든 곳이 이 함수 하나를 써요
  const libRoot = () => {
    const raw = String((getSettings() && getSettings().backupRoot) || '').trim();
    return raw ? path.resolve(raw) : '';
  };
  // ---------- 가져오기 전 거르기 (2026-11-18 사용자 결정, docs/superpowers/specs/2026-11-18-import-screening-design.md) ----------
  //   가져올 폴더를 잠깐 "지금 보는 폴더"로 삼아 비슷한 사진 화면 · 사진 보기 · 바로 지우기를 그대로 써요
  //   screen = { root: 가져올 폴더, name: 폴더 이름, trashed · moved: 거르기에서 휴지통으로 · _정리완료원본으로 옮긴 장수, hasher, embedder } 또는 null
  //   메모리에만 있어요 (설정 파일에 안 써요). 끝내면(가져오기 화면으로, 앱을 끌 때) 다시 백업 폴더를 봐요
  //   폴더는 main.js 가 설정의 가져올 폴더로만 정해요 (화면이 경로를 보내지 않아요)
  let screen = null;
  const rootNow = () => (screen ? screen.root : libRoot());
  const isScreenRoot = (root) => !!screen && root === screen.root;
  const SCREEN_BLOCK = '가져오기 전 거르기 중에는 할 수 없어요. "거르기 끝내고 가져오기로"를 누른 뒤에 해 주세요';
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
  let freshDb = false; // 이번에 library.db를 새로 만들었는지 (처음 켬, 깨져서 다시 만듦) → 옛 썸네일 정리 판단에 써요
  try {
    const dbFile = path.join(base, 'library.db');
    const existed = fs.existsSync(dbFile);
    const r = openDb(dbFile);
    db = r.db;
    freshDb = !existed || r.recovered;
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
      if (r.applied || r.undone || r.skipped || r.superseded || r.defs) {
        // 건너뛴 이유도 같이 남겨요 (묶음 번호, 종류, 이유). 사진 파일 경로는 안 들어가는 글만이에요
        const why = (r.errors || []).map((x) => `  건너뜀: ${x.batchId ? `묶음 ${x.batchId} ` : ''}(${x.type}) ${x.message}`);
        startupLog([`기록 파일에서 직접 넣은 값을 복구했어요: 넣기 ${r.applied}개, 되돌리기 ${r.undone}개, 버린 옛 묶음 ${r.superseded}개, 겹친 사진을 빼고 넣은 옛 묶음 ${r.partial || 0}개, 태그 정의 ${r.defs || 0}개, 건너뜀 ${r.skipped}개`, ...why]);
      }
    } catch (e) {
      errorLog('직접 넣은 값 복구', e);
    }
    // 띄어쓰기 글자만 다른 앨범 태그를 하나로 합쳐요 (전에 읽어 둔 태그 줄)
    try {
      const n = db.mergeSpacedTags();
      if (n) startupLog([`띄어쓰기만 다른 태그 ${n}개를 합쳤어요`]);
    } catch (e) {
      errorLog('띄어쓰기만 다른 태그 합치기', e);
    }
    // 내가 붙인 태그를 목록 표(file_tags)에 다시 맞춰요 (옛 빌드로 다시 읽은 파일에서 빠졌을 수 있어요)
    try {
      const n = db.resyncManualTags();
      if (n) startupLog([`내가 붙인 태그 ${n}개를 목록에 다시 넣었어요`]);
    } catch (e) {
      errorLog('내가 붙인 태그 다시 맞추기', e);
    }
    // 이 기능(빈 태그 · 단축키, 2026-11-18) 전에 붙인 태그 이름을 태그 정의 표에 채워요 (처음 한 번만 개수가 있어요)
    try {
      const n = db.fillTagNames();
      if (n) startupLog([`내가 붙인 태그 이름 ${n}개를 태그 목록에 채웠어요`]);
    } catch (e) {
      errorLog('태그 목록 채우기', e);
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
  // 원본을 못 읽어 미리보기를 작은 썸네일로 대신 보낸 사진 번호들. 원본으로 다시 보내면 빠져요
  //   화면의 <img>는 응답 헤더를 못 읽어서, 그림을 받은 뒤 gallery:preview-fallback 으로 물어봐요 (2026-11-11 사용자 결정)
  const previewFallbacks = new Set();
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
  let pruned = false; // 옛 썸네일 정리를 이번 실행에서 했는지
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
    if (result.status === 'done' && root === rootNow() && thumbs) {
      // 켠 뒤 처음 끝까지 읽었을 때 한 번만 옛 썸네일을 정리해요 (파일이 바뀌어 이름이 달라진 썸네일)
      //   새 DB를 만들 때 썸네일이 이미 있었으면 정리하지 않아요 (lib/thumbs.js pruneAllowed)
      //   거르기 폴더(가져올 폴더) 읽기에서는 정리하지 않아요 (그 폴더가 켠 뒤 처음 읽은 폴더여도, 설계 5-1)
      if (!pruned && !isScreenRoot(root)) {
        pruned = true;
        const p = pruneAllowed({ thumbDir: path.join(base, 'thumbs'), markerPath: path.join(base, 'thumb-prune-off.json'), freshDb, onError: errorLog });
        if (p.allowed) thumbs.pruneOrphans();
        if (p.markedNow) startupLog(['옛 썸네일 정리를 껐어요 (library.db를 새로 만들 때 썸네일이 이미 있었어요. 다른 백업 폴더 썸네일을 지우지 않게. thumb-prune-off.json)']);
      }
      // 비슷한 사진 지문 · 흐림 점수를 뒤에서 미리 만들어요: 썸네일이 있는 사진부터 바로, 썸네일 백그라운드가 끝나면 한 번 더
      startHashing(root, 'bg');
      Promise.resolve(thumbs.startBackground(root))
        .then(() => { if (!closed && root === rootNow()) startHashing(root, 'bg'); })
        .catch((e) => errorLog('썸네일 뒤 지문 만들기', e));
    }
    return result;
  }

  // ---------- 화면의 부탁 ----------
  ipcMain.handle('gallery:get-state', () => {
    const root = rootNow();
    warmPreviewDrive(root); // 확인 창이 바로 뜨게 드라이브 판단을 뒤에서 미리 읽어 둬요 (이미 있으면 그대로)
    const t = getTools(); // 아직 찾는 중이면 null → 화면에는 tools: null (도구 "없음" 안내를 잘못 띄우지 않게)
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
      tools: t ? { exiftool: !!(t.exiftool && t.exiftool.ok), ffmpeg: !!(t.ffmpeg && t.ffmpeg.ok) } : null,
      jobPending: !!(getJobPending && getJobPending()),
      // 가져오기 전 거르기 중이면 폴더 이름만 (전체 경로는 화면에 주지 않아요). root 는 그 폴더예요
      screening: screen ? { name: screen.name } : null,
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
        const fl = lastFillRun(fillJournalDir, root); // 날짜없음 채우기 되돌리기 버튼용 { count, at } 또는 null
        out.lastFill = fl ? { count: fl.count, at: fl.at } : null;
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

  // ---------- 정리 화면 (읽기만) ----------
  // 정리 기록 (원본 정리 · 비슷한 사진 버리기 로그)과 _정리완료원본 폴더 크기. 파일 경로는 화면에 주지 않아요 (이름만)
  //   모두 비동기라 폴더가 커도 앱 창이 멈추지 않아요. 읽는 중에 또 부르면 같은 결과를 같이 받아요 (겹쳐 세지 않게)
  let cleanJob = null;
  const cleanedDirs = new Map(); // 화면에 준 폴더 key → 경로 (예전 폴더 열기용, 화면에는 경로를 주지 않아요)
  const loadCleanHistory = async () => {
    const s = getSettings() || {};
    const { sessions, oldBases } = await readCleanHistory(logger.dir);
    const { folders, dirs } = await cleanedFolders({ source: s.source, backupRoot: rootNow(), oldBases });
    for (const [k, d] of dirs) cleanedDirs.set(k, d);
    return { sessions, folders };
  };
  ipcMain.handle('gallery:clean-history', () => {
    if (screen) throw new Error(SCREEN_BLOCK);
    if (!cleanJob) cleanJob = loadCleanHistory().finally(() => { cleanJob = null; });
    return cleanJob;
  });
  // _정리완료원본 폴더 열기: 화면은 폴더 key 만 보내고, 경로는 여기서 정해요. 없는 폴더는 열지 않아요
  //   'source' · 'backup' = 지금 설정의 폴더, 'old-…' = 정리 기록에서 찾아 화면에 보여 준 예전 폴더
  ipcMain.handle('gallery:open-cleaned', async (e, key) => {
    if (typeof key !== 'string' || !/^(source|backup|old-[0-9a-f]{12})$/.test(key)) throw new Error('열 폴더가 올바르지 않아요');
    if (screen) throw new Error(SCREEN_BLOCK);
    const s = getSettings() || {};
    let dir = null;
    if (key === 'source') dir = cleanedDirOf(s.source);
    else if (key === 'backup') dir = cleanedDirOf(rootNow());
    else dir = cleanedDirs.get(key) || null;
    if (!dir || !isDir(dir)) throw new Error('아직 _정리완료원본 폴더가 없어요');
    if (!openPath) throw new Error('폴더를 열 수 없어요');
    const err = await openPath(dir);
    if (err) {
      errorLog('정리 폴더 열기', err);
      throw new Error('폴더를 열지 못했어요');
    }
    return true;
  });

  // 지도 핀용 위치 목록 (단계 6) → [[id, 위도, 경도, 찍은 날], ...]
  ipcMain.handle('gallery:map-points', () => {
    if (screen) throw new Error(SCREEN_BLOCK); // 지도는 거르기 중에 막아요
    const root = rootNow();
    return db && root ? db.mapPoints(root) : [];
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

  // 방금 보낸 미리보기가 원본 대신 작은 썸네일이었는지 (화면이 "원본이 연결되지 않아..." 한 줄을 보여 줄지 정해요)
  ipcMain.handle('gallery:preview-fallback', (e, id) => Number.isSafeInteger(id) && id > 0 && previewFallbacks.has(id));

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
    // 가져오기 화면으로 가면 거르기를 끝내요 ("거르기 끝내고 가져오기로" 버튼도 이 길로 와요)
    //   옮기는 중이면 기다려요 (옮긴 장수를 다 센 뒤에 끝내려고)
    //   거르기 중이 아니어도 옮기는 중(휴지통 · 돌리기)이면 막아요 (#138 검증 ⚠️: 가져오기가 같은 이름 파일을 만들지 않게)
    if (name === 'import' && discarding) throw new Error('사진을 옮기는 중이에요. 끝난 뒤 다시 눌러 주세요');
    if (name === 'import') endScreening();
    await loadScreen(name);
    return true;
  });

  // ---------- 날짜와 위치 직접 넣기 ----------
  //   순서: 검사 → 다시 계산 → 기록 파일에 먼저 적기 → DB 저장 → (저장이 실패하면 void) → 로그 → 화면 알림
  //   화면이 본 미리보기는 믿지 않고, 넣을 때 main이 처음부터 다시 계산해서 저장해요.
  //   ⚠️ 사진 파일은 건드리지 않아요. 쓰는 곳은 DB, 기록 파일(manual-edits.jsonl), 로그뿐이에요.
  //   백업 폴더가 연결되지 않아도 돼요 (DB와 기록 파일만 쓰므로)

  // 가져오기 중이거나 DB, 백업 폴더가 없으면 못 해요. 준비됐으면 지금 백업 폴더(root)를 돌려줘요
  //   screenOk: 가져오기 전 거르기 중에도 쓰는 일 (비슷한 사진 · 바로 지우기). 그 밖의 일(날짜 · 위치 · 태그 · 날짜없음 채우기 ·
  //   위치 제안 · 되돌리기)은 거르기 중에 막아요. 가져올 폴더 경로에 붙인 값은 가져오면 경로가 바뀌어 사라지기 때문이에요 (설계 4-1)
  function editReady({ screenOk = false } = {}) {
    if (screen && !screenOk) throw new Error(SCREEN_BLOCK);
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
  const tagText = (v) => (Array.isArray(v) && v.length ? v.join(', ') : '없음');

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
  //   picks · pickSources: 위치 없는 사진마다 제안 하나 (건너뛴 사진 포함). 갤러리에서 사진을 고르면 오른쪽 패널 · 우클릭 메뉴에
  //   "근처 사진 위치 넣기"를 보여 주는 데 써요 (2026-11-21). 넣기는 위 apply-edit 의 위치 제안 검사를 그대로 거쳐요
  ipcMain.handle('gallery:list-suggestions', () => {
    const root = editReady();
    const rows = db.listSuggestionRows(root);
    const r = buildSuggestions(rows, skips.paths());
    const p = pickSuggestions(rows);
    return {
      ...r,
      groups: r.groups.map((g) => ({ ...g, targets: g.targets.map(({ path: _path, ...t }) => t) })),
      picks: p.picks,
      pickSources: p.sources,
    };
  });

  // 건너뛰기: 번호를 경로로 바꿔 지금 백업 폴더의 사진만 더해요. saved = 파일에 저장했는지
  //   batchId: 일부만 넣을 때 체크를 끈 사진이면 그 넣기의 번호. 그 묶음을 되돌리면 이번에 새로 건너뛴 사진은 다시 빠져요
  //   ("이 묶음 건너뛰기"는 번호 없이 와서 되돌려도 그대로)
  ipcMain.handle('gallery:skip-suggestions', (e, ids, batchId = null) => {
    const root = editReady();
    checkIds(ids);
    if (batchId !== null && (typeof batchId !== 'string' || !batchId || batchId.length > 100)) throw new Error('작업 번호가 올바르지 않아요.');
    const paths = db.getFilesByIds(ids).filter((f) => f.root === root).map((f) => f.path);
    return { saved: skips.add(paths, batchId) };
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
    let defsChanged = false;
    saveOrVoid('undo', last.id, '되돌리기', () => { defsChanged = db.undoBatch(last.id, at); });
    if (defsChanged) saveTagDefs(root); // 태그 이름 바꾸기 · 지우기 등을 되돌리면 태그 목록도 바뀌어요
    // 그 넣기에서 체크를 꺼서 건너뛴 사진도 다시 제안에 나오게 빼요. 목록 파일 저장에 실패해도 되돌리기는 이미 끝났어요
    const unskip = skips.undoBatch(last.id);
    // 되돌리기 로그: 파일별로 "되돌리기 전(넣었던 값) → 되돌린 뒤(그 전 값, 직접 넣은 값이 없었으면 없음)"
    if (isTagKind(last.kind)) {
      finishEdit('태그 되돌리기', last.id, last.kind, last.count, () => db.batchItems(last.id).map((it) =>
        `${it.path}\t태그 ${tagText(it.after)} → ${tagText(it.before)}`));
    } else {
      finishEdit('직접 넣은 값 되돌리기', last.id, last.kind, last.count, () => db.batchItems(last.id).map((it) =>
        `${it.path}\t직접 넣은 날짜 ${dateText(it.after)} → ${dateText(it.before)}\t직접 넣은 위치 ${locText(it.after)} → ${locText(it.before)}`));
    }
    // 다시 제안에 나오게 뺀 사진이 있을 때만 그 개수와 저장 여부를 더해요
    return { kind: last.kind, count: last.count, ...(unskip.removed ? { unskipped: unskip.removed, skipsSaved: unskip.saved } : {}) };
  });

  // ---------- 내가 붙이는 태그 (단계 5) ----------
  //   순서는 값 넣기와 같아요: 검사 → 다시 계산 → 기록 파일에 먼저 적기 → DB 저장 → (저장이 실패하면 void) → 로그 → 화면 알림
  //   화면은 사진 번호와 태그 이름만 보내요. 미리보기는 믿지 않고 넣을 때 다시 계산해요

  // 태그 목록: 내가 붙인 태그와 앨범 태그 (장수 많은 순)
  ipcMain.handle('gallery:tag-list', () => {
    if (screen) throw new Error(SCREEN_BLOCK);
    const root = rootNow();
    if (!db || !root) return { manual: [], album: [] };
    const s = db.summary(root);
    return { manual: s.manualTags, album: s.tags };
  });

  // 고른 사진들에 내가 붙인 태그와 장수 (떼기 창에서 고를 목록)
  ipcMain.handle('gallery:selection-tags', (e, ids) => {
    const root = editReady();
    return db.manualTagsOf(checkIds(ids), root);
  });

  const computeTagPlan = (root, ids, edit) => planTagEdit(db.getFilesByIds(checkIds(ids)), normalizeTagEdit(edit), (p) => db.getManualTags(p), root);

  // 미리보기: 아무것도 저장하지 않아요
  ipcMain.handle('gallery:tag-preview', (e, ids, edit) => {
    const root = editReady();
    return toTagPreview(computeTagPlan(root, ids, edit));
  });

  // 태그 묶음 하나 저장: 기록 파일 → DB(실패하면 void) → (정의가 바뀌었으면 정의 목록 줄) → 로그 → 화면 알림
  //   items: 바뀌는 사진들 [{ path, before, after }], defs: 태그 정의 전후 (없으면 빈 목록)
  function saveTagBatch(root, kind, items, defs, title, note) {
    const batchId = crypto.randomUUID();
    const at = new Date().toISOString();
    try {
      journal.append({ type: 'apply', batchId, at, root, kind, via: 'tag', sourcePath: null, items, ...(defs.length ? { defs } : {}) });
    } catch (err) {
      errorLog('태그 기록 파일 쓰기', err);
      throw new Error(`기록 파일에 쓰지 못해서 태그를 바꾸지 않았어요${codeNote(err)}. 자세한 내용은 로그 폴더의 오류 로그에 있어요.`);
    }
    saveOrVoid('apply', batchId, '태그', () => db.applyManualBatch({ id: batchId, root, kind, createdAt: at, items, defs }));
    if (defs.length) saveTagDefs(root);
    finishEdit(title, batchId, kind, items.length, () => items.map((it) => `${it.path}\t태그 ${tagText(it.before)} → ${tagText(it.after)}`), note);
    return batchId;
  }

  // 붙이기·떼기: 바뀌는 사진만 저장해요. 바꿀 것이 없으면 아무것도 쓰지 않고 count 0
  //   새 이름으로 붙이면 태그 정의도 같이 만들어요 (되돌리면 그 빈 태그도 같이 사라져요)
  ipcMain.handle('gallery:tag-apply', (e, ids, edit) => {
    const root = editReady();
    const plan = computeTagPlan(root, ids, edit);
    const changed = plan.items.filter((it) => it.status === 'changed');
    if (!changed.length) return { batchId: null, kind: plan.kind, count: 0, name: plan.name };
    const items = changed.map((it) => ({ path: it.path, before: it.before, after: it.after }));
    const defs = plan.kind === 'tagAdd' && !db.tagDef(root, plan.name) ? [{ name: plan.name, before: null, after: { hotkey: null } }] : [];
    const batchId = saveTagBatch(root, plan.kind, items, defs, plan.kind === 'tagAdd' ? '태그 붙이기' : '태그 떼기', `\n태그 ${plan.name}`);
    return { batchId, kind: plan.kind, count: changed.length, name: plan.name };
  });

  // ---------- 태그 만들기 · 이름 바꾸기 · 지우기 · 단축키 (2026-11-18) ----------
  //   내가 만든 태그만 바꿀 수 있어요. 앨범에서 가져온 태그(파일에서 읽은 것)는 읽기 전용이에요
  //   사진 파일은 건드리지 않아요. 쓰는 곳은 DB, 기록 파일, 로그뿐이에요

  // 태그 정의 목록을 기록 파일에 한 줄로 (DB를 새로 만들 때 빈 태그와 숫자를 되살리려고). 못 써도 이미 저장한 작업은 그대로예요
  function saveTagDefs(root) {
    try {
      journal.append({ type: 'tagDefs', batchId: crypto.randomUUID(), at: new Date().toISOString(), root, defs: db.tagDefList(root) });
    } catch (err) {
      errorLog('태그 목록 기록 파일 쓰기', err);
    }
  }
  // 묶음이 아닌 정의 바꾸기의 로그와 화면 알림 (실패해도 저장은 그대로)
  function defDone(title, text) {
    try {
      logger.newLog('manual-edit', `${title} ${now()}\n${text}`);
    } catch (err) {
      errorLog(`${title} 로그`, err);
    }
    try {
      send('gallery:library-changed');
    } catch (err) {
      errorLog(`${title} 화면 알림`, err);
    }
  }
  const tagNameArg = (v) => {
    if (typeof v !== 'string' || !v || v.length > 200) throw new Error('태그 이름이 올바르지 않아요.');
    return v;
  };
  // 내가 만든 태그 정의를 찾아요. 없으면 (앨범 태그뿐이거나 그 사이 지워졌으면) 거절해요
  const mineOrThrow = (root, name) => {
    const d = db.tagDef(root, tagNameArg(name));
    if (!d) throw new Error(`'${name}'은 내가 만든 태그가 아니라서 바꿀 수 없어요. 앨범에서 가져온 태그는 읽기 전용이에요.`);
    return d;
  };
  const defState = (d) => (d ? { hotkey: d.hotkey } : null);
  const shownCount = (root, name) => {
    const t = db.summary(root).manualTags.find((x) => x.name === name);
    return t ? t.count : 0;
  };

  // 빈 태그 만들기: 사진 없이 목록에 남아요 (장수 0). 같은 이름이 이미 있으면 거절
  ipcMain.handle('gallery:tag-create', (e, rawName) => {
    const root = editReady();
    const name = cleanTagName(rawName);
    if (db.tagDef(root, name)) throw new Error(`'${name}' 태그는 이미 있어요.`);
    db.setTagDefs(root, [{ name, after: { hotkey: null } }]);
    saveTagDefs(root);
    defDone('태그 만들기', `태그 ${name}`);
    return { name };
  });

  // 단축키 숫자 정하기 (1~9, null = 빼기). 같은 숫자를 쓰던 태그는 숫자가 빠져요 → { name, hotkey, moved: 숫자가 빠진 태그 이름 }
  ipcMain.handle('gallery:tag-hotkey', (e, name, key) => {
    const root = editReady();
    const hotkey = cleanHotkey(key);
    mineOrThrow(root, name);
    const moved = db.setTagHotkey(root, name, hotkey);
    saveTagDefs(root);
    defDone('태그 단축키', `태그 ${name}\n숫자 ${hotkey === null ? '없음' : hotkey}${moved ? `\n숫자가 빠진 태그 ${moved}` : ''}`);
    return { name, hotkey, moved };
  });

  // 이름 바꾸기 미리보기: 같은 이름의 내 태그가 있으면 합치기(merge)예요. 아무것도 저장하지 않아요
  ipcMain.handle('gallery:tag-rename-preview', (e, from, to) => {
    const root = editReady();
    const r = normalizeRename(tagNameArg(from), to);
    mineOrThrow(root, r.from);
    const merge = !!db.tagDef(root, r.to);
    return { from: r.from, to: r.to, merge, count: shownCount(root, r.from), toCount: merge ? shownCount(root, r.to) : 0 };
  });

  // 이름 바꾸기 · 합치기: 그 태그가 붙은 사진 모두에서 이름을 바꿔요. 같은 이름이 있으면 merge 가 true 일 때만 합쳐요
  //   단축키 숫자는 새 이름으로 옮겨요 (합칠 때 새 이름에 숫자가 이미 있으면 그 숫자를 남겨요)
  ipcMain.handle('gallery:tag-rename', (e, from, to, merge) => {
    const root = editReady();
    const r = normalizeRename(tagNameArg(from), to);
    const a = mineOrThrow(root, r.from);
    const b = db.tagDef(root, r.to);
    if (b && merge !== true) throw new Error(`'${r.to}' 태그가 이미 있어요. 합칠지 먼저 확인해 주세요.`);
    const defs = [
      { name: r.from, before: defState(a), after: null },
      { name: r.to, before: defState(b), after: { hotkey: b && b.hotkey !== null ? b.hotkey : a.hotkey } },
    ];
    const { items } = planTagRename(db.taggedPaths(root, r.from), r.from, r.to);
    const kind = 'tagRename';
    if (!items.length) {
      // 사진이 없는 태그: 정의만 바꿔요 (되돌리기 줄을 차지하지 않게 묶음을 만들지 않아요)
      db.setTagDefs(root, defs);
      saveTagDefs(root);
      defDone('태그 이름 바꾸기', `태그 ${r.from} → ${r.to}${b ? ' (합침)' : ''}\n개수 0`);
      return { batchId: null, kind, count: 0, from: r.from, name: r.to, merged: !!b };
    }
    const batchId = saveTagBatch(root, kind, items, defs, b ? '태그 합치기' : '태그 이름 바꾸기', `\n태그 ${r.from} → ${r.to}`);
    return { batchId, kind, count: items.length, from: r.from, name: r.to, merged: !!b };
  });

  // 지우기: 그 태그를 모든 사진에서 떼고 목록에서 빼요. 사진 · 영상 파일은 그대로예요. 같은 이름의 앨범 태그도 그대로예요
  ipcMain.handle('gallery:tag-delete', (e, name) => {
    const root = editReady();
    const a = mineOrThrow(root, name);
    const defs = [{ name: a.name, before: defState(a), after: null }];
    const { items } = planTagRename(db.taggedPaths(root, a.name), a.name, null);
    const kind = 'tagDelete';
    if (!items.length) {
      db.setTagDefs(root, defs);
      saveTagDefs(root);
      defDone('태그 지우기', `태그 ${a.name}\n개수 0`);
      return { batchId: null, kind, count: 0, name: a.name };
    }
    const batchId = saveTagBatch(root, kind, items, defs, '태그 지우기', `\n태그 ${a.name}`);
    return { batchId, kind, count: items.length, name: a.name };
  });

  // ---------- 장소 검색과 지도 출처 ----------
  //   검색어 검사와 실패 문장은 map-net 이 정해요. 거절 문장을 그대로 화면에 넘겨요 (검색어는 로그에 안 남아요)
  // ---------- 비슷한 사진 (단계 4) ----------
  //   지문 · 흐림 점수(썸네일에서 계산)는 두 때에 만들어요. 만드는 동안 진행을 gallery:similar-progress 로 알려요
  //     'bg'  : 백업 폴더를 끝까지 읽은 뒤(가져오기 회차 뒤 포함)와 썸네일 백그라운드가 끝난 뒤, 썸네일이 있는 사진만 미리 (2026-11-16)
  //     'full': 화면을 열 때. 썸네일이 없는 사진은 썸네일부터 만들어요
  //   둘 다 가져오기 중(busy)에는 쉬어요 (가져오기를 느리게 하지 않게, 메모리 지키기와 부딪히지 않게). 고르기 · 버리기는 화면에서만
  //   파일 경로는 화면에 주지 않아요. 버리기는 미리보기(similar-preview)를 보고 사용자가 누를 때만 (similar-discard)
  let hasher = db && thumbs ? createHasher({ db, thumbs }) : null;
  let hashing = false;
  let hashAgain = null; // 도는 동안 또 부탁받은 것 { root, mode } ('full'이 'bg'보다 앞서요. 다른 폴더 부탁은 새것으로)
  let hashStall = null; // 하나도 못 만들고 끝난 회차의 열쇠 (폴더 · 방식 · 진행이 같으면 다시 돌지 않아요)
  let closed = false; // 프로그램을 끄는 중 (DB 를 닫은 뒤에 새로 시작하지 않게)
  let discarding = false;

  // ---------- 확인 창 미리보기의 드라이브 판단 다시 쓰기 (lib/preview-drive.js, 2026-11-21 사용자 지적: 확인 창 버튼이 1~2초 늦게 떠요) ----------
  //   미리보기(trash-preview · similar-preview)만 읽어 둔 판단을 다시 써요. 갤러리를 열 때 · 옮긴 뒤 뒤에서 미리 읽어 둬요
  //   실제로 옮길 때(similar-discard · trash-selected)는 지금처럼 매번 makeDriveKindOf() 로 새로 확인해요 (안전 그대로)
  const previewDrive = createPreviewDrive({ make: makeDriveKindOf });
  const previewDriveKindOf = (root) => previewDrive.get(root);
  const warmPreviewDrive = (root, opts) => { if (!closed) previewDrive.warm(root, opts); };
  // 옮기기 직전 다시 맞춰 보기 (#128 검증 ⚠️): 휴지통 넘침 주의는 미리보기에서만 계산해서, 읽어 둔(조금 옛) 값이면 주의가 빠질 수 있어요
  //   → 확인 창에 보여 준 결과를 기억해 두고, 옮기기 직전에 새 판단으로 다시 계산해요
  //   휴지통 / _정리완료원본 장수가 다르거나 창에 없던 주의가 생겼으면 옮기지 않고 창을 다시 열라고 해요
  //   확인 창 없이 온 부탁(점검 등, 같은 번호의 미리보기가 없음)은 예전처럼 다시 맞추지 않아요
  const shownPreview = new Map(); // 'trash' | 'similar' → { key: 번호들, info }
  const previewKey = (ids) => (Array.isArray(ids) ? ids.join(',') : '');
  const rememberPreview = (kind, ids, info) => shownPreview.set(kind, { key: previewKey(ids), info });
  async function recheckPreview(kind, ids, files, fresh) {
    const seen = shownPreview.get(kind);
    shownPreview.delete(kind); // 한 번만 써요
    if (!seen || seen.key !== previewKey(ids)) return;
    const now = await discardInfo(files, { driveKindOf: fresh });
    const before = seen.info.warnings || [];
    const added = (now.warnings || []).filter((w) => !before.includes(w));
    if (now.trash !== seen.info.trash || now.move !== seen.info.move || added.length) {
      throw new Error('확인 창을 연 뒤 휴지통 상황이 바뀌었어요. 아무것도 옮기지 않았어요. 창을 닫고 다시 열어 확인해 주세요');
    }
  }

  const withState = (p) => ({ ...p, hashing, waiting: hashing && busy() });
  const similarProgress = (root) => withState(db.hashProgress(root));
  function startHashing(root, mode = 'full') {
    if (!hasher || !root || closed) return;
    if (hashing) {
      if (!hashAgain || hashAgain.root !== root || mode === 'full') hashAgain = { root, mode };
      return;
    }
    const p = db.hashProgress(root);
    if (p.done >= p.total) return;
    // 지난 회차가 하나도 못 만들고 끝났고 그 뒤 달라진 게 없으면 다시 돌지 않아요
    //   (원본을 잠깐 못 읽는 사진이 남으면 화면 다시 받기 ↔ 다시 시작이 끝없이 반복됐어요, #120 검증 지적)
    const key = `${root}|${mode}|${p.done}|${p.total}`;
    if (hashStall === key) return;
    hashing = true;
    send('gallery:similar-progress', withState(p));
    // 거르기 폴더는 따로 만든 계산기로 돌려요 (거르기를 끝낼 때 그것만 멈춰요. 라이브러리 계산기는 그대로)
    const h = isScreenRoot(root) ? screen.hasher : hasher;
    // 진행 알림은 hasher 가 잰 값을 그대로 써요 (다시 조회하지 않게)
    h.run(root, (q) => send('gallery:similar-progress', withState(q)), { readyOnly: mode === 'bg', isBusy: busy })
      // 멈춘 계산기(거르기를 시작 · 끝내며 바꾼 것)의 빈 결과는 '못 만듦'으로 기억하지 않아요 (다음에 다시 돌게)
      .then((r) => { hashStall = r && r.made + r.failed === 0 && (h === hasher || (screen && h === screen.hasher)) ? key : null; })
      .catch((e) => errorLog('비슷한 사진 지문 만들기', e))
      .finally(() => {
        hashing = false;
        const again = hashAgain;
        hashAgain = null;
        if (closed) return;
        try {
          send('gallery:similar-progress', similarProgress(root));
          if (again && again.root === rootNow()) startHashing(again.root, again.mode);
          else if (root === rootNow()) startEmbedding(root, mode); // 지문 다음에 AI 특징값 (모델을 받았을 때만)
        } catch (e) { /* 끄는 중 */ }
      });
  }

  // ---------- PC 안 AI 특징값 (④, lib/similar-ai.js) ----------
  //   모델은 사용자가 화면 확인 창에서 "받기"를 누를 때만 받아요 (gallery:ai-download). 앱이 스스로 받지 않아요
  //   특징값은 지문처럼 뒤에서 만들고, 가져오기 중에는 쉬어요. 다 만들면 화면이 목록을 다시 받아요
  let embedder = db && thumbs ? ai.createEmbedder({ db, thumbs, base }) : null;
  let embedding = false;
  let embedAgain = null;
  let embedStall = null; // 지문과 같은 방식 (하나도 못 만들고 끝난 회차)
  let aiBroken = false; // 모델을 열지 못했어요 (onnxruntime 을 못 불러옴 등) → 다시 받거나 다시 켤 때까지 시도하지 않아요
  let modelChecked = false; // 이번 실행에서 모델 파일 SHA-256 을 확인했는지
  let downloadAbort = null; // 받는 중이면 끌 때 멈춰요
  const aiInfo = { downloading: false, got: 0, error: '' }; // 받기 상태 (화면 표시용)
  const aiProgress = (root) => {
    const ready = ai.modelReady(base);
    const p = ready && root ? db.embedProgress(root, ai.MODEL.id) : { total: 0, done: 0 };
    return { model: ready ? 'ready' : aiInfo.downloading ? 'downloading' : 'none', bytes: ai.MODEL.bytes, got: aiInfo.got, error: aiInfo.error, ...p, embedding, waiting: embedding && busy() };
  };
  const sendAi = (root) => {
    try { send('gallery:ai-progress', aiProgress(root)); } catch (e) { /* 끄는 중 */ }
  };
  function startEmbedding(root, mode = 'full') {
    if (!embedder || !root || closed || aiBroken || !ai.modelReady(base)) return;
    if (embedding) {
      if (!embedAgain || embedAgain.root !== root || mode === 'full') embedAgain = { root, mode };
      return;
    }
    const p = db.embedProgress(root, ai.MODEL.id);
    if (p.done >= p.total) return;
    const key = `${root}|${mode}|${p.done}|${p.total}`;
    if (embedStall === key) return;
    embedding = true;
    sendAi(root);
    const em = isScreenRoot(root) ? screen.embedder : embedder; // 지문과 같아요 (거르기 폴더는 따로)
    (async () => {
      // 이번 실행에서 처음 쓸 때 한 번 모델 파일이 원래 것과 같은지(SHA-256) 확인해요. 다르면 옆으로 치우고 다시 받게 해요
      if (!modelChecked) {
        const ok = await ai.verifyModel(base);
        modelChecked = true;
        if (!ok) {
          aiInfo.error = 'AI 모델 파일이 원래 것과 달라서 쓰지 않았어요. 다시 받아 주세요.';
          return null;
        }
      }
      return em.run(root, () => sendAi(root), { readyOnly: mode === 'bg', isBusy: busy });
    })()
      .then((r) => { embedStall = r && r.made + r.failed === 0 && (em === embedder || (screen && em === screen.embedder)) ? key : null; })
      .catch((e) => {
        aiBroken = true;
        aiInfo.error = 'AI 특징값을 만들지 못했어요. 프로그램을 다시 켜 주세요 (자세한 내용은 오류 로그).';
        errorLog('AI 특징값 만들기', e);
      })
      .finally(() => {
        embedding = false;
        const again = embedAgain;
        embedAgain = null;
        if (closed) return;
        sendAi(root);
        if (again && again.root === rootNow()) startEmbedding(again.root, again.mode);
      });
  }

  // AI 상태 → { model: 'none'|'downloading'|'ready', bytes, got, error, total, done, embedding, waiting }
  ipcMain.handle('gallery:ai-state', () => aiProgress(rootNow()));

  // AI 모델 받기 (화면 확인 창에서 누른 뒤에만). 정해진 주소 하나 · SHA-256 확인 (lib/similar-ai.js)
  ipcMain.handle('gallery:ai-download', async () => {
    if (ai.modelReady(base)) return aiProgress(rootNow());
    if (aiInfo.downloading) throw new Error('이미 받는 중이에요');
    aiInfo.downloading = true;
    aiInfo.got = 0;
    aiInfo.error = '';
    downloadAbort = new AbortController();
    sendAi(rootNow());
    const log = (() => {
      try { return logger.newLog('ai-model', `AI 모델 받기 ${now()}`); } catch (e) { return null; }
    })();
    try {
      if (log) log.write(`받는 곳: ${ai.MODEL.url} (${ai.MODEL.bytes} 바이트, ${ai.MODEL.label})`);
      await ai.downloadModel({
        fetchImpl: (...a) => mapFetch(...a),
        base,
        onProgress: (got) => { aiInfo.got = got; sendAi(rootNow()); },
        signal: downloadAbort.signal,
      });
      if (log) log.write('받기 끝, SHA-256 맞음');
      modelChecked = true; // 방금 받으면서 확인했어요
      aiBroken = false;
      embedStall = null;
    } catch (e) {
      aiInfo.error = e.message;
      if (log) log.write(`받기 실패: ${e.message}`);
      throw e;
    } finally {
      aiInfo.downloading = false;
      downloadAbort = null;
      if (!closed) sendAi(rootNow());
    }
    const root = rootNow();
    if (root) startEmbedding(root, 'full');
    return aiProgress(root);
  });

  // "이 묶음은 모두 남기기"를 누른 사진 (다음 실행에도 기억해요, 2026-11-04 사용자 결정). DB를 새로 만들어도 남게 경로로 적어요
  const similarKeeps = createSkips(path.join(base, 'similar-keeps.json'), { onError: errorLog, label: '모두 남긴 사진 목록' });

  // 묶음 목록 → { progress: { total, done, hashing }, hiddenKept: 숨긴 묶음 수,
  //   groups: [{ ids, keepId, softIds, keptIds, timeOnly, takenAt, files: [{ id, name, width, height, size, takenAt, blurry }] }] }
  //   blurry: 흐림 점수가 BLUR_LIMIT 이상 (lib/similar.js). 점수가 아직 없으면 false
  //   모든 사진을 "모두 남기기"로 기억한 묶음은 숨겨요. 일부만 기억한 묶음(새 사진이 들어옴)은 기억한 사진이 처음부터 남김(keptIds)
  ipcMain.handle('gallery:similar-list', () => {
    const root = editReady({ screenOk: true });
    startHashing(root);
    if (!hashing) startEmbedding(root, 'full'); // 지문을 만드는 중이면 지문이 끝난 뒤에 이어서 (CPU 를 겹쳐 쓰지 않게)
    const rows = db.similarRows(root);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const kept = similarKeeps.paths();
    let hiddenKept = 0;
    const groups = [];
    for (const g of buildGroups(rows)) {
      const keptIds = g.ids.filter((id) => kept.has(byId.get(id).path));
      if (keptIds.length === g.ids.length) {
        hiddenKept++;
        continue;
      }
      groups.push({
        ...g,
        keptIds,
        files: g.ids.map((id) => {
          const r = byId.get(id);
          return { id: r.id, name: r.name, width: r.width, height: r.height, size: r.size, takenAt: r.takenAt, blurry: isBlurry(r.blur) };
        }),
      });
    }
    return { progress: similarProgress(root), groups, hiddenKept };
  });

  // 모두 남기기 기억: 번호를 경로로 바꿔 지금 백업 폴더의 사진만 더해요. saved = 파일에 저장했는지
  // 거르기 중 버리기 · 바로 지우기: 로그 이름을 따로 해요 (정리 기록 화면이 라이브러리 버리기로 세지 않게) + 옮긴 장수 세기
  const screenLog = (root) => (isScreenRoot(root) ? { logKind: 'screen-discard', logTitle: '가져오기 전 거르기' } : {});
  function countScreenRemoved(root, r) {
    if (!isScreenRoot(root)) return;
    screen.trashed += r.trashed || 0;
    screen.moved += r.moved || 0; // 휴지통이 없는 드라이브(USB 등)면 가져올 폴더\_정리완료원본으로 옮겨요 (안내 문구를 나눠요)
  }

  //   거르기 중에는 그 폴더 몫으로 따로 적어 둬요 (screenKeepId). "숨긴 묶음 다시 보기"가 그 몫만 비우게 (라이브러리 기억은 그대로)
  const screenKeepId = (root) => `screen|${root}`;
  ipcMain.handle('gallery:similar-keep-all', (e, ids) => {
    const root = editReady({ screenOk: true });
    checkIds(ids);
    const paths = db.getFilesByIds(ids).filter((f) => f.root === root).map((f) => f.path);
    return { saved: similarKeeps.add(paths, isScreenRoot(root) ? screenKeepId(root) : null) };
  });

  // 숨긴 묶음 다시 보기: 기억을 비워요. 사진 파일에는 영향이 없어요
  //   거르기 중에는 이 거르기 폴더에서 남긴 기억만 비워요 (라이브러리의 "모두 남기기" 기억을 바꾸지 않게, 설계 2절)
  ipcMain.handle('gallery:similar-clear-keeps', () => {
    const root = editReady({ screenOk: true });
    if (isScreenRoot(root)) return { saved: similarKeeps.undoBatch(screenKeepId(root)).saved };
    return { saved: similarKeeps.clear() };
  });

  // 버리기 미리보기: 몇 장이 휴지통으로, 몇 장이 _정리완료원본으로 가는지 (아무것도 옮기지 않아요)
  ipcMain.handle('gallery:similar-preview', async (e, ids) => {
    const root = editReady({ screenOk: true });
    const { files, groups } = checkDiscard(db, root, ids);
    const info = await discardInfo(files, { driveKindOf: await previewDriveKindOf(root) }); // 미리보기는 읽어 둔 판단을 다시 써요 (위 규칙)
    rememberPreview('similar', ids, info); // 옮기기 직전에 새 판단과 맞춰 봐요
    return { ...info, groups, canTrash: typeof trash === 'function' };
  });

  // 버리기 실행. 끝나면 옮긴 사진을 "사라짐"으로 적고 화면에 목록이 바뀌었다고 알려요
  ipcMain.handle('gallery:similar-discard', async (e, ids) => {
    const root = editReady({ screenOk: true });
    if (discarding || filling) throw new Error('이미 옮기는 중이에요');
    if (library && library.isScanning()) throw new Error('백업 폴더를 읽는 중이에요. 끝난 뒤 다시 눌러 주세요');
    const { files } = checkDiscard(db, root, ids);
    discarding = true;
    try {
      const noTrash = async () => { throw new Error('휴지통을 쓸 수 없어요'); };
      const fresh = makeDriveKindOf(); // 옮길 때는 늘 새로 확인해요
      await recheckPreview('similar', ids, files, fresh); // 확인 창과 달라졌으면 옮기지 않아요
      const r = await discardFiles({ root, files, trash: typeof trash === 'function' ? trash : noTrash, driveKindOf: fresh, logger, ...screenLog(root) });
      // DB에 적다가 실패해도 옮긴 결과는 알려요 (다음에 백업 폴더를 읽으면 "사라짐"으로 맞춰져요)
      if (r.done.length) {
        try {
          db.setMissing(r.done, 1);
        } catch (err) {
          errorLog('비슷한 사진 사라짐 표시', err);
        }
      }
      countScreenRemoved(root, r);
      send('gallery:library-changed');
      return { trashed: r.trashed, moved: r.moved, fail: r.fail, pairs: r.pairs, pairFail: r.pairFail, logFail: r.logFail, logName: path.basename(r.logPath || '') };
    } finally {
      discarding = false;
      warmPreviewDrive(root, { forget: true }); // 휴지통 크기가 바뀌었어요 → 다음 미리보기용으로 뒤에서 새로 읽어요
    }
  });

  // ---------- 갤러리에서 고른 사진 휴지통으로 (2026-11-16 사용자 결정) ----------
  //   사진첩에서 보다가 필요 없는 건 바로 지울 수 있게. 고른 사진 · 영상을 확인 창(trash-preview)을 보고 누를 때만 옮겨요 (trash-selected)
  //   옮기는 방법 · 로그 · 라이브 포토 짝 영상은 비슷한 사진 버리기와 같아요 (lib/similar-discard.js). 묶음 조건만 없어요
  //   영구 삭제는 안 해요: 휴지통, 휴지통이 없는 드라이브면 백업 폴더\_정리완료원본
  ipcMain.handle('gallery:trash-preview', async (e, ids) => {
    const root = editReady({ screenOk: true });
    const { files } = checkSelected(db, root, ids);
    const info = await discardInfo(files, { driveKindOf: await previewDriveKindOf(root) }); // 미리보기는 읽어 둔 판단을 다시 써요 (위 규칙)
    rememberPreview('trash', ids, info); // 옮기기 직전에 새 판단과 맞춰 봐요
    return { ...info, canTrash: typeof trash === 'function' };
  });
  ipcMain.handle('gallery:trash-selected', async (e, ids) => {
    const root = editReady({ screenOk: true });
    if (discarding || filling) throw new Error('이미 옮기는 중이에요');
    if (library && library.isScanning()) throw new Error('백업 폴더를 읽는 중이에요. 끝난 뒤 다시 눌러 주세요');
    const { files } = checkSelected(db, root, ids);
    discarding = true;
    try {
      const noTrash = async () => { throw new Error('휴지통을 쓸 수 없어요'); };
      const fresh = makeDriveKindOf(); // 옮길 때는 늘 새로 확인해요
      await recheckPreview('trash', ids, files, fresh); // 확인 창과 달라졌으면 옮기지 않아요
      const r = await discardFiles({ root, files, trash: typeof trash === 'function' ? trash : noTrash, driveKindOf: fresh, logger, logKind: 'gallery-trash', logTitle: '갤러리에서 휴지통으로', ...screenLog(root) });
      // DB에 적다가 실패해도 옮긴 결과는 알려요 (다음에 백업 폴더를 읽으면 "사라짐"으로 맞춰져요)
      if (r.done.length) {
        try {
          db.setMissing(r.done, 1);
        } catch (err) {
          errorLog('갤러리 휴지통 사라짐 표시', err);
        }
      }
      countScreenRemoved(root, r);
      send('gallery:library-changed');
      return { trashed: r.trashed, moved: r.moved, fail: r.fail, pairs: r.pairs, pairFail: r.pairFail, logFail: r.logFail, logName: path.basename(r.logPath || '') };
    } finally {
      discarding = false;
      warmPreviewDrive(root, { forget: true }); // 휴지통 크기가 바뀌었어요 → 다음 미리보기용으로 뒤에서 새로 읽어요
    }
  });

  // ---------- 사진 · 영상 돌리기 (2026-11-23 사용자 요청, 나중에 할 일 23) ----------
  //   한 장을 골라 화면에서 돌려 본 뒤(rotate-preview) 저장 방식을 골라 누를 때만 파일을 만들어요 (rotate)
  //   - 'copy'    = 돌린 복사본을 같은 폴더에 새 이름(이름_1.jpg)으로. 원본은 그대로. 직접 넣은 날짜 · 위치 · 태그도 복사본에 붙여요
  //   - 'replace' = 돌린 파일로 원본 바꾸기. 옛 원본은 휴지통(휴지통이 없는 드라이브면 _정리완료원본)으로. 영구 삭제는 안 해요
  //   라이브 포토면 짝 영상도 같이 돌려요 (lib/similar-discard.js 의 짝 찾기 그대로)
  //   늘 임시 파일을 먼저 다 만든 뒤에만 원본을 옮겨요. 중간에 실패하면 원본은 그대로예요 (lib/media-edit.js)
  //   임시 파일은 같은 폴더의 .pvm-edit 폴더에 둬요 (점으로 시작하는 폴더는 백업 폴더 읽기에서 빠져요, 같은 드라이브라 이름 바꾸기로 옮겨져요)
  const EDIT_TMP_DIR = '.pvm-edit';
  // 임시 파일을 제자리로: 그 이름에 파일이 있으면 절대 덮어쓰지 않아요 (#138 검증 ⚠️: Windows 의 이름 바꾸기는 있던 파일을 덮어써요)
  //   먼저 하드 링크(같은 드라이브, 바로 끝남)로 걸고, 링크를 못 쓰는 드라이브(exFAT 등)면 "있으면 실패" 복사로 둬요. 그 뒤 임시 파일을 지워요
  const placeFile = (tmp, to) => {
    try {
      fs.linkSync(tmp, to);
    } catch (err) {
      if (err && err.code === 'EEXIST') throw new Error('그 자리에 파일이 그사이 생겼어요');
      fs.copyFileSync(tmp, to, fs.constants.COPYFILE_EXCL);
    }
    try { fs.rmSync(tmp, { force: true }); } catch (err) { /* 임시 파일만 남아요 (원본 아님) */ }
  };
  const rotateTarget = (root, id) => {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('파일 번호가 올바르지 않아요');
    const { files } = checkSelected(db, root, [id]);
    const f = files[0];
    if (!rotateKind(f.path)) throw new Error('이 형식은 아직 돌릴 수 없어요 (JPG · PNG · MOV · MP4 만)');
    if (f.pair && !rotateKind(f.pair.path)) f.pair = null; // 짝 영상이 못 돌리는 형식이면 사진만
    return { files, f };
  };
  ipcMain.handle('gallery:rotate-preview', async (e, id) => {
    const root = editReady();
    const { files, f } = rotateTarget(root, id);
    const info = await discardInfo(files, { driveKindOf: await previewDriveKindOf(root) });
    rememberPreview('rotate', [id], info); // 원본 바꾸기 직전에 새 판단과 맞춰 봐요
    return { name: f.name, pair: !!f.pair, trash: info.trash, move: info.move, warnings: info.warnings, canTrash: typeof trash === 'function' };
  });
  ipcMain.handle('gallery:rotate', async (e, id, turn, mode) => {
    const root = editReady();
    if (!TURNS.includes(turn)) throw new Error('돌릴 각도가 올바르지 않아요');
    if (mode !== 'copy' && mode !== 'replace') throw new Error('저장 방식이 올바르지 않아요');
    if (discarding || filling) throw new Error('이미 옮기는 중이에요');
    if (library && library.isScanning()) throw new Error('백업 폴더를 읽는 중이에요. 끝난 뒤 다시 눌러 주세요');
    const et = getEt();
    if (!et) throw new Error('exiftool 을 찾지 못해서 돌릴 수 없어요');
    const { files, f } = rotateTarget(root, id);
    // 원본 바꾸기는 확인 창(rotate-preview)을 본 뒤에만 해요 (#138 검증 ⚠️: 다시 확인을 건너뛰지 않게). 한 번 쓰면 지워져서 다시 물어봐야 해요
    if (mode === 'replace') {
      const seen = shownPreview.get('rotate');
      if (!seen || seen.key !== previewKey([id])) throw new Error('휴지통 확인이 끝나지 않았어요. 잠시 뒤 다시 눌러 주세요');
    }
    const targets = [f.path, ...(f.pair ? [f.pair.path] : [])]; // 돌릴 파일 (사진, 라이브 포토 짝 영상)
    discarding = true;
    const tmpOf = new Map(); // 원본 경로 → 아직 쓰지 않은 임시 파일
    const tmpDirs = new Set();
    let log = null;
    const note = (line) => { try { if (log) log.write(line); } catch (err) { /* 로그 실패는 계속 */ } };
    try {
      log = logger.newLog('gallery-rotate', `# 돌리기 / ${now()} / 시계 방향 ${turn}도 / ${mode === 'copy' ? '복사본 저장' : '원본 바꾸기'}\n# 백업 폴더: ${root}`);
      // 1) 임시 파일부터 모두 만들어요 (하나라도 실패하면 아무것도 바꾸지 않아요)
      for (const p of targets) {
        const dir = path.join(path.dirname(p), EDIT_TMP_DIR);
        fs.mkdirSync(dir, { recursive: true });
        tmpDirs.add(dir);
        const tmp = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(p)}`);
        const r = await rotateFile({ et, src: p, turn, out: tmp });
        tmpOf.set(p, tmp);
        note(`${now()}\t임시 파일\t${p}\t${r.kind} ${r.before} → ${r.after}`);
      }
      const result = { mode, pair: !!f.pair, done: 0, trashed: 0, moved: 0, fail: 0, kept: [], logName: path.basename(log.path || '') };
      if (mode === 'copy') {
        // 2) 사진과 짝 영상이 같은 이름을 갖도록 둘 다 비어 있는 번호를 골라요 (이름_1.jpg + 이름_1.mov 라야 라이브 포토로 이어져요)
        const stemOf = (p) => p.slice(0, p.length - path.extname(p).length);
        const copyOf = (p, n) => `${stemOf(p)}_${n}${path.extname(p)}`;
        let n = 1;
        while (targets.some((p) => fs.existsSync(copyOf(p, n)))) n++;
        for (const p of targets) {
          const to = copyOf(p, n);
          if (fs.existsSync(to)) throw new Error('복사본 이름이 그사이 생겼어요. 다시 눌러 주세요');
          placeFile(tmpOf.get(p), to);
          tmpOf.delete(p);
          result.done++;
          note(`${now()}\t복사본\t${p}\t${to}`);
          try {
            db.copyManual(p, to, root);
          } catch (err) {
            note(`${now()}\t직접 넣은 값 복사 실패\t${to}\t${err.message}`);
          }
        }
      } else {
        // 2) 옛 원본을 휴지통(또는 _정리완료원본)으로 옮기고, 비워진 자리에만 돌린 파일을 둬요
        const noTrash = async () => { throw new Error('휴지통을 쓸 수 없어요'); };
        const fresh = makeDriveKindOf(); // 옮길 때는 늘 새로 확인해요
        await recheckPreview('rotate', [id], files, fresh); // 확인 창과 달라졌으면 옮기지 않아요
        const r = await discardFiles({ root, files, trash: typeof trash === 'function' ? trash : noTrash, driveKindOf: fresh, logger, logKind: 'gallery-rotate-trash', logTitle: '돌리기 전 원본을 휴지통으로' });
        result.trashed = r.trashed;
        result.moved = r.moved;
        const gone = new Set(r.done);
        for (const p of targets) {
          const tmp = tmpOf.get(p);
          // 휴지통 쪽에서 오류가 났어도 원본이 이미 사라졌으면 옮겨진 걸로 봐요 (#138 검증 ⚠️: 돌린 파일까지 지우면 그 자리가 비어요)
          if (!gone.has(p) && fs.existsSync(p)) {
            result.fail++;
            note(`${now()}\t원본을 못 옮겨 그대로 둠\t${p}`);
            continue; // 쓰지 않은 임시 파일은 아래 finally 에서 지워요
          }
          if (!gone.has(p)) note(`${now()}\t옮기기 결과를 못 받았지만 원본 자리가 비어 있음 → 돌린 파일을 둠\t${p}`);
          tmpOf.delete(p); // 옛 원본이 이미 휴지통에 있어요 → 이제부터 이 임시 파일은 지우지 않아요 (잃지 않게)
          try {
            placeFile(tmp, p); // 그사이 같은 이름 파일이 생겼으면 덮어쓰지 않고 실패해요 → 돌린 파일은 남겨요
            result.done++;
            note(`${now()}\t바꿈\t${p}`);
          } catch (err) {
            result.kept.push(path.relative(root, tmp));
            note(`${now()}\t바꾸기 실패(돌린 파일 남김)\t${p}\t${tmp}\t${err.message}`);
          }
        }
      }
      note(`# 끝 / 완료 ${result.done}, 못 옮김 ${result.fail}, 남긴 돌린 파일 ${result.kept.length}`);
      return result;
    } catch (err) {
      note(`${now()}\t실패\t${err && err.message ? err.message : err}`);
      throw err;
    } finally {
      // 쓰지 않은 임시 파일과 빈 임시 폴더를 치워요 (원본이 아니에요)
      for (const tmp of tmpOf.values()) {
        try { fs.rmSync(tmp, { force: true }); } catch (err) { /* 못 지워도 계속 */ }
      }
      for (const dir of tmpDirs) {
        try { fs.rmdirSync(dir); } catch (err) { /* 비어 있지 않으면 그대로 */ }
      }
      discarding = false;
      if (mode === 'replace') warmPreviewDrive(root, { forget: true });
      // 바뀐 파일만 다시 읽어요 (크기 · 수정 시각으로 알아요). 끝나면 library 가 gallery:library-changed 를 보내요
      runScan(root, { changed: true }).catch((err) => errorLog('돌린 뒤 다시 읽기', err));
    }
  });

  // ---------- 날짜없음 채우기 (_날짜없음 → 앨범 정보 날짜의 날짜 폴더) ----------
  //   미리보기(fill-preview) → 실행(fill-run) → 되돌리기(fill-undo). 화면은 경로를 모르고 개수와 이름만 받아요
  //   옮기기만 해요 (삭제 · 복사 없음, lib/fill-nodate.js). 옮긴 뒤 갤러리가 폴더를 다시 읽어서 맞춰요
  const fillJournalDir = path.join(base, 'fill-nodate');
  const fillAlbumDirs = []; // 사용자가 고른 앨범 폴더 (경로는 화면에 주지 않아요)
  let fillPlan = null; // 마지막 미리보기 { root, items, token }
  let filling = false;
  // 직접 넣은 값 · 태그는 경로에 묶여 있어서 옮기면 잃어요 → 그 사진은 옮기지도 되돌리지도 않아요
  const isProtected = (p) => {
    try {
      return !!db.getManual(p) || db.getManualTags(p).length > 0;
    } catch (err) {
      return true; // 못 읽으면 안전한 쪽(옮기지 않음)
    }
  };
  const fillBusyCheck = () => {
    const root = editReady();
    if (discarding || filling) throw new Error('다른 옮기기가 끝난 뒤에 할 수 있어요');
    if (library && library.isScanning()) throw new Error('백업 폴더를 읽는 중이에요. 끝난 뒤 다시 눌러 주세요');
    return root;
  };
  ipcMain.handle('gallery:fill-pick-folder', async () => {
    fillBusyCheck();
    if (typeof pickFolder !== 'function') throw new Error('폴더를 고를 수 없어요');
    const dir = await pickFolder('iCloud 공유 앨범이 들어 있는 폴더 고르기 (예: iCloud Shared Albums)');
    if (!dir || !isDir(dir)) return { picked: false, folders: fillAlbumDirs.map((d) => path.basename(d)) };
    const abs = path.resolve(dir);
    if (!fillAlbumDirs.includes(abs)) fillAlbumDirs.push(abs);
    if (fillAlbumDirs.length > 5) fillAlbumDirs.shift();
    return { picked: true, folders: fillAlbumDirs.map((d) => path.basename(d)) };
  });
  ipcMain.handle('gallery:fill-clear-folders', () => {
    fillAlbumDirs.length = 0;
    fillPlan = null;
    return true;
  });
  ipcMain.handle('gallery:fill-preview', async () => {
    const root = fillBusyCheck();
    const history = historyFromJobs(path.join(base, 'jobs'), (n, err) => errorLog(`날짜 채우기: 가져오기 기록 ${n} 읽기`, err));
    const plan = await planFill({ root, history, albumDirs: [...fillAlbumDirs], isProtected });
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fillPlan = { root, items: plan.items, token };
    return { token, folders: fillAlbumDirs.map((d) => path.basename(d)), ...toFillPreview(plan) };
  });
  ipcMain.handle('gallery:fill-run', async (e, token) => {
    const root = fillBusyCheck();
    if (!fillPlan || fillPlan.token !== token || fillPlan.root !== root) throw new Error('미리보기가 바뀌었어요. 다시 후보를 확인해 주세요');
    const plan = fillPlan;
    fillPlan = null; // 한 번 실행한 미리보기는 다시 쓰지 않아요
    filling = true;
    try {
      const r = await runFill({ root, items: plan.items, logger, journalDir: fillJournalDir, isProtected, onProgress: (p) => send('gallery:fill-progress', p) });
      if (r.pairs.length) {
        try {
          db.setMissing(r.pairs.map((x) => x.from), 1);
        } catch (err) {
          errorLog('날짜 채우기 사라짐 표시', err);
        }
        runScan(root, { changed: true }).catch((err) => errorLog('날짜 채우기 뒤 다시 읽기', err)); // 새 자리 파일을 읽어요
      }
      send('gallery:library-changed');
      return { moved: r.moved, fail: r.fail, skipped: r.skipped, logName: path.basename(r.logPath || '') };
    } finally {
      filling = false;
    }
  });
  ipcMain.handle('gallery:fill-undo', async () => {
    const root = fillBusyCheck();
    const last = lastFillRun(fillJournalDir, root);
    if (!last) throw new Error('되돌릴 기록이 없어요');
    filling = true;
    try {
      const r = await undoFill({ journalPath: last.journalPath, logger, isProtected });
      if (r.restored) {
        // 옮겼던 새 자리는 사라짐으로, 원래 자리 파일은 폴더를 다시 읽어서 되살려요
        try {
          db.setMissing(r.pairs.map((x) => x.to), 1);
        } catch (err) {
          errorLog('날짜 채우기 되돌리기 사라짐 표시', err);
        }
        runScan(root, { changed: true }).catch((err) => errorLog('날짜 채우기 되돌린 뒤 다시 읽기', err));
      }
      send('gallery:library-changed');
      return { restored: r.restored, fail: r.fail, skipped: r.skipped };
    } finally {
      filling = false;
    }
  });

  ipcMain.handle('gallery:search-place', (e, query) => mapNet.search(query));

  // 장소 이름: 화면은 사진 번호만 보내요 (좌표는 DB에서 읽어요. 화면이 좌표를 정하지 못해요)
  //   ask: false → 저장해 둔 이름만 (인터넷에 안 나감), true → 없으면 서버에 물어보고 저장
  //   돌려주는 값: { name } (name null = 아직 모름, '' = 이름 없는 곳). 위치가 없거나 다른 폴더 사진이면 null
  //   같은 곳을 묻는 중에 또 누르면(다른 사진에 다녀오거나 같은 동네 사진) 새로 보내지 않고 묻는 중인 것을 같이 기다려요
  const placeAsking = new Map(); // 줄인 좌표 → 묻는 중인 Promise
  // 지도 핀 이름 (단계 6-2): 묶음 가운데 좌표 → { name, country, cc } 또는 null (저장된 이름이 없고 ask가 아니면)
  //   좌표는 소수점 2자리(약 1km)로 줄여서 열쇠로 쓰고, 받은 값은 place_names 에 "city:" 열쇠로 저장해요 (다시 묻지 않아요)
  ipcMain.handle('gallery:map-place', async (e, lat, lng, ask) => {
    const ok = (v, lim) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
    if (!ok(lat, 90) || !ok(lng, 180)) throw new Error('위치 값이 올바르지 않아요');
    if (!db) return null;
    const key = `city:${roundCity(lat).toFixed(2)},${roundCity(lng).toFixed(2)}`;
    const saved = db.getPlaceName(key);
    if (saved !== null) {
      try {
        const v = JSON.parse(saved);
        return { name: String(v.name || ''), country: String(v.country || ''), cc: String(v.cc || '') };
      } catch (err) {
        return { name: '', country: '', cc: '' };
      }
    }
    if (ask !== true) return null;
    if (!placeAsking.has(key)) {
      const asking = mapNet.reverseCity(lat, lng).then((v) => {
        try {
          db.setPlaceName(key, JSON.stringify(v), new Date().toISOString());
        } catch (err) {
          errorLog('지도 핀 이름 저장', err);
        }
        return v;
      }).finally(() => placeAsking.delete(key));
      placeAsking.set(key, asking);
    }
    return placeAsking.get(key);
  });

  ipcMain.handle('gallery:place-name', async (e, id, ask) => {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('파일 번호가 올바르지 않아요');
    const root = rootNow();
    if (!db || !root) return null;
    const f = db.getFile(id);
    if (!f || f.missing || f.root !== root || f.lat === null || f.lng === null) return null;
    const key = `${roundCoord(f.lat).toFixed(3)},${roundCoord(f.lng).toFixed(3)}`;
    const saved = db.getPlaceName(key);
    if (saved !== null || ask !== true) return { name: saved };
    if (!placeAsking.has(key)) {
      // 실패하면 정해진 문장으로 거절돼요 (좌표는 로그에 안 남아요). 끝나면(성공이든 실패든) 목록에서 빼서 다음에 다시 누를 수 있게
      const asking = mapNet.reverse(f.lat, f.lng).then((name) => {
        try {
          db.setPlaceName(key, name, new Date().toISOString());
        } catch (err) {
          errorLog('장소 이름 저장', err); // 저장을 못 해도 이번에는 보여 줘요
        }
        return name;
      }).finally(() => placeAsking.delete(key));
      placeAsking.set(key, asking);
    }
    return { name: await placeAsking.get(key) };
  });

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
        // 화면이 칸을 더 안 기다리면(지도를 옮김, 창을 닫음) request.signal로 받기를 끊게 해 둬요
        //   Electron 45.2.1은 이 signal을 끊어 주지 않아서(lib/browser/api/protocol.ts의 new Request에 signal 없음) 지금은 효과가 없고, 나중 버전을 위해 준비만 한 것이에요
        const t = await mapNet.tile(request.url, { signal: request.signal });
        if (t.status !== 200) return notFound();
        return new Response(t.buffer, { status: 200, headers: { 'Content-Type': t.type, 'Cache-Control': 'no-cache' } });
      }
      if (!db) return notFound();
      const r = await handleMedia(request.url, { db, thumbs });
      if (r.status === 204) return new Response(null, { status: 204 }); // 라이브 포토가 아닌 사진 (화면은 재생 버튼을 숨겨요)
      if (r.status !== 200) return notFound();
      // 같은 id의 사진이 바뀌면 썸네일도 바뀌니 화면이 옛 그림을 붙들지 않게 해요
      const headers = { 'Content-Type': r.type, 'Cache-Control': 'no-cache' };
      const u = new URL(request.url);
      if (u.hostname === 'preview') {
        // 썸네일로 대신했는지 기억해 두고 헤더에도 적어요 (경로는 주지 않아요)
        const id = Number(u.pathname.slice(1));
        if (r.fallback) previewFallbacks.add(id);
        else previewFallbacks.delete(id);
        headers['X-Pvm-Preview'] = r.fallback ? 'thumb' : 'full';
      }
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

  // ---------- 가져오기 전 거르기: 시작 · 끝 ----------
  let screenNotice = null; // 끝낸 거르기 결과 { name, removed, trashed, moved } → 가져오기 화면이 한 번 읽어 가요
  // 시작: main.js 가 검사를 마친 가져올 폴더만 넘겨요. 지문 · AI 계산기는 이 폴더 몫으로 새로 만들어요
  function startScreening(dir) {
    if (!db || !thumbs) throw new Error('목록 파일(library.db)을 열지 못해서 거를 수 없어요. 프로그램을 다시 켜 보세요');
    const root = path.resolve(String(dir || ''));
    if (!dir || !isDir(root)) throw new Error('가져올 폴더를 찾지 못했어요. 연결을 확인해 주세요');
    if (screen && screen.root === root) return { name: screen.name };
    endScreening();
    // 라이브러리 지문 · AI 계산이 돌고 있으면(AI 는 몇 시간 걸리기도 해요) 거르기 폴더 계산이 그 뒤로 밀려요
    //   → 라이브러리 계산기는 지금 회차를 멈추고 새것으로 바꿔요. 남은 일은 거르기를 끝낸 뒤 다시 읽을 때 이어서 해요
    if (hashing && hasher) {
      const old = hasher;
      hasher = createHasher({ db, thumbs });
      old.stop().catch(() => {});
    }
    if (embedding && embedder) {
      const old = embedder;
      embedder = ai.createEmbedder({ db, thumbs, base });
      old.stop().catch(() => {});
    }
    screen = {
      root,
      name: path.basename(root) || root,
      trashed: 0,
      moved: 0,
      hasher: createHasher({ db, thumbs }),
      embedder: ai.createEmbedder({ db, thumbs, base }),
    };
    screenNotice = null;
    try {
      logger.newLog('screen', `가져오기 전 거르기 시작 ${now()}\n폴더: ${root}`);
    } catch (e) { /* 로그를 못 써도 계속 */ }
    send('gallery:library-changed');
    runScan(root, {}).catch((e) => errorLog('거르기 폴더 읽기', e));
    return { name: screen.name };
  }
  // 끝: 거르기 폴더 값을 비우고 그 폴더 계산을 멈춰요 → 갤러리는 다시 백업 폴더. 거르기가 없으면 아무것도 안 해요
  //   DB 의 거르기 폴더 줄은 지우지 않아요 (같은 폴더를 다시 거르면 썸네일 · 지문을 다시 안 만들어도 돼요, 설계 4-1)
  function endScreening() {
    if (!screen) return null;
    const s = screen;
    screen = null;
    if (hashAgain && hashAgain.root === s.root) hashAgain = null;
    if (embedAgain && embedAgain.root === s.root) embedAgain = null;
    s.hasher.stop().catch(() => {});
    s.embedder.stop().catch(() => {});
    screenNotice = { name: s.name, removed: s.trashed + s.moved, trashed: s.trashed, moved: s.moved };
    try {
      logger.newLog('screen', `가져오기 전 거르기 끝 ${now()}\n폴더: ${s.root}\n휴지통 ${s.trashed}장, _정리완료원본 ${s.moved}장`);
    } catch (e) { /* 로그를 못 써도 계속 */ }
    if (!closed) {
      send('gallery:library-changed');
      const root = libRoot();
      // 멈춘 라이브러리 계산을 다시 이어요: 읽기가 끝나면 지문(runScan 안), 지문이 다 있으면 AI 특징값도 (거르기 시작 때 멈췄을 수 있어요, #126 검증 ⚠️)
      if (root) {
        runScan(root, {})
          .then((r) => { if (r && r.status === 'done' && !closed && !screen && root === rootNow() && !hashing) startEmbedding(root, 'bg'); })
          .catch((e) => errorLog('거르기 끝낸 뒤 백업 폴더 읽기', e));
      }
    }
    return screenNotice;
  }

  // ---------- 가져올 때 태그 한 번에 (설계 4-3) ----------
  //   name: 작업에 적어 둔 태그 이름, paths: 이번 회차에 백업 폴더에 들어온(또는 이미 있던 같은) 파일 경로
  //   백업 폴더 안에서 DB 에 있는(갤러리가 읽은) 사진만 붙여요. 지금 태그 붙이기와 같은 길(기록 파일 → DB → 로그, 묶음 1개)이라
  //   되돌리기 줄로 한 번에 뗄 수 있어요. 이미 붙은 사진은 그대로. 사진 파일에는 쓰지 않아요
  //   → { batchId, count: 새로 붙인 장수, name, matched: DB 에서 찾은 장수, unknown: 못 찾은 장수 }
  function tagImported(rawName, paths) {
    if (!db) throw new Error('목록 파일(library.db)을 열지 못해서 태그를 붙이지 못했어요');
    const root = libRoot();
    if (!root) throw new Error('백업 폴더가 없어서 태그를 붙이지 못했어요');
    const name = cleanTagName(rawName);
    const low = (p) => path.resolve(p).toLowerCase(); // Windows 경로는 대소문자를 가리지 않아요
    const known = new Map();
    for (const [p, k] of db.knownFiles(root)) if (!k.missing) known.set(low(p), p);
    const rootLow = low(root);
    const seen = new Set();
    const rows = [];
    let unknown = 0;
    for (const raw of paths || []) {
      if (typeof raw !== 'string' || !raw) continue;
      const key = low(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      const rel = path.relative(rootLow, key);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue; // 백업 폴더 밖은 붙이지 않아요
      const p = known.get(key);
      if (!p) {
        unknown++;
        continue;
      }
      rows.push({ id: 0, name: path.basename(p), path: p, root, missing: false });
    }
    const plan = planTagEdit(rows, { kind: 'tagAdd', name }, (p) => db.getManualTags(p), root);
    const changed = plan.items.filter((it) => it.status === 'changed');
    if (!changed.length) return { batchId: null, count: 0, name, matched: rows.length, unknown };
    const items = changed.map((it) => ({ path: it.path, before: it.before, after: it.after }));
    const defs = !db.tagDef(root, name) ? [{ name, before: null, after: { hotkey: null } }] : [];
    const batchId = saveTagBatch(root, 'tagAdd', items, defs, '가져올 때 태그 붙이기', `\n태그 ${name}`);
    return { batchId, count: items.length, name, matched: rows.length, unknown };
  }

  // ---------- main.js가 부르는 것들 ----------
  let started = false;
  return {
    startScreening,
    endScreening,
    isScreening: () => !!screen,
    // 끝낸 거르기 결과를 한 번만 돌려줘요 (가져오기 화면 상태 줄용) → { name, removed, trashed, moved } 또는 null
    takeScreenNotice() {
      const n = screenNotice;
      screenNotice = null;
      return n;
    },
    tagImported,
    // 창이 처음 열리고 도구를 찾았으면: 백업 폴더가 있으면 읽기 시작
    //   창은 도구를 찾기 전에 먼저 떠요. 그래서 화면이 도구 정보(tools)를 다시 읽도록 한 번 알려요
    onWindowReady() {
      if (started) return;
      started = true;
      send('gallery:library-changed');
      const root = rootNow();
      if (root) runScan(root, {}).catch((e) => errorLog('시작 읽기', e));
    },
    // 가져오기 묶음이 끝나면: 읽는 중이어도 새 파일을 놓치지 않게 changed 로 다시 읽어요
    //   늘 백업 폴더를 읽어요 (거르기 폴더가 아니라. main.js 가 가져오기 전에 거르기를 끄지만 한 번 더, 설계 5-1)
    //   돌려주는 값: 다시 읽기 결과 Promise<{ status }> (태그 붙이기가 읽기가 끝난 뒤에 붙으려고 기다려요). 실패해도 거절하지 않아요
    onBatchDone() {
      const root = libRoot();
      if (!root) return Promise.resolve({ status: 'no-root' });
      // 기다리는 사이 거르기가 시작되면 합쳐진 다시 읽기가 거르기 폴더를 읽고 끝날 수 있어요 (lib/library.js 의 대기 요청은 마지막 폴더를 읽어요)
      //   → 끝났을 때 거르기 중이거나 백업 폴더가 바뀌었으면 "백업 폴더를 읽음"으로 보지 않아요 (태그가 엉뚱한 읽기 결과를 믿지 않게, #126 검증 ⚠️)
      return runScan(root, { changed: true })
        .then((r) => (screen || libRoot() !== root ? { ...r, status: 'superseded' } : r))
        .catch((e) => {
          errorLog('가져오기 뒤 다시 읽기', e);
          return { status: 'error' };
        });
    },
    // 설정에서 백업 폴더가 바뀌면: 새 폴더를 읽어요 (읽던 다른 폴더는 library가 멈춰요)
    onRootChanged() {
      send('gallery:library-changed');
      const root = libRoot();
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
      closed = true;
      try {
        endScreening(); // 거르기 중이면 그 계산도 멈춰요 (값은 메모리에만 있어서 다음에 켜면 백업 폴더)
      } catch (e) { /* 끄는 중이라 무시 */ }
      try {

        if (hasher) hasher.stop().catch(() => {});
        if (embedder) embedder.stop().catch(() => {});
        if (downloadAbort) downloadAbort.abort(); // 받는 중이면 멈춰요 (임시 파일은 다음 받기 때 치워요)


        if (thumbs) thumbs.stop().catch(() => {});
      } catch (e) { /* 끄는 중이라 무시 */ }
      try {
        if (db) db.close();
      } catch (e) { /* 이미 닫힘 */ }
    },
  };
}

module.exports = { setupGallery, registerScheme, cleanFilter }; // cleanFilter: 점검 42에서 지도 영역 거르기를 봐요

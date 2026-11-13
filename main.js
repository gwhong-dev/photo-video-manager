// 파일 위치: main.js
// 역할: 프로그램의 뇌 🧠 — 창 만들기 + 화면(index.html)의 부탁 처리
// 실제 작업은 lib 폴더의 파일들이 해요.

// 점검 전용(PVM_USER_DATA가 있을 때): 불러오는 중 오류가 나면 Electron의 "main process 오류" 대화상자를 띄우지 않고
//   바로 끝내요. 대화상자는 사용자 화면에서 점검을 멈춰 세워요. 다른 require보다 먼저 있어야 해요
if (process.env.PVM_USER_DATA) process.on('uncaughtException', (e) => { console.error(e); process.exit(1); });

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, session } = require('electron');
const path = require('path');
const fs = require('fs');

const { ExifTool, ExifToolPool } = require('./lib/exiftool');
const { detectTools } = require('./lib/tools');
const { makePlan, priorKey, readMetaWithKeys, META_TAGS, isVideoPath, NO_DATE_DIR, statusLabelOf, isIssue } = require('./lib/planner');

// 원본 정리 직전에 변환된 중복을 확인할 정보 (애플 ID, 촬영 날짜, 가로×세로) → Map<keyOf(경로), 정보>
const cleanReadMeta = (paths) => {
  if (!et) throw new Error('exiftool 없음');
  return readMetaWithKeys(et, paths.map((p) => ({ path: p, isVideo: isVideoPath(p) })), [...META_TAGS, 'ImageWidth', 'ImageHeight', 'ModifyDate']);
};
const { validateFolders, validatePick } = require('./lib/paths');
const { JobStore, jobStats } = require('./lib/job');
const { cleanCandidates, cleanTargets, cleanInfo, cleanOriginals, createHashCache, countHashesFrom } = require('./lib/cleaner');
const { createDriveKindOf } = require('./lib/platform');
const { samplePool, sampleView, openSample } = require('./lib/clean-sample');
const { openFolderOnly } = require('./lib/open-folder');
const { createLogger, now } = require('./lib/logger');
const { guardWindow } = require('./lib/window-guard');
const { writePlanLog, nextTodo, requeueFailed, checkSpace, runBatch, DEFAULT_CONCURRENCY } = require('./lib/runner');
const { setupGallery, registerScheme } = require('./gallery-main');

// ---------- 상태 ----------
let win = null;
let settings = null;   // 저장된 설정 (폴더 경로, 도구 위치 등)
let tools = null;      // 찾은 도구들
let toolsReady = null; // 켤 때 처음 도구 찾기 (창을 먼저 띄우고 뒤에서 찾아요. 끝나면 tools가 채워져요)
let et = null;         // 계속 켜 둔 exiftool
let store = null;      // 작업 목록 저장소
let job = null;        // 지금 작업 (이어하기용)
let lastPlan = null;   // 미리보기 결과 (아직 실행 전)
let running = false;   // 실행 중인지
let pauseAsked = false; // 일시정지 눌렀는지
let planning = false;  // 미리보기를 만드는 중인지 (화면을 바꾸면 늦게 끝난 미리보기가 다른 화면의 계획을 덮어쓸 수 있어서 막아요)
let gallery = null;    // 갤러리 연결 (gallery-main.js). 아직 없으면 null

const userDir = () => app.getPath('userData');
const settingsPath = () => path.join(userDir(), 'settings.json');
const logDir = () => path.join(userDir(), 'logs');

// ---------- 설정 저장/불러오기 ----------
// mapTileUrl, placeSearchUrl: 지도 그림과 장소 검색 서버 주소. 비워 두면 기본 주소를 써요 (https 만. 화면에는 설정 칸이 없고 settings.json 에서 바꿔요)
const DEFAULTS = { source: '', backupRoot: '', includeSub: true, batchSize: 2000, exiftool: '', magick: '', ffmpeg: '', mapTileUrl: '', placeSearchUrl: '' };

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch (e) {
    return { ...DEFAULTS };
  }
}
function saveSettings() {
  fs.mkdirSync(userDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

// ---------- 도구 찾기 ----------
// tools 폴더를 찾아볼 곳: 개발 중에는 프로젝트 폴더, exe 로 만든 뒤에는 설정 폴더 → exe 가 든 폴더 순서
//   exe 안의 코드는 app.asar(묶음 파일) 속에 있어서, 그 안에 든 프로그램은 실행할 수 없어요
//   exe 를 다시 만들면 exe 폴더(release\win-unpacked)가 통째로 지워져서, 오래 둘 곳은 설정 폴더의 tools 예요 (#73 검증 ⚠️)
//   둘 다 없으면 예전처럼 PATH(이름만으로 찾기)에서 찾아요
const toolsBaseDirs = () => (app.isPackaged ? [userDir(), path.dirname(process.execPath)] : [__dirname]);
// 가져오기 실행·미리보기 중에는 쓰던 exiftool을 닫으면 남은 파일이 전부 실패로 기록돼서 도구를 새로 찾지 않아요
const TOOLS_BUSY_MSG = '가져오기 실행이나 미리보기가 끝난 뒤에 도구를 다시 찾을 수 있어요';
const toolsBusy = () => running || planning;

//   notify: false = 갤러리에 알리지 않아요 (켤 때 처음 찾기. 갤러리는 창이 열린 뒤 toolsReady를 기다렸다가 스스로 읽기 시작해요)
async function refreshTools({ notify = true } = {}) {
  const found = await detectTools(settings, toolsBaseDirs());
  // 찾는 동안(몇백 ms) 작업이 시작됐을 수 있어서, 바꾸기 직전에 한 번 더 확인해요
  if (toolsBusy()) throw new Error(TOOLS_BUSY_MSG);
  tools = found;
  const old = et;
  // 같은 exiftool이면 켜 둔 것을 그대로 써요 (읽기 중인 갤러리를 방해하지 않게)
  if (old && !old.closed && tools.exiftool.ok && old.exePath === tools.exiftool.path) return tools;
  if (old) old.close();
  et = tools.exiftool.ok ? new ExifTool(tools.exiftool.path) : null;
  // 갤러리 읽기는 옛 exiftool이 닫히면 오류로 끝나거나(읽는 중), 'exiftool 없음'으로 끝났을 수 있어서 한 번 다시 읽어요
  if (gallery && notify) {
    try {
      gallery.onToolsChanged();
    } catch (err) {
      try { logger.newLog('gallery-error', `onToolsChanged 오류: ${err && err.message ? err.message : err}`); } catch (e2) { /* 로그 실패는 무시 */ }
    }
  }
  return tools;
}

// ---------- 로그 ----------
// 실제 로그 쓰기는 lib/logger.js (앱이 준비된 뒤에 만들어요)
let logger = null;

// ---------- 화면에 보여줄 표 만들기 ----------
// 상태 이름, "주의할 것" 판단은 lib/planner.js (점검에서도 같은 함수를 확인해요)
function rowsOf(data, filter) {
  const items = data.items;
  const tests = {
    all: () => true,
    issue: isIssue,
    nodate: (it) => it.relDir === NO_DATE_DIR,
    dup: (it) => it.status === 'dup',
    fail: (it) => it.status === 'fail',
    todo: (it) => it.status === 'todo',
  };
  const test = tests[filter] || tests.all;
  let list = items.filter(test);
  if (filter === 'all') list = list.filter(isIssue).concat(list.filter((it) => !isIssue(it))); // 주의할 것 먼저
  const total = list.length;
  const rows = list.slice(0, 500).map((it) => {
    const shown = it.finalPath || it.dupOf || it.dest;
    return {
      status: statusLabelOf(it),
      statusKey: it.status,
      src: path.relative(data.source, it.src) || path.basename(it.src),
      work: it.label,
      name: path.basename(shown),
      dir: path.relative(data.backupRoot, path.dirname(shown)) || '.',
      dateFrom: it.dateFrom,
      newFolder: it.status === 'todo' && !fs.existsSync(path.dirname(it.dest)), // 아직 없는 폴더면 🆕
      renamed: it.renamed,
      noDate: it.relDir === NO_DATE_DIR,
      check: !!it.check,
      note: it.note || (it.refDate ? `참고 날짜 ${it.refDate}` : ''),
    };
  });
  return { rows, total };
}

function jobInfo() {
  if (!job) return null;
  const list = cleanCandidates(job); // 정리할 수 있어 보이는 원본 (정리 직전에 지문까지 다시 확인)
  return {
    source: job.source,
    backupRoot: job.backupRoot,
    createdAt: job.createdAt,
    stats: jobStats(job),
    deletable: list.length,
    deletableBytes: list.reduce((a, it) => a + (it.size || 0), 0),
  };
}

// ---------- 창 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 860,
    title: '사진/영상 관리 프로그램',
    // spellcheck: false = 맞춤법 검사를 끔. 아래 whenReady 쪽 설명처럼 사전 내려받기를 막으려는 것 (점검 34k)
    webPreferences: { preload: path.join(__dirname, 'preload.js'), spellcheck: false },
  });
  // 앱 화면 밖으로 나가는 이동과 새 창은 막고 로그에 남겨요 (주소가 길면 앞부분만)
  guardWindow(win.webContents, [GALLERY_FILE, IMPORT_FILE], (kind, url) => {
    try { logger.newLog('window-guard', `${kind} 막음: ${String(url).slice(0, 200)}`); } catch (e) { /* 로그를 못 써도 막기는 그대로예요 */ }
  });
  showStartScreen();
  // 창이 처음 다 열리고 도구도 다 찾았으면 갤러리가 백업 폴더 읽기를 시작해요 (읽으려면 exiftool이 필요해요)
  win.webContents.once('did-finish-load', async () => {
    if (toolsReady) await toolsReady;
    if (gallery) gallery.onWindowReady();
  });

  // 실행 중에 닫으려고 하면 한 번 물어보기
  win.on('close', (e) => {
    if (!running) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['계속 작업', '닫기'],
      defaultId: 0,
      message: '작업 중이에요. 닫을까요?',
      detail: '닫아도 완료된 파일은 기록돼 있어서, 다음에 켜면 이어서 할 수 있어요.',
    });
    if (r === 0) e.preventDefault();
  });
}

// ---------- 화면 바꾸기 ----------
// 시작 화면은 갤러리예요. 갤러리 화면은 Vite로 만든 dist/renderer 에 있어요 (npm start 가 먼저 만들어 줘요)
//   PVM_START_SCREEN=import 는 점검(npm run check) 전용이에요. 사용자는 쓰지 않아요
const GALLERY_FILE = path.join(__dirname, 'dist', 'renderer', 'index.html');
const IMPORT_FILE = path.join(__dirname, 'index.html');

async function loadScreen(name) {
  if (!win || win.isDestroyed()) return;
  if (name === 'gallery') {
    if (!fs.existsSync(GALLERY_FILE)) {
      throw new Error('갤러리 화면 파일이 아직 없어요. 터미널에서 npm start 로 실행하면 만들어져요');
    }
    await win.loadFile(GALLERY_FILE);
  } else {
    await win.loadFile(IMPORT_FILE);
  }
}

function showStartScreen() {
  // 갤러리 연결이 실패했으면(gallery가 null) 갤러리 화면은 아무것도 못 해서 가져오기 화면으로 열어요
  const wantGallery = process.env.PVM_START_SCREEN !== 'import' && !!gallery;
  if (wantGallery && !fs.existsSync(GALLERY_FILE)) {
    // 빈 창 대신 이유를 알려 주고 가져오기 화면으로 열어요 (가져오기는 만들기 없이 쓸 수 있어요)
    win.loadFile(IMPORT_FILE);
    // 점검(PVM_USER_DATA)에서는 대화상자를 띄우지 않아요. 사용자 화면에서 점검이 멈춰 서지 않게
    if (!process.env.PVM_USER_DATA) {
      dialog.showMessageBox(win, {
        type: 'warning',
        message: '갤러리 화면 파일이 아직 없어요',
        detail: '터미널에서 npm start 로 실행해 주세요. 화면을 먼저 만든 뒤 프로그램이 켜져요.\n지금은 가져오기 화면으로 열었어요.',
      });
    }
    return;
  }
  win.loadFile(wantGallery ? GALLERY_FILE : IMPORT_FILE);
}

const send = (ch, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
};

// ---------- 화면에서 오는 부탁들 ----------

// 처음 켤 때 상태
ipcMain.handle('get-state', async () => {
  if (toolsReady) await toolsReady; // 처음 찾기가 아직이면 끝날 때까지 기다려요 (찾는 중에 "없음"으로 보이지 않게)
  if (!tools) await refreshTools();
  return { settings, tools, job: jobInfo() };
});

// 도구 다시 찾기
ipcMain.handle('check-tools', async () => {
  if (toolsBusy()) throw new Error(TOOLS_BUSY_MSG);
  if (toolsReady) await toolsReady; // 처음 찾기와 겹치지 않게
  return refreshTools();
});

// 도구 위치 직접 고르기 (exe 파일 선택)
ipcMain.handle('pick-tool', async (e, name) => {
  if (toolsBusy()) throw new Error(TOOLS_BUSY_MSG);
  if (toolsReady) await toolsReady; // 처음 찾기가 끝난 뒤에 (취소하면 지금 도구 정보를 돌려주려고)
  const r = await dialog.showOpenDialog(win, {
    title: `${name} 실행 파일 선택`,
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: '실행 파일', extensions: ['exe'] }] : [],
  });
  if (r.canceled) return tools;
  if (toolsBusy()) throw new Error(TOOLS_BUSY_MSG); // 창을 고르는 사이에 작업이 시작됐을 수 있어요
  settings[name] = r.filePaths[0];
  saveSettings();
  return refreshTools();
});

// 폴더 선택
ipcMain.handle('select-folder', async (e, title, defaultPath) => {
  const r = await dialog.showOpenDialog(win, {
    title,
    defaultPath: defaultPath || undefined,
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

// 설정 저장 (폴더 경로, 하위 폴더 포함, 한 번에 개수)
ipcMain.handle('save-settings', async (e, patch) => {
  const rootBefore = settings.backupRoot;
  // 지도와 검색 서버 주소는 settings.json에서만 바꿔요 (설계서 4-3). 화면이 보낸 값은 버려요
  const { mapTileUrl, placeSearchUrl, ...allowed } = patch || {};
  Object.assign(settings, allowed);
  saveSettings();
  if (gallery && settings.backupRoot !== rootBefore) gallery.onRootChanged(); // 백업 폴더가 바뀌면 갤러리가 새 폴더를 읽어요
  return settings;
});

// 폴더를 고르는 순간 확인 (둘 다 골랐을 때만 판단)
ipcMain.handle('check-folders', async (e, source, backupRoot) => validatePick(source, backupRoot));

// 미리보기 (읽기만 함!)
ipcMain.handle('make-plan', async (e, { source, backupRoot, includeSub }) => {
  if (running) throw new Error('실행 중에는 미리보기를 할 수 없어요');
  if (!et) throw new Error('exiftool을 찾지 못했어요. 위쪽 도구 상태를 확인해 주세요.');
  // 폴더 조합 확인 (같은 폴더, 백업 안쪽/상위, 후가공 폴더 → 거부). 화면에서도 고를 때 확인하지만 한 번 더
  const v = validateFolders(source, backupRoot);
  if (!v.ok) throw new Error(v.reason);

  planning = true;
  let planEt = null;
  try {
    // 이전 작업에서 변환을 끝낸 원본은 "이미 정리됨"으로 (같은 폴더를 다시 가져와도 _1 복사본이 또 생기지 않게, M4)
    let priorResults = null;
    try {
      priorResults = store.priorResults(priorKey, (name, err) => {
        try { logger.newLog('plan-prior', `이전 작업 기록 읽기 실패 ${name}: ${err.message}`); } catch (e2) { /* 로그 실패는 무시 */ }
      });
    } catch (err) {
      priorResults = null; // 못 읽으면 예전처럼 (이름이 겹치면 _1)
    }
    // 미리보기 동안만 exiftool을 여러 개 켜서 파일 정보를 나눠 읽어요 (파일이 많을 때 빨라져요). 끝나면 꺼요
    planEt = new ExifToolPool(tools.exiftool.path, DEFAULT_CONCURRENCY);
    lastPlan = await makePlan({ source, backupRoot, includeSub }, planEt, (msg) => send('plan-status', msg), { priorResults });
  } finally {
    planning = false;
    if (planEt) planEt.close();
    planEt = null;
  }
  // 새로 처리할 파일이 없어도(전부 중복) 백업에 이미 있는 원본은 정리할 수 있게 개수를 같이 보내요 (실사용 테스트 10-4)
  //   정리 직전에는 지금처럼 cleanTargets 로 지문까지 다시 확인해요
  const cleanable = lastPlan.stats.todo === 0 ? cleanCandidates(lastPlan).length : 0;
  return { stats: lastPlan.stats, cleanable, ...rowsOf(lastPlan, 'all') };
});

// 표 필터 바꾸기
ipcMain.handle('get-rows', async (e, filter) => {
  const data = lastPlan || job;
  if (!data) return { rows: [], total: 0 };
  return rowsOf(data, filter);
});

// 미리보기 → 작업 목록으로 저장 (실행 시작)
ipcMain.handle('start-job', async () => {
  if (running) throw new Error('실행 중이거나 원본 정리 중에는 새 작업을 시작할 수 없어요');
  if (!lastPlan) throw new Error('먼저 미리보기를 해 주세요');
  if (store.exists()) store.close('replaced'); // 이전 작업은 보관
  job = store.create(lastPlan);
  lastPlan = null;
  resetCleanCheck(); // 이전 작업의 샘플 후보가 남지 않게
  writePlanLog(job, logger); // 계획 로그 (날짜없음 참고 날짜, 중복, 확인 필요 목록)
  return jobInfo();
});

// 실행 전 남은 공간 확인 (화면에서 실행 버튼 누르기 전에 물어봐요)
ipcMain.handle('space-info', async (e, batchSize) => {
  if (!job) return null;
  return checkSpace(nextTodo(job, batchSize), job.backupRoot);
});

// 일시정지 (지금 파일까지만 하고 멈춤)
ipcMain.handle('pause', async () => {
  pauseAsked = true;
  return true;
});

// 실패한 파일을 다시 시도할 수 있게 대기로 되돌리기 (임시 파일 정리 포함, 실행은 화면이 이어서 run-batch 로)
ipcMain.handle('retry-failed', async () => {
  if (!job) throw new Error('작업이 없어요');
  if (running) throw new Error('이미 실행 중이에요');
  const r = requeueFailed(job, store);
  try { logger.newLog('retry', `# 실패 다시 시도 / ${now()} / 대기로 되돌림 ${r.requeued}개, 임시 파일 정리 ${r.cleaned}개`); } catch (e) { /* 로그 실패는 무시 */ }
  return { ...r, job: jobInfo() };
});

// 실행: 다음 N개 처리
ipcMain.handle('run-batch', async (e, batchSize) => {
  if (!job) throw new Error('작업이 없어요');
  if (running) throw new Error('이미 실행 중이에요');

  const n = Math.max(1, Number(batchSize) || 2000);
  const todo = nextTodo(job, n);

  // 필요한 도구가 있는지 먼저 확인
  if (todo.some((it) => it.kind === 'heic2jpg') && !tools.magick.ok) throw new Error('ImageMagick이 없어서 HEIC를 변환할 수 없어요');
  if (todo.some((it) => it.kind === 'mov2mp4') && !tools.ffmpeg.ok) throw new Error('FFmpeg이 없어서 MOV를 변환할 수 없어요');

  running = true;
  pauseAsked = false;
  // 파일 여러 개를 동시에 처리해요 (lib/runner.js). exiftool도 그 수만큼 켜서 줄 서지 않게, 끝나면 꺼요
  const runEt = tools.exiftool.ok ? new ExifToolPool(tools.exiftool.path, DEFAULT_CONCURRENCY) : et;
  const ctx = { et: runEt, magick: tools.magick.path, ffmpeg: tools.ffmpeg.path, ffprobe: tools.ffprobe.path };
  try {
    const r = await runBatch({
      job,
      store,
      batchSize: n,
      ctx,
      logger,
      concurrency: DEFAULT_CONCURRENCY,
      shouldPause: () => pauseAsked,
      onProgress: (p) => send('progress', p),
    });
    return { ...r, job: jobInfo() };
  } finally {
    if (runEt && runEt !== et) runEt.close();
    running = false;
    // 새로 들어온 파일을 갤러리가 다시 읽어요 (오류로 멈춰도 이미 옮긴 파일이 있을 수 있어요).
    //   갤러리 쪽 오류가 가져오기 결과를 바꾸면 안 돼서 여기서 잡고 로그만 남겨요
    if (gallery) {
      try {
        gallery.onBatchDone();
      } catch (err) {
        try { logger.newLog('gallery-error', `onBatchDone 오류: ${err && err.message ? err.message : err}`); } catch (e2) { /* 로그 실패는 무시 */ }
      }
    }
  }
});

// 원본 삭제 전 정보 (개수, 용량, 휴지통 경고)
// 원본 정리 전 정보 (개수, 용량, 드라이브별 방법, 경고)
//   확인 창에서 쓴 드라이브 판단을 실제 정리에도 그대로 써요 (보여 준 방법과 실제 방법이 달라지지 않게)
//   원본 확인(지문 계산)은 1분 넘게 걸릴 수 있어요 → 진행 상황을 화면에 보내고, 그동안은 "실행 중"으로 막아요 (여러 번 눌러도 겹치지 않게)
//   지문도 확인 창에서 계산한 것을 실제 정리 때 다시 써요. 크기 · 수정 시각이 바뀐 파일만 다시 계산 (createHashCache)
let cleanDriveKindOf = null;
let cleanHashOf = null;
let cleanSample = null; // 🔍 샘플 확인 후보 (확인 창을 띄울 때 만든 정리 대상의 결과 파일들)
// 정리 확인 창에서 만든 것들 비우기 (정리를 끝냈을 때, 작업을 끝내거나 새로 시작할 때)
//   지난 작업의 샘플 후보가 남아 있으면 다른 작업의 파일을 열 수 있어서요
function resetCleanCheck() {
  cleanDriveKindOf = null; // 다음 정리 때는 새로 확인
  cleanHashOf = null; // 지문도 다음 정리 때는 새로 계산
  cleanSample = null; // 샘플 후보도 다음 확인 창에서 새로
}
ipcMain.handle('trash-info', async () => {
  if (running) throw new Error('다른 작업이 끝난 뒤에 해 주세요');
  running = true;
  try {
    cleanDriveKindOf = createDriveKindOf();
    cleanHashOf = createHashCache();
    const targets = job ? await cleanTargets(job, { hashOf: cleanHashOf, ffprobe: tools.ffprobe.path, store, logger, readMeta: cleanReadMeta, onProgress: (p) => send('clean-check-progress', p) }) : [];
    cleanSample = samplePool(job, targets);
    // 확인하다 재생 불가를 찾으면 개수가 바뀌어요 → 작업 정보도 새로 보내요
    return { ...(await cleanInfo(job, targets, { driveKindOf: cleanDriveKindOf })), sample: sampleView(cleanSample), job: jobInfo() };
  } finally {
    running = false;
  }
});

// 원본 정리 (하드디스크 → 휴지통 / USB·SD·네트워크 → _정리완료원본으로 이동, 영구 삭제 없음)
ipcMain.handle('trash-originals', async () => {
  if (running) throw new Error('실행 중에는 할 수 없어요');
  // 정리하는 동안에는 "실행 중"으로 표시 → 미리보기·새 작업·작업 끝내기를 막아요 (기록이 섞이지 않게)
  running = true;
  try {
    // 정리 직전 확인은 줄이지 않아요: 크기 · 열어서 읽기 · 재생 확인은 다시 하고, 지문만 바뀌지 않은 파일은 다시 써요
    const hashOf = cleanHashOf || createHashCache();
    const hashCount = countHashesFrom(hashOf); // 정리 직전 확인에서 지문을 다시 계산한 수 · 다시 쓴 수 → 로그 끝 줄
    const targets = job ? await cleanTargets(job, { hashOf, ffprobe: tools.ffprobe.path, store, logger, readMeta: cleanReadMeta }) : [];
    const r = await cleanOriginals({
      hashStats: hashCount(),
      job,
      store,
      targets,
      logger,
      trash: (p) => shell.trashItem(p),
      driveKindOf: cleanDriveKindOf || createDriveKindOf(), // 확인 창과 같은 판단
      onProgress: (p) => send('trash-progress', p),
    });
    return { ...r, job: jobInfo() };
  } finally {
    running = false;
    resetCleanCheck();
  }
});

// 🔍 샘플 확인: 다시 뽑기 (확인 창을 띄울 때 만든 후보에서 다시 무작위로)
//   돌려주는 값: { items: 뽑은 10개, total: 후보 전체 수 }
ipcMain.handle('clean-sample', async () => sampleView(cleanSample || []));

// 🔍 샘플 확인: 누른 결과 파일을 크게 열기 (Windows 기본 프로그램, 사진 앱 · 영상 플레이어)
//   화면은 경로를 모르고 번호만 보내요. 이번 후보 안의 파일만 열어요
ipcMain.handle('clean-sample-open', async (e, key) => openSample(cleanSample, key, { exists: fs.existsSync, openPath: (x) => shell.openPath(x) }));

// 작업 끝내기 / 취소
ipcMain.handle('close-job', async (e, reason) => {
  if (running) throw new Error('실행 중에는 할 수 없어요');
  store.close(reason === 'cancel' ? 'cancelled' : 'done');
  job = null;
  resetCleanCheck(); // 끝낸 작업의 샘플 후보가 남지 않게
  return true;
});

// 로그 폴더 열기
ipcMain.handle('open-logs', async () => {
  fs.mkdirSync(logDir(), { recursive: true });
  await shell.openPath(logDir());
});

// 폴더 열기 (실제 폴더일 때만. 화면이 파일 경로를 보내도 열지 않아요)
ipcMain.handle('open-folder', async (e, p) => openFolderOnly(p, { isDir: (x) => fs.statSync(x).isDirectory(), openPath: (x) => shell.openPath(x) }));

// ---------- 시작 / 종료 ----------
// 프로그램은 하나만 켜지게 (두 개가 같은 작업 기록을 동시에 건드리면 안 돼서요)
//   이미 켜져 있으면 → 새로 켠 쪽은 바로 끄고, 원래 창을 앞으로 보여줘요
// 점검 전용: PVM_USER_DATA가 있으면 설정·DB·로그를 그 폴더에 써요 (진짜 사용자 설정을 건드리지 않게).
//   프로그램은 하나만 켜지게 하는 잠금도 이 폴더 기준이라, 잠금보다 먼저 정해야 해요
if (process.env.PVM_USER_DATA) app.setPath('userData', process.env.PVM_USER_DATA);
registerScheme(protocol); // pvm:// 이미지 주소 등록 (앱이 준비되기 전에 해야 해요)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

app.whenReady().then(async () => {
  if (!gotLock) return;
  settings = loadSettings();
  logger = createLogger(logDir());
  // 맞춤법 검사 끄기: 켜 두면 Chromium이 처음 켤 때 한국어 사전을 구글 서버(gvt1.com)에서 내려받아요.
  //   창 설정 spellcheck: false 와 setSpellCheckerEnabled(false) 만으로는 내려받기가 안 멈췄고, 언어 목록을 비워야 멈췄어요 (점검 34k)
  //   실패해도 앱은 계속 켜져요
  try {
    session.defaultSession.setSpellCheckerEnabled(false);
    session.defaultSession.setSpellCheckerLanguages([]);
  } catch (e) {
    logger.newLog('startup', `맞춤법 검사 끄기 실패 ${e.message}`);
  }
  store = new JobStore(path.join(userDir(), 'jobs'));
  try {
    job = store.load(); // 이어할 작업이 있으면 불러오기
  } catch (e) {
    job = null;
  }
  // 도구 찾기는 기다리지 않고 시작만 해요. 창이 먼저 뜨고, 도구(exiftool 등 4개 실행)는 뒤에서 찾아요
  //   찾는 동안 화면의 get-state(가져오기)와 갤러리 읽기 시작은 toolsReady를 기다려요. 실패해도 앱은 켜져요 (tools는 null 그대로)
  toolsReady = refreshTools({ notify: false }).catch((e) => {
    logger.newLog('startup', `도구 찾기 실패 ${e.message}`);
    return null;
  });
  try {
    gallery = setupGallery({
      ipcMain,
      protocol,
      getWin: () => win,
      getSettings: () => settings,
      getTools: () => tools,
      getEt: () => et,
      isRunning: () => running,
      isPlanning: () => planning,
      logger,
      userDir,
      loadScreen,
      getJobPending: () => !!job,
      // 지도용 인터넷과 브라우저 열기. 갤러리는 Electron을 직접 부르지 않고 여기서 받아요
      mapFetch: (...a) => net.fetch(...a),
      openExternal: (u) => shell.openExternal(u),
      openPath: (p) => shell.openPath(p), // 정리 화면의 _정리완료원본 폴더 열기 (gallery-main 이 정한 경로만)
      appVersion: app.getVersion(),
      trash: (p) => shell.trashItem(p), // 비슷한 사진 버리기 (휴지통이 없는 드라이브는 _정리완료원본으로 이동)
    });
  } catch (e) {
    // 갤러리를 못 켜도 가져오기는 쓸 수 있어야 해요
    gallery = null;
    console.error('갤러리 연결 실패:', e);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

// 종료할 때 갤러리 DB와 exiftool도 같이 끄기
app.on('will-quit', () => {
  if (gallery) gallery.close(); // 썸네일 만들던 프로그램을 기다리지 않고 DB를 닫아요
  if (et) et.close();
});

// 파일 위치: main.js
// 역할: 프로그램의 뇌 🧠 — 창 만들기 + 화면(index.html)의 부탁 처리
// 실제 작업은 lib 폴더의 파일들이 해요.

const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

const { ExifTool } = require('./lib/exiftool');
const { detectTools } = require('./lib/tools');
const { makePlan, NO_DATE_DIR, statusLabelOf, isIssue } = require('./lib/planner');
const { validateFolders, validatePick } = require('./lib/paths');
const { JobStore, jobStats } = require('./lib/job');
const { cleanCandidates, cleanTargets, cleanInfo, cleanOriginals } = require('./lib/cleaner');
const { createDriveKindOf } = require('./lib/platform');
const { createLogger } = require('./lib/logger');
const { writePlanLog, nextTodo, checkSpace, runBatch } = require('./lib/runner');
const { setupGallery, registerScheme } = require('./gallery-main');

// ---------- 상태 ----------
let win = null;
let settings = null;   // 저장된 설정 (폴더 경로, 도구 위치 등)
let tools = null;      // 찾은 도구들
let et = null;         // 계속 켜 둔 exiftool
let store = null;      // 작업 목록 저장소
let job = null;        // 지금 작업 (이어하기용)
let lastPlan = null;   // 미리보기 결과 (아직 실행 전)
let running = false;   // 실행 중인지
let pauseAsked = false; // 일시정지 눌렀는지
let gallery = null;    // 갤러리 연결 (gallery-main.js). 아직 없으면 null

const userDir = () => app.getPath('userData');
const settingsPath = () => path.join(userDir(), 'settings.json');
const logDir = () => path.join(userDir(), 'logs');

// ---------- 설정 저장/불러오기 ----------
const DEFAULTS = { source: '', backupRoot: '', includeSub: true, batchSize: 2000, exiftool: '', magick: '', ffmpeg: '' };

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
async function refreshTools() {
  tools = await detectTools(settings, __dirname);
  if (et) et.close();
  et = tools.exiftool.ok ? new ExifTool(tools.exiftool.path) : null;
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
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  showStartScreen();
  // 창이 처음 다 열리면 갤러리가 백업 폴더 읽기를 시작해요
  win.webContents.once('did-finish-load', () => {
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
  const wantGallery = process.env.PVM_START_SCREEN !== 'import';
  if (wantGallery && !fs.existsSync(GALLERY_FILE)) {
    // 빈 창 대신 이유를 알려 주고 가져오기 화면으로 열어요 (가져오기는 만들기 없이 쓸 수 있어요)
    win.loadFile(IMPORT_FILE);
    dialog.showMessageBox(win, {
      type: 'warning',
      message: '갤러리 화면 파일이 아직 없어요',
      detail: '터미널에서 npm start 로 실행해 주세요. 화면을 먼저 만든 뒤 프로그램이 켜져요.\n지금은 가져오기 화면으로 열었어요.',
    });
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
  if (!tools) await refreshTools();
  return { settings, tools, job: jobInfo() };
});

// 도구 다시 찾기
ipcMain.handle('check-tools', async () => refreshTools());

// 도구 위치 직접 고르기 (exe 파일 선택)
ipcMain.handle('pick-tool', async (e, name) => {
  const r = await dialog.showOpenDialog(win, {
    title: `${name} 실행 파일 선택`,
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: '실행 파일', extensions: ['exe'] }] : [],
  });
  if (r.canceled) return tools;
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
  Object.assign(settings, patch);
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

  lastPlan = await makePlan({ source, backupRoot, includeSub }, et, (msg) => send('plan-status', msg));
  return { stats: lastPlan.stats, ...rowsOf(lastPlan, 'all') };
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
  const ctx = { et, magick: tools.magick.path, ffmpeg: tools.ffmpeg.path, ffprobe: tools.ffprobe.path };
  try {
    const r = await runBatch({
      job,
      store,
      batchSize: n,
      ctx,
      logger,
      shouldPause: () => pauseAsked,
      onProgress: (p) => send('progress', p),
    });
    return { ...r, job: jobInfo() };
  } finally {
    running = false;
    if (gallery) gallery.onBatchDone(); // 새로 들어온 파일을 갤러리가 다시 읽어요 (오류로 멈춰도 이미 옮긴 파일이 있을 수 있어요)
  }
});

// 원본 삭제 전 정보 (개수, 용량, 휴지통 경고)
// 원본 정리 전 정보 (개수, 용량, 드라이브별 방법, 경고)
//   확인 창에서 쓴 드라이브 판단을 실제 정리에도 그대로 써요 (보여 준 방법과 실제 방법이 달라지지 않게)
//   원본 확인(지문 계산)은 1분 넘게 걸릴 수 있어요 → 진행 상황을 화면에 보내고, 그동안은 "실행 중"으로 막아요 (여러 번 눌러도 겹치지 않게)
let cleanDriveKindOf = null;
ipcMain.handle('trash-info', async () => {
  if (running) throw new Error('다른 작업이 끝난 뒤에 해 주세요');
  running = true;
  try {
    cleanDriveKindOf = createDriveKindOf();
    const targets = job ? await cleanTargets(job, { ffprobe: tools.ffprobe.path, store, logger, onProgress: (p) => send('clean-check-progress', p) }) : [];
    // 확인하다 재생 불가를 찾으면 개수가 바뀌어요 → 작업 정보도 새로 보내요
    return { ...(await cleanInfo(job, targets, { driveKindOf: cleanDriveKindOf })), job: jobInfo() };
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
    const targets = job ? await cleanTargets(job, { ffprobe: tools.ffprobe.path, store, logger }) : [];
    const r = await cleanOriginals({
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
    cleanDriveKindOf = null; // 다음 정리 때는 새로 확인
  }
});

// 작업 끝내기 / 취소
ipcMain.handle('close-job', async (e, reason) => {
  if (running) throw new Error('실행 중에는 할 수 없어요');
  store.close(reason === 'cancel' ? 'cancelled' : 'done');
  job = null;
  return true;
});

// 로그 폴더 열기
ipcMain.handle('open-logs', async () => {
  fs.mkdirSync(logDir(), { recursive: true });
  await shell.openPath(logDir());
});

// 폴더 열기
ipcMain.handle('open-folder', async (e, p) => {
  if (!p || !fs.existsSync(p)) return false;
  await shell.openPath(p);
  return true;
});

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
  store = new JobStore(path.join(userDir(), 'jobs'));
  try {
    job = store.load(); // 이어할 작업이 있으면 불러오기
  } catch (e) {
    job = null;
  }
  // 갤러리가 폴더를 읽으려면 exiftool이 필요해서 창을 열기 전에 도구부터 찾아요
  try {
    await refreshTools();
  } catch (e) {
    logger.newLog('startup', `도구 찾기 실패 ${e.message}`);
  }
  try {
    gallery = setupGallery({
      ipcMain,
      protocol,
      getWin: () => win,
      getSettings: () => settings,
      getTools: () => tools,
      getEt: () => et,
      isRunning: () => running,
      logger,
      userDir,
      loadScreen,
      getJobPending: () => !!job,
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

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto'); // 파일 내용 지문(해시) 만드는 도구
const exifr = require('exifr'); // 촬영일 읽는 도구

// 사진/영상 확장자 목록
const PHOTO_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic'];
const VIDEO_EXT = ['.mp4', '.mov', '.avi', '.mkv', '.wmv'];

let lastPlan = null; // 미리보기로 만든 계획 (실행할 때 사용)
let running = false; // 실행 중인지 표시

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: '사진/영상 관리 프로그램',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

// ---------- 날짜 읽기 ----------

// 1순위: 촬영일(EXIF)
async function readTakenDate(fullPath) {
  try {
    const exif = await exifr.parse(fullPath, ['DateTimeOriginal', 'CreateDate']);
    const date = exif?.DateTimeOriginal || exif?.CreateDate;
    if (date instanceof Date && !isNaN(date)) return date;
  } catch (e) {
    // 읽기 실패하면 없는 걸로 처리
  }
  return null;
}

// 2순위: 파일명 속 날짜 (예: 2024-06-22_..., 스크린샷 2026-04-06 ...)
function readNameDate(fileName) {
  const m = fileName.match(
    /(?<!\d)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/
  );
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(date)) return null;
  if (date > new Date()) return null; // 미래 날짜는 무시
  return date;
}

// ---------- 중복 판단 ----------

// 파일 내용으로 지문(해시) 만들기
function fileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// 두 파일 내용이 똑같은지 확인 (크기 먼저 보고, 같을 때만 지문 비교)
async function sameContent(a, b) {
  try {
    const sa = await fsp.stat(a);
    const sb = await fsp.stat(b);
    if (sa.size !== sb.size) return false;
    const [ha, hb] = await Promise.all([fileHash(a), fileHash(b)]);
    return ha === hb;
  } catch (e) {
    return false; // 읽기 실패하면 "다른 파일"로 보고 안전하게 보존
  }
}

// 파일이 들어갈 자리 찾기
// - 빈 자리면 → 이동
// - 자리가 차 있고 내용이 똑같으면(휴지통 모드) → 휴지통
// - 자리가 차 있고 내용이 다르면 → 번호 붙여서 다음 자리 찾기
async function findSlot(wanted, fromPath, usedMap, dupMode) {
  const dir = path.dirname(wanted);
  const ext = path.extname(wanted);
  const base = path.basename(wanted, ext);
  let n = 0;

  while (true) {
    const candidate = n === 0 ? wanted : path.join(dir, `${base}(${n})${ext}`);
    const key = candidate.toLowerCase();

    // 자기 자신이 이미 그 자리에 있으면 할 일 없음
    if (key === fromPath.toLowerCase()) return { action: 'skip' };

    let otherPath = null;
    if (usedMap.has(key)) otherPath = usedMap.get(key); // 이번 계획에서 이미 차지한 자리
    else if (fs.existsSync(candidate)) otherPath = candidate; // 이미 폴더에 있는 파일

    if (!otherPath) return { action: 'move', target: candidate }; // 빈 자리!

    if (dupMode === 'trash' && (await sameContent(fromPath, otherPath))) {
      return { action: 'trash', keep: candidate }; // 똑같은 파일 → 이쪽은 휴지통
    }
    n++; // 다른 파일이면 번호 붙여서 다음 자리
  }
}

// ---------- 안전 도우미 ----------

// 같은 이름이 있으면 파일명(1).jpg 처럼 번호 붙이기 (실행 직전 확인용)
function uniqueTarget(target) {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  let candidate = target;
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}(${n})${ext}`);
    n++;
  }
  return candidate;
}

// 파일 이동 (같은 드라이브면 이름 변경, 다른 드라이브면 복사 → 검증 → 원본 제거)
async function moveFile(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e; // 다른 드라이브가 아닌 진짜 에러
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL); // 덮어쓰기 금지
    const a = await fsp.stat(from);
    const b = await fsp.stat(to);
    if (a.size !== b.size) {
      await fsp.unlink(to); // 복사 실패한 파일만 정리
      throw new Error('복사 검증 실패 (원본은 그대로 있어요)');
    }
    await fsp.utimes(to, a.atime, a.mtime); // 수정일 유지
    await fsp.unlink(from); // 검증 끝났으니 원본 제거
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// ---------- 화면에서 오는 부탁들 ----------

// [부탁 1] 폴더 선택 창
ipcMain.handle('select-folder', async (event, title) => {
  const result = await dialog.showOpenDialog({
    title: title || '폴더 선택',
    properties: ['openDirectory'],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// [부탁 2] 정리 계획 만들기 (읽기만 함! 파일은 안 움직여요)
ipcMain.handle('make-plan', async (event, opts) => {
  const { source, includeSub, level } = opts;
  const dupMode = opts.dupMode === 'trash' ? 'trash' : 'keep'; // keep=번호 붙이기, trash=중복 휴지통
  const dest = opts.dest || source; // 대상 안 정하면 원본 폴더 안에 정리

  const names = includeSub
    ? fs.readdirSync(source, { recursive: true })
    : fs.readdirSync(source);

  const plan = [];
  const usedMap = new Map(); // 이번 계획에서 차지한 자리 → 그 파일의 원래 경로

  for (const file of names) {
    const ext = path.extname(file).toLowerCase();
    const isPhoto = PHOTO_EXT.includes(ext);
    const isVideo = VIDEO_EXT.includes(ext);
    if (!isPhoto && !isVideo) continue;

    const fullPath = path.join(source, file);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (e) {
      continue; // 읽을 수 없는 파일은 건너뛰기
    }
    if (!stat.isFile()) continue;

    const fileName = path.basename(file);

    // 날짜 정하기: 촬영일 → 파일명 → 수정일
    let date = null;
    let sourceType = '';
    if (isPhoto) {
      date = await readTakenDate(fullPath);
      if (date) sourceType = '촬영일';
    }
    if (!date) {
      date = readNameDate(fileName);
      if (date) sourceType = '파일명';
    }
    if (!date) {
      date = stat.mtime;
      sourceType = '수정일';
    }

    // 폴더 이름 만들기: 연\월 또는 연\월\일
    const y = String(date.getFullYear());
    const m = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const rel = level === 'day' ? path.join(y, m, d) : path.join(y, m);
    const wanted = path.join(dest, rel, fileName);

    // 들어갈 자리 찾기 (이동 / 휴지통 / 건너뛰기)
    const slot = await findSlot(wanted, fullPath, usedMap, dupMode);
    if (slot.action === 'skip') continue;
    if (slot.action === 'move') usedMap.set(slot.target.toLowerCase(), fullPath);

    plan.push({
      action: slot.action, // 'move' 또는 'trash'
      from: fullPath,
      to: slot.target || null,
      keep: slot.keep || null, // 휴지통일 때 "남길 파일" 위치
      name: slot.action === 'move' ? path.basename(slot.target) : fileName,
      type: isPhoto ? '사진' : '영상',
      rel,
      month: `${y}-${m}`,
      source: sourceType,
      renamed: slot.action === 'move' && path.basename(slot.target) !== fileName,
    });
  }

  lastPlan = plan; // 실행할 때 쓰려고 기억해두기

  // 요약 만들기
  const monthCount = {};
  const sourceCount = { 촬영일: 0, 파일명: 0, 수정일: 0 };
  let renamedCount = 0;
  let moveCount = 0;
  let trashCount = 0;
  for (const p of plan) {
    monthCount[p.month] = (monthCount[p.month] || 0) + 1;
    sourceCount[p.source]++;
    if (p.renamed) renamedCount++;
    if (p.action === 'trash') trashCount++;
    else moveCount++;
  }

  // 화면에는 앞 100개만 (휴지통 항목을 맨 위에 보여주기)
  const rows = plan
    .filter((p) => p.action === 'trash')
    .concat(plan.filter((p) => p.action !== 'trash'))
    .slice(0, 100);

  return { total: plan.length, moveCount, trashCount, monthCount, sourceCount, renamedCount, rows };
});

// [부탁 3] 계획대로 실행 (이동 + 중복은 휴지통)
ipcMain.handle('run-plan', async (event) => {
  if (!lastPlan || lastPlan.length === 0) {
    throw new Error('먼저 미리보기를 해주세요');
  }
  if (running) throw new Error('이미 실행 중이에요');
  running = true;

  const plan = lastPlan;
  const total = plan.length;
  const startTime = Date.now();
  let lastSend = 0;
  let moved = 0;
  let trashed = 0;
  let failed = 0;

  // 로그 파일 만들기
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const logPath = path.join(logDir, `log_${stamp}.txt`);
  fs.appendFileSync(logPath, `# 작업 시작 / 총 ${total}개\n# 시간\t상태\t원본\t대상(또는 남긴 파일)\n`, 'utf8');

  try {
    for (let i = 0; i < total; i++) {
      const p = plan[i];
      const time = new Date().toLocaleString('ko-KR');

      try {
        if (p.action === 'trash') {
          // 남길 파일이 실제로 있을 때만 휴지통으로!
          if (!p.keep || !fs.existsSync(p.keep)) {
            throw new Error('남길 파일을 찾지 못해서 휴지통 처리를 건너뛰었어요');
          }
          await shell.trashItem(p.from);
          trashed++;
          fs.appendFileSync(logPath, `${time}\t휴지통(중복)\t${p.from}\t${p.keep}\n`, 'utf8');
        } else {
          // 실행 직전에 한 번 더 겹침 확인 (덮어쓰기 방지)
          let target = p.to;
          if (fs.existsSync(target)) target = uniqueTarget(target);
          await moveFile(p.from, target);
          moved++;
          fs.appendFileSync(logPath, `${time}\t이동\t${p.from}\t${target}\n`, 'utf8');
        }
      } catch (e) {
        failed++;
        fs.appendFileSync(logPath, `${time}\t실패\t${p.from}\t${e.message}\n`, 'utf8');
      }

      // 진행 상황 화면에 보내기 (0.1초에 한 번만)
      const now = Date.now();
      if (now - lastSend > 100 || i === total - 1) {
        lastSend = now;
        const done = i + 1;
        const elapsedSec = (now - startTime) / 1000;
        const remainSec = (elapsedSec / done) * (total - done);
        event.sender.send('progress', {
          done,
          total,
          name: p.name,
          elapsedSec,
          remainSec,
        });
      }
    }
  } finally {
    running = false;
    lastPlan = null; // 다시 미리보기 해야 실행 가능
  }

  fs.appendFileSync(
    logPath,
    `# 작업 끝 / 이동 ${moved}개, 휴지통 ${trashed}개, 실패 ${failed}개\n`,
    'utf8'
  );
  return { moved, trashed, failed, logPath };
});

// [부탁 4] 로그 폴더 열기
ipcMain.handle('open-logs', async () => {
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  await shell.openPath(logDir);
});

// [부탁 5] 폴더를 탐색기로 열기
ipcMain.handle('open-folder', async (event, folderPath) => {
  if (!folderPath || !fs.existsSync(folderPath)) return false;
  await shell.openPath(folderPath);
  return true;
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

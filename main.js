const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
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

// ---------- 안전 도우미 ----------

// 같은 이름이 있으면 파일명(1).jpg 처럼 번호 붙이기 (절대 덮어쓰지 않음)
function uniqueTarget(target, usedSet) {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  let candidate = target;
  let n = 1;
  while (fs.existsSync(candidate) || usedSet.has(candidate.toLowerCase())) {
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
  const dest = opts.dest || source; // 대상 안 정하면 원본 폴더 안에 정리

  const names = includeSub
    ? fs.readdirSync(source, { recursive: true })
    : fs.readdirSync(source);

  const plan = [];
  const usedTargets = new Set(); // 이번 계획에서 이미 쓴 이름

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

    // 이미 알맞은 자리에 있으면 제외
    if (fullPath.toLowerCase() === wanted.toLowerCase()) continue;

    // 이름 겹치면 번호 붙이기
    const finalTarget = uniqueTarget(wanted, usedTargets);
    usedTargets.add(finalTarget.toLowerCase());

    plan.push({
      from: fullPath,
      to: finalTarget,
      name: path.basename(finalTarget),
      type: isPhoto ? '사진' : '영상',
      rel,
      month: `${y}-${m}`,
      source: sourceType,
      renamed: path.basename(finalTarget) !== fileName,
    });
  }

  lastPlan = plan; // 실행할 때 쓰려고 기억해두기

  // 화면에는 요약 + 앞 100개만 보내기 (가볍게)
  const monthCount = {};
  const sourceCount = { 촬영일: 0, 파일명: 0, 수정일: 0 };
  let renamedCount = 0;
  for (const p of plan) {
    monthCount[p.month] = (monthCount[p.month] || 0) + 1;
    sourceCount[p.source]++;
    if (p.renamed) renamedCount++;
  }

  return {
    total: plan.length,
    monthCount,
    sourceCount,
    renamedCount,
    rows: plan.slice(0, 100),
  };
});

// [부탁 3] 계획대로 실행 (이동만! 삭제 없음)
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
  let failed = 0;

  // 로그 파일 만들기
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const logPath = path.join(logDir, `log_${stamp}.txt`);
  fs.appendFileSync(logPath, `# 작업 시작 / 총 ${total}개\n# 시간\t상태\t원본\t대상\n`, 'utf8');

  try {
    for (let i = 0; i < total; i++) {
      const p = plan[i];
      const time = new Date().toLocaleString('ko-KR');

      try {
        // 실행 직전에 한 번 더 겹침 확인 (덮어쓰기 방지)
        let target = p.to;
        if (fs.existsSync(target)) target = uniqueTarget(target, new Set());

        await moveFile(p.from, target);
        moved++;
        fs.appendFileSync(logPath, `${time}\t이동\t${p.from}\t${target}\n`, 'utf8');
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

  fs.appendFileSync(logPath, `# 작업 끝 / 이동 ${moved}개, 실패 ${failed}개\n`, 'utf8');
  return { moved, failed, logPath };
});

// [부탁 4] 로그 폴더 열기
ipcMain.handle('open-logs', async () => {
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  await shell.openPath(logDir);
});

// [부탁 5] 폴더를 탐색기로 열기
ipcMain.handle('open-folder', async (event, folderPath) => {
  if (!folderPath || !fs.existsSync(folderPath)) return false; // 폴더가 없으면 안 열기
  await shell.openPath(folderPath);
  return true;
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

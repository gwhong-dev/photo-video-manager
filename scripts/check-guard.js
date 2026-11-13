// 파일 위치: scripts/check-guard.js
// 역할: 점검이 같은 PC 에서 여러 개 동시에 돌아도 안 부딪히고, 멈춰도 끝나게 하는 도우미
//   1) freePort: 실행할 때마다 비어 있는 디버깅 포트를 골라 줘요 (고정 포트를 쓰면 다른 세션 점검과 충돌)
//   2) 점검이 띄운 Electron 을 기억해 두었다가 끝날 때 · 제한 시간이 지났을 때 꺼요
//   3) startWatchdog: 점검 전체 제한 시간. 넘으면 자식 프로세스(Electron · exiftool)를 정리하고 실패로 끝내요

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');

// 운영체제에 빈 포트를 하나 받아서 알려줘요 (127.0.0.1 에서만 확인)
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// 점검이 띄운 Electron 목록 (끝나면 빠짐)
const tracked = new Set();
function trackChild(child) {
  tracked.add(child);
  child.once('exit', () => tracked.delete(child));
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch (e) { /* 이미 끝남 */ }
}

function killTracked() {
  for (const c of [...tracked]) killTree(c.pid);
  tracked.clear();
}

// 이 점검 프로세스의 자식 · 손자 프로세스 번호 목록 (Windows 만. 다른 세션의 점검은 부모가 달라서 안 건드려요)
function descendantPids(rootPid = process.pid) {
  if (process.platform !== 'win32') return [];
  const ps = `$all=Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId;$q=@(${rootPid});$out=@();while($q.Count){$p=$q[0];$q=$q[1..($q.Count)];foreach($c in $all|Where-Object{$_.ParentProcessId -eq $p}){$out+=$c.ProcessId;$q+=$c.ProcessId}};$out -join ','`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 20000 });
  return String(r.stdout || '').trim().split(',').map(Number).filter((n) => n > 0 && n !== rootPid);
}

function killDescendants() {
  const pids = descendantPids();
  for (const pid of pids.reverse()) killTree(pid);
  return pids.length;
}

// 제한 시간(분) 안에 안 끝나면 onTimeout 뒤 자식을 정리하고 종료 코드 1 로 끝내요
//   PVM_CHECK_TIMEOUT_MIN 환경변수로 바꿀 수 있어요 (기본 40분)
function startWatchdog(onTimeout) {
  const min = Number(process.env.PVM_CHECK_TIMEOUT_MIN) || 40;
  const timer = setTimeout(() => {
    console.log(`\n❌ 점검이 제한 시간(${min}분) 안에 끝나지 않아서 멈춰요. 남은 Electron · exiftool 을 정리합니다`);
    try { if (onTimeout) onTimeout(); } catch (e) { /* 무시 */ }
    killTracked();
    const n = killDescendants();
    console.log(`  정리한 자식 프로세스 ${n}개`);
    process.exit(1);
  }, min * 60 * 1000);
  timer.unref();
  return () => clearTimeout(timer);
}

// ---------- 점검 임시 폴더 정리 (영구 삭제 예외: 점검이 만든 복사본만) ----------
// 같은 PC 에서 다른 세션의 점검이 돌고 있을 수 있어서, 남의 폴더는 일정 시간(staleMs, 기본 3시간)이 지난 것만 지워요
//   (점검 전체 제한 시간이 40분이라, 3시간 넘은 폴더는 끝났거나 죽은 점검의 것)
const TEMP_PREFIX = 'pvm-check-';
const STALE_MS = 3 * 60 * 60 * 1000;
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// 지워도 되는 폴더인지 코드로 확인 (tmpRoot 바로 안 + 이름이 pvm-check- + 링크 아닌 진짜 폴더)
function isCheckTempDir(dir, tmpRoot = os.tmpdir()) {
  const full = path.resolve(dir);
  if (!sameDir(path.dirname(full), tmpRoot)) return false;
  if (!path.basename(full).startsWith(TEMP_PREFIX)) return false;
  try {
    const st = fs.lstatSync(full);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch (e) {
    return false;
  }
}

// 이번 실행 폴더(current): 통과면 지우고 실패면 남겨요. 다른 폴더: 오래된 것만 지워요
function cleanupTempDirs(current, failed, { tmpRoot = os.tmpdir(), staleMs = STALE_MS, now = Date.now(), log = console.log } = {}) {
  const removed = [];
  for (const name of fs.readdirSync(tmpRoot)) {
    const dir = path.join(tmpRoot, name);
    if (!isCheckTempDir(dir, tmpRoot)) continue;
    const mine = sameDir(dir, current);
    if (mine && failed) continue; // 실패한 이번 폴더는 남김
    if (!mine) {
      let age = 0;
      try { age = now - fs.statSync(dir).mtimeMs; } catch (e) { continue; }
      if (age < staleMs) continue; // 다른 세션이 지금 쓰는 중일 수 있음
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch (e) {
      log(`  ⚠️ 임시 폴더를 못 지웠어요: ${dir} (${e.message})`);
    }
  }
  return removed;
}

// 점검이 어떻게 끝나든 남은 Electron 은 끄기
process.on('exit', killTracked);

module.exports = { cleanupTempDirs, isCheckTempDir, TEMP_PREFIX, freePort, trackChild, killTracked, killDescendants, startWatchdog };

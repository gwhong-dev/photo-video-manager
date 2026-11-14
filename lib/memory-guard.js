// 파일 위치: lib/memory-guard.js
// 역할: 가져오기 실행 중 PC 메모리 지키기
//   2026-11-14 밤: 약 8만 개를 돌리는 동안 Windows 탐색기(explorer.exe)가 30GB 까지 커져 가상 메모리가 바닥났고,
//   Claude 앱 · 크롬 · Windows 서비스가 줄줄이 죽은 뒤 PC 가 멈췄어요 (원인 기록 docs/decisions/2026-11-14-overnight-memory-crash.md)
//   → 실행하는 동안 1분마다 "남은 가상 메모리"와 "탐색기 메모리"를 재고, 위험하면 일시정지하게 알려 줘요
//
// 모양: createMemoryGuard({ sample, intervalMs, minFreeGB, maxExplorerGB, logger })
//        → { start(), stop(), check() → Promise<상태>, low() → 위험 이유 글 또는 null, last() → 마지막 측정 }
//   logger: 로거 또는 로거를 돌려주는 함수 (main.js 는 앱이 준비된 뒤에 로거가 생겨서 함수로 넘겨요)
//   sample(): Promise<{ freeVirtualGB, explorerGB }> — 기본은 PowerShell 로 재요 (점검 때는 가짜 함수)

const { runCmd } = require('./tools');

const MIN_FREE_GB = 3; // 남은 가상 메모리가 이보다 적으면 위험
const MAX_EXPLORER_GB = 4; // 탐색기가 이보다 크면 위험 (평소 0.2~0.3GB)
const INTERVAL_MS = 60 * 1000;

// Windows 에서 남은 가상 메모리(커밋)와 탐색기 메모리 재기. 못 재면 null (그때는 막지 않아요)
async function sampleWindows() {
  if (process.platform !== 'win32') return null;
  const ps =
    "$e=(Get-Process explorer -ErrorAction SilentlyContinue | Measure-Object PrivateMemorySize64 -Sum).Sum; " +
    "$o=Get-CimInstance Win32_OperatingSystem; [string]$o.FreeVirtualMemory + ' ' + [string][int64]$e";
  try {
    const r = await runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeoutMs: 20000 });
    if (!r || r.timedOut || r.code !== 0) return null; // 시간 초과 · 오류면 못 잰 것 → 막지 않아요
    const parts = r.stdout.trim().split(/\s+/);
    if (parts.length !== 2) return null; // 숫자 2개(남은 메모리, 탐색기)가 아니면 못 잰 것
    const [freeKB, explorerBytes] = parts.map(Number);
    if (!Number.isFinite(freeKB) || freeKB <= 0 || !Number.isFinite(explorerBytes)) return null;
    return { freeVirtualGB: freeKB / 1024 / 1024, explorerGB: explorerBytes / 1024 ** 3 };
  } catch (e) {
    return null;
  }
}

// 측정값 → 위험 이유 (괜찮으면 null)
function lowReason(m, { minFreeGB = MIN_FREE_GB, maxExplorerGB = MAX_EXPLORER_GB } = {}) {
  if (!m) return null;
  const parts = [];
  if (m.freeVirtualGB < minFreeGB) parts.push(`남은 가상 메모리 ${m.freeVirtualGB.toFixed(1)}GB`);
  if (m.explorerGB > maxExplorerGB) parts.push(`Windows 탐색기 ${m.explorerGB.toFixed(1)}GB`);
  return parts.length ? parts.join(', ') : null;
}

// 사용자에게 보여 줄 안내 글 (what: 'run' = 실행을 멈춤, 'clean' = 원본 정리를 시작하지 않음)
function lowMessage(reason, what = 'run') {
  const head = what === 'clean' ? 'PC 메모리가 부족해서 원본 정리를 시작하지 않았어요' : 'PC 메모리가 부족해서 멈췄어요';
  const tail = what === 'clean'
    ? '그대로 두면 PC 가 멈출 수 있어요. 메모리가 돌아오면 "원본 정리"를 다시 눌러 주세요.'
    : '그대로 두면 PC 가 멈출 수 있어서 원본 정리도 하지 않았어요.';
  return (
    `${head} (${reason}).\n` +
    `열려 있는 탐색기 창과 폴더 속성 창을 닫거나, 작업 관리자에서 "Windows 탐색기"를 다시 시작한 뒤 이어서 실행해 주세요.\n` +
    tail
  );
}

function createMemoryGuard({ sample = sampleWindows, intervalMs = INTERVAL_MS, minFreeGB, maxExplorerGB, logger } = {}) {
  let timer = null;
  let lastM = null;
  let reason = null;
  const opts = { minFreeGB, maxExplorerGB };
  const check = async () => {
    lastM = await sample();
    const r = lowReason(lastM, opts);
    const lg = typeof logger === 'function' ? logger() : logger;
    if (r && !reason && lg) {
      try { lg.newLog('memory', `# 메모리 경고 / ${new Date().toLocaleString('ko-KR')}\n# ${r}`); } catch (e) { /* 로그 실패는 무시 */ }
    }
    reason = r;
    return { measured: lastM, low: reason };
  };
  return {
    start() {
      if (timer) return;
      reason = null;
      timer = setInterval(() => { check().catch(() => {}); }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    check,
    low: () => reason,
    last: () => lastM,
  };
}

module.exports = { createMemoryGuard, lowReason, lowMessage, sampleWindows, MIN_FREE_GB, MAX_EXPLORER_GB };

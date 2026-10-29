// 파일 위치: lib/runner.js
// 역할: 계획 로그 쓰기 + 실행(다음 N개 처리)
//   main.js에 있던 코드를 옮겨 왔어요 → 앱 창 없이도 점검할 수 있어요.

const fs = require('fs');
const path = require('path');
const { processItem } = require('./processor');
const { jobStats } = require('./job');
const { NO_DATE_DIR } = require('./planner');
const { now } = require('./logger');

// 파일 1개의 참고 정보 (로그용)
function extraInfo(it) {
  const parts = [`날짜출처:${it.dateFrom}`];
  if (it.refDate) parts.push(`참고(수정날짜):${it.refDate}`);
  if (it.model) parts.push(`기기:${it.model}`);
  if (it.gps) parts.push(`GPS:${it.gps}`);
  return parts.join(' / ');
}

// 계획 로그 (날짜없음 참고 날짜, 중복, 확인 필요 목록) → 로그 경로
function writePlanLog(job, logger) {
  const s = job.stats;
  const log = logger.newLog(
    'plan',
    `# 계획 / ${now()}\n# 가져올 폴더: ${job.source}\n# 백업 폴더: ${job.backupRoot}\n` +
      `# 처리 예정 ${s.todo}개 (HEIC→JPG ${s.heic}, MOV→MP4 ${s.mov}, 이름만 ${s.copy}) / 날짜없음 ${s.noDate} / ` +
      `중복 ${s.dup} (확인 필요 ${s.check}) / _번호 ${s.renamed} / 이미 정리됨 ${s.skip}\n` +
      `# 아래는 주의할 파일만 적었어요 (날짜없음, 중복, 번호 붙음)`
  );
  log.write('# 상태\t원본\t갈 위치\t메모\t참고 정보');
  for (const it of job.items) {
    if (it.status === 'todo' && !it.renamed && it.relDir !== NO_DATE_DIR) continue; // 평범한 건 생략
    const tag = it.relDir === NO_DATE_DIR ? '날짜없음' : it.check ? '확인필요' : it.status === 'dup' ? '중복' : it.status === 'skip' ? '이미정리' : '번호붙음';
    log.write(`${tag}\t${it.src}\t${it.dupOf || it.dest}\t${it.note}\t${extraInfo(it)}`);
  }
  return log.path;
}

// 이번 회차에 처리할 파일들 (앞에서부터 N개)
function nextTodo(job, batchSize) {
  const n = Math.max(1, Number(batchSize) || 2000);
  return job.items.filter((it) => it.status === 'todo').slice(0, n);
}

// 실행 전 백업 폴더 남은 공간 확인
//   예상 용량: HEIC→JPG는 파일이 커져서 원본 × 2, 나머지는 원본 크기 그대로
//   남은 공간 < 예상 용량 → ok=false (실행 안 함) / 실행 뒤 사용률 80% 넘음 → 경고
//   statfs: 디스크 정보 읽는 함수 (점검 때는 가짜 함수로 바꿔 끼워요)
function checkSpace(items, backupRoot, statfs = fs.statfsSync) {
  const estimateBytes = items.reduce((a, it) => a + (it.size || 0) * (it.kind === 'heic2jpg' ? 2 : 1), 0);
  let s;
  try {
    s = statfs(backupRoot);
  } catch (e) {
    return { ok: true, estimateBytes, freeBytes: null, usedRatioAfter: null, warning: '백업 폴더의 남은 공간을 확인하지 못했어요' };
  }
  const total = s.blocks * s.bsize;
  const freeBytes = s.bavail * s.bsize;
  const usedRatioAfter = total ? (total - freeBytes + estimateBytes) / total : 0;
  const gb = (b) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + 'GB' : Math.ceil(b / 1024 ** 2) + 'MB');
  if (freeBytes < estimateBytes) {
    return { ok: false, estimateBytes, freeBytes, usedRatioAfter, warning: `백업 폴더 공간이 부족해요 (필요 약 ${gb(estimateBytes)}, 남은 공간 ${gb(freeBytes)})` };
  }
  const warning = usedRatioAfter > 0.8 ? `이번 회차가 끝나면 백업 드라이브가 약 ${Math.round(usedRatioAfter * 100)}% 차요 (80% 넘음)` : null;
  return { ok: true, estimateBytes, freeBytes, usedRatioAfter, warning };
}

// 실행: 다음 N개 처리
//   shouldPause() 가 true가 되면 지금 파일까지만 하고 멈춰요.
//   남은 공간이 모자라면 하나도 처리하지 않고 stopped에 이유를 담아 돌려줘요.
async function runBatch({ job, store, batchSize, ctx, logger, statfs, shouldPause = () => false, onProgress = () => {} }) {
  const todo = nextTodo(job, batchSize);

  const space = checkSpace(todo, job.backupRoot, statfs);
  if (!space.ok) {
    const log = logger.newLog('run', `# 실행 / ${now()} / 이번 회차 ${todo.length}개\n# ⛔ 실행 안 함: ${space.warning}`);
    return { done: 0, dup: 0, fail: 0, paused: false, handled: 0, stopped: space.warning, spaceWarning: null, logPath: log.path };
  }

  const log = logger.newLog('run', `# 실행 / ${now()} / 이번 회차 ${todo.length}개${space.warning ? `\n# ⚠️ ${space.warning}` : ''}\n# 시간\t상태\t원본\t결과\t메모\t참고 정보`);
  const start = Date.now();
  let lastSend = 0;
  const count = { done: 0, dup: 0, fail: 0 };
  let handled = 0;
  let paused = false;

  for (const it of todo) {
    if (shouldPause()) {
      paused = true;
      break;
    }
    try {
      // 진짜 이름으로 바꾸기 직전에 "여기로 옮길 예정"을 작업 기록에 먼저 적어요 (바꾼 직후 꺼져도 이어할 때 알아봄)
      const onBeforeRename = (info) => store.mark(job, it.i, { pending: info });
      const r = await processItem(it, { ...ctx, onBeforeRename });
      store.mark(job, it.i, { status: r.status, finalPath: r.finalPath, resultHash: r.resultHash || null, pending: null, note: r.note || it.note });
      count[r.status]++;
      log.write(`${now()}\t${r.status === 'done' ? '완료' : '중복'}\t${it.src}\t${r.finalPath}\t${r.note || ''}\t${extraInfo(it)}`);
    } catch (err) {
      store.mark(job, it.i, { status: 'fail', note: err.message });
      count.fail++;
      log.write(`${now()}\t실패\t${it.src}\t-\t${err.message}\t${extraInfo(it)}`);
    }
    handled++;

    // 진행 상황 알리기 (0.2초에 한 번)
    const t = Date.now();
    if (t - lastSend > 200 || handled === todo.length) {
      lastSend = t;
      const elapsedSec = (t - start) / 1000;
      onProgress({
        done: handled,
        total: todo.length,
        name: path.basename(it.src),
        elapsedSec,
        remainSec: (elapsedSec / handled) * (todo.length - handled),
        ...count,
      });
    }
  }

  const stats = jobStats(job);
  log.write(`# 끝 / 완료 ${count.done}, 중복 ${count.dup}, 실패 ${count.fail} / 남은 작업 ${stats.todo}개${paused ? ' (일시정지)' : ''}`);
  return { ...count, paused, handled, stopped: null, spaceWarning: space.warning, logPath: log.path };
}

module.exports = { extraInfo, writePlanLog, nextTodo, checkSpace, runBatch };

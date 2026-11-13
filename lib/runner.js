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

// 실패한 파일을 다시 시도할 수 있게 "대기"로 되돌리기
//   다시 시도 직전에, 그 파일이 이전 실패로 남겼을 수 있는 임시 파일(.__tmp__)만 지워요.
//   지우는 대상은 아주 좁게: 그 항목의 "갈 위치"에서 만든 임시 이름 2가지뿐이고,
//   백업 폴더 안에 있어야 하고, 일반 파일이어야 하고, 어느 항목의 원본도 아니어야 해요.
//   원본 · 정상 결과 파일은 이름이 달라서 대상이 될 수 없어요.
const TMP_NAME = /\.__tmp__(\.[^.\\/]*)?(_exiftool_tmp)?$/;

function tmpCandidates(it) {
  if (!it.dest) return [];
  const ext = path.extname(it.dest);
  const tmp = path.join(path.dirname(it.dest), path.basename(it.dest, ext) + '.__tmp__' + ext);
  return [tmp, tmp + '_exiftool_tmp'];
}

function requeueFailed(job, store) {
  const root = path.resolve(job.backupRoot) + path.sep;
  const srcs = new Set(job.items.map((x) => path.resolve(x.src).toLowerCase()));
  let requeued = 0;
  let cleaned = 0;
  for (const it of job.items) {
    if (it.status !== 'fail') continue;
    for (const tmp of tmpCandidates(it)) {
      const abs = path.resolve(tmp);
      if (!abs.toLowerCase().startsWith(root.toLowerCase())) continue; // 백업 폴더 밖은 안 건드림
      if (!TMP_NAME.test(path.basename(abs))) continue; // 임시 이름이 아니면 안 건드림
      if (srcs.has(abs.toLowerCase())) continue; // 원본이면 안 건드림
      try {
        if (!fs.lstatSync(abs).isFile()) continue; // 일반 파일만 (폴더 · 바로가기 제외)
        fs.unlinkSync(abs);
        cleaned++;
      } catch (e) {
        // 없으면 지울 것도 없어요
      }
    }
    store.mark(job, it.i, { status: 'todo', pending: null, note: `다시 시도 (이전 실패: ${it.note || '이유 없음'})` });
    requeued++;
  }
  return { requeued, cleaned };
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

// 동시에 처리할 파일 수 (기본). 큰 파일(영상)은 디스크를 오래 붙잡아서 한 번에 하나씩만 해요
const DEFAULT_CONCURRENCY = 4;
const BIG_FILE_BYTES = 100 * 1024 * 1024; // 100MB 넘으면 "큰 파일"

// 차례 기다리기 (한 번에 하나만 들어가는 문)
function makeGate() {
  let tail = Promise.resolve();
  return () => {
    let open;
    const wait = tail;
    tail = new Promise((r) => (open = r));
    return wait.then(() => open);
  };
}

// 실행: 다음 N개 처리
//   concurrency 개를 동시에 처리해요 (1이면 예전처럼 하나씩). 큰 파일은 한 번에 하나만
//   shouldPause() 가 true가 되면 지금 처리 중인 파일들까지만 하고 멈춰요.
//   남은 공간이 모자라면 하나도 처리하지 않고 stopped에 이유를 담아 돌려줘요.
async function runBatch({ job, store, batchSize, ctx, logger, statfs, shouldPause = () => false, onProgress = () => {}, concurrency = DEFAULT_CONCURRENCY }) {
  const todo = nextTodo(job, batchSize);

  const space = checkSpace(todo, job.backupRoot, statfs);
  if (!space.ok) {
    const log = logger.newLog('run', `# 실행 / ${now()} / 이번 회차 ${todo.length}개\n# ⛔ 실행 안 함: ${space.warning}`);
    return { done: 0, dup: 0, fail: 0, broken: 0, paused: false, handled: 0, stopped: space.warning, spaceWarning: null, logPath: log.path };
  }

  const lanes = Math.max(1, Math.min(Number(concurrency) || 1, todo.length || 1));
  const log = logger.newLog('run', `# 실행 / ${now()} / 이번 회차 ${todo.length}개 / 동시 처리 ${lanes}개${space.warning ? `\n# ⚠️ ${space.warning}` : ''}\n# 시간\t상태\t원본\t결과\t메모\t참고 정보`);
  const start = Date.now();
  let lastSend = 0;
  const count = { done: 0, dup: 0, fail: 0, broken: 0 };
  const LOG_LABEL = { done: '완료', dup: '중복', broken: '재생불가' };
  let handled = 0;
  let paused = false;

  // 동시에 처리하는 파일끼리 같은 이름 · 같은 폴더를 알아보게 (lib/processor.js 의 claim · release · dirShared)
  const claimed = new Set();
  const busyDirs = new Map(); // 폴더 → 지금 그 폴더에 쓰는 파일 수
  const low = (p) => path.resolve(p).toLowerCase();
  const shared = {
    claim: (p) => {
      const k = low(p);
      if (claimed.has(k)) return false;
      claimed.add(k);
      return true;
    },
    release: (list) => list.forEach((p) => claimed.delete(low(p))),
    dirShared: (dir) => (busyDirs.get(low(dir)) || 0) > 1,
  };
  const bigGate = makeGate();

  let next = 0;
  // 예상 밖 오류(작업 기록 쓰기 실패 등)가 나면: 다른 일꾼도 새 파일을 집지 않고, 처리 중인 파일이 다 끝난 뒤 오류를 알려요
  //   (먼저 알리면 "실행 중"이 풀려서, 다시 실행한 쪽과 남은 일꾼이 같은 파일을 같이 처리할 수 있어요)
  let fatal = null;
  const worker = async () => {
    try {
      await work();
    } catch (e) {
      if (!fatal) fatal = e;
    }
  };
  const work = async () => {
    for (;;) {
      if (fatal || next >= todo.length) return;
      if (shouldPause()) {
        paused = true;
        return;
      }
      const it = todo[next++];
      const dirKey = low(path.dirname(it.dest || it.src));
      busyDirs.set(dirKey, (busyDirs.get(dirKey) || 0) + 1);
      const leave = lanes > 1 && (it.size || 0) >= BIG_FILE_BYTES ? await bigGate() : null;
      // 큰 파일 차례를 기다리는 동안 일시정지 · 오류가 생겼으면 시작하지 않고 돌아가요 (기록 전이라 대기로 남아요)
      if (leave && (fatal || shouldPause())) {
        leave();
        if (!fatal) paused = true;
        const left = busyDirs.get(dirKey) - 1;
        if (left > 0) busyDirs.set(dirKey, left);
        else busyDirs.delete(dirKey);
        return;
      }
      try {
        // 진짜 이름으로 바꾸기 직전에 "여기로 옮길 예정"을 작업 기록에 먼저 적어요 (바꾼 직후 꺼져도 이어할 때 알아봄)
        const onBeforeRename = (info) => store.mark(job, it.i, { pending: info });
        const r = await processItem(it, { ...ctx, ...(lanes > 1 ? shared : {}), onBeforeRename });
        store.mark(job, it.i, { status: r.status, finalPath: r.finalPath, resultHash: r.resultHash || null, pending: null, note: r.note || it.note });
        count[r.status]++;
        log.write(`${now()}\t${LOG_LABEL[r.status]}\t${it.src}\t${r.finalPath || '-'}\t${r.note || ''}\t${extraInfo(it)}`);
      } catch (err) {
        store.mark(job, it.i, { status: 'fail', note: err.message });
        count.fail++;
        log.write(`${now()}\t실패\t${it.src}\t-\t${err.message}\t${extraInfo(it)}`);
      } finally {
        if (leave) leave();
        const left = busyDirs.get(dirKey) - 1;
        if (left > 0) busyDirs.set(dirKey, left);
        else busyDirs.delete(dirKey);
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
  };
  await Promise.all(Array.from({ length: lanes }, worker));
  if (fatal) throw fatal;

  const stats = jobStats(job);
  const sec = Math.round((Date.now() - start) / 1000);
  log.write(`# 끝 / 완료 ${count.done}, 중복 ${count.dup}, 실패 ${count.fail}, 재생불가 ${count.broken} / 남은 작업 ${stats.todo}개 / 걸린 시간 ${sec}초${paused ? ' (일시정지)' : ''}`);
  return { ...count, paused, handled, stopped: null, spaceWarning: space.warning, logPath: log.path };
}

module.exports = { extraInfo, writePlanLog, nextTodo, requeueFailed, checkSpace, runBatch, DEFAULT_CONCURRENCY, BIG_FILE_BYTES };

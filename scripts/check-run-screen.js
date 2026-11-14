// 파일 위치: scripts/check-run-screen.js
// 역할: 실행 화면 안내 점검 (55). scripts/check.js 의 ITEMS 끝에 붙어요
//   크기 기준 남은 시간, 진행 알림의 크기 · 속도 값을 확인해요 (2026-11-14 실사용: 큰 영상이 몰린 묶음에서 남은 시간이 4배로 보임)
//   ⚠️ 샘플은 임시 폴더 복사본으로만 써요
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const { sub } = require('./check-gallery');
const { makePlan } = require('../lib/planner');
const { JobStore } = require('../lib/job');
const { createLogger } = require('../lib/logger');
const runner = require('../lib/runner');
const cleaner = require('../lib/cleaner');

const AUTO = path.join(__dirname, '..', 'test', 'samples', 'auto');

const items = [
  {
    no: 55,
    name: '실행 화면 안내 (크기 기준 남은 시간)',
    async run(env) {
      const out = [];
      let ranJob = null; // 55b 에서 끝까지 실행한 작업 (55f 에서 다시 써요)

      // 55a 남은 시간: 20초 전에는 개수 기준, 그 뒤에는 처리한 크기 기준
      //   예) 400개 중 100개 처리, 크기는 200GB 중 40GB, 12분 지남 → 개수 기준 36분, 크기 기준 48분
      const early = runner.remainOf(10, 100, 400, 40e9, 200e9);
      const late = runner.remainOf(720, 100, 400, 40e9, 200e9);
      const noSize = runner.remainOf(720, 100, 400, 0, 0);
      const by = [runner.remainBy(10, 40e9, 200e9), runner.remainBy(720, 40e9, 200e9), runner.remainBy(720, 0, 0)].join(',');
      out.push(sub('55a 남은 시간: 처음 20초는 개수 기준, 그 뒤는 크기 기준, 크기를 모르면 개수 기준 (표시 이름도 맞음)', Math.round(early) === 30 && Math.round(late) === 2880 && Math.round(noSize) === 2160 && by === 'count,bytes,count', `${Math.round(early)} / ${Math.round(late)} / ${Math.round(noSize)}초, ${by}`));

      // 55b 실행 진행 알림에 처리한 크기 · 전체 크기 · 속도가 들어 있음 (마지막 알림은 처리 크기 = 전체 크기)
      {
        const root = path.join(env.tmp, 'run-screen');
        const source = path.join(root, 'source');
        fs.cpSync(AUTO, source, { recursive: true, preserveTimestamps: true });
        const backupRoot = path.join(root, 'backup');
        fs.mkdirSync(backupRoot, { recursive: true });
        const logger = createLogger(path.join(root, 'logs'));
        const plan = await makePlan({ source, backupRoot, includeSub: true }, env.et);
        const store = new JobStore(path.join(root, 'jobs'));
        const job = store.create(plan);
        const total = job.items.filter((it) => it.status === 'todo').reduce((n, it) => n + (it.size || 0), 0);
        const seen = [];
        await runner.runBatch({ job, store, batchSize: 100000, ctx: env.ctx, logger, onProgress: (p) => seen.push(p) });
        ranJob = job;
        const last = seen[seen.length - 1] || {};
        const ok = seen.length > 0 && last.bytesTotal === total && last.bytesDone === total && last.bytesPerSec >= 0 && seen.every((p) => typeof p.bytesDone === 'number');
        out.push(sub('55b 진행 알림에 처리한 크기 · 전체 크기 · 속도', ok, `알림 ${seen.length}번, 마지막 ${last.bytesDone} / ${last.bytesTotal} (전체 ${total})`));
      }

      // 55c 화면 코드에 일시정지 때 원본 확인을 건너뛰는 길과 폴더가 바뀌었을 때 안내가 있음 (화면 동작은 PR 앱 확인에서)
      {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const ok = /if \(r\.paused \|\| pauseClicked\) \{[\s\S]{0,400}\} else await offerTrash\(r\.job\)/.test(html) && /pauseClicked = true;/.test(html) && /id="folderNote"/.test(html) && /function renderFolderNote\(\)/.test(html) && /원본 정리만 남음/.test(html);
        out.push(sub('55c 화면: 일시정지 때 원본 확인 건너뜀, 폴더가 다르면 안내 자리', ok));
      }

      // 55d 회차가 끝나면 원본 확인을 바로 하지 않고 먼저 물어봄, "실패 다시 시도"는 되돌린 개수만 처리 (2026-11-15 실사용)
      {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const offer = (html.match(/async function offerTrash\(j\) \{[\s\S]*?\n    \}/) || [''])[0];
        const ask = /if \(!j \|\| !j\.deletable\) return;/.test(offer) && /if \(ok\) await askTrash\(\);/.test(offer) && /confirm\(/.test(offer);
        const retry = /await runBatch\(r\.requeued\);/.test(html) && /async function runBatch\(n = batchSize\(\)\)/.test(html) && /api\.runBatch\(n\)/.test(html) && /api\.spaceInfo\(n\)/.test(html);
        // 회차 끝에 askTrash 를 바로 부르는 곳이 없어야 해요 (원본만 남은 작업 · 원본 정리 버튼은 직접 고른 것이라 그대로)
        const direct = (html.match(/await askTrash\(\)/g) || []).length;
        out.push(sub('55d 화면: 회차 끝 원본 확인은 먼저 물어봄, 실패 다시 시도는 되돌린 개수만', ask && retry && direct === 3, `물어봄 ${ask}, 다시 시도 ${retry}, askTrash 직접 호출 ${direct}곳`));
      }

      // 55e 실제 실행: 앞쪽 2개가 실패로 남은 작업에서 "실패 다시 시도"(되돌린 개수만큼 실행) → 그 2개만 처리되고 나머지 대기는 그대로
      {
        const root = path.join(env.tmp, 'retry-only');
        const source = path.join(root, 'source');
        fs.cpSync(AUTO, source, { recursive: true, preserveTimestamps: true });
        const backupRoot = path.join(root, 'backup');
        fs.mkdirSync(backupRoot, { recursive: true });
        const logger = createLogger(path.join(root, 'logs'));
        const plan = await makePlan({ source, backupRoot, includeSub: true }, env.et);
        const store = new JobStore(path.join(root, 'jobs'));
        const job = store.create(plan);
        // 첫 회차 3개 처리 → 그중 앞 2개를 실패로 바꿔 둠 (실패한 회차를 흉내)
        await runner.runBatch({ job, store, batchSize: 3, ctx: env.ctx, logger });
        const first = job.items.filter((it) => it.status !== 'todo').map((it) => it.i).sort((a, b) => a - b);
        const failed = first.slice(0, 2);
        for (const i of failed) store.mark(job, i, { status: 'fail', note: '시험 실패' });
        const todoBefore = job.items.filter((it) => it.status === 'todo').length;
        const rq = runner.requeueFailed(job, store);
        await runner.runBatch({ job, store, batchSize: rq.requeued, ctx: env.ctx, logger });
        const todoAfter = job.items.filter((it) => it.status === 'todo').length;
        const retried = failed.every((i) => job.items[i].status !== 'todo' && job.items[i].status !== 'fail');
        out.push(sub('55e 실패 2개 다시 시도 → 그 2개만 처리, 다른 대기 파일은 그대로', rq.requeued === 2 && retried && todoAfter === todoBefore && todoBefore > 0, `되돌림 ${rq.requeued}, 다시 처리 ${retried}, 대기 ${todoBefore} → ${todoAfter}`));
      }

      // 55f 정리할 원본 세기를 기다리지 않는 방식으로 (2026-11-15 실사용: 1만 9천 개에서 창이 4분 "응답 없음")
      //   같은 결과 · 그만두기 · 세는 동안 창(이벤트 루프)이 멈추지 않음 · 화면 연결 확인
      {
        const job = ranJob;
        const syncIds = cleaner.cleanCandidates(job).map((it) => it.i).join(',');
        const asyncIds = (await cleaner.cleanCandidatesAsync(job)).map((it) => it.i).join(',');
        const same = !!syncIds && syncIds === asyncIds;
        const stopped = await cleaner.cleanCandidatesAsync(job, { shouldStop: () => true });
        // 완료 항목을 4천 번 복사한 큰 작업: 세는 동안 0.02초 타이머가 얼마나 늦어지는지
        const done = job.items.filter((it) => it.status === 'done');
        const big = { items: [] };
        for (let k = 0; k < 4000; k++) for (const it of done) big.items.push({ ...it, i: big.items.length });
        let maxLag = 0;
        let last = Date.now();
        const timer = setInterval(() => { const t = Date.now(); maxLag = Math.max(maxLag, t - last - 20); last = t; }, 20);
        const bigList = await cleaner.cleanCandidatesAsync(big);
        clearInterval(timer);
        const one = done.filter((it) => cleaner.cleanCandidates({ items: [it] }).length).length;
        const lagOk = maxLag < 1000 && one > 0 && bigList.length === one * 4000;
        const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
        const cleanerSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cleaner.js'), 'utf8');
        const wired = !/[^.\w]cleanCandidates\(/.test(main) && /sendJobInfoLater\(\);[^\n]*\n\s*return \{ settings, tools, job: infoOf\(job, null\) \}/.test(main) &&
          /onJobInfo: \(cb\) => subscribe\('job-info', cb\)/.test(preload) && /api\.onJobInfo\(/.test(html) && /원본 세는 중/.test(html) && /await cleanCandidatesAsync\(job\)/.test(cleanerSrc);
        out.push(sub('55f 정리할 원본 세기: 같은 결과, 그만두기, 세는 동안 창이 멈추지 않음, 처음 켤 때 기다리지 않음', same && stopped === null && lagOk && wired,
          `같음 ${same}, 그만둠 ${stopped === null}, 큰 작업 ${bigList.length}개 · 최대 지연 ${maxLag}ms, 연결 ${wired}`));
      }
      return out;
    },
  },
];

module.exports = { items };

// 이 파일만 돌릴 때: node scripts/check-run-screen.js
if (require.main === module) {
  const os = require('os');
  const { ExifTool } = require('../lib/exiftool');
  const { detectTools } = require('../lib/tools');
  (async () => {
    const tools = await detectTools({}, path.join(__dirname, '..'));
    const et = new ExifTool(tools.exiftool.path);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvm-check-run-screen-'));
    const env = { tmp, tools, et, ctx: { et, magick: tools.magick.path, ffmpeg: tools.ffmpeg.path, ffprobe: tools.ffprobe.path } };
    let failed = 0;
    try {
      for (const s of await items[0].run(env)) {
        if (s.status === 'fail') failed++;
        console.log(`${s.status === 'ok' ? '✅' : '❌'} ${s.label}${s.detail ? ' — ' + s.detail : ''}`);
      }
    } finally {
      et.close();
      if (!failed) fs.rmSync(tmp, { recursive: true, force: true });
      else console.log('남긴 폴더: ' + tmp);
    }
    process.exit(failed ? 1 : 0);
  })();
}

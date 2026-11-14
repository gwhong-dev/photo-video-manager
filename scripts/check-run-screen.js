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

const AUTO = path.join(__dirname, '..', 'test', 'samples', 'auto');

const items = [
  {
    no: 55,
    name: '실행 화면 안내 (크기 기준 남은 시간)',
    async run(env) {
      const out = [];

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
        const last = seen[seen.length - 1] || {};
        const ok = seen.length > 0 && last.bytesTotal === total && last.bytesDone === total && last.bytesPerSec >= 0 && seen.every((p) => typeof p.bytesDone === 'number');
        out.push(sub('55b 진행 알림에 처리한 크기 · 전체 크기 · 속도', ok, `알림 ${seen.length}번, 마지막 ${last.bytesDone} / ${last.bytesTotal} (전체 ${total})`));
      }

      // 55c 화면 코드에 일시정지 때 원본 확인을 건너뛰는 길과 폴더가 바뀌었을 때 안내가 있음 (화면 동작은 PR 앱 확인에서)
      {
        const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        const ok = /if \(r\.paused \|\| pauseClicked\) \{[\s\S]{0,400}\} else await askTrash\(\)/.test(html) && /pauseClicked = true;/.test(html) && /id="folderNote"/.test(html) && /function renderFolderNote\(\)/.test(html) && /원본 정리만 남음/.test(html);
        out.push(sub('55c 화면: 일시정지 때 원본 확인 건너뜀, 폴더가 다르면 안내 자리', ok));
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

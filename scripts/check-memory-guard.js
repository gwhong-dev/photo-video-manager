// 파일 위치: scripts/check-memory-guard.js
// 역할: PC 메모리 지키기(lib/memory-guard.js) 점검 (53). scripts/check.js 의 ITEMS 끝에 붙어요
//   위험 판단 기준, 실행 중 위험해지면 처리 중인 파일까지만 하고 멈추는지, 안내 글을 확인해요
//   ⚠️ 샘플은 임시 폴더 복사본으로만 써요. 진짜 메모리 측정은 한 번 읽기만 해요
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const { sub } = require('./check-gallery');
const { createMemoryGuard, lowReason, lowMessage, sampleWindows } = require('../lib/memory-guard');
const { makePlan } = require('../lib/planner');
const { JobStore } = require('../lib/job');
const { createLogger } = require('../lib/logger');
const runner = require('../lib/runner');

const AUTO = path.join(__dirname, '..', 'test', 'samples', 'auto');

const items = [
  {
    no: 53,
    name: 'PC 메모리 지키기',
    async run(env) {
      const out = [];

      // 53a 위험 판단: 남은 가상 메모리 3GB 미만 또는 탐색기 4GB 초과
      const ok = lowReason({ freeVirtualGB: 15, explorerGB: 0.3 });
      const lowFree = lowReason({ freeVirtualGB: 2.1, explorerGB: 0.3 });
      const bigExplorer = lowReason({ freeVirtualGB: 10, explorerGB: 30.1 });
      out.push(sub('53a 위험 판단 (평소 통과, 가상 메모리 부족 · 탐색기 30GB 는 위험)', ok === null && /가상 메모리 2.1GB/.test(lowFree || '') && /탐색기 30.1GB/.test(bigExplorer || '') && lowReason(null) === null, [ok, lowFree, bigExplorer].join(' / ')));

      // 53b 안내 글: 이유 · 할 일(창 닫기, 탐색기 다시 시작) · 원본 정리 안 함
      const msg = lowMessage('Windows 탐색기 30.1GB');
      out.push(sub('53b 안내 글에 이유와 할 일', /탐색기 30.1GB/.test(msg) && /속성 창을 닫거나/.test(msg) && /원본 정리도 하지 않았어요/.test(msg)));

      // 53c 실행 중 위험해지면: 처리 중인 파일까지만 하고 멈춤, 나머지는 대기
      {
        const root = path.join(env.tmp, 'memory-guard');
        const source = path.join(root, 'source');
        fs.cpSync(AUTO, source, { recursive: true, preserveTimestamps: true });
        const backupRoot = path.join(root, 'backup');
        fs.mkdirSync(backupRoot, { recursive: true });
        const logger = createLogger(path.join(root, 'logs'));
        const plan = await makePlan({ source, backupRoot, includeSub: true }, env.et);
        const store = new JobStore(path.join(root, 'jobs'));
        const job = store.create(plan);
        let calls = 0;
        // 가짜 측정: 처음 한 번은 괜찮고, 그다음부터 탐색기 30GB
        const guard = createMemoryGuard({ sample: async () => (++calls === 1 ? { freeVirtualGB: 12, explorerGB: 0.3 } : { freeVirtualGB: 1.5, explorerGB: 30 }), logger: () => logger });
        const before = await guard.check();
        let first = true;
        const r = await runner.runBatch({
          job, store, batchSize: 100000, ctx: env.ctx, logger, concurrency: 2,
          shouldPause: () => !!guard.low(),
          onProgress: () => { if (first) { first = false; guard.check(); } }, // 첫 파일이 끝나면 다시 재기 (실제는 1분마다)
        });
        await new Promise((res) => setTimeout(res, 50));
        const todoLeft = job.items.filter((it) => it.status === 'todo').length;
        const memLog = fs.readdirSync(path.join(root, 'logs')).some((n) => n.startsWith('memory_'));
        out.push(sub('53c 실행 중 메모리 위험 → 멈추고 남은 파일은 대기, 메모리 로그', before.low === null && r.paused && todoLeft > 0 && memLog, `처음 ${before.low}, paused ${r.paused}, 처리 ${r.handled}, 남은 ${todoLeft}, 로그 ${memLog}`));
      }

      // 53d 진짜 측정이 숫자로 나옴 (Windows 에서만)
      if (process.platform === 'win32') {
        const m = await sampleWindows();
        out.push(sub('53d 이 PC 의 실제 메모리 측정', !!m && m.freeVirtualGB > 0 && m.explorerGB >= 0, m ? `남은 가상 메모리 ${m.freeVirtualGB.toFixed(1)}GB, 탐색기 ${m.explorerGB.toFixed(2)}GB` : '못 잼'));
      }
      return out;
    },
  },
];

module.exports = { items };

// 이 파일만 돌릴 때: node scripts/check-memory-guard.js
if (require.main === module) {
  const os = require('os');
  const { ExifTool } = require('../lib/exiftool');
  const { detectTools } = require('../lib/tools');
  (async () => {
    const tools = await detectTools({}, path.join(__dirname, '..'));
    const et = new ExifTool(tools.exiftool.path);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvm-check-mem-'));
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

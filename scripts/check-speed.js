// 파일 위치: scripts/check-speed.js
// 역할: 가져오기 동시 처리 점검 (50). scripts/check.js 의 ITEMS 끝에 붙어요
//   동시에 여러 파일을 처리해도 하나씩 할 때와 결과가 같은지, 이름이 겹치지 않는지, 일시정지가 되는지 확인해요
//   ⚠️ 샘플은 임시 폴더 복사본으로만 써요
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const { sub } = require('./check-gallery');
const { ExifToolPool } = require('../lib/exiftool');
const { makePlan, readMetaWithKeys, walk } = require('../lib/planner');
const { JobStore } = require('../lib/job');
const { createLogger } = require('../lib/logger');
const { probeVideo } = require('../lib/tools');
const runner = require('../lib/runner');

const AUTO = path.join(__dirname, '..', 'test', 'samples', 'auto');
const slash = (p) => p.split(path.sep).join('/');

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath || e.path, e.name));
}

// 자동 샘플 복사본으로 미리보기 → 작업 저장 (실행은 따로)
async function prepare(root, et, { copies = 1 } = {}) {
  const source = path.join(root, 'source');
  fs.cpSync(AUTO, source, { recursive: true, preserveTimestamps: true });
  // 동시 처리가 실제로 겹치게 같은 샘플을 다른 폴더에 몇 벌 더 둬요 (이름이 겹쳐 _번호가 붙는 경우도 생겨요)
  for (let i = 2; i <= copies; i++) fs.cpSync(AUTO, path.join(source, `copy${i}`), { recursive: true, preserveTimestamps: true });
  const backupRoot = path.join(root, 'backup');
  fs.mkdirSync(backupRoot, { recursive: true });
  const logger = createLogger(path.join(root, 'logs'));
  const plan = await makePlan({ source, backupRoot, includeSub: true }, et);
  const store = new JobStore(path.join(root, 'jobs'));
  const job = store.create(plan);
  return { root, source, backupRoot, logger, store, job };
}

// 원본(상대 경로) → 상태 · 결과(상대 경로) · 파일 날짜
function summary(p) {
  const m = {};
  for (const it of p.job.items) {
    const rel = slash(path.relative(p.source, it.src));
    let mtime = null;
    try { mtime = it.finalPath ? Math.round(fs.statSync(it.finalPath).mtimeMs / 1000) : null; } catch (e) { /* 없음 */ }
    m[rel] = { status: it.status, result: it.finalPath ? slash(path.relative(p.backupRoot, it.finalPath)) : null, mtime };
  }
  return m;
}

const leftovers = (dir) => listFiles(dir).filter((f) => /\.__tmp__|_exiftool_tmp$/.test(f));

const items = [
  {
    no: 50,
    name: '가져오기 동시 처리 (속도)',
    async run(env) {
      const out = [];
      const base = path.join(env.tmp, 'speed');
      const pool = new ExifToolPool(env.tools.exiftool.path, 3);
      try {
        // 50a 하나씩(1) 과 동시에(4) 처리한 결과가 같음: 상태 · 결과 위치 · 파일 날짜
        {
          const one = await prepare(path.join(base, 'one'), env.et, { copies: 3 });
          await runner.runBatch({ job: one.job, store: one.store, batchSize: 100000, ctx: env.ctx, logger: one.logger, concurrency: 1 });
          const four = await prepare(path.join(base, 'four'), env.et, { copies: 3 });
          await runner.runBatch({ job: four.job, store: four.store, batchSize: 100000, ctx: { ...env.ctx, et: pool }, logger: four.logger, concurrency: 4 });
          const a = summary(one);
          const b = summary(four);
          const diff = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
          // 같은 이름이 여러 벌일 때 _1 · _2 가 어느 원본에 붙을지는 처리 순서에 따라 달라질 수 있어요 → 결과 위치 "목록"은 같아야 해요
          const setOf = (m) => Object.values(m).map((v) => `${v.status}|${v.result}|${v.mtime}`).sort().join('\n');
          const sameSet = setOf(a) === setOf(b);
          const fails = Object.values(b).filter((v) => v.status === 'fail').length;
          out.push(sub('50a 동시 처리 결과 = 하나씩 처리 결과 (결과 위치 · 날짜 목록, 실패 0)', sameSet && fails === 0, `다른 줄 ${diff.length}개 ${diff.slice(0, 3).join(', ')} / 실패 ${fails}`));
          out.push(sub('50b 임시 파일(.__tmp__) 안 남음', leftovers(four.backupRoot).length === 0, leftovers(four.backupRoot).join(', ')));
          const doneFiles = Object.values(b).filter((v) => v.result && v.status === 'done').map((v) => v.result.toLowerCase());
          out.push(sub('50c 완료 결과 파일 이름이 서로 다름', new Set(doneFiles).size === doneFiles.length, `${doneFiles.length}개`));
          const runLog = listFiles(path.join(four.root, 'logs')).find((f) => /run_/.test(path.basename(f)));
          const head = runLog ? fs.readFileSync(runLog, 'utf8').split('\n')[0] : '';
          out.push(sub('50d 실행 로그에 동시 처리 수', /동시 처리 4개/.test(head), head));
        }

        // 50e 같은 이름을 노리는 두 파일을 동시에: 둘 다 완료, 하나는 _1 (이름 잡기)
        {
          const p = await prepare(path.join(base, 'same-name'), env.et);
          const todo = p.job.items.filter((it) => it.status === 'todo' && it.kind === 'copy' && it.date);
          const [x, y] = todo;
          if (!x || !y) {
            out.push(sub('50e 같은 이름 두 파일 동시 처리', false, '시험할 파일이 모자라요'));
          } else {
            y.dest = x.dest; // 일부러 같은 자리를 노리게
            for (const it of p.job.items) if (it !== x && it !== y && it.status === 'todo') it.status = 'skip';
            await runner.runBatch({ job: p.job, store: p.store, batchSize: 100000, ctx: { ...env.ctx, et: pool }, logger: p.logger, concurrency: 4 });
            const ok = x.status === 'done' && y.status === 'done' && x.finalPath && y.finalPath && x.finalPath.toLowerCase() !== y.finalPath.toLowerCase();
            const names = [x.finalPath, y.finalPath].map((f) => (f ? path.basename(f) : '-'));
            out.push(sub('50e 같은 이름 두 파일 동시 처리 → 둘 다 완료, 이름 다름 (_1)', ok && names.some((n) => /_1\.[^.]+$/.test(n)), names.join(' / ')));
          }
        }

        // 50f 일시정지: 처리 중인 것까지만 하고 멈춤, 나머지는 대기로 남음
        {
          const p = await prepare(path.join(base, 'pause'), env.et, { copies: 3 });
          let seen = 0;
          const r = await runner.runBatch({
            job: p.job, store: p.store, batchSize: 100000, ctx: { ...env.ctx, et: pool }, logger: p.logger, concurrency: 4,
            shouldPause: () => seen >= 1, // 첫 파일이 끝나면 바로 멈추기 (동시에 시작한 것까지만 끝남)
            onProgress: (x) => { seen = x.done; },
          });
          const todoLeft = p.job.items.filter((it) => it.status === 'todo').length;
          out.push(sub('50f 일시정지 → 멈추고 남은 파일은 대기', r.paused && todoLeft > 0 && leftovers(p.backupRoot).length === 0, `paused ${r.paused}, 처리 ${r.handled}, 남은 ${todoLeft}`));
        }

        // 50g 여러 개 켠 exiftool로 읽어도 결과가 같음 (미리보기 정보 읽기)
        {
          const files = walk(AUTO, true, []);
          const a = await readMetaWithKeys(env.et, files, ['DateTimeOriginal', 'Model']);
          const b = await readMetaWithKeys(pool, files, ['DateTimeOriginal', 'Model']);
          const norm = (m) => JSON.stringify([...m.entries()].sort((x, y) => x[0].localeCompare(y[0])));
          out.push(sub('50g exiftool 여러 개로 읽어도 결과 같음', a.size > 0 && norm(a) === norm(b), `${a.size}개 / ${b.size}개`));
        }

        // 50h 재생 확인 한 번으로 영상 형식까지 읽음 (MOV→MP4 가 ffprobe 를 다시 켜지 않게)
        {
          const v = await probeVideo(env.tools.ffprobe.path, path.join(AUTO, 'IMG_0103.MOV'));
          out.push(sub('50h 재생 확인이 영상 형식도 돌려줌', v.ok === true && !!v.video, JSON.stringify(v)));
        }
      } finally {
        pool.close();
      }
      return out;
    },
  },
];

module.exports = { items };

// 이 파일만 돌릴 때: node scripts/check-speed.js
if (require.main === module) {
  const os = require('os');
  const { ExifTool } = require('../lib/exiftool');
  const { detectTools } = require('../lib/tools');
  (async () => {
    const tools = await detectTools({}, path.join(__dirname, '..'));
    const et = new ExifTool(tools.exiftool.path);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvm-check-speed-'));
    const env = { tmp, tools, et, ctx: { et, magick: tools.magick.path, ffmpeg: tools.ffmpeg.path, ffprobe: tools.ffprobe.path } };
    let failed = 0;
    try {
      for (const item of items) {
        const subs = await item.run(env);
        for (const s of subs) {
          if (s.status === 'fail') failed++;
          console.log(`${s.status === 'ok' ? '✅' : '❌'} ${s.label}${s.detail ? ' — ' + s.detail : ''}`);
        }
      }
    } finally {
      et.close();
      if (!failed) fs.rmSync(tmp, { recursive: true, force: true });
      else console.log('남긴 폴더: ' + tmp);
    }
    process.exit(failed ? 1 : 0);
  })();
}

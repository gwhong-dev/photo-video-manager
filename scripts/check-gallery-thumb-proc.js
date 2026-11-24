// 파일 위치: scripts/check-gallery-thumb-proc.js
// 역할: 갤러리 썸네일 · 큰 그림을 따로 도는 프로그램(lib/thumb-worker.js)에서 만드는 점검 (72). scripts/check.js 의 ITEMS 끝에 붙어서 같이 돌아요.
//   빠르게 이 파일만 돌릴 때: node scripts/check-gallery-thumb-proc.js
//
// ⚠️ 점검용 임시 폴더(pvm-check-)에 자동 샘플을 복사해서만 써요. 실제 사진은 건드리지 않아요
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { sub, row, withDb } = require('./check-gallery');

const APP = path.join(__dirname, '..');
const SAMPLES = path.join(APP, 'test', 'samples', 'auto');
const ALL = { tab: 'all', sort: 'newest', query: '', tag: null };

const items = [
  {
    no: 72,
    name: '갤러리 썸네일 · 큰 그림을 따로 도는 프로그램에서 (sharp 가 꺼져도 앱은 계속)',
    async run(env) {
      const { createThumbs } = require('../lib/thumbs');
      const { createProcMake } = require('../lib/thumb-proc');
      const out = [];
      const own = !env.tmp;
      const tmpBase = env.tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'pvm-check-thumb-proc-'));
      const root = path.join(tmpBase, 'thumb-proc');
      const src = path.join(root, 'src');
      fs.mkdirSync(src, { recursive: true });
      const kids = [];
      const spawn = (file) => {
        const c = cp.fork(file, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        kids.push(c);
        return { postMessage: (m) => c.send(m), on: (ev, fn) => c.on(ev, fn), kill: () => c.kill() };
      };
      try {
        const tools = env.tools || (await require('../lib/tools').detectTools({}, APP));
        const fakeFile = path.join(root, 'fake-worker.js');
        // 가짜 그림 프로그램: 이름에 crash 가 있으면 꺼지고, 나머지는 'ok' 를 돌려줘요
        fs.writeFileSync(fakeFile, [
          "process.on('message', (m) => {",
          "  if (m.p.includes('crash')) process.exit(3);",
          "  process.send({ id: m.id, b64: Buffer.from('ok').toString('base64') });",
          '});',
          "process.on('disconnect', () => process.exit(0));",
        ].join('\n'));

        const names = ['a.jpg', 'b.jpg', 'c.jpg', 'crash.jpg', 'd.jpg'];
        for (const n of names) fs.copyFileSync(path.join(SAMPLES, 'IMG_0101.jpg'), path.join(src, n));
        const hasMov = fs.existsSync(path.join(SAMPLES, 'IMG_0103.MOV'));
        if (hasMov) fs.copyFileSync(path.join(SAMPLES, 'IMG_0103.MOV'), path.join(src, 'v.mov'));
        const rowOf = (n) => {
          const p = path.join(src, n);
          const st = fs.statSync(p);
          return row({ root: src, path: p, name: n, mediaType: n.endsWith('.mov') ? 'video' : 'photo', size: st.size, mtimeMs: Math.floor(st.mtimeMs), takenDay: null, takenAt: null, durationSec: n.endsWith('.mov') ? 3 : null });
        };

        await withDb({ tmp: tmpBase }, 'thumb-proc', async (db) => {
          db.upsertFiles([...names, ...(hasMov ? ['v.mov'] : [])].map(rowOf));
          const idOf = (n) => db.listFiles(src, null, ALL).find((f) => f.name === n).id;
          const stateOf = (n) => db.getFile(idOf(n)).thumbState;
          const sizeOf = async (p) => {
            const m = await require('sharp')(p).metadata();
            return { f: m.format, max: Math.max(m.width, m.height) };
          };

          // 72a 진짜 그림 프로그램: 사진 · 영상 썸네일(320 이하), 큰 그림(webp), 끌 때 자식 프로세스도 꺼짐
          const real = createProcMake({ spawn, videoTimeoutMs: 60000 });
          const t = createThumbs({ db, thumbDir: path.join(root, 'thumbs-real'), getTools: () => tools, isBusy: () => false, logger: null, make: real });
          const t0 = Date.now();
          const four = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'];
          const ps = await Promise.all(four.map((n) => t.request(idOf(n))));
          const ms = Date.now() - t0;
          const sz = await Promise.all(ps.map((p) => (p ? sizeOf(p) : null)));
          const photoOk = sz.every((m) => m && m.f === 'webp' && m.max > 0 && m.max <= 320) && four.every((n) => stateOf(n) === 'ready');
          let vidOk = true;
          if (hasMov && tools.ffmpeg && tools.ffmpeg.ok) {
            const vp = await t.request(idOf('v.mov'));
            const vm = vp ? await sizeOf(vp) : null;
            vidOk = !!vm && vm.f === 'webp' && vm.max <= 320 && stateOf('v.mov') === 'ready';
          }
          const pv = await t.preview(idOf('a.jpg'));
          const pm = pv && pv.buffer ? await require('sharp')(pv.buffer).metadata() : null;
          const running = real.stats().running;
          await t.stop();
          const closed = !real.stats().running && running;
          out.push(sub('72a 진짜 그림 프로그램에서 사진 · 영상 썸네일과 큰 그림이 만들어지고, 끌 때 같이 꺼짐', photoOk && vidOk && !!pm && pm.format === 'webp' && closed,
            JSON.stringify({ photoOk, vidOk, preview: pm && pm.width, closed, ms4photos: ms })));

          // 72b 그림 프로그램이 꺼지는 사진: 그 칸만 failed(그림 없음), 앱은 계속, 다시 띄워서 다른 사진은 됨, 자동으로 다시 하지 않음
          const crashes = [];
          const fake = createProcMake({ spawn, file: fakeFile, timeoutMs: 3000, onCrash: (e) => crashes.push(e) });
          const t2 = createThumbs({ db, thumbDir: path.join(root, 'thumbs-fake'), getTools: () => tools, isBusy: () => false, logger: null, make: fake });
          const bad = await t2.request(idOf('crash.jpg'));
          const afterBad = fake.stats();
          const good = await t2.request(idOf('a.jpg'));
          const total = fake.stats().crashes;
          await t2.stop();
          out.push(sub('72b 그림 프로그램을 꺼뜨리는 사진은 그 칸만 failed, 다른 사진은 계속 만들어짐, 자동 재시도 없음',
            bad === null && stateOf('crash.jpg') === 'failed' && afterBad.crashes === 1 && !afterBad.running && !!good && stateOf('a.jpg') === 'ready'
              && total === 1 && crashes.length === 1 && crashes[0].code === 3,
            JSON.stringify({ bad, state: stateOf('crash.jpg'), afterBad, good: !!good, total })));
        });

        // 72c 앱 연결: gallery-main 이 utilityProcess 로 띄우고 createThumbs 에 끼우고 끌 때 같이 끔
        const gm = fs.readFileSync(path.join(APP, 'gallery-main.js'), 'utf8');
        const wired = gm.includes("utilityProcess.fork(file, [], { serviceName: 'pvm-gallery-thumbs' })") && /make: thumbMake/.test(gm)
          && gm.includes('if (thumbMake) thumbMake.close()');
        out.push(sub('72c 앱 연결 (utilityProcess · createThumbs make · 끌 때 close)', wired, JSON.stringify({ wired })));
      } finally {
        for (const k of kids) {
          try {
            k.kill();
          } catch (e) {
            // 이미 꺼짐
          }
        }
        if (own) {
          await new Promise((r) => setTimeout(r, 300));
          try {
            fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
          } catch (e) {
            // 윈도우가 막 꺼진 프로그램의 파일을 잠깐 잡고 있을 수 있어요 (임시 폴더라 남아도 괜찮아요)
          }
        }
      }
      return out;
    },
  },
];

module.exports = { items };

if (require.main === module) {
  (async () => {
    let failed = false;
    for (const it of items) {
      const rows = await it.run({});
      for (const r of rows) {
        if (r.status === 'fail') failed = true;
        const icon = { ok: '✅', fail: '❌', skip: '⏭' }[r.status];
        console.log(`${icon} ${r.label}${r.status === 'ok' ? '' : ` — ${r.detail}`}`);
        if (r.status === 'ok' && r.detail) console.log(`   ${r.detail}`);
      }
    }
    process.exitCode = failed ? 1 : 0;
  })();
}

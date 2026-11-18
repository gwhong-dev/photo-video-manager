// 파일 위치: scripts/check-dup-compare.js
// 역할: 원본 정리 확인 창의 "🔁 중복 원본 비교" 점검 (58). scripts/check.js 의 ITEMS 끝에 붙어서 같이 돌아요.
//   빠르게 이 파일만 돌려 볼 때: node scripts/check-dup-compare.js
//
// ⚠️ 점검용 임시 폴더(pvm-check-)에 자동 샘플을 복사해서만 써요. 실제 사진 · 진짜 휴지통은 건드리지 않아요 (휴지통은 가짜)
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { sub } = require('./check-gallery');

const APP = path.join(__dirname, '..');
const SAMPLES = path.join(APP, 'test', 'samples', 'auto');
const sha1 = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
const listAll = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
};

const items = [
  {
    no: 58,
    name: '원본 정리 중복 비교 (남는 파일 ↔ 정리될 원본, 남기기)',
    async run(env) {
      const C = require('../lib/dup-compare');
      const cleaner = require('../lib/cleaner');
      const { JobStore } = require('../lib/job');
      const { createLogger } = require('../lib/logger');
      const { parseLog } = require('../lib/clean-history');
      const out = [];
      const own = !env.tmp; // 이 파일만 돌릴 때는 임시 폴더를 직접 만들고 지워요
      const tmpBase = env.tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'pvm-check-dup-compare-'));
      const root = path.join(tmpBase, 'dup-compare');
      fs.mkdirSync(root, { recursive: true });

      // 58a 비교 목록: 중복(같은 파일 · 이미 있음 · 변환형)만 나오고 방금 옮긴 원본(done)은 개수만
      //     남는 파일은 dupOf · 이번 작업의 완료 항목(dupOfItem) 둘 다 찾아요
      {
        const job = {
          source: 'S:\\가져올',
          backupRoot: 'X:\\백업',
          items: [
            { i: 0, status: 'done', src: 'S:\\가져올\\a.jpg', finalPath: 'X:\\백업\\2026\\10\\28\\a.jpg' },
            { i: 1, status: 'dup', src: 'S:\\가져올\\a(1).jpg', dupOfItem: 0, note: '같은 파일 (a.jpg)', date: '2026:10:28 10:11:12' },
            { i: 2, status: 'dup', src: 'S:\\가져올\\옛날\\b.heic', converted: true, sameShot: true, dupOf: 'X:\\백업\\2026\\10\\29\\b.jpg', note: '이미 있음 (같은 촬영 b.jpg)' },
            { i: 3, status: 'done', src: 'S:\\가져올\\c.mov', converted: true, finalPath: 'X:\\백업\\2026\\10\\29\\c.mp4' },
          ],
        };
        const pool = C.comparePool(job, job.items);
        const view = await C.compareRows(job, pool, 0, { statOf: async (p) => ({ size: p.endsWith('b.heic') ? 2048 : 1024 }) });
        const shown = JSON.stringify(view);
        const r0 = view.rows[0];
        const r1 = view.rows[1];
        out.push(sub('58a 비교 목록은 중복 원본만 (방금 옮긴 원본 2개는 개수만), 남는 파일 찾기 두 가지, 화면 값에 전체 경로 없음',
          pool.items.length === 2 && pool.done === 2 && view.total === 2 && view.done === 2 && view.next === null
          && r0.keepName === 'a.jpg' && r0.srcName === 'a(1).jpg' && r0.shot === '2026-10-28 10:11:12' && r0.why === '같은 파일 (a.jpg)' && r0.keepPlace === path.join('2026', '10', '28') && r0.srcPlace === '맨 위'
          && r1.keepName === 'b.jpg' && r1.srcPlace === '옛날' && r1.srcSize === 2048 && r1.shot === '' && !r1.video
          && !shown.includes('S:\\') && !shown.includes('X:\\') && !shown.includes('가져올\\') && !shown.includes('백업\\'),
          shown.slice(0, 300)));
      }

      // 58b 수천 개: 100줄씩 나눠 보내고(더 보기), 번호는 이번 목록 안의 것만, 이상한 번호로 남기기를 부탁하면 정리하지 않게 오류
      {
        const job = { source: 'S:\\', backupRoot: 'X:\\', items: [] };
        for (let i = 0; i < 250; i++) job.items.push({ i, status: 'dup', src: `S:\\${i}.jpg`, dupOf: `X:\\${i}.jpg` });
        const pool = C.comparePool(job, job.items);
        const stat = async () => ({ size: 1 });
        const p0 = await C.compareRows(job, pool, 0, { statOf: stat });
        const p1 = await C.compareRows(job, pool, p0.next, { statOf: stat });
        const p2 = await C.compareRows(job, pool, p1.next, { statOf: stat });
        const pagesOk = p0.rows.length === 100 && p0.next === 100 && p1.rows[0].key === 100 && p2.rows.length === 50 && p2.next === null && p2.rows[49].key === 249;
        const errOf = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
        const kept = C.keptItems(pool, [3, 3, 249]);
        const bad = [errOf(() => C.keptItems(pool, [250])), errOf(() => C.keptItems(pool, [-1])), errOf(() => C.keptItems(pool, ['1'])), errOf(() => C.keptItems(pool, 1)), errOf(() => C.keptItems(null, [0]))];
        const files = [C.compareFile(pool, 3, 'keep'), C.compareFile(pool, 3, 'src'), C.compareFile(pool, 3, 'x'), C.compareFile(pool, 250, 'keep'), C.compareFile(pool, 1.5, 'src')];
        out.push(sub('58b 100줄씩 나눠 보냄 (250개 → 100 · 100 · 50), 남기기 번호 검사 (이상하면 오류), 여는 파일은 이번 목록 번호로만',
          pagesOk && JSON.stringify(kept) === '[3,249]' && bad.every((m) => m === '비교 목록을 다시 열어 주세요')
          && files[0] === 'X:\\3.jpg' && files[1] === 'S:\\3.jpg' && files.slice(2).every((f) => f === null) && C.keptItems(pool, undefined).length === 0,
          JSON.stringify({ pagesOk, kept, bad, files })));
      }

      // 58c 진짜 파일로 끝까지 (확인 창 → 남기기 1개 → 정리 직전 확인 → 정리, 휴지통은 가짜)
      //     중복 원본 2개 + 방금 옮긴 원본 1개. 남기기한 원본은 휴지통으로 안 가고 파일 그대로, 작업 기록에 "사용자가 남김"
      //     다음 정리 창(배너 후보 · 확인)에 다시 안 나오고, 껐다 켜도(작업 기록 다시 읽기) 그대로, 로그에 남고 정리 화면 숫자에는 안 셈
      {
        const src = path.join(root, 'src');
        const bak = path.join(root, 'bak');
        const day = path.join(bak, '2026', '10', '28');
        for (const d of [src, day]) fs.mkdirSync(d, { recursive: true });
        const cp = (from, to) => fs.copyFileSync(path.join(SAMPLES, from), to);
        cp('IMG_0101.jpg', path.join(src, 'IMG_0101.jpg'));
        cp('IMG_0101.jpg', path.join(day, 'IMG_0101.jpg'));
        cp('IMG_0104.jpg', path.join(src, 'IMG_0104.jpg'));
        cp('IMG_0104.jpg', path.join(day, 'IMG_0104.jpg'));
        cp('KakaoTalk_20261028_210941.jpg', path.join(src, 'Kakao.jpg'));
        cp('KakaoTalk_20261028_210941.jpg', path.join(day, 'Kakao.jpg'));
        const size = (p) => fs.statSync(p).size;
        const store = new JobStore(path.join(root, 'jobs'));
        const job = store.create({
          source: src,
          backupRoot: bak,
          items: [
            { i: 0, status: 'dup', src: path.join(src, 'IMG_0101.jpg'), dupOf: path.join(day, 'IMG_0101.jpg'), size: size(path.join(src, 'IMG_0101.jpg')), note: '이미 있음 (내용이 같은 IMG_0101.jpg)' },
            { i: 1, status: 'dup', src: path.join(src, 'IMG_0104.jpg'), dupOf: path.join(day, 'IMG_0104.jpg'), size: size(path.join(src, 'IMG_0104.jpg')), note: '이미 있음 (내용이 같은 IMG_0104.jpg)' },
            { i: 2, status: 'done', src: path.join(src, 'Kakao.jpg'), finalPath: path.join(day, 'Kakao.jpg'), size: size(path.join(src, 'Kakao.jpg')) },
          ],
        });
        const keptPath = path.join(src, 'IMG_0101.jpg');
        const keptHash = sha1(keptPath);
        const logs = createLogger(path.join(root, 'logs'));
        const sigs = new Map();
        const targets = await cleaner.cleanTargets(job, { store, logger: logs, sigs });
        const pool = C.comparePool(job, targets);
        const first = await C.compareRows(job, pool, 0);
        const keepKey = first.rows.findIndex((r) => r.srcName === 'IMG_0101.jpg');
        // main.js trash-originals 와 같은 차례: 남기기 먼저 적고 → 정리 직전 확인 → 정리
        const userKept = C.markUserKept(job, store, C.keptItems(pool, [keepKey]));
        const finalTargets = await cleaner.recheckTargets(job, sigs);
        const binDir = path.join(root, 'fake-bin');
        fs.mkdirSync(binDir, { recursive: true });
        const trashed = [];
        const trash = async (p) => {
          trashed.push(p);
          fs.renameSync(p, path.join(binDir, path.basename(p))); // 가짜 휴지통 (점검 폴더 안)
        };
        const r = await cleaner.cleanOriginals({ job, store, targets: finalTargets, logger: logs, trash, driveKindOf: async () => 'fixed', recycleOf: async () => null, userKept });
        const reloaded = store.load();
        const again = cleaner.cleanCandidates(reloaded);
        const againTargets = await cleaner.cleanTargets(reloaded, {});
        const againPool = C.comparePool(reloaded, againTargets);
        const logText = fs.readFileSync(r.logPath, 'utf8');
        const hist = { session: parseLog(path.basename(r.logPath), logText) };
        out.push(sub('58c 진짜 파일: 비교 목록에 중복 2개만 (방금 옮긴 1개는 개수만), 남기기 1개는 휴지통에 안 가고 파일 그대로, 나머지 2개는 정리',
          targets.length === 3 && first.total === 2 && first.done === 1 && keepKey >= 0 && first.rows.every((x) => x.keepSize === x.srcSize && x.keepSize > 0)
          && finalTargets.length === 2 && !finalTargets.some((it) => it.src === keptPath)
          && r.trashed === 2 && r.kept === 1 && r.fail === 0 && !trashed.includes(keptPath)
          && fs.existsSync(keptPath) && sha1(keptPath) === keptHash && !fs.existsSync(path.join(src, 'IMG_0104.jpg')) && !fs.existsSync(path.join(src, 'Kakao.jpg')),
          JSON.stringify({ targets: targets.length, total: first.total, done: first.done, final: finalTargets.length, r: [r.trashed, r.kept, r.fail], trashed: trashed.map((p) => path.basename(p)) })));
        out.push(sub('58d 남기기는 작업 기록에 "사용자가 남김" → 다시 켜도 그대로, 다음 정리 창(배너 후보 · 확인 · 비교 목록)에 안 나옴, 로그에 남고 정리 화면 숫자에는 안 셈',
          reloaded.items[0].cleanSkip === C.USER_KEPT && !reloaded.items[0].trashed && !reloaded.items[1].cleanSkip && reloaded.items[1].trashed
          && again.length === 0 && againTargets.length === 0 && againPool.items.length === 0
          && logText.includes('사용자가 남김') && /# 끝 \/ 휴지통 2, 이동 0, 실패 0 \/ 사용자가 남김 1/.test(logText)
          && hist.session && hist.session.trash === 2 && hist.session.files.length === 2,
          JSON.stringify({ skip: reloaded.items[0].cleanSkip, again: again.length, againTargets: againTargets.length, hist: hist.session && [hist.session.trash, hist.session.files.length], log: logText.split(/\r?\n/).slice(-2) })));

        // 58e 이미 정리된 원본 · 완료 원본은 남기기로 적지 않음 (확인 창을 띄운 뒤 다른 곳에서 정리됐을 때)
        const fakeStore = { mark: (j, i, patch) => Object.assign(j.items[i], patch) };
        const j2 = { items: [{ i: 0, status: 'dup', trashed: true, src: 'a' }, { i: 1, status: 'done', src: 'b' }, { i: 2, status: 'dup', src: 'c' }] };
        const marked = C.markUserKept(j2, fakeStore, [0, 1, 2, 9]);
        out.push(sub('58e 이미 정리된 원본 · 완료 원본 · 없는 번호는 남기기로 적지 않음',
          marked.length === 1 && marked[0].src === 'c' && !j2.items[0].cleanSkip && !j2.items[1].cleanSkip && j2.items[2].cleanSkip === C.USER_KEPT,
          JSON.stringify(j2.items.map((x) => x.cleanSkip || ''))));
      }

      // 58f 작은 그림: 진짜 사진 · 영상으로 만들고(data 주소), 사진 폴더에는 아무것도 안 생기고 임시 파일도 안 남음
      //     같은 그림은 한 번만 만들고, 동시에 2개까지, clear() 하면 기다리던 것은 null
      {
        const pics = path.join(root, 'pics');
        fs.mkdirSync(pics, { recursive: true });
        fs.copyFileSync(path.join(SAMPLES, 'IMG_0101.jpg'), path.join(pics, 'IMG_0101.jpg'));
        fs.copyFileSync(path.join(SAMPLES, 'IMG_0103.MOV'), path.join(pics, 'IMG_0103.MOV'));
        const before = listAll(pics);
        const tempDir = path.join(root, 'userData', 'compare-tmp');
        const resolvedTools = env.tools || (await require('../lib/tools').detectTools({}, APP));
        const real2 = C.createCompareThumbs({ tempDir, getTools: () => resolvedTools });
        const [jpg, mov, none] = await Promise.all([
          real2.get(path.join(pics, 'IMG_0101.jpg')),
          real2.get(path.join(pics, 'IMG_0103.MOV')),
          real2.get(path.join(pics, '없는파일.jpg')),
        ]);
        const after = listAll(pics);
        const leftover = listAll(tempDir);
        const hasFfmpeg = !!(resolvedTools && resolvedTools.ffmpeg && resolvedTools.ffmpeg.ok);
        const isWebp = (u) => typeof u === 'string' && u.startsWith('data:image/webp;base64,') && u.length > 200;
        out.push(sub('58f 작은 그림: 사진 · 영상(FFmpeg 있으면)이 data 주소로, 없는 파일은 null, 사진 폴더 그대로, 임시 파일 안 남음',
          isWebp(jpg) && (hasFfmpeg ? isWebp(mov) : true) && none === null && JSON.stringify(before) === JSON.stringify(after) && leftover.length === 0,
          JSON.stringify({ jpg: String(jpg).slice(0, 30), mov: String(mov).slice(0, 30), none, before, after, leftover, hasFfmpeg })));

        let active = 0;
        let peak = 0;
        let made = 0;
        const gates = [];
        const fake = C.createCompareThumbs({
          tempDir,
          make: async () => {
            made++;
            active++;
            peak = Math.max(peak, active);
            await new Promise((res) => gates.push(res));
            active--;
            return Buffer.from('webp');
          },
        });
        const a = fake.get('X:\\a.jpg');
        const a2 = fake.get('X:\\a.jpg'); // 같은 그림 → 한 번만
        const b = fake.get('X:\\b.jpg');
        const c = fake.get('X:\\c.jpg'); // 2개가 만드는 중이라 기다림
        await new Promise((res) => setImmediate(res));
        const peakBefore = peak;
        fake.clear(); // 기다리던 c 는 null
        const cv = await c;
        while (gates.length) gates.shift()();
        const [av, a2v, bv] = await Promise.all([a, a2, b]);
        // 앱이 꺼지며 남은 임시 파일(cmp-*)은 다음에 만들 때 치움, 다른 이름은 그대로 (#125 검증 ⚠️)
        fs.mkdirSync(tempDir, { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'cmp-1-1.frame.jpg'), 'x');
        fs.writeFileSync(path.join(tempDir, 'other.txt'), 'x');
        C.createCompareThumbs({ tempDir });
        const swept = listAll(tempDir);
        fs.rmSync(path.join(tempDir, 'other.txt'), { force: true });
        out.push(sub('58g 같은 그림은 한 번만 만들고 동시에 2개까지, 창을 닫으면(clear) 기다리던 것은 만들지 않음, 꺼지며 남은 임시 파일은 다음에 치움',
          peakBefore === 2 && made === 2 && cv === null && av === a2v && typeof bv === 'string' && fake.stats().cached === 0 && JSON.stringify(swept) === '["other.txt"]',
          JSON.stringify({ peakBefore, made, cv, av: String(av).slice(0, 25), cached: fake.stats().cached, swept })));
      }

      // 58h 화면 · 통로 연결: 확인 창 비교 칸 (남는 파일 · 정리될 원본 · 정리 체크 · 모두 남기기 · 더 보기), 버튼 글자에 남김 수,
      //     그림은 data 주소만 허용(CSP), preload 세 통로 · 남기기 번호는 정수만, main 은 정리 직전 확인보다 남기기를 먼저 적음,
      //     확인 창을 닫거나 작업이 바뀌면 비교 목록 · 그림을 비움, 비교 코드는 옮기기 · 지우기를 하지 않음
      {
        const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
        const html = read('index.html');
        const pre = read('preload.js');
        const main = read('main.js');
        const lib = read('lib/dup-compare.js');
        const block = (name) => {
          const at = main.indexOf(`ipcMain.handle('${name}'`);
          return at < 0 ? '' : main.slice(at, main.indexOf('\n});', at));
        };
        const tr = block('trash-originals');
        const htmlOk = html.includes('id="cdCompareBox"') && html.includes('라이브러리에 남는 파일') && html.includes('정리될 원본') && html.includes('id="cdCmpAllKeep"') && html.includes('id="cdCmpMore"')
          && html.includes("img-src 'self' data:") && html.includes('api.cleanCompareThumb(') && html.includes('api.openCleanCompare(r.key, side)') && html.includes('api.cleanCompareRows(cmpState.next)')
          && html.includes("binOverflow: choice === 'bin' ? 'trash' : 'move', keep })") && html.includes('new IntersectionObserver(onThumbsVisible')
          && html.includes('방금 옮긴 사진의 원본');
        // 버튼 글자: 화면 코드의 cleanGoText 를 그대로 떼어 돌려 봐요
        const fnSrc = html.slice(html.indexOf('function cleanGoText('), html.indexOf('// 🔁 중복 원본 비교 (2026-11-18'));
        // eslint-disable-next-line no-new-func
        const goText = new Function('num', `${fnSrc}; return cleanGoText;`)((n) => Number(n).toLocaleString('ko-KR'));
        const info = { count: 228, drives: [{ method: 'trash' }] };
        const texts = [goText(info, 0), goText(info, 2), goText({ count: 2, drives: [{ method: 'trash' }] }, 2), goText({ count: 5, drives: [{ method: 'move' }] }, 1)];
        const textOk = texts[0] === '원본 228개 휴지통으로 옮기기' && texts[1] === '원본 226개 휴지통으로 옮기기 (2개 남김)' && texts[2] === '원본은 옮기지 않고 2개 남기기'
          && texts[3] === '원본 4개 _정리완료원본으로 옮기기 (1개 남김)' && !texts.some((t) => t.includes('→') || t.includes('·'));
        const preOk = pre.includes("'clean-compare-rows'") && pre.includes("'clean-compare-thumb'") && pre.includes("'clean-compare-open'") && pre.includes('opts.keep.filter(Number.isInteger)');
        const mainOk = ['clean-compare-rows', 'clean-compare-thumb', 'clean-compare-open'].every((n) => main.includes(`ipcMain.handle('${n}'`))
          && tr.indexOf('markUserKept(') > 0 && tr.indexOf('markUserKept(') < tr.indexOf('recheckTargets(') && tr.includes('userKept,')
          && /function resetCleanCheck\(\) \{[^}]*cleanCompare = null;[^}]*compareThumbs\.clear\(\)/.test(main)
          && block('trash-info').includes('cleanCompare = comparePool(job, targets);') && block('trash-info').includes('compare: await compareRows(job, cleanCompare, 0)');
        // 지우기는 설정 폴더 아래 임시 폴더(tempDir)의 cmp-* 치우기 한 곳뿐이어야 해요
        const rmCalls = lib.match(/\.rm(Sync)?\(/g) || [];
        const readOnly = !/\.(rename|unlink|rmdir|copyFile|cp|truncate)(Sync)?\(|trashItem/.test(lib) && !/writeFile/.test(lib)
          && rmCalls.length === 1 && lib.includes("if (name.startsWith('cmp-')) fs.rmSync(path.join(tempDir, name), { force: true });");
        out.push(sub('58h 확인 창 비교 칸 · 버튼 글자에 남김 수 · CSP · 통로 · 남기기를 정리 직전 확인보다 먼저 · 비우기 · 비교 코드는 옮기기 · 지우기 없음',
          htmlOk && textOk && preOk && mainOk && readOnly,
          JSON.stringify({ htmlOk, texts, preOk, mainOk, readOnly })));
      }

      if (own) fs.rmSync(tmpBase, { recursive: true, force: true });
      return out;
    },
  },
];

module.exports = { items };

// 이 파일만 돌릴 때
if (require.main === module) {
  (async () => {
    let failed = false;
    for (const it of items) {
      const rows = await it.run({});
      for (const r of rows) {
        if (r.status === 'fail') failed = true;
        const icon = { ok: '✅', fail: '❌', skip: '⏭' }[r.status];
        console.log(`${icon} ${r.label}${r.status === 'ok' ? '' : ` — ${r.detail}`}`);
      }
    }
    process.exitCode = failed ? 1 : 0;
  })();
}

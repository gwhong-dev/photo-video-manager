// 파일 위치: scripts/check-clean-sample.js
// 역할: 원본 정리 확인 창의 "🔍 샘플 확인" 점검 (48). scripts/check.js 의 ITEMS 끝에 붙어서 같이 돌아요.
//   빠르게 이 파일만 돌려 볼 때: node scripts/check-clean-sample.js (48c는 샘플 처리 결과가 없어서 건너뜀)
//
// ⚠️ 파일을 만들거나 옮기지 않아요. 가짜 작업 정보(경로 글자)와 샘플 처리 결과의 작업 정보만 읽어요
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const { sub } = require('./check-gallery');

const APP = path.join(__dirname, '..');

// 늘 같은 순서의 "무작위" (점검 결과가 매번 같게)
function seeded(seed) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

const items = [
  {
    no: 48,
    name: '원본 정리 샘플 확인',
    async run(env) {
      const S = require('../lib/clean-sample');
      const out = [];

      // 48a 종류별로 골고루: 사진 30 · 영상 2 · 바꾼 사진 1 · 날짜 없음 3 → 10개 중 적은 종류는 다 들어가고 나머지는 사진,
      //     번호 겹침 없음, 종류 순서대로, 다른 무작위면 다른 사진, 후보가 4개면 4개 전부
      {
        const pool = [];
        const add = (kind, count) => {
          for (let i = 0; i < count; i++) pool.push({ path: `X:\\백업\\${kind}${i}`, name: `${kind}${i}`, kind, folder: '2026\\10\\28' });
        };
        add('사진', 30);
        add('영상', 2);
        add('바꾼 사진', 1);
        add('날짜 없음', 3);
        const a = S.pickSample(pool, { rand: seeded(1) });
        const b = S.pickSample(pool, { rand: seeded(7) });
        const count = (list, kind) => list.filter((x) => x.kind === kind).length;
        const keys = new Set(a.map((x) => x.key));
        const ordered = a.every((x, i) => i === 0 || S.KINDS.indexOf(a[i - 1].kind) <= S.KINDS.indexOf(x.kind));
        const photosA = a.filter((x) => x.kind === '사진').map((x) => x.key).join(',');
        const photosB = b.filter((x) => x.kind === '사진').map((x) => x.key).join(',');
        const small = S.pickSample(pool.slice(30, 34));
        const empty = S.pickSample([]);
        out.push(sub('48a 10개를 종류별로 골고루 (적은 종류는 다), 겹침 없음, 종류 순서, 다시 뽑으면 다른 사진, 후보가 적으면 전부',
          a.length === 10 && keys.size === 10 && count(a, '영상') === 2 && count(a, '바꾼 사진') === 1 && count(a, '날짜 없음') === 3 && count(a, '사진') === 4
          && ordered && photosA !== photosB && small.length === 4 && empty.length === 0
          && a.every((x) => pool[x.key].name === x.name && !('path' in x)),
          JSON.stringify({ a: a.map((x) => `${x.kind}:${x.key}`), photosB, small: small.length })));
      }

      // 48b 후보 만들기: 종류 판단 (그대로 사진 · 바꾼 사진 · 바꾼 영상 · 영상 · 날짜 없음), 백업 폴더 안의 위치,
      //     같은 결과 파일을 가리키는 중복은 한 번만, 화면에 가는 값에 전체 경로 없음
      {
        const backupRoot = path.join('X:\\', '사진백업');
        const at = (...p) => path.join(backupRoot, ...p);
        const job = {
          backupRoot,
          items: [
            { i: 0, status: 'done', src: 'S:\\a.jpg', finalPath: at('2026', '10', '28', 'a.jpg') },
            { i: 1, status: 'done', src: 'S:\\b.heic', converted: true, finalPath: at('2026', '10', '28', 'b.jpg') },
            { i: 2, status: 'done', src: 'S:\\c.mov', converted: true, finalPath: at('2026', '10', '29', 'c.mp4') },
            { i: 3, status: 'done', src: 'S:\\d.mp4', finalPath: at('2026', '10', '29', 'd.mp4') },
            { i: 4, status: 'done', src: 'S:\\e.jpg', finalPath: at('_날짜없음', 'e.jpg') },
            { i: 5, status: 'dup', src: 'S:\\a(1).jpg', dupOf: at('2026', '10', '28', 'a.jpg') }, // a.jpg 와 같은 결과 → 한 번만
            { i: 6, status: 'dup', src: 'S:\\a(2).jpg', dupOfItem: 0 }, // 이번 작업의 a.jpg → 한 번만
          ],
        };
        const pool = S.samplePool(job, job.items);
        const kinds = pool.map((p) => `${p.name}:${p.kind}`).join(',');
        const folders = pool.map((p) => p.folder).join('|');
        const shown = JSON.stringify(S.pickSample(pool));
        out.push(sub('48b 종류 판단 5가지, 백업 폴더 안 위치, 같은 결과 파일은 한 번만, 화면 값에 전체 경로 없음',
          kinds === 'a.jpg:사진,b.jpg:바꾼 사진,c.mp4:바꾼 영상,d.mp4:영상,e.jpg:날짜 없음'
          && folders === [path.join('2026', '10', '28'), path.join('2026', '10', '28'), path.join('2026', '10', '29'), path.join('2026', '10', '29'), '_날짜없음'].join('|')
          && !shown.includes('사진백업') && !shown.includes('X:'),
          JSON.stringify({ kinds, folders, shown: shown.slice(0, 200) })));
      }

      // 48c 샘플 처리 결과의 진짜 작업 정보로: 사진, 바꾼 영상(IMG_0103.MOV → mp4), 날짜 없음(noinfo.jpg)이 모두 뽑히고 파일이 실제로 있음
      if (env.full && env.full.job) {
        const job = env.full.job;
        const done = job.items.filter((it) => it.status === 'done' && it.finalPath);
        const pool = S.samplePool(job, done);
        const picked = S.pickSample(pool);
        const kinds = new Set(picked.map((x) => x.kind));
        const exist = picked.every((x) => fs.existsSync(S.samplePath(pool, x.key)));
        out.push(sub('48c 샘플 처리 결과: 사진 · 바꾼 영상 · 날짜 없음이 다 뽑히고, 열 파일이 실제로 있음',
          kinds.has('사진') && kinds.has('바꾼 영상') && kinds.has('날짜 없음') && exist && picked.length === Math.min(10, pool.length),
          JSON.stringify({ picked: picked.map((x) => `${x.kind}:${x.name}`), exist })));
      } else {
        out.push({ label: '48c 샘플 처리 결과', status: 'skip', detail: '이 파일만 돌려서 샘플 처리 결과가 없음' });
      }

      // 48d 열 파일 찾기: 이번 후보의 번호만 (음수 · 소수 · 글자 · 범위 밖 · 후보 없음은 null)
      {
        const pool = [{ path: 'X:\\a.jpg' }, { path: 'X:\\b.jpg' }];
        const ok = S.samplePath(pool, 1) === 'X:\\b.jpg';
        const bad = [S.samplePath(pool, -1), S.samplePath(pool, 1.5), S.samplePath(pool, '0'), S.samplePath(pool, 2), S.samplePath(null, 0), S.samplePath(pool, undefined)];
        out.push(sub('48d 여는 파일은 이번 후보 번호로만', ok && bad.every((v) => v === null), JSON.stringify(bad)));
      }

      // 48e 화면 연결과 읽기만: 확인 창(샘플 목록 · 다시 뽑기 · 나중에 · 결과를 말하는 버튼), preload 두 통로, main 처리,
      //     샘플 코드에 옮기기 · 지우기 · 쓰기 없음
      {
        const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
        const html = read('index.html');
        const pre = read('preload.js');
        const main = read('main.js');
        const lib = read('lib/clean-sample.js');
        const ask = html.slice(html.indexOf('async function askTrash'), html.indexOf("$('trashBtn').onclick"));
        const wired = html.includes('<dialog id="cleanDialog">') && html.includes('🔍 샘플 확인') && html.includes('id="cdResample"') && html.includes('id="cdLater"')
          && ask.includes('await confirmClean(') && !ask.includes('confirm(msg)') && html.includes('휴지통으로 옮기기') && html.includes('api.openCleanSample(s.key)')
          && pre.includes("'clean-sample'") && pre.includes("'clean-sample-open'")
          && main.includes("ipcMain.handle('clean-sample'") && main.includes("ipcMain.handle('clean-sample-open'") && main.includes('sample: sampleView(cleanSample)')
          && main.includes('openSample(cleanSample, key,');
        const readOnly = !/\.(rename|rm|unlink|rmdir|writeFile|appendFile|copyFile|mkdir|cp|truncate)(Sync)?\(|trashItem|require\('fs'\)/.test(lib);
        out.push(sub('48e 확인 창 연결 (샘플 목록, 다시 뽑기, 나중에, 결과를 말하는 버튼), 통로 두 개, 샘플 코드는 읽기만', wired && readOnly, JSON.stringify({ wired, readOnly })));
      }

      // 48f 샘플 열기를 가짜 openPath 로 실제로 돌려 보기 (#77 검증)
      //     이번 후보 번호만 열고, 없는 파일 · 열기 실패 · 이상한 번호는 쉬운 문장 오류. "다른 10개 뽑기"용 후보 수
      {
        const pool = [{ path: 'X:\\a.jpg', kind: '사진', name: 'a.jpg', folder: '2026' }, { path: 'X:\\없음.jpg', kind: '사진', name: '없음.jpg', folder: '2026' }];
        const opened = [];
        const deps = (fail) => ({ exists: (p) => p !== 'X:\\없음.jpg', openPath: async (p) => { opened.push(p); return fail ? '열 수 없음' : ''; } });
        const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
        const ok = (await S.openSample(pool, 0, deps(false))) === true;
        const errs = [
          await errOf(() => S.openSample(pool, 1, deps(false))),
          await errOf(() => S.openSample(pool, 0, deps(true))),
          await errOf(() => S.openSample(pool, 5, deps(false))),
          await errOf(() => S.openSample(null, 0, deps(false))),
        ];
        const errOk = errs[0] === '결과 파일을 찾지 못했어요' && errs[1] === '파일을 열지 못했어요' && errs[2] === '샘플을 다시 뽑아 주세요' && errs[3] === '샘플을 다시 뽑아 주세요';
        // 열린 건 이번 후보의 0번 두 번뿐 (정상 1번 + 열기 실패 1번). 없는 파일 · 이상한 번호는 열지 않음
        const openOk = opened.length === 2 && opened.every((p) => p === 'X:\\a.jpg');
        const ten = Array.from({ length: 10 }, (_, i) => ({ path: `X:\\${i}.jpg`, kind: '사진', name: `${i}.jpg`, folder: '' }));
        const v10 = S.sampleView(ten);
        const v11 = S.sampleView(ten.concat([{ path: 'X:\\10.jpg', kind: '사진', name: '10.jpg', folder: '' }]));
        const viewOk = v10.total === 10 && v10.items.length === 10 && v11.total === 11 && v11.items.length === 10 && S.sampleView(null).total === 0;
        // 화면: 후보가 보여 준 것보다 많을 때만 "다른 10개 뽑기"가 켜짐 (딱 10개면 꺼짐)
        const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
        const btnOk = html.includes('const more = total > list.length;') && html.includes("$('cdResample').disabled = !more;");
        out.push(sub('48f 샘플 열기를 가짜 openPath로 돌림 (이번 후보만, 쉬운 오류 문장), 후보가 10개 넘을 때만 다시 뽑기', ok && errOk && openOk && viewOk && btnOk,
          JSON.stringify({ ok, errs, opened, viewOk, btnOk })));
      }

      // 48g 지난 작업의 샘플 후보를 비움 (작업 끝내기, 새 작업, 정리 끝) + 폴더 열기는 실제 폴더만 (#77 검증)
      {
        const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
        const block = (name) => {
          const at = main.indexOf(`ipcMain.handle('${name}'`);
          return at < 0 ? '' : main.slice(at, main.indexOf('\n});', at));
        };
        const reset = /function resetCleanCheck\(\) \{[^}]*cleanSample = null;/.test(main);
        const used = ['close-job', 'start-job', 'trash-originals'].every((n) => block(n).includes('resetCleanCheck();'));
        const { openFolderOnly } = require('../lib/open-folder');
        const opened = [];
        const deps = { isDir: (p) => { if (p === 'X:\\없음') throw new Error('ENOENT'); return p === 'X:\\폴더'; }, openPath: async (p) => { opened.push(p); return ''; } };
        const res = [
          await openFolderOnly('X:\\폴더', deps),
          await openFolderOnly('X:\\파일.exe', deps),
          await openFolderOnly('X:\\없음', deps),
          await openFolderOnly('', deps),
          await openFolderOnly(null, deps),
          await openFolderOnly({}, deps),
        ];
        const folderOk = JSON.stringify(res) === JSON.stringify([true, false, false, false, false, false]) && opened.length === 1 && opened[0] === 'X:\\폴더';
        const wired = main.includes("ipcMain.handle('open-folder', async (e, p) => openFolderOnly(p,");
        out.push(sub('48g 작업 끝내기, 새 작업, 정리 끝에 샘플 후보 비움, 폴더 열기는 실제 폴더만', reset && used && folderOk && wired,
          JSON.stringify({ reset, used, res, opened, wired })));
      }
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

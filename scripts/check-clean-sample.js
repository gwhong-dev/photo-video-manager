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
          && main.includes("ipcMain.handle('clean-sample'") && main.includes("ipcMain.handle('clean-sample-open'") && main.includes('sample: pickSample(cleanSample)')
          && main.includes('samplePath(cleanSample, key)');
        const readOnly = !/\.(rename|rm|unlink|rmdir|writeFile|appendFile|copyFile|mkdir|cp|truncate)(Sync)?\(|trashItem|require\('fs'\)/.test(lib);
        out.push(sub('48e 확인 창 연결 (샘플 목록, 다시 뽑기, 나중에, 결과를 말하는 버튼), 통로 두 개, 샘플 코드는 읽기만', wired && readOnly, JSON.stringify({ wired, readOnly })));
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

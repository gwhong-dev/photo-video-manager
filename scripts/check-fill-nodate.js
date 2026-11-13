// 파일 위치: scripts/check-fill-nodate.js
// 역할: "날짜없음 채우기" 점검 항목 (50번). scripts/check.js 의 ITEMS 끝에 붙어서 같이 돌아요.
//   빠르게 이 파일만 돌려 볼 때: node scripts/check-fill-nodate.js
//
// ⚠️ 실제 사진과 실제 userData 는 쓰지 않아요. 가짜 백업 폴더와 가짜 iCloud 앨범 폴더를
//    점검 임시 폴더(env.tmp) 안에 만들어서 옮기기, 되돌리기를 해 봐요.
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { sub } = require('./check-gallery');

const sha = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
const w = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
// 12:00 GMT → 어느 시간대에서도 같은 날짜가 되는 시각
const info = (photos) => JSON.stringify({ photos: photos.map(([name, date]) => ({ name, dateCreated: `Sunday ${date} 12:00 PM GMT` })) });

// 가짜 환경: 백업 폴더(_날짜없음에 파일 여러 개) + iCloud 앨범 폴더 두 개
function build(tmp, tag) {
  const base = path.join(tmp, `fill-${tag}`);
  const root = path.join(base, 'backup');
  const nd = path.join(root, '_날짜없음');
  const albums = path.join(base, 'Shared Albums');
  w(path.join(albums, '가족여행', 'AlbumInfo.json'), info([['IMG_1.JPG', 'August 14,2022'], ['IMG_2.JPG', 'August 15,2022'], ['DUP.JPG', 'August 14,2022'], ['TWIN.JPG', 'May 1,2021']]));
  w(path.join(albums, '친구들', 'AlbumInfo.json'), info([['TWIN.JPG', 'June 2,2021'], ['IMG_9.JPG', 'July 7,2020']]));
  w(path.join(nd, 'IMG_1.JPG'), 'photo-one');
  w(path.join(nd, 'IMG_2.JPG'), 'photo-two');
  w(path.join(nd, 'DUP.JPG'), 'same-bytes');
  w(path.join(nd, 'TWIN.JPG'), 'twin');
  w(path.join(nd, 'NONE.JPG'), 'no album info');
  w(path.join(nd, 'IMG_9.JPG'), 'friends nine');
  w(path.join(nd, 'KEEP.JPG'), 'manual');
  w(path.join(root, '2022', '08', '14', '2022-08-14_140000_DUP.jpg'), 'same-bytes'); // 이미 있는 같은 내용
  const old = new Date('2020-01-02T03:04:05Z');
  for (const n of fs.readdirSync(nd)) fs.utimesSync(path.join(nd, n), old, old);
  return { base, root, nd, albums, logs: path.join(base, 'logs'), journal: path.join(base, 'fill-nodate') };
}

const items = [
  {
    no: 50,
    name: '날짜없음 채우기 (앨범 정보 날짜로 날짜 폴더에 옮기기, 되돌리기)',
    async run(env) {
      const out = [];
      const F = require('../lib/fill-nodate');
      const { createLogger } = require('../lib/logger');

      // 50a 가져오기 기록의 원본 폴더에서 날짜를 찾아요 (고른 앨범 폴더 없이)
      {
        const e = build(env.tmp, 'a');
        const src = path.join(e.albums, '가족여행');
        const jobs = path.join(e.base, 'jobs');
        w(path.join(jobs, 'done', '2026-11-01_000000_done.json'), JSON.stringify({ items: [
          { status: 'done', src: path.join(src, 'IMG_1.JPG'), finalPath: path.join(e.nd, 'IMG_1.JPG') },
          { status: 'done', src: path.join(src, 'IMG_2.JPG'), finalPath: path.join(e.nd, 'IMG_2.JPG') },
          { status: 'done', src: path.join(src, 'X.JPG'), finalPath: path.join(e.root, '2020', '01', '01', 'X.jpg') }, // 날짜없음이 아니면 안 봐요
        ] }));
        const history = F.historyFromJobs(jobs);
        const plan = await F.planFill({ root: e.root, history });
        const byName = Object.fromEntries(plan.items.map((it) => [it.name, it]));
        out.push(sub('50a 가져오기 기록의 원본 폴더 앨범 정보로 날짜를 찾음 (날짜없음 파일만 기록에서 읽음)',
          history.size === 2 && plan.counts.move === 2 && byName['IMG_1.JPG'].day === '2022-08-14' && byName['IMG_2.JPG'].day === '2022-08-15'
          && byName['IMG_1.JPG'].via === 'job' && plan.counts.noDate === 5, JSON.stringify(plan.counts)));
        out.push(sub('50b 새 이름은 가져올 때와 같은 규칙 (날짜 앞붙이기), 폴더는 연\\월\\일',
          /^2022-08-14_\d{6}_IMG_1\.jpg$/.test(byName['IMG_1.JPG'].newName) && path.join('2022', '08', '14') === byName['IMG_1.JPG'].relDir
          && byName['IMG_1.JPG'].dest === path.join(e.root, '2022', '08', '14', byName['IMG_1.JPG'].newName), byName['IMG_1.JPG'].newName));
        // 미리보기는 읽기만
        out.push(sub('50c 미리보기는 아무것도 옮기지 않음', fs.readdirSync(e.nd).length === 7 && !fs.existsSync(path.join(e.root, '2022', '08', '15'))));
      }

      // 50d 고른 앨범 폴더에서 이름으로 찾기 + 날짜가 다른 같은 이름은 건너뜀 + 못 찾은 파일은 그대로
      {
        const e = build(env.tmp, 'd');
        const plan = await F.planFill({ root: e.root, albumDirs: [e.albums] });
        const by = Object.fromEntries(plan.items.map((it) => [it.name, it]));
        out.push(sub('50d 고른 앨범 폴더에서 파일 이름으로 찾음, 날짜가 다른 같은 이름(TWIN)은 건너뜀, 정보가 없는 파일은 그대로',
          by['IMG_9.JPG'].status === 'move' && by['IMG_9.JPG'].day === '2020-07-07' && by['IMG_9.JPG'].via === 'folder'
          && by['TWIN.JPG'].status === 'ambiguous' && by['NONE.JPG'].status === 'nodate', JSON.stringify(plan.counts)));
        // 50e 겹침: 같은 내용은 옮기지 않고 (이미 있음), 이름만 같고 내용이 다르면 _1
        // 계획이 정한 IMG_2 자리에 이름은 같고 내용이 다른 파일을 먼저 만들어 둬요
        const first = plan.items.find((it) => it.name === 'IMG_2.JPG');
        w(first.dest, 'other bytes');
        const plan3 = await F.planFill({ root: e.root, albumDirs: [e.albums] });
        const by3 = Object.fromEntries(plan3.items.map((it) => [it.name, it]));
        out.push(sub('50e 이름이 같고 내용이 다르면 _1 로 옮기고 덮어쓰지 않음, 내용이 같으면 "이미 있음"으로 두고 옮기지 않음',
          /_1\.jpg$/.test(by3['IMG_2.JPG'].newName) && by3['IMG_2.JPG'].status === 'move' && by3['DUP.JPG'].status === 'dup' && plan3.counts.dup === 1,
          `${by3['IMG_2.JPG'].newName} ${by3['DUP.JPG'].status}`));
        // 50f 직접 넣은 값이 있는 파일은 건너뜀
        const plan4 = await F.planFill({ root: e.root, albumDirs: [e.albums], isProtected: (p) => path.basename(p) === 'IMG_9.JPG' });
        out.push(sub('50f 직접 넣은 날짜·태그가 있는 파일은 옮기지 않음', plan4.items.find((it) => it.name === 'IMG_9.JPG').status === 'protected' && plan4.counts.protected === 1));
      }

      // 50g 실행: 이동만 (내용 · 수정 시각 그대로), 로그와 되돌리기 기록, 실행 직전에 생긴 같은 이름은 덮어쓰지 않음
      {
        const e = build(env.tmp, 'g');
        const plan = await F.planFill({ root: e.root, albumDirs: [e.albums] });
        const moves = plan.items.filter((it) => it.status === 'move');
        const before = Object.fromEntries(moves.map((it) => [it.name, { hash: sha(it.from), mtime: fs.statSync(it.from).mtimeMs }]));
        // 계획을 세운 뒤에 IMG_1 의 자리에 같은 이름이 생김 → 덮어쓰면 안 돼요
        const one = moves.find((it) => it.name === 'IMG_1.JPG');
        const origDest = one.dest;
        w(origDest, 'someone else');
        const r = await F.runFill({ root: e.root, items: plan.items, logger: createLogger(e.logs), journalDir: e.journal });
        const after = moves.map((it) => ({ it, ok: !fs.existsSync(it.from) && fs.existsSync(it.dest) && sha(it.dest) === before[it.name].hash && Math.abs(fs.statSync(it.dest).mtimeMs - before[it.name].mtime) < 2000 }));
        out.push(sub('50g 실행하면 파일만 옮겨짐 (내용 · 수정 시각 그대로, 원래 자리는 비고, 날짜 폴더 파일은 그대로, 못 찾은 파일은 그대로)',
          r.moved === moves.length && after.every((x) => x.ok) && fs.existsSync(path.join(e.nd, 'NONE.JPG')) && fs.existsSync(path.join(e.nd, 'TWIN.JPG')) && fs.existsSync(path.join(e.nd, 'DUP.JPG')),
          JSON.stringify(r)));
        out.push(sub('50h 실행 직전에 생긴 같은 이름은 덮어쓰지 않고 _번호로 옮김', fs.readFileSync(origDest, 'utf8') === 'someone else' && /_1\.jpg$/.test(one.dest) && fs.existsSync(one.dest)));
        const log = fs.readFileSync(r.logPath, 'utf8');
        const journal = fs.readFileSync(r.journalPath, 'utf8');
        out.push(sub('50i 로그에 예정 · 옮김 줄, 되돌리기 기록에 이전 → 새 경로가 남음', (log.match(/\t예정\t/g) || []).length === moves.length && (log.match(/\t옮김\t/g) || []).length === moves.length
          && (journal.match(/"type":"move"/g) || []).length === moves.length));

        // 50j 되돌리기: 원래 자리로, 빈 날짜 폴더는 정리, 두 번째는 거절
        const last = F.lastFillRun(e.journal, e.root);
        out.push(sub('50j 되돌리지 않은 가장 최근 묶음이 보임 (다른 백업 폴더는 안 보임)', !!last && last.count === moves.length && F.lastFillRun(e.journal, path.join(e.base, 'other')) === null));
        const u = await F.undoFill({ journalPath: last.journalPath, logger: createLogger(e.logs) });
        const restoredAll = moves.every((it) => fs.existsSync(it.from) && sha(it.from) === before[it.name].hash);
        out.push(sub('50k 되돌리면 모두 원래 자리로 돌아오고, 비워진 날짜 폴더는 정리되고, 원래 있던 다른 파일은 그대로',
          u.restored === moves.length && restoredAll && !fs.existsSync(path.join(e.root, '2020', '07', '07')) && fs.existsSync(path.join(e.root, '2022', '08', '14', '2022-08-14_140000_DUP.jpg')),
          JSON.stringify(u)));
        let again = null;
        try {
          await F.undoFill({ journalPath: last.journalPath, logger: createLogger(e.logs) });
        } catch (err) {
          again = err.message;
        }
        out.push(sub('50l 같은 묶음을 두 번 되돌릴 수 없고, 되돌린 묶음은 더 이상 목록에 안 나옴', !!again && F.lastFillRun(e.journal, e.root) === null, String(again)));
      }

      // 50m 되돌릴 때 원래 자리에 같은 이름이 생겼으면 덮어쓰지 않음
      {
        const e = build(env.tmp, 'm');
        const plan = await F.planFill({ root: e.root, albumDirs: [e.albums] });
        const r = await F.runFill({ root: e.root, items: plan.items, logger: createLogger(e.logs), journalDir: e.journal });
        w(path.join(e.nd, 'IMG_9.JPG'), 'new file with the same name');
        const u = await F.undoFill({ journalPath: r.journalPath, logger: createLogger(e.logs) });
        out.push(sub('50m 원래 자리에 같은 이름이 새로 생겼으면 덮어쓰지 않고 건너뜀', fs.readFileSync(path.join(e.nd, 'IMG_9.JPG'), 'utf8') === 'new file with the same name' && u.fail === 1 && u.restored === r.moved - 1, JSON.stringify(u)));
      }

      // 50n 안전 확인: 조작된 계획(_날짜없음 밖의 파일 · 백업 폴더 밖 도착)은 옮기지 않음
      {
        const e = build(env.tmp, 'n');
        const outside = path.join(e.base, 'outside.jpg');
        w(outside, 'outside');
        const evil = [
          { status: 'move', from: outside, dest: path.join(e.root, '2020', '01', '01', 'x.jpg') },
          { status: 'move', from: path.join(e.nd, 'IMG_1.JPG'), dest: path.join(e.base, 'escape', 'x.jpg') },
          { status: 'move', from: path.join(e.nd, 'IMG_2.JPG'), dest: path.join(e.nd, 'again.jpg') },
        ];
        const r = await F.runFill({ root: e.root, items: evil, logger: createLogger(e.logs), journalDir: e.journal });
        out.push(sub('50n 계획이 이상해도 _날짜없음 밖 파일, 백업 폴더 밖 도착, 날짜없음 안 도착은 옮기지 않음',
          r.moved === 0 && r.fail === 3 && fs.existsSync(outside) && fs.existsSync(path.join(e.nd, 'IMG_1.JPG')) && !fs.existsSync(path.join(e.base, 'escape')), JSON.stringify(r)));
      }

      // 50o 글자 점검: 삭제 호출이 없고, 화면 연결이 있음
      {
        const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fill-nodate.js'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
        const gm = fs.readFileSync(path.join(__dirname, '..', 'gallery-main.js'), 'utf8');
        const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
        out.push(sub('50o 날짜 채우기 코드에 삭제 · 복사 · 덮어쓰기 호출이 없고(이동 rename 만), 갤러리와 화면이 연결됨',
          !/unlinkSync|rmSync|\.unlink\(|\.rm\(|trashItem|copyFile|writeFile\b/.test(lib) && lib.includes('renameSync')
          && gm.includes("'gallery:fill-preview'") && gm.includes("'gallery:fill-run'") && gm.includes("'gallery:fill-undo'") && pre.includes('fillRun')));
      }
      return out;
    },
  },
];

module.exports = { items };

// 이 파일만 돌릴 때
if (require.main === module) {
  (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvm-check-'));
    let failed = false;
    for (const it of items) {
      const rows = await it.run({ tmp });
      for (const r of rows) {
        if (r.status !== 'ok') failed = true;
        console.log(`${r.status === 'ok' ? '✅' : '❌'} ${r.label}${r.status === 'ok' ? '' : ` — ${r.detail}`}`);
      }
    }
    if (!failed) fs.rmSync(tmp, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
  })();
}

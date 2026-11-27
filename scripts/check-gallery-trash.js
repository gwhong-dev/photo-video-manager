// 파일 위치: scripts/check-gallery-trash.js
// 역할: 갤러리에서 고른 사진을 휴지통으로 옮기기 점검 (56). scripts/check.js 의 ITEMS 끝에 붙어요
//   2026-11-16 사용자 결정: "기본은 사진첩, 보고 필요 없는 건 바로 삭제할 수 있게"
//   ⚠️ 진짜 휴지통은 쓰지 않아요. 임시 폴더의 가짜 파일로만 옮겨 봐요
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const { sub, row, withDb } = require('./check-gallery');

const items = [
  {
    no: 56,
    name: '갤러리에서 고른 사진 휴지통으로',
    async run(env) {
      const out = [];
      const D = require('../lib/similar-discard');
      const { createLogger } = require('../lib/logger');
      const V = await import('../src/trash-view.mjs');

      // 56a 확인(checkSelected): 묶음 조건 없이 고른 사진 · 영상만, 사라진 파일 · 다른 폴더 · 이상한 번호는 거절
      await withDb(env, 'gallery-trash', async (db) => {
        db.upsertFiles([
          row({ root: 'R1', path: 'R1/a.jpg', name: 'a.jpg', takenAt: '2026-02-01T10:00:00', takenDay: '2026-02-01' }),
          row({ root: 'R1', path: 'R1/b.jpg', name: 'b.jpg', takenAt: '2026-02-01T10:00:00', takenDay: '2026-02-01' }),
          row({ root: 'R1', path: 'R1/b.mp4', name: 'b.mp4', mediaType: 'video', takenAt: '2026-02-01T10:00:01', takenDay: '2026-02-01', durationSec: 2.5 }),
          row({ root: 'R1', path: 'R1/c.mov', name: 'c.mov', mediaType: 'video', takenAt: '2026-02-01T11:00:00', takenDay: '2026-02-01', durationSec: 30 }),
          row({ root: 'R2', path: 'R2/z.jpg', name: 'z.jpg' }),
        ]);
        const all = db.similarRows('R1');
        const idOf = (n) => {
          const r = all.find((x) => x.name === n);
          if (r) return r.id;
          // 영상은 similarRows 에 없어서 같은 이름으로 찾아요
          return db.sameStem('R1', `R1/${path.parse(n).name}`).find((x) => x.name === n).id;
        };
        const zId = db.similarRows('R2').find((x) => x.name === 'z.jpg').id;
        const err = (ids) => { try { D.checkSelected(db, 'R1', ids); return null; } catch (e) { return e.message; } };

        // 한 장만 골라도 됨 (비슷한 사진처럼 "묶음마다 한 장 남기기" 조건이 없어요)
        const one = D.checkSelected(db, 'R1', [idOf('a.jpg')]);
        // 사진 + 그 짝 영상(라이브 포토)
        const withPair = D.checkSelected(db, 'R1', [idOf('b.jpg')]);
        // 사진과 짝 영상을 둘 다 골랐으면 짝 영상은 그 파일로 한 번만
        const both = D.checkSelected(db, 'R1', [idOf('b.jpg'), idOf('b.mp4')]);
        // 일반 영상만
        const video = D.checkSelected(db, 'R1', [idOf('c.mov')]);
        out.push(sub('56a 묶음 조건 없이 고른 사진 · 영상을 옮길 수 있음 (한 장, 라이브 포토 짝 영상은 같이, 짝 영상을 직접 골랐으면 한 번만, 일반 영상)',
          one.files.length === 1 && one.files[0].path === 'R1/a.jpg' && one.files[0].pair === null && one.files[0].keepers === undefined && one.groups === 0
            && withPair.files[0].pair && withPair.files[0].pair.path === 'R1/b.mp4'
            && both.files.length === 2 && both.files.every((f) => f.pair === null)
            && video.files.length === 1 && video.files[0].path === 'R1/c.mov',
          JSON.stringify({ one: one.files[0].pair, withPair: withPair.files[0].pair, both: both.files.map((f) => f.pair) })));

        // 짝 영상만 고르면 영상만 (#119 검증 ⚠️)
        const onlyVideo = D.checkSelected(db, 'R1', [idOf('b.mp4')]);
        // 같은 이름 사진 둘(d.jpg · d.heic)과 짝 영상 d.mov: 하나만 고르면 짝 영상은 안 옮김(다른 사진의 짝일 수 있음),
        //   둘 다 고르면 번호가 작은 한 장에만 짝 영상이 붙고 siblings 에 다른 한 장 (기존 비슷한 사진 규칙)
        db.upsertFiles([
          row({ root: 'R1', path: 'R1/d.jpg', name: 'd.jpg', takenAt: '2026-03-01T10:00:00', takenDay: '2026-03-01' }),
          row({ root: 'R1', path: 'R1/d.heic', name: 'd.heic', takenAt: '2026-03-01T10:00:00', takenDay: '2026-03-01' }),
          row({ root: 'R1', path: 'R1/d.mov', name: 'd.mov', mediaType: 'video', takenAt: '2026-03-01T10:00:01', takenDay: '2026-03-01', durationSec: 2 }),
        ]);
        const dRows = db.similarRows('R1');
        const dId = (n) => dRows.find((x) => x.name === n).id;
        const dOne = D.checkSelected(db, 'R1', [dId('d.jpg')]);
        const dBoth = D.checkSelected(db, 'R1', [dId('d.jpg'), dId('d.heic')]);
        const withPairs = dBoth.files.filter((f) => f.pair);
        out.push(sub('56a 짝 영상만 고르면 영상만, 같은 이름 사진 둘 중 하나만 고르면 짝 영상은 그대로, 둘 다 고르면 한 장에만 짝 영상(다른 한 장은 siblings)',
          onlyVideo.files.length === 1 && onlyVideo.files[0].path === 'R1/b.mp4' && onlyVideo.files[0].pair === null
            && dOne.files[0].pair === null
            && withPairs.length === 1 && withPairs[0].pair.path === 'R1/d.mov' && withPairs[0].pair.siblings.length === 1,
          JSON.stringify({ onlyVideo: onlyVideo.files.map((f) => [f.path, f.pair]), dOne: dOne.files[0].pair, dBoth: dBoth.files.map((f) => f.pair && f.pair.siblings) })));

        db.setMissing(['R1/a.jpg'], 1);
        out.push(sub('56a 사라진 파일, 다른 백업 폴더의 사진, 빈 목록, 같은 번호 두 번, 이상한 번호는 거절',
          !!err([idOf('a.jpg')]) && !!err([zId]) && !!err([]) && !!err(null) && !!err([idOf('b.jpg'), idOf('b.jpg')]) && !!err(['x']) && !!err([0]),
          [err([idOf('a.jpg')]), err([zId]), err([])].join(' / ')));
      });

      // 56b 실제로 옮기기 (임시 폴더): 하드디스크 → 휴지통(가짜), USB → _정리완료원본, 백업 폴더 밖 · 바뀐 파일은 안 옮김, 로그
      {
        const base = path.join(env.tmp, 'gallery-trash');
        const root = path.join(base, 'backup');
        fs.mkdirSync(path.join(root, 'hdd'), { recursive: true });
        fs.mkdirSync(path.join(root, 'usb'), { recursive: true });
        const put = (rel, text = 'x') => {
          const p = path.join(root, rel);
          fs.writeFileSync(p, text);
          const st = fs.statSync(p);
          return { path: p, size: st.size, mtimeMs: st.mtimeMs };
        };
        const a = put(path.join('hdd', 'a.jpg'));
        const v = put(path.join('hdd', 'v.mp4'), 'video');
        const u = put(path.join('usb', 'u.jpg'));
        const changed = put(path.join('hdd', 'changed.jpg'));
        fs.writeFileSync(changed.path, 'changed after preview'); // 미리보기 뒤에 바뀐 파일
        const outside = path.join(base, 'outside.jpg');
        fs.writeFileSync(outside, 'x');
        const bin = [];
        const trash = async (p) => { bin.push(p); fs.rmSync(p); }; // 점검에서는 휴지통 대신 지워요 (임시 폴더의 가짜 파일)
        const driveKindOf = async (p) => (p.includes(`${path.sep}usb${path.sep}`) ? 'removable' : 'fixed');
        const recycleOf = async () => null;
        const list = [a, v, u, changed, { path: outside, size: 1, mtimeMs: null }].map((f, i) => ({ id: i + 1, name: path.basename(f.path), pair: null, ...f }));
        const info = await D.discardInfo(list, { driveKindOf, recycleOf });
        const logDir = path.join(base, 'logs');
        const r = await D.discardFiles({ root, files: list, trash, driveKindOf, recycleOf, logger: createLogger(logDir), logKind: 'gallery-trash', logTitle: '갤러리에서 휴지통으로' });
        const logs = fs.readdirSync(logDir);
        const logText = logs.map((n) => fs.readFileSync(path.join(logDir, n), 'utf8')).join('\n');
        out.push(sub('56b 고른 사진 · 영상을 휴지통으로(하드디스크), USB 는 _정리완료원본으로, 미리보기 뒤 바뀐 파일과 백업 폴더 밖은 그대로',
          info.count === 5 && info.trash === 4 && info.move === 1
            && r.trashed === 2 && r.moved === 1 && r.fail === 2 && bin.length === 2
            && !fs.existsSync(a.path) && !fs.existsSync(v.path) && fs.existsSync(path.join(root, '_정리완료원본', 'usb', 'u.jpg'))
            && fs.existsSync(changed.path) && fs.existsSync(outside),
          JSON.stringify({ info: { count: info.count, trash: info.trash, move: info.move }, r: { trashed: r.trashed, moved: r.moved, fail: r.fail } })));
        out.push(sub('56b 로그는 gallery-trash 이름, 첫 줄 "갤러리에서 휴지통으로", 옮기기 전에 예정 줄',
          logs.length === 1 && logs[0].startsWith('gallery-trash') && /^# 갤러리에서 휴지통으로/.test(logText) && /예정\(휴지통\)/.test(logText) && /\t휴지통\t/.test(logText),
          logs.join(', ')));
      }

      // 56c 확인 창 글 · 버튼 · Delete 키
      {
        const lines = V.trashLines({ count: 3, trash: 2, move: 1, pairs: 1, warnings: ['G:\\ 드라이브: 넘어요'] });
        out.push(sub('56c 확인 창: 몇 장이 휴지통 · _정리완료원본으로 가는지, 짝 영상, 주의. 버튼은 결과를 말함',
          lines[0] === '고른 3장을 옮겨요.' && lines.includes('휴지통으로 2장') && lines.some((l) => l.includes('_정리완료원본 폴더로 1장')) && lines.some((l) => l.includes('짝 영상 1개'))
            && lines.at(-1) === '주의: G:\\ 드라이브: 넘어요'
            && V.trashLabel({ count: 3, trash: 3, move: 0 }) === '3장 휴지통으로 옮기기' && V.trashLabel({ count: 2, trash: 0, move: 2 }) === '2장 정리완료원본 폴더로 옮기기'
            && V.trashLabel({ count: 0 }) === '' && V.trashMenuLabel(1234) === '1,234장 휴지통으로 옮기기',
          lines.join(' | ')));
        // 안내 한 줄은 어디서 되살릴 수 있는지 사실대로 (#119 검증 ⚠️: 전부 _정리완료원본이거나 휴지통이 넘쳐도 "휴지통에서 되살릴 수 있어요" 였음)
        out.push(sub('56c 확인 창 안내: 휴지통만 / _정리완료원본만 / 섞임 / 휴지통 주의가 있을 때 각각 맞는 글',
          V.trashHint({ count: 2, trash: 2, move: 0 }).includes('휴지통에서 되살릴 수 있어요')
            && V.trashHint({ count: 2, trash: 0, move: 2 }).includes('_정리완료원본 폴더에서 되돌릴 수 있어요')
            && V.trashHint({ count: 2, trash: 1, move: 1 }).includes('휴지통이나 _정리완료원본')
            && V.trashHint({ count: 2, trash: 2, move: 0, warnings: ['넘어요'] }).includes('위의 주의를 먼저')
            && V.trashHint({ count: 0 }) === ''));
        // 비슷한 사진 화면의 확인 창도 같은 글 (나중에 할 일 14번). 같은 영상 창은 "영상 파일"
        out.push(sub('56c 비슷한 사진 확인 창 안내: 영상은 "영상 파일" 로, _정리완료원본만이면 휴지통이라고 하지 않음',
          V.trashHint({ count: 2, trash: 0, move: 2 }, '영상') === '영상 파일은 지우지 않아요. _정리완료원본 폴더에서 되돌릴 수 있어요.'
            && V.trashHint({ count: 1, trash: 1, move: 0 }).startsWith('사진 파일은')));
        const el = (tagName, extra = {}) => ({ tagName, ...extra });
        out.push(sub('56c Delete 키는 격자에서만 창을 열고, 글 쓰는 칸 · 다른 창이 열려 있으면 안 엶 (Backspace 는 안 엶)',
          V.deleteKeyOpens('Delete', el('BUTTON'), false) && V.deleteKeyOpens('Delete', el('DIV'), false) && V.deleteKeyOpens('Delete', null, false)
            && !V.deleteKeyOpens('Delete', el('INPUT'), false) && !V.deleteKeyOpens('Delete', el('textarea'), false)
            && !V.deleteKeyOpens('Delete', el('DIV', { isContentEditable: true }), false)
            && !V.deleteKeyOpens('Delete', el('DIV'), true) && !V.deleteKeyOpens('Backspace', el('DIV'), false)));
      }

      // 56d 화면 연결: 오른쪽 패널 · 우클릭 메뉴 · App (Delete 키, 확인 창) · main · preload 가 이어져 있음
      {
        const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
        const app = read('src/App.jsx');
        const gm = read('gallery-main.js');
        const pre = read('preload.js');
        const api = read('src/api.js');
        const ok = /onTrash/.test(read('src/components/DetailPanel.jsx')) && /onTrash/.test(read('src/components/ContextMenu.jsx'))
          && /<TrashDialog/.test(app) && /deleteKeyOpens\(/.test(app) && /screen === 'gallery' \|\| screen === 'missing'/.test(app)
          && /'gallery:trash-preview'/.test(gm) && /'gallery:trash-selected'/.test(gm) && /checkSelected\(db, root, ids\)/.test(gm) && /logKind: 'gallery-trash'/.test(gm)
          && /trashSelected: \(ids\) => ipcRenderer\.invoke\('gallery:trash-selected', ids\)/.test(pre) && /previewTrash/.test(api);
        out.push(sub('56d 오른쪽 패널 · 우클릭 메뉴 · Delete 키 → 확인 창 → main(gallery:trash-selected) 연결, 갤러리 · 정보 없는 사진 화면에서만', ok));
      }

      // 56e 진짜 앱: 사진 하나를 누르면 오른쪽 패널에 "1장 휴지통으로 옮기기", Delete 키로 확인 창(미리보기),
      //     "그만두기"로 닫으면 아무것도 안 옮겨짐, 우클릭 메뉴에도 같은 항목. 진짜 휴지통은 쓰지 않아요 (옮기기는 누르지 않음)
      {
        const { launchCheck } = require('./launch-check');
        const { makeImage } = require('./check-similar');
        const root = path.join(env.tmp, 'launch-gallery-trash-root');
        for (const [name, seed] of [['t1.jpg', 3], ['t2.jpg', 9], ['t3.jpg', 21]]) await makeImage(path.join(root, name), { seed });
        const names = () => fs.readdirSync(root).sort().join(',');
        const before = names();
        const ud = path.join(env.tmp, 'launch-gallery-trash-ud');
        fs.mkdirSync(ud, { recursive: true });
        fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ backupRoot: root }), 'utf8');
        const r = await launchCheck(path.join(__dirname, '..'), {
          env: { PVM_USER_DATA: ud },
          until: '백업 폴더 다시 읽기',
          untilMs: 30000,
          probe: `(${trashProbe.toString()})()`,
        });
        const q = r.probed || {};
        const seen = JSON.stringify(q).slice(0, 600);
        out.push(sub('56e 진짜 앱: 사진을 고르면 오른쪽 패널에 "1장 휴지통으로 옮기기", Delete 키로 확인 창(고른 1장, 휴지통으로 1장 또는 _정리완료원본)',
          q.panelButton === '1장 휴지통으로 옮기기' && /고른 1장을 옮겨요/.test(q.dialogText || '') && /1장 (휴지통|정리완료원본 폴더)으로 옮기기/.test(q.goLabel || '') && q.focusCancel === true, seen));
        out.push(sub('56e 그만두기로 닫으면 파일 그대로, 우클릭 메뉴에도 "1장 휴지통으로 옮기기", 화면 오류 없음',
          q.closed === true && names() === before && q.menuItem === '1장 휴지통으로 옮기기' && !(r.errors || []).some((e) => !/Failed to load resource/.test(e)),
          `${seen} / 오류 ${(r.errors || []).length}개`));
      }
      return out;
    },
  },
];

// 진짜 앱 창 안에서 도는 확인 (launch-check 의 probe). 버튼 · 키만 눌러 보고 옮기기는 누르지 않아요
async function trashProbe() {
  const wait = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await new Promise((res) => setTimeout(res, 100));
    }
  };
  const q = {};
  const cells = await wait(() => document.querySelectorAll('button.cell').length >= 3, 30000);
  if (!cells) return { stop: '사진 칸이 3개가 안 돼요' };
  const cell = document.querySelector('button.cell');
  cell.click();
  const btn = await wait(() => document.querySelector('.panel-actions .trash-button'));
  q.panelButton = btn ? btn.innerText.trim() : null;
  // Delete 키 → 확인 창
  cell.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  const dlg = await wait(() => {
    const d = document.querySelector('[aria-labelledby="trash-title"]');
    return d && /옮겨요/.test(d.innerText) ? d : null;
  });
  if (!dlg) return { ...q, stop: 'Delete 키로 확인 창이 안 열려요' };
  q.dialogText = dlg.innerText;
  q.focusCancel = (document.activeElement && document.activeElement.innerText.trim()) === '그만두기';
  const foot = [...dlg.querySelectorAll('.dialog-foot button')];
  q.goLabel = foot[1] ? foot[1].innerText.trim() : null;
  foot[0].click(); // 그만두기 (옮기지 않아요)
  q.closed = !!(await wait(() => !document.querySelector('[aria-labelledby="trash-title"]')));
  // 우클릭 메뉴
  cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
  const item = await wait(() => document.querySelector('.context-menu .trash-button'));
  q.menuItem = item ? item.innerText.trim() : null;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return q;
}

module.exports = { items };

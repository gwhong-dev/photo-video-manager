// 파일 위치: scripts/check-trash-fast.js
// 역할: 휴지통 확인 창 바로 뜨게 + Delete 두 번으로 옮기기 점검 (62). scripts/check.js 의 ITEMS 끝에 붙어요
//   2026-11-21 사용자 지적: "삭제 누르면 왜 '그만두기'가 먼저 뜨고 1~2초 뒤에 휴지통 옮기기가 뜨지? DELETE 눌러도 삭제 가능하게"
//   원인: 확인 창을 열 때마다 PowerShell 로 드라이브 종류 · 휴지통 크기를 새로 읽었어요 → 미리보기만 잠깐 다시 써요 (lib/preview-drive.js)
//   ⚠️ 진짜 휴지통은 쓰지 않아요. 진짜 앱 확인에서도 옮기기는 누르지 않아요 (꾹 누른 Delete 가 무시되는지만 봐요)
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const { sub } = require('./check-gallery');

const items = [
  {
    no: 62,
    name: '휴지통 확인 창 바로 뜨게 + Delete 두 번',
    async run(env) {
      const out = [];
      const V = await import('../src/trash-view.mjs');
      const { createPreviewDrive } = require('../lib/preview-drive');

      // 62a 버튼 글자는 확인 결과 전에도 고른 장수로 보임, 결과가 오면 정확한 글자로
      out.push(sub('62a 확인 결과 전에도 버튼 글자 "3장 휴지통으로 옮기기", 결과 뒤에는 휴지통 / 정리완료원본 / 섞임 글자',
        V.trashLabel(null, 3) === '3장 휴지통으로 옮기기' && V.trashLabel(null, 0) === '' && V.trashLabel(null) === ''
          && V.trashLabel({ count: 2, trash: 0, move: 2 }, 2) === '2장 정리완료원본 폴더로 옮기기'
          && V.trashLabel({ count: 0 }, 3) === ''));

      // 62b Delete 키: 반복(꾹 누름) · 다른 키 · 옮기는 중 · 오류는 무시, 결과 전이면 기다렸다가, 결과 뒤면 바로
      {
        const ok = { info: { count: 2, trash: 2, move: 0 }, error: '', busy: false };
        const A = (e, s) => V.dialogDeleteAction(e, s);
        out.push(sub('62b 창에서 Delete = 옮기기, 꾹 눌러 반복된 키 · Enter · 옮기는 중 · 오류 · 0장 · 확인 결과 전(미리보기 후 실행)은 무시',
          A({ key: 'Delete' }, ok) === 'go'
            && A({ key: 'Delete', repeat: true }, ok) === 'ignore'
            && A({ key: 'Enter' }, ok) === 'ignore' && A({ key: 'Backspace' }, ok) === 'ignore'
            && A({ key: 'Delete' }, { ...ok, busy: true }) === 'ignore'
            && A({ key: 'Delete' }, { ...ok, error: '목록이 바뀌었어요' }) === 'ignore'
            && A({ key: 'Delete' }, { ...ok, info: { count: 0 } }) === 'ignore'
            && A({ key: 'Delete' }, { ...ok, info: null }) === 'ignore'
            && V.queuedDeleteGoes === undefined));
      }

      // 62c 미리보기 판단기 다시 쓰기: 1분 안 = 그대로, 1분 뒤 = 지금 것 + 뒤에서 새로, 10분 뒤 = 새로 기다림, 옮긴 뒤 = 버리고 새로
      {
        let t = 0;
        let made = 0;
        const asked = []; // 미리 읽은 것 (판단기 번호, 무엇, 경로)
        const make = () => {
          const n = ++made;
          const kindOf = async (p) => { asked.push([n, 'kind', p]); return 'fixed'; };
          kindOf.recycleOf = async (p) => { asked.push([n, 'recycle', p]); return null; };
          kindOf.binUsedOf = async (r) => { asked.push([n, 'bin', r]); return 0; };
          kindOf.n = n;
          return kindOf;
        };
        const pd = createPreviewDrive({ make, now: () => t, rootOf: (p) => `ROOT(${p})` });
        const tick = () => new Promise((res) => setImmediate(res));
        pd.warm('G:\\사진');
        pd.warm('G:\\사진'); // 이미 있으면 그대로
        await tick();
        const warmed = made === 1 && asked.some((a) => a[1] === 'kind') && asked.some((a) => a[1] === 'bin' && a[2] === 'ROOT(G:\\사진)');
        t = 30 * 1000;
        const a = await pd.get('G:\\사진');
        t = 90 * 1000; // 1분 지남: 지금 것을 바로 쓰고 뒤에서 새로
        const b = await pd.get('G:\\사진');
        const madeAfterStale = made;
        await tick();
        await tick();
        const c = await pd.get('G:\\사진'); // 새로 읽은 것으로 바뀜
        t = 90 * 1000 + 11 * 60 * 1000; // 10분 지남: 새로 만들어 기다림
        const d = await pd.get('G:\\사진');
        const madeAfterMax = made;
        pd.warm('G:\\사진', { forget: true }); // 옮긴 뒤
        const e = await pd.get('G:\\사진');
        out.push(sub('62c 미리보기 판단기: 갤러리를 열 때 미리 읽음(종류 · 휴지통 설정 · 든 크기), 1분 안은 그대로, 1분 뒤는 바로 쓰고 뒤에서 새로, 10분 뒤 · 옮긴 뒤는 새로',
          warmed && a.n === 1 && b.n === 1 && madeAfterStale === 2 && c.n === 2 && d.n === 3 && madeAfterMax === 3 && e.n === 4 && made === 4,
          JSON.stringify({ a: a.n, b: b.n, c: c.n, d: d.n, e: e.n, made })));
        // 미리 읽기가 실패해도 조용히 (미리보기 때 다시 물어봄)
        const bad = createPreviewDrive({ make: () => Object.assign(async () => { throw new Error('PowerShell 실패'); }, { n: 9 }), now: () => 0 });
        let threw = false;
        try { await bad.get('C:\\x'); } catch (err) { threw = true; }
        out.push(sub('62c 미리 읽기가 실패해도 오류 없이 판단기를 돌려줌', !threw));
        // 드라이브 종류를 모르거나 휴지통 크기를 못 읽은 판단기는 다시 쓰지 않고 다음 창에서 새로 읽음 (#128 검증 ⚠️)
        let um = 0;
        const unk = createPreviewDrive({ make: () => { um++; return Object.assign(async () => 'unknown', { binUsedOf: async () => 0 }); }, now: () => 0, rootOf: (x) => x });
        await unk.get('C:\\x');
        await unk.get('C:\\x');
        let nm = 0;
        const nul = createPreviewDrive({ make: () => { nm++; return Object.assign(async () => 'fixed', { binUsedOf: async () => null }); }, now: () => 0, rootOf: (x) => x });
        await nul.get('C:\\x');
        await nul.get('C:\\x');
        out.push(sub('62c 드라이브 종류 모름 · 휴지통 크기 못 읽음은 다시 쓰지 않음 (창마다 새로 읽음)', um === 2 && nm === 2, JSON.stringify({ um, nm })));
      }

      // 62d 연결: 미리보기 두 곳만 다시 쓰고, 실제로 옮기는 두 곳은 매번 새 판단기, 옮긴 뒤 버림, 갤러리를 열 때 미리 읽기
      {
        const gm = fs.readFileSync(path.join(__dirname, '..', 'gallery-main.js'), 'utf8');
        const dlg = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'TrashDialog.jsx'), 'utf8');
        const block = (name) => {
          const i = gm.indexOf(`ipcMain.handle('${name}'`);
          if (i < 0) return '';
          const j = gm.indexOf('ipcMain.handle(', i + 10);
          return gm.slice(i, j < 0 ? undefined : j);
        };
        const pv = [block('gallery:trash-preview'), block('gallery:similar-preview')];
        const mv = [block('gallery:trash-selected'), block('gallery:similar-discard')];
        out.push(sub('62d 미리보기(trash-preview · similar-preview)만 읽어 둔 판단 + 보여 준 결과 기억, 옮기기(trash-selected · similar-discard)는 새 판단으로 다시 맞춰 본 뒤 그 판단으로 옮김, 옮긴 뒤 버림',
          pv.every((b) => /previewDriveKindOf\(root\)/.test(b) && !/makeDriveKindOf\(\)/.test(b) && /rememberPreview\(/.test(b))
            && mv.every((b) => /const fresh = makeDriveKindOf\(\)/.test(b) && /recheckPreview\([^)]*fresh\)/.test(b) && /driveKindOf: fresh/.test(b) && !/previewDriveKindOf/.test(b) && /warmPreviewDrive\(root, \{ forget: true \}\)/.test(b))
            && /warmPreviewDrive\(root\)/.test(block('gallery:get-state'))));
        // #144 검증 ⚠️5: 비슷한 사진 미리보기 · 옮기기가 같은 열쇠(번호 + 모두 버리는 번호)로 맞춰 봄
        out.push(sub('62d 비슷한 사진 미리보기 · 옮기기 모두 similarKey(ids, whole) 로 기억 · 다시 맞춰 봄',
          [block('gallery:similar-preview'), block('gallery:similar-discard')].every((b) => /similarKey\(ids, whole\)/.test(b))));
        out.push(sub('62d 확인 창: 버튼 글자에 고른 장수, Delete 는 dialogDeleteAction 만(미리 눌러 둔 것을 나중에 옮기지 않음), 처음 초점은 그만두기',
          /trashLabel\(info, error \? 0 : ids\.length\)/.test(dlg) && /dialogDeleteAction\(e,/.test(dlg) && !/queuedDeleteGoes|wantRef/.test(dlg) && /cancelRef\.current\.focus\(\)/.test(dlg)));
      }

      // 62f 옮기기 직전 다시 맞춰 보기 (#128 검증 ⚠️): 확인 창은 읽어 둔(옛) 판단으로 "주의 없음"이었는데 그 사이 휴지통이 찼으면
      //     옮기지 않고 "창을 다시 열어" → 다시 연 창에는 주의가 보이고, 그 뒤에 누르면 옮김. 가짜 휴지통 폴더로만 옮겨요
      {
        const { openDb } = require('../lib/db');
        const { createLogger } = require('../lib/logger');
        const { row } = require('./check-gallery');
        const gmPath = require.resolve('../gallery-main');
        delete require.cache[gmPath];
        const gm = require('../gallery-main');
        delete require.cache[gmPath];
        const base = path.join(env.tmp, 'trash-fast-recheck');
        const P = { lib: path.join(base, 'backup'), ud: path.join(base, 'ud'), logDir: path.join(base, 'logs'), bin: path.join(base, 'fake-bin') };
        for (const d of Object.values(P)) fs.mkdirSync(d, { recursive: true });
        const put = (name, text) => {
          const fp = path.join(P.lib, name);
          fs.writeFileSync(fp, text);
          const st = fs.statSync(fp);
          return row({ root: P.lib, path: fp, name, size: st.size, mtimeMs: st.mtimeMs });
        };
        const o = openDb(path.join(P.ud, 'library.db'));
        try { o.db.upsertFiles([put('A.jpg', 'aaaa'), put('B.jpg', 'bbbb')]); } finally { o.db.close(); }
        let binUsed = 0; // 휴지통에 든 크기 (가짜). 설정 크기는 1000 바이트
        let made = 0;
        const handlers = new Map();
        const bin = [];
        const g = gm.setupGallery({
          ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
          protocol: { handle() {} },
          getWin: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
          getSettings: () => ({ backupRoot: P.lib }),
          getTools: () => ({}),
          getEt: () => null,
          isRunning: () => false,
          isPlanning: () => false,
          logger: createLogger(P.logDir),
          userDir: P.ud,
          loadScreen: async () => {},
          getJobPending: () => false,
          trash: async (fp) => { fs.renameSync(fp, path.join(P.bin, path.basename(fp))); bin.push(fp); },
          makeDriveKindOf: () => {
            made++;
            const seen = binUsed; // 이 판단기를 만들 때의 휴지통 크기를 기억해요 (옛 판단 흉내)
            return Object.assign(async () => 'fixed', { recycleOf: async () => ({ nuke: false, maxBytes: 1000 }), binUsedOf: async () => seen });
          },
        });
        const call = (ch, ...a) => handlers.get(ch)(null, ...a);
        try {
          await call('gallery:get-state'); // 갤러리를 열면 뒤에서 미리 읽어요
          const madeAfterOpen = made;
          const o2 = openDb(path.join(P.ud, 'library.db'));
          let ids;
          try { ids = o2.db.listIds(P.lib, { tab: 'all', sort: 'newest', query: '', tag: null }); } finally { o2.db.close(); }
          const pv1 = await call('gallery:trash-preview', ids); // 읽어 둔 판단: 주의 없음
          binUsed = 5000; // 그 사이 다른 곳에서 휴지통이 참
          let err = '';
          try { await call('gallery:trash-selected', ids); } catch (e) { err = e.message; }
          const stillThere = fs.existsSync(path.join(P.lib, 'A.jpg')) && fs.existsSync(path.join(P.lib, 'B.jpg')) && bin.length === 0;
          const pv2 = await call('gallery:trash-preview', ids); // 다시 연 창: 새로 읽어 주의가 보임
          const r = await call('gallery:trash-selected', ids); // 주의를 본 뒤 누름 → 옮김
          out.push(sub('62f 갤러리를 열면 판단을 미리 읽고, 확인 창(주의 없음) 뒤 휴지통이 차면 옮기기 직전에 멈춤(아무것도 안 옮김)',
            madeAfterOpen === 1 && pv1.count === 2 && pv1.warnings.length === 0 && /휴지통 상황이 바뀌었어요/.test(err) && stillThere,
            JSON.stringify({ madeAfterOpen, pv1: pv1.warnings, err })));
          out.push(sub('62f 다시 연 창에는 휴지통 주의가 보이고, 그 뒤 누르면 가짜 휴지통으로 2장 옮김',
            pv2.warnings.length === 1 && r.trashed === 2 && bin.length === 2,
            JSON.stringify({ pv2: pv2.warnings, r: { trashed: r.trashed, fail: r.fail } })));
        } finally {
          g.close();
        }
      }

      // 62e 진짜 앱: Delete 로 창 → 버튼 글자가 바로 있음, 꾹 누른 Delete(반복)는 아무것도 안 옮김, 두 번째로 열 때는 결과가 빨리 옴. 옮기기는 누르지 않아요
      {
        const { launchCheck } = require('./launch-check');
        const { makeImage } = require('./check-similar');
        const root = path.join(env.tmp, 'launch-trash-fast-root');
        for (const [name, seed] of [['f1.jpg', 4], ['f2.jpg', 11]]) await makeImage(path.join(root, name), { seed });
        const names = () => fs.readdirSync(root).sort().join(',');
        const before = names();
        const ud = path.join(env.tmp, 'launch-trash-fast-ud');
        fs.mkdirSync(ud, { recursive: true });
        fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ backupRoot: root }), 'utf8');
        const r = await launchCheck(path.join(__dirname, '..'), {
          env: { PVM_USER_DATA: ud },
          until: '백업 폴더 다시 읽기',
          untilMs: 30000,
          probe: `(${fastProbe.toString()})()`,
        });
        const q = r.probed || {};
        const seen = JSON.stringify(q).slice(0, 600);
        out.push(sub('62e 진짜 앱: Delete 로 연 창에 버튼 글자가 처음부터 "1장 … 옮기기", 결과 뒤 "Delete 키를 한 번 더" 안내',
          /^1장 (휴지통|정리완료원본 폴더)으로 옮기기$/.test(q.firstLabel || '') && /Delete 키를 한 번 더/.test(q.dialogText || ''), seen));
        out.push(sub('62e 꾹 누른 Delete(반복)는 창을 그대로 두고 파일도 그대로, Esc 로 닫힘, 화면 오류 없음',
          q.afterRepeatOpen === true && q.closed === true && names() === before && !(r.errors || []).some((e) => !/Failed to load resource/.test(e)),
          `${seen} / 오류 ${(r.errors || []).length}개`));
        // 두 번째로 열 때 결과가 오는 시간 (참고: 미리 읽어 둔 판단을 다시 써서 빨라야 해요. 느린 PC 를 생각해 1.5초 안)
        out.push(sub('62e 두 번째로 연 창은 결과가 1.5초 안에 옴 (드라이브 판단을 다시 씀)',
          typeof q.secondMs === 'number' && q.secondMs < 1500, `첫 번째 ${q.firstMs}ms, 두 번째 ${q.secondMs}ms`));
      }
      return out;
    },
  },
];

// 진짜 앱 창 안에서 도는 확인 (launch-check 의 probe). 옮기기는 누르지 않아요
async function fastProbe() {
  const wait = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await new Promise((res) => setTimeout(res, 20));
    }
  };
  const q = {};
  const cells = await wait(() => document.querySelectorAll('button.cell').length >= 2, 30000);
  if (!cells) return { stop: '사진 칸이 2개가 안 돼요' };
  const cell = document.querySelector('button.cell');
  cell.click();
  await wait(() => document.querySelector('.panel-actions .trash-button'));
  const dlgOf = () => document.querySelector('[aria-labelledby="trash-title"]');
  const goOf = () => { const d = dlgOf(); const b = d ? d.querySelectorAll('.dialog-foot button')[1] : null; return b ? b.innerText.trim() : null; };
  const open = async () => {
    cell.focus();
    const t0 = performance.now();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    const d = await wait(dlgOf);
    if (!d) return null;
    const label = goOf();
    const done = await wait(() => /고른 1장을 옮겨요/.test(d.innerText));
    return { label, ms: done ? Math.round(performance.now() - t0) : null };
  };
  const first = await open();
  if (!first) return { stop: 'Delete 키로 확인 창이 안 열려요' };
  q.firstLabel = first.label;
  q.firstMs = first.ms;
  q.dialogText = dlgOf().innerText;
  // 꾹 누른 Delete (반복 키) → 무시돼야 해요
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', repeat: true, bubbles: true }));
  await new Promise((res) => setTimeout(res, 400));
  q.afterRepeatOpen = !!dlgOf() && !/옮기는 중/.test(dlgOf().innerText);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  q.closed = !!(await wait(() => !dlgOf()));
  // 두 번째로 열기: 결과가 빨리 와야 해요
  const second = await open();
  q.secondMs = second ? second.ms : null;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(() => !dlgOf());
  return q;
}

module.exports = { items };

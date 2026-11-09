// 파일 위치: scripts/check-clean-view.js
// 역할: "정리" 화면 점검 항목 (45, 46). scripts/check.js 의 ITEMS 끝에 붙어서 같이 돌아요.
//   빠르게 이 파일만 돌려 볼 때: node scripts/check-clean-view.js
//
// ⚠️ 실제 사진, 실제 로그, 실제 userData는 쓰지 않아요 (점검 임시 폴더 env.tmp 안에 가짜 로그와 폴더를 만들어요)
//   이 화면은 읽기만 해요. 점검도 파일을 옮기거나 지우지 않는지 봐요
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { sub } = require('./check-gallery');

const APP = path.join(__dirname, '..');
const T = '\t';

// 가짜 로그 세 개 + 세지 않을 로그. 원본 경로는 일부러 긴 Windows 경로로 (화면에는 이름만 가야 해요)
function writeLogs(dir, srcDir) {
  fs.mkdirSync(dir, { recursive: true });
  const p = (n) => `${srcDir}\\${n}`;
  fs.writeFileSync(path.join(dir, 'clean_2026-11-01_101500.txt'), [
    '# 원본 정리 / 2026-11-01 10:15:00 / 4개',
    '# 시간\t방법\t원본\t옮긴 곳 또는 남아 있는 결과 파일',
    `10:15:01${T}예정(휴지통)${T}${p('a.jpg')}${T}X:\\백업\\a.jpg`,
    `10:15:01${T}휴지통${T}${p('a.jpg')}${T}X:\\백업\\a.jpg`,
    `10:15:02${T}예정(휴지통)${T}${p('b.jpg')}${T}X:\\백업\\b.jpg`,
    `10:15:02${T}휴지통 실패 → 이동${T}${p('b.jpg')}${T}EPERM`,
    `10:15:02${T}이동(USB)${T}${p('b.jpg')}${T}${p('_정리완료원본\\b.jpg')}`,
    `10:15:03${T}예정(휴지통)${T}${p('c.jpg')}${T}X:\\백업\\c.jpg`,
    `10:15:03${T}휴지통${T}${p('c.jpg')}${T}X:\\백업\\c.jpg`,
    `10:15:04${T}실패${T}${p('d.jpg')}${T}결과 파일을 찾지 못했어요`,
    '# 끝 / 휴지통 2, 이동 1, 실패 1',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'clean_2026-11-03_090000.txt'), [
    '# 원본 정리 / 2026-11-03 09:00:00 / 2개',
    `09:00:01${T}예정(휴지통)${T}${p('e.jpg')}${T}X:\\백업\\e.jpg`,
  ].join('\n')); // 끝 줄 없음 (도중에 꺼짐)
  fs.writeFileSync(path.join(dir, 'similar-discard_2026-11-02_120000.txt'), [
    '# 비슷한 사진 버리기 / 2026-11-02 12:00:00 / 1장',
    '# 백업 폴더: X:\\백업',
    `12:00:01${T}예정(휴지통)${T}X:\\백업\\2026\\10\\IMG_1.HEIC`,
    `12:00:01${T}휴지통${T}X:\\백업\\2026\\10\\IMG_1.HEIC`,
    `12:00:02${T}짝 영상 휴지통${T}X:\\백업\\2026\\10\\IMG_1.MOV`,
    '# 끝 / 휴지통 1, 이동 0, 실패 0, 짝 영상 1, 짝 영상 실패 0',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'clean-check_2026-11-04_080000.txt'), '# 다른 로그\n'); // 세지 않음
  fs.writeFileSync(path.join(dir, 'run_2026-11-04_080000.txt'), '# 다른 로그\n'); // 세지 않음
}

const items = [
  {
    no: 45,
    name: '정리 화면: 정리 기록과 _정리완료원본 (읽기만)',
    async run(env) {
      const out = [];
      const H = require('../lib/clean-history');
      const root = path.join(env.tmp, 'clean-view');
      const logDir = path.join(root, 'logs');
      const srcDir = 'C:\\Users\\사용자\\사진\\가져올';
      writeLogs(logDir, srcDir);

      // 45a 기록 읽기: 새것부터, 정리 · 비슷한 사진 버리기만, 개수 (예정 · 안내 줄은 세지 않음), 끝 줄, 이름만, 실패 이유, 짝 영상
      const list = H.readCleanHistory(logDir);
      const [s1, s2, s3] = list;
      const json = JSON.stringify(list);
      out.push(sub('45a 정리 기록: 새것부터 3개 (다른 로그 빼고), 휴지통 · 옮김 · 실패 개수, 끝 줄 없으면 표시, 화면에는 이름만, 실패 이유, 짝 영상',
        list.length === 3 && s1.at === '2026-11-03 09:00:00' && s1.finished === false && s1.trash + s1.move + s1.fail === 0
        && s2.kind === 'similar-discard' && s2.trash === 2 && s2.files[1].pair === true && s2.files[1].name === 'IMG_1.MOV'
        && s3.trash === 2 && s3.move === 1 && s3.fail === 1 && s3.finished === true && s3.planned === 4
        && s3.files.map((f) => f.name).join(',') === 'a.jpg,b.jpg,c.jpg,d.jpg' && s3.files[3].note === '결과 파일을 찾지 못했어요'
        && !json.includes('사용자') && !json.includes('백업\\\\'),
        json.slice(0, 400)));

      // 45b _정리완료원본 폴더: 있는지, 파일 수와 크기, 폴더를 안 정했으면 따로 표시, 경로는 주지 않음
      const src = path.join(root, 'src');
      fs.mkdirSync(path.join(src, '_정리완료원본', '2026'), { recursive: true });
      fs.writeFileSync(path.join(src, '_정리완료원본', '2026', 'a.jpg'), 'abc');
      fs.writeFileSync(path.join(src, '_정리완료원본', 'b.jpg'), 'abcdefg');
      const backup = path.join(root, 'backup');
      fs.mkdirSync(backup, { recursive: true });
      const folders = H.cleanedFolders({ source: src, backupRoot: backup });
      const none = H.cleanedFolders({ source: '', backupRoot: backup });
      out.push(sub('45b _정리완료원본: 가져올 폴더 2개 10바이트, 백업 폴더는 없음, 안 정한 폴더는 따로, 경로 없음',
        folders[0].exists && folders[0].files === 2 && folders[0].bytes === 10 && !folders[1].exists && folders[1].set
        && none[0].set === false && !JSON.stringify(folders).includes(root),
        JSON.stringify([folders, none[0]])));

      // 45c 연결: 기록에 경로 없음, 폴더 열기는 main 이 정한 경로만, 이상한 값 · 없는 폴더 · 열기 실패는 정해진 문장
      {
        const fakes = [];
        try {
          const { createLogger } = require('../lib/logger');
          const gmPath = require.resolve('../gallery-main');
          delete require.cache[gmPath];
          const gm = require('../gallery-main');
          delete require.cache[gmPath];
          const ud = path.join(root, 'ud');
          fs.mkdirSync(ud, { recursive: true });
          const opened = [];
          let openFail = '';
          const handlers = new Map();
          const g = gm.setupGallery({
            ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
            protocol: { handle() {} },
            getWin: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
            getSettings: () => ({ source: src, backupRoot: backup }),
            getTools: () => ({}),
            getEt: () => null,
            isRunning: () => false,
            isPlanning: () => false,
            logger: createLogger(logDir),
            userDir: ud,
            loadScreen: async () => {},
            getJobPending: () => false,
            mapFetch: async () => new Response('', { status: 503 }),
            openExternal: async () => {},
            openPath: async (p) => {
              opened.push(p);
              return openFail;
            },
            appVersion: '9.9.9',
          });
          fakes.push(g);
          const call = (ch, ...a) => Promise.resolve().then(() => handlers.get(ch)(null, ...a));
          const errOf = (p) => p.then(() => null, (e) => e.message);
          const hist = await call('gallery:clean-history');
          const ok = await call('gallery:open-cleaned', 'source');
          const bad = await errOf(call('gallery:open-cleaned', 'C:\\Windows'));
          const noDir = await errOf(call('gallery:open-cleaned', 'backup'));
          openFail = 'Failed to open path';
          const fail = await errOf(call('gallery:open-cleaned', 'source'));
          const histJson = JSON.stringify(hist);
          out.push(sub('45c 연결: 기록 3개 · 폴더 2개에 경로 없음, 가져올 폴더의 _정리완료원본만 열고, 이상한 값 · 없는 폴더 · 열기 실패는 정해진 문장',
            hist.sessions.length === 3 && hist.folders.length === 2 && !histJson.includes(root) && !histJson.includes('사용자')
            && ok === true && opened[0] === path.join(path.resolve(src), '_정리완료원본') && opened.length === 2
            && !!bad && (noDir || '').includes('없어요') && fail === '폴더를 열지 못했어요',
            JSON.stringify([ok, opened.map((p) => path.basename(p)), bad, noDir, fail])));
        } catch (e) {
          out.push(sub('45c 실행 중 오류', false, String(e.stack).split('\n').slice(0, 3).join(' | ')));
        } finally {
          for (const g of fakes) {
            try {
              g.close();
            } catch (e) { /* 닫기 실패는 무시 */ }
          }
        }
      }

      // 45d 읽기만: 점검 앞뒤로 _정리완료원본 파일이 그대로, 화면 연결 (메뉴 켜짐, 화면 · 패널, preload 두 통로)
      {
        const still = fs.existsSync(path.join(src, '_정리완료원본', '2026', 'a.jpg')) && fs.existsSync(path.join(src, '_정리완료원본', 'b.jpg'));
        const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');
        const side = read('src/components/Sidebar.jsx');
        const app = read('src/App.jsx');
        const pre = read('preload.js');
        const view = read('src/components/CleanView.jsx');
        const lib = read('lib/clean-history.js');
        const wired = side.includes("onScreen('clean')") && !side.includes('label="정리" disabled') && app.includes('<CleanView') && app.includes('<CleanPanel')
          && pre.includes("'gallery:clean-history'") && pre.includes("'gallery:open-cleaned'") && view.includes('_정리완료원본 열기');
        const readOnly = !/\b(renameSync|rmSync|unlinkSync|rmdirSync|writeFileSync|trashItem)\b/.test(lib);
        out.push(sub('45d 읽기만 (파일 그대로, 정리 기록 코드에 옮기기 · 지우기 · 쓰기 없음), 정리 메뉴 · 화면 · 패널 · 통로 연결', still && wired && readOnly, JSON.stringify({ still, wired, readOnly })));
      }
      return out;
    },
  },
  {
    no: 46,
    name: '정리 화면 (진짜 앱)',
    async run(env) {
      // 임시 userData 의 logs 에 가짜 정리 로그를 두고, 가져올 폴더에 _정리완료원본 파일 하나. 폴더 열기는 누르지 않아요
      const out = [];
      const { launchCheck } = require('./launch-check');
      const { makeImage } = require('./check-similar');
      const root = path.join(env.tmp, 'launch-clean');
      const backup = path.join(root, 'backup');
      await makeImage(path.join(backup, 'one.jpg'), { seed: 5 });
      const src = path.join(root, 'src');
      fs.mkdirSync(path.join(src, '_정리완료원본'), { recursive: true });
      fs.writeFileSync(path.join(src, '_정리완료원본', 'b.jpg'), 'abcdefg');
      const ud = path.join(root, 'ud');
      writeLogs(path.join(ud, 'logs'), 'C:\\Users\\사용자\\사진\\가져올');
      fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ backupRoot: backup, source: src }), 'utf8');
      const r = await launchCheck(APP, {
        port: 9344,
        env: { PVM_USER_DATA: ud },
        until: '백업 폴더 다시 읽기',
        untilMs: 30000,
        probe: `(${cleanProbe.toString()})()`,
      });
      const q = r.probed || {};
      const seen = JSON.stringify(q).slice(0, 600);
      out.push(sub('46a 정리 메뉴 → 기록 3줄, 가져올 폴더의 _정리완료원본 1개와 열기 버튼, 백업 폴더는 없음', q.rows === 3 && (q.source || '').includes('1개') && q.openButton === '가져올 폴더의 _정리완료원본 열기' && (q.backup || '').includes('옮겨 둔 원본이 없어요'), seen));
      out.push(sub('46b 기록을 누르면 패널에 파일 이름과 간 곳, 끝 줄 없는 기록은 안내', q.files === 'a.jpg휴지통,b.jpg_정리완료원본,c.jpg휴지통,d.jpg실패결과파일을찾지못했어요' && (q.unfinished || '').includes('도중에'), seen));
      out.push(sub('46c 화면 오류 없음, 정상 종료, 화면에 경로 없음, _정리완료원본 파일 그대로', r.errors.length === 0 && r.exitCode === 0 && !q.stop && !q.pathShown && fs.existsSync(path.join(src, '_정리완료원본', 'b.jpg')), `${r.errors.join(' / ')} 종료 코드 ${r.exitCode} ${q.stop || ''}`));
      return out;
    },
  },
];

// 항목 46이 앱 화면 안에서 돌리는 함수예요. 글자로 바뀌어 넘어가니까 바깥 변수를 쓰면 안 돼요
async function cleanProbe() {
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
  await wait(() => document.querySelector('button.cell'), 30000);
  const menu = [...document.querySelectorAll('.menu button.menu-row')].find((b) => b.innerText.includes('정리'));
  if (!menu || menu.disabled) return { stop: '정리 메뉴가 꺼져 있어요' };
  menu.click();
  const rows = await wait(() => document.querySelectorAll('.clean-table tbody tr').length >= 3);
  if (!rows) return { stop: '정리 기록이 3줄이 안 돼요' };
  q.rows = document.querySelectorAll('.clean-table tbody tr').length;
  const folders = [...document.querySelectorAll('.clean-folder')];
  q.source = folders[0] ? folders[0].innerText : '';
  q.backup = folders[1] ? folders[1].innerText : '';
  const btn = folders[0] && folders[0].querySelector('button');
  q.openButton = btn ? btn.innerText.trim() : '';
  // 첫 줄 = 끝 줄 없는 기록, 셋째 줄 = 4개짜리 원본 정리
  document.querySelectorAll('.clean-row')[0].click();
  q.unfinished = ((await wait(() => document.querySelector('.clean-panel .clean-note'))) || {}).innerText || '';
  document.querySelectorAll('.clean-row')[2].click();
  await wait(() => document.querySelectorAll('.clean-panel .clean-file').length === 4);
  q.files = [...document.querySelectorAll('.clean-panel .clean-file')].map((li) => li.innerText.replace(/\s+/g, '')).join(',');
  q.pathShown = document.body.innerText.includes('사용자') || document.body.innerText.includes('C:\\');
  return q;
}

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

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

      // 45a 기록 읽기: 새것부터, 정리 · 비슷한 사진 버리기만, 개수 (예정 · 안내 줄은 세지 않음), 끝 줄, 이름만, 실패 이유, 짝 영상,
      //     끝 줄 없는 기록의 옮기던 파일(예정만 있음)은 이름과 '결과 없음'으로
      const { sessions: list } = await H.readCleanHistory(logDir);
      const [s1, s2, s3] = list;
      const json = JSON.stringify(list);
      out.push(sub('45a 정리 기록: 새것부터 3개 (다른 로그 빼고), 휴지통 · 옮김 · 실패 개수, 끝 줄 없으면 표시와 옮기던 파일 이름, 화면에는 이름만, 실패 이유, 짝 영상',
        list.length === 3 && s1.at === '2026-11-03 09:00:00' && s1.finished === false && s1.trash + s1.move + s1.fail === 0
        && s1.pending === 1 && s1.files.length === 1 && s1.files[0].name === 'e.jpg' && s1.files[0].how === 'pending'
        && s3.pending === 0
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
      const { folders, dirs } = await H.cleanedFolders({ source: src, backupRoot: backup });
      const { folders: none } = await H.cleanedFolders({ source: '', backupRoot: path.join(root, 'unplugged') });
      out.push(sub('45b _정리완료원본: 가져올 폴더 2개 10바이트, 백업 폴더는 없음, 안 정한 폴더 · 연결 안 된 폴더는 따로, 화면 값에 경로 없음',
        folders.length === 2 && folders[0].key === 'source' && folders[0].exists && folders[0].files === 2 && folders[0].bytes === 10 && !folders[0].partial
        && folders[0].name === 'src' && folders[1].reachable && !folders[1].exists && folders[1].set
        && none[0].set === false && none[1].set === true && none[1].reachable === false
        && dirs.get('source') === path.join(src, '_정리완료원본') && !dirs.has('backup') && !JSON.stringify(folders).includes(root),
        JSON.stringify([folders, none])));

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
          // 예전 가져올 폴더(지금 설정과 다른 곳)에 옮긴 기록 하나 더. 그 폴더도 찾아서 열 수 있어야 해요
          const oldSrc = path.join(root, 'old-src');
          fs.mkdirSync(path.join(oldSrc, '_정리완료원본'), { recursive: true });
          fs.writeFileSync(path.join(oldSrc, '_정리완료원본', 'x.jpg'), 'xyz');
          fs.writeFileSync(path.join(logDir, 'clean_2026-10-01_080000.txt'), [
            '# 원본 정리 / 2026-10-01 08:00:00 / 1개',
            `08:00:01${T}예정(이동)${T}${path.join(oldSrc, 'x.jpg')}${T}X:\\백업\\x.jpg`,
            `08:00:01${T}이동(USB)${T}${path.join(oldSrc, 'x.jpg')}${T}${path.join(oldSrc, '_정리완료원본', 'x.jpg')}`,
            '# 끝 / 휴지통 0, 이동 1, 실패 0',
          ].join('\n'));
          const [hist, again] = await Promise.all([call('gallery:clean-history'), call('gallery:clean-history')]);
          const old = hist.folders.find((f) => f.name === 'old-src') || {};
          // 가짜 로그의 C:\Users\사용자\가져올 은 드라이브는 있고 폴더가 없음 → 지워진 예전 폴더라 안 보여요 (#60 검증)
          const goneShown = hist.folders.some((f) => f.name === '가져올');
          const ok = await call('gallery:open-cleaned', 'source');
          const okOld = await call('gallery:open-cleaned', old.key);
          const bad = await errOf(call('gallery:open-cleaned', 'C:\\Windows'));
          const unknown = await errOf(call('gallery:open-cleaned', 'old-000000000000'));
          const noDir = await errOf(call('gallery:open-cleaned', 'backup'));
          openFail = 'Failed to open path';
          const fail = await errOf(call('gallery:open-cleaned', 'source'));
          const histJson = JSON.stringify(hist);
          out.push(sub('45c 연결: 기록 4개 · 폴더에 경로 없음, 겹친 요청은 같은 결과, 예전 가져올 폴더도 찾아 열고 지워진 예전 폴더는 안 보임, 이상한 값 · 모르는 폴더 · 없는 폴더 · 열기 실패는 정해진 문장',
            hist.sessions.length === 4 && hist === again && !histJson.includes(root) && !histJson.includes('사용자')
            && hist.folders[0].key === 'source' && hist.folders[1].key === 'backup'
            && old.label === '예전 가져올 폴더' && old.exists && old.files === 1 && /^old-[0-9a-f]{12}$/.test(old.key || '')
            && !goneShown
            && ok === true && okOld === true && opened[0] === path.join(path.resolve(src), '_정리완료원본')
            && opened[1] === path.join(oldSrc, '_정리완료원본') && opened.length === 3
            && (bad || '').includes('올바르지') && (unknown || '').includes('없어요') && (noDir || '').includes('없어요') && fail === '폴더를 열지 못했어요',
            JSON.stringify([hist.folders, ok, okOld, opened.map((p) => path.basename(path.dirname(p))), bad, unknown, noDir, fail]).slice(0, 600)));
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
        const readOnly = !/\.(rename|rm|unlink|rmdir|writeFile|appendFile|copyFile|mkdir|cp|truncate)(Sync)?\(|trashItem/.test(lib);
        const noSync = !/\b\w+Sync\(/.test(lib); // 앱을 멈추는 기다리기 읽기 없음 (#60 검증)
        out.push(sub('45d 읽기만 (파일 그대로, 정리 기록 코드에 옮기기 · 지우기 · 쓰기 없음, Sync 읽기 없음), 정리 메뉴 · 화면 · 패널 · 통로 연결', still && wired && readOnly && noSync, JSON.stringify({ still, wired, readOnly, noSync })));
      }

      // 45e 실제로 쓴 로그: cleanOriginals · discardFiles (가짜 휴지통, 가짜 드라이브)가 남긴 로그를 그대로 읽어 개수 · 이름 · 실패 이유가 맞는지
      try {
        const { createLogger } = require('../lib/logger');
        const { cleanOriginals } = require('../lib/cleaner');
        const { discardFiles } = require('../lib/similar-discard');
        const real = path.join(root, 'real');
        const rLogs = path.join(real, 'logs');
        const source = path.join(real, 'source');
        const bk = path.join(real, 'backup');
        fs.mkdirSync(path.join(source, 'sub'), { recursive: true });
        fs.mkdirSync(path.join(bk, '2026'), { recursive: true });
        const w = (p, t) => (fs.writeFileSync(p, t), p);
        const items = [
          { i: 0, src: w(path.join(source, 'sub', 'usb.jpg'), 'A'), status: 'done', finalPath: w(path.join(bk, 'usb.jpg'), 'A') }, // USB → 이동
          { i: 1, src: w(path.join(source, 'hdd.jpg'), 'B'), status: 'dup', dupOf: w(path.join(bk, 'hdd.jpg'), 'B') }, // 하드디스크 → 휴지통
          { i: 2, src: w(path.join(source, 'binfail.jpg'), 'C'), status: 'dup', dupOf: w(path.join(bk, 'binfail.jpg'), 'C') }, // 휴지통 실패 → 이동
          { i: 3, src: w(path.join(source, 'gone.jpg'), 'D'), status: 'dup', dupOf: w(path.join(bk, 'gone.jpg'), 'D') }, // 휴지통 결과 모름 → 실패 (이유에 경로)
          { i: 4, src: w(path.join(real, 'outside.jpg'), 'E'), status: 'dup', dupOf: w(path.join(bk, 'outside.jpg'), 'E') }, // 가져올 폴더 밖 USB → 실패
        ];
        const job = { source, backupRoot: bk, items };
        const store = { mark: (j, i, patch) => Object.assign(j.items[i], patch) };
        const trash = async (p) => {
          const err = new Error(`EPERM: operation not permitted, unlink '${p}'`);
          err.code = 'EPERM';
          if (p.endsWith('binfail.jpg')) throw err;
          if (p.endsWith('gone.jpg')) { fs.rmSync(p); throw err; }
          fs.rmSync(p); // 점검에서는 휴지통 대신 지워요 (임시 폴더의 가짜 파일)
        };
        const kindOf = async (p) => (/usb\.jpg$|outside\.jpg$/.test(p) ? 'removable' : 'fixed');
        const rc = await cleanOriginals({ job, store, targets: items, logger: createLogger(rLogs), trash, driveKindOf: kindOf, recycleOf: async () => null });
        const ph = w(path.join(bk, '2026', 'IMG_9.jpg'), 'P');
        const pv = w(path.join(bk, '2026', 'IMG_9.mov'), 'V');
        const rd = await discardFiles({ root: bk, files: [{ id: 1, path: ph, name: 'IMG_9.jpg', size: 1, pair: { path: pv, siblings: [ph] } }], trash, driveKindOf: async () => 'removable', recycleOf: async () => null, logger: createLogger(rLogs) });
        const { sessions, oldBases } = await H.readCleanHistory(rLogs);
        const c = sessions.find((x) => x.kind === 'clean') || {};
        const d = sessions.find((x) => x.kind === 'similar-discard') || {};
        const files = (x) => (x.files || []).map((f) => `${f.name}:${f.how}${f.pair ? '+' : ''}`).join(',');
        const notes = (c.files || []).filter((f) => f.how === 'fail').map((f) => f.note);
        const j2 = JSON.stringify(sessions);
        out.push(sub('45e 실제 로그: 원본 정리 휴지통 1 · 이동 2 · 실패 2, 비슷한 사진 이동 1 + 짝 영상, 결과 없는 파일 0, 실패 이유에 경로 없음, 옮긴 곳의 위 폴더 2개',
          sessions.length === 2 && c.finished && d.finished && c.planned === 5 && d.planned === 1
          && c.trash === rc.trashed && c.move === rc.moved && c.fail === rc.fail && rc.trashed === 1 && rc.moved === 2 && rc.fail === 2
          && d.move === rd.moved + rd.pairs && rd.moved === 1 && rd.pairs === 1 && c.pending === 0 && d.pending === 0
          && files(c) === 'usb.jpg:move,hdd.jpg:trash,binfail.jpg:move,gone.jpg:fail,outside.jpg:fail'
          && files(d) === 'IMG_9.jpg:move,IMG_9.mov:move+'
          && notes[0] === '휴지통 결과를 알 수 없어요 (EPERM)' && notes[1] === '가져올 폴더 밖의 파일이라 옮기지 않았어요'
          && !j2.includes(real) && !j2.includes('\\\\') && oldBases.length === 2
          && oldBases.filter((b) => b.kind === 'clean').every((b) => path.resolve(b.base) === source)
          && oldBases.filter((b) => b.kind === 'similar-discard').every((b) => path.resolve(b.base) === bk),
          JSON.stringify({ rc: [rc.trashed, rc.moved, rc.fail], c: files(c), d: files(d), notes, bases: oldBases.length }).slice(0, 600)));
      } catch (e) {
        out.push(sub('45e 실행 중 오류', false, String(e.stack).split('\n').slice(0, 3).join(' | ')));
      }

      // 45f 실패 이유 다듬기: 경로는 이름만, Node 오류 글은 코드만, 남은 경로 모양은 정해진 문장, 우리가 쓴 한글 문장은 그대로
      {
        const cases = [
          ["EPERM: operation not permitted, rename 'C:\\Users\\사용자\\a.jpg' -> 'D:\\x\\a.jpg'", '옮기지 못했어요 (EPERM)'],
          ["휴지통 결과를 알 수 없어요 (EBUSY: resource busy or locked, unlink 'C:\\Users\\사용자\\a.jpg')", '휴지통 결과를 알 수 없어요 (EBUSY)'],
          ["ENOTDIR: not a directory, mkdir '/home/사용자/src/_정리완료원본/sub'", '옮기지 못했어요 (ENOTDIR)'],
          ['Failed to move C:\\Users\\홍 길동\\a.jpg to trash', '옮기지 못했어요'],
          ['\\\\nas\\사용자\\a.jpg 를 옮기지 못함', '옮기지 못했어요'],
          ['결과 파일을 찾지 못했어요', '결과 파일을 찾지 못했어요'],
          ["EPERM: operation not permitted, unlink 'C:\\Users\\홍\\IMG_1 (1).jpg'", '옮기지 못했어요 (EPERM)'],
          ["휴지통 결과를 알 수 없어요 (EBUSY: resource busy, unlink 'C:\\a (2).jpg')", '휴지통 결과를 알 수 없어요 (EBUSY)'],
        ];
        const got = cases.map(([a]) => H.safeNote(a));
        out.push(sub('45f 실패 이유: 경로 · 영문 오류 글은 화면에 안 감', got.every((g, i) => g === cases[i][1]), JSON.stringify(got)));
      }

      // 45g 상한과 빈 곳: 파일 줄 300개 넘김(more) + 결과 없는 파일은 맨 앞에 따로, 폴더 세기 상한(capped), 없는 로그 폴더
      {
        const lines = ['# 원본 정리 / 2026-11-05 10:00:00 / 306개'];
        for (let i = 0; i < 305; i++) lines.push(`10:00:00${T}휴지통${T}C:\\a\\f${i}.jpg${T}X:\\b\\f${i}.jpg`);
        lines.push(`10:00:09${T}예정(휴지통)${T}C:\\a\\last.jpg${T}X:\\b\\last.jpg`);
        const big = H.parseLog('clean_2026-11-05_100000.txt', lines.join('\n'));
        const cap = await H.folderStats(path.join(src, '_정리완료원본'), { max: 1 });
        const empty = await H.readCleanHistory(path.join(root, 'no-logs'));
        out.push(sub('45g 파일 줄 300개 + 그 밖에 5개, 결과 없는 파일은 맨 앞, 폴더 세기 상한, 없는 로그 폴더는 빈 기록',
          big.trash === 305 && big.more === 5 && big.files.length === 301 && big.files[0].name === 'last.jpg' && big.files[0].how === 'pending' && big.pending === 1
          && cap.capped === true && cap.files === 1 && empty.sessions.length === 0 && empty.oldBases.length === 0,
          JSON.stringify({ more: big.more, n: big.files.length, first: big.files[0], cap, empty })));
      }

      // 45g 새 끝 줄 (지문 개수가 붙은 줄, 2026-11-11)도 끝까지 적힌 기록으로 읽고, 개수는 그대로
      {
        const withHash = H.parseLog('clean_2026-11-11_100000.txt', [
          '# 원본 정리 / 2026-11-11 10:00:00 / 1개',
          `10:00:01${T}예정(휴지통)${T}C:\\a\\x.jpg${T}X:\\b\\x.jpg`,
          `10:00:01${T}휴지통${T}C:\\a\\x.jpg${T}X:\\b\\x.jpg`,
          '# 끝 / 휴지통 1, 이동 0, 실패 0 / 지문 다시 계산 2개, 재사용 5개',
        ].join('\n'));
        out.push(sub('45g 지문 개수가 붙은 끝 줄도 끝까지 적힌 기록, 개수 그대로',
          withHash.finished === true && withHash.trash === 1 && withHash.fail === 0 && withHash.pending === 0 && withHash.files.length === 1,
          JSON.stringify(withHash)));
      }

      // 45h 예전 폴더 (#60 검증): 지워진 예전 폴더가 9개 먼저 있어도 뒤의 있는 폴더가 보임 (보이는 것만 MAX_OLD개까지 셈)
      //   Windows 에서는 없는 드라이브 글자의 예전 폴더가 "연결 안 됨"으로 보이는지도 봐요
      {
        const live = path.join(root, 'old-live');
        fs.mkdirSync(path.join(live, '_정리완료원본'), { recursive: true });
        const oldBases = [];
        for (let i = 0; i < 9; i++) oldBases.push({ kind: 'clean', base: path.join(root, `old-gone-${i}`) });
        oldBases.push({ kind: 'clean', base: live });
        let drive = null;
        if (process.platform === 'win32') {
          drive = 'QRSTUVWXYZ'.split('').map((l) => `${l}:\\`).find((d) => !fs.existsSync(d)) || null;
          if (drive) oldBases.unshift({ kind: 'clean', base: `${drive}사진` });
        }
        const r = await H.cleanedFolders({ source: src, backupRoot: '', oldBases });
        const olds = r.folders.filter((f) => f.key.startsWith('old-'));
        const liveShown = olds.some((f) => f.name === 'old-live' && f.exists);
        const goneShown = olds.some((f) => f.name.startsWith('old-gone-'));
        const unplugged = !drive || olds.some((f) => f.name === '사진' && f.reachable === false);
        out.push(sub('45h 지워진 예전 폴더는 안 보이고 상한에 안 셈, 뒤의 있는 폴더는 보임, 없는 드라이브는 연결 안 됨',
          liveShown && !goneShown && unplugged, JSON.stringify({ olds: olds.map((f) => [f.name, f.reachable, f.exists]), drive })));
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
        env: { PVM_USER_DATA: ud },
        until: '백업 폴더 다시 읽기',
        untilMs: 30000,
        probe: `(${cleanProbe.toString()})()`,
      });
      const q = r.probed || {};
      const seen = JSON.stringify(q).slice(0, 600);
      out.push(sub('46a 정리 메뉴 → 기록 3줄, 가져올 폴더의 _정리완료원본 1개와 열기 버튼, 백업 폴더는 없음', q.rows === 3 && (q.source || '').includes('1개') && q.openButton === '가져올 폴더의 _정리완료원본 열기' && (q.backup || '').includes('옮겨 둔 원본이 없어요'), seen));
      out.push(sub('46b 기록을 누르면 패널에 파일 이름과 간 곳, 끝 줄 없는 기록은 안내와 옮기던 파일', q.files === 'a.jpg휴지통,b.jpg_정리완료원본,c.jpg휴지통,d.jpg실패결과파일을찾지못했어요' && (q.unfinished || '').includes('도중에') && q.pendingFile === 'e.jpg결과가기록되지않음', seen));
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
  q.pendingFile = [...document.querySelectorAll('.clean-panel .clean-file')].map((li) => li.innerText.replace(/\s+/g, '')).join(',');
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

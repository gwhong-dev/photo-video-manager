// 파일 위치: scripts/check-media-edit.js
// 역할: 사진 · 영상 돌리기 점검 (66). scripts/check.js 의 ITEMS 끝에 붙어요
//   2026-11-23 사용자 요청 (나중에 할 일 23): 돌린 모습을 복사본으로 저장하거나 원본을 바꾸기
//   임시 폴더에 만든 시험 사진 · 영상으로만 돌려 봐요 (샘플 · 진짜 휴지통은 안 건드려요)
//   원본 바꾸기 · 휴지통 연결(gallery-main.js)은 앱을 띄워 샘플 복사본으로 확인해요
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sub, withDb } = require('./check-gallery');
const { runCmd } = require('../lib/tools');
const M = require('../lib/media-edit');

const hashOf = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const tryRotate = async (args) => {
  try {
    return { r: await M.rotateFile(args), err: '' };
  } catch (e) {
    return { r: null, err: e.message };
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errOf = (p) => p.then(() => null, (e) => e.message);

// 66h: setupGallery 를 가짜 ipcMain 으로 띄워 gallery:rotate-preview · gallery:rotate 를 직접 불러요
//   휴지통은 가짜(임시 폴더 안 bin 으로 옮김)라 진짜 휴지통은 건드리지 않아요
async function mainFlow(env, et, t) {
  const out = [];
  const { createLogger } = require('../lib/logger');
  const { DatabaseSync } = require('node:sqlite');
  const gm = require('../gallery-main');
  const base = path.join(env.tmp, 'media-edit-main');
  const root = path.join(base, 'root');
  const bin = path.join(base, 'bin');
  const ud = path.join(base, 'ud');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const n of ['a', 'b', 'c', 'd']) {
    const p = path.join(root, `${n}.jpg`);
    await runCmd(t.magick.path, ['-size', '80x60', 'xc:blue', p]);
    await et.write(['-overwrite_original', '-DateTimeOriginal=2026:07:12 10:00:00', p]);
  }

  // 가짜 휴지통: ok = bin 으로 옮김, goneThrow = 옮긴 뒤 오류(결과를 모름), race = 옮긴 뒤 그 자리에 다른 파일이 생김(가져오기와 겹침)
  let trashMode = 'ok';
  let binN = 0;
  const trash = async (p) => {
    fs.renameSync(p, path.join(bin, `${++binN}-${path.basename(p)}`));
    if (trashMode === 'goneThrow') throw new Error('가짜 휴지통 오류');
    if (trashMode === 'race') fs.writeFileSync(p, 'race');
  };
  const handlers = new Map();
  const loaded = [];
  const g = gm.setupGallery({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    protocol: { handle: () => {} },
    getWin: () => null,
    getSettings: () => ({ backupRoot: root }),
    getTools: () => ({}),
    getEt: () => et,
    isRunning: () => false,
    isPlanning: () => false,
    logger: createLogger(path.join(base, 'logs')),
    userDir: ud,
    loadScreen: async (name) => { loaded.push(name); },
    getJobPending: () => false,
    trash,
    makeDriveKindOf: () => Object.assign(async () => 'fixed', { recycleOf: async () => null, binUsedOf: async () => 0 }),
  });
  const call = (ch, ...args) => handlers.get(ch)(null, ...args);
  // 다시 읽기가 끝날 때까지 기다려요 (돌린 뒤 main 이 바뀐 파일을 다시 읽어요)
  const idle = async (want) => {
    await sleep(150);
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const s = await call('gallery:get-state');
      if (!s.scan.scanning && (want === undefined || s.total >= want)) return true;
      await sleep(50);
    }
    return false;
  };
  const idOf = (name) => {
    const d = new DatabaseSync(path.join(ud, 'library.db'), { readOnly: true });
    try {
      const r = d.prepare('SELECT id FROM files WHERE path = ? AND missing = 0').get(path.join(root, name));
      return r ? Number(r.id) : null;
    } finally {
      d.close();
    }
  };
  const orient = async (p) => ((await et.read([p], ['Orientation#']))[0] || {}).Orientation;
  const noTmpDir = () => !fs.existsSync(path.join(root, '.pvm-edit'));

  try {
    g.onRootChanged();
    const ready = await idle(4);

    // 1) 복사본 저장 중에는 가져오기 화면으로 못 감 (같은 이름 파일이 생기지 않게)
    const hashA = hashOf(path.join(root, 'a.jpg'));
    const pCopy = call('gallery:rotate', idOf('a.jpg'), 90, 'copy');
    const blocked = await errOf(call('gallery:open-screen', 'import'));
    const rCopy = await pCopy.catch((e) => ({ err: e.message }));
    const copyOk = rCopy.done === 1 && (await orient(path.join(root, 'a_1.jpg'))) === 6 && hashOf(path.join(root, 'a.jpg')) === hashA && noTmpDir();
    out.push(sub('66h-1 복사본 저장 → a_1.jpg(Orientation 6), 원본 그대로, 저장 중에는 가져오기 화면으로 못 감',
      ready && copyOk && typeof blocked === 'string' && blocked.includes('옮기는 중') && !loaded.includes('import'),
      JSON.stringify({ ready, rCopy, blocked, loaded })));
    await idle();

    // 2) 확인 창(미리보기) 없이 원본 바꾸기 → 거절, 확인 뒤엔 바꿈, 한 번 쓴 확인으로 또 바꾸기 → 거절
    const pB = path.join(root, 'b.jpg');
    const hashB = hashOf(pB);
    const noPreview = await errOf(call('gallery:rotate', idOf('b.jpg'), 90, 'replace'));
    const sameB = hashOf(pB) === hashB;
    await call('gallery:rotate-preview', idOf('b.jpg'));
    const rB = await call('gallery:rotate', idOf('b.jpg'), 90, 'replace').catch((e) => ({ err: e.message }));
    const oB = await orient(pB);
    await idle();
    const again = await errOf(call('gallery:rotate', idOf('b.jpg'), 90, 'replace'));
    out.push(sub('66h-2 확인 창 없이 원본 바꾸기는 거절, 확인 뒤 바꿈(옛 원본은 가짜 휴지통, b.jpg Orientation 6), 쓴 확인으로 또 누르면 거절',
      !!noPreview && noPreview.includes('휴지통 확인') && sameB && rB.done === 1 && rB.trashed === 1 && oB === 6 && binN === 1
        && noTmpDir() && !!again && again.includes('휴지통 확인'),
      JSON.stringify({ noPreview, rB, oB, binN, again })));

    // 3) 휴지통이 옮긴 뒤 오류를 내도(결과를 모름) 원본 자리가 비었으면 돌린 파일을 둠 (빈 자리로 남기지 않음)
    const pC = path.join(root, 'c.jpg');
    await call('gallery:rotate-preview', idOf('c.jpg'));
    trashMode = 'goneThrow';
    const rC = await call('gallery:rotate', idOf('c.jpg'), 90, 'replace').catch((e) => ({ err: e.message }));
    trashMode = 'ok';
    const oC = fs.existsSync(pC) ? await orient(pC) : null;
    out.push(sub('66h-3 휴지통이 옮긴 뒤 오류 → 비어 있는 원본 자리에 돌린 파일을 둠 (c.jpg Orientation 6)',
      rC.done === 1 && oC === 6 && noTmpDir(), JSON.stringify({ rC, oC })));
    await idle();

    // 4) 옛 원본을 옮긴 사이 같은 이름 파일이 생기면 덮어쓰지 않고, 돌린 파일은 .pvm-edit 에 남겨 알림
    const pD = path.join(root, 'd.jpg');
    await call('gallery:rotate-preview', idOf('d.jpg'));
    trashMode = 'race';
    const rD = await call('gallery:rotate', idOf('d.jpg'), 90, 'replace').catch((e) => ({ err: e.message }));
    trashMode = 'ok';
    const keptOk = Array.isArray(rD.kept) && rD.kept.length === 1 && fs.existsSync(path.join(root, rD.kept[0]));
    out.push(sub('66h-4 옮기는 사이 같은 이름 파일이 생김 → 그 파일을 덮어쓰지 않고 돌린 파일은 남겨 알림',
      keptOk && fs.readFileSync(pD, 'utf8') === 'race' && rD.done === 0, JSON.stringify({ rD })));
    await idle();
  } finally {
    g.close();
  }
  return out;
}

const items = [
  {
    no: 66,
    name: '사진 · 영상 돌리기',
    async run(env) {
      const out = [];
      const t = env.tools;
      const et = env.et;
      const dir = path.join(env.tmp, 'media-edit');
      fs.mkdirSync(dir, { recursive: true });

      // 66a 방향 계산: Orientation(뒤집기는 그대로 두고 각도만) · 영상 회전 정보
      {
        const o = [[1, 90, 6], [6, 90, 3], [3, 90, 8], [8, 90, 1], [1, 270, 8], [6, 180, 8], [2, 90, 7], [7, 90, 4], [4, 90, 5], [5, 90, 2], [4, 180, 2], [undefined, 90, 6]];
        const r = [[0, 90, 90], [270, 90, 0], [90, 180, 270], [-90, 90, 0], [undefined, 270, 270]];
        const badO = o.filter(([c, turn, want]) => M.turnOrientation(c, turn) !== want);
        const badR = r.filter(([c, turn, want]) => M.turnRotation(c, turn) !== want);
        out.push(sub('66a 방향 계산 (Orientation 1→6→3→8→1, 뒤집힌 사진은 뒤집기 유지, 영상 회전 0·90·180·270)',
          !badO.length && !badR.length, JSON.stringify({ badO, badR })));
      }

      // 66b JPG: 방향 정보만 바뀌고 픽셀 · 촬영일 · 위치는 그대로, 원본 파일은 한 바이트도 안 바뀜
      if (!t.magick.ok) {
        out.push({ label: '66b JPG 돌리기', status: 'skip', detail: 'ImageMagick 없음' });
      } else {
        const src = path.join(dir, 'IMG_0001.jpg');
        await runCmd(t.magick.path, ['-size', '80x60', 'xc:red', src]);
        await et.write(['-overwrite_original', '-DateTimeOriginal=2026:07:12 10:00:00', '-GPSLatitude=37.5', '-GPSLatitudeRef=N', '-GPSLongitude=127.1', '-GPSLongitudeRef=E', src]);
        const before = hashOf(src);
        const o1 = path.join(dir, 'IMG_0001_r1.jpg');
        const o2 = path.join(dir, 'IMG_0001_r2.jpg');
        const a = await tryRotate({ et, src, turn: 90, out: o1 });
        // 돌린 파일을 한 번 더 왼쪽(270)으로 → 다시 정방향(1)
        const b = a.r ? await tryRotate({ et, src: o1, turn: 270, out: o2 }) : { r: null, err: '' };
        const tags = ['Orientation#', 'ImageWidth', 'ImageHeight', 'DateTimeOriginal', 'GPSLatitude#', 'GPSLongitude#'];
        const [m1] = a.r ? await et.read([o1], tags) : [{}];
        const [m2] = b.r ? await et.read([o2], tags) : [{}];
        const ok = !!a.r && a.r.kind === 'exif' && a.r.before === 1 && a.r.after === 6
          && m1.Orientation === 6 && m1.ImageWidth === 80 && m1.ImageHeight === 60
          && m1.DateTimeOriginal === '2026:07:12 10:00:00' && Math.abs(m1.GPSLatitude - 37.5) < 1e-4 && Math.abs(m1.GPSLongitude - 127.1) < 1e-4
          && !!b.r && m2.Orientation === 1 && hashOf(src) === before;
        out.push(sub('66b JPG 오른쪽으로 돌리기 → Orientation 6 (그림 80x60 · 촬영일 · 위치 그대로), 다시 왼쪽 → 1, 원본은 그대로',
          ok, a.err || b.err || JSON.stringify({ a: a.r, m1, o2: m2.Orientation })));
      }

      // 66c MOV: 영상 회전 정보만 바뀜 (다시 압축 안 함), 아이폰 촬영일(Keys:CreationDate) 그대로, 원본 그대로
      if (!t.ffmpeg.ok) {
        out.push({ label: '66c 영상 돌리기', status: 'skip', detail: 'FFmpeg 없음' });
      } else {
        const src = path.join(dir, 'IMG_0002.MOV');
        const mk = await runCmd(t.ffmpeg.path, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=10', '-c:v', 'libx264', src]);
        if (mk.code !== 0) {
          out.push({ label: '66c 영상 돌리기', status: 'skip', detail: '시험 영상을 못 만듦: ' + mk.stderr.slice(0, 80) });
        } else {
          await et.write(['-overwrite_original', '-Keys:CreationDate=2026:07:12 10:00:00+09:00', src]);
          const before = hashOf(src);
          const size = fs.statSync(src).size;
          const o1 = path.join(dir, 'IMG_0002_r1.MOV');
          const o2 = path.join(dir, 'IMG_0002_r2.MOV');
          const a = await tryRotate({ et, src, turn: 90, out: o1 });
          const b = a.r ? await tryRotate({ et, src: o1, turn: 270, out: o2 }) : { r: null, err: '' };
          const [m1] = a.r ? await et.read([o1], ['Rotation#', 'CreationDate']) : [{}];
          const [m2] = b.r ? await et.read([o2], ['Rotation#']) : [{}];
          // 재생 프로그램(ffprobe)도 돌린 것으로 알아보는지: 화면 회전 값 -90 (반시계 표기)
          const pr = a.r ? await runCmd(t.ffprobe.path, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream_side_data=rotation', '-of', 'csv=p=0', o1]) : { stdout: '' };
          const seen = Math.abs(Number(String(pr.stdout).trim().split(/\s|,/)[0]));
          // 다시 압축하지 않아서 크기가 거의 같아요 (머리 정보 몇 KB 차이만)
          const sameSize = a.r ? Math.abs(fs.statSync(o1).size - size) < 8192 : false;
          const ok = !!a.r && a.r.kind === 'video' && m1.Rotation === 90 && /^2026:07:12 10:00:00/.test(String(m1.CreationDate || ''))
            && seen === 90 && sameSize && !!b.r && (m2.Rotation || 0) === 0 && hashOf(src) === before;
          out.push(sub('66c MOV 오른쪽으로 돌리기 → 회전 정보 90 (재생기도 90 으로 읽음, 다시 압축 안 함, 촬영일 그대로), 다시 왼쪽 → 0, 원본은 그대로',
            ok, a.err || b.err || JSON.stringify({ a: a.r, m1, ffprobe: pr.stdout.trim(), sameSize, m2 })));
        }
      }

      // 66d PNG: 픽셀을 돌려서 가로세로가 바뀌고, 적어 둔 정보(제목)는 따라오고, Orientation 은 남기지 않음
      if (!t.magick.ok) {
        out.push({ label: '66d PNG 돌리기', status: 'skip', detail: 'ImageMagick 없음' });
      } else {
        const src = path.join(dir, 'shot.png');
        await runCmd(t.magick.path, ['-size', '80x60', 'xc:blue', src]);
        await et.write(['-overwrite_original', '-XMP-dc:Title=pvm-check', src]);
        const before = hashOf(src);
        const o1 = path.join(dir, 'shot_r1.png');
        const a = await tryRotate({ et, src, turn: 90, out: o1 });
        const [m1] = a.r ? await et.read([o1], ['ImageWidth', 'ImageHeight', 'Title', 'Orientation#']) : [{}];
        const ok = !!a.r && a.r.kind === 'pixels' && m1.ImageWidth === 60 && m1.ImageHeight === 80 && m1.Title === 'pvm-check'
          && m1.Orientation === undefined && hashOf(src) === before;
        out.push(sub('66d PNG 돌리기 → 그림 80x60 이 60x80 으로, 정보는 따라오고, 원본은 그대로', ok, a.err || JSON.stringify({ a: a.r, m1 })));
      }

      // 66e 실패하면 새 파일을 남기지 않고 원본은 그대로: 못 돌리는 형식 · 이상한 각도 · 이미 있는 이름 · exiftool 이 파일을 못 만든 경우
      {
        const src = path.join(dir, 'IMG_0001.jpg');
        const has = fs.existsSync(src);
        const before = has ? hashOf(src) : '';
        const heic = await tryRotate({ et, src: path.join(dir, 'IMG_9.HEIC'), turn: 90, out: path.join(dir, 'x.HEIC') });
        const badTurn = await tryRotate({ et, src, turn: 45, out: path.join(dir, 'x1.jpg') });
        const taken = path.join(dir, 'taken.jpg');
        fs.writeFileSync(taken, 'keep');
        const exists = await tryRotate({ et, src, turn: 90, out: taken });
        // 진짜로 파일은 만들었지만 "created" 를 말하지 않는 exiftool → 실패로 보고 만든 파일을 지워야 해요
        const quietEt = { read: et.read.bind(et), write: async (args) => { await et.write(args); return ''; } };
        const quietOut = path.join(dir, 'x2.jpg');
        const quiet = has ? await tryRotate({ et: quietEt, src, turn: 90, out: quietOut }) : { err: '' };
        const ok = /형식/.test(heic.err) && !fs.existsSync(path.join(dir, 'x.HEIC'))
          && /각도/.test(badTurn.err) && !fs.existsSync(path.join(dir, 'x1.jpg'))
          && /이미 있어요/.test(exists.err) && fs.readFileSync(taken, 'utf8') === 'keep'
          && (!has || (/만들지 못했어요/.test(quiet.err) && !fs.existsSync(quietOut) && hashOf(src) === before));
        out.push(sub('66e 돌리기 실패 → 새 파일 남기지 않음 (HEIC · 45도 · 이미 있는 이름은 그 파일 그대로 · exiftool 이 못 만들면 지움), 원본 그대로',
          ok, JSON.stringify({ heic: heic.err, badTurn: badTurn.err, exists: exists.err, quiet: quiet.err })));
      }

      // 66f 복사본에도 직접 넣은 날짜 · 위치와 내가 붙인 태그가 따라감 (DB, 경로 기준)
      await withDb(env, 'media-edit', async (db) => {
        db.applyManualBatch({ id: 'E1', root: 'R', kind: 'date', createdAt: '2026-11-23T00:00:00.000Z', items: [{ path: 'R/a.jpg', before: null, after: { takenAt: '2019-05-05T12:00:00', takenOffset: '+09:00', lat: 37.2, lng: 127.0 } }] });
        db.applyManualBatch({ id: 'E2', root: 'R', kind: 'tagAdd', createdAt: '2026-11-23T00:00:01.000Z', items: [{ path: 'R/a.jpg', before: [], after: ['가족', '수원'] }] });
        db.copyManual('R/a.jpg', 'R/a_1.jpg', 'R');
        // 아무것도 안 넣은 파일을 복사해도 빈 값 그대로 (오류 없음)
        db.copyManual('R/none.jpg', 'R/none_1.jpg', 'R');
        const m = db.getManual('R/a_1.jpg');
        const tags = db.getManualTags('R/a_1.jpg');
        const src = db.getManual('R/a.jpg');
        const ok = !!m && m.takenAt === '2019-05-05T12:00:00' && m.takenOffset === '+09:00' && m.lat === 37.2 && m.lng === 127.0
          && tags.join(',') === '가족,수원' && !!src && db.getManual('R/none_1.jpg') === null && db.getManualTags('R/none_1.jpg').length === 0;
        out.push(sub('66f 돌린 복사본에 직접 넣은 날짜 · 위치 · 태그가 따라감 (원본 값은 그대로)', ok, JSON.stringify({ m, tags })));
      });

      // 66g 화면 계산 · 문구 (src/rotate-view.mjs): 돌릴 수 있는 형식이 main 과 같고, 각도 · 크기 · 결과 문구
      {
        const V = await import('../src/rotate-view.mjs');
        const exts = Object.keys(M.ROTATE_KIND);
        const sameKinds = exts.every((e) => V.canRotate(`a${e.toUpperCase()}`) && V.canRotate(`a${e}`)) && !V.canRotate('a.heic') && !V.canRotate('a.gif') && !V.canRotate('');
        const turns = V.nextTurn(0, -90) === 270 && V.nextTurn(270, 90) === 0 && V.nextTurn(90, 90) === 180;
        const fit = V.fitScale(90, 4 / 3) === 0.75 && V.fitScale(180, 4 / 3) === 1 && V.fitScale(270, 0.5) === 0.5;
        const hint = V.replaceHint({ trash: 1, move: 0, pair: false }).includes('휴지통') && V.replaceHint({ trash: 0, move: 1, pair: true }).includes('_정리완료원본')
          && V.replaceHint({ trash: 1, move: 0, pair: true }).includes('짝 영상');
        const texts = [
          V.rotateResultText({ mode: 'copy', done: 1, pair: true }),
          V.rotateResultText({ mode: 'replace', done: 1, fail: 0, kept: [] }),
          V.rotateResultText({ mode: 'replace', done: 0, fail: 1, kept: [] }),
          V.rotateResultText({ mode: 'replace', done: 1, fail: 0, kept: ['IMG_1.jpg'] }),
          V.rotateResultText({ mode: 'replace', done: 2, fail: 0, kept: [], pair: true }),
        ];
        const textOk = texts[0].includes('복사본') && texts[0].includes('짝 영상') && texts[1].startsWith('돌린 모습으로 원본을 바꿨어요')
          && texts[2].includes('아무것도 바꾸지 않았어요') && texts[3].includes('IMG_1.jpg')
          && !texts[1].includes('짝 영상') && texts[4].includes('짝 영상도 같이 바꿨어요');
        out.push(sub('66g 화면 계산 · 문구 (돌릴 수 있는 형식이 main 과 같음, 각도 · 칸 맞춤 · 휴지통 안내 · 결과 문구)',
          sameKinds && turns && fit && hint && textOk, JSON.stringify({ sameKinds, turns, fit, hint, texts })));
      }

      // 66h main(gallery-main.js) 돌리기 흐름을 가짜 ipc · 가짜 휴지통으로 (Electron · 진짜 휴지통 없이, #138 검증 ⚠️ 1 · 2 · 5)
      if (!t.magick.ok) {
        out.push({ label: '66h 돌리기 main 흐름', status: 'skip', detail: 'ImageMagick 없음' });
      } else {
        out.push(...(await mainFlow(env, et, t)));
      }
      return out;
    },
  },
];

module.exports = { items };

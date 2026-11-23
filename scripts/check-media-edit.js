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
        const o = [[1, 90, 6], [6, 90, 3], [3, 90, 8], [8, 90, 1], [1, 270, 8], [6, 180, 8], [2, 90, 7], [4, 180, 2], [undefined, 90, 6]];
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
        ];
        const textOk = texts[0].includes('복사본') && texts[0].includes('짝 영상') && texts[1].startsWith('돌린 모습으로 원본을 바꿨어요')
          && texts[2].includes('아무것도 바꾸지 않았어요') && texts[3].includes('IMG_1.jpg');
        out.push(sub('66g 화면 계산 · 문구 (돌릴 수 있는 형식이 main 과 같음, 각도 · 칸 맞춤 · 휴지통 안내 · 결과 문구)',
          sameKinds && turns && fit && hint && textOk, JSON.stringify({ sameKinds, turns, fit, hint, texts })));
      }
      return out;
    },
  },
];

module.exports = { items };

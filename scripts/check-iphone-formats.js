// 파일 위치: scripts/check-iphone-formats.js
// 역할: 최신 아이폰 파일 형식 변환 점검 (54). scripts/check.js 의 ITEMS 끝에 붙어요
//   2026-11-14 실사용에서 실패한 두 경우를 시험 파일로 만들어 확인해요
//   ① MP4 에 담을 수 없는 소리 트랙이 하나 더 있는 영상 (아이폰 공간 음향 apple_apac 대신 adpcm_ima_qt 로 흉내)
//   ② 한 파일에 그림이 여러 장 든 사진 (HEIC 의 깊이 · HDR 보조 사진 대신 3장짜리 TIFF 로 흉내)
//   ③ 예전 실패가 남긴 이름.__tmp__-0.jpg 조각을 "실패한 파일 다시 시도"가 치우는지
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const { sub } = require('./check-gallery');
const { runCmd, probeVideo } = require('../lib/tools');
const { processItem } = require('../lib/processor');
const { requeueFailed } = require('../lib/runner');

const items = [
  {
    no: 54,
    name: '최신 아이폰 형식 변환',
    async run(env) {
      const out = [];
      const t = env.tools;
      const root = path.join(env.tmp, 'iphone-formats');
      const src = path.join(root, 'src');
      const backup = path.join(root, 'backup', '2026', '07', '12');
      fs.mkdirSync(src, { recursive: true });
      fs.mkdirSync(backup, { recursive: true });

      // 54a 소리 트랙이 2개(두 번째는 MP4 에 못 담는 형식)인 MOV → MP4 성공, 소리 1개
      if (!t.ffmpeg.ok) {
        out.push({ label: '54a 소리 트랙 2개 MOV', status: 'skip', detail: 'FFmpeg 없음' });
      } else {
        const mov = path.join(src, 'IMG_8719.MOV');
        const mk = await runCmd(t.ffmpeg.path, ['-y', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=10',
          '-f', 'lavfi', '-i', 'sine=duration=1', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1',
          '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-c:a:0', 'aac', '-c:a:1', 'adpcm_ima_qt', mov]);
        if (mk.code !== 0) {
          out.push({ label: '54a 소리 트랙 2개 MOV', status: 'skip', detail: '시험 영상을 못 만듦: ' + mk.stderr.slice(0, 80) });
        } else {
          const it = { i: 0, src: mov, kind: 'mov2mp4', converted: true, date: '2026:07:12 01:52:34', dest: path.join(backup, '2026-07-12_015234_IMG_8719.mp4') };
          let r = null;
          let err = '';
          try { r = await processItem(it, env.ctx); } catch (e) { err = e.message; }
          const streams = r ? (await runCmd(t.ffprobe.path, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', r.finalPath])).stdout.split(/\r?\n/).filter((l) => l.trim() === 'audio').length : 0;
          const v = r ? await probeVideo(t.ffprobe.path, r.finalPath) : { ok: false };
          const noted = !!r && /소리 트랙 2개 중 첫 번째만 옮김/.test(r.note || '');
          out.push(sub('54a 소리 트랙 2개 MOV → MP4 완료, 소리 트랙 1개, 재생됨, 작업 메모에 "첫 번째만 옮김"', !!r && r.status === 'done' && streams === 1 && v.ok === true && noted, err || `소리 ${streams}개, 재생 ${v.ok}, 메모 "${r && r.note}"`));
        }
      }

      // 54b 그림 3장이 든 사진 → 첫 장만 JPG 하나, 조각 임시 파일 없음
      if (!t.magick.ok) {
        out.push({ label: '54b 여러 장 든 사진', status: 'skip', detail: 'ImageMagick 없음' });
      } else {
        const multi = path.join(src, 'IMG_14081.tif');
        await runCmd(t.magick.path, ['-size', '80x60', 'xc:red', '-size', '40x30', 'xc:blue', '-size', '40x30', 'xc:green', multi]);
        const dir = path.join(root, 'backup', '2025', '08', '26');
        fs.mkdirSync(dir, { recursive: true });
        const it = { i: 1, src: multi, kind: 'heic2jpg', converted: true, date: '2025:08:26 18:30:17', dest: path.join(dir, '2025-08-26_183017_IMG_14081.jpg') };
        let r = null;
        let err = '';
        try { r = await processItem(it, env.ctx); } catch (e) { err = e.message; }
        const left = fs.readdirSync(dir).filter((n) => /__tmp__/.test(n));
        const dims = r ? (await env.et.read([r.finalPath], ['ImageWidth', 'ImageHeight']))[0] : {};
        out.push(sub('54b 그림 3장 든 사진 → 첫 장(80x60)만 JPG 1개, 조각 임시 파일 0개', !!r && r.status === 'done' && dims.ImageWidth === 80 && dims.ImageHeight === 60 && left.length === 0, err || `${dims.ImageWidth}x${dims.ImageHeight}, 남은 임시 ${left.join(',')}`));
      }

      // 54d 사진 변환이 실패하면 그 파일의 조각 임시 파일을 치움 (시작 전에 남아 있던 조각도). 이름이 비슷한 다른 파일은 그대로
      if (t.magick.ok) {
        const multi = path.join(src, 'IMG_2.tif');
        await runCmd(t.magick.path, ['-size', '80x60', 'xc:red', '-size', '40x30', 'xc:blue', multi]);
        const dir = path.join(root, 'backup', '2025', '08', '28');
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, '2025-08-28_100000_IMG_2.jpg');
        const junk = ['2025-08-28_100000_IMG_2.__tmp__-0.jpg', '2025-08-28_100000_IMG_2.__tmp__-1.jpg'];
        const keep = ['2025-08-28_100000_IMG_22.__tmp__-0.jpg', '2025-08-28_100000_IMG_2.__tmp__-x.jpg'];
        for (const n of [...junk, ...keep]) fs.writeFileSync(path.join(dir, n), 'x');
        // exiftool 쓰기가 실패하는 가짜 ctx → 변환 뒤 정보 복사에서 실패
        const badEt = { read: env.et.read.bind(env.et), write: async () => { throw new Error('exiftool: 시험 실패'); } };
        let err = '';
        try { await processItem({ i: 2, src: multi, kind: 'heic2jpg', converted: true, date: '2025:08:28 10:00:00', dest }, { ...env.ctx, et: badEt }); } catch (e) { err = e.message; }
        const now = fs.readdirSync(dir);
        const ok = /시험 실패/.test(err) && junk.every((n) => !now.includes(n)) && keep.every((n) => now.includes(n)) && !now.some((n) => /IMG_2\.__tmp__(\.jpg|-\d+\.jpg)$/.test(n));
        out.push(sub('54d 사진 변환 실패 → 그 파일의 조각 임시 파일만 치움', ok, `오류 "${err}", 남은 ${now.join(', ')}`));
      }

      // 54c 예전 실패가 남긴 조각(-0, -1)을 "실패한 파일 다시 시도"가 치움. 다른 파일 · 결과 파일은 그대로
      {
        const dir = path.join(root, 'backup', '2025', '08', '27');
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, '2025-08-27_100000_IMG_1.jpg');
        const junk = ['2025-08-27_100000_IMG_1.__tmp__-0.jpg', '2025-08-27_100000_IMG_1.__tmp__-1.jpg'];
        const keep = ['2025-08-27_100000_IMG_10.__tmp__-0.jpg', '2025-08-27_100000_IMG_1.jpg', '2025-08-27_100000_IMG_1.__tmp__-x.jpg'];
        for (const n of [...junk, ...keep]) fs.writeFileSync(path.join(dir, n), 'x');
        const job = { backupRoot: path.join(root, 'backup'), items: [{ i: 0, src: path.join(src, 'IMG_1.HEIC'), dest, status: 'fail', note: '시험' }] };
        const store = { mark: (j, i, patch) => Object.assign(j.items[i], patch) };
        const r = requeueFailed(job, store);
        const now = fs.readdirSync(dir);
        const ok = r.cleaned === 2 && junk.every((n) => !now.includes(n)) && keep.every((n) => now.includes(n)) && job.items[0].status === 'todo';
        out.push(sub('54c 실패 다시 시도가 그 파일의 조각 임시 파일만 치움 (이름이 비슷한 다른 파일은 그대로)', ok, `치운 ${r.cleaned}개, 남은 ${now.join(', ')}`));
      }
      return out;
    },
  },
];

module.exports = { items };

// 이 파일만 돌릴 때: node scripts/check-iphone-formats.js
if (require.main === module) {
  const os = require('os');
  const { ExifTool } = require('../lib/exiftool');
  const { detectTools } = require('../lib/tools');
  (async () => {
    const tools = await detectTools({}, path.join(__dirname, '..'));
    const et = new ExifTool(tools.exiftool.path);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvm-check-iphone-'));
    const env = { tmp, tools, et, ctx: { et, magick: tools.magick.path, ffmpeg: tools.ffmpeg.path, ffprobe: tools.ffprobe.path } };
    let failed = 0;
    try {
      for (const s of await items[0].run(env)) {
        if (s.status === 'fail') failed++;
        console.log(`${s.status === 'ok' ? '✅' : s.status === 'skip' ? '⏭' : '❌'} ${s.label}${s.detail ? ' — ' + s.detail : ''}`);
      }
    } finally {
      et.close();
      if (!failed) fs.rmSync(tmp, { recursive: true, force: true });
      else console.log('남긴 폴더: ' + tmp);
    }
    process.exit(failed ? 1 : 0);
  })();
}

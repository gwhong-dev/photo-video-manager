// 파일 위치: scripts/check-content-type.js
// 역할: 확장자와 내용이 다른 파일 점검 (59). scripts/check.js 의 ITEMS 끝에 붙어요
//   2026-11-18 실사용: 이름은 .JPG 인데 내용은 MOV(라이브 포토 영상)인 파일이 "이름만"으로 .jpg 가 돼서 썸네일이 실패했어요
//   자동 샘플(test/samples/auto)을 임시 폴더에 다른 이름으로 복사해서 시험해요 (개인 사진 안 씀, 샘플 원본은 그대로)
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const { sub } = require('./check-gallery');
const { probeVideo } = require('../lib/tools');
const { makePlan, contentExt, isIssue } = require('../lib/planner');
const { processItem } = require('../lib/processor');
const { isLivePair } = require('../lib/live-pair');

const SAMPLES = path.join(__dirname, '..', 'test', 'samples', 'auto');
// "2026:10:28 13:41:13" → "2026-10-28T13:41:13" (라이브 포토 짝 규칙이 쓰는 모양)
const iso = (d) => (d ? d.replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T') : null);

const items = [
  {
    no: 59,
    name: '확장자와 내용이 다른 파일',
    async run(env) {
      const out = [];
      const root = path.join(env.tmp, 'content-type');
      const src = path.join(root, 'src');
      const backupRoot = path.join(root, 'backup');
      fs.mkdirSync(src, { recursive: true });
      fs.mkdirSync(backupRoot, { recursive: true });
      // 이름은 .JPG 인 MOV (아이폰 라이브 포토 영상처럼 이름에 찍은 시각)
      const fakeMov = path.join(src, '2026-10-28_13-41-13.JPG');
      fs.copyFileSync(path.join(SAMPLES, 'IMG_0103.MOV'), fakeMov);
      // 이름은 .HEIC 인 JPEG
      const fakeHeic = path.join(src, 'IMG_0201.HEIC');
      fs.copyFileSync(path.join(SAMPLES, 'IMG_0101.jpg'), fakeHeic);
      // 이름과 내용이 맞는 파일은 지금처럼
      fs.copyFileSync(path.join(SAMPLES, 'IMG_0103.MOV'), path.join(src, 'IMG_0301.MOV'));
      fs.copyFileSync(path.join(SAMPLES, 'IMG_0104.jpg'), path.join(src, 'IMG_0302.jpg'));

      // 59a 확장자 판단 규칙
      const rules = [
        ['.jpg', 'MOV', '.mov'], ['.heic', 'JPEG', '.jpg'], ['.jpg', 'HEIC', '.heic'], ['.png', 'MP4', '.mp4'],
        ['.jpg', 'JPEG', '.jpg'], ['.jpeg', 'JPEG', '.jpeg'], ['.tiff', 'TIFF', '.tiff'],
        ['.mp4', 'MOV', '.mp4'], ['.jpg', undefined, '.jpg'], ['.jpg', 'MPO', '.jpg'],
      ];
      const wrong = rules.filter(([ext, ft, want]) => contentExt(ext, ft) !== want).map(([ext, ft, want]) => `${ext}+${ft}→${contentExt(ext, ft)}(기대 ${want})`);
      out.push(sub('59a 내용 기준 확장자: 사진↔영상 · 사진끼리만 내용을 따르고, 영상끼리 · 모르는 종류는 확장자 그대로', wrong.length === 0, wrong.join(', ')));

      const plan = await makePlan({ source: src, backupRoot, includeSub: true }, env.et);
      const by = (name) => plan.items.find((it) => path.basename(it.src) === name);
      const mov = by('2026-10-28_13-41-13.JPG');
      const heic = by('IMG_0201.HEIC');

      // 59b 이름은 .JPG 인 MOV → 영상으로 MOV→MP4, 촬영일은 Keys:CreationDate (13:41:13, 일부러 넣은 잘못된 XMP 날짜 11:00 아님)
      const movOk = !!mov && mov.kind === 'mov2mp4' && mov.isVideo === true && path.extname(mov.name) === '.mp4' &&
        mov.date === '2026:10:28 13:41:13' && mov.relDir === path.join('2026', '10', '28') && /내용은 MOV/.test(mov.typeNote) && isIssue(mov);
      out.push(sub('59b 이름 .JPG · 내용 MOV → MOV→MP4 예정, 결과 .mp4, 촬영일 Keys:CreationDate, 주의 목록에 보임', movOk,
        mov ? `${mov.kind} ${mov.name} ${mov.date} (${mov.dateFrom}) "${mov.typeNote}"` : '항목 없음'));

      // 59c 이름은 .HEIC 인 JPEG → 변환 없이 복사, 결과 .jpg
      const heicOk = !!heic && heic.kind === 'copy' && heic.isVideo === false && path.extname(heic.name) === '.jpg' && /내용은 JPEG/.test(heic.typeNote);
      out.push(sub('59c 이름 .HEIC · 내용 JPEG → 이름만(복사), 결과 .jpg', heicOk, heic ? `${heic.kind} ${heic.name} "${heic.typeNote}"` : '항목 없음'));

      // 59d 이름과 내용이 맞는 파일은 그대로 (MOV→MP4 / 이름만, 메모 없음)
      const a = by('IMG_0301.MOV');
      const b = by('IMG_0302.jpg');
      const sameOk = !!a && !!b && a.kind === 'mov2mp4' && b.kind === 'copy' && !a.typeNote && !b.typeNote && path.extname(b.name) === '.jpg';
      out.push(sub('59d 이름과 내용이 맞는 파일은 지금과 같음', sameOk, `${a && a.kind}/${b && b.kind} 메모 "${a && a.typeNote}" "${b && b.typeNote}"`));

      // 59e 실제로 처리 → .mp4 가 만들어지고 재생됨 (처리 전 재생 확인도 함)
      if (!env.tools.ffmpeg.ok || !env.tools.ffprobe.ok) {
        out.push({ label: '59e 이름 .JPG 인 MOV 처리', status: 'skip', detail: 'FFmpeg 없음' });
      } else if (mov) {
        let r = null;
        let err = '';
        try { r = await processItem(mov, env.ctx); } catch (e) { err = e.message; }
        const v = r && r.finalPath ? await probeVideo(env.tools.ffprobe.path, r.finalPath) : { ok: false };
        const ft = r && r.finalPath ? ((await env.et.read([r.finalPath], ['FileType']))[0] || {}).FileType : '';
        out.push(sub('59e 처리 결과 .mp4 (내용 MP4), 재생됨, 만든 직후 재생 확인 통과', !!r && r.status === 'done' && path.extname(r.finalPath) === '.mp4' && ft === 'MP4' && v.ok === true && r.resultPlayable === true,
          err || `${r && r.status} ${r && path.basename(r.finalPath)} ${ft} 재생 ${v.ok}`));
      }

      // 59f 라이브 포토 짝: 결과 .mp4 는 같은 이름 사진의 영상 짝이 돼요. 예전처럼 .jpg 였다면 짝이 아니었어요
      if (mov) {
        const stem = path.basename(mov.name, '.mp4');
        const photo = { path: path.join(path.dirname(mov.dest), stem + '.jpg'), takenAt: iso(mov.date) };
        const nowPair = isLivePair(photo, { path: mov.dest, durationSec: 1, takenAt: iso(mov.date) });
        const oldPair = isLivePair(photo, { path: path.join(path.dirname(mov.dest), stem + '.jpg'), durationSec: 1, takenAt: iso(mov.date) });
        out.push(sub('59f 결과 .mp4 는 같은 이름 사진의 라이브 포토 영상 짝 (사진끼리로 묶이지 않음)', nowPair && !oldPair, `지금 ${nowPair}, 옛 이름 ${oldPair}`));
      }
      return out;
    },
  },
];

module.exports = { items };

// 이 파일만 돌릴 때: node scripts/check-content-type.js
if (require.main === module) {
  const os = require('os');
  const { ExifTool } = require('../lib/exiftool');
  const { detectTools } = require('../lib/tools');
  (async () => {
    const tools = await detectTools({}, path.join(__dirname, '..'));
    const et = new ExifTool(tools.exiftool.path);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvm-check-content-'));
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

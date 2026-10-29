// 파일 위치: scripts/make-samples.js
// 역할: 점검용 자동 샘플 만들기 → test/samples/auto/  (실행: npm run samples)
//
// 개인 사진은 하나도 안 써요. 그림은 ImageMagick으로, 영상은 FFmpeg로 새로 만들고
// 날짜·태그는 exiftool로 넣어요.
// 이미 있는 파일은 건너뛰어요 (다시 만들고 싶으면 그 파일을 직접 지우고 실행).

const fs = require('fs');
const path = require('path');
const { detectTools, runOrThrow } = require('../lib/tools');
const { ExifTool } = require('../lib/exiftool');

const appDir = path.join(__dirname, '..');
const OUT = path.join(appDir, 'test', 'samples', 'auto');

// 만들 샘플 목록 (기대 결과는 scripts/check.js에 있어요)
const SAMPLES = [
  { rel: 'IMG_0101.jpg', draw: ['gradient:#3B3A37-#E0412F'], tags: ['-DateTimeOriginal=2026:10:28 13:40:58', '-Model=iPhone 18 Pro'] },
  { rel: 'dup/IMG_0101.jpg', copyOf: 'IMG_0101.jpg' }, // 바이트까지 똑같은 복사본
  { rel: 'other/IMG_0101.jpg', draw: ['xc:#55534E', '-fill', '#F1EEE6', '-draw', 'circle 160,120 160,60'], tags: ['-DateTimeOriginal=2026:10:28 13:40:58', '-Model=iPhone 18 Pro'] },
  { rel: '여행 사진/2026-10-28_13-41-05_여행.jpg', draw: ['gradient:#403F3B-#E3B341'], tags: ['-DateTimeOriginal=2026:10:28 13:41:05'] },
  { rel: 'KakaoTalk_20261028_210941.jpg', draw: ['gradient:#33322F-#B3AFA5'] },
  { rel: 'IMG_0102.PNG', draw: ['xc:#8C887E'], tags: ['-XMP-exif:DateTimeOriginal=2026:10:27 09:15:00', '-XMP-dc:Subject=스크린샷'] },
  {
    rel: 'IMG_0103.MOV',
    video: true,
    tags: [
      '-Keys:CreationDate=2026:10:28 13:41:13+09:00', // 진짜 찍은 시각
      '-QuickTime:CreateDate=2026:10:29 02:00:00',     // 전송한 시각 (UTC)
      '-XMP-exif:DateTimeOriginal=2026:10:29 11:00:00', // 일부러 넣은 잘못된 날짜
      '-XMP-dc:Subject=비디오',
      '-XMP-dc:Subject=수원시',
    ],
  },
  { rel: 'noinfo.jpg', draw: ['xc:#F1EEE6'] },
  // Windows가 복사할 때 붙이는 "(1)" — 이름은 다르지만 내용은 똑같은 파일
  { rel: 'IMG_0104.jpg', draw: ['gradient:#F1EEE6-#55534E'], tags: ['-DateTimeOriginal=2026:10:28 13:42:00'] },
  { rel: 'IMG_0104(1).jpg', copyOf: 'IMG_0104.jpg' },
];

(async () => {
  const tools = await detectTools({}, appDir);
  for (const n of ['exiftool', 'magick', 'ffmpeg']) {
    if (!tools[n].ok) throw new Error(`${n}을(를) 찾지 못했어요. 설치 후 새 터미널에서 다시 실행해 주세요.`);
  }
  const et = new ExifTool(tools.exiftool.path);

  try {
    for (const s of SAMPLES) {
      const out = path.join(OUT, s.rel);
      if (fs.existsSync(out)) {
        console.log(`건너뜀 (이미 있음): ${s.rel}`);
        continue;
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });

      if (s.copyOf) {
        fs.copyFileSync(path.join(OUT, s.copyOf), out);
      } else if (s.video) {
        // 1초짜리 작은 시험 영상 (소리 없음)
        await runOrThrow(tools.ffmpeg.path, [
          '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=10',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mov', out,
        ], 'FFmpeg');
      } else {
        await runOrThrow(tools.magick.path, ['-size', '320x240', ...s.draw, out], 'ImageMagick');
      }

      if (s.tags) await et.write(['-overwrite_original', ...s.tags, out]);
      console.log(`만듦: ${s.rel}`);
    }
  } finally {
    et.close();
  }
})().catch((e) => {
  console.error('❌ ' + e.message);
  process.exit(1);
});

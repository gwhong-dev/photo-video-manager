// 파일 위치: scripts/check-video-player.js
// 역할: 앱 안 영상 재생 점검 (73). scripts/check.js 의 ITEMS 끝에 붙어요
//   2026-11-27 필수 기능 순위 2위: 갤러리에서 영상을 고르면 오른쪽 패널에서 바로 재생 · 건너뛰기
//   pvm://video/<id> 로 원본을 주고, 건너뛸 때 오는 구간 요청(Range)에는 그 구간만 206 으로 줘요
//   ⚠️ 영상 파일은 고치지 않아요. 자동 샘플 복사본만 써요
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const { sub } = require('./check-gallery');

const SAMPLE_MOV = path.join(__dirname, '..', 'test', 'samples', 'auto', 'IMG_0103.MOV'); // H.264 짧은 영상 (자동 샘플)

const items = [
  {
    no: 73,
    name: '앱 안 영상 재생 (pvm://video · 건너뛰기 구간 요청)',
    async run(env) {
      const out = [];
      const { parseRange, fileRangeResponse } = require('../lib/byte-range');
      const { handleMedia } = require('../lib/media-protocol');
      const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

      // 73a 구간 요청 풀기: 앞 · 뒤 · 끝에서 · 넘침 · 여러 구간 · 모르는 모양
      {
        const S = 1000;
        const cases = [
          ['bytes=0-99', { start: 0, end: 99 }],
          ['bytes=500-', { start: 500, end: 999 }],
          ['bytes=-100', { start: 900, end: 999 }],
          ['bytes=-5000', { start: 0, end: 999 }], // 파일보다 길게 달라면 전체
          ['bytes=900-5000', { start: 900, end: 999 }], // 끝이 넘치면 파일 끝까지
          ['bytes=1000-', { unsatisfiable: true }],
          ['bytes=-0', { unsatisfiable: true }],
          ['bytes=0-10,20-30', null], // 여러 구간은 전체로
          ['bytes=50-10', null], // 뒤집힌 구간은 전체로
          ['items=0-10', null],
          ['bytes=-', null],
          [undefined, null],
          [null, null],
        ];
        const bad = cases.filter(([h, want]) => JSON.stringify(parseRange(h, S)) !== JSON.stringify(want));
        out.push(sub('73a 구간 요청(Range) 풀기: 앞 · 뒤 · 끝에서 · 넘침은 파일 끝까지, 파일 밖은 416, 여러 구간 · 뒤집힘 · 모르는 모양은 전체',
          bad.length === 0, bad.map(([h]) => `${h} → ${JSON.stringify(parseRange(h, S))}`).join(' | ')));
      }

      // 73b pvm://video: 영상만 원본 경로, 사진 · 없는 파일 · 빠진 파일 · 상대 경로는 404
      {
        const base = path.join(env.tmp, 'video-player');
        fs.mkdirSync(base, { recursive: true });
        const mov = path.join(base, 'IMG_0103.MOV');
        fs.copyFileSync(SAMPLE_MOV, mov);
        const rows = {
          1: { id: 1, root: base, path: mov, mediaType: 'video', thumbState: 'done' },
          2: { id: 2, root: base, path: path.join(base, 'a.jpg'), mediaType: 'photo', thumbState: 'done' },
          3: { id: 3, root: base, path: path.join(base, 'gone.mp4'), mediaType: 'video', thumbState: 'done', missing: true },
          4: { id: 4, root: base, path: 'rel/x.mp4', mediaType: 'video', thumbState: 'done' },
          5: { id: 5, root: base, path: path.join(base, 'old.avi'), mediaType: 'video', thumbState: 'failed' },
        };
        const db = { getFile: (id) => rows[id] || null, sameStem: () => [] };
        const thumbs = { request: async () => null, preview: async () => ({ buffer: Buffer.from('webp'), type: 'image/webp' }) };
        const H = (u) => handleMedia(u, { db, thumbs });
        const v1 = await H('pvm://video/1?v=5');
        const v5 = await H('pvm://video/5');
        const others = await Promise.all(['pvm://video/2', 'pvm://video/3', 'pvm://video/4', 'pvm://video/9', 'pvm://video/01', 'pvm://video/1/x', 'pvm://video/..%2F1'].map(H));
        out.push(sub('73b pvm://video 는 영상 원본 경로(MOV 종류), 썸네일이 실패한 영상도 재생은 시도, 사진 · 빠진 파일 · 상대 경로 · 없는 번호 · 이상한 주소는 404',
          v1.status === 200 && v1.path === mov && v1.type === 'video/quicktime' && v5.status === 200 && v5.type === 'video/x-msvideo' && others.every((r) => r.status === 404),
          JSON.stringify({ v1: v1.type, v5: v5.type, others: others.map((r) => r.status) })));
      }

      // 73e 구간 응답 (실제 파일): bytes=0-99 → 206 · 100바이트, 요청 없음 → 200 · 전체, 파일 밖 → 416
      //   화면 보안 설정(CSP)이 화면에서 fetch 를 막아서, 응답 만들기는 Node 에서 직접 확인해요
      {
        const size = fs.statSync(SAMPLE_MOV).size;
        const want = fs.readFileSync(SAMPLE_MOV);
        const H0 = { 'Content-Type': 'video/quicktime' };
        const a = await fileRangeResponse(SAMPLE_MOV, H0, 'bytes=0-99');
        const ab = Buffer.from(await a.arrayBuffer());
        const t = await fileRangeResponse(SAMPLE_MOV, H0, 'bytes=-50');
        const tb = Buffer.from(await t.arrayBuffer());
        const w = await fileRangeResponse(SAMPLE_MOV, H0, null);
        const wb = Buffer.from(await w.arrayBuffer());
        const x = await fileRangeResponse(SAMPLE_MOV, H0, 'bytes=999999999-');
        const info = { a: [a.status, ab.length, a.headers.get('content-range')], t: [t.status, tb.length], w: [w.status, wb.length, w.headers.get('content-length')], x: [x.status, x.headers.get('content-range')] };
        out.push(sub('73e 구간 응답: bytes=0-99 → 206 · 앞 100바이트 · Content-Range, 끝 50바이트, 요청 없음 → 200 · 전체 같은 내용, 파일 밖 → 416 · bytes */크기, 모두 Accept-Ranges',
          a.status === 206 && ab.equals(want.subarray(0, 100)) && a.headers.get('content-range') === `bytes 0-99/${size}` && a.headers.get('content-length') === '100'
            && t.status === 206 && tb.equals(want.subarray(size - 50))
            && w.status === 200 && wb.equals(want) && w.headers.get('content-length') === String(size) && w.headers.get('content-type') === 'video/quicktime'
            && x.status === 416 && x.headers.get('content-range') === `bytes */${size}`
            && [a, t, w, x].every((r) => r.headers.get('accept-ranges') === 'bytes'),
          JSON.stringify(info)));
      }

      // 73c 연결: gallery-main 이 video 는 구간 응답으로, 패널은 영상이면 재생기, 못 열면 썸네일 + 안내
      {
        const gm = read('gallery-main.js');
        const dp = read('src/components/DetailPanel.jsx');
        const vp = read('src/components/VideoPlayer.jsx');
        out.push(sub('73c 연결: video 요청은 Range 를 넘겨 구간 응답, 영상 패널은 VideoPlayer(controls · preload=metadata · poster), 재생 실패면 썸네일 + 안내, 돌리기 미리 볼 땐 썸네일',
          /u\.hostname === 'video'\) return await fileRangeResponse\(r\.path, headers, request\.headers\.get\('range'\)\)/.test(gm)
            && /<VideoPlayer file=\{file\}/.test(dp) && /isVideo && !turn && unplayable !== playKey/.test(dp) && /playKey = `\$\{file\.id\}:\$\{file\.mtimeMs/.test(dp) && /UNPLAYABLE_TEXT/.test(dp)
            && /controls/.test(vp) && /preload="metadata"/.test(vp) && /poster=\{poster\}/.test(vp) && /onError=\{onUnplayable\}/.test(vp)));
      }

      // 73d 진짜 앱: 백업 폴더에 영상 1개 + 못 여는 영상 1개 → 영상을 고르면 패널에서 재생 · 건너뛰기, 못 여는 영상은 안내
      {
        const { launchCheck } = require('./launch-check');
        const root = path.join(env.tmp, 'launch-video-root');
        fs.mkdirSync(root, { recursive: true });
        fs.copyFileSync(SAMPLE_MOV, path.join(root, 'IMG_0103.MOV'));
        fs.writeFileSync(path.join(root, 'old.avi'), Buffer.from('RIFF0000AVI not a real video'.repeat(20))); // 재생 안 되는 가짜 영상
        const snap = () => fs.readdirSync(root).sort().map((n) => `${n}:${fs.statSync(path.join(root, n)).size}`).join(',');
        const before = snap();
        const ud = path.join(env.tmp, 'launch-video-ud');
        fs.mkdirSync(ud, { recursive: true });
        fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ backupRoot: root }), 'utf8');
        const r = await launchCheck(path.join(__dirname, '..'), {
          env: { PVM_USER_DATA: ud },
          until: '백업 폴더 다시 읽기',
          untilMs: 30000,
          probe: `(${videoProbe.toString()})()`,
        });
        const q = r.probed || {};
        const seen = JSON.stringify(q).slice(0, 700);
        out.push(sub('73d 진짜 앱: 영상을 고르면 패널에 재생기, 길이를 읽고 재생 · 뒤로 건너뛰기가 됨',
          q.player === true && q.duration > 0 && q.played === true && q.seeked === true, seen));
        out.push(sub('73d 못 여는 영상(가짜 AVI)은 재생기 대신 안내 한 줄, 영상 파일 그대로, 화면 오류 없음 (못 여는 영상 자체의 읽기 실패는 빼고)',
          q.badNote === true && q.badPlayer === false && snap() === before && !(r.errors || []).some((e) => !/Failed to load resource|MEDIA_ERR|DEMUXER|PIPELINE/i.test(e)),
          `${seen} / 오류 ${(r.errors || []).join(' | ').slice(0, 300)}`));
      }
      return out;
    },
  },
];

// 진짜 앱 창 안에서 도는 확인 (launch-check 의 probe). 재생 · 건너뛰기만 하고 파일은 건드리지 않아요
async function videoProbe() {
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
  const cellOf = (name) => document.querySelector(`button.cell[aria-label="${name}"]`);
  const cell = await wait(() => cellOf('IMG_0103.MOV'), 30000);
  if (!cell) return { stop: 'IMG_0103.MOV 칸이 없어요', cells: [...document.querySelectorAll('button.cell')].map((c) => c.getAttribute('aria-label')) };
  cell.click();
  const v = await wait(() => document.querySelector('.preview video.video-player'));
  q.player = !!v;
  if (!v) return { ...q, stop: '재생기가 없어요', panel: (document.querySelector('.panel') || {}).innerText };
  q.duration = (await wait(() => (v.readyState >= 1 && v.duration > 0 ? v.duration : 0))) || 0;
  v.muted = true; // 점검 중 소리가 나지 않게
  try { await v.play(); } catch (e) { q.playError = String(e && e.message); }
  q.played = !!(await wait(() => !v.paused && v.currentTime > 0, 8000));
  v.pause();
  // 뒤로 건너뛰기: 끝 가까이로 옮겨 seeked 가 오는지
  const target = Math.max(0, q.duration * 0.8);
  const seeked = new Promise((res) => v.addEventListener('seeked', () => res(true), { once: true }));
  v.currentTime = target;
  q.seeked = !!(await Promise.race([seeked, new Promise((res) => setTimeout(() => res(false), 8000))]));
  q.at = Math.round(v.currentTime * 10) / 10;
  // 못 여는 영상: 재생기 대신 안내 한 줄
  const bad = await wait(() => cellOf('old.avi'), 10000);
  if (!bad) return { ...q, stop: 'old.avi 칸이 없어요' };
  bad.click();
  q.badNote = !!(await wait(() => /재생하지 못하는 영상 형식/.test((document.querySelector('.panel') || {}).innerText || ''), 10000));
  q.badPlayer = !!document.querySelector('.preview video.video-player');
  return q;
}

module.exports = { items };

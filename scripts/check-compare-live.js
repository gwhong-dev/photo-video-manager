// 파일 위치: scripts/check-compare-live.js
// 역할: 비슷한 사진 크게 비교 + 라이브 포토 · 모션 포토 재생 점검 (64). scripts/check.js 의 ITEMS 끝에 붙어요
//   2026-11-21 사용자 요청: "미리보기 크기가 고정이라 자세히 볼 수가 없네" + "라이브 포토인데 재생이 안 되는 거야?"
//   비교 창: ←/→ 넘기기, Space 로 가장 좋은 사진 왼쪽 고정, 오른쪽에서 ↑ 버림 · ↓ 남김, 두 칸 같이 확대
//   라이브: 같은 이름의 짝 영상, 또는 JPG 끝에 붙은 영상(모션 포토, XMP MicroVideoOffset · MotionPhoto Item:Length)
//   ⚠️ 사진 파일은 고치지 않고 옮기지도 않아요 (비교 창은 표시만 바꿔요). 자동 샘플 복사본만 써요
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const { sub } = require('./check-gallery');

const SAMPLE_MOV = path.join(__dirname, '..', 'test', 'samples', 'auto', 'IMG_0103.MOV'); // H.264 짧은 영상 (자동 샘플)

// JPG 에 XMP(모션 포토 표시)를 넣고 끝에 영상을 붙여요. style: 'v1' (MicroVideoOffset) | 'v2' (Container Item:Length) | 'bad' (자리가 틀림)
function withMotion(jpg, video, style = 'v1') {
  const len = style === 'bad' ? video.length + 7 : video.length;
  const xmp = style === 'v2'
    ? `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" GCamera:MotionPhoto="1"><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${len}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>`
    : `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:GCamera="http://ns.google.com/photos/1.0/camera/" GCamera:MicroVideo="1" GCamera:MicroVideoVersion="1" GCamera:MicroVideoOffset="${len}"/></rdf:RDF></x:xmpmeta>`;
  const body = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(xmp, 'utf8')]);
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  return Buffer.concat([jpg.subarray(0, 2), seg, jpg.subarray(2), video]);
}

const items = [
  {
    no: 64,
    name: '비슷한 사진 크게 비교 + 라이브 포토 재생',
    async run(env) {
      const out = [];
      const M = require('../lib/motion-photo');
      const { handleMedia } = require('../lib/media-protocol');
      const SV = await import('../src/similar-view.mjs');
      const C = await import('../src/compare-view.mjs');
      const { makeImage } = require('./check-similar');
      const base = path.join(env.tmp, 'compare-live');
      fs.mkdirSync(base, { recursive: true });
      const video = fs.readFileSync(SAMPLE_MOV);

      // 64a 모션 포토에서 영상 자리 찾기: 1판 · 2판 표시, 표시 없음 · 자리가 틀림은 없음
      {
        const plain = path.join(base, 'plain.jpg');
        await makeImage(plain, { seed: 3 });
        const jpg = fs.readFileSync(plain);
        const files = {};
        for (const st of ['v1', 'v2', 'bad']) {
          files[st] = path.join(base, `motion-${st}.jpg`);
          fs.writeFileSync(files[st], withMotion(jpg, video, st));
        }
        const stOf = (p) => { const s = fs.statSync(p); return `${s.size}|${s.mtimeMs}`; };
        const stBefore = stOf(files.v1);
        const v1 = await M.motionVideoOf(files.v1);
        const v2 = await M.motionVideoOf(files.v2);
        const bad = await M.motionVideoOf(files.bad);
        const none = await M.motionVideoOf(plain);
        const buf = await M.readMotionVideo(files.v1);
        out.push(sub('64a 모션 포토 영상 자리: 1판(MicroVideoOffset) · 2판(MotionPhoto Item:Length)을 읽고, 영상(ftyp)으로 시작할 때만. 표시 없음 · 자리 틀림은 없음',
          v1 && v1.length === video.length && v2 && v2.length === video.length && bad === null && none === null
            && buf && buf.equals(video) && M.tailLengthOf('<GCamera:MicroVideoOffset>123</GCamera:MicroVideoOffset>') === 123,
          JSON.stringify({ v1, v2, bad, none })));
        // 사진 파일은 고치지 않아요
        out.push(sub('64a 읽기만 함 (사진 파일 크기 · 수정 시각 그대로)', stOf(files.v1) === stBefore));

        // 64b pvm:// 주소: original(원본 그대로 · 못 그리는 형식은 미리보기), live(짝 영상 > 모션 포토 > 없음), 모르는 호스트는 404
        const pair = path.join(base, 'pair.jpg');
        const pairMov = path.join(base, 'pair.mov');
        fs.copyFileSync(plain, pair);
        fs.copyFileSync(SAMPLE_MOV, pairMov);
        const rows = {
          1: { id: 1, root: base, path: files.v1, mediaType: 'photo', thumbState: 'done', takenAt: '2026-11-17T18:49:27' },
          2: { id: 2, root: base, path: plain, mediaType: 'photo', thumbState: 'done', takenAt: '2026-11-17T18:49:28' },
          3: { id: 3, root: base, path: pair, mediaType: 'photo', thumbState: 'done', takenAt: '2026-11-17T18:50:00' },
          4: { id: 4, root: base, path: pairMov, mediaType: 'video', thumbState: 'done', takenAt: '2026-11-17T18:50:01', durationSec: 2 },
          5: { id: 5, root: base, path: path.join(base, 'x.heic'), mediaType: 'photo', thumbState: 'done' },
        };
        const db = {
          getFile: (id) => rows[id] || null,
          sameStem: (root, stem) => Object.values(rows).filter((r) => r.root === root && r.path.slice(0, r.path.length - path.extname(r.path).length) === stem),
        };
        const thumbs = { request: async () => null, preview: async () => ({ buffer: Buffer.from('webp'), type: 'image/webp' }) };
        const H = (u) => handleMedia(u, { db, thumbs });
        const o1 = await H('pvm://original/2');
        const o5 = await H('pvm://original/5');
        const l1 = await H('pvm://live/1');
        const l3 = await H('pvm://live/3');
        const l2 = await H('pvm://live/2');
        const l4 = await H('pvm://live/4');
        const odd = await H('pvm://video/1');
        out.push(sub('64b pvm://original 은 JPG 원본 그대로, HEIC 는 1200px 미리보기로 대신',
          o1.status === 200 && o1.path === plain && o1.type === 'image/jpeg' && o5.status === 200 && !o5.path && o5.type === 'image/webp',
          JSON.stringify({ o1: o1.type, o5: o5.type })));
        out.push(sub('64b pvm://live 는 짝 영상(같은 이름 · 5초 이하 · 3초 안) 먼저, 없으면 JPG 끝 영상, 보통 사진은 204(화면 오류 로그 없게), 영상 번호 · 모르는 호스트는 404',
          l3.status === 200 && l3.path === pairMov && l1.status === 200 && l1.buffer && l1.buffer.equals(video) && l1.type === 'video/mp4'
            && l2.status === 204 && l4.status === 404 && odd.status === 404,
          JSON.stringify({ l1: l1.status, l2: l2.status, l3: l3.path && path.basename(l3.path), l4: l4.status, odd: odd.status })));
      }

      // 64c 표시 규칙: Space 고정 = 남김 (아무것도 안 고른 묶음이면 원래 추천은 버림), ↑/↓ 는 정해서 표시, 마지막 남김은 못 버림
      {
        const g = { ids: [11, 12, 13, 14], keepId: 12, softIds: [], keptIds: [] };
        const o0 = SV.pinMarks([g], new Map());
        const p = SV.pinBest(g, 14, o0);
        const touched = SV.setMark(g, 13, 'keep', o0).overrides; // 13 을 남김으로 고른 묶음
        const p2 = SV.pinBest(g, 14, touched);
        const only = SV.setMark(g, 14, 'discard', p); // 14 가 유일한 남김 → 거절
        const same = SV.setMark(g, 11, 'discard', p); // 이미 버림 → 사용자가 고른 것으로 적음
        out.push(sub('64c Space 고정: 고정한 사진 남김 + (안 고른 묶음이면) 원래 추천 버림, 이미 고른 묶음은 다른 표시 그대로',
          SV.markOf(g, 14, p) === 'keep' && SV.markOf(g, 12, p) === 'discard' && SV.discardIds([g], p).length === 3
            && SV.markOf(g, 14, p2) === 'keep' && SV.markOf(g, 12, p2) === 'keep' && SV.markOf(g, 13, p2) === 'keep'));
        out.push(sub('64c ↑ 버림 · ↓ 남김: 마지막 남김은 버리지 못함, 같은 표시여도 사용자가 고른 것으로 적음',
          only.refused === true && same.refused === false && same.overrides.get(11) === 'discard'));
      }

      // 64d 비교 창 계산: 키, 넘기기, 두 칸 같이 확대 (마우스 자리 고정), 맞춤 ↔ 원본 크기, 끌기
      {
        const K = (key, extra = {}) => C.compareKey({ key, ...extra });
        out.push(sub('64d 키: ←/→ 넘기기, Space 고정, ↑ 버림, ↓ 남김, Esc 닫기. 꾹 누른 ↑ · ↓ · Space 와 Ctrl 조합은 무시',
          K('ArrowLeft') === 'prev' && K('ArrowRight') === 'next' && K(' ') === 'pin' && K('ArrowUp') === 'discard' && K('ArrowDown') === 'keep' && K('Escape') === 'close'
            && K('ArrowRight', { repeat: true }) === 'next' && K('ArrowUp', { repeat: true }) === null && K(' ', { repeat: true }) === null
            && K('ArrowUp', { ctrlKey: true }) === null && K('Enter') === null));
        const g = { ids: [1, 2, 3, 4] };
        out.push(sub('64d 넘기기: 고정한 사진은 오른쪽 목록에서 빠지고, 끝에서 멈추고, 정한 뒤에는 다음 사진',
          JSON.stringify(C.browseIds(g, 2)) === '[1,3,4]' && C.stepId([1, 3, 4], 4, 1) === 4 && C.stepId([1, 3, 4], 1, -1) === 1 && C.stepId([1, 3, 4], 9, 1) === 1
            && C.afterDecide([1, 3, 4], 3) === 4));
        const nat = { w: 4000, h: 3000 };
        const box = { w: 800, h: 600 };
        const fit = C.layoutOf(nat, box, C.FIT_VIEW);
        const pt = { x: 200, y: 150 };
        const before = { x: (pt.x - fit.left) / fit.w, y: (pt.y - fit.top) / fit.h };
        const z = C.zoomAt(C.FIT_VIEW, nat, box, pt, 2);
        const zl = C.layoutOf(nat, box, z);
        const after = { x: (pt.x - zl.left) / zl.w, y: (pt.y - zl.top) / zl.h };
        // 다른 크기 사진(같은 비율)도 같은 view 로 같은 자리를 보여요
        const nat2 = { w: 2000, h: 1500 };
        const z2 = C.layoutOf(nat2, box, z);
        const after2 = { x: (pt.x - z2.left) / z2.w, y: (pt.y - z2.top) / z2.h };
        const actual = C.toggleActual(C.FIT_VIEW, nat, box, { x: 400, y: 300 });
        const back = C.toggleActual(actual, nat, box);
        const tooFar = C.zoomAt(C.FIT_VIEW, nat, box, pt, 1000);
        const tooSmall = C.zoomAt(z, nat, box, pt, 0.01);
        const panned = C.panBy(z, nat, box, 100, 0);
        out.push(sub('64d 확대: 마우스 자리가 그대로, 크기가 다른 사진도 같은 자리, 더블클릭 = 원본 1:1 ↔ 맞춤, 맞춤보다 작게 · 원본 4배보다 크게는 안 됨, 끌면 옮겨짐',
          fit.w === 800 && fit.h === 600 && Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9
            && Math.abs(after2.x - before.x) < 1e-9
            && Math.abs(C.fitScale(nat, box) * actual.z - 1) < 1e-9 && back.z === 1
            && Math.abs(C.fitScale(nat, box) * tooFar.z - C.MAX_ZOOM_PX) < 1e-9 && tooSmall.z === 1 && tooSmall.fx === 0.5
            && panned.fx < z.fx,
          JSON.stringify({ z, actual: actual.z, tooFar: tooFar.z })));
      }

      // 64e 연결: 화면 보안 설정에 영상(pvm:) 허용, pvm 주소가 영상 재생(stream) 가능, 비슷한 사진 화면 · 오른쪽 패널 연결
      {
        const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
        const html = read('src/index.html');
        const csp = (html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/) || [])[1] || '';
        const gm = read('gallery-main.js');
        const sv = read('src/components/SimilarView.jsx');
        const dp = read('src/components/DetailPanel.jsx');
        out.push(sub('64e 보안 설정: media-src 는 앱과 pvm: 만 (인터넷 주소 없음), pvm 주소에 stream 권한',
          /media-src 'self' pvm:;/.test(csp) && !/https?:/.test(csp) && /privileges: \{[^}]*stream: true/.test(gm), csp));
        out.push(sub('64e 비슷한 사진 화면: 더블클릭 · Space · "크게 보며 고르기"로 CompareView, 오른쪽 패널에 LivePhoto',
          /<CompareView /.test(sv) && /onDoubleClick=/.test(sv) && /e\.key !== ' '/.test(sv) && /크게 보며 고르기/.test(sv) && /<LivePhoto id=\{file\.id\} \/>/.test(dp)));
      }

      // 64f 진짜 앱: 비슷한 묶음(3장, 그중 1장은 모션 포토) → 더블클릭으로 비교 창 → →, Space 고정(두 칸), ↑ · ↓, 휠로 두 칸 같이 확대, Esc
      //     오른쪽 패널에서 모션 포토는 "움직이는 사진" 버튼 → 누르면 재생, 보통 사진은 버튼 없음. 사진 파일은 그대로
      {
        const { launchCheck } = require('./launch-check');
        const sharp = require('sharp');
        const root = path.join(env.tmp, 'launch-compare-root');
        fs.mkdirSync(root, { recursive: true });
        const a = path.join(root, 'a.jpg');
        await makeImage(a, { seed: 5, w: 800, h: 600 });
        await sharp(a).resize(400, 300).modulate({ brightness: 1.1 }).jpeg({ quality: 70 }).toFile(path.join(root, 'b.jpg'));
        const cTmp = path.join(base, 'c-plain.jpg');
        await sharp(a).resize(600, 450).jpeg({ quality: 80 }).toFile(cTmp);
        fs.writeFileSync(path.join(root, 'c.jpg'), withMotion(fs.readFileSync(cTmp), video, 'v1'));
        const snap = () => fs.readdirSync(root).sort().map((n) => `${n}:${fs.statSync(path.join(root, n)).size}`).join(',');
        const before = snap();
        const ud = path.join(env.tmp, 'launch-compare-ud');
        fs.mkdirSync(ud, { recursive: true });
        fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ backupRoot: root }), 'utf8');
        const r = await launchCheck(path.join(__dirname, '..'), {
          env: { PVM_USER_DATA: ud },
          until: '백업 폴더 다시 읽기',
          untilMs: 30000,
          clickText: '비슷한 사진',
          clickUntil: '크게 보며 고르기',
          probe: `(${compareProbe.toString()})()`,
        });
        const q = r.probed || {};
        const seen = JSON.stringify(q).slice(0, 700);
        out.push(sub('64f 진짜 앱: 오른쪽 패널에서 모션 포토는 "움직이는 사진" 버튼 → 누르고 있으면 재생, 보통 사진은 버튼 없음',
          q.panelLive === true && q.played === true && q.plainLive === false, seen));
        out.push(sub('64f 더블클릭 → 비교 창(한 장, 원본 그림) → → 로 넘김 → Space 로 왼쪽 고정(두 칸) → ↑ 버림 · ↓ 남김 → 표시가 화면과 같음',
          q.opened === true && q.single === true && q.origin === true && q.moved === true && q.two === true && q.pinnedThumb === true
            && q.keepsAfter === 2 && q.gridKeeps === 2 && q.closed === true, seen));
        out.push(sub('64f 휠로 확대하면 두 칸이 같은 배율로 커짐, Space 로 다시 열림, 사진 파일 그대로, 화면 오류 없음',
          q.zoomSync === true && q.spaceOpens === true && snap() === before && (r.errors || []).length === 0,
          `${seen} / 오류 ${(r.errors || []).join(' | ').slice(0, 300)}`));
        out.push(sub('64f 비교 창 안 재생 버튼: 누르면 재생, 누른 채 움직여도 사진이 끌리지 않음 / 열린 동안 뒤 화면 inert / 고정 칸 테두리는 빨강이 아님',
          q.compareLive === true && q.comparePlayed === true && q.noDrag === true && q.inert === true && !!q.pinColor && !/224, 65, 47/.test(q.pinColor), seen));
        const st = q.strip || {};
        out.push(sub('64g 아래 띠: 남김 사진을 보고 있어도 지금 칸은 밝은 바깥 테두리(빨강 아님) + 위로 올라감, 남김 빨강 테두리는 안쪽에 그대로, 다른 남김 칸엔 없음',
          /241, 238, 230/.test(st.shadow || '') && !/inset/.test(st.shadow || '') && !/224, 65, 47/.test(st.shadow || '')
            && /224, 65, 47/.test(st.outline || '') && st.otherShadow === 'none' && st.lift >= 3 && st.ariaCurrent === 'true' && st.count === 1,
          JSON.stringify(st)));
      }
      return out;
    },
  },
];

// 진짜 앱 창 안에서 도는 확인 (launch-check 의 probe). 표시만 바꾸고 옮기기는 누르지 않아요
async function compareProbe() {
  const wait = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await new Promise((res) => setTimeout(res, 50));
    }
  };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k === ' ' ? 'Space' : k, bubbles: true }));
  const q = {};
  const cells = await wait(() => (document.querySelectorAll('.similar-cell').length >= 3 ? document.querySelectorAll('.similar-cell .cell') : null), 40000);
  if (!cells) return { stop: '비슷한 사진 3장 묶음이 안 보여요', text: document.body.innerText.slice(0, 300) };
  const cellOf = (name) => [...document.querySelectorAll('.similar-cell .cell')].find((b) => (b.getAttribute('aria-label') || '').startsWith(name));
  // 오른쪽 패널: 모션 포토(c.jpg)
  cellOf('c.jpg').click();
  const btn = await wait(() => document.querySelector('.preview .live-button'), 15000);
  q.panelLive = !!btn;
  if (btn) {
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    const v = document.querySelector('.preview video.live-video');
    q.played = !!(await wait(() => v && v.classList.contains('playing') && !v.paused && v.currentTime > 0, 5000));
    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
  }
  cellOf('a.jpg').click();
  await sleep(1500);
  q.plainLive = !!document.querySelector('.preview .live-button');
  // 비교 창: 더블클릭
  cellOf('a.jpg').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const cmp = await wait(() => document.querySelector('.compare'));
  q.opened = !!cmp;
  if (!cmp) return q;
  q.single = !document.querySelector('.compare-panes.two');
  const img0 = await wait(() => { const i = document.querySelector('.compare-img'); return i && i.complete && i.naturalWidth ? i : null; });
  q.origin = !!img0 && img0.src.startsWith('pvm://original/') && img0.naturalWidth === 800;
  const label0 = document.querySelector('.compare-label').innerText;
  key('ArrowRight');
  q.moved = !!(await wait(() => document.querySelector('.compare-label').innerText !== label0, 3000));
  key(' ');
  q.two = !!(await wait(() => document.querySelector('.compare-panes.two'), 3000));
  q.pinnedThumb = !!document.querySelector('.compare-thumb.pinned');
  key('ArrowUp'); // 오른쪽 사진 버림 → 다음
  await sleep(200);
  key('ArrowDown'); // 다음 사진 남김
  await sleep(300);
  q.keepsAfter = document.querySelectorAll('.compare-thumb.keep').length;
  // 휠: 두 칸이 같은 배율로 커져야 해요
  const imgs = () => [...document.querySelectorAll('.compare-img')];
  await wait(() => imgs().length === 2 && imgs().every((i) => i.complete && i.naturalWidth), 5000);
  const ratio = (i) => i.getBoundingClientRect().width / i.parentElement.getBoundingClientRect().width;
  const r0 = imgs().map(ratio);
  const box = document.querySelector('.compare-box');
  const b = box.getBoundingClientRect();
  box.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, bubbles: true, cancelable: true }));
  await sleep(300);
  const r1 = imgs().map(ratio);
  q.zoom = { r0, r1 };
  q.zoomSync = r1[0] > r0[0] * 1.2 && Math.abs(r1[0] / r0[0] - r1[1] / r0[1]) < 0.02;
  // 비교 창이 열린 동안 뒤 화면은 inert (Tab 으로 뒤 버튼에 못 감), 고정 칸 테두리는 빨강이 아님 (#131 검증 ⚠️)
  q.inert = !!(document.querySelector('.similar-actions') && document.querySelector('.similar-actions').closest('[inert]'));
  const pinBox = document.querySelector('.compare-pane.pinned .compare-box');
  q.pinColor = pinBox ? getComputedStyle(pinBox).outlineColor : '';
  // 비교 창 안 재생 버튼: 모션 포토(c.jpg)가 오른쪽에 올 때까지 넘겨서 누르면 재생, 사진은 끌리지 않음
  let lb = null;
  for (const k of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft']) {
    lb = await wait(() => document.querySelector('.compare-pane:not(.pinned) .live-button'), 1500);
    if (lb) break;
    key(k);
  }
  if (!lb) lb = document.querySelector('.compare .live-button');
  q.compareLive = !!lb;
  if (lb) {
    const im = lb.closest('.compare-box').querySelector('.compare-img');
    const rect0 = JSON.stringify(im.getBoundingClientRect());
    lb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    lb.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: 60, clientY: 40 }));
    const cv = lb.closest('.compare-box').querySelector('video.live-video');
    q.comparePlayed = !!(await wait(() => cv && !cv.paused && cv.currentTime > 0, 5000));
    q.noDrag = JSON.stringify(im.getBoundingClientRect()) === rect0;
    lb.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
  }
  key('Escape');
  q.closed = !!(await wait(() => !document.querySelector('.compare'), 3000));
  q.gridKeeps = document.querySelectorAll('.similar-cell.keep').length;
  // Space 로 다시 열기 (고른 사진이 있을 때)
  key(' ');
  q.spaceOpens = !!(await wait(() => document.querySelector('.compare'), 3000));
  // 64g 아래 띠: 남김 사진을 지금 보고 있어도 "지금 보는 칸"이 따로 보여야 해요 (빨강이 아닌 밝은 바깥 테두리 + 위로)
  {
    const keeps = [...document.querySelectorAll('.compare-thumb.keep')];
    if (keeps.length >= 2) {
      keeps[0].click();
      const cur = await wait(() => document.querySelector('.compare-thumb.keep.current'), 3000);
      const other = cur && keeps.find((t) => t !== cur);
      if (cur && other) {
        const cs = getComputedStyle(cur);
        q.strip = {
          shadow: cs.boxShadow,
          outline: cs.outlineColor,
          otherShadow: getComputedStyle(other).boxShadow,
          lift: Math.round(other.getBoundingClientRect().top - cur.getBoundingClientRect().top),
          ariaCurrent: cur.getAttribute('aria-current'),
          count: document.querySelectorAll('.compare-thumb.current').length,
        };
      }
    }
  }
  key('Escape');
  await wait(() => !document.querySelector('.compare'), 3000);
  return q;
}

module.exports = { items, withMotion };

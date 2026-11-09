// 파일 위치: scripts/check-map-view.js
// 역할: 지도 화면 점검 항목 (42, 43). scripts/check.js 의 ITEMS 끝에 붙어서 같이 돌아요.
//   빠르게 이 파일만 돌려 볼 때: node scripts/check-map-view.js
//
// ⚠️ 실제 사진과 실제 userData는 쓰지 않아요 (점검 임시 폴더 env.tmp 안에만 만들어요). 지도 그림 주소는 닿지 않는 곳이라 인터넷에 나가지 않아요
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { row, sub, withDb } = require('./check-gallery');

const APP = path.join(__dirname, '..');
const loadPlaces = () => import(pathToFileURL(path.join(APP, 'src', 'places-view.mjs')).href);

// 점 n개를 (lat, lng) 둘레에 조금씩 흩어 놓기 → [id, 위도, 경도, 찍은 날]
function spread(startId, lat, lng, n, day) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([startId + i, lat + (i % 10) * 1e-4, lng + Math.floor(i / 10) * 1e-4, day]);
  return out;
}

// 늘 같은 값이 나오는 난수 (점검이 매번 같게)
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const items = [
  {
    no: 42,
    name: '지도 묶기 계산과 위치 목록 (단계 6)',
    async run(env) {
      const out = [];
      const P = await loadPlaces();

      // 42a 가까운 사진은 한 핀, 먼 곳은 따로, 합계는 전체, 확대하면 나뉨
      const rows = [
        ...spread(1, 37.27, 127.01, 50, '2026-10-01'), // 수원
        ...spread(101, 37.56, 126.98, 30, '2019-03-02'), // 서울
        ...spread(201, 33.5, 126.53, 20, null), // 제주 (날짜 없음)
        ...spread(301, 41.39, 2.17, 10, '2017-05-05'), // 바르셀로나
      ];
      const pts = P.toPoints([...rows, ['x', 'a', 1, null], [999, 95, 1, null]]); // 숫자가 아니거나 지구 밖이면 버림
      {
        const counts = (z) => P.clusterPoints(pts, z).map((c) => c.count).join(',');
        const z3 = counts(3);
        const z10 = counts(10);
        out.push(sub('42a 가까운 사진은 한 핀, 먼 곳은 따로, 확대하면 나뉨, 이상한 값은 버림', pts.length === 110 && z3 === '100,10' && z10 === '50,30,20,10', `점 ${pts.length}개, 3단계 ${z3}, 10단계 ${z10}`));
      }

      // 42b 묶음의 영역(칸 사각형)에 드는 사진 수 = 핀 숫자, 영역끼리 겹치지 않음 (흩어진 3,000장, 여러 확대 단계, 지도 끝)
      {
        const r = rng(7);
        const many = [];
        for (let i = 0; i < 3000; i++) many.push([i + 1, -60 + r() * 130, -180 + r() * 360, null]);
        many.push([5001, 89.9, 179.99999, null], [5002, -89.9, -180, null], [5003, 0, 0, null]);
        const mp = P.toPoints(many);
        const bad = [];
        for (const z of [2, 5, 9, 14]) {
          const cs = P.clusterPoints(mp, z);
          let seen = 0;
          for (const c of cs) {
            const n = mp.filter((p) => c.rects.some((rect) => P.inRect(rect, p.lat, p.lng))).length;
            if (n !== c.count) bad.push(`${z}단계 ${c.key} 핀 ${c.count} 영역 ${n}`);
            seen += n;
          }
          if (seen !== mp.length) bad.push(`${z}단계 합계 ${seen}/${mp.length}`);
        }
        out.push(sub('42b 핀 숫자와 영역 안 사진 수가 같고 영역이 겹치지 않음 (지도 끝 포함)', bad.length === 0, bad.slice(0, 3).join(' / ') || '4단계 모두 맞음'));
      }

      // 42c 연도 탭, 찍은 기간 글, 패널 요약 (최근 9장, 연도 탭이면 영역에 그 해)
      {
        const years = P.yearsOf(pts).join(',');
        const y2019 = P.byYear(pts, 2019).length;
        const texts = [P.rangeText('2019-03-02', '2026-10-01'), P.rangeText('2026-10-01', '2026-10-30'), P.rangeText(null, null)];
        const top = P.clusterPoints(pts, 3)[0];
        const s = P.summarize(top, 2026);
        out.push(sub('42c 연도 탭 (최근 해부터, 날짜 없는 사진은 전체에만), 기간 글, 최근 9장, 영역에 연도',
          years === '2026,2019,2017' && y2019 === 30
          && texts.join('|') === '2019년 3월부터 2026년 10월까지|2026년 10월|찍은 날짜 없음'
          && s.count === 100 && s.first === '2019-03-02' && s.last === '2026-10-01' && s.recent.length === 9 && s.recent[0] === 50 && s.area.year === 2026,
          JSON.stringify([years, y2019, texts, s.count, s.recent.slice(0, 3), s.area.year])));
      }

      // 42d DB: 위치 목록은 위치가 있고 사라지지 않은 파일만, 경로 없음. 지도 영역 필터의 장수 = 핀 숫자 (연도 포함)
      await withDb(env, 'map', async (db) => {
        const r = rng(11);
        const files = [];
        for (let i = 0; i < 1500; i++) {
          const year = 2015 + (i % 4);
          const lat = 33 + r() * 5;
          const lng = 125 + r() * 5;
          files.push(row({ path: `R1/m${i}.jpg`, name: `m${i}.jpg`, lat, lng, takenAt: `${year}-05-0${1 + (i % 9)}T10:00:00`, takenDay: `${year}-05-0${1 + (i % 9)}` }));
        }
        files.push(row({ path: 'R1/nogps.jpg', name: 'nogps.jpg' }));
        files.push(row({ path: 'R1/gone.jpg', name: 'gone.jpg', lat: 37, lng: 127 }));
        files.push(row({ root: 'R2', path: 'R2/other.jpg', name: 'other.jpg', lat: 37, lng: 127 }));
        db.upsertFiles(files);
        db.setMissing(['R1/gone.jpg'], 1);
        const listed = db.mapPoints('R1');
        const noPath = !JSON.stringify(listed).includes('R1/');
        const mp = P.toPoints(listed);
        const bad = [];
        for (const [z, year] of [[6, null], [9, null], [9, 2016]]) {
          for (const c of P.clusterPoints(P.byYear(mp, year), z)) {
            const s = P.summarize(c, year);
            const ids = db.listIds('R1', { area: s.area });
            if (ids.length !== c.count) bad.push(`${z}단계 ${year || '전체'} 핀 ${c.count} 갤러리 ${ids.length}`);
          }
        }
        out.push(sub('42d 위치 목록 (위치 있음 · 사라지지 않음 · 이 폴더만, 경로 없음), 갤러리 지도 영역 장수 = 핀 숫자',
          listed.length === 1500 && noPath && bad.length === 0,
          `목록 ${listed.length}개, 경로 없음 ${noPath}, ${bad.slice(0, 3).join(' / ') || '3가지 확대 · 연도에서 모두 맞음'}`));
      });

      // 42e 화면에서 온 지도 영역은 숫자 칸만 남겨요 (이상한 값은 필터 없음)
      {
        const { cleanFilter } = require('../gallery-main');
        const good = cleanFilter({ area: { rects: [{ s: 1, w: 2, n: 3, e: 4, x: 'y' }], year: 2026 } }).area;
        const bads = [
          { rects: [{ s: 3, w: 2, n: 1, e: 4 }] }, // 뒤집힘
          { rects: [{ s: '1', w: 2, n: 3, e: 4 }] }, // 글자
          { rects: [{ s: 1, w: 2, n: 300, e: 4 }] }, // 지구 밖
          { rects: [] },
          'area',
        ].map((a) => cleanFilter({ area: a }).area);
        const year = cleanFilter({ area: { rects: [{ s: 1, w: 2, n: 3, e: 4 }], year: '2026' } }).area.year;
        out.push(sub('42e 지도 영역 거르기: 숫자 칸만, 뒤집히거나 글자 · 지구 밖이면 필터 없음, 연도는 정수만',
          JSON.stringify(good) === '{"rects":[{"s":1,"w":2,"n":3,"e":4}],"year":2026}' && bads.every((b) => b === null) && year === null,
          JSON.stringify([good, bads, year])));
      }

      // 42f 6만 장 묶기 시간 (대한민국 전체 화면, 확대 8 · 12)
      {
        const r = rng(3);
        const big = [];
        for (let i = 0; i < 60000; i++) big.push([i + 1, 33 + r() * 5, 125 + r() * 5, '2025-01-01']);
        const bp = P.toPoints(big);
        const times = [];
        for (const [z, bounds] of [[8, { s: 33, w: 125, n: 38.6, e: 130 }], [12, { s: 37.2, w: 126.8, n: 37.7, e: 127.3 }]]) {
          const t0 = Date.now();
          const cs = P.clusterPoints(bp, z, { bounds });
          times.push(`${z}단계 ${Date.now() - t0}ms 핀 ${cs.length}개`);
        }
        const slow = times.some((t) => Number(t.split(' ')[1].replace('ms', '')) > 1000);
        console.log(`   ⏱ 42f 6만 장 묶기 ${times.join(', ')}`); // 통과해도 시간은 보이게
        out.push(sub('42f 6만 장 묶기가 한 번에 1초 이하 (지도를 옮길 때마다 계산해요)', !slow, times.join(', ')));
      }

      // 42g 화면 연결: 지도 메뉴가 켜지고, 지도 화면 · 패널 · 갤러리 영역 줄이 이어져 있음
      {
        const src = (f) => fs.readFileSync(path.join(APP, 'src', f), 'utf8');
        const side = src('components/Sidebar.jsx');
        const app = src('App.jsx');
        const panel = src('components/MapPanel.jsx');
        const view = src('components/MapView.jsx');
        const pre = fs.readFileSync(path.join(APP, 'preload.js'), 'utf8');
        const ok = side.includes("onScreen('map')") && !side.includes('label="지도" disabled')
          && app.includes('<MapView') && app.includes('<MapPanel') && app.includes('지도로 돌아가기')
          && panel.includes('장 갤러리에서 보기') && view.includes('지도에 놓으러 가기') && view.includes("'pvm://tile/{z}/{x}/{y}'")
          && pre.includes("'gallery:map-points'");
        out.push(sub('42g 지도 메뉴 켜짐, 지도 화면 · 패널 · 갤러리 영역 줄 연결, 지도 그림은 pvm://tile 로만', ok));
      }
      return out;
    },
  },
  {
    no: 43,
    name: '지도 화면 (진짜 앱, 끊긴 상태)',
    async run(env) {
      // GPS와 찍은 날을 넣은 점검용 그림 4장(수원 2, 바르셀로나 1, 위치 없음 1)을 백업 폴더로 정한 임시 userData로 앱을 띄워요
      //   지도 그림 주소는 닿지 않는 127.0.0.1:1 이라 인터넷에 나가지 않아요. 핀은 지도 그림 없이도 보여야 해요
      const out = [];
      const { launchCheck } = require('./launch-check');
      const { makeImage } = require('./check-similar');
      const { detectTools, runOrThrow } = require('../lib/tools');
      const tools = env.tools || (await detectTools({}, APP));
      if (!tools.exiftool || !tools.exiftool.ok) return [sub('43 지도 화면', false, 'exiftool 없음')];
      const root = path.join(env.tmp, 'launch-mapview-root');
      const shots = [
        ['suwon1.jpg', 3, 37.2667, 127.0081, '2026:10:05 12:00:00'],
        ['suwon2.jpg', 9, 37.2669, 127.0083, '2019:03:02 09:00:00'],
        ['bcn.jpg', 21, 41.3874, 2.1686, '2017:05:05 18:00:00'],
        ['nogps.jpg', 30, null, null, '2018:01:01 08:00:00'],
      ];
      for (const [name, seed, lat, lng, when] of shots) {
        const file = await makeImage(path.join(root, name), { seed });
        const args = ['-overwrite_original', `-DateTimeOriginal=${when}`];
        if (lat !== null) args.push(`-GPSLatitude=${lat}`, `-GPSLatitudeRef=${lat >= 0 ? 'N' : 'S'}`, `-GPSLongitude=${Math.abs(lng)}`, `-GPSLongitudeRef=${lng >= 0 ? 'E' : 'W'}`);
        await runOrThrow(tools.exiftool.path, [...args, file], 'exiftool');
      }
      const bytes = () => shots.map(([n]) => fs.readFileSync(path.join(root, n)).toString('base64')).join('|');
      const before = bytes();
      const ud = path.join(env.tmp, 'launch-mapview-ud');
      fs.mkdirSync(ud, { recursive: true });
      fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({
        backupRoot: root,
        mapTileUrl: 'https://127.0.0.1:1/{z}/{x}/{y}.png',
        placeSearchUrl: 'https://127.0.0.1:1/search',
      }), 'utf8');
      const r = await launchCheck(APP, {
        port: 9343,
        env: { PVM_USER_DATA: ud },
        until: '백업 폴더 다시 읽기',
        untilMs: 30000,
        probe: `(${mapViewProbe.toString()})()`,
      });
      const q = r.probed || {};
      const seen = JSON.stringify(q).slice(0, 700);
      out.push(sub('43a 지도 메뉴 → 숫자 핀 (수원 2, 바르셀로나 1), 연도 탭, 장소가 없는 사진 1장', q.pins === '1,2' && q.years === '전체 기간,2026,2019,2017' && q.missing === '장소가 없는 사진 1장', seen));
      out.push(sub('43b 핀을 누르면 패널: 2장, 찍은 기간, 사진 2장, "2장 갤러리에서 보기"', q.count === '2장' && q.range === '2019년 3월부터 2026년 10월까지' && q.thumbs === 2 && q.showButton === '2장 갤러리에서 보기', seen));
      out.push(sub('43c 갤러리에 그 곳 사진 2장만, 영역 줄, 지도로 돌아가기', q.areaCells === 2 && (q.areaBar || '').includes('지도에서 고른 곳의 사진만 보여요') && q.backToMap === true, seen));
      out.push(sub('43d 2017 탭이면 바르셀로나 핀 1개만, 장소 없는 사진 버튼은 정보 없는 사진 화면으로', q.pins2017 === '1' && q.missingScreen === true, seen));
      out.push(sub('43e 지도 그림을 못 받아도 안내가 나오고 핀은 그대로', (q.mapError || '').includes('지도를 불러오지 못했어요'), seen));
      // 끊긴 상태라 지도 칸 실패(404) 로그는 당연히 나와요 (점검 35k와 같음). 그 밖의 화면 오류는 없어야 해요
      const realErrors = r.errors.filter((e) => !/Failed to load resource/.test(e));
      out.push(sub('43f 화면 오류 없음, 정상 종료, 사진 파일은 그대로', realErrors.length === 0 && r.exitCode === 0 && !q.stop && bytes() === before, `${realErrors.join(' / ')} 종료 코드 ${r.exitCode} ${q.stop || ''}`));
      return out;
    },
  },
];

// 항목 43이 앱 화면 안에서 돌리는 함수예요. 글자로 바뀌어 넘어가니까 바깥 변수를 쓰면 안 돼요
async function mapViewProbe() {
  const wait = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await new Promise((res) => setTimeout(res, 100));
    }
  };
  const byText = (sel, text) => [...document.querySelectorAll(sel)].find((b) => (b.innerText || '').trim() === text || (b.innerText || '').includes(text));
  const pinTexts = () => [...document.querySelectorAll('.place-pin')].map((p) => p.innerText.trim()).sort().join(',');
  const q = {};
  // 사진을 다 읽을 때까지 (그림 4장)
  const cells = await wait(() => document.querySelectorAll('button.cell').length >= 4, 30000);
  if (!cells) return { stop: '사진 칸이 4개가 안 돼요' };
  const menu = byText('.menu button.menu-row', '지도');
  if (!menu || menu.disabled) return { stop: '지도 메뉴가 꺼져 있어요' };
  menu.click();
  const pins = await wait(() => document.querySelectorAll('.place-pin').length >= 2);
  if (!pins) return { stop: '핀이 2개가 안 돼요' };
  await new Promise((res) => setTimeout(res, 300));
  q.pins = pinTexts();
  q.years = [...document.querySelectorAll('.map-years button')].map((b) => b.innerText.trim()).join(',');
  q.missing = ((document.querySelector('.map-missing span') || {}).innerText || '').trim();
  q.mapError = ((await wait(() => document.querySelector('.map-view-note'), 8000)) || {}).innerText || '';

  // 핀 2 누르기 → 패널
  const two = [...document.querySelectorAll('.place-pin')].find((p) => p.innerText.trim() === '2');
  two.click();
  const count = await wait(() => document.querySelector('.map-panel .map-count'));
  if (!count) return { ...q, stop: '패널이 안 바뀌어요' };
  q.count = count.innerText.trim();
  q.range = (document.querySelector('.map-panel .map-range') || {}).innerText;
  q.thumbs = document.querySelectorAll('.map-panel .map-thumb').length;
  const show = document.querySelector('.map-panel .map-show');
  q.showButton = show ? show.innerText.trim() : '';

  // 갤러리에서 보기 → 그 곳 사진만
  show.click();
  const bar = await wait(() => document.querySelector('.area-bar'));
  q.areaBar = bar ? bar.innerText : '';
  await wait(() => !document.querySelector('.map-view') && document.querySelectorAll('button.cell').length > 0);
  await new Promise((res) => setTimeout(res, 500));
  q.areaCells = document.querySelectorAll('button.cell').length;
  if (!bar) return { ...q, stop: '영역 줄이 없어요' };
  byText('.area-bar button', '지도로 돌아가기').click();
  q.backToMap = !!(await wait(() => document.querySelector('.map-view .place-pin')));

  // 2017 탭 → 바르셀로나만
  const tab = byText('.map-years button', '2017');
  if (!tab) return { ...q, stop: '2017 탭이 없어요' };
  tab.click();
  await wait(() => pinTexts() === '1');
  q.pins2017 = pinTexts();

  // 장소가 없는 사진 → 정보 없는 사진 화면
  byText('.map-missing button', '지도에 놓으러 가기').click();
  q.missingScreen = !!(await wait(() => {
    const on = document.querySelector('.menu button.menu-row.active');
    return on && on.innerText.includes('정보 없는 사진');
  }));
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

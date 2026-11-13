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
        const wrapped = P.viewRanges(30, 170, 40, 200); // 경도 ±180에 걸친 화면 → 구간 둘 (#55 검증: 전 세계를 묶던 것)
        const wrapOk = Array.isArray(wrapped) && wrapped.length === 2 && P.viewRanges(0, -200, 10, 200) === null;
        for (const [z, bounds] of [[8, { s: 33, w: 125, n: 38.6, e: 130 }], [12, { s: 37.2, w: 126.8, n: 37.7, e: 127.3 }], [15, wrapped]]) {
          const t0 = Date.now();
          const cs = P.clusterPoints(bp, z, { bounds });
          times.push(`${z}단계 ${Date.now() - t0}ms 핀 ${cs.length}개`);
        }
        const slow = times.some((t) => Number(t.split(' ')[1].replace('ms', '')) > 1000);
        console.log(`   ⏱ 42f 6만 장 묶기 ${times.join(', ')}`); // 통과해도 시간은 보이게
        out.push(sub('42f 6만 장 묶기가 한 번에 1초 이하 (지도를 옮길 때마다 계산해요), ±180에 걸친 화면은 구간 둘', !slow && wrapOk, times.join(', ')));
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
        placeReverseUrl: 'https://127.0.0.1:1/reverse', // 핀 이름도 진짜 서버로 나가지 않게
      }), 'utf8');
      const r = await launchCheck(APP, {
        env: { PVM_USER_DATA: ud },
        until: '백업 폴더 다시 읽기',
        untilMs: 30000,
        probe: `(${mapViewProbe.toString()})()`,
      });
      const q = r.probed || {};
      const seen = JSON.stringify(q).slice(0, 700);
      out.push(sub('43a 지도 메뉴 → 숫자 핀 (수원 2, 바르셀로나 1), 연도 탭, 장소가 없는 사진 1장', q.pins === '1,2' && q.years === '전체 기간,2026,2019,2017' && q.missing === '장소가 없는 사진 1장', seen));
      out.push(sub('43b 핀을 누르면 패널: 2장, 찍은 기간, 사진 2장, "2장 갤러리에서 보기"', q.count === '2장' && q.range === '2019년 3월부터 2026년 10월까지' && q.thumbs === 2 && q.showButton === '2장 갤러리에서 보기', seen));
      out.push(sub('43c 갤러리에 그 곳 사진 2장만, 영역 줄, 지도로 돌아가면 보던 곳 그대로 (전에 누른 많이 찍은 곳으로 다시 옮기지 않음)', q.areaCells === 2 && (q.areaBar || '').includes('지도에서 고른 곳의 사진만 보여요') && q.backToMap === true && q.pinsAfterBack === '1,2', seen));
      out.push(sub('43d 2017 탭이면 바르셀로나 핀 1개만, 장소 없는 사진 버튼은 정보 없는 사진 화면으로', q.pins2017 === '1' && q.missingScreen === true, seen));
      out.push(sub('43e 지도 그림을 못 받아도 안내가 나오고 핀은 그대로', (q.mapError || '').includes('지도를 불러오지 못했어요'), seen));
      out.push(sub('43g 이름을 못 받아도 많이 찍은 곳 목록(장수 많은 순)이 나오고, 누르면 그 핀을 골라 패널에 장수, 해외 칩은 없음, 장소 검색 칸',
        q.topRows === '이름없는곳2,이름없는곳1' && q.gotoCount === '2장' && q.chips === 0 && q.searchBox === true, seen));
      // 끊긴 상태라 지도 칸 실패(404) 로그는 당연히 나와요 (점검 35k와 같음). 그 밖의 화면 오류는 없어야 해요
      const realErrors = r.errors.filter((e) => !/Failed to load resource/.test(e));
      out.push(sub('43f 화면 오류 없음, 정상 종료, 사진 파일은 그대로', realErrors.length === 0 && r.exitCode === 0 && !q.stop && bytes() === before, `${realErrors.join(' / ')} 종료 코드 ${r.exitCode} ${q.stop || ''}`));
      return out;
    },
  },
  {
    no: 44,
    name: '지도 핀 이름, 많이 찍은 곳, 해외 나라 (가짜 서버, 단계 6-2)',
    async run(env) {
      const out = [];
      const P = await loadPlaces();
      const { cityOf, createMapNet } = require('../lib/map-net');
      const json = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
      const addr = (address) => ({ display_name: 'x', address });

      // 44a 시 · 군 이름: 한국은 끝의 시 · 군 · 특별시를 떼서 짧게, 해외는 나라 · 나라 코드, 모양이 틀리면 null
      {
        const got = [
          cityOf(addr({ city: '수원시', country: '대한민국', country_code: 'kr' })),
          cityOf(addr({ city: '서울특별시', country: '대한민국', country_code: 'kr' })),
          cityOf(addr({ county: '양평군', state: '경기도', country: '대한민국', country_code: 'kr' })),
          cityOf(addr({ city: '세종특별자치시', country: '대한민국', country_code: 'KR' })),
          cityOf(addr({ city: '시', country: '대한민국', country_code: 'kr' })),
          cityOf(addr({ city: '바르셀로나', country: '스페인', country_code: 'es' })),
          cityOf({ display_name: 'x' }),
          cityOf([]),
        ];
        const names = got.slice(0, 6).map((g) => g.name).join(',');
        out.push(sub('44a 시 · 군 이름 (수원시 → 수원, 서울특별시 → 서울, 양평군 → 양평, 두 글자 안 되면 그대로), 해외 나라, 틀린 모양',
          names === '수원,서울,양평,세종,시,바르셀로나' && got[5].cc === 'es' && got[5].country === '스페인' && got[3].cc === 'kr' && got[6].name === '' && got[7] === null,
          JSON.stringify(got)));
      }

      // 44b 서버에는 소수점 2자리 좌표와 zoom 10, 한국어로 물어요. 실패는 정해진 문장, 이름 없는 곳은 빈 값
      {
        const calls = [];
        let mode = 'ok';
        const net = createMapNet({
          fetchImpl: async (url) => {
            calls.push(url);
            if (mode === 'fail') return new Response('', { status: 503 });
            if (mode === 'none') return json({ error: 'Unable to geocode' });
            return json(addr({ city: '수원시', country: '대한민국', country_code: 'kr' }));
          },
          getSettings: () => ({}),
          version: '1.0.0',
          onError: () => {},
          nowMs: () => 0,
          wait: async () => {},
        });
        const v = await net.reverseCity(37.26671234, 127.00811234);
        const u = new URL(calls[0]);
        mode = 'none';
        const none = await net.reverseCity(0.001, 0.001);
        mode = 'fail';
        const fail = await net.reverseCity(1, 1).then(() => null, (e) => e.message);
        const bad = await net.reverseCity('37', 127).then(() => null, (e) => e.message);
        out.push(sub('44b 시 · 군 이름 묻기: 좌표 2자리, zoom 10, 한국어, 실패는 정해진 문장, 이름 없는 곳은 빈 값, 글자 좌표는 거절',
          v.name === '수원' && u.searchParams.get('lat') === '37.27' && u.searchParams.get('lon') === '127.01' && u.searchParams.get('zoom') === '10'
          && u.searchParams.get('accept-language') === 'ko' && none.name === '' && none.cc === '' && typeof fail === 'string' && fail.includes('장소 이름') && !!bad,
          JSON.stringify([v, calls[0], none, fail, bad])));
      }

      // 44c gallery:map-place: 저장된 값이 없고 묻지 않으면 null, 물으면 한 번만 나가서 저장, 같은 2자리 좌표는 저장한 값
      {
        const fakes = [];
        try {
          const { createLogger } = require('../lib/logger');
          const gmPath = require.resolve('../gallery-main');
          delete require.cache[gmPath];
          const gm = require('../gallery-main');
          delete require.cache[gmPath];
          const dir = path.join(env.tmp, 'mapnames-wire');
          const ud = path.join(dir, 'ud');
          fs.mkdirSync(ud, { recursive: true });
          const fetchCalls = [];
          const handlers = new Map();
          const g = gm.setupGallery({
            ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
            protocol: { handle() {} },
            getWin: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
            getSettings: () => ({ backupRoot: path.join(dir, 'photos') }),
            getTools: () => ({}),
            getEt: () => null,
            isRunning: () => false,
            isPlanning: () => false,
            logger: createLogger(path.join(dir, 'logs')),
            userDir: ud,
            loadScreen: async () => {},
            getJobPending: () => false,
            mapFetch: async (url) => {
              fetchCalls.push(url);
              return json(addr({ city: '수원시', country: '대한민국', country_code: 'kr' }));
            },
            openExternal: async () => {},
            appVersion: '9.9.9',
          });
          fakes.push(g);
          const call = (ch, ...a) => handlers.get(ch)(null, ...a);
          const peek = await call('gallery:map-place', 37.2667, 127.0081, false);
          const both = await Promise.all([call('gallery:map-place', 37.2667, 127.0081, true), call('gallery:map-place', 37.2699, 127.0099, true)]);
          const again = await call('gallery:map-place', 37.268, 127.009, false);
          const bad = await Promise.resolve().then(() => call('gallery:map-place', 'x', 1, true)).then(() => null, (e) => e.message);
          out.push(sub('44c 지도 핀 이름 연결: 안 물으면 null, 같은 곳은 한 번만 나가고 저장, 저장한 값은 다시 안 나감, 이상한 좌표 거절',
            peek === null && both.every((b) => b.name === '수원' && b.cc === 'kr') && fetchCalls.length === 1 && again && again.name === '수원' && !!bad,
            JSON.stringify([peek, both, again, fetchCalls.length, bad])));
        } catch (e) {
          out.push(sub('44c 실행 중 오류', false, String(e.stack).split('\n').slice(0, 3).join(' | ')));
        } finally {
          for (const g of fakes) {
            try {
              g.close();
            } catch (e) { /* 닫기 실패는 무시 */ }
          }
        }
      }

      // 44d 많이 찍은 곳 (큰 곳부터 5개), 해외 나라 칩 (한국 · 모르는 나라는 빼고 나라별 합계), 가장 가까운 핀, 이름 열쇠
      {
        const rows = [
          ...spread(1, 37.27, 127.01, 50, '2026-10-01'),
          ...spread(101, 37.56, 126.98, 30, '2019-03-02'),
          ...spread(201, 41.39, 2.17, 10, '2017-05-05'),
          ...spread(301, 40.42, -3.70, 7, '2017-05-07'),
          ...spread(401, 34.69, 135.5, 4, '2019-01-01'),
          ...spread(501, 35.68, 139.69, 3, '2019-01-02'),
          ...spread(601, -33.87, 151.21, 2, null),
        ];
        const pts = P.toPoints(rows);
        const top = P.topPlaces(pts).map((t) => t.count).join(',');
        const wide = P.clusterPoints(pts, P.COUNTRY_ZOOM);
        const place = (lat, lng) => {
          if (lat > 33 && lat < 39 && lng > 124 && lng < 131) return { name: '한국', country: '대한민국', cc: 'kr' };
          if (lng > -10 && lng < 4) return { name: '', country: '스페인', cc: 'es' };
          if (lng > 130 && lng < 146) return { name: '', country: '일본', cc: 'jp' };
          return null; // 아직 모름
        };
        const chips = P.countryChips(wide, place);
        const chipText = chips.map((c) => `${c.country}${c.count}`).join(',');
        const box = chips[0] && chips[0].box;
        // 합친 뒤에도 큰 순서인지 (#56 검증: 합치기 전 칸 크기 순서라 [12, 19]가 나왔음)
        const merged = P.toPoints([...spread(1, 37.2700, 127.0000, 12, null), ...spread(101, 37.5, 127.5, 19, null)]);
        const order = P.clusterPoints(merged, 9).map((c) => c.count);
        const sorted = order.every((n, i) => i === 0 || order[i - 1] >= n);
        // 이름 자리는 가장 많이 찍은 2km 칸(0.02도 눈금)이라 연도 탭을 바꿔도 같은 열쇠 (#56 검증: 연도마다 새 요청)
        const spots = (y) => P.clusterPoints(P.byYear(pts, y), 9).map((c) => P.cityKey(c.named.lat, c.named.lng)).sort().join(' ');
        const all = new Set(spots(null).split(' '));
        const sameSpots = [2026, 2019, 2017].every((y) => spots(y).split(' ').every((k) => all.has(k)));
        out.push(sub('44d 많이 찍은 곳 5개 (큰 곳부터, 합친 뒤에도), 해외 칩 (한국 · 모르는 곳 빼고 합계, 영역), 이름 자리는 연도가 바뀌어도 같은 열쇠',
          top === '50,30,10,7,4' && chipText === '스페인17,일본7' && box.s <= 40.42 && box.n >= 41.39 && sorted && sameSpots && P.cityKey(37.2667, 127.0081) === '37.27,127.01',
          JSON.stringify([top, chipText, box, order, sameSpots])));
      }

      // 44f 이름 자리는 사진을 가장 많이 찍은 곳, 나라는 빈 · 부다페스트를 따로 (10-9 확인: 평균 자리라 "대전", 슬로바키아가 나왔음)
      {
        // 수원 40장 + 대구 30장 + 부산 10장 → 넓게 본 한 묶음의 평균은 대전 근처지만, 이름 자리는 수원이어야 해요
        const korea = P.toPoints([
          ...spread(1, 37.27, 127.01, 40, '2026-10-01'),
          ...spread(101, 35.87, 128.6, 30, '2026-10-01'),
          ...spread(201, 35.18, 129.08, 10, '2026-10-01'),
        ]);
        const one = P.clusterPoints(korea, 3)[0];
        const near = (s, lat, lng) => Math.abs(s.lat - lat) < 0.05 && Math.abs(s.lng - lng) < 0.05;
        const suwon = one && one.count === 80 && near(one.named, 37.27, 127.01);
        // 위도 · 경도 둘 다 0.02도 눈금 위 (#62 검증: 위도만 보고, 늘 참인 식이 섞여 있었음)
        const onFine = (v) => Math.abs(v / P.NAME_FINE - Math.round(v / P.NAME_FINE)) < 1e-6;
        const fine = one && onFine(one.named.lat) && onFine(one.named.lng) && P.nameSpot([]) === null;
        // 나라를 알아볼 묶음은 핀 · 많이 찍은 곳 뒤에 물어요 (상한 80을 먼저 다 쓰지 않게, #62 검증)
        const mv = fs.readFileSync(path.join(APP, 'src', 'components', 'MapView.jsx'), 'utf8');
        const later = /wantName\(c\.named, true\)/.test(mv) && /WAITING\.shift\(\) \|\| LATER\.shift\(\)/.test(mv);
        // 빈 25장 + 부다페스트 37장: 나라 칩이 오스트리아 · 헝가리로 나뉘어야 해요 (슬로바키아로 합치지 않게)
        const trip = P.toPoints([...spread(301, 48.21, 16.37, 25, '2018-01-01'), ...spread(401, 47.5, 19.04, 37, '2018-01-02')]);
        const where = (lat, lng) => {
          if (lng > 15.5 && lng < 17.1) return { name: '빈', country: '오스트리아', cc: 'at' };
          if (lng > 18.5 && lng < 19.5) return { name: '부다페스트', country: '헝가리', cc: 'hu' };
          if (lng >= 17.1 && lng <= 18.5) return { name: '', country: '슬로바키아', cc: 'sk' };
          return null;
        };
        const chips2 = P.countryChips(P.clusterPoints(trip, P.COUNTRY_ZOOM), where).map((c) => `${c.country}${c.count}`).join(',');
        out.push(sub('44f 이름 자리는 묶음에서 가장 많이 찍은 곳(위도 · 경도 눈금 위), 나라 묶음은 뒤에 물음, 나라 칩은 빈 · 부다페스트를 나눠 셈',
          suwon && fine && later && chips2 === '헝가리37,오스트리아25',
          JSON.stringify([one && one.count, one && one.named, chips2, later])));
      }

      // 44e 핀 이름은 인터넷에서 온 글이라 HTML로 넣지 않아요 (textContent)
      {
        const view = fs.readFileSync(path.join(APP, 'src', 'components', 'MapView.jsx'), 'utf8');
        out.push(sub('44e 핀 이름은 textContent 로 넣음 (HTML 글자로 넣지 않음), 이름은 한 번에 하나씩 · 상한까지만 저절로 물음',
          view.includes('label.textContent = name') && !/html:\s*`[^`]*\$\{name/.test(view) && view.includes('if (pumping) return;') && /autoAsked < AUTO_MAX/.test(view)));
      }
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
  q.searchBox = !!document.querySelector('.map-view-search input');
  // 많이 찍은 곳: 이름 서버가 닿지 않아서 "이름 없는 곳"이 될 때까지 기다려요. 누르면 그 핀을 골라요
  const rows = () => [...document.querySelectorAll('.map-top-list button')].map((b) => b.innerText.replace(/\s+/g, ''));
  await wait(() => rows().length === 2 && rows().every((t) => t.startsWith('이름없는곳')), 20000);
  q.topRows = rows().join(',');
  q.chips = document.querySelectorAll('.map-abroad button').length;
  const first = document.querySelector('.map-top-list button');
  if (first) {
    first.click();
    q.gotoCount = ((await wait(() => document.querySelector('.map-panel .map-count'))) || {}).innerText;
    // 다음 단계(핀 2 누르기)를 위해 처음처럼 연도 탭 · 지도를 두 핀이 다 보이게 되돌려요
    document.querySelector('.leaflet-control-zoom-out').click();
    for (let i = 0; i < 12; i++) {
      if (document.querySelectorAll('.place-pin').length >= 2) break;
      document.querySelector('.leaflet-control-zoom-out').click();
      await new Promise((res) => setTimeout(res, 300));
    }
  }

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
  await new Promise((res) => setTimeout(res, 500));
  q.pinsAfterBack = pinTexts(); // 많이 찍은 곳을 눌렀던 것이 다시 실행되면 수원만 보여요 (#56 검증)

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

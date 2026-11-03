// 파일 위치: scripts/check-places.js
// 역할: "장소 이름 보기" 점검 항목 (39번). scripts/check.js 의 ITEMS 끝에 붙어서 같이 돌아요.
//   빠르게 이 파일만 돌려 볼 때: node scripts/check-places.js
//
// ⚠️ 진짜 인터넷에는 나가지 않아요. 검색 서버 대신 가짜 응답(fetchImpl, mapFetch)을 넘겨요.
//    실제 사진과 실제 userData도 쓰지 않아요 (점검 임시 폴더 env.tmp 안에만 만들어요)
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { row, sub } = require('./check-gallery');

const REVERSE_FAIL = '장소 이름을 받지 못했어요. 잠시 뒤 다시 눌러 주세요.';
const BAD_COORD = '위치 값이 올바르지 않아요.';
const SEOUL = { display_name: '세종대로, 세종로, 종로구, 서울특별시, 03172, 대한민국', address: { country: '대한민국', country_code: 'kr', postcode: '03172' } };
const json = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
const errOf = (p) => p.then(() => null, (e) => e.message);

// 가짜 응답으로 map-net 을 만들어요 (check-map-pick.js 의 harness 와 같은 모양)
function harness(handler, settings = {}) {
  const { createMapNet } = require('../lib/map-net');
  const h = { calls: [], errs: [], waits: [], settings, now: 1_000_000 };
  h.net = createMapNet({
    fetchImpl: async (url, init) => {
      h.calls.push({ url, init });
      return handler(url, init);
    },
    getSettings: () => h.settings,
    version: '1.0.0',
    onError: (where, code) => h.errs.push({ where, code }),
    nowMs: () => h.now,
    wait: async (ms) => {
      h.waits.push(ms);
      h.now += ms;
    },
  });
  return h;
}

const items = [
  {
    no: 39,
    name: '장소 이름 보기 (가짜 서버)',
    async run(env) {
      const out = [];
      const { placeNameOf } = require('../lib/map-net');

      // 39a 응답 → 이름: 큰 곳부터 3칸, 우편번호와 나라 빼기, 외국은 나라 이름 앞에
      {
        const kr = placeNameOf(SEOUL);
        const jp = placeNameOf({ display_name: '神宮前, 渋谷区, 東京都, 150-0001, 일본', address: { country: '일본', country_code: 'jp', postcode: '150-0001' } });
        const short = placeNameOf({ display_name: '독도, 대한민국', address: { country: '대한민국', country_code: 'kr' } });
        const none = placeNameOf({ display_name: '' });
        const bad = [placeNameOf(null), placeNameOf([]), placeNameOf('글자')];
        out.push(sub('39a 이름 만들기 (한국은 3칸, 외국은 나라 이름 앞, 이름 없으면 빈 값, 모양 틀리면 null)',
          kr === '서울특별시 종로구 세종로' && jp === '일본 東京都 渋谷区 神宮前' && short === '독도' && none === '' && bad.every((x) => x === null),
          JSON.stringify([kr, jp, short, none, bad])));
      }

      // 39b 요청 모양: reverse 주소, 소수점 3자리로 줄인 좌표, 이름표, 캐시 안 남김, 쿠키 안 씀, 리다이렉트 안 따라감
      {
        const h = harness(() => json(SEOUL));
        const name = await h.net.reverse(37.5759876, 126.9768543);
        const u = new URL(h.calls[0].url);
        const init = h.calls[0].init;
        const keys = [...u.searchParams.keys()].sort().join(',');
        out.push(sub('39b 요청 모양 (reverse, 좌표 3자리, jsonv2, ko, User-Agent, no-store, 쿠키 안 씀, 리다이렉트 안 따라감)',
          name === '서울특별시 종로구 세종로' && u.origin + u.pathname === 'https://nominatim.openstreetmap.org/reverse'
          && u.searchParams.get('lat') === '37.576' && u.searchParams.get('lon') === '126.977'
          && u.searchParams.get('format') === 'jsonv2' && u.searchParams.get('accept-language') === 'ko'
          && keys === 'accept-language,addressdetails,format,lat,lon,zoom'
          && init.headers['User-Agent'] === 'photo-video-manager/1.0.0 (https://github.com/gwhong-dev/photo-video-manager)'
          && init.cache === 'no-store' && init.credentials === 'omit' && init.redirect === 'error' && !!init.signal,
          h.calls[0].url));
      }

      // 39c 좌표 검사: 숫자가 아니거나 범위 밖이면 나가기 전에 거절 (0도는 살림)
      {
        const h = harness(() => json(SEOUL));
        const bads = [['37', 127], [37, '127'], [NaN, 1], [91, 0], [0, 181], [null, 0], [undefined, 0], [Infinity, 0]];
        const texts = [];
        for (const [a, b] of bads) texts.push(await errOf(h.net.reverse(a, b)));
        const before = h.calls.length;
        await h.net.reverse(0, 0);
        out.push(sub('39c 숫자가 아니거나 범위 밖 좌표는 나가기 전에 거절, 0도는 보냄',
          texts.every((t) => t === BAD_COORD) && before === 0 && h.calls.length === 1, JSON.stringify(texts)));
      }

      // 39d 실패: 정해진 문장 + 한 번만 시도 + 로그에 상태만 (좌표 없음). 이름 없는 곳(error 칸)은 빈 이름
      {
        const cases = [
          ['429', () => new Response('', { status: 429 }), 'HTTP 429'],
          ['네트워크', () => { const e = new TypeError('fetch failed https://nominatim.openstreetmap.org/reverse?lat=37.576'); e.cause = { code: 'ECONNRESET' }; throw e; }, 'ECONNRESET'],
          ['JSON 아님', () => new Response('<html>', { headers: { 'content-type': 'text/html' } }), 'json'],
          ['배열', () => json([]), 'shape'],
        ];
        const problems = [];
        for (const [label, handler, code] of cases) {
          const h = harness(handler);
          const text = await errOf(h.net.reverse(37.5759876, 126.9768543));
          const logs = JSON.stringify(h.errs);
          if (text !== REVERSE_FAIL || h.calls.length !== 1 || h.errs.length !== 1 || h.errs[0].where !== 'reverse' || h.errs[0].code !== code || logs.includes('37.5')) {
            problems.push(`${label}: ${text} ${h.calls.length} ${logs}`);
          }
        }
        const sea = harness(() => json({ error: 'Unable to geocode' }));
        const seaName = await sea.net.reverse(30, 130);
        out.push(sub('39d 실패는 정해진 문장 + 한 번만 시도 + 로그에 상태만, 이름 없는 곳은 빈 이름',
          problems.length === 0 && seaName === '' && sea.errs.length === 0, problems.join(' / ') || JSON.stringify(seaName)));
      }

      // 39e 검색과 장소 이름은 한 줄로 서요: 연달아 보내도 1초 간격
      {
        const h = harness((url) => (url.includes('/reverse') ? json(SEOUL) : json([])));
        const at = [];
        const orig = h.net;
        const track = (p) => p.then(() => at.push(h.now));
        await Promise.all([track(orig.search('서울')), track(orig.reverse(37.5, 127)), track(orig.reverse(35.1, 129.1))]);
        const gaps = at.slice(1).map((t, i) => t - at[i]);
        out.push(sub('39e 검색과 장소 이름이 한 줄로 서고 1000ms 간격', h.calls.length === 3 && gaps.every((g) => g >= 1000), JSON.stringify(gaps)));
      }

      // 39f 설정 placeReverseUrl: https 아니면 기본 주소 + 키 이름만 로그, 올바르면 사용
      {
        const bad = harness(() => json(SEOUL), { placeReverseUrl: 'http://secret.example/reverse' });
        await bad.net.reverse(1, 1);
        const good = harness(() => json(SEOUL), { placeReverseUrl: 'https://geo.example/reverse' });
        await good.net.reverse(1, 1);
        const logs = JSON.stringify(bad.errs);
        out.push(sub('39f placeReverseUrl: https 아니면 기본 주소 + 키 이름만 로그, 올바르면 사용',
          bad.calls[0].url.startsWith('https://nominatim.openstreetmap.org/reverse?') && !logs.includes('secret') && logs.includes('placeReverseUrl')
          && good.calls[0].url.startsWith('https://geo.example/reverse?') && good.errs.length === 0, logs));
      }

      // 39g IPC: 저장해 둔 것만 볼 때는 안 나가고, 누르면 한 번 나가서 DB에 저장. 같은 동네 사진은 다시 안 나감
      const fakes = [];
      try {
        const { openDb } = require('../lib/db');
        const { createLogger } = require('../lib/logger');
        const gmPath = require.resolve('../gallery-main');
        delete require.cache[gmPath];
        const gm = require('../gallery-main');
        delete require.cache[gmPath];

        const dir = path.join(env.tmp, 'places-wire');
        const P = { root: path.resolve(dir, 'photos'), ud: path.join(dir, 'ud'), logDir: path.join(dir, 'logs') };
        fs.mkdirSync(P.root, { recursive: true });
        fs.mkdirSync(P.ud, { recursive: true });
        const spec = {
          'a.jpg': { lat: 37.5759876, lng: 126.9768543, locationSource: 'gps' },
          'near.jpg': { lat: 37.5761, lng: 126.9771, locationSource: 'gps' }, // 3자리로 줄이면 a.jpg 와 같은 곳
          'none.jpg': {},
        };
        const o = openDb(path.join(P.ud, 'library.db'));
        o.db.upsertFiles(Object.entries(spec).map(([name, over]) => {
          fs.writeFileSync(path.join(P.root, name), `사진 ${name}`);
          return row({ root: P.root, path: path.join(P.root, name), name, ...over });
        }));
        const idOf = (name) => o.db.listSuggestionRows(P.root).find((x) => x.name === name).id;
        const ids = { a: idOf('a.jpg'), near: idOf('near.jpg'), none: idOf('none.jpg') };
        o.db.close();

        const fetchCalls = [];
        let fail = false;
        const handlers = new Map();
        const args = {
          ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
          protocol: { handle() {} },
          getWin: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
          getSettings: () => ({ backupRoot: P.root }),
          getTools: () => ({}),
          getEt: () => null,
          isRunning: () => false,
          isPlanning: () => false,
          logger: createLogger(P.logDir),
          userDir: P.ud,
          loadScreen: async () => {},
          getJobPending: () => false,
          mapFetch: async (url, init) => {
            fetchCalls.push(url);
            return fail ? new Response('', { status: 503 }) : json(SEOUL);
          },
          openExternal: async () => {},
          appVersion: '9.9.9',
        };
        const g = gm.setupGallery(args);
        fakes.push(g);
        const call = (ch, ...a) => handlers.get(ch)(null, ...a);

        const peek = await call('gallery:place-name', ids.a, false);
        const noFetchYet = fetchCalls.length === 0;
        const got = await call('gallery:place-name', ids.a, true);
        const nearPeek = await call('gallery:place-name', ids.near, false);
        const nearAsk = await call('gallery:place-name', ids.near, true);
        const noLoc = await call('gallery:place-name', ids.none, true);
        const badId = await errOf(Promise.resolve().then(() => call('gallery:place-name', 'x', true)));
        out.push(sub('39g 보기만 할 때는 안 나감, 누르면 한 번 나가서 저장, 같은 동네 사진은 저장한 이름을 씀, 위치 없는 사진은 null',
          peek && peek.name === null && noFetchYet && got.name === '서울특별시 종로구 세종로' && fetchCalls.length === 1
          && nearPeek.name === '서울특별시 종로구 세종로' && nearAsk.name === '서울특별시 종로구 세종로' && noLoc === null && !!badId,
          JSON.stringify([peek, got, nearPeek, noLoc, badId, fetchCalls.length])));

        // 39h 실패하면 정해진 문장, 저장하지 않아서 다음에 다시 누를 수 있음. 오류 로그에 좌표가 없음
        const o2 = openDb(path.join(P.ud, 'library.db'));
        const far = row({ root: P.root, path: path.join(P.root, 'far.jpg'), name: 'far.jpg', lat: 33.4996, lng: 126.5312, locationSource: 'gps' });
        fs.writeFileSync(far.path, '사진 far');
        o2.db.upsertFiles([far]);
        const farId = o2.db.listSuggestionRows(P.root).find((x) => x.name === 'far.jpg').id;
        o2.db.close();
        fail = true;
        const failText = await errOf(call('gallery:place-name', farId, true));
        const after = await call('gallery:place-name', farId, false);
        const errLog = (fs.existsSync(P.logDir) ? fs.readdirSync(P.logDir) : []).filter((n) => n.startsWith('gallery-error_'))
          .map((n) => fs.readFileSync(path.join(P.logDir, n), 'utf8')).join('\n');
        out.push(sub('39h 서버 실패는 정해진 문장, 저장 안 함, 오류 로그에 상태만 (좌표 없음)',
          failText === REVERSE_FAIL && after.name === null && errLog.includes('HTTP 503') && !errLog.includes('33.4') && !errLog.includes('33.5'),
          JSON.stringify([failText, after, errLog.slice(0, 120)])));
      } catch (e) {
        out.push(sub('39g 실행 중 오류', false, String(e.stack).split('\n').slice(0, 3).join(' | ')));
      } finally {
        for (const g of fakes) {
          try {
            g.close();
          } catch (e) { /* 이미 닫힘 */ }
        }
      }

      // 39i 화면: 위치가 있을 때만 버튼, 누를 때만 묻기 (빌드 전 원본 글자로 확인)
      {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'DetailPanel.jsx'), 'utf8');
        out.push(sub('39i 패널: 위치가 있을 때만 장소 이름, 처음에는 저장한 이름만 읽고 버튼을 누를 때만 서버에 물음',
          src.includes('{coords && <PlaceName file={file} />}') && src.includes('api.placeName(file.id, false)') && src.includes('api.placeName(file.id, true)')
          && src.includes('누르면 이 위치 하나를 OpenStreetMap 서버로 보내요')));
      }
      return out;
    },
  },
];

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

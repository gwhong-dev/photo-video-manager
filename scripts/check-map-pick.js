// 파일 위치: scripts/check-map-pick.js
// 역할: "지도에서 위치 고르기" 점검 항목 (33번부터). scripts/check.js 의 ITEMS 끝에 붙어서 같이 돌아요.
//   빠르게 이 파일만 돌려 볼 때: node scripts/check-map-pick.js
//   (os.tmpdir()의 pvm-check- 임시 폴더에서 돌리고, 모두 통과하면 그 폴더를 지워요)
//
// ⚠️ 진짜 인터넷에는 나가지 않아요. 지도 서버 대신 가짜 응답(fetchImpl)을 넘기거나, 닿지 않는 주소(127.0.0.1:1)를 설정해서 확인해요.
//    실제 사진과 실제 userData도 쓰지 않아요.
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { row, sub } = require('./check-gallery');

// 가짜 PNG (앞 8바이트는 PNG 표시, 나머지는 아무 값)
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const png = () => new Response(PNG, { headers: { 'content-type': 'image/png' } });

// 가짜 응답으로 map-net 을 만들어요. 나간 요청, 남긴 오류, 기다린 시간, 시계를 같이 돌려줘요
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
    // 가짜 기다리기: 진짜로 기다리지 않고 가짜 시계만 앞으로 보내요
    wait: async (ms) => {
      h.waits.push(ms);
      h.now += ms;
    },
  });
  return h;
}

// ---------- 점검 항목 ----------
const items = [
  {
    no: 33,
    name: '지도 그림 전달과 장소 검색 (가짜 서버)',
    async run(env) {
      const out = [];

      // 33a 올바른 주소는 지도 서버 주소로 바뀌어 나가요
      const h = harness(png);
      const ok = await h.net.tile('pvm://tile/5/27/12');
      out.push(sub('33a 올바른 주소는 200 + 서버 주소 변환', ok.status === 200 && ok.type === 'image/png' && Buffer.isBuffer(ok.buffer) && ok.buffer.equals(PNG) && h.calls[0].url === 'https://tile.openstreetmap.org/5/27/12.png', JSON.stringify(h.calls.map((c) => c.url))));

      // 33b 앱 이름표를 달고, 다른 주소로 넘기는 응답은 따라가지 않아요
      const init = h.calls[0].init;
      out.push(sub('33b User-Agent 이름표 + 리다이렉트 안 따라감 + 제한시간', init.headers['User-Agent'] === 'photo-video-manager/1.0.0 (https://github.com/gwhong-dev/photo-video-manager)' && init.redirect === 'error' && !!init.signal, JSON.stringify(init.headers)));

      // 33c 잘못된 주소는 나가기 전에 404예요
      const bad = ['pvm://tile/20/0/0', 'pvm://tile/1/2/0', 'pvm://tile/1/0/-1', 'pvm://tile/01/0/0', 'pvm://tile/1/0', 'pvm://tile/1/0/0/0', 'pvm://tile/1/0/0?a=1', 'pvm://thumb/1', 'pvm://tile/1/0/0#x', 'pvm://u:p@tile/1/0/0', 'pvm://tile:80/1/0/0', 'pvm://tile/1/0/0/', 'pvm://tile/a/0/0', 'pvm://tile/1.5/0/0', 'pvm://tile/19/524288/0', '글자', ''];
      const notFound = [];
      for (const u of bad) {
        const r = await h.net.tile(u);
        if (r.status !== 404) notFound.push(u);
      }
      // 경계값은 통과해야 해요 (z 19의 마지막 칸, z 0)
      const edge1 = await h.net.tile('pvm://tile/19/524287/524287');
      const edge2 = await h.net.tile('pvm://tile/0/0/0');
      out.push(sub('33c 잘못된 주소는 모두 404, 나간 요청 늘지 않음 (경계값은 통과)', notFound.length === 0 && h.calls.length === 3 && edge1.status === 200 && edge2.status === 200, JSON.stringify({ notFound, calls: h.calls.length })));

      // 33d 만들기만 해서는 나가지 않아요
      let boomCalls = 0;
      const { createMapNet } = require('../lib/map-net');
      const made = createMapNet({ fetchImpl: async () => { boomCalls++; throw new Error('boom'); }, getSettings: () => ({}), version: '1.0.0', onError() {} });
      out.push(sub('33d 만들기만 해서는 요청이 나가지 않음', !!made && boomCalls === 0));

      // 33e 설정: https가 아니거나 자리표시가 없으면 기본 주소, 값은 로그에 없고 키 이름만 있어요
      {
        const e = harness(png, { mapTileUrl: 'http://secret.example/{z}/{x}/{y}.png' });
        await e.net.tile('pvm://tile/1/0/0');
        const e2 = harness(png, { mapTileUrl: 'https://secret2.example/tiles.png' });
        await e2.net.tile('pvm://tile/1/0/0');
        const logs = JSON.stringify([e.errs, e2.errs]);
        out.push(sub('33e 잘못된 설정은 기본 주소, 로그에 값 없이 키 이름만', e.calls[0].url.startsWith('https://tile.openstreetmap.org/') && e2.calls[0].url.startsWith('https://tile.openstreetmap.org/') && !logs.includes('secret') && e.errs.length === 1 && JSON.stringify(e.errs).includes('mapTileUrl'), logs));

        // 올바른 설정은 쓰고, 비어 있으면 조용히 기본 주소를 써요
        const g = harness(png, { mapTileUrl: 'https://tiles.example/{z}/{x}/{y}.png' });
        await g.net.tile('pvm://tile/3/1/2');
        const empty = harness(png, { mapTileUrl: '' });
        await empty.net.tile('pvm://tile/3/1/2');
        const none = harness(png, {});
        await none.net.tile('pvm://tile/3/1/2');
        out.push(sub('33e2 올바른 설정은 사용, 빈 설정은 조용히 기본 주소', g.calls[0].url === 'https://tiles.example/3/1/2.png' && empty.calls[0].url === 'https://tile.openstreetmap.org/3/1/2.png' && none.calls[0].url === 'https://tile.openstreetmap.org/3/1/2.png' && empty.errs.length === 0 && none.errs.length === 0 && g.errs.length === 0));
      }

      // 33f 실패는 모두 502이고 한 번만 시도해요 (자동 재시도 없음)
      {
        const cases = [
          ['429', () => new Response('', { status: 429 }), 'HTTP 429'],
          ['네트워크 오류', () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; }, 'ECONNRESET'],
          ['다른 형식', () => new Response('<html>', { headers: { 'content-type': 'text/html' } }), null],
          ['2MB 초과', () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }), null],
          ['2MB 딱', () => new Response(Buffer.alloc(2 * 1024 * 1024), { headers: { 'content-type': 'image/png' } }), 'ok'],
        ];
        const problems = [];
        for (const [name, handler, code] of cases) {
          const f = harness(handler);
          const r = await f.net.tile('pvm://tile/2/1/1');
          const want = code === 'ok' ? 200 : 502;
          if (r.status !== want || f.calls.length !== 1) problems.push(`${name}: ${r.status}, 요청 ${f.calls.length}`);
          if (code && code !== 'ok' && !JSON.stringify(f.errs).includes(code)) problems.push(`${name}: 로그에 ${code} 없음 ${JSON.stringify(f.errs)}`);
        }
        out.push(sub('33f 429, 네트워크 오류, 다른 형식, 2MB 초과는 502 + 한 번만 시도 (2MB 딱은 통과)', problems.length === 0, problems.join(' / ')));
      }

      // 33g 지도 그림 실패 로그는 60초에 한 번
      {
        const f = harness(() => new Response('', { status: 500 }));
        const tries = [0, 1000, 30000, 59999, 60000, 61000];
        const base = f.now;
        for (const t of tries) {
          f.now = base + t;
          await f.net.tile('pvm://tile/2/1/1');
        }
        out.push(sub('33g 실패 로그는 60초에 한 번 (6번 실패 → 2줄)', f.errs.length === 2 && f.calls.length === 6 && f.errs.every((x) => x.where && x.code === 'HTTP 500'), JSON.stringify(f.errs)));
      }

      // ---------- 장소 검색 (33h부터) ----------
      const FAIL_TEXT = '장소를 찾지 못했어요. 잠시 뒤 다시 눌러 주세요.';
      const BAD_QUERY_TEXT = '검색어는 1자부터 200자까지 적어 주세요.';
      const json = (body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      // 약속이 거절되고 문장이 정확히 같은지 봐요
      const rejects = async (promise, text) => {
        try {
          await promise;
          return false;
        } catch (e) {
          return e instanceof Error && e.message === text;
        }
      };
      const SEARCH_DEFAULT = 'https://nominatim.openstreetmap.org/search';

      // 33h 요청 모양: 앞뒤 공백을 빼고, 정해진 값만 붙어서 나가요
      {
        const f = harness(() => json([]));
        await f.net.search(' 경복궁 ');
        const u = new URL(f.calls[0].url);
        const names = [...u.searchParams.keys()].sort().join(',');
        out.push(sub('33h 검색 요청 모양 (q 공백 제거, jsonv2, limit 5, ko, User-Agent, 리다이렉트 안 따라감, 제한시간)',
          u.origin + u.pathname === SEARCH_DEFAULT
          && u.searchParams.get('q') === '경복궁' && u.searchParams.get('format') === 'jsonv2'
          && u.searchParams.get('limit') === '5' && u.searchParams.get('accept-language') === 'ko'
          && names === 'accept-language,format,limit,q'
          && f.calls[0].init.headers['User-Agent'] === 'photo-video-manager/1.0.0 (https://github.com/gwhong-dev/photo-video-manager)'
          && f.calls[0].init.redirect === 'error' && !!f.calls[0].init.signal,
          f.calls[0].url));
      }

      // 33i 응답은 { name, lat, lng } 만 남겨요. 0도는 살리고, 범위 밖과 글자 좌표는 버려요
      {
        const rows = [
          { lat: '37.5', lon: '127', display_name: '가', class: 'x', place_id: 1 },
          { lat: 0, lon: '0', display_name: '영' },
          { lat: '91', lon: '0', display_name: '위도 범위 밖' },
          { lat: '0', lon: '181', display_name: '경도 범위 밖' },
          { lat: 'abc', lon: '0', display_name: '글자 좌표' },
          { lat: null, lon: null, display_name: '널' },
          { lat: '', lon: '', display_name: '빈 글자' },
          { lat: '1', display_name: '경도 없음' },
          null,
          'x',
          { lat: '-90', lon: '-180', display_name: '끝' },
        ];
        const f = harness(() => json(rows));
        const got = await f.net.search('여러 줄');
        const want = [{ name: '가', lat: 37.5, lng: 127 }, { name: '영', lat: 0, lng: 0 }, { name: '끝', lat: -90, lng: -180 }];
        out.push(sub('33i 응답은 name, lat, lng 만 (0도는 살리고 범위 밖과 글자 좌표는 버림)', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got)));
      }

      // 33j 결과 0건은 [], 실패는 정해진 문장으로 거절하고 한 번만 시도해요
      {
        const zero = harness(() => json([]));
        const none = await zero.net.search('없는곳');
        const cases = [
          ['429', () => new Response('', { status: 429 })],
          ['네트워크 오류', () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; }],
          ['리다이렉트', () => { const e = new TypeError('fetch failed'); e.cause = new Error('unexpected redirect'); throw e; }],
          ['잘못된 JSON', () => json('{ 깨진')],
          ['배열이 아닌 JSON', () => json({ a: 1 })],
        ];
        const problems = [];
        for (const [name, handler] of cases) {
          const f = harness(handler);
          if (!(await rejects(f.net.search('실패'), FAIL_TEXT))) problems.push(`${name}: 문장이 다름`);
          if (f.calls.length !== 1) problems.push(`${name}: 요청 ${f.calls.length}번`);
        }
        out.push(sub('33j 0건은 [], 실패(429, 네트워크, 리다이렉트, 잘못된 JSON)는 정해진 문장 + 한 번만 시도',
          Array.isArray(none) && none.length === 0 && zero.calls.length === 1 && problems.length === 0, problems.join(' / ')));
      }

      // 33k 검색어 검사: 나가기 전에 거절해요
      {
        const f = harness(() => json([]));
        const bad = ['', '   ', '가'.repeat(201), 123, null, undefined, {}];
        const problems = [];
        for (const q of bad) {
          if (!(await rejects(f.net.search(q), BAD_QUERY_TEXT))) problems.push(`거절 안 됨: ${String(q).slice(0, 10)}`);
        }
        const edge1 = await f.net.search('가'); // 1자
        const edge2 = await f.net.search(` ${'나'.repeat(200)} `); // 공백 빼면 200자
        out.push(sub('33k 검색어 검사 (빈 값, 공백만, 201자, 글자 아님은 나가기 전에 거절. 1자와 200자는 통과)',
          problems.length === 0 && f.calls.length === 2 && Array.isArray(edge1) && Array.isArray(edge2), problems.join(' / ') + ` 요청 ${f.calls.length}번`));
      }

      // 33l 간격: 동시에 하나만 나가고, 보내는 시각이 1000ms 이상 벌어져요
      {
        let inflight = 0;
        let maxInflight = 0;
        const sentAt = [];
        let f;
        f = harness(async () => {
          inflight++;
          maxInflight = Math.max(maxInflight, inflight);
          sentAt.push(f.now);
          await new Promise((r) => setImmediate(r)); // 응답이 늦게 오는 서버
          inflight--;
          return json([]);
        });
        await Promise.all([f.net.search('하나'), f.net.search('둘'), f.net.search('셋')]);
        const firstThree = sentAt.slice();
        const gaps = firstThree.slice(1).map((t, i) => t - firstThree[i]);
        const firstWaited = f.waits.length === 2; // 첫 요청은 안 기다리고, 뒤의 둘만 기다려요
        // 400ms 뒤에 또 부르면 600ms만 기다려요. 충분히 지났으면 안 기다려요
        f.now += 400;
        await f.net.search('넷');
        const partial = f.waits[f.waits.length - 1];
        f.now += 5000;
        const before = f.waits.length;
        await f.net.search('다섯');
        out.push(sub('33l 연달아 3개: 동시에 하나만, 1000ms 이상 간격 (400ms 뒤면 600ms 기다림, 충분히 지났으면 안 기다림)',
          maxInflight === 1 && firstThree.length === 3 && gaps.every((g) => g >= 1000) && firstWaited && partial === 600 && f.waits.length === before,
          JSON.stringify({ maxInflight, firstThree, gaps, waits: f.waits })));
      }

      // 33m 같은 검색어는 다시 나가지 않고, 실패는 저장하지 않고, 100개까지만 기억해요
      {
        let n = 0;
        const f = harness(() => json([{ lat: '1', lon: '2', display_name: `결과${++n}` }]));
        const a = await f.net.search('서울');
        const b = await f.net.search('  서울  '); // 공백만 다른 같은 검색어
        a.push({ name: '낙서', lat: 0, lng: 0 }); // 받은 쪽이 고쳐도 저장된 것은 그대로
        const c = await f.net.search('서울');
        const sameOk = f.calls.length === 1 && JSON.stringify(b) === JSON.stringify([{ name: '결과1', lat: 1, lng: 2 }]) && c.length === 1;

        // 실패는 저장하지 않아요: 실패 뒤 같은 검색어는 다시 나가요
        let fail = true;
        const g = harness(() => (fail ? new Response('', { status: 500 }) : json([])));
        await rejects(g.net.search('부산'), FAIL_TEXT);
        fail = false;
        await g.net.search('부산');
        const failNotSaved = g.calls.length === 2;

        // 101번째 검색어를 넣으면 가장 오래된 것이 빠져요
        const h2 = harness(() => json([]));
        for (let i = 0; i <= 100; i++) await h2.net.search(`검색${i}`);
        const full = h2.calls.length; // 101
        await h2.net.search('검색1'); // 아직 저장돼 있음 (나가지 않음)
        const afterHit = h2.calls.length;
        await h2.net.search('검색0'); // 빠졌으니 다시 나감 (이때 검색1이 빠짐)
        const afterEvict = h2.calls.length;
        await h2.net.search('검색2'); // 저장돼 있음
        const afterHit2 = h2.calls.length;
        await h2.net.search('검색1'); // 방금 빠졌으니 다시 나감
        out.push(sub('33m 같은 검색어는 다시 안 나감 (공백 무시), 실패는 저장 안 함, 101번째에 가장 오래된 것이 빠짐',
          sameOk && failNotSaved && full === 101 && afterHit === 101 && afterEvict === 102 && afterHit2 === 102 && h2.calls.length === 103,
          JSON.stringify({ sameOk, failNotSaved, full, afterHit, afterEvict, afterHit2, last: h2.calls.length })));
      }

      // 33n 검색어는 오류 로그 어디에도 없어요
      {
        const secret = '비밀검색어SECRETQUERY';
        const handlers = [
          () => new Response('', { status: 429 }),
          () => { const e = new TypeError(`fetch failed: ${secret}`); e.cause = { code: 'ENOTFOUND', message: secret }; throw e; },
          () => { throw new TypeError(`주소에 ${secret} 가 들어 있는 오류`); },
          () => json(`{ ${secret}`),
        ];
        const all = [];
        for (const handler of handlers) {
          const f = harness(handler);
          await rejects(f.net.search(secret), FAIL_TEXT);
          all.push(f.errs);
        }
        const logs = JSON.stringify(all);
        const encoded = encodeURIComponent(secret);
        out.push(sub('33n 검색어가 오류 로그에 없음 (상태와 오류 코드만)',
          !logs.includes('SECRETQUERY') && !logs.includes(encoded) && !logs.includes('비밀') && all.every((e) => e.length === 1 && e[0].where === 'search') && logs.includes('HTTP 429') && logs.includes('ENOTFOUND'), logs));
      }

      // 33o placeSearchUrl 도 mapTileUrl 과 같은 규칙: https가 아니면 기본 주소, 값은 로그에 없고 키 이름만
      {
        const bad1 = harness(() => json([]), { placeSearchUrl: 'http://secret.example/search' });
        await bad1.net.search('가');
        const bad2 = harness(() => json([]), { placeSearchUrl: 12345 });
        await bad2.net.search('가');
        const logs = JSON.stringify([bad1.errs, bad2.errs]);
        const good = harness(() => json([]), { placeSearchUrl: 'https://search.example/find' });
        await good.net.search('가');
        const empty = harness(() => json([]), { placeSearchUrl: '' });
        await empty.net.search('가');
        const none = harness(() => json([]), {});
        await none.net.search('가');
        const gu = new URL(good.calls[0].url);
        out.push(sub('33o placeSearchUrl: https 아니면 기본 주소 + 키 이름만 로그, 올바르면 사용, 비면 조용히 기본 주소',
          bad1.calls[0].url.startsWith(SEARCH_DEFAULT + '?') && bad2.calls[0].url.startsWith(SEARCH_DEFAULT + '?')
          && !logs.includes('secret') && !logs.includes('12345') && bad1.errs.length === 1 && bad1.errs[0].where === 'placeSearchUrl' && bad2.errs.length === 1
          && gu.origin + gu.pathname === 'https://search.example/find' && gu.searchParams.get('q') === '가' && good.errs.length === 0
          && empty.calls[0].url.startsWith(SEARCH_DEFAULT + '?') && none.calls[0].url.startsWith(SEARCH_DEFAULT + '?') && empty.errs.length === 0 && none.errs.length === 0,
          logs));
      }

      return out;
    },
  },
  {
    no: 34,
    name: '핀 위치 저장과 지도 연결 (가짜 setupGallery)',
    async run(env) {
      const out = [];
      const dbMod = require('../lib/db');
      const { normalizeRequest } = require('../lib/manual-edit');
      const { createJournal, recover } = require('../lib/manual-journal');
      const { createLogger } = require('../lib/logger');
      const { openDb } = dbMod;
      const throws = (fn) => {
        try {
          fn();
          return false;
        } catch (e) {
          return e instanceof Error;
        }
      };

      // 34a, 34b 값 검사와 반올림 (DB 없이 계산만)
      {
        const r = normalizeRequest({ source: 'pin', lat: 37.12345678, lng: 0 });
        out.push(sub('34a 핀 요청은 소수점 6자리로 줄이고 0도 살림 (위치만, 근거 사진 없음)', r.kind === 'location' && r.location.lat === 37.123457 && r.location.lng === 0 && r.sourceId === null && r.date === null, JSON.stringify(r)));
        const bad = [
          { source: 'pin', lat: 91, lng: 0 },
          { source: 'pin', lat: 0, lng: -181 },
          { source: 'pin', lat: '37', lng: 127 },
          { source: 'pin', lat: NaN, lng: 127 },
          { source: 'pin', lat: 37 },
          { source: 'pin' },
        ];
        const notRejected = bad.filter((b) => !throws(() => normalizeRequest(b)));
        out.push(sub('34b 범위 밖, 글자, 빠진 값은 거절', notRejected.length === 0, JSON.stringify(notRejected)));
      }

      // gallery-main을 불러오는 동안만 openDb를 감싸서, 점검이 같은 DB를 들여다볼 수 있게 해요 (항목 30과 같은 방식)
      const opened = [];
      const gmPath = require.resolve('../gallery-main');
      delete require.cache[gmPath];
      dbMod.openDb = (f, o) => {
        const r = openDb(f, o);
        opened.push(r.db);
        return r;
      };
      let gm;
      try {
        gm = require('../gallery-main');
      } finally {
        dbMod.openDb = openDb;
        delete require.cache[gmPath];
      }

      const base = path.join(env.tmp, 'map-wire');
      fs.mkdirSync(base, { recursive: true });
      let seq = 0;
      const fakes = [];
      const errOf = (p) => p.then(() => null, (e) => e.message);
      const DAY = '2026-10-25';
      const at = (hhmm) => `${DAY}T${hhmm}:00`;
      const FILE_LAT = 35.1;
      const FILE_LNG = 129.2;
      const PIN = (lat, lng) => ({ source: 'pin', lat, lng });
      const SEARCH_JSON = JSON.stringify([{ lat: '37.5', lon: '127', display_name: '가짜 장소' }]);
      const SEARCH_FAIL = '장소를 찾지 못했어요. 잠시 뒤 다시 눌러 주세요.';

      // 사진 폴더와 userData를 만들고 DB에 줄을 넣어 둬요. spec: { 이름: 덮어쓸 값 }
      const prep = (label, spec) => {
        const dir = path.join(base, `${label}-${++seq}`);
        const P = { root: path.resolve(dir, 'photos-root-xyz'), ud: path.join(dir, 'ud'), logDir: path.join(dir, 'logs') };
        fs.mkdirSync(P.ud, { recursive: true });
        fs.mkdirSync(P.root, { recursive: true });
        const o = openDb(path.join(P.ud, 'library.db'));
        o.db.upsertFiles(Object.entries(spec).map(([name, over]) => {
          fs.writeFileSync(path.join(P.root, name), `사진 ${name}`);
          return row({ root: P.root, path: path.join(P.root, name), name, takenAt: at('14:00'), takenDay: DAY, ...over });
        }));
        o.db.close();
        return P;
      };
      // setupGallery를 가짜 ipcMain, 가짜 protocol, 가짜 인터넷으로 띄워요.
      //   wire: false 면 mapFetch, openExternal, appVersion 을 아예 안 넘겨요 (이 기능이 생기기 전의 점검과 같은 모양)
      const makeFake = (P, { wire = true, mapFetch } = {}) => {
        const f = { handlers: new Map(), P, fetchCalls: [], opened: [], protocolHandler: null };
        const win = { isDestroyed: () => false, webContents: { send() {} } };
        const args = {
          ipcMain: { handle: (ch, fn) => f.handlers.set(ch, fn) },
          protocol: { handle: (scheme, fn) => { f.protocolHandler = fn; } },
          getWin: () => win,
          getSettings: () => ({ backupRoot: P.root }),
          getTools: () => ({}),
          getEt: () => null,
          isRunning: () => false,
          isPlanning: () => false,
          logger: createLogger(P.logDir),
          userDir: P.ud,
          loadScreen: async () => {},
          getJobPending: () => false,
        };
        if (wire) {
          args.mapFetch = async (url, init) => {
            f.fetchCalls.push({ url, init });
            return mapFetch ? mapFetch(url, init) : png();
          };
          args.openExternal = async (u) => { f.opened.push(u); };
          args.appVersion = '9.9.9';
        }
        f.g = gm.setupGallery(args);
        f.db = opened[opened.length - 1];
        f.call = async (ch, ...a) => f.handlers.get(ch)(null, ...a);
        f.close = () => {
          if (f.closed) return;
          f.closed = true;
          f.g.close();
        };
        fakes.push(f);
        return f;
      };
      const idOf = (f, name) => f.db.listSuggestionRows(f.P.root).find((x) => x.name === name).id;
      const jlines = (P) => createJournal(path.join(P.ud, 'manual-edits.jsonl')).read().lines;
      const logsOf = (P, prefix) => (fs.existsSync(P.logDir) ? fs.readdirSync(P.logDir) : []).filter((n) => n.startsWith(prefix)).map((n) => fs.readFileSync(path.join(P.logDir, n), 'utf8')).join('\n');
      const scene = async (label, fn) => {
        try {
          await fn();
        } catch (e) {
          out.push(sub(`${label} 실행 중 오류`, false, String(e.stack).split('\n').slice(0, 3).join(' | ')));
        }
      };
      const BASIC = { 'a.jpg': {}, 'b.jpg': { takenAt: at('14:10') }, 'file.jpg': { lat: FILE_LAT, lng: FILE_LNG, locationSource: 'gps' } };
      const request = (u) => ({ url: u });

      try {
        await scene('34c', async () => {
          const f = makeFake(prep('pin', BASIC));
          const file = idOf(f, 'file.jpg');
          const a = idOf(f, 'a.jpg');
          const edit = PIN(37.12345678, 127.5);
          // 34c 파일 위치가 있는 사진이 섞이면 원래 값 있음으로 세고, 되돌리면 파일 값으로 돌아와요
          const pv = await f.call('gallery:preview-edit', [a, file], edit);
          const r = await f.call('gallery:apply-edit', [a, file], edit);
          const after = await f.call('gallery:get-file', file);
          const afterA = await f.call('gallery:get-file', a);
          await f.call('gallery:undo-last', r.batchId);
          const undone = await f.call('gallery:get-file', file);
          out.push(sub('34c 핀 미리보기: 파일 위치 있는 사진은 덮어씀으로 셈, 저장은 6자리, 되돌리면 파일 값',
            pv.kind === 'location' && pv.counts.changed === 2 && pv.counts.overwrite === 1
            && r.count === 2 && r.kind === 'location' && after.lat === 37.123457 && after.lng === 127.5 && after.locationSource === 'manual' && afterA.lat === 37.123457
            && undone.lat === FILE_LAT && undone.lng === FILE_LNG,
            JSON.stringify([pv.counts, r, after.lat, undone.lat])));

          // 34d 기록 파일과 로그
          const line = jlines(f.P)[0];
          const log = logsOf(f.P, 'manual-edit_');
          out.push(sub('34d 기록 파일 via map + sourcePath null, 로그에 제목 지도로 넣기, 방법 map, 근거 없음',
            line.via === 'map' && line.sourcePath === null && line.kind === 'location' && log.includes('지도로 넣기') && log.includes('방법 map') && log.includes('근거 없음'),
            `${JSON.stringify([line.via, line.sourcePath])} ${log.slice(0, 80)}`));

          // 34f 핀과 위치 제안이 섞이거나 모르는 via 가 오면 거절
          const withSuggest = await errOf(f.call('gallery:apply-edit', [a], { ...edit, via: 'suggest' }));
          const withRobot = await errOf(f.call('gallery:apply-edit', [a], { ...edit, via: 'robot' }));
          out.push(sub('34f via suggest 와 함께 온 핀은 거절, 모르는 via 도 거절',
            withSuggest === '위치 제안은 위치만 넣을 수 있어요.' && withRobot === '넣는 방법이 올바르지 않아요.', JSON.stringify([withSuggest, withRobot])));
        });

        await scene('34e', async () => {
          // 34e 켤 때 복구: 기록 파일로 DB를 새로 만들어도 핀 값이 살아나요
          const P = prep('recover', BASIC);
          const f = makeFake(P);
          await f.call('gallery:apply-edit', [idOf(f, 'a.jpg')], PIN(10.5, -20.25));
          f.close();
          fs.mkdirSync(path.join(P.ud, 'fresh'), { recursive: true });
          const fresh = openDb(path.join(P.ud, 'fresh', 'library.db'));
          const r = recover(fresh.db, createJournal(path.join(P.ud, 'manual-edits.jsonl')));
          fresh.db.upsertFiles([row({ root: P.root, path: path.join(P.root, 'a.jpg'), name: 'a.jpg', takenDay: DAY })]);
          const va = fresh.db.listSuggestionRows(P.root).find((x) => x.name === 'a.jpg');
          fresh.db.close();
          out.push(sub('34e 기록 파일에서 핀 값이 복구됨 (출처 manual)', r.applied === 1 && va.lat === 10.5 && va.lng === -20.25 && va.locationSource === 'manual', JSON.stringify([r.applied, va.lat, va.lng, va.locationSource])));
        });

        await scene('34g', async () => {
          // 34g 시작과 목록 읽기만으로는 mapFetch를 부르지 않아요
          const f = makeFake(prep('lazy', BASIC));
          f.g.onWindowReady();
          await f.call('gallery:get-state');
          await f.call('gallery:list-days', {});
          await f.call('gallery:list-files', null, {});
          await f.call('gallery:list-suggestions');
          out.push(sub('34g 시작, 읽기 시작, 목록 읽기만으로는 mapFetch를 부르지 않음', f.fetchCalls.length === 0 && typeof f.protocolHandler === 'function', String(f.fetchCalls.length)));

          // mapFetch 등을 안 넘겨도 켜지고, 쓸 때만 실패해요 (옛 점검과 같은 방식)
          const bare = makeFake(prep('bare', BASIC), { wire: false });
          const st = await bare.call('gallery:get-state');
          const tileRes = await bare.protocolHandler(request('pvm://tile/5/27/12'));
          const searchErr = await errOf(bare.call('gallery:search-place', '서울'));
          const creditErr = await errOf(bare.call('gallery:open-map-credit'));
          out.push(sub('34g2 mapFetch, openExternal, appVersion 없이도 켜지고 쓸 때만 실패',
            st.root === bare.P.root && tileRes.status === 404 && searchErr === SEARCH_FAIL && typeof creditErr === 'string' && creditErr !== '',
            JSON.stringify([tileRes.status, searchErr, creditErr])));
        });

        await scene('34h', async () => {
          // 34h pvm://tile 은 DB가 없어도 응답하고 사진 번호를 쓰지 않아요. pvm://thumb 은 그대로
          const f = makeFake(prep('tile', BASIC));
          const ok = await f.protocolHandler(request('pvm://tile/5/27/12'));
          const body = Buffer.from(await ok.arrayBuffer());
          const headersOk = ok.status === 200 && ok.headers.get('content-type') === 'image/png' && ok.headers.get('cache-control') === 'no-cache' && body.equals(PNG);
          const fetched = f.fetchCalls.map((c) => c.url);
          const ua = f.fetchCalls[0].init.headers['User-Agent'];
          const bad = await f.protocolHandler(request('pvm://tile/20/0/0'));
          const thumb = await f.protocolHandler(request('pvm://thumb/999'));
          const onlyOne = f.fetchCalls.length === 1; // 그림 한 번만 나갔고, 잘못된 주소와 thumb 은 안 나감
          f.close();

          // DB를 못 여는 상태 (파일 자리에 폴더): 그래도 지도는 나와요
          const P2 = { root: path.resolve(base, 'nodb', 'photos'), ud: path.join(base, 'nodb', 'ud'), logDir: path.join(base, 'nodb', 'logs') };
          fs.mkdirSync(path.join(P2.ud, 'library.db'), { recursive: true });
          const g = makeFake(P2);
          const st = await g.call('gallery:get-state');
          const t2 = await g.protocolHandler(request('pvm://tile/3/1/2'));
          const th2 = await g.protocolHandler(request('pvm://thumb/1'));
          out.push(sub('34h pvm://tile: 200 + image/png + no-cache, 서버 주소와 이름표 사용, 잘못된 주소와 thumb 은 404 (인터넷 안 나감), DB가 없어도 지도는 나오고 thumb 은 404',
            headersOk && fetched[0] === 'https://tile.openstreetmap.org/5/27/12.png' && ua === 'photo-video-manager/9.9.9 (https://github.com/gwhong-dev/photo-video-manager)'
            && bad.status === 404 && thumb.status === 404 && onlyOne
            && typeof st.dbError === 'string' && t2.status === 200 && g.fetchCalls.length === 1 && th2.status === 404,
            JSON.stringify({ headersOk, fetched, bad: bad.status, thumb: thumb.status, dbError: !!st.dbError, t2: t2.status, th2: th2.status })));

          // 서버가 실패하면 화면에는 404, 오류 로그에는 상태만
          const h = makeFake(prep('tile-fail', BASIC), { mapFetch: () => new Response('', { status: 429 }) });
          const failed = await h.protocolHandler(request('pvm://tile/5/27/12'));
          const errLog = logsOf(h.P, 'gallery-error_');
          out.push(sub('34h2 지도 서버가 실패하면 화면에는 404, 오류 로그에는 상태만', failed.status === 404 && errLog.includes('HTTP 429') && !errLog.includes('tile.openstreetmap'), errLog.slice(0, 120)));
        });

        await scene('34i', async () => {
          // 34i 검색 IPC가 숫자, 객체를 거절하고 credit IPC는 인자를 무시하고 고정 주소만 열어요
          const f = makeFake(prep('ipc', BASIC), { mapFetch: () => new Response(SEARCH_JSON, { headers: { 'content-type': 'application/json' } }) });
          const BAD_QUERY = '검색어는 1자부터 200자까지 적어 주세요.';
          const num = await errOf(f.call('gallery:search-place', 123));
          const obj = await errOf(f.call('gallery:search-place', { q: '서울' }));
          const empty = await errOf(f.call('gallery:search-place', '  '));
          const noFetchYet = f.fetchCalls.length === 0;
          const found = await f.call('gallery:search-place', ' 서울 ');
          await f.call('gallery:open-map-credit', 'https://evil.example/', 123);
          await f.call('gallery:open-map-credit');
          const first = new URL(f.fetchCalls[0].url);
          out.push(sub('34i 검색 IPC는 숫자, 객체, 빈 값을 거절하고 올바른 검색어는 결과를 돌려줌',
            num === BAD_QUERY && obj === BAD_QUERY && empty === BAD_QUERY && noFetchYet && JSON.stringify(found) === JSON.stringify([{ name: '가짜 장소', lat: 37.5, lng: 127 }])
            && first.origin + first.pathname === 'https://nominatim.openstreetmap.org/search' && first.searchParams.get('q') === '서울',
            JSON.stringify([num, obj, empty, found])));
          out.push(sub('34i2 credit IPC는 인자를 무시하고 고정 주소만 엶', f.opened.length === 2 && f.opened.every((u) => u === 'https://www.openstreetmap.org/copyright'), JSON.stringify(f.opened)));

          // 34j 검색 실패 로그에는 검색어가 없어요
          const secret = '비밀검색어SECRETQUERY';
          const g = makeFake(prep('ipc-fail', BASIC), { mapFetch: () => new Response('', { status: 429 }) });
          const failText = await errOf(g.call('gallery:search-place', secret));
          const errLog = logsOf(g.P, 'gallery-error_');
          out.push(sub('34j 검색 실패는 정해진 문장으로 거절, 오류 로그에 상태만 있고 검색어는 없음',
            failText === SEARCH_FAIL && errLog.includes('HTTP 429') && !errLog.includes('SECRETQUERY') && !errLog.includes(encodeURIComponent(secret)) && !errLog.includes('비밀'),
            errLog.slice(0, 160)));
        });
      } finally {
        for (const f of fakes) {
          try {
            f.close();
          } catch (e) { /* 이미 닫혔으면 그대로 */ }
        }
      }
      return out;
    },
  },
  {
    no: 35,
    name: '지도 창 (진짜 앱, 끊긴 상태) 과 핀 계산',
    async run(env) {
      const out = [];
      const APP = path.join(__dirname, '..');

      // ---------- 순수 계산 (React와 Leaflet 없이) ----------
      const { pathToFileURL } = require('url');
      const { pinFrom, nextPin, createLatest, nearLng } = await import(pathToFileURL(path.join(APP, 'src', 'map-view.mjs')).href);
      out.push(sub('35g 경도 감기', pinFrom(37, 190).lng === -170 && pinFrom(37, -190).lng === 170 && pinFrom(0, 0).lat === 0, JSON.stringify([pinFrom(37, 190), pinFrom(37, -190)])));
      out.push(sub('35h 반올림', pinFrom(37.12345678, 127).lat === 37.123457));
      // 35d 늦은 검색 응답: 새 검색이나 창 닫기 뒤의 옛 번호는 버려요
      const latest = createLatest();
      const a = latest.next();
      const b = latest.next();
      const newest = b.isCurrent();
      latest.cancel();
      out.push(sub('35d 늦은 검색 응답은 버림 (새 검색, 창 닫기)', !a.isCurrent() && newest && !b.isCurrent()));
      // 35e 넣는 중에는 핀이 안 바뀌어요
      const here = { lat: 1, lng: 2 };
      const there = { lat: 3, lng: 4 };
      out.push(sub('35e 넣는 중에는 핀이 안 바뀜', nextPin(here, there, true) === here && nextPin(here, there, false) === there));
      // 35e2 날짜변경선 근처에서 지도를 눌러도 핀이 보던 화면 안에 있어요 (값은 감긴 그대로)
      out.push(sub('35e2 핀은 보고 있는 지구 복사본에 그림', nearLng(-170, 170) === 190 && nearLng(170, -170) === -190 && nearLng(127, 127) === 127, String(nearLng(-170, 170))));
      // 35i 화면이 직접 나가지 않아요
      const html = fs.readFileSync(path.join(APP, 'src', 'index.html'), 'utf8');
      const csp = (html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/) || [])[1];
      out.push(sub('35i 화면 보안 설정에 인터넷 주소가 없음', !!csp && !/https?:/.test(csp), String(csp)));

      // ---------- 진짜 앱 ----------
      // 샘플 복사본과 임시 userData로 띄워요. 지도와 검색 주소는 닿지 않는 127.0.0.1:1 이라 진짜 인터넷에 나가지 않아요. 값은 넣지 않아요
      const { launchCheck } = require('./launch-check');
      const copyRoot = path.join(env.tmp, 'launch-map-root');
      fs.cpSync(path.join(APP, 'test', 'samples', 'auto'), copyRoot, { recursive: true });
      const ud = path.join(env.tmp, 'launch-map-ud');
      fs.mkdirSync(ud, { recursive: true });
      fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({
        backupRoot: copyRoot,
        mapTileUrl: 'https://127.0.0.1:1/{z}/{x}/{y}.png',
        placeSearchUrl: 'https://127.0.0.1:1/search',
      }), 'utf8');
      const r = await launchCheck(APP, {
        port: 9338,
        env: { PVM_USER_DATA: ud },
        until: '10.28',
        probe: `(${mapProbe.toString()})()`,
      });
      const q = r.probed || {};
      const seen = JSON.stringify(q);
      out.push(sub('35a 지도 크기가 있고 지도 칸이 만들어졌고 검색칸에 초점', q.mapHeight > 0 && q.tileCount > 0 && q.focused === 'INPUT', seen));
      out.push(sub('35a2 메뉴와 오른쪽 패널에 같은 버튼', q.menuText === '1장 위치 지도에서 고르기' && q.panelText === '1장 위치 지도에서 고르기' && q.title === '지도에서 위치 고르기', seen));
      out.push(sub('35a3 처음에는 핀이 없고 넣기 버튼이 꺼져 있음', q.start && q.start.pin === false && q.start.button === '지도에서 위치를 골라 주세요' && q.start.disabled === true, seen));
      out.push(sub('35b 출처가 보이고, 앱을 넘기는 링크가 없음', q.creditText === '© OpenStreetMap 기여자' && q.externalLinks === 0 && q.attribution === 0, seen));
      out.push(sub('35b2 확대 버튼을 눌러도 창 주소가 그대로', q.zoomClicked === true && q.sameUrl === true, seen));
      out.push(sub('35b3 검색 안내 문장', q.searchHint === '검색어는 OpenStreetMap 서버로 보내요. 이름이나 전화번호 같은 개인정보는 적지 마세요.', seen));
      out.push(sub('35c 끊긴 상태의 문장', q.mapError === '지도를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.' && q.searchError === '장소를 찾지 못했어요. 잠시 뒤 다시 눌러 주세요.', seen));
      // 넣지는 않고 그만둬요
      out.push(sub('35f 지도를 누르면 핀이 놓이고 미리보기가 만들어져 넣기 버튼이 켜짐', !!q.afterClick && q.afterClick.button.endsWith('위치 넣기') && q.afterClick.pending === false && q.afterClick.pin === true && q.afterClick.disabled === false, seen));
      out.push(sub('35j 창 안의 Tab 순환과 Esc 닫기 (지도에 초점이 있어도)', q.tabWraps === true && q.shiftTabWraps === true && q.closedByEsc === true && q.undoBar === false, seen));
      // 끊긴 상태라 지도 칸 실패 로그는 당연히 나와요. 그 밖의 화면 오류는 없어야 해요
      const realErrors = r.errors.filter((e) => !/Failed to load resource/.test(e));
      out.push(sub('35k 화면 오류 없음, 정상 종료', realErrors.length === 0 && r.exitCode === 0, `${realErrors.join(' / ')} 종료 코드 ${r.exitCode}`));
      return out;
    },
  },
];

// 항목 35가 앱 화면 안에서 돌리는 함수예요. 글자로 바뀌어 넘어가니까 바깥 변수를 쓰면 안 돼요
//   사진을 고르고 메뉴로 지도 창을 연 뒤, 보이는 값을 모아 돌려줘요. 넣기는 누르지 않아요
async function mapProbe() {
  const wait = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await new Promise((res) => setTimeout(res, 100));
    }
  };
  const byText = (sel, text) => [...document.querySelectorAll(sel)].find((b) => (b.innerText || '').includes(text));
  const q = {};
  const cell = await wait(() => document.querySelector('button.cell'));
  if (!cell) return { stop: '사진 칸이 없어요' };
  cell.click();
  const panelButton = await wait(() => byText('.panel-actions button', '위치 지도에서 고르기'));
  q.panelText = panelButton ? panelButton.innerText : '';
  cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
  const menuItem = await wait(() => byText('.context-menu button', '위치 지도에서 고르기'));
  if (!menuItem) return { ...q, stop: '메뉴 항목이 없어요' };
  q.menuText = menuItem.innerText;
  menuItem.click();

  const canvas = await wait(() => document.querySelector('.map-canvas'));
  if (!canvas) return { ...q, stop: '지도가 없어요' };
  const dialog = document.querySelector('.dialog');
  const foot = () => dialog.querySelector('.dialog-foot button.primary');
  q.focused = document.activeElement.tagName;
  q.title = dialog.querySelector('.dialog-title').innerText;
  q.start = { pin: !!dialog.querySelector('.map-pin'), button: foot().innerText, disabled: foot().disabled };
  await wait(() => dialog.querySelector('.leaflet-tile'));
  q.mapHeight = canvas.offsetHeight;
  q.tileCount = dialog.querySelectorAll('.leaflet-tile').length;
  q.creditText = (dialog.querySelector('.map-credit') || {}).innerText;
  q.externalLinks = document.querySelectorAll('a[href^="http"]').length;
  q.attribution = document.querySelectorAll('.leaflet-control-attribution').length;
  const hint = dialog.querySelector('.map-hint');
  q.searchHint = hint ? hint.innerText : '';

  // 지도 그림 실패 문장
  const mapError = await wait(() => dialog.querySelector('.map-error'));
  q.mapError = mapError ? mapError.innerText : '';

  // 검색 실패 문장
  const input = dialog.querySelector('.map-search input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '서울');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((res) => setTimeout(res, 50));
  dialog.querySelector('.map-search button').click();
  const searchError = await wait(() => dialog.querySelector('.map-search-error'));
  q.searchError = searchError ? searchError.innerText : '';

  // 확대 버튼은 링크 모양이지만 창 주소를 바꾸지 않아요
  const before = location.href;
  const zoomIn = dialog.querySelector('.leaflet-control-zoom-in');
  q.zoomClicked = !!zoomIn;
  if (zoomIn) zoomIn.click();
  await new Promise((res) => setTimeout(res, 400));
  q.sameUrl = location.href === before;

  // 지도 가운데를 누르면 핀이 놓이고 미리보기가 만들어져요
  const box = canvas.getBoundingClientRect();
  canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
  await wait(() => foot().innerText.endsWith('위치 넣기') && !foot().disabled);
  q.afterClick = {
    button: foot().innerText,
    disabled: foot().disabled,
    pending: dialog.innerText.includes('지도에서 위치를 골라 주세요'),
    pin: !!dialog.querySelector('.map-pin'),
  };

  // Tab 순환: 마지막 버튼에서 Tab이면 검색칸으로, 검색칸에서 Shift+Tab이면 마지막 버튼으로
  const key = (el, opts) => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...opts }));
  const last = foot();
  last.focus();
  key(last, { key: 'Tab' });
  q.tabWraps = document.activeElement === input;
  key(input, { key: 'Tab', shiftKey: true });
  q.shiftTabWraps = document.activeElement === last;

  // 지도에 초점이 있을 때 Esc를 누르면 창이 닫혀요. 넣지 않았으니 되돌리기 줄은 없어요
  canvas.focus();
  key(canvas, { key: 'Escape' });
  q.closedByEsc = !!(await wait(() => !document.querySelector('.dialog'), 3000));
  q.undoBar = document.body.innerText.includes('되돌리기');
  return q;
}

module.exports = { items };

// 이 파일만 바로 돌릴 때: 임시 폴더를 만들고, 다 통과하면 지워요
if (require.main === module) {
  (async () => {
    const { stamp } = require('../lib/logger');
    const tmp = path.join(os.tmpdir(), `pvm-check-mappick-${stamp()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const env = { tmp };
    let failed = 0;
    for (const item of items) {
      let subs;
      try {
        subs = await item.run(env);
      } catch (e) {
        subs = [sub('실행 중 오류', false, e.stack)];
      }
      const bad = subs.filter((s) => s.status === 'fail');
      if (bad.length) failed++;
      console.log(`${bad.length ? '❌' : '✅'} ${item.no}. ${item.name}`);
      for (const s of subs) {
        if (s.status === 'ok') continue;
        console.log(`      ❌ ${s.label}${s.detail ? ' — ' + s.detail : ''}`);
      }
    }
    if (failed) {
      console.log(`\n결과: ❌ ${failed}개 항목 실패 (원인 확인용 폴더: ${tmp})`);
      process.exit(1);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n결과: ✅ 모두 통과');
  })().catch((e) => {
    console.error('❌ 점검 실행 오류: ' + e.stack);
    process.exit(1);
  });
}

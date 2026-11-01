// 파일 위치: scripts/check-map-pick.js
// 역할: "지도에서 위치 고르기" 점검 항목 (33번부터). scripts/check.js 의 ITEMS 끝에 붙어서 같이 돌아요.
//   빠르게 이 파일만 돌려 볼 때: node scripts/check-map-pick.js
//   (os.tmpdir()의 pvm-check- 임시 폴더에서 돌리고, 모두 통과하면 그 폴더를 지워요)
//
// ⚠️ 진짜 인터넷에는 나가지 않아요. 지도 서버 대신 가짜 응답(fetchImpl)을 넘겨서 확인해요.
//    실제 사진과 실제 userData도 쓰지 않아요.
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { sub } = require('./check-gallery');

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
];

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

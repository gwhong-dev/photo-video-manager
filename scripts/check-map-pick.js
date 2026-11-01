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

// 가짜 응답으로 map-net 을 만들어요. 나간 요청, 남긴 오류, 시계를 같이 돌려줘요
function harness(handler, settings = {}) {
  const { createMapNet } = require('../lib/map-net');
  const h = { calls: [], errs: [], settings, now: 1_000_000 };
  h.net = createMapNet({
    fetchImpl: async (url, init) => {
      h.calls.push({ url, init });
      return handler(url, init);
    },
    getSettings: () => h.settings,
    version: '1.0.0',
    onError: (where, code) => h.errs.push({ where, code }),
    nowMs: () => h.now,
  });
  return h;
}

// ---------- 점검 항목 ----------
const items = [
  {
    no: 33,
    name: '지도 그림 전달 (가짜 서버)',
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

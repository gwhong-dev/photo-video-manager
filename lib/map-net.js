// 파일 위치: lib/map-net.js
// 역할: 지도 그림을 인터넷에서 받아 오는 곳 (docs/superpowers/specs/2026-11-02-map-pick-design.md 4절 "인터넷 연결 규칙")
//   - 이 앱에서 인터넷으로 나가는 곳은 여기뿐이에요. 화면은 직접 나가지 않고 pvm://tile/<z>/<x>/<y> 로만 요청해요
//   - 나가는 것은 지도 번호(z, x, y)와 앱 이름표(User-Agent)뿐이에요. 사진, 파일 이름, 폴더 경로, 좌표 목록은 나가지 않아요
//   - 모양이 틀린 주소는 나가기 전에 바로 404예요
//   - 실패해도 자동으로 다시 시도하지 않아요 (사용자가 지도를 다시 움직일 때만 다시 보내요)
//   - 로그에는 HTTP 상태나 오류 코드, 설정 키 이름만 남겨요. 설정 주소 값은 남기지 않아요
//   - Electron은 쓰지 않아요 (lib/ 규칙). fetch 는 밖에서 받아서 써요 (gallery-main.js 가 net.fetch 를 넘겨요)
//
// 모양: createMapNet({ fetchImpl, getSettings, version, onError, nowMs }) → { tile(urlText) }
//   tile → { status: 200, buffer, type: 'image/png' } | { status: 404 } | { status: 502 }
//   onError(where, code): where는 정해진 글자('tile', 'mapTileUrl'), code는 'HTTP 429' 같은 상태나 오류 코드뿐

const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const PROJECT_URL = 'https://github.com/gwhong-dev/photo-video-manager';
const TILE_TIMEOUT_MS = 10 * 1000; // 지도 그림 제한시간 10초
const MAX_TILE_BYTES = 2 * 1024 * 1024; // 2MB 넘는 그림은 받지 않아요
const LOG_INTERVAL_MS = 60 * 1000; // 같은 종류의 실패 로그는 60초에 한 번만

const Z_PATTERN = /^(0|[1-9][0-9]?)$/; // 맨 앞 0 없는 정수
const XY_PATTERN = /^(0|[1-9][0-9]{0,6})$/; // 2^19 = 524288 이 가장 큰 칸 수라 일곱 자리면 충분해요
const NOT_FOUND = { status: 404 };
const BAD_GATEWAY = { status: 502 };

function createMapNet({ fetchImpl, getSettings, version, onError, nowMs = Date.now }) {
  const userAgent = `photo-video-manager/${version} (${PROJECT_URL})`;
  const lastLogAt = new Map(); // 로그 종류 → 마지막으로 남긴 시각

  // 같은 종류(where)는 60초에 한 번만 남겨요. 서버가 막혔을 때 로그가 넘치지 않게
  function report(where, code) {
    const now = nowMs();
    const last = lastLogAt.get(where);
    if (last !== undefined && now - last < LOG_INTERVAL_MS) return;
    lastLogAt.set(where, now);
    try {
      if (onError) onError(where, String(code));
    } catch (e) {
      // 로그가 안 남는다고 지도가 멈추면 안 돼요
    }
  }

  // 설정에서 지도 주소 틀을 읽어요. 비었으면 조용히 기본값, 잘못됐으면 기본값 + 키 이름만 로그
  function tileTemplate() {
    let value;
    try {
      const s = getSettings ? getSettings() : null;
      value = s && s.mapTileUrl;
    } catch (e) {
      return DEFAULT_TILE_URL;
    }
    if (value === undefined || value === null || value === '') return DEFAULT_TILE_URL;
    const ok = typeof value === 'string' && value.startsWith('https://') && ['{z}', '{x}', '{y}'].every((k) => value.includes(k));
    if (!ok) {
      report('mapTileUrl', 'invalid');
      return DEFAULT_TILE_URL;
    }
    return value;
  }

  // pvm://tile/<z>/<x>/<y> 를 풀어서 숫자 3개로. 틀리면 null
  function parseTile(urlText) {
    let u;
    try {
      u = new URL(String(urlText));
    } catch (e) {
      return null;
    }
    if (u.protocol !== 'pvm:' || u.hostname !== 'tile') return null;
    if (u.username || u.password || u.port || u.search || u.hash) return null;
    const parts = u.pathname.split('/'); // '/5/27/12' → ['', '5', '27', '12']
    if (parts.length !== 4 || parts[0] !== '') return null;
    const [zs, xs, ys] = parts.slice(1);
    if (!Z_PATTERN.test(zs) || !XY_PATTERN.test(xs) || !XY_PATTERN.test(ys)) return null;
    const z = Number(zs);
    const x = Number(xs);
    const y = Number(ys);
    if (z > 19) return null;
    const size = 2 ** z; // 이 줌에서 가로·세로 칸 수
    if (x >= size || y >= size) return null;
    return { z, x, y };
  }

  async function tile(urlText) {
    const t = parseTile(urlText);
    if (!t) return NOT_FOUND;

    const url = tileTemplate().replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': userAgent, Accept: 'image/png' },
        redirect: 'error', // 다른 주소로 넘기는 응답은 따라가지 않고 실패로 봐요
        signal: AbortSignal.timeout(TILE_TIMEOUT_MS),
      });
      if (!res.ok) {
        report('tile', `HTTP ${res.status}`);
        return BAD_GATEWAY;
      }
      const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (type !== 'image/png') {
        report('tile', 'type');
        return BAD_GATEWAY;
      }
      // 크기가 미리 보이면 받기 전에 걸러요
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_TILE_BYTES) {
        report('tile', 'size');
        return BAD_GATEWAY;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_TILE_BYTES) {
        report('tile', 'size');
        return BAD_GATEWAY;
      }
      return { status: 200, buffer, type: 'image/png' };
    } catch (e) {
      // 오류 메시지에는 주소가 들어 있을 수 있어서 코드나 이름만 남겨요
      report('tile', (e && (e.code || (e.cause && e.cause.code) || e.name)) || 'error');
      return BAD_GATEWAY;
    }
  }

  return { tile };
}

module.exports = { createMapNet };

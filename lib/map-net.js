// 파일 위치: lib/map-net.js
// 역할: 지도 그림과 장소 검색을 인터넷에서 받아 오는 곳 (docs/superpowers/specs/2026-11-02-map-pick-design.md 4절 "인터넷 연결 규칙")
//   - 이 앱에서 인터넷으로 나가는 곳은 여기뿐이에요. 화면은 직접 나가지 않고 pvm://tile/<z>/<x>/<y> 나 IPC 로만 요청해요
//   - 나가는 것은 지도 번호(z, x, y), 사용자가 적은 검색어, 앱 이름표(User-Agent)뿐이에요. 사진, 파일 이름, 폴더 경로, 좌표 목록은 나가지 않아요
//   - 모양이 틀린 주소는 나가기 전에 바로 404예요
//   - 실패해도 자동으로 다시 시도하지 않아요 (사용자가 지도를 다시 움직이거나 검색을 다시 누를 때만 다시 보내요)
//   - 로그에는 HTTP 상태나 오류 코드, 설정 키 이름만 남겨요. 설정 주소 값과 검색어는 남기지 않아요
//   - 장소 검색은 검색 서버 정책에 맞춰요: 동시에 하나만, 보내는 사이 1초 이상, 같은 검색어는 저장해 둔 결과 (100개까지)
//   - Electron은 쓰지 않아요 (lib/ 규칙). fetch 는 밖에서 받아서 써요 (gallery-main.js 가 net.fetch 를 넘겨요)
//
// 모양: createMapNet({ fetchImpl, getSettings, version, onError, nowMs, wait }) → { tile(urlText), search(query) }
//   tile → { status: 200, buffer, type: 'image/png' } | { status: 404 } | { status: 502 }
//   search → Promise<{ name, lat, lng }[]> (0건이면 []). 거절과 실패는 사람이 읽을 글자의 Error
//   onError(where, code): where는 정해진 글자('tile', 'search', 'mapTileUrl', 'placeSearchUrl'), code는 'HTTP 429' 같은 상태나 오류 코드뿐
//   wait(ms): 기다리는 함수. 기본은 진짜 setTimeout. 점검에서는 가짜 시계와 함께 가짜를 넘겨요

const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEFAULT_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const PROJECT_URL = 'https://github.com/gwhong-dev/photo-video-manager';
const TILE_TIMEOUT_MS = 10 * 1000; // 지도 그림 제한시간 10초
const SEARCH_TIMEOUT_MS = 15 * 1000; // 장소 검색 제한시간 15초
const SEARCH_GAP_MS = 1000; // 검색 요청 사이 최소 간격
const SEARCH_RESULT_LIMIT = 5; // 한 번에 받는 결과 수
const MAX_QUERY_CHARS = 200; // 검색어는 1~200자
const MAX_CACHED_QUERIES = 100; // 저장해 두는 검색어 수
const MAX_TILE_BYTES = 2 * 1024 * 1024; // 2MB 넘는 그림은 받지 않아요
const LOG_INTERVAL_MS = 60 * 1000; // 같은 종류의 실패 로그는 60초에 한 번만
const TILE_PAUSE_MS = 60 * 1000; // 지도 서버가 그만 보내라고 하면(429, 403) 60초 쉬어요

const Z_PATTERN = /^(0|[1-9][0-9]?)$/; // 맨 앞 0 없는 정수
const XY_PATTERN = /^(0|[1-9][0-9]{0,6})$/; // 2^19 = 524288 이 가장 큰 칸 수라 일곱 자리면 충분해요
const SEARCH_FAIL_TEXT = '장소를 찾지 못했어요. 잠시 뒤 다시 눌러 주세요.';
const BAD_QUERY_TEXT = '검색어는 1자부터 200자까지 적어 주세요.';
const NOT_FOUND = { status: 404 };
const BAD_GATEWAY = { status: 502 };

// 로그에 남길 오류 이름. DOMException(제한시간)의 code는 숫자 23이라, 글자로 된 코드가 없으면 이름(TimeoutError)을 써요
function errorName(e) {
  if (!e) return 'error';
  if (typeof e.code === 'string') return e.code;
  return (e.cause && e.cause.code) || e.name || 'error';
}

// 기본 기다리기: 진짜로 ms 만큼 기다려요
const realWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createMapNet({ fetchImpl, getSettings, version, onError, nowMs = Date.now, wait = realWait }) {
  const userAgent = `photo-video-manager/${version} (${PROJECT_URL})`;
  const lastLogAt = new Map(); // 로그 종류 → 마지막으로 남긴 시각
  const searchCache = new Map(); // 검색어 → 결과. 넣은 순서가 곧 오래된 순서예요
  let searchQueue = Promise.resolve(); // 검색을 한 줄로 세우는 사슬
  let lastSearchAt; // 마지막으로 검색 요청을 보낸 시각
  let tilePausedUntil = 0; // 이 시각까지는 지도 서버에 요청하지 않아요

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

  // 설정에서 주소를 읽어요. 비었으면 조용히 기본값, 잘못됐으면 기본값 + 키 이름만 로그
  // isValid(value): https 로 시작하는 글자가 더 쓸 만한지 알려 주는 함수
  function settingUrl(key, defaultUrl, isValid) {
    let value;
    try {
      const s = getSettings ? getSettings() : null;
      value = s && s[key];
    } catch (e) {
      return defaultUrl;
    }
    if (value === undefined || value === null || value === '') return defaultUrl;
    if (typeof value !== 'string' || !value.startsWith('https://') || !isValid(value)) {
      report(key, 'invalid');
      return defaultUrl;
    }
    return value;
  }

  // 지도 주소 틀: https 이고 {z}, {x}, {y} 가 다 있어야 해요
  function tileTemplate() {
    return settingUrl('mapTileUrl', DEFAULT_TILE_URL, (v) => ['{z}', '{x}', '{y}'].every((k) => v.includes(k)));
  }

  // 검색 주소: https 이고 주소로 읽혀야 해요
  function searchBase() {
    return settingUrl('placeSearchUrl', DEFAULT_SEARCH_URL, (v) => {
      try {
        return new URL(v).protocol === 'https:';
      } catch (e) {
        return false;
      }
    });
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
    if (nowMs() < tilePausedUntil) return BAD_GATEWAY; // 서버가 막는 동안 지도를 끌어도 더 보내지 않아요

    const url = tileTemplate().replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y);
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': userAgent, Accept: 'image/png' },
        redirect: 'error', // 다른 주소로 넘기는 응답은 따라가지 않고 실패로 봐요
        signal: AbortSignal.timeout(TILE_TIMEOUT_MS),
      });
      if (!res.ok) {
        report('tile', `HTTP ${res.status}`);
        if (res.status === 429 || res.status === 403) tilePausedUntil = nowMs() + TILE_PAUSE_MS;
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
      report('tile', errorName(e));
      return BAD_GATEWAY;
    }
  }

  // ---------- 장소 검색 ----------

  // 위도·경도 값 하나를 숫자로. 숫자나 숫자 글자만 받고, 범위 밖이면 null (null이나 빈 글자가 0이 되지 않게)
  function toCoord(value, limit) {
    let n;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
    else return null;
    return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
  }

  // 서버 응답에서 { name, lat, lng } 만 남겨요. 좌표가 이상한 줄은 버려요
  function toPlaces(rows) {
    const places = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const lat = toCoord(row.lat, 90);
      const lng = toCoord(row.lon, 180);
      if (lat === null || lng === null) continue;
      places.push({ name: typeof row.display_name === 'string' ? row.display_name : '', lat, lng });
      if (places.length >= SEARCH_RESULT_LIMIT) break;
    }
    return places;
  }

  // 서버에 한 번 물어봐요. 실패하면 로그(코드만)를 남기고 정해진 문장으로 거절해요
  async function fetchPlaces(query) {
    // 마지막 요청에서 1초가 지나도록 기다려요 (타이머가 조금 일찍 깨도 괜찮게 몇 번 확인)
    for (let i = 0; i < 3 && lastSearchAt !== undefined; i++) {
      const gap = nowMs() - lastSearchAt;
      if (gap >= SEARCH_GAP_MS || gap < 0) break; // 시계가 거꾸로 갔으면 기다리지 않아요
      await wait(SEARCH_GAP_MS - gap);
    }
    lastSearchAt = nowMs(); // 실패해도 보낸 것으로 쳐요

    const u = new URL(searchBase());
    u.searchParams.set('q', query);
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('limit', String(SEARCH_RESULT_LIMIT));
    u.searchParams.set('accept-language', 'ko');
    try {
      const res = await fetchImpl(u.toString(), {
        headers: { 'User-Agent': userAgent, Accept: 'application/json' },
        cache: 'no-store', // 검색어가 든 주소가 디스크 캐시에 남지 않게 해요
        redirect: 'error', // 다른 주소로 넘기는 응답은 따라가지 않고 실패로 봐요
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        report('search', `HTTP ${res.status}`);
        throw new Error(SEARCH_FAIL_TEXT);
      }
      let rows;
      try {
        rows = await res.json();
      } catch (e) {
        report('search', 'json');
        throw new Error(SEARCH_FAIL_TEXT);
      }
      if (!Array.isArray(rows)) {
        report('search', 'shape');
        throw new Error(SEARCH_FAIL_TEXT);
      }
      return toPlaces(rows);
    } catch (e) {
      if (e && e.message === SEARCH_FAIL_TEXT) throw e; // 위에서 이미 로그를 남긴 것
      // 오류 메시지에는 주소(검색어 포함)가 들어 있을 수 있어서 코드나 이름만 남겨요
      report('search', errorName(e));
      throw new Error(SEARCH_FAIL_TEXT);
    }
  }

  // 줄 앞에서 차례가 되면: 저장해 둔 결과가 있으면 그대로, 없으면 서버에 물어보고 저장해요
  async function runSearch(query) {
    if (searchCache.has(query)) return searchCache.get(query).map((p) => ({ ...p }));
    const places = await fetchPlaces(query); // 실패하면 여기서 끝나서 저장하지 않아요
    searchCache.set(query, places);
    if (searchCache.size > MAX_CACHED_QUERIES) searchCache.delete(searchCache.keys().next().value); // 가장 오래된 것
    return places.map((p) => ({ ...p }));
  }

  // 검색어 1~200자(앞뒤 공백 뺀 뒤). 잘못되면 서버에 나가기 전에 거절해요
  function search(rawQuery) {
    const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
    const length = Array.from(query).length;
    if (length < 1 || length > MAX_QUERY_CHARS) return Promise.reject(new Error(BAD_QUERY_TEXT));
    const result = searchQueue.then(() => runSearch(query));
    searchQueue = result.catch(() => {}); // 앞 검색이 실패해도 다음 검색은 이어서 해요
    return result;
  }

  return { tile, search };
}

module.exports = { createMapNet };

// 파일 위치: src/places-view.mjs
// 역할: 지도 화면(단계 6)의 계산. 화면(React, Leaflet) 없이 점검에서 바로 불러 써요 (점검 42)
//   - 위치가 있는 사진을 확대 정도에 맞춰 숫자 핀으로 묶기 (아이폰 "장소"처럼, 인터넷은 쓰지 않아요)
//   - 연도 탭, 묶음 요약(장수, 찍은 기간, 최근 사진 9장), 갤러리로 넘길 영역
//
// 묶는 방법: 세계 지도를 확대 정도별로 같은 크기(CELL 화면 점)의 칸으로 나누고, 같은 칸의 사진을 한 묶음으로 봐요.
//   칸 경계에 걸친 동네가 두 핀으로 갈라져 겹쳐 보이지 않게, 가까운 이웃 칸의 핀은 큰 핀에 합쳐요.
//   묶음의 영역은 칸들의 사각형 목록이라, 갤러리의 "그 곳 사진" 개수가 핀의 숫자와 똑같아요 (lib/db.js 지도 영역 필터)

export const CELL = 80; // 칸 크기 (화면 점). 핀 지름보다 넉넉하게
export const TILE = 256; // 지도 칸 그림 한 장의 크기 (Leaflet 기본)
const MAX_LAT = 85.0511287798; // 메르카토르 지도의 끝 위도
export const PANEL_THUMBS = 9; // 오른쪽 패널에 보여 줄 사진 수

const clampLat = (lat) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

// 위도 · 경도 → 그 확대 정도의 세계 지도 위 점 (Leaflet의 map.project 와 같은 값)
export function project(lat, lng, zoom) {
  const size = TILE * 2 ** zoom;
  const sin = Math.sin((clampLat(lat) * Math.PI) / 180);
  const x = ((lng + 180) / 360) * size;
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size;
  return { x, y };
}

// 세계 지도 위 점 → 위도 · 경도
export function unproject(x, y, zoom) {
  const size = TILE * 2 ** zoom;
  const lng = (x / size) * 360 - 180;
  const lat = ((2 * Math.atan(Math.exp(Math.PI * (1 - (2 * y) / size))) - Math.PI / 2) * 180) / Math.PI;
  return { lat, lng };
}

// 칸 번호 → 그 칸의 사각형 { s, w, n, e }. 맨 끝 칸은 지도 밖까지 넓혀서 극지방이나 경도 180도 사진도 빠지지 않게 해요
export function cellRect(col, row, zoom, cell = CELL) {
  const count = Math.ceil((TILE * 2 ** zoom) / cell); // 한 줄의 칸 수
  const nw = unproject(col * cell, row * cell, zoom);
  const se = unproject((col + 1) * cell, (row + 1) * cell, zoom);
  return {
    s: row >= count - 1 ? -91 : se.lat,
    w: col <= 0 ? -181 : nw.lng,
    n: row <= 0 ? 91 : nw.lat,
    e: col >= count - 1 ? 181 : se.lng,
  };
}

// 점이 칸 사각형 안에 있는지 (lib/db.js 와 같은 규칙: s < 위도 <= n, w <= 경도 < e)
export const inRect = (r, lat, lng) => lat > r.s && lat <= r.n && lng >= r.w && lng < r.e;

// 점 하나가 들어가는 칸 번호. 사각형 규칙과 어긋나지 않게, 경계에 아주 가까우면 사각형으로 다시 확인해요
function cellOf(lat, lng, zoom, cell) {
  const count = Math.ceil((TILE * 2 ** zoom) / cell);
  const p = project(lat, lng, zoom);
  let col = Math.min(count - 1, Math.max(0, Math.floor(p.x / cell)));
  let row = Math.min(count - 1, Math.max(0, Math.floor(p.y / cell)));
  // 소수 계산의 아주 작은 차이로 옆 칸 사각형에 들어가는 경우를 바로잡아요 (위아래 · 좌우 한 칸만 보면 충분해요)
  if (!inRect(cellRect(col, row, zoom, cell), lat, lng)) {
    for (const [dc, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= count || r >= count) continue;
      if (inRect(cellRect(c, r, zoom, cell), lat, lng)) {
        col = c;
        row = r;
        break;
      }
    }
  }
  return { col, row };
}

// 화면에서 받은 위치 목록 [[id, 위도, 경도, 찍은 날], ...] → { id, lat, lng, day } (숫자가 아니면 버려요)
export function toPoints(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const [id, lat, lng, day] = r;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    out.push({ id, lat, lng, day: typeof day === 'string' ? day : null });
  }
  return out;
}

// 연도 탭: 위치가 있는 사진의 연도 (최근 해부터). 날짜 없는 사진은 "전체 기간"에만 들어가요
export function yearsOf(points) {
  const set = new Set();
  for (const p of points) if (p.day) set.add(Number(p.day.slice(0, 4)));
  return [...set].filter(Number.isInteger).sort((a, b) => b - a);
}

export const byYear = (points, year) => (year ? points.filter((p) => p.day && Number(p.day.slice(0, 4)) === year) : points);

const inBox = (b, p) => p.lat >= b.s && p.lat <= b.n && p.lng >= b.w && p.lng <= b.e;
const inBounds = (bounds, p) => (Array.isArray(bounds) ? bounds.some((b) => inBox(b, p)) : inBox(bounds, p));

// 묶기. bounds = { s, w, n, e } 또는 그 목록을 주면 그 안(조금 넉넉히)의 사진만 묶어요 (화면 밖은 계산하지 않게)
//   돌려주는 묶음: { key, count, lat, lng (핀 자리 = 사진들의 평균), rects (영역), members (사진 목록) } — 큰 묶음부터
export function clusterPoints(points, zoom, { cell = CELL, bounds = null } = {}) {
  const z = Math.max(0, Math.round(zoom));
  const cells = new Map();
  for (const p of points) {
    if (bounds && !inBounds(bounds, p)) continue;
    const { col, row } = cellOf(p.lat, p.lng, z, cell);
    const key = `${z}/${col}/${row}`;
    let c = cells.get(key);
    if (!c) {
      c = { key, col, row, members: [], sumLat: 0, sumLng: 0 };
      cells.set(key, c);
    }
    c.members.push(p);
    c.sumLat += p.lat;
    c.sumLng += p.lng;
  }
  // 핀 자리 (화면 점)
  const list = [...cells.values()].map((c) => {
    const lat = c.sumLat / c.members.length;
    const lng = c.sumLng / c.members.length;
    return { ...c, lat, lng, at: project(lat, lng, z) };
  });
  // 큰 칸부터, 이웃 8칸의 핀이 한 칸 크기보다 가까우면 합쳐요 (한 번만: 합친 묶음끼리는 다시 합치지 않아요)
  list.sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key));
  const byKey = new Map(list.map((c) => [c.key, c]));
  const taken = new Set();
  const out = [];
  for (const c of list) {
    if (taken.has(c.key)) continue;
    taken.add(c.key);
    const group = [c];
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (!dc && !dr) continue;
        const n = byKey.get(`${z}/${c.col + dc}/${c.row + dr}`);
        if (!n || taken.has(n.key)) continue;
        if (Math.hypot(n.at.x - c.at.x, n.at.y - c.at.y) < cell) {
          taken.add(n.key);
          group.push(n);
        }
      }
    }
    const members = group.flatMap((g) => g.members);
    const lat = members.reduce((s, p) => s + p.lat, 0) / members.length;
    const lng = members.reduce((s, p) => s + p.lng, 0) / members.length;
    out.push({
      key: c.key,
      count: members.length,
      lat,
      lng,
      named: nameSpot(lat, lng), // 이름을 물을 자리 (0.1도 눈금이라 연도 · 다시 읽기가 바뀌어도 거의 그대로)
      rects: group.map((g) => cellRect(g.col, g.row, z, cell)),
      members,
    });
  }
  // 합치면 장수가 바뀌어서 큰 묶음부터 다시 줄 세워요 (많이 찍은 곳, 이름 붙일 큰 핀이 이 순서를 써요, #56 검증)
  out.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return out;
}

// 이름을 물을 자리: 묶음의 사진 평균 좌표를 0.1도(약 10km) 눈금에 맞춘 곳.
//   평균 좌표를 그대로 물으면 연도 탭이나 다시 읽기마다 좌표가 조금씩 달라져 새 요청이 나가요 (#56 검증: 6만 장에서 최대 681개).
//   눈금에 맞추면 같은 동네는 같은 열쇠가 되고, 서버로 가는 좌표도 덜 자세해요 (칸 가운데를 쓰면 사진과 멀어져 이웃 도시 이름이 나와서 평균을 써요)
export const NAME_GRID = 0.1;
const snap = (v) => Math.round(v / NAME_GRID) * NAME_GRID;
export function nameSpot(atLat, atLng) {
  const lat = Math.max(-85, Math.min(85, snap(atLat)));
  let lng = snap(atLng);
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;
  return { lat: Number(lat.toFixed(1)), lng: Number(lng.toFixed(1)) };
}

// 오른쪽 패널에 보일 묶음 요약: 장수, 찍은 기간, 최근 사진 9장 id, 갤러리로 넘길 영역 (연도 탭이 골라져 있으면 그 해만)
export function summarize(cluster, year = null) {
  const days = cluster.members.map((p) => p.day).filter(Boolean).sort();
  const recent = [...cluster.members]
    .sort((a, b) => (b.day || '').localeCompare(a.day || '') || b.id - a.id)
    .slice(0, PANEL_THUMBS)
    .map((p) => p.id);
  return {
    key: cluster.key,
    count: cluster.count,
    first: days[0] || null,
    last: days[days.length - 1] || null,
    recent,
    area: { rects: cluster.rects, year: year || null },
  };
}

// 찍은 기간 글: "2019년 3월부터 2026년 10월까지", 같은 달이면 "2026년 10월", 날짜가 없으면 "찍은 날짜 없음"
export function rangeText(first, last) {
  const ym = (d) => `${Number(d.slice(0, 4))}년 ${Number(d.slice(5, 7))}월`;
  if (!first || !last) return '찍은 날짜 없음';
  const a = ym(first);
  const b = ym(last);
  return a === b ? a : `${a}부터 ${b}까지`;
}

// 핀 크기: 숫자 자리수에 맞춰 (지름 화면 점)
export const pinSize = (count) => 28 + 6 * Math.min(4, String(count).length - 1);

// 숫자 핀 글자 (1,280)
export const countText = (n) => n.toLocaleString('en-US');

// ---------- 단계 6-2: 핀 이름, 많이 찍은 곳, 해외 나라 ----------

export const TOP_PLACES = 5; // "사진을 많이 찍은 곳" 줄 수
export const TOP_ZOOM = 9; // 많이 찍은 곳은 이 확대 단계(시 · 군 정도)의 묶음으로 세요
export const COUNTRY_ZOOM = 5; // 해외 나라는 이 확대 단계의 묶음 가운데 좌표로 나라를 알아봐요 (나라 경계 근처는 어림이에요)
export const NAMED_PINS = 5; // 화면에 보이는 핀 중 이름을 붙일 큰 핀 수

// 이름 저장 열쇠 (main 의 gallery:map-place 와 같은 줄임: 소수점 2자리)
export const cityKey = (lat, lng) => `${(Math.round(lat * 100) / 100).toFixed(2)},${(Math.round(lng * 100) / 100).toFixed(2)}`;

// 많이 찍은 곳: TOP_ZOOM 묶음 중 큰 것부터 n개 → [{ key, count, lat, lng, cluster }]
export function topPlaces(points, n = TOP_PLACES, zoom = TOP_ZOOM) {
  return clusterPoints(points, zoom).slice(0, n).map((c) => ({ key: c.key, count: c.count, lat: c.lat, lng: c.lng, named: c.named, cluster: c }));
}

// 해외 나라 칩: COUNTRY_ZOOM 묶음마다 이름표(나라)를 찾아 나라별로 장수를 더해요. 한국과 아직 모르는 나라는 빼요
//   places(lat, lng) → { name, country, cc } 또는 null. 돌려주는 값: [{ cc, country, count, box: { s, w, n, e } }] (많은 순)
export function countryChips(clusters, places) {
  const by = new Map();
  for (const c of clusters) {
    const at = c.named || c;
    const p = places(at.lat, at.lng);
    if (!p || !p.cc || p.cc === 'kr' || !p.country) continue;
    let x = by.get(p.cc);
    if (!x) {
      x = { cc: p.cc, country: p.country, count: 0, box: { s: 90, w: 180, n: -90, e: -180 } };
      by.set(p.cc, x);
    }
    x.count += c.count;
    for (const m of c.members) {
      x.box.s = Math.min(x.box.s, m.lat);
      x.box.n = Math.max(x.box.n, m.lat);
      x.box.w = Math.min(x.box.w, m.lng);
      x.box.e = Math.max(x.box.e, m.lng);
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.country.localeCompare(b.country));
}

// 지도 화면의 경도 구간 → 묶을 범위 목록. 지구 복사본을 넘겨 본 화면(경도가 ±180 밖)은 두 구간으로 나눠요 (#55 검증: 전 세계를 묶지 않게)
//   west, east 는 Leaflet 이 주는 그대로(±180 밖일 수 있음). 화면이 지구 한 바퀴보다 넓으면 null (전부)
export function viewRanges(s, w, n, e) {
  if (e - w >= 360) return null;
  const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
  const a = wrap(w);
  const b = wrap(e);
  if (a <= b) return [{ s, w: a, n, e: b }];
  return [{ s, w: a, n, e: 180 }, { s, w: -180, n, e: b }];
}

export const MAX_PINS = 1500; // 한 번에 그리는 핀 수 상한 (큰 묶음부터)

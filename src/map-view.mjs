// 파일 위치: src/map-view.mjs
// 역할: 지도 창의 순수 계산 (React와 Leaflet이 없어서 점검에서 바로 불러올 수 있어요)
//   pinFrom    : 지도 좌표를 저장할 값으로 바꿔요 (경도 감기, 소수점 6자리)
//   nextPin    : 넣는 중에는 핀을 바꾸지 않아요
//   createTileBoard: 지도 칸 가운데 어느 것이 떠 있는지 기억해요 (Leaflet의 tileload·tileunload 이벤트로 채워요)
//   tileCoordsAt: 지도 위 픽셀 자리 → 그 자리를 덮는 칸 번호
//   canPlacePin: 누른 자리에 그림이 떠 있을 때만 핀을 놓을 수 있어요
//   nearLng    : 핀을 지금 보고 있는 지구 복사본 위에 그릴 경도를 구해요
//   createLatest: 가장 최근 요청만 살려 두는 번호표 (늦게 온 옛 검색 응답을 버려요)

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// 경도를 -180 이상 180 미만으로 감아요. 지도를 옆으로 돌리면 190도 같은 값이 나오는데, main은 범위 밖을 거절해요
function wrapLng(lng) {
  return ((lng + 180) % 360 + 360) % 360 - 180;
}

// 지도에서 나온 좌표 → 저장할 { lat, lng }
export function pinFrom(lat, lng) {
  return {
    lat: round6(Math.max(-90, Math.min(90, lat))),
    lng: round6(wrapLng(lng)),
  };
}

// 핀의 다음 값. disabled(넣는 중)이면 지금 값을 그대로 돌려줘요
export function nextPin(current, candidate, disabled) {
  return disabled ? current : candidate;
}

// 떠 있는 지도 칸의 번호표. Leaflet이 칸을 띄우면 loaded, 치우면 gone으로 알려 줘요
//   칸 번호는 Leaflet의 coords({ x, y, z })를 그대로 써요. 지구 복사본마다 x가 달라서 감지 않아요
export function createTileBoard() {
  const shown = new Set();
  const key = (c) => `${c.x}:${c.y}:${c.z}`;
  return {
    loaded(coords) { shown.add(key(coords)); },
    gone(coords) { shown.delete(key(coords)); },
    has(coords) { return shown.has(key(coords)); },
    count() { return shown.size; },
  };
}

// 지도 위 픽셀 자리(map.project로 구한 { x, y })를 덮는 칸 번호. 칸 한 변은 보통 256픽셀이에요
export function tileCoordsAt(point, zoom, tileSize = 256) {
  return { x: Math.floor(point.x / tileSize), y: Math.floor(point.y / tileSize), z: zoom };
}

// 확대·축소 직후에는 새 칸이 오기 전까지 Leaflet이 이전 단계의 칸을 늘려서 보여 줘요 (최대 5단계 위까지)
const PARENT_LEVELS = 5;

// 누른 자리에 핀을 놓아도 되는지. 그 자리를 덮는 칸(또는 늘려서 보여 주는 윗단계 칸)이 떠 있어야 어디를 누르는지 알 수 있어요
//   화면에 다른 칸이 떠 있어도 누른 자리가 비어 있으면 막고, 다른 칸이 실패했어도 누른 자리가 보이면 허용해요
export function canPlacePin(board, coords) {
  let { x, y, z } = coords;
  for (let up = 0; up <= PARENT_LEVELS; up++) {
    if (board.has({ x, y, z })) return true;
    if (z <= 0) return false;
    x = Math.floor(x / 2);
    y = Math.floor(y / 2);
    z -= 1;
  }
  return false;
}

// 지도는 옆으로 끝없이 이어져요. 값은 감겨 있어도 핀은 보고 있는 쪽에 그려야 화면에서 사라지지 않아요
export function nearLng(lng, centerLng) {
  return lng + 360 * Math.round((centerLng - lng) / 360);
}

// 번호표: next()로 새 번호를 받고, 응답이 오면 isCurrent()로 아직 최신인지 봐요. cancel()은 창을 닫을 때 써요
export function createLatest() {
  let current = 0;
  return {
    next() {
      const mine = ++current;
      return { isCurrent: () => mine === current };
    },
    cancel() {
      current++;
    },
  };
}

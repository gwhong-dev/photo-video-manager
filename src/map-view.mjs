// 파일 위치: src/map-view.mjs
// 역할: 지도 창의 순수 계산 (React와 Leaflet이 없어서 점검에서 바로 불러올 수 있어요)
//   pinFrom    : 지도 좌표를 저장할 값으로 바꿔요 (경도 감기, 소수점 6자리)
//   nextPin    : 넣는 중에는 핀을 바꾸지 않아요
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

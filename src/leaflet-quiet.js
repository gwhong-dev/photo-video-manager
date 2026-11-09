// 파일 위치: src/leaflet-quiet.js
// 역할: 지도 칸 그림 층 (지도에서 위치 고르기 창과 지도 화면이 같이 써요)
import L from 'leaflet';

// Leaflet은 안 쓰는 지도 칸을 치울 때 src에 data: 그림을 넣어서 받던 것을 끊어요.
//   그런데 이 앱의 화면 보안 설정(CSP)은 data: 그림을 막아서 오류가 쌓여요. 설정은 바꾸지 않고, src를 지워서 똑같이 끊어요
//   아래 두 함수는 Leaflet 1.9.4의 같은 이름 함수에서 그 줄만 바꾼 것이에요 (버전은 package.json에 고정. 어긋나면 점검 35k가 알려 줘요)
export const QuietTileLayer = L.TileLayer.extend({
  _abortLoading() {
    for (const key of Object.keys(this._tiles)) {
      const { el, coords } = this._tiles[key];
      if (coords.z === this._tileZoom) continue;
      el.onload = L.Util.falseFn;
      el.onerror = L.Util.falseFn;
      if (!el.complete) {
        el.removeAttribute('src');
        L.DomUtil.remove(el);
        delete this._tiles[key];
        this.fire('tileabort', { tile: el, coords });
      }
    }
  },
  _removeTile(key) {
    const tile = this._tiles[key];
    if (!tile) return undefined;
    tile.el.removeAttribute('src');
    return L.GridLayer.prototype._removeTile.call(this, key);
  },
});

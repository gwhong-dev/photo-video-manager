// 파일 위치: src/components/MapView.jsx
// 역할: 지도 화면 (단계 6). 위치가 있는 사진을 숫자 핀으로 묶어 보여 주고, 핀을 누르면 오른쪽 패널(MapPanel)에 그 곳 사진이 나와요
//   묶기 계산은 src/places-view.mjs (인터넷 안 씀). 지도 그림은 pvm://tile 로만 받아요 (화면이 직접 인터넷에 나가지 않아요)
//   지도는 색을 빼고(그림 층에 흑백 필터) 숫자 핀만 또렷하게 (Figma "지도")
//   위쪽: 연도 탭 / 아래 오른쪽: 장소가 없는 사진 → 정보 없는 사진 화면 / 지도를 못 받아도 핀은 그대로 보여요

import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api, errorText } from '../api.js';
import { QuietTileLayer } from '../leaflet-quiet.js';
import { nearLng } from '../map-view.mjs';
import { byYear, clusterPoints, countText, pinSize, summarize, toPoints, yearsOf } from '../places-view.mjs';

const KOREA = { center: [36.5, 127.8], zoom: 7 }; // 위치가 있는 사진이 없을 때 처음 위치
const FIT_MAX_ZOOM = 12; // 처음에 사진들이 다 보이게 맞출 때 너무 가까이 가지 않게
const MAP_ERROR = '지도를 불러오지 못했어요. 인터넷 연결을 확인해 주세요. 핀은 그대로 볼 수 있어요.';

// viewRef = { center, zoom, year } 지도 화면을 다시 열 때 이어서 보여 줄 곳 (App이 들고 있어요)
// picked = 고른 묶음 요약 (MapPanel과 같이 써요), onPick(요약 또는 null), onLoaded(위치가 있는 사진 수)
export default function MapView({ gen, noLocation, picked, onPick, onLoaded, onGoMissing, viewRef }) {
  const holderRef = useRef(null);
  const mapRef = useRef(null);
  const pinsRef = useRef(null); // 핀 층
  const fittedRef = useRef(!!viewRef.current.center); // 처음 한 번 사진들이 다 보이게 맞췄는지
  const [points, setPoints] = useState(null); // null = 받는 중
  const [error, setError] = useState('');
  const [year, setYear] = useState(viewRef.current.year || null);
  const [mapFailed, setMapFailed] = useState(false);

  // Leaflet 이벤트는 처음 만들 때 한 번만 묶어서, 늘 최신 값을 여기서 읽어요
  const latest = useRef(null);
  latest.current = { points, year, picked, onPick };

  // ---------- 위치 목록 받기 ----------
  useEffect(() => {
    let alive = true;
    api.mapPoints().then(
      (rows) => {
        if (!alive) return;
        const list = toPoints(rows);
        setPoints(list);
        setError('');
        onLoaded(list.length);
      },
      (e) => { if (alive) setError(errorText(e)); },
    );
    return () => { alive = false; };
  }, [gen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 핀 그리기 ----------
  const draw = () => {
    const map = mapRef.current;
    const layer = pinsRef.current;
    const { points: all, year: y, picked: pick } = latest.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (!all || !all.length) return;
    const zoom = Math.round(map.getZoom());
    // 화면 안(조금 넉넉히)만 묶어요. 지구 복사본을 넘겨 본 때(경도가 ±180 밖)는 전부 계산해요
    const b = map.getBounds().pad(0.3);
    const inside = b.getWest() >= -180 && b.getEast() <= 180;
    const bounds = inside ? { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() } : null;
    const centerLng = map.getCenter().lng;
    for (const c of clusterPoints(byYear(all, y), zoom, { bounds })) {
      const size = pinSize(c.count);
      const icon = L.divIcon({
        className: `place-pin${pick && pick.key === c.key ? ' on' : ''}`,
        html: `<span>${countText(c.count)}</span>`,
        iconSize: [size, size],
      });
      const marker = L.marker([c.lat, nearLng(c.lng, centerLng)], { icon, title: `${countText(c.count)}장`, keyboard: true, riseOnHover: true });
      marker.on('click', () => latest.current.onPick(summarize(c, latest.current.year)));
      marker.addTo(layer);
    }
  };

  // ---------- 지도 만들기 (화면이 열릴 때 한 번) ----------
  useEffect(() => {
    const saved = viewRef.current;
    const map = L.map(holderRef.current, {
      center: saved.center || KOREA.center,
      zoom: saved.zoom || KOREA.zoom,
      attributionControl: false,
      zoomControl: false,
      worldCopyJump: true,
      maxZoom: 19,
      minZoom: 2,
    });
    mapRef.current = map;
    L.control.zoom({ position: 'topright', zoomInTitle: '크게 보기', zoomOutTitle: '작게 보기' }).addTo(map);
    const tiles = new QuietTileLayer('pvm://tile/{z}/{x}/{y}', { maxZoom: 19, bounds: [[-85.06, -180], [85.06, 180]] });
    tiles.on('tileerror', (e) => {
      setMapFailed(true);
      // 실패한 칸을 치워 두면 사용자가 지도를 움직일 때 다시 받아요 (가만히 있으면 되풀이하지 않아요)
      tiles._removeTile(tiles._tileCoordsToKey(e.coords));
    });
    tiles.on('tileload', () => setMapFailed(false));
    tiles.addTo(map);
    pinsRef.current = L.layerGroup().addTo(map);
    map.on('moveend', () => {
      viewRef.current = { ...viewRef.current, center: map.getCenter(), zoom: map.getZoom() };
      draw();
    });
    const watcher = new ResizeObserver(() => map.invalidateSize());
    watcher.observe(holderRef.current);
    return () => {
      watcher.disconnect();
      map.remove();
      mapRef.current = null;
      pinsRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 처음 받았을 때 사진들이 다 보이게 맞추고, 그다음부터는 목록 · 연도 · 고른 핀이 바뀔 때마다 다시 그려요
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !points) return;
    if (!fittedRef.current && points.length) {
      fittedRef.current = true;
      const box = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
      map.fitBounds(box, { padding: [48, 48], maxZoom: FIT_MAX_ZOOM, animate: false });
      return; // fitBounds가 moveend로 다시 그려요
    }
    draw();
  }, [points, year, picked]); // eslint-disable-line react-hooks/exhaustive-deps

  const years = points ? yearsOf(points) : [];
  const chooseYear = (y) => {
    if (y === year) return;
    setYear(y);
    viewRef.current = { ...viewRef.current, year: y };
    onPick(null); // 다른 해의 묶음은 숫자가 달라서 고른 것을 풀어요
  };

  return (
    <div className="map-view">
      <div ref={holderRef} className="map-canvas map-view-canvas" />
      <div className="map-years" role="tablist" aria-label="찍은 해">
        <button type="button" role="tab" aria-selected={!year} className={!year ? 'on' : ''} onClick={() => chooseYear(null)}>전체 기간</button>
        {years.map((y) => (
          <button key={y} type="button" role="tab" aria-selected={year === y} className={year === y ? 'on' : ''} onClick={() => chooseYear(y)}>{y}</button>
        ))}
      </div>
      {points && points.length === 0 && !error && (
        <p className="map-empty" role="status">위치가 있는 사진이 아직 없어요. 정보 없는 사진 화면에서 위치를 넣으면 여기에 핀이 생겨요.</p>
      )}
      {error && <p className="map-error map-view-note" role="alert">사진 위치를 불러오지 못했어요. {error}</p>}
      {mapFailed && !error && <p className="map-error map-view-note" role="alert">{MAP_ERROR}</p>}
      {noLocation > 0 && (
        <div className="map-missing">
          <span>장소가 없는 사진 {countText(noLocation)}장</span>
          <button type="button" onClick={onGoMissing}>지도에 놓으러 가기</button>
        </div>
      )}
      {/* 못 열어도 지도는 그대로 쓸 수 있어서 따로 알리지 않아요 (main이 오류 로그를 남겨요) */}
      <button type="button" className="map-credit" onClick={() => api.openMapCredit().catch(() => {})}>© OpenStreetMap 기여자</button>
    </div>
  );
}

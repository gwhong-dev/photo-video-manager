// 파일 위치: src/components/MapPicker.jsx
// 역할: 지도 창의 위쪽 칸. 장소 검색, 지도, 핀, 출처 버튼, 오류 줄 (설계서 3, 6절)
//   지도를 누르거나 핀을 끌어 놓거나 검색 결과를 누를 때만 onChange로 알려요. 처음 위치에는 핀을 놓지 않아요
//   지도 그림은 pvm://tile 로만 받아요. 화면이 직접 인터넷에 나가지 않아요
//   Leaflet의 기본 출처 표시는 꺼요 (링크를 누르면 앱 창이 그 사이트로 넘어가서). 출처는 기본 브라우저로 여는 버튼이에요

import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api, errorText } from '../api.js';
import { formatCoords } from '../format.mjs';
import { canPlacePin, createLatest, createTileBoard, nearLng, pinFrom, tileCoordsAt } from '../map-view.mjs';

const KOREA = { center: [36.5, 127.8], zoom: 7 }; // 고른 곳이 없을 때 처음 위치
const START_ZOOM = 15; // 이번 실행에서 마지막으로 고른 곳을 열 때
const RESULT_ZOOM = 16; // 검색 결과를 눌렀을 때
const MAX_RESULTS = 5;

const MAP_ERROR = '지도를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.';
const CLICK_REFUSED = '지도가 보일 때 눌러 주세요. 검색 결과는 지금도 고를 수 있어요.';
const NO_RESULT = '찾은 곳이 없어요. 근처 지역을 검색한 뒤 지도에서 눌러 주세요.';
const SEARCH_HINT = '검색어는 OpenStreetMap 서버로 보내요. 이름이나 전화번호 같은 개인정보는 적지 마세요.';

// 핀은 이미지 없이 CSS로 그려요. 뾰족한 끝(12, 29)이 고른 자리예요
const PIN_ICON = L.divIcon({ className: 'map-pin', html: '<span></span>', iconSize: [24, 30], iconAnchor: [12, 29] });

// Leaflet은 안 쓰는 지도 칸을 치울 때 src에 data: 그림을 넣어서 받던 것을 끊어요.
//   그런데 이 앱의 화면 보안 설정(CSP)은 data: 그림을 막아서 오류가 쌓여요. 설정은 바꾸지 않고, src를 지워서 똑같이 끊어요
//   아래 두 함수는 Leaflet 1.9.4의 같은 이름 함수에서 그 줄만 바꾼 것이에요 (버전은 package.json에 고정. 어긋나면 점검 35k가 알려 줘요)
const QuietTileLayer = L.TileLayer.extend({
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

// value = 놓인 핀 { lat, lng, name? } 또는 null, onChange(핀): 사용자가 핀을 골랐을 때. name은 검색 결과를 눌렀을 때만 있어요
// startAt = 처음 보여 줄 곳 (없으면 대한민국 전체), disabled = 넣는 중 (핀과 검색을 막아요)
export default function MapPicker({ value, onChange, startAt, disabled }) {
  const holderRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const draggingRef = useRef(false); // 핀을 끄는 중인지
  const shownAtRef = useRef(() => false); // 그 자리에 지도 그림이 떠 있는지 (지도를 만들 때 채워요)
  const searchSeq = useRef(null); // 검색 번호표
  const [mapFailed, setMapFailed] = useState(false);
  const [clickRefused, setClickRefused] = useState(false); // 그림이 없는 지도를 눌렀을 때 안내
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState({ busy: false, results: null, error: '' });

  // Leaflet 이벤트는 처음 만들 때 한 번만 묶어서, 늘 최신 값을 여기서 읽어요
  const latest = useRef(null);
  latest.current = { value, onChange, disabled };

  // 핀을 지금 보고 있는 지구 복사본 위에 그려요 (값은 그대로)
  const drawMarker = () => {
    const map = mapRef.current;
    const marker = markerRef.current;
    const pin = latest.current.value;
    if (!map || !marker || !pin) return;
    marker.setLatLng([pin.lat, nearLng(pin.lng, map.getCenter().lng)]);
  };

  // ---------- 지도 만들기 (창이 열릴 때 한 번) ----------
  useEffect(() => {
    const start = startAt ? { center: [startAt.lat, startAt.lng], zoom: START_ZOOM } : KOREA;
    const map = L.map(holderRef.current, {
      ...start,
      attributionControl: false,
      zoomControl: false,
      worldCopyJump: true,
      maxZoom: 19,
    });
    mapRef.current = map;
    L.control.zoom({ zoomInTitle: '크게 보기', zoomOutTitle: '작게 보기' }).addTo(map);
    const board = createTileBoard(); // 지금 떠 있는 칸들
    const tiles = new QuietTileLayer('pvm://tile/{z}/{x}/{y}', { maxZoom: 19, bounds: [[-85.06, -180], [85.06, 180]] });
    tiles.on('tileerror', (e) => {
      setMapFailed(true);
      // Leaflet은 실패한 칸을 그대로 들고 있어서 조금 옮겨도 다시 받지 않아요. 치워 두면 사용자가 움직일 때 다시 받아요
      //   칸을 새로 받는 일은 지도가 움직일 때만 일어나서, 가만히 있으면 저절로 되풀이되지 않아요 (설계서 4-4)
      tiles._removeTile(tiles._tileCoordsToKey(e.coords));
    });
    tiles.on('tileload', (e) => {
      board.loaded(e.coords);
      setMapFailed(false);
      setClickRefused(false);
    });
    tiles.on('tileunload', (e) => board.gone(e.coords));
    tiles.addTo(map);
    // 그 자리에 그림이 떠 있는지. 화면 어딘가에 칸 하나가 떴다고 빈 자리를 눌러 엉뚱한 곳에 넣지 않게, 누른 자리의 칸을 봐요
    const shownAt = (latlng) => {
      const zoom = map.getZoom();
      return canPlacePin(board, tileCoordsAt(map.project(latlng, zoom), zoom, tiles.getTileSize().x));
    };
    shownAtRef.current = shownAt;
    map.on('click', (e) => {
      if (latest.current.disabled) return;
      if (!shownAt(e.latlng)) {
        setClickRefused(true);
        return;
      }
      latest.current.onChange(pinFrom(e.latlng.lat, e.latlng.lng));
    });
    // 옆으로 돌리거나 지구 복사본을 건너뛰어도 핀이 화면에서 사라지지 않게 해요. 끄는 중에는 건드리지 않아요
    map.on('moveend', () => {
      if (!draggingRef.current) drawMarker();
    });
    // 창 크기가 바뀌면 지도에 알려요
    const watcher = new ResizeObserver(() => map.invalidateSize());
    watcher.observe(holderRef.current);
    return () => {
      watcher.disconnect();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 핀 그리기 (값이 바뀔 때) ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!value) {
      if (markerRef.current) markerRef.current.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) {
      const marker = L.marker([value.lat, value.lng], { icon: PIN_ICON, draggable: true, title: '고른 위치', alt: '고른 위치' });
      marker.on('dragstart', () => { draggingRef.current = true; });
      marker.on('dragend', () => {
        draggingRef.current = false;
        const at = marker.getLatLng();
        // 끄는 사이에 넣기가 시작됐거나, 그림이 없는 자리에 놓았으면 핀을 원래 자리로 돌려놔요 (빈 지도에서는 어디에 놓는지 알 수 없어요)
        if (latest.current.disabled || !shownAtRef.current(at)) {
          if (!latest.current.disabled) setClickRefused(true);
          drawMarker();
          return;
        }
        latest.current.onChange(pinFrom(at.lat, at.lng));
      });
      marker.addTo(map);
      markerRef.current = marker;
    }
    drawMarker();
    if (disabled) markerRef.current.dragging.disable();
    else markerRef.current.dragging.enable();
  }, [value, disabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 검색 ----------
  // 창이 닫히면 늦게 온 응답을 버려요
  if (!searchSeq.current) searchSeq.current = createLatest();
  useEffect(() => () => searchSeq.current.cancel(), []);

  // Enter와 검색 버튼 둘 다 여기로 와요. 한글 입력 중의 Enter는 브라우저가 글자를 마친 뒤에 보내 줘요
  const runSearch = async (e) => {
    e.preventDefault();
    const text = query.trim();
    if (!text || disabled) return;
    const ticket = searchSeq.current.next();
    setSearch({ busy: true, results: null, error: '' });
    try {
      const found = await api.searchPlace(text);
      if (ticket.isCurrent()) setSearch({ busy: false, results: found.slice(0, MAX_RESULTS), error: '' });
    } catch (err) {
      if (ticket.isCurrent()) setSearch({ busy: false, results: null, error: errorText(err) });
    }
  };

  // 검색 결과를 누르면 그곳으로 옮겨서 핀을 놓아요. 첫 결과에 저절로 놓지는 않아요
  //   고른 뒤에는 목록을 접어서 넣기 버튼과 미리보기가 잘 보이게 해요. 눌렀던 버튼이 사라지니 초점은 지도로 옮겨요 (Esc와 Tab이 계속 창 안에서 돌게)
  const chooseResult = (place) => {
    if (disabled) return;
    mapRef.current.setView([place.lat, place.lng], RESULT_ZOOM);
    onChange({ ...pinFrom(place.lat, place.lng), name: place.name });
    setClickRefused(false);
    setSearch({ busy: false, results: null, error: '' });
    holderRef.current.focus({ preventScroll: true });
  };

  return (
    <div className="map-picker">
      <form className="map-search" onSubmit={runSearch}>
        <input
          type="text"
          value={query}
          maxLength={200}
          disabled={disabled}
          aria-label="장소 검색"
          placeholder="장소 이름이나 주소"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={disabled}>검색</button>
      </form>
      <p className="dialog-sub map-hint">{SEARCH_HINT}</p>
      {search.busy && <p className="dialog-sub map-status" role="status">찾는 중이에요</p>}
      {search.error && <p className="dialog-error map-search-error" role="alert">{search.error}</p>}
      {search.results && search.results.length === 0 && <p className="dialog-sub map-status" role="status">{NO_RESULT}</p>}
      {search.results && search.results.length > 0 && (
        <ul className="map-results" aria-label="검색 결과">
          {search.results.map((place, i) => (
            <li key={`${i}-${place.lat}-${place.lng}`}>
              <button type="button" disabled={disabled} onClick={() => chooseResult(place)}>
                {place.name || formatCoords(place.lat, place.lng)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="map-frame">
        <div ref={holderRef} className="map-canvas" />
        {(mapFailed || clickRefused) && (
          <div className="map-notes">
            {mapFailed && <p className="map-error" role="alert">{MAP_ERROR}</p>}
            {clickRefused && <p className="map-refused" role="alert">{CLICK_REFUSED}</p>}
          </div>
        )}
        {/* 못 열어도 지도는 그대로 쓸 수 있어서 따로 알리지 않아요 (main이 오류 로그를 남겨요) */}
        <button type="button" className="map-credit" onClick={() => api.openMapCredit().catch(() => {})}>© OpenStreetMap 기여자</button>
      </div>
    </div>
  );
}

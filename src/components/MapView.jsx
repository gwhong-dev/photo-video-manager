// 파일 위치: src/components/MapView.jsx
// 역할: 지도 화면 (단계 6). 위치가 있는 사진을 숫자 핀으로 묶어 보여 주고, 핀을 누르면 오른쪽 패널(MapPanel)에 그 곳 사진이 나와요
//   묶기 계산은 src/places-view.mjs (인터넷 안 씀). 지도 그림은 pvm://tile 로만 받아요 (화면이 직접 인터넷에 나가지 않아요)
//   지도는 색을 빼고(그림 층에 흑백 필터) 숫자 핀만 또렷하게 (Figma "지도")
//   위쪽: 장소 검색, 연도 탭 / 아래 왼쪽: 해외에서 찍은 사진 나라 칩 / 아래 오른쪽: 장소가 없는 사진 → 정보 없는 사진 화면
//   핀 이름 (6-2): 화면에 보이는 큰 핀 몇 개와 많이 찍은 곳, 해외 나라만 main 에 물어봐요 (시 · 군 단위, 받은 이름은 DB에 저장)

import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api, errorText } from '../api.js';
import { QuietTileLayer } from '../leaflet-quiet.js';
import { nearLng } from '../map-view.mjs';
import {
  byYear, cityKey, clusterPoints, COUNTRY_ZOOM, countText, countryChips, NAMED_PINS, nearestCluster,
  pinSize, summarize, toPoints, topPlaces, yearsOf,
} from '../places-view.mjs';

const KOREA = { center: [36.5, 127.8], zoom: 7 }; // 위치가 있는 사진이 없을 때 처음 위치
const FIT_MAX_ZOOM = 12; // 처음에 사진들이 다 보이게 맞출 때 너무 가까이 가지 않게
const GOTO_ZOOM = 11; // 많이 찍은 곳을 눌렀을 때
const RESULT_ZOOM = 13; // 검색 결과를 눌렀을 때
const MAX_RESULTS = 5;
const MAP_ERROR = '지도를 불러오지 못했어요. 인터넷 연결을 확인해 주세요. 핀은 그대로 볼 수 있어요.';
const NO_RESULT = '찾은 곳이 없어요. 다른 이름으로 찾아 보세요.';

// 핀 모양: 숫자 동그라미 + (이름을 알면) 오른쪽에 이름. 이름은 인터넷에서 온 글이라 innerHTML 대신 textContent 로 넣어요
function pinElement(count, name) {
  const box = document.createElement('div');
  const num = document.createElement('span');
  num.textContent = countText(count);
  box.appendChild(num);
  if (name) {
    const label = document.createElement('em');
    label.textContent = name;
    box.appendChild(label);
  }
  return box;
}

// viewRef = { center, zoom, year } 지도 화면을 다시 열 때 이어서 보여 줄 곳 (App이 들고 있어요)
// picked = 고른 묶음 요약 (MapPanel과 같이 써요), onPick(요약 또는 null), onLoaded(위치가 있는 사진 수)
// onTop(많이 찍은 곳 목록), goto = { lat, lng, seq } 패널에서 많이 찍은 곳을 누르면 그곳으로 옮기고 핀을 골라요
export default function MapView({ gen, noLocation, picked, onPick, onLoaded, onTop, goto, onGoMissing, viewRef }) {
  const holderRef = useRef(null);
  const mapRef = useRef(null);
  const pinsRef = useRef(null); // 핀 층
  const fittedRef = useRef(!!viewRef.current.center); // 사진들이 다 보이게 맞췄는지 (처음 한 번, 연도 탭을 바꿀 때마다 다시)
  const pendingPickRef = useRef(null); // 옮긴 뒤 고를 핀 자리 { lat, lng }
  const namesRef = useRef(new Map()); // 이름 열쇠 → { name, country, cc } | 'asking' | 'failed'
  const [namesVer, setNamesVer] = useState(0); // 이름이 새로 오면 다시 그려요
  const [points, setPoints] = useState(null); // null = 받는 중
  const [error, setError] = useState('');
  const [year, setYear] = useState(viewRef.current.year || null);
  const [mapFailed, setMapFailed] = useState(false);
  const [chips, setChips] = useState([]);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState({ busy: false, results: null, error: '' });

  // Leaflet 이벤트는 처음 만들 때 한 번만 묶어서, 늘 최신 값을 여기서 읽어요
  const latest = useRef(null);
  latest.current = { points, year, picked, onPick };

  // ---------- 이름 ----------
  const placeOf = (lat, lng) => {
    const v = namesRef.current.get(cityKey(lat, lng));
    return v && typeof v === 'object' ? v : null;
  };
  // 저장된 이름이 있으면 쓰고, 없으면 물어봐요 (main 이 1초에 하나씩 보내요). 실패한 곳은 이번 실행에서 다시 묻지 않아요
  const ensureName = (lat, lng) => {
    const key = cityKey(lat, lng);
    if (namesRef.current.has(key)) return;
    namesRef.current.set(key, 'asking');
    api.mapPlace(lat, lng, false)
      .then((saved) => saved || api.mapPlace(lat, lng, true))
      .then(
        (v) => namesRef.current.set(key, v || { name: '', country: '', cc: '' }),
        () => namesRef.current.set(key, 'failed'),
      )
      .finally(() => setNamesVer((n) => n + 1));
  };
  const nameOf = (c) => {
    const p = placeOf(c.lat, c.lng);
    return p && p.name ? p.name : '';
  };

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
    const clusters = clusterPoints(byYear(all, y), zoom, { bounds });
    // 화면 안의 큰 핀 몇 개만 이름을 물어봐요
    const view = map.getBounds();
    clusters.filter((c) => view.contains([c.lat, nearLng(c.lng, centerLng)])).slice(0, NAMED_PINS).forEach((c) => ensureName(c.lat, c.lng));
    for (const c of clusters) {
      const size = pinSize(c.count);
      const icon = L.divIcon({
        className: `place-pin${pick && pick.key === c.key ? ' on' : ''}`,
        html: pinElement(c.count, nameOf(c)),
        iconSize: [size, size],
      });
      const marker = L.marker([c.lat, nearLng(c.lng, centerLng)], { icon, title: `${countText(c.count)}장`, keyboard: true, riseOnHover: true });
      marker.on('click', () => latest.current.onPick({ ...summarize(c, latest.current.year), name: nameOf(c), lat: c.lat, lng: c.lng }));
      marker.addTo(layer);
    }
    // 많이 찍은 곳을 눌러 옮겨 온 경우: 그 자리에서 가장 가까운 핀을 골라요
    const want = pendingPickRef.current;
    if (want) {
      pendingPickRef.current = null;
      const c = nearestCluster(clusters, want.lat, want.lng);
      if (c) latest.current.onPick({ ...summarize(c, latest.current.year), name: nameOf(c), lat: c.lat, lng: c.lng });
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

  // 처음 받았을 때 사진들이 다 보이게 맞추고, 그다음부터는 목록 · 연도 · 고른 핀 · 이름이 바뀔 때마다 다시 그려요
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !points) return;
    const shown = byYear(points, year);
    if (!fittedRef.current && shown.length) {
      fittedRef.current = true;
      const box = L.latLngBounds(shown.map((p) => [p.lat, p.lng]));
      map.fitBounds(box, { padding: [48, 48], maxZoom: FIT_MAX_ZOOM, animate: false });
      return; // fitBounds가 moveend로 다시 그려요
    }
    draw();
  }, [points, year, picked, namesVer]); // eslint-disable-line react-hooks/exhaustive-deps

  // 많이 찍은 곳과 해외 나라 칩 (목록 · 연도 · 이름이 바뀔 때)
  useEffect(() => {
    if (!points) return;
    const shown = byYear(points, year);
    const top = topPlaces(shown);
    top.forEach((t) => ensureName(t.lat, t.lng));
    onTop(top.map((t) => ({ key: t.key, count: t.count, lat: t.lat, lng: t.lng, name: nameOf(t), asking: namesRef.current.get(cityKey(t.lat, t.lng)) === 'asking' })));
    const wide = clusterPoints(shown, COUNTRY_ZOOM);
    wide.forEach((c) => ensureName(c.lat, c.lng));
    setChips(countryChips(wide, placeOf));
  }, [points, year, namesVer]); // eslint-disable-line react-hooks/exhaustive-deps

  // 고른 핀의 이름이 나중에 오면 패널에도 넣어요
  useEffect(() => {
    if (!picked || picked.name || picked.lat === undefined) return;
    const p = placeOf(picked.lat, picked.lng);
    if (p && p.name) onPick({ ...picked, name: p.name });
  }, [namesVer]); // eslint-disable-line react-hooks/exhaustive-deps

  // 패널에서 많이 찍은 곳을 누르면 그곳으로 옮기고, 다 옮긴 뒤(moveend → draw) 가장 가까운 핀을 골라요
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !goto) return;
    pendingPickRef.current = { lat: goto.lat, lng: goto.lng };
    map.setView([goto.lat, goto.lng], GOTO_ZOOM, { animate: false });
  }, [goto && goto.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  const years = points ? yearsOf(points) : [];
  const chooseYear = (y) => {
    if (y === year) return;
    setYear(y);
    fittedRef.current = false; // 그 해 사진이 다 보이게 지도를 다시 맞춰요 (화면 밖에만 있으면 핀이 하나도 안 보여서)
    viewRef.current = { ...viewRef.current, year: y };
    onPick(null); // 다른 해의 묶음은 숫자가 달라서 고른 것을 풀어요
  };

  // ---------- 장소 검색 (main 이 1초에 하나씩 보내요. 검색어는 OpenStreetMap 서버로 가요) ----------
  const runSearch = async (e) => {
    e.preventDefault();
    const text = query.trim();
    if (!text) return;
    setSearch({ busy: true, results: null, error: '' });
    try {
      const found = await api.searchPlace(text);
      setSearch({ busy: false, results: found.slice(0, MAX_RESULTS), error: '' });
    } catch (err) {
      setSearch({ busy: false, results: null, error: errorText(err) });
    }
  };
  const chooseResult = (place) => {
    mapRef.current.setView([place.lat, place.lng], RESULT_ZOOM);
    setSearch({ busy: false, results: null, error: '' });
  };
  const goChip = (chip) => {
    const { s, w, n, e } = chip.box;
    mapRef.current.fitBounds([[s, w], [n, e]], { padding: [48, 48], maxZoom: FIT_MAX_ZOOM });
  };

  return (
    <div className="map-view">
      <div ref={holderRef} className="map-canvas map-view-canvas" />
      <div className="map-top">
        <form className="map-view-search" onSubmit={runSearch}>
          <input
            type="text"
            value={query}
            maxLength={200}
            aria-label="장소 검색"
            placeholder="장소 검색"
            title="검색어는 OpenStreetMap 서버로 보내요. 이름이나 전화번호 같은 개인정보는 적지 마세요."
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
        <div className="map-years" role="tablist" aria-label="찍은 해">
          <button type="button" role="tab" aria-selected={!year} className={!year ? 'on' : ''} onClick={() => chooseYear(null)}>전체 기간</button>
          {years.map((y) => (
            <button key={y} type="button" role="tab" aria-selected={year === y} className={year === y ? 'on' : ''} onClick={() => chooseYear(y)}>{y}</button>
          ))}
        </div>
      </div>
      {(search.busy || search.error || search.results) && (
        <div className="map-view-results">
          {search.busy && <p role="status">찾는 중이에요</p>}
          {search.error && <p role="alert">{search.error}</p>}
          {search.results && search.results.length === 0 && <p role="status">{NO_RESULT}</p>}
          {search.results && search.results.length > 0 && (
            <ul aria-label="검색 결과">
              {search.results.map((place, i) => (
                <li key={`${i}-${place.lat}-${place.lng}`}>
                  <button type="button" onClick={() => chooseResult(place)}>{place.name || `${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`}</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {points && points.length === 0 && !error && (
        <p className="map-empty" role="status">위치가 있는 사진이 아직 없어요. 정보 없는 사진 화면에서 위치를 넣으면 여기에 핀이 생겨요.</p>
      )}
      {error && <p className="map-error map-view-note" role="alert">사진 위치를 불러오지 못했어요. {error}</p>}
      {mapFailed && !error && !search.results && !search.error && <p className="map-error map-view-note" role="alert">{MAP_ERROR}</p>}
      {chips.length > 0 && (
        <div className="map-abroad">
          <span>해외에서 찍은 사진</span>
          {chips.map((c) => (
            <button key={c.cc} type="button" onClick={() => goChip(c)}>{c.country} {countText(c.count)}</button>
          ))}
        </div>
      )}
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

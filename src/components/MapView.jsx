// 파일 위치: src/components/MapView.jsx
// 역할: 지도 화면 (단계 6). 위치가 있는 사진을 숫자 핀으로 묶어 보여 주고, 핀을 누르면 오른쪽 패널(MapPanel)에 그 곳 사진이 나와요
//   묶기 계산은 src/places-view.mjs (인터넷 안 씀). 지도 그림은 pvm://tile 로만 받아요 (화면이 직접 인터넷에 나가지 않아요)
//   지도는 색을 빼고(그림 층에 흑백 필터) 숫자 핀만 또렷하게 (Figma "지도")
//   위쪽: 장소 검색, 연도 탭 / 아래 왼쪽: 해외에서 찍은 사진 나라 칩 / 아래 오른쪽: 장소가 없는 사진 → 정보 없는 사진 화면
//   핀 이름 (6-2): 화면에 보이는 큰 핀 몇 개와 많이 찍은 곳, 해외 나라만 main 에 물어봐요 (시 · 군 단위, 받은 이름은 DB에 저장)

import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { api, errorText } from '../api.js';
import { QuietTileLayer } from '../leaflet-quiet.js';
import { nearLng } from '../map-view.mjs';
import {
  byYear, cityKey, clusterPoints, COUNTRY_ZOOM, countText, countryChips, MAX_PINS, NAMED_PINS,
  pinSize, summarize, toPoints, topPlaces, viewRanges, yearsOf,
} from '../places-view.mjs';

const KOREA = { center: [36.5, 127.8], zoom: 7 }; // 위치가 있는 사진이 없을 때 처음 위치
const FIT_MAX_ZOOM = 12; // 처음에 사진들이 다 보이게 맞출 때 너무 가까이 가지 않게
const GOTO_MAX_ZOOM = 13; // 많이 찍은 곳을 눌렀을 때 그 사진들이 다 보이게 맞추되 너무 가까이 가지 않게
const RELOAD_GAP_MS = 5000; // 백업 폴더를 읽는 동안 위치 목록을 다시 받는 최소 간격 (#55 검증: 0.5초마다 6만 줄을 받던 것)
const AUTO_MAX = 80; // 이번 실행에서 저절로 묻는 이름 수 상한 (#56 검증). 넘으면 저장된 이름만 써요

// ---------- 핀 이름 (앱이 켜져 있는 동안 기억해요. 지도 화면을 다시 열어도 다시 묻지 않게, #56 검증) ----------
//   이름 열쇠 → { name, country, cc } | 'waiting' | 'failed' | 'skipped'
//   한 번에 하나씩만 물어요. 그래야 사용자가 장소를 검색하면 1~2초 안에 차례가 와요 (main 의 지도 요청은 한 줄로 서요)
const NAMES = new Map();
const WAITING = []; // 핀 · 많이 찍은 곳 (먼저)
const LATER = []; // 해외 나라를 알아볼 묶음 (뒤에. 상한 80을 먼저 다 쓰지 않게, #62 검증)
const LISTENERS = new Set();
let pumping = false;
let autoAsked = 0;
function wantName(spot, later = false) {
  const key = cityKey(spot.lat, spot.lng);
  if (NAMES.has(key)) return;
  NAMES.set(key, 'waiting');
  (later ? LATER : WAITING).push({ ...spot, key });
  pumpNames();
}
async function pumpNames() {
  if (pumping) return;
  const next = WAITING.shift() || LATER.shift();
  if (!next) return;
  pumping = true;
  try {
    let v = await api.mapPlace(next.lat, next.lng, false); // 저장된 이름 (인터넷 안 씀)
    if (!v && autoAsked < AUTO_MAX) {
      autoAsked += 1;
      v = await api.mapPlace(next.lat, next.lng, true);
    }
    NAMES.set(next.key, v || (autoAsked >= AUTO_MAX ? 'skipped' : { name: '', country: '', cc: '' }));
  } catch (e) {
    NAMES.set(next.key, 'failed'); // 이번 실행에서는 다시 묻지 않아요
  } finally {
    pumping = false;
    LISTENERS.forEach((f) => f());
    pumpNames();
  }
}
const placeAt = (spot) => {
  const v = spot && NAMES.get(cityKey(spot.lat, spot.lng));
  return v && typeof v === 'object' ? v : null;
};
const nameAt = (spot) => {
  const p = placeAt(spot);
  return p && p.name ? p.name : '';
};
const stateAt = (spot) => (spot ? NAMES.get(cityKey(spot.lat, spot.lng)) : undefined);
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
// onTop(많이 찍은 곳 목록), goto = { key, seq } 패널에서 누른 많이 찍은 곳 → 그 묶음을 고르고 그곳을 보여 줘요
export default function MapView({ gen, noLocation, picked, onPick, onLoaded, onTop, goto, onGoMissing, viewRef }) {
  const holderRef = useRef(null);
  const mapRef = useRef(null);
  const pinsRef = useRef(null); // 핀 층
  const fittedRef = useRef(!!viewRef.current.center); // 사진들이 다 보이게 맞췄는지 (처음 한 번, 연도 탭을 바꿀 때마다 다시)
  const [namesVer, setNamesVer] = useState(0); // 이름이 새로 오면 다시 그려요
  const [points, setPoints] = useState(null); // null = 받는 중
  const [error, setError] = useState('');
  const [year, setYear] = useState(viewRef.current.year || null);
  const [mapFailed, setMapFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState({ busy: false, results: null, error: '' });

  // Leaflet 이벤트는 처음 만들 때 한 번만 묶어서, 늘 최신 값을 여기서 읽어요
  const latest = useRef(null);
  latest.current = { points, year, picked, onPick };

  // 이름이 새로 오면 다시 그려요 (화면이 닫히면 듣지 않아요)
  useEffect(() => {
    const f = () => setNamesVer((n) => n + 1);
    LISTENERS.add(f);
    return () => { LISTENERS.delete(f); };
  }, []);

  // ---------- 위치 목록 받기 ----------
  const lastLoadRef = useRef(0);
  useEffect(() => {
    let alive = true;
    let timer = null;
    const load = () => {
      lastLoadRef.current = Date.now();
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
    };
    // 읽는 중에는 gen 이 자주 올라요. 마지막으로 받은 지 RELOAD_GAP_MS 안이면 남은 시간 뒤에 한 번만 받아요
    const wait = lastLoadRef.current ? RELOAD_GAP_MS - (Date.now() - lastLoadRef.current) : 0;
    if (wait > 0) timer = setTimeout(load, wait);
    else load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
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
    // 화면 안(조금 넉넉히)만 묶어요. 지구 복사본을 넘겨 본 화면은 경도 구간 두 개로 나눠요 (전 세계를 묶지 않게)
    const b = map.getBounds().pad(0.3);
    const bounds = viewRanges(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
    const centerLng = map.getCenter().lng;
    // 핀이 아주 많으면 큰 묶음부터 MAX_PINS 개만 그려요 (묶음은 큰 순서예요)
    const clusters = clusterPoints(byYear(all, y), zoom, { bounds }).slice(0, MAX_PINS);
    // 화면 안의 큰 핀 몇 개만 이름을 물어봐요
    const view = map.getBounds();
    clusters.filter((c) => view.contains([c.lat, nearLng(c.lng, centerLng)])).slice(0, NAMED_PINS).forEach((c) => wantName(c.named));
    for (const c of clusters) {
      const size = pinSize(c.count);
      const icon = L.divIcon({
        className: `place-pin${pick && pick.key === c.key ? ' on' : ''}`,
        html: pinElement(c.count, nameAt(c.named)),
        iconSize: [size, size],
      });
      const marker = L.marker([c.lat, nearLng(c.lng, centerLng)], { icon, title: `${countText(c.count)}장`, keyboard: true, riseOnHover: true });
      marker.on('click', () => latest.current.onPick({ ...summarize(c, latest.current.year), name: nameAt(c.named), named: c.named }));
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

  // 많이 찍은 곳과 해외 나라를 알아볼 묶음은 목록 · 연도가 바뀔 때만 다시 묶어요 (이름이 올 때마다 6만 장을 묶지 않게, #56 검증)
  const shownTop = useMemo(() => (points ? topPlaces(byYear(points, year)) : []), [points, year]);
  const wide = useMemo(() => (points ? clusterPoints(byYear(points, year), COUNTRY_ZOOM) : []), [points, year]);
  useEffect(() => {
    shownTop.forEach((t) => wantName(t.named));
    wide.forEach((c) => wantName(c.named, true)); // 큰 묶음부터 (clusterPoints는 큰 순서)
  }, [shownTop, wide]);
  // 패널의 많이 찍은 곳 (이름이 오면 이름만 다시 붙여요)
  useEffect(() => {
    onTop(shownTop.map((t) => ({ key: t.key, count: t.count, name: nameAt(t.named), asking: stateAt(t.named) === 'waiting' })));
  }, [shownTop, namesVer]); // eslint-disable-line react-hooks/exhaustive-deps
  const chips = useMemo(() => countryChips(wide, (lat, lng) => placeAt({ lat, lng })), [wide, namesVer]);

  // 고른 핀의 이름이 나중에 오면 패널에도 넣어요
  useEffect(() => {
    if (!picked || picked.name || !picked.named) return;
    const name = nameAt(picked.named);
    if (name) onPick({ ...picked, name });
  }, [namesVer]); // eslint-disable-line react-hooks/exhaustive-deps

  // 패널에서 많이 찍은 곳을 누르면: 그 묶음을 그대로 골라 패널과 숫자가 같게 하고, 그 사진들이 다 보이게 지도를 맞춰요
  //   처리한 번호를 viewRef 에 적어 둬서, 갤러리에 다녀와 지도 화면이 다시 열려도 다시 옮기지 않아요 (#56 검증)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !goto || viewRef.current.gotoSeq === goto.seq) return;
    const t = shownTop.find((x) => x.key === goto.key);
    if (!t) return;
    viewRef.current = { ...viewRef.current, gotoSeq: goto.seq };
    onPick({ ...summarize(t.cluster, year), name: nameAt(t.named), named: t.named });
    const box = L.latLngBounds(t.cluster.members.map((m) => [m.lat, m.lng]));
    map.fitBounds(box, { padding: [48, 48], maxZoom: GOTO_MAX_ZOOM, animate: false });
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

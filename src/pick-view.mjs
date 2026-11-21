// 파일 위치: src/pick-view.mjs
// 역할: 고른 사진에 바로 주는 위치 제안 (2026-11-21 사용자 요청). 화면 계산만 하는 순수 함수라 점검에서 바로 불러 봐요
//   main 이 위치 없는 사진마다 제안 하나를 미리 계산해 줘요 (lib/location-suggest.js pickSuggestions, listSuggestions 응답의 picks · pickSources)
//   여기서는 고른 사진 중 제안이 있는 것만 모아, 같은 날 1km 안의 근거 사진끼리 한 곳으로 묶어요 (위치 제안 탭과 같은 1km)
//   한 곳 = 넣기 한 번 (근거 사진 하나). 여러 곳이면 장수가 많은 곳부터 한 곳씩 넣어요

import { formatCount, gapText } from './format.mjs';

const GROUP_KM = 1;

// 두 위치 사이의 거리 (km)
function kmBetween(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// 'YYYY-MM-DDTHH:MM:SS' → 초 (시간대 없이 글자 그대로, lib/location-suggest.js 와 같음). 모양이 다르면 null
function secondsOf(text) {
  const m = typeof text === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(text) : null;
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : null;
}

// listSuggestions 응답 → 찾기 쉬운 표 { byId: Map(사진 번호 → 제안), sources: { 번호: 근거 사진 } }. 응답이 이상하면 빈 표
export function pickTable(res) {
  const byId = new Map();
  const picks = res && Array.isArray(res.picks) ? res.picks : [];
  const sources = res && res.pickSources && typeof res.pickSources === 'object' ? res.pickSources : {};
  for (const p of picks) if (p && sources[p.sourceId]) byId.set(p.id, p);
  return { byId, sources };
}

// 고른 사진(ids: Set 또는 배열)의 제안. 제안 받을 사진이 없으면 null
//   돌려주는 값: { count: 제안 받는 장수, places: [{ source, ids, kind: 'near'|'between'|'mixed', gapMin, gapMax }] }
//   gapMin · gapMax 는 그곳의 근거 사진(source, 넣을 위치의 주인)과 각 사진의 실제 시간 차이예요 (분). 창에 보이는 근거 사진과 맞아요
//   places 는 장수가 많은 곳부터. 같으면 근거 사진 시각, 그다음 번호 순
export function selectionPick(ids, table) {
  if (!table) return null;
  const mine = [];
  for (const id of ids) {
    const p = table.byId.get(id);
    if (p) mine.push(p);
  }
  if (!mine.length) return null;
  const src = (p) => table.sources[p.sourceId];
  // 먼저 만든 곳의 근거 사진이 그곳의 위치가 돼요. 고른 사진 중 가장 많은 사진의 근거 사진부터 보아서,
  //   되도록 많은 사진이 자기와 가장 가까운 사진의 좌표를 그대로 받게 해요 (같으면 근거 사진 시각, 그다음 번호)
  const uses = new Map();
  for (const p of mine) uses.set(p.sourceId, (uses.get(p.sourceId) || 0) + 1);
  mine.sort((a, b) => uses.get(b.sourceId) - uses.get(a.sourceId)
    || String(src(a).takenAt).localeCompare(String(src(b).takenAt)) || a.sourceId - b.sourceId || a.id - b.id);
  const places = [];
  for (const p of mine) {
    const s = src(p);
    let place = places.find((g) => g.source.takenDay === s.takenDay && kmBetween(g.source, s) <= GROUP_KM);
    if (!place) {
      place = { source: s, ids: [], kinds: new Set(), gapMin: Infinity, gapMax: 0 };
      places.push(place);
    }
    place.ids.push(p.id);
    place.kinds.add(p.kind);
    // 묶이면 위치는 그곳의 근거 사진 것을 받아서, 시간 차이도 그 사진과 다시 재요 (대상 시각이 없으면 원래 차이)
    const a = secondsOf(p.takenAt);
    const b = secondsOf(place.source.takenAt);
    const gap = a !== null && b !== null ? Math.round(Math.abs(a - b) / 60) : p.gapMinutes;
    place.gapMin = Math.min(place.gapMin, gap);
    place.gapMax = Math.max(place.gapMax, gap);
  }
  places.sort((a, b) => b.ids.length - a.ids.length
    || String(a.source.takenAt).localeCompare(String(b.source.takenAt)) || a.source.id - b.source.id);
  return {
    count: mine.length,
    places: places.map(({ kinds, ...g }) => ({ ...g, kind: kinds.size > 1 ? 'mixed' : [...kinds][0] })),
  };
}

// 한 곳을 넣은 뒤 남길 선택: 지금 선택에서 넣은 사진을 뺀 번호들 (넣은 사진이 목록에서 빠져도 보이지 않는 사진이 선택에 남지 않게)
export function remainingAfter(selectedIds, placeIds) {
  const done = new Set(placeIds);
  return [...selectedIds].filter((id) => !done.has(id));
}

// 버튼 글자: 결과를 말해요. 한 번에 넣는 것은 첫 곳의 장수예요 ("3장에 근처 사진 위치 넣기")
export function pickButtonLabel(pick) {
  return `${formatCount(pick.places[0].ids.length)}장에 근처 사진 위치 넣기`;
}

// 버튼 아래 작은 안내 한 줄: 어떤 사진 기준인지, 여러 곳이면 한 곳씩 넣는다는 것
export function pickNote(pick) {
  const g = pick.places[0];
  let base;
  if (g.kind === 'between') base = '앞뒤로 찍은 사진이 같은 곳이에요';
  else if (g.kind === 'mixed') base = '같은 날 시간이 가까운 사진 위치예요';
  else base = g.gapMax < 1 ? '같은 날 1분 안에 찍은 사진 위치예요' : `같은 날 ${gapText(g.gapMax).replace(' 차이', '')} 안에 찍은 사진 위치예요`;
  return pick.places.length > 1 ? `${base}. ${formatCount(pick.places.length)}곳이라 한 곳씩 넣어요` : base;
}

// 창 안 설명 한 줄: 근거 사진과 시간 차이
export function pickGapText(place) {
  if (place.gapMax < 1) return '1분 안';
  if (place.gapMin === place.gapMax) return gapText(place.gapMax);
  return `${place.gapMin < 1 ? '1분 안' : gapText(place.gapMin).replace(' 차이', '')} ~ ${gapText(place.gapMax)}`;
}

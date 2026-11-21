// 파일 위치: lib/location-suggest.js
// 역할: "위치 제안" 묶음 계산. 위치 없는 사진마다 같은 날 시간이 가장 가까운 사진을 찾아서 묶어요.
//   DB도 파일도 건드리지 않는 순수 함수라서 Electron 없이 일반 Node에서 점검할 수 있어요.
//   값을 넣는 일은 하지 않아요. 넣기는 사용자가 버튼을 눌렀을 때 gallery-main.js 가 해요.
//
// 시각은 시간대 없이 "현지 시각 글자" 그대로 다뤄요 (lib/manual-edit.js 처럼).

const MAX_GAP_SECONDS = 3600; // 제안할 수 있는 최대 시간 차이 (60분 정각은 포함)
const GROUP_KM = 1; // 같은 묶음으로 보는 거리

// 'YYYY-MM-DDTHH:MM:SS' 글자를 초로 바꿔요. 시각이 없거나 날짜뿐이면 null
function secondsOf(takenAt) {
  const m = typeof takenAt === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(takenAt) : null;
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
}

// 시각을 믿을 수 있는지: 파일 이름에 날짜만 있어 00:00:00이 된 사진과, 사람이 직접 넣은 시각은 실제 찍은 시각이 아니에요.
//   이런 사진으로 시간 차이를 계산하면 근거 없는 제안이 나오므로 근거로도 대상으로도 쓰지 않아요
function hasRealTime(f) {
  if (f.takenAtSource === 'manual') return false;
  return !(f.takenAtSource === 'filename' && /T00:00:00/.test(String(f.takenAt)));
}

// 두 위치 사이의 거리 (km)
function kmBetween(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// 근거 사진이 될 수 있는지: 파일에서 읽은 위치와 시각이 있어야 해요 (0도 값이에요).
//   직접 넣은 위치는 빼요. 제안으로 넣은 값이 다시 근거가 되면 오차가 쌓이니까요
function isSource(f) {
  return typeof f.lat === 'number' && typeof f.lng === 'number' && f.locationSource !== 'manual' && !!f.takenDay;
}

// 기기 정보(카메라나 휴대폰 모델명)가 없는지: 없음, 빈 글자, 공백뿐이면 없음이에요.
//   이런 사진은 내보내거나 편집한 파일이 많아서 날짜가 찍은 날인지 확신할 수 없어요 (설계서 12절)
function noDeviceOf(f) {
  return !(typeof f.model === 'string' && f.model.trim());
}

// 대상 사진의 근거 사진을 찾아요: 시간 차이가 가장 작은 것, 같으면 이른 사진, 그래도 같으면 id가 작은 사진
function nearestSource(target, sources) {
  let best = null;
  let bestGap = Infinity;
  for (const s of sources) {
    const gap = Math.abs(s.seconds - target.seconds);
    if (gap > MAX_GAP_SECONDS) continue;
    const better = gap < bestGap
      || (gap === bestGap && (s.seconds < best.seconds || (s.seconds === best.seconds && s.id < best.id)));
    if (better) {
      best = s;
      bestGap = gap;
    }
  }
  return best;
}

// 묶음 목록을 만들어요
//   rows: db.listSuggestionRows 결과 (사라진 파일과 스크린샷은 이미 빠져 있어요)
//   skippedPaths: 건너뛴 사진의 경로 Set
//   돌려주는 값: { groups, photoCount, skippedCount }
//     묶음 = { day, source: { id, name, takenAt, mediaType }, targets: [{ id, name, takenAt, mediaType, gapMinutes, noDevice, path }] }
//     path는 main 안에서만 써요. 화면에 주기 전에 빼요
function buildSuggestions(rows, skippedPaths) {
  const sourcesByDay = new Map();
  const targetsByDay = new Map();
  let skippedCount = 0;

  for (const f of rows) {
    const seconds = secondsOf(f.takenAt);
    if (seconds === null || !f.takenDay || !hasRealTime(f)) continue;
    const item = { ...f, seconds };
    if (f.lat === null || f.lat === undefined) {
      if (skippedPaths.has(f.path)) {
        skippedCount++;
      } else {
        if (!targetsByDay.has(f.takenDay)) targetsByDay.set(f.takenDay, []);
        targetsByDay.get(f.takenDay).push(item);
      }
    } else if (isSource(f)) {
      if (!sourcesByDay.has(f.takenDay)) sourcesByDay.set(f.takenDay, []);
      sourcesByDay.get(f.takenDay).push(item);
    }
  }

  const groups = [];
  let photoCount = 0;
  for (const [day, targets] of targetsByDay) {
    const sources = sourcesByDay.get(day);
    if (!sources) continue;
    targets.sort((a, b) => a.seconds - b.seconds || a.id - b.id);
    const dayGroups = [];
    for (const t of targets) {
      const near = nearestSource(t, sources);
      if (!near) continue;
      // 그날 먼저 만든 묶음의 기준 위치에서 1km 안이면 그 묶음으로 (묶음의 모든 사진은 기준 사진의 위치를 받아요)
      let group = dayGroups.find((g) => kmBetween(g.anchor, near) <= GROUP_KM);
      if (!group) {
        group = { day, anchor: near, targets: [] };
        dayGroups.push(group);
      }
      group.targets.push({
        id: t.id,
        name: t.name,
        takenAt: t.takenAt,
        mediaType: t.mediaType,
        gapMinutes: Math.round(Math.abs(t.seconds - group.anchor.seconds) / 60),
        noDevice: noDeviceOf(t),
        path: t.path,
      });
      photoCount++;
    }
    for (const g of dayGroups) {
      const { id, name, takenAt, mediaType } = g.anchor;
      groups.push({ day: g.day, source: { id, name, takenAt, mediaType }, targets: g.targets });
    }
  }

  // 순서: 기기 정보 있는 사진이 하나라도 든 묶음 먼저 (설계서 12절)
  //   그다음 장수 많은 묶음부터, 같으면 최근 날짜, 그다음 기준 사진 id
  const hasDevice = (g) => (g.targets.some((t) => !t.noDevice) ? 1 : 0);
  groups.sort((a, b) => hasDevice(b) - hasDevice(a)
    || b.targets.length - a.targets.length
    || (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)
    || a.source.id - b.source.id);
  return { groups, photoCount, skippedCount };
}

// ---------- 고른 사진에 바로 주는 제안 (2026-11-21 사용자 요청) ----------
//   갤러리에서 위치 없는 사진을 고르면 오른쪽 패널 · 우클릭 메뉴에 "근처 사진 위치 넣기"를 보여 주려고
//   위치 없는 사진마다 제안 하나를 미리 계산해 둬요 (설계 docs/superpowers/specs/2026-11-21-selection-location-suggest-design.md)
//   - near   : 같은 날 60분 안에 위치 있는 사진이 있으면 그중 시간이 가장 가까운 사진 (위 buildSuggestions 와 같은 규칙)
//   - between: 60분 안에는 없어도, 바로 앞과 바로 뒤에 찍은 위치 있는 사진(같은 날)이 서로 1km 안이면 시간이 가까운 쪽
//              (그 사이에도 같은 곳에 있었을 가능성이 높아요. 실제 목록에서 가려 보고 잰 값 1km 안 87%,
//               docs/decisions/2026-11-21-selection-location-suggest.md)
//   시각을 믿을 수 없는 사진(이름의 날짜뿐 · 직접 넣은 시각)은 시간 차이를 잴 수 없어서 제안하지 않아요
//   건너뛴 사진도 계산해요. 사용자가 직접 골랐으니까요

// 시간 순서로 정렬된 근거 목록에서 대상 바로 앞(같은 시각 포함)과 바로 뒤 사진
function neighbors(target, sorted) {
  let before = null;
  let after = null;
  for (const s of sorted) {
    if (s.seconds <= target.seconds) {
      before = s;
    } else {
      after = s;
      break;
    }
  }
  return { before, after };
}

// rows: db.listSuggestionRows 결과
// 돌려주는 값: { picks: [{ id, kind: 'near'|'between', sourceId, gapMinutes }],
//               sources: { [id]: { id, name, takenAt, takenDay, mediaType, lat, lng } } }
//   파일 경로는 넣지 않아요 (화면으로 가는 값이에요)
function pickSuggestions(rows) {
  const sourcesByDay = new Map();
  const targets = [];
  for (const f of rows) {
    const seconds = secondsOf(f.takenAt);
    if (seconds === null || !f.takenDay || !hasRealTime(f)) continue;
    const item = { ...f, seconds };
    if (f.lat === null || f.lat === undefined) {
      targets.push(item);
    } else if (isSource(f)) {
      if (!sourcesByDay.has(f.takenDay)) sourcesByDay.set(f.takenDay, []);
      sourcesByDay.get(f.takenDay).push(item);
    }
  }
  for (const list of sourcesByDay.values()) list.sort((a, b) => a.seconds - b.seconds || a.id - b.id);

  const picks = [];
  const used = new Map();
  for (const t of targets) {
    const daySources = sourcesByDay.get(t.takenDay);
    if (!daySources) continue;
    let kind = 'near';
    let src = nearestSource(t, daySources);
    if (!src) {
      const { before, after } = neighbors(t, daySources);
      if (!before || !after || kmBetween(before, after) > GROUP_KM) continue;
      kind = 'between';
      src = t.seconds - before.seconds <= after.seconds - t.seconds ? before : after; // 같으면 앞 사진
    }
    used.set(src.id, src);
    picks.push({ id: t.id, kind, sourceId: src.id, gapMinutes: Math.round(Math.abs(src.seconds - t.seconds) / 60) });
  }
  const sources = {};
  for (const [id, s] of used) {
    sources[id] = { id, name: s.name, takenAt: s.takenAt, takenDay: s.takenDay, mediaType: s.mediaType, lat: s.lat, lng: s.lng };
  }
  return { picks, sources };
}

module.exports = { buildSuggestions, pickSuggestions, MAX_GAP_SECONDS, GROUP_KM };

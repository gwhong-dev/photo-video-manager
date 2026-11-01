// 파일 위치: lib/manual-edit.js
// 역할: "날짜와 위치 넣기"의 미리보기 계산. 값 검사, +1초 규칙, 전 → 후 목록을 만들어요.
//   DB도 파일도 건드리지 않는 순수 함수라서 Electron 없이 일반 Node에서 점검할 수 있어요.
//   (실제 저장은 gallery-main.js 가 이 계산 결과를 lib/db.js 에 넘겨서 해요)
//
// 시각은 시간대 없이 "현지 시각 글자" 그대로 다뤄요 (formatTakenAt 처럼).
//   계산할 때만 Date.UTC 를 빌려 쓰고, 다시 글자로 되돌려요. 그래서 컴퓨터의 시간대와 상관없어요.

const MAX_TARGETS = 20000; // 한 번에 넣을 수 있는 최대 장수
const PREVIEW_LINES = 100; // 화면에 그릴 줄 수 (나머지는 more 로 줄여요)
const DIRECT_OFFSET = '+09:00'; // 날짜 직접 넣기의 시간대
const DEFAULT_TIME = '12:00:00'; // 시간을 안 정했을 때 쓰는 시간

const pad = (n, w = 2) => String(n).padStart(w, '0');

// 'YYYY-MM-DD' 글자가 달력에 있는 날이고, 1900년부터 올해(year)까지인지 검사해요
function checkDay(day, year) {
  const m = typeof day === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!m) throw new Error('날짜는 2026-03-05 모양으로 적어 주세요.');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  // 2월 30일 같은 날은 Date가 다음 달로 넘겨 버리므로, 되돌려 읽어서 같은지 본다
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    throw new Error('없는 날짜예요. 날짜를 다시 확인해 주세요.');
  }
  if (y < 1900 || y > year) throw new Error(`연도는 1900년부터 ${year}년까지만 넣을 수 있어요.`);
  return day;
}

// 'HH:MM:SS' 글자가 맞는 시각인지 검사해요
function checkTime(time) {
  const m = typeof time === 'string' ? /^(\d{2}):(\d{2}):(\d{2})$/.exec(time) : null;
  if (!m) throw new Error('시간은 14:00:30 모양으로 적어 주세요.');
  if (Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3]) > 59) throw new Error('없는 시간이에요. 시간을 다시 확인해 주세요.');
  return time;
}

// 위도와 경도가 숫자이고 범위 안인지 검사해요 (0도 정상 값이에요)
function checkLocation(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('위치 값이 올바르지 않아요.');
  }
  if (lat < -90 || lat > 90) throw new Error('위도는 -90부터 90까지만 넣을 수 있어요.');
  if (lng < -180 || lng > 180) throw new Error('경도는 -180부터 180까지만 넣을 수 있어요.');
  return { lat, lng };
}

// 찍은 시각 글자('2026-10-25T14:00:30')에서 시간 부분만 꺼내요. 시간이 없으면 null
const timeOf = (takenAt) => {
  const m = typeof takenAt === 'string' ? /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})/.exec(takenAt) : null;
  return m ? m[1] : null;
};

// 요청 한 개를 검사해서 계산에 쓸 모양(Resolved)으로 바꿔요. 잘못이면 사람이 읽을 글자로 Error
//   raw: { source: 'copy', sourceId, date, time, location } 또는 { source: 'direct', date, time }
//   sourceRow: 복사한 기준 사진 줄 (copy 일 때만 필요)
//   year: 연도 상한 (보통 올해)
function normalizeRequest(raw, { sourceRow = null, year = new Date().getFullYear() } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('넣을 값이 올바르지 않아요.');

  if (raw.source === 'direct') {
    const day = checkDay(raw.date, year);
    const time = raw.time === undefined || raw.time === null || raw.time === '' ? DEFAULT_TIME : checkTime(raw.time);
    return { kind: 'date', date: { day, time, offset: DIRECT_OFFSET }, location: null, sourceId: null };
  }

  if (raw.source !== 'copy') throw new Error('넣는 방법이 올바르지 않아요.');
  if (!sourceRow) throw new Error('복사한 기준 사진을 찾을 수 없어요. 다시 복사해 주세요.');
  if (!Number.isInteger(raw.sourceId) || sourceRow.id !== raw.sourceId) throw new Error('복사한 기준 사진이 맞지 않아요. 다시 복사해 주세요.');

  const wantDate = raw.date === true;
  const wantTime = raw.time === true;
  const wantLocation = raw.location === true;
  if (wantTime && !wantDate) throw new Error('시간은 날짜와 함께 골라야 해요.');
  if (!wantDate && !wantLocation) throw new Error('넣을 항목을 하나 이상 골라 주세요.');

  let date = null;
  if (wantDate) {
    if (sourceRow.takenAt === null || sourceRow.takenAt === undefined) throw new Error('기준 사진에 날짜가 없어요.');
    const day = String(sourceRow.takenAt).slice(0, 10);
    let time = null;
    if (wantTime) {
      time = timeOf(sourceRow.takenAt);
      if (time === null) throw new Error('기준 사진에 시간이 없어요.');
    }
    const offset = sourceRow.takenOffset === undefined ? null : sourceRow.takenOffset;
    date = { day, time, offset };
  }

  let location = null;
  if (wantLocation) {
    if (sourceRow.lat === null || sourceRow.lat === undefined || sourceRow.lng === null || sourceRow.lng === undefined) {
      throw new Error('기준 사진에 위치가 없어요.');
    }
    location = checkLocation(sourceRow.lat, sourceRow.lng);
  }

  return { kind: date && location ? 'both' : date ? 'date' : 'location', date, location, sourceId: sourceRow.id };
}

// 'YYYY-MM-DD' + 'HH:MM:SS' 에 초를 더해서 'YYYY-MM-DDTHH:MM:SS' 글자로 돌려줘요
function addSeconds(day, time, seconds) {
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi, s] = time.split(':').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s) + seconds * 1000);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}

// 대상 순서: 지금 찍은 시각, 파일 이름, id (찍은 시각이 없는 파일은 맨 뒤)
function compareTargets(a, b) {
  const aNull = a.takenAt === null || a.takenAt === undefined;
  const bNull = b.takenAt === null || b.takenAt === undefined;
  if (aNull !== bNull) return aNull ? 1 : -1;
  if (!aNull && a.takenAt !== b.takenAt) return a.takenAt < b.takenAt ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id - b.id;
}

const present = (v) => v !== null && v !== undefined;

// 미리보기를 계산해요
//   rows: getFilesByIds 결과, resolved: normalizeRequest 결과, manualOf(path): 직접 넣은 값 또는 null
//   root: 지금 보는 백업 폴더. 다른 root 줄, 사라진 파일(missing), 기준 사진 자신은 빼고 excluded 로 세요
function planEdit(rows, resolved, manualOf, root) {
  if (rows.length > MAX_TARGETS) throw new Error(`한 번에 ${MAX_TARGETS.toLocaleString('en-US')}장까지만 넣을 수 있어요.`);

  const targets = [];
  let excluded = 0;
  for (const r of rows) {
    if (r.root !== root || r.missing || r.id === resolved.sourceId) excluded++;
    else targets.push(r);
  }
  targets.sort(compareTargets);

  const { date, location } = resolved;
  const items = [];
  const counts = { changed: 0, same: 0, overwrite: 0, excluded };

  targets.forEach((r, i) => {
    const beforeManual = manualOf(r.path) || null;
    const before = { takenAt: r.takenAt, lat: r.lat, lng: r.lng };

    // 날짜: 시간을 정했으면 기준 시각부터 +1초씩. 아니면 파일의 시각과 시간대를 유지
    let newTakenAt = r.takenAt;
    let newOffset = r.takenOffset;
    let dateChanged = false;
    if (date) {
      if (date.time !== null) {
        newTakenAt = addSeconds(date.day, date.time, i);
        newOffset = date.offset;
      } else {
        const own = timeOf(r.takenAt);
        if (own !== null) {
          newTakenAt = `${date.day}T${own}`; // 시간대는 파일 것을 그대로 둠
        } else {
          newTakenAt = `${date.day}T${DEFAULT_TIME}`;
          newOffset = date.offset;
        }
      }
      dateChanged = newTakenAt !== r.takenAt || (newOffset === undefined ? null : newOffset) !== (r.takenOffset === undefined ? null : r.takenOffset);
    }

    // 위치: 위도와 경도를 같이 비교해요 (0도 값이라서 null 인지로만 판단)
    const locationChanged = !!location && (r.lat !== location.lat || r.lng !== location.lng);

    const changed = dateChanged || locationChanged;
    const hadValue = (dateChanged && present(r.takenAt)) || (locationChanged && present(r.lat) && present(r.lng));

    // 직접 넣은 값에는 실제로 바뀌는 부분만 합쳐요 (같은 값은 "내가 넣은 값"으로 바꾸지 않음)
    let afterManual = beforeManual;
    if (changed) {
      afterManual = beforeManual
        ? { ...beforeManual }
        : { takenAt: null, takenOffset: null, lat: null, lng: null };
      if (dateChanged) {
        afterManual.takenAt = newTakenAt;
        afterManual.takenOffset = newOffset === undefined ? null : newOffset;
      }
      if (locationChanged) {
        afterManual.lat = location.lat;
        afterManual.lng = location.lng;
      }
    }

    const after = {
      takenAt: dateChanged ? newTakenAt : r.takenAt,
      lat: locationChanged ? location.lat : r.lat,
      lng: locationChanged ? location.lng : r.lng,
    };

    if (changed) counts.changed++;
    else counts.same++;
    if (hadValue) counts.overwrite++;

    items.push({
      id: r.id, path: r.path, name: r.name,
      status: changed ? 'changed' : 'same',
      hadValue,
      beforeManual, afterManual,
      before, after,
    });
  });

  return { kind: resolved.kind, items, counts };
}

// 화면에 줄 값: 파일 경로와 직접 넣은 값(manual)을 빼고, 앞 100줄만 남겨요 (나머지 개수는 more)
function toPreview(plan) {
  const items = plan.items.slice(0, PREVIEW_LINES).map((it) => ({
    id: it.id, name: it.name, status: it.status, hadValue: it.hadValue,
    before: { ...it.before }, after: { ...it.after },
  }));
  return { kind: plan.kind, counts: { ...plan.counts }, items, more: plan.items.length - items.length };
}

module.exports = { normalizeRequest, planEdit, toPreview, MAX_TARGETS };

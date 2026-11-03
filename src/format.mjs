// 파일 위치: src/format.mjs
// 역할: 화면에 보여 줄 글자 만들기 (영상 길이, 용량, 찍은 시각, 좌표, 값 넣기 버튼 글). React 없이 값만 다뤄서 점검에서도 불러 확인해요

// 영상 길이: 12.3초 → "0:12", 3725초 → "1:02:05". 모르면 빈 글자
export function formatDuration(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// 용량: 1024 단위. KB는 정수, MB부터는 소수 한 자리 (16.3 MB)
export function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// 찍은 곳 현지 시각 "2026-10-28T13:41:13" → "2026년 10월 28일 오후 1:41:13" (시간대를 건드리지 않고 글자 그대로 풀어요)
export function formatTakenAt(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(text || ''));
  if (!m) return '';
  const date = `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일`;
  if (m[4] === undefined) return date;
  const h = Number(m[4]);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${date} ${h < 12 ? '오전' : '오후'} ${hour12}:${m[5]}${m[6] === undefined ? '' : ':' + m[6]}`;
}

// 좌표: 소수점 다섯 자리까지 (약 1m). 하나라도 없으면 빈 글자
export function formatCoords(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

// 숫자에 천 단위 쉼표 (1,200)
export const formatCount = (n) => Number(n || 0).toLocaleString('ko-KR');

// ---------- 날짜와 위치 넣기 버튼 글 ----------
// 넣은 항목의 이름과, 문장에 쓸 때의 "을/를"까지 붙인 말
const KIND_NAME = { date: '날짜', location: '위치', both: '날짜와 위치' };
const KIND_OBJECT = { date: '날짜를', location: '위치를', both: '날짜와 위치를' };
const countOk = (n) => Number.isFinite(n) && n > 0;

// 미리보기 창의 실행 버튼: "124장에 위치 넣기". 바꿀 사진이 0장이거나 종류를 모르면 빈 글자
//   (화면은 빈 글자면 버튼을 끄고 "바꿀 사진이 없어요"를 보여 줘요)
export function applyLabel(count, kind) {
  return countOk(count) && KIND_NAME[kind] ? `${formatCount(count)}장에 ${KIND_NAME[kind]} 넣기` : '';
}

// 많은 장에 한 번에 넣을 때 (2026-11-04 사용자 결정: 100장 이상이면 체크를 한 번 더 받아요)
export const MANY_PHOTOS = 100;
export function needsManyCheck(count) {
  return countOk(count) && count >= MANY_PHOTOS;
}
export function manyCheckText(count) {
  return needsManyCheck(count) ? `${formatCount(count)}장에 한 번에 넣는 것이 맞아요` : '';
}

// 되돌리기 버튼: "124장 위치 되돌리기"
export function undoLabel(count, kind) {
  return countOk(count) && KIND_NAME[kind] ? `${formatCount(count)}장 ${KIND_NAME[kind]} 되돌리기` : '';
}

// 값을 넣은 직후 알림 줄의 글: "124장에 위치를 넣었어요"
export function appliedText(count, kind) {
  return countOk(count) && KIND_OBJECT[kind] ? `${formatCount(count)}장에 ${KIND_OBJECT[kind]} 넣었어요` : '';
}

// 되돌린 직후 알림 줄의 글: "4장 위치를 되돌렸어요"
export function undoneText(count, kind) {
  return countOk(count) && KIND_OBJECT[kind] ? `${formatCount(count)}장 ${KIND_OBJECT[kind]} 되돌렸어요` : '';
}

// ---------- 위치 제안 ----------
// 넣기 버튼: "4장에 이 위치 넣기". 0장이면 빈 글자
export const suggestApplyLabel = (count) => (countOk(count) ? `${formatCount(count)}장에 이 위치 넣기` : '');
// 묶음의 모든 사진을 체크하는 버튼 글: 4 → "4장 모두 체크하기"
export const checkAllLabel = (count) => `${formatCount(count)}장 모두 체크하기`;

// 근거 사진과의 시간 차이: 0 → "1분 안", 12 → "12분 차이", 65 → "1시간 5분 차이"
export function gapText(minutes) {
  if (minutes < 1) return '1분 안';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}분 차이`;
  return m ? `${h}시간 ${m}분 차이` : `${h}시간 차이`;
}

// 파일 위치: src/format.mjs
// 역할: 화면에 보여 줄 글자 만들기 (영상 길이, 용량, 찍은 시각, 좌표). React 없이 값만 다뤄서 점검에서도 불러 확인해요

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

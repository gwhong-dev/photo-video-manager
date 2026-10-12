// 파일 위치: lib/dates.js
// 역할: "찍은 날짜" 찾기
//   1순위: 사진/영상 속 촬영 정보
//   2순위: 파일 이름 속 날짜 (예: KakaoTalk_20250328_204512345.jpg)
//   없으면 null → "_날짜없음" 폴더로
//   ⚠️ 파일 수정 날짜는 믿을 수 없어서 쓰지 않아요 (다운받은 날로 바뀌어 있음)

// 촬영 정보에서 찾을 태그 (앞에서부터 먼저)
const SHOT_TAGS = ['DateTimeOriginal', 'CreationDate', 'CreateDate', 'DateCreated'];

// 이름 "맨 앞"의 날짜(+시간) 찾기
//   2016-08-01_17-59-31 / 2016-08-01_175931 / 20160801_175931 / 2016.08.01 등
const LEAD_RE =
  /^((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_. T]?([01]\d|2[0-3])[-_.:]?([0-5]\d)[-_.:]?([0-5]\d))?/;

// 파일 이름 속 날짜 찾기 (시간은 있으면 같이)
//   20250328_204512 / 2025-03-28 20.45.12 / 2025-03-28 / IMG_20250328 등
const NAME_RE =
  /(?<!\d)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_. T]?([01]\d|2[0-3])[-_.:]?([0-5]\d)[-_.:]?([0-5]\d)|(?!\d))/;

const pad = (n) => String(n).padStart(2, '0');

// 진짜 있는 날짜인지 + 너무 옛날/미래가 아닌지 확인
function makeDate(y, mo, d, h = 0, mi = 0, s = 0) {
  y = Number(y); mo = Number(mo); d = Number(d);
  h = Number(h); mi = Number(mi); s = Number(s);
  const dt = new Date(y, mo - 1, d, h, mi, s);
  if (isNaN(dt)) return null;
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null; // 2월 31일 같은 것
  if (y < 1990) return null;
  if (dt.getTime() > Date.now() + 24 * 3600 * 1000) return null; // 미래 날짜
  return { y, mo, d, h, mi, s };
}

// "2025:03:28 20:06:53+09:00" → 날짜 (시간대 글자는 무시 = 찍은 곳 현지 시간)
function parseExifDate(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return makeDate(m[1], m[2], m[3], m[4], m[5], m[6]);
}

// 1순위: 촬영 정보
function dateFromMeta(meta) {
  if (!meta) return null;
  for (const tag of SHOT_TAGS) {
    const parts = parseExifDate(meta[tag]);
    if (parts) return { parts, from: '촬영정보' };
  }
  return null;
}

// 2순위: 파일 이름
function dateFromName(fileName) {
  const m = fileName.match(NAME_RE);
  if (!m) return null;
  const parts = makeDate(m[1], m[2], m[3], m[4] || 0, m[5] || 0, m[6] || 0);
  return parts ? { parts, from: '파일이름' } : null;
}

// 날짜 → 여러 모양으로
const toPrefix = (p) => `${p.y}-${pad(p.mo)}-${pad(p.d)}_${pad(p.h)}${pad(p.mi)}${pad(p.s)}`; // 이름 앞부분
const toExif = (p) => `${p.y}:${pad(p.mo)}:${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`; // exiftool 용
const toFolders = (p) => [String(p.y), pad(p.mo), pad(p.d)]; // 2025 / 03 / 28

// 새 파일 이름 만들기 (B 규칙)
//   이름 앞의 날짜가 촬영 날짜와 같으면 → 그 부분을 빼고 우리 모양으로 통일
//     2016-08-01_17-59-31.mov       → 2016-08-01_175931.mp4
//     2016-08-01_17-59-31_여행.jpg  → 2016-08-01_175931_여행.jpg
//     2025-03-28_200653_IMG_0433.jpg → 그대로 (이미 우리 모양)
//   날짜가 없거나 촬영 날짜와 다르면 → 앞에 붙이기 (원래 정보 보존)
//     IMG_0433.HEIC → 2025-03-28_200653_IMG_0433.jpg
function buildName(base, p, newExt) {
  const prefix = toPrefix(p);

  // 이름 앞 날짜가 촬영 날짜와 같은지 (시간은 1분 차이까지 같은 걸로 봄)
  const sameAsShot = (m) => {
    if (Number(m[1]) !== p.y || Number(m[2]) !== p.mo || Number(m[3]) !== p.d) return false;
    if (m[4] === undefined) return true; // 이름에 날짜만 있음
    const a = Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6]);
    const b = p.h * 3600 + p.mi * 60 + p.s;
    return Math.abs(a - b) <= 60;
  };

  // 같은 날짜가 여러 번 붙어 있어도 전부 떼어내기 (예전에 두 번 붙은 이름도 정리)
  let rest = base;
  let stripped = false;
  for (;;) {
    const m = rest.match(LEAD_RE);
    if (!m || !sameAsShot(m)) break;
    rest = rest.slice(m[0].length).replace(/^[-_. ]+/, '');
    stripped = true;
  }

  if (!stripped) return `${prefix}_${base}${newExt}`;
  return rest ? `${prefix}_${rest}${newExt}` : `${prefix}${newExt}`;
}

// 파일 수정 날짜 → 보기 좋은 글자 (로그에 참고용으로만)
function fmtLocal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

module.exports = { SHOT_TAGS, buildName, dateFromMeta, dateFromName, toPrefix, toExif, toFolders, fmtLocal };

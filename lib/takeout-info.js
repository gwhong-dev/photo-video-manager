// 파일 위치: lib/takeout-info.js
// 역할: Google 포토 내보내기(Takeout) 폴더의 사진 옆 JSON 에서 사진별 찍은 시각 읽기
//   Takeout 은 진짜 찍은 시각을 사진 밖 JSON 의 photoTakenTime 에 두어요 (사진 파일의 수정 날짜는 내려받은 날).
//   읽기만 하고 아무것도 바꾸지 않아요. 같은 폴더 안의 JSON 만 봐요.
//
// JSON 이름 모양 (모두 같은 폴더)
//   IMG_1.jpg.json                         ← 예전 모양
//   IMG_1.jpg.supplemental-metadata.json   ← 2024년 뒤 모양
//   IMG_1.jpg.supplemental-me.json         ← 이름이 길면 중간에서 잘림 (51자 제한)
//   IMG_1.jpg(1).json                      ← 같은 이름 두 번째 사진 IMG_1(1).jpg 의 것
//   IMG_1-edited.jpg 는 JSON 이 없고 원본 IMG_1.jpg 의 JSON 을 같이 써요
//   이름이 잘려 짝을 못 찾으면 JSON 안의 title(원래 파일 이름)로 찾되, 같은 title 이 둘 이상이면 쓰지 않아요

const fs = require('fs');
const path = require('path');
const D = require('./dates');

const MAX_BYTES = 1024 * 1024; // JSON 하나가 이보다 크면 Takeout 것이 아님 (이상한 파일 방어)
const SUPP = 'supplemental-metadata';
const AMBIGUOUS = Symbol('같은 title 이 여러 개');

// "IMG_1(2).jpg" 처럼 확장자 앞에 번호 넣기
function withNumber(name, n) {
  if (!n) return name;
  const ext = path.extname(name);
  return name.slice(0, name.length - ext.length) + `(${n})` + ext;
}

// JSON 파일 이름 → 그 JSON 이 설명하는 사진 파일 이름 (모르면 null)
function mediaNameOf(jsonName) {
  let s = jsonName.replace(/\.json$/i, '');
  let n = '';
  const m = s.match(/\((\d+)\)$/);
  if (m) {
    n = m[1];
    s = s.slice(0, -m[0].length);
  }
  // 끝의 ".supplemental-metadata" (잘린 것 포함) 떼기 — 그 앞에 사진 확장자가 있을 때만
  const dot = s.lastIndexOf('.');
  if (dot > 0) {
    const tail = s.slice(dot + 1).toLowerCase();
    if (tail && SUPP.startsWith(tail) && path.extname(s.slice(0, dot))) s = s.slice(0, dot);
  }
  if (!path.extname(s)) return null; // 확장자가 없으면 사진 JSON 이 아님 (앨범 metadata.json 등)
  return withNumber(s, n);
}

// JSON 안의 찍은 시각 (초, 세계 표준시) → 날짜 { parts, from } | null
function takenOf(json) {
  const ts = json && json.photoTakenTime && json.photoTakenTime.timestamp;
  if (!/^\d{9,11}$/.test(String(ts == null ? '' : ts))) return null;
  return D.dateFromEpoch(Number(ts) * 1000, '구글정보');
}

// 폴더 하나 → { byName: Map(소문자 사진 이름 → 날짜), byTitle: Map(소문자 title → 날짜 | AMBIGUOUS) } | null (JSON 없음)
function loadTakeoutDir(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /\.json$/i.test(n));
  } catch (e) {
    return null;
  }
  if (names.length === 0) return null;
  const byName = new Map();
  const byTitle = new Map();
  for (const n of names) {
    let json;
    try {
      const file = path.join(dir, n);
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      continue; // 깨진 JSON 은 건너뜀
    }
    const found = takenOf(json);
    if (!found) continue;
    const media = mediaNameOf(n);
    if (media) byName.set(media.toLowerCase(), found);
    if (json && typeof json.title === 'string' && json.title) {
      // 번호 붙은 JSON(IMG_1.jpg(1).json)의 title 은 번호 없는 원래 이름이라, 번호를 붙여 (1) 사진 것으로 등록
      //   (안 붙이면 원본 JSON 이 빠진 폴더에서 원본 IMG_1.jpg 가 (1) 사진의 날짜를 받아요, #157 검증)
      const num = (n.replace(/\.json$/i, '').match(/\((\d+)\)$/) || [])[1];
      const t = withNumber(json.title, num).toLowerCase();
      byTitle.set(t, byTitle.has(t) ? AMBIGUOUS : found);
    }
  }
  return byName.size || byTitle.size ? { byName, byTitle } : null;
}

// 사진 이름(소문자)으로 찾기: JSON 이름 → 편집본이면 원본 이름 → title
function lookup(info, lower) {
  const direct = info.byName.get(lower);
  if (direct) return direct;
  const edited = lower.match(/^(.+)-edited(\.[^.]+)$/);
  if (edited && info.byName.get(edited[1] + edited[2])) return info.byName.get(edited[1] + edited[2]);
  const t = info.byTitle.get(lower);
  return t && t !== AMBIGUOUS ? t : null;
}

// 폴더마다 한 번만 읽어 두는 조회 함수
function createTakeoutDates() {
  const cache = new Map(); // 폴더 → 정보 | null

  // 사진 파일 경로 → 날짜 { parts, from: '구글정보' } 또는 null
  return function dateFromTakeout(filePath) {
    const dir = path.dirname(filePath);
    if (!cache.has(dir)) cache.set(dir, loadTakeoutDir(dir));
    const info = cache.get(dir);
    return info ? lookup(info, path.basename(filePath).toLowerCase()) : null;
  };
}

module.exports = { createTakeoutDates, loadTakeoutDir, mediaNameOf };

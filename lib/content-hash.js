// 파일 위치: lib/content-hash.js
// 역할: "내용 지문" — 태그 · 날짜 같은 정보를 뺀, 그림 · 영상 내용만의 지문으로 같은 사진인지 보기
//
// 왜? (2026-11-23 결정, docs/decisions/2026-11-23-태그-파일에-쓰기.md 구현 1단계)
//   백업 파일에 태그를 쓰면(이 프로그램 · 탐색기) 파일 전체의 지문(SHA1)과 크기가 바뀌어요
//   그러면 ① 원본 정리 확인에서 "백업과 지문이 달라" 원본이 남고 ② 같은 사진을 다시 가져오면 _1 로 하나 더 저장돼요
//   exiftool 의 ImageDataHash(-api ImageHashType=SHA256)는 정보 칸을 빼고 그림 · 영상 데이터만 계산해서
//   태그를 쓴 뒤에도 그대로예요 (JPG · PNG · WEBP · MP4 · MOV 시험)
//
// "같은 내용"으로 보는 조건 (둘 다 맞아야 해요)
//   1. 두 파일 모두 내용 지문을 읽었고 값이 같음
//   2. 원본에 있는 중요한 정보(촬영 날짜 · 위치 · 애플 ID · 기기 · 방향 · 가로세로)가 백업 파일에도 같은 값으로 있음
//      (백업에 정보가 더 있는 건 괜찮아요: 태그 · 프로그램이 채운 날짜. 원본 값이 바뀌었거나 없어졌으면 다른 것으로 봐요)
//   바이트 지문이 같은지는 부르는 쪽에서 먼저 봐요. 이건 바이트가 다를 때만 한 번 더 보는 비교예요
//
// 비교하지 않는 것: 변환한 파일(HEIC→JPG · MOV→MP4)은 내용 자체가 달라서 이걸로 비교할 수 없어요 (부르는 쪽에서 빼요)

const path = require('path');

const isWin = process.platform === 'win32';
// 경로 비교용 열쇠 (lib/planner.js keyOf 와 같은 규칙. planner 가 이 파일을 불러서 거꾸로 부르지 않아요)
const keyOf = (p) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));

// 원본에 있으면 백업에도 같아야 하는 정보
//   수정 시각(ModifyDate)은 넣지 않아요: 태그를 쓰는 프로그램(탐색기 등)이 바꾸기도 하는 값이에요
const KEY_TAGS = [
  'DateTimeOriginal', 'CreateDate', 'CreationDate', 'DateCreated', 'SubSecTimeOriginal', 'OffsetTimeOriginal', // 촬영 날짜
  'GPSLatitude', 'GPSLongitude', 'GPSAltitude', // 장소
  'PhotoIdentifier', 'ContentIdentifier', 'ImageUniqueID', // 고유 ID
  'Make', 'Model', // 기기
  'Orientation', 'Rotation', 'ImageWidth', 'ImageHeight', // 방향 · 가로세로 (돌려 저장한 백업은 다른 것으로 봐요)
];

// exiftool 결과 한 줄 → { hash, keys, error }
//   -G1 로 읽어서 "그룹:이름" 열쇠예요 (영상의 Keys:CreationDate 와 QuickTime:CreationDate 가 섞이지 않게)
function pickContent(m) {
  if (!m) return null;
  const out = { hash: '', keys: {}, error: '' };
  for (const [k, v] of Object.entries(m)) {
    if (k === 'SourceFile') continue;
    const name = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k;
    if (name === 'ImageDataHash') out.hash = String(v || '');
    else if (name === 'Error') out.error = String(v || '');
    else if (KEY_TAGS.includes(name)) out.keys[k] = v;
  }
  return out;
}

// 파일 여러 개의 내용 지문 · 중요한 정보 읽기 → files 와 같은 순서의 목록 (못 읽은 파일은 null)
//   et: lib/exiftool.js 의 ExifTool · ExifToolPool (run 을 써요. read 는 -api 를 더 붙일 수 없어서)
//   파일 전체를 읽어 계산해요 (큰 영상은 오래 걸림) → 바이트 지문이 다를 때만 불러요
async function readContent(et, files) {
  if (!files.length) return [];
  const args = ['-j', '-n', '-G1', '-api', 'QuickTimeUTC', '-api', 'ImageHashType=SHA256', '-ImageDataHash', ...KEY_TAGS.map((t) => '-' + t), ...files];
  const { stdout } = await et.run(args);
  const text = stdout.trim();
  let list = [];
  if (text) {
    try {
      list = JSON.parse(text);
    } catch (e) {
      throw new Error('exiftool 결과를 읽지 못했어요');
    }
  }
  const byKey = new Map();
  for (const m of list) if (m && m.SourceFile) byKey.set(keyOf(m.SourceFile), m);
  return files.map((f) => pickContent(byKey.get(keyOf(f))));
}

// 두 파일 읽은 결과로 판단 → 같으면 null, 아니면 { why, lasting }
//   lasting: true 면 다시 확인해도 같은 결과 (원본 정리에서 "규칙에 걸려 남김"으로 기록해요, lib/cleaner.js)
//            false 면 읽기 문제처럼 다음에 달라질 수 있는 것
function contentDiffWhy(a, b) {
  if (!a || !b || a.error || b.error) return { why: '내용 지문을 읽지 못해 남김', lasting: false };
  if (!a.hash || !b.hash) return { why: '이 형식은 내용 지문으로 비교할 수 없어 남김', lasting: true };
  if (a.hash !== b.hash) return { why: '백업 파일과 내용(지문)이 달라 남김', lasting: true };
  for (const [k, v] of Object.entries(a.keys)) {
    if (v == null || v === '') continue;
    if (!(k in b.keys) || String(b.keys[k]) !== String(v)) {
      return { why: `백업 파일과 그림 · 영상 내용은 같지만 정보(${k})가 달라 남김`, lasting: true };
    }
  }
  return null;
}

// src(원본)와 other(백업 파일)가 정보만 다르고 내용은 같은지 → { same, why, lasting }
//   읽다가 오류가 나면 같지 않은 것으로 봐요 (안전하게 둘 다 보존 · 원본 남김)
async function sameContent(et, src, other) {
  let r;
  try {
    const [a, b] = await readContent(et, [src, other]);
    r = contentDiffWhy(a, b);
  } catch (e) {
    r = { why: '내용 지문을 읽지 못해 남김', lasting: false };
  }
  return r ? { same: false, ...r } : { same: true, why: '', lasting: false };
}

// 미리 읽어 둔 정보로 "내용이 같을 리 없는" 쌍을 거르기 (exiftool 로 파일 전체를 읽기 전에)
//   가로 · 세로가 둘 다 있는데 다르거나(돌린 것 포함 다르면), 애플 ID 가 둘 다 있는데 다르면 false
//   모르면 true (읽어서 확인)
function mayBeSameContent(a, b) {
  if (!a || !b) return true;
  const dims = (m) => [Number(m.ImageWidth), Number(m.ImageHeight)];
  const [aw, ah] = dims(a);
  const [bw, bh] = dims(b);
  if ([aw, ah, bw, bh].every((n) => Number.isFinite(n) && n > 0) && !(aw === bw && ah === bh)) return false;
  for (const tag of ['PhotoIdentifier', 'ContentIdentifier', 'ImageUniqueID']) {
    if (a[tag] && b[tag] && String(a[tag]) !== String(b[tag])) return false;
  }
  return true;
}

module.exports = { KEY_TAGS, readContent, contentDiffWhy, sameContent, mayBeSameContent, pickContent };

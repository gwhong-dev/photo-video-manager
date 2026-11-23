// 파일 위치: lib/content-hash.js
// 역할: "내용 지문" — 태그 같은 정보를 뺀, 그림 · 영상 내용만의 지문으로 같은 사진인지 보기
//
// 왜? (2026-11-23 결정, docs/decisions/2026-11-23-태그-파일에-쓰기.md 구현 1단계)
//   백업 파일에 태그를 쓰면(이 프로그램 · 탐색기) 파일 전체의 지문(SHA1)과 크기가 바뀌어요
//   그러면 ① 원본 정리 확인에서 "백업과 지문이 달라" 원본이 남고 ② 같은 사진을 다시 가져오면 _1 로 하나 더 저장돼요
//   exiftool 의 ImageDataHash(-api ImageHashType=SHA256)는 정보 칸을 빼고 그림 · 영상 데이터만 계산해서
//   태그를 쓴 뒤에도 그대로예요 (JPG · PNG · WEBP · MP4 · MOV 시험)
//
// "같은 내용"으로 보는 조건 (모두 맞아야 해요)
//   1. 두 파일 모두 내용 지문을 읽었고 값이 같음
//   2. 원본의 정보가 백업 파일에도 모두 같은 값으로 있음 (촬영 날짜 · 위치 · 기기 · 색 정보(ICC) · 제조사 정보 · 설명 등 전부)
//      태그를 쓰면 바뀌는 칸(키워드 · 수정 시각 · 쓴 프로그램 · 자리 정보)만 빼고 봐요 (IGNORE_* 아래)
//      백업에 정보가 더 있는 건 괜찮아요 (태그 · 프로그램이 채운 날짜). 원본 값이 바뀌었거나 없어졌으면 다른 것으로 봐요
//   3. 그림 · 영상 뒤에 붙은 데이터가 없음 (모션 포토 영상 · 다른 프로그램이 붙인 데이터)
//      ImageDataHash 는 JPG 끝(FFD9) 뒤에 붙은 데이터를 계산에 넣지 않아서, 백업에 그게 빠져도 지문이 같아요
//      → 붙은 데이터가 있으면 이걸로 비교하지 않고 남겨요 (2026-11-23 검증에서 찾음)
//   바이트 지문이 같은지는 부르는 쪽에서 먼저 봐요. 이건 바이트가 다를 때만 한 번 더 보는 비교예요
//
// 비교하지 않는 것: 변환한 파일(HEIC→JPG · MOV→MP4)은 내용 자체가 달라서 이걸로 비교할 수 없어요 (부르는 쪽에서 빼요)

const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';
// 경로 비교용 열쇠 (lib/planner.js keyOf 와 같은 규칙. planner 가 이 파일을 불러서 거꾸로 부르지 않아요)
const keyOf = (p) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));

// 비교에서 빼는 그룹: 파일 자체 정보(크기 · 시각) · exiftool 이 만든 값 · 다른 칸에서 계산한 값
const IGNORE_GROUPS = new Set(['System', 'File', 'ExifTool', 'Composite', 'XMP-microsoft', 'XMP-xmpMM']);
// 비교에서 빼는 칸: 태그 · 별점을 쓰는 프로그램(이 프로그램 · 탐색기 · 라이트룸)이 바꾸거나 새로 만드는 값
const IGNORE_NAMES = new Set([
  'XMPToolkit', 'Subject', 'Keywords', 'HierarchicalSubject', 'XPKeywords', 'CatalogSets', 'Category', // 키워드
  'Rating', 'RatingPercent', // 별점
  'MetadataDate', 'ModifyDate', // 수정 시각
  'Padding', 'OffsetSchema', // 정보 칸 여유 자리
  'ApplicationRecordVersion', 'CodedCharacterSet', 'EnvelopeRecordVersion', 'IPTCDigest', 'CurrentIPTCDigest', // IPTC 를 새로 만들 때 생김
]);
// 파일 안 위치 값 (정보 칸 크기가 바뀌면 같이 바뀜): ThumbnailOffset · MediaDataOffset · PreviewImageStart 등
const IGNORE_NAME_RE = /(Offsets?|Start)$/;

// 내용 지문을 계산할 수 있는 형식 (이 형식인데 지문이 없으면 읽기 문제로 보고 다음에 다시 확인)
const HASHABLE = new Set(['JPEG', 'PNG', 'TIFF', 'HEIC', 'HEIF', 'AVIF', 'MOV', 'MP4', 'M4V', '3GP', '3G2', 'WEBP', 'AVI', 'JXL', 'CR2', 'CR3', 'NEF', 'ARW', 'DNG', 'ORF', 'RW2']);

function ignoreTag(group, name) {
  return IGNORE_GROUPS.has(group) || IGNORE_NAMES.has(name) || IGNORE_NAME_RE.test(name);
}

// exiftool 결과 한 줄 → { hash, type, warn, error, tags }
//   -G1 로 읽어서 "그룹:이름" 열쇠예요 (영상의 Keys:CreationDate 와 QuickTime:CreationDate 가 섞이지 않게)
function pickContent(m) {
  if (!m) return null;
  const out = { hash: '', type: '', warn: '', error: '', tags: {} };
  for (const [k, v] of Object.entries(m)) {
    if (k === 'SourceFile') continue;
    const i = k.indexOf(':');
    const group = i >= 0 ? k.slice(0, i) : '';
    const name = i >= 0 ? k.slice(i + 1) : k;
    if (name === 'ImageDataHash') out.hash = String(v || '');
    else if (name === 'FileType' && group === 'File') out.type = String(v || '');
    else if (name === 'Error') out.error = String(v || '');
    else if (name === 'Warning') out.warn = String(v || '');
    else if (!ignoreTag(group, name)) out.tags[k] = v;
  }
  return out;
}

// 파일 끝 몇 바이트로 "그림 뒤에 붙은 데이터"가 있는지 보기 (exiftool 이 JPG 뒤 데이터는 경고도 안 줘요)
//   JPG: 끝이 FFD9(그림 끝 표시) 여야 함 (뒤에 0 으로 채운 것은 괜찮음)
//   PNG: 끝이 IEND 덩어리여야 함
//   그 밖(영상 · HEIC 등)은 exiftool 경고("trailer")로 봐요
const PNG_END = Buffer.from('0000000049454e44ae426082', 'hex');
function hasTrailer(file, type, warn) {
  if (/trailer/i.test(warn || '')) return true;
  if (type !== 'JPEG' && type !== 'PNG') return false;
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, 4096);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    if (type === 'PNG') return !(n >= 12 && buf.subarray(n - 12).equals(PNG_END));
    let end = n;
    while (end > 0 && buf[end - 1] === 0) end--;
    return !(end >= 2 && buf[end - 2] === 0xff && buf[end - 1] === 0xd9);
  } finally {
    fs.closeSync(fd);
  }
}

// 읽은 결과 잠깐 기억 (2026-11-23 검증 지적: 미리보기에서 같은 원본을 이름이 겹칠 때마다 다시 읽음)
//   열쇠 = 경로 + 크기 + 수정 · 변경 시각 → 파일이 바뀌면 다시 읽어요. 오래된 것부터 지워 500개까지만
const CACHE_MAX = 500;
const cache = new Map();
function cacheKey(f) {
  try {
    const st = fs.statSync(f);
    return `${keyOf(f)}|${st.size}|${st.mtimeMs}|${st.ctimeMs}`;
  } catch (e) {
    return '';
  }
}

// 파일 여러 개의 내용 지문 · 정보 읽기 → files 와 같은 순서의 목록 (못 읽은 파일은 null)
//   et: lib/exiftool.js 의 ExifTool · ExifToolPool (run 을 써요. read 는 -api 를 더 붙일 수 없어서)
//   파일 전체를 읽어 계산해요 (큰 영상은 오래 걸림) → 바이트 지문이 다를 때만 불러요
async function readContent(et, files) {
  if (!files.length) return [];
  const keys = files.map(cacheKey);
  const need = files.filter((f, i) => !keys[i] || !cache.has(keys[i]));
  const byKey = new Map();
  if (need.length) {
    const args = ['-j', '-a', '-n', '-G1', '-api', 'QuickTimeUTC', '-api', 'ImageHashType=SHA256', '-all', '-ImageDataHash', ...need];
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
    for (const m of list) if (m && m.SourceFile) byKey.set(keyOf(m.SourceFile), m);
  }
  return files.map((f, i) => {
    if (keys[i] && cache.has(keys[i])) return cache.get(keys[i]);
    const r = pickContent(byKey.get(keyOf(f)));
    if (r && !r.error) {
      try {
        r.trailer = hasTrailer(f, r.type, r.warn);
      } catch (e) {
        r.error = '파일 끝을 읽지 못했어요';
      }
    }
    // 오류 없이 읽은 것만 기억 (읽기 문제는 다음에 다시)
    if (r && !r.error && !r.warn && keys[i]) {
      cache.set(keys[i], r);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return r;
  });
}

// 두 파일 읽은 결과로 판단 → 같으면 null, 아니면 { why, lasting }
//   a = 원본(남길지 정할 파일), b = 백업 파일
//   lasting: true 면 다시 확인해도 같은 결과 (원본 정리에서 "규칙에 걸려 남김"으로 기록해요, lib/cleaner.js)
//            false 면 읽기 문제처럼 다음에 달라질 수 있는 것 (경고가 있으면 복사 중 · 잘린 파일일 수 있어 false)
// 잘리거나 복사 중인 파일로 보이는 경고 (그냥 "뒤에 데이터가 있음" · [minor] 경고는 아님)
function brokenWarn(w) {
  if (!w) return false;
  if (/truncat|corrupt|format error/i.test(w)) return true;
  return !(/trailer/i.test(w) || /^\[minor\]/.test(w));
}

function contentDiffWhy(a, b) {
  if (!a || !b || a.error || b.error) return { why: '내용 지문을 읽지 못해 남김', lasting: false };
  if (brokenWarn(a.warn) || brokenWarn(b.warn)) return { why: '파일이 잘렸거나 아직 복사 중일 수 있어 남김', lasting: false };
  if (a.trailer || b.trailer) return { why: '그림 · 영상 뒤에 붙은 데이터(모션 포토 등)가 있어 내용 지문으로 비교할 수 없어 남김', lasting: true };
  if (!a.hash || !b.hash) {
    const odd = HASHABLE.has(a.type) || HASHABLE.has(b.type);
    return odd ? { why: '내용 지문을 읽지 못해 남김', lasting: false } : { why: '이 형식은 내용 지문으로 비교할 수 없어 남김', lasting: true };
  }
  if (a.hash !== b.hash) return { why: '백업 파일과 내용(지문)이 달라 남김', lasting: true };
  for (const [k, v] of Object.entries(a.tags)) {
    if (v == null || v === '') continue;
    if (!(k in b.tags) || JSON.stringify(b.tags[k]) !== JSON.stringify(v)) {
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

module.exports = { readContent, contentDiffWhy, sameContent, mayBeSameContent, pickContent, hasTrailer };

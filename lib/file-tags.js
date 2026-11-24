// 파일 위치: lib/file-tags.js
// 역할: 사진 · 영상 파일 안의 태그(키워드) 읽기와 쓰기 (2026-11-24, 31 ②)
//   설계: docs/decisions/2026-11-23-태그-파일에-쓰기.md
//
// 어디에 쓰나요? (다른 프로그램 · 휴대폰에서도 보이게, 표준 칸 여러 곳에 같은 목록을 써요)
//   JPG                        : XMP 키워드(dc:subject) + IPTC 키워드(UTF-8) + 윈도우 탐색기 태그(XPKeywords)
//   PNG · WEBP · GIF · TIFF · DNG · HEIC : XMP 키워드
//   MP4 · MOV · M4V · 3GP      : XMP 키워드 + 윈도우 탐색기 영상 태그(Microsoft:Category)
//   BMP · AVI · MKV · WMV 등   : 쓸 수 없어요 → 이 PC 의 DB 에만 남아요 (화면에 ⚠️ 로 알려요)
//
// 쓸 때 규칙
//   - 목록 전체를 매번 통째로 써요 (더하기 · 빼기가 아님). 그래서 되돌리기 = 이전 목록을 다시 쓰기
//   - 파일에 이미 있던 종류 태그(사진 · 비디오 · 스크린샷)는 그대로 남겨요 (PhotoSync 가 붙인 것)
//   - -P: 파일 수정 시각 · 만든 시각을 바꾸지 않아요
//   - 원래 파일은 바로 고치지 않아요: 옆에 "이름_exiftool_tmp" 로 새로 만들어(-o) 그 사본을 다시 읽어
//     ① 태그가 그대로 들어갔는지 ② 그림 · 영상 내용 지문이 그대로인지 ③ 영상은 재생되는지 확인한 뒤에만 원래 파일과 바꿔 끼워요
//     → 확인에 실패하거나 쓰는 도중 꺼져도 원래 파일은 그대로예요 (확인 못 한 사본만 지워요)
//   - IPTC 키워드는 한 개에 64바이트까지라 (한글 약 21자) 그보다 긴 태그는 IPTC 에만 안 써요 (잘린 이름이 남지 않게)

const fs = require('fs');
const path = require('path');
const { tidyTagName } = require('./manual-tags');
const { readContent } = require('./content-hash');

// 앱이 자동으로 붙이는 종류 태그 (lib/library.js 와 같은 목록)
const MEDIA_TYPE_TAGS = ['사진', '비디오', '스크린샷'];

// 읽을 칸 (lib/library.js 가 폴더를 읽을 때 같이 읽어요). -j 결과의 열쇠는 그룹 없는 이름이에요
//   XMP-dc:Subject → Subject, IPTC:Keywords → Keywords, XPKeywords, Microsoft:Category → Category
const READ_FIELDS = ['XMP-dc:Subject', 'IPTC:Keywords', 'XPKeywords', 'Microsoft:Category'];

// 확장자 → 쓰는 방식 ('jpg' | 'xmp' | 'video'). 없으면 쓸 수 없는 형식
const KIND_BY_EXT = {
  '.jpg': 'jpg', '.jpeg': 'jpg',
  '.png': 'xmp', '.webp': 'xmp', '.gif': 'xmp', '.tif': 'xmp', '.tiff': 'xmp', '.dng': 'xmp', '.heic': 'xmp', '.heif': 'xmp',
  '.mp4': 'video', '.mov': 'video', '.m4v': 'video', '.3gp': 'video',
};
// 내용으로 본 진짜 종류(FileType) → 쓰는 방식 (확장자와 내용이 다른 파일은 내용을 따라요)
const KIND_BY_TYPE = {
  JPEG: 'jpg',
  PNG: 'xmp', WEBP: 'xmp', GIF: 'xmp', TIFF: 'xmp', DNG: 'xmp', HEIC: 'xmp', HEIF: 'xmp',
  MP4: 'video', MOV: 'video', M4V: 'video', '3GP': 'video',
};
const writableKind = (p) => KIND_BY_EXT[path.extname(p).toLowerCase()] || null;
const canWrite = (p) => writableKind(p) !== null;

// 값 하나 또는 목록 → 글자 목록
const listOf = (v) => (v == null ? [] : [].concat(v)).map((x) => String(x));

// 읽은 정보 → { tags: 종류 태그를 뺀 태그 이름 목록(정렬), media: 파일에 있는 종류 태그 목록 }
//   XMP · IPTC · 영상 태그 칸을 모두 합쳐요. 탐색기 태그(XPKeywords)는 ; 로 이어 적혀 있어서
//   XMP 키워드가 없을 때만 나눠서 읽어요 (태그 이름 안의 ; 가 둘로 갈라지지 않게)
function tagsFromMeta(meta) {
  const names = [];
  if (meta) {
    const subject = listOf(meta.Subject);
    names.push(...subject, ...listOf(meta.Keywords), ...listOf(meta.Category));
    if (!subject.length) for (const v of listOf(meta.XPKeywords)) names.push(...v.split(';'));
  }
  const tags = new Set();
  const media = new Set();
  for (const raw of names) {
    const name = tidyTagName(raw); // 띄어쓰기 글자가 달라도 같은 태그로
    if (!name) continue;
    if (MEDIA_TYPE_TAGS.includes(name)) media.add(name);
    else tags.add(name);
  }
  return { tags: [...tags].sort(), media: [...media].sort() };
}

const sameList = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

// exiftool 에 줄 쓰기 인자 (파일 경로는 맨 끝에 부르는 쪽이 붙여요)
//   names: 쓸 태그 전체(종류 태그 포함). 빈 목록이면 그 칸들을 비워요
const IPTC_MAX_BYTES = 64;
const fitsIptc = (n) => Buffer.byteLength(n, 'utf8') <= IPTC_MAX_BYTES;
function writeArgs(kind, names) {
  const a = ['-P', '-XMP-dc:Subject='];
  for (const n of names) a.push(`-XMP-dc:Subject=${n}`);
  if (kind === 'jpg') {
    // IPTC 는 글자 방식을 UTF-8 로 적어 둬야 한글이 다른 프로그램에서 깨지지 않아요
    a.push('-charset', 'iptc=UTF8', '-IPTC:CodedCharacterSet=UTF8', '-IPTC:Keywords=');
    for (const n of names.filter(fitsIptc)) a.push(`-IPTC:Keywords=${n}`);
    a.push(`-XPKeywords=${names.join(';')}`);
  }
  if (kind === 'video') {
    a.push('-Microsoft:Category=');
    for (const n of names) a.push(`-Microsoft:Category=${n}`);
  }
  return a;
}

// 파일 서명 (크기 · 수정 시각) — DB 의 size, mtime_ms 와 비교해요
function statOf(p) {
  try {
    const s = fs.statSync(p);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch (e) {
    return null;
  }
}

// 쓸 때 만드는 사본 이름 (원래 파일 이름 + _exiftool_tmp)
const tempOf = (p) => `${p}_exiftool_tmp`;

// 지금 파일의 태그 읽기 → { type, tags, media } (못 읽으면 오류)
async function readFileTags(et, p) {
  const { stdout } = await et.run(['-j', '-FileType', ...READ_FIELDS.map((t) => `-${t}`), p]);
  let m;
  try {
    m = JSON.parse(stdout.trim())[0];
  } catch (e) {
    throw new Error('파일 정보를 읽지 못했어요');
  }
  if (!m) throw new Error('파일 정보를 읽지 못했어요');
  return { type: String(m.FileType || '').toUpperCase(), ...tagsFromMeta(m) };
}

// 파일 하나에 태그 목록 쓰기
//   p: 파일 경로, list: 쓸 태그(종류 태그 뺀 것), expect: { size, mtimeMs } 미리보기 때(DB) 서명 — 다르면 쓰지 않아요
//   opts.probe(경로) → { ok }: 영상 재생 확인 (lib/tools.js probeVideo). 없으면 영상 확인을 건너뛰어요
//   opts.onBefore({ before }): 실제로 쓰기 직전에 불러요 (로그에 먼저 적으려고)
//   → { ok: true, before, after, stat, verified } 또는 { ok: false, why, lasting, before? }
//     verified: 쓰기 전 · 뒤 내용 지문을 실제로 비교해 같았음 (GIF 처럼 지문을 못 만드는 형식은 false)
//       → 가져오기 기록의 서명 · 지문을 새로 고치는 일은 verified 일 때만 해요
//     lasting: true = 다시 해도 같은 결과(쓸 수 없는 형식 등) / false = 파일이 바뀜 · 읽기 문제처럼 다시 해 볼 만한 것
async function writeFileTags(et, p, list, expect, opts = {}) {
  const now = statOf(p);
  if (!now) return { ok: false, why: '파일이 없어요', lasting: false };
  if (expect && (now.size !== expect.size || Math.abs(now.mtimeMs - expect.mtimeMs) > 1)) {
    return { ok: false, why: '폴더를 읽은 뒤 파일이 바뀌었어요. 폴더를 다시 읽은 뒤 써 주세요', lasting: false };
  }
  let cur;
  try {
    cur = await readFileTags(et, p);
  } catch (e) {
    return { ok: false, why: e.message, lasting: false };
  }
  // opts.plan(지금 파일 태그) → 쓸 목록: 쓰기 직전에 파일에서 바뀐 태그를 목록에 합치고 그 목록을 써요
  if (opts.plan) list = opts.plan(cur.tags);
  const kind = KIND_BY_TYPE[cur.type] || null;
  if (!kind || !writableKind(p)) return { ok: false, why: `이 형식(${cur.type || path.extname(p)})은 파일에 태그를 쓸 수 없어요`, lasting: true, before: cur.tags };
  // 이미 같으면 쓰지 않아요 (파일을 건드리지 않음)
  if (sameList(cur.tags, list)) return { ok: true, same: true, list, before: cur.tags, after: cur.tags, stat: now };

  // 그림 · 영상 내용 지문 (쓰기 전) — 쓴 뒤와 같아야 해요
  let [c0] = await readContent(et, [p]).catch(() => [null]);
  const hash0 = c0 && !c0.error ? c0.hash : null;

  // 사본 이름 (쓰다 꺼져서 남은 것은 leftoverTemps 로 찾아 휴지통으로 옮겨요)
  const tmp = tempOf(p);
  if (fs.existsSync(tmp)) return { ok: false, why: '지난번에 남은 임시 파일이 있어서 쓰지 않았어요', lasting: false, before: cur.tags };

  if (opts.onBefore) opts.onBefore({ before: cur.tags });
  const names = [...cur.media, ...list];
  // 확인에 실패하면 이 사본만 지워요 (방금 만든, 확인 못 한 사본이에요. 원래 파일은 그대로)
  const fail = (why) => {
    try { fs.rmSync(tmp, { force: true }); } catch (e) { /* 다음에 leftoverTemps 가 찾아요 */ }
    return { ok: false, why, lasting: false, before: cur.tags };
  };
  try {
    await et.write([...writeArgs(kind, names), '-o', tmp, p]);
  } catch (e) {
    return fail(`쓰지 못했어요 (${String(e.message || e).split('\n')[0].slice(0, 200)})`);
  }

  // 사본을 다시 읽어 확인
  let back;
  try {
    back = await readFileTags(et, tmp);
  } catch (e) {
    return fail(`쓴 뒤 다시 읽지 못했어요 (${e.message})`);
  }
  if (!sameList(back.tags, list)) return fail('쓴 뒤 다시 읽은 태그가 달라요');
  if (hash0) {
    const [c1] = await readContent(et, [tmp]).catch(() => [null]);
    if (!c1 || c1.error || c1.hash !== hash0) return fail('쓴 뒤 그림 · 영상 내용 지문이 달라졌어요');
  }
  if (kind === 'video' && opts.probe) {
    const r = await opts.probe(tmp);
    if (r && r.ok === false) return fail(`쓴 뒤 영상이 재생되지 않아요 (${r.reason})`);
  }
  // 바꿔 끼우기 직전에 원래 파일이 그사이 바뀌지 않았는지 한 번 더 봐요
  const still = statOf(p);
  if (!still || still.size !== now.size || still.mtimeMs !== now.mtimeMs) return fail('쓰는 동안 파일이 바뀌었어요');
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    return fail(`원래 파일과 바꿔 끼우지 못했어요 (${e.code || e.message})`);
  }
  return { ok: true, list, before: cur.tags, after: back.tags, stat: statOf(p), verified: !!hash0 };
}

// 지난번에 쓰다 꺼져서 남은 exiftool 임시 파일 ("이름_exiftool_tmp") 찾기
//   파일 이름 그대로 원래 파일이 옆에 있을 때만 골라요 (원래 파일이 없으면 그게 유일한 사본일 수 있어 건드리지 않아요)
//   지우지 않고 목록만 돌려줘요 (부르는 쪽에서 휴지통으로 옮겨요)
function leftoverTemps(files) {
  const out = [];
  for (const p of files) {
    const tmp = tempOf(p);
    try {
      // 원래 파일과 임시 파일이 둘 다 있을 때만 (원래 파일이 없으면 임시 파일이 유일한 사본일 수 있어요)
      if (fs.statSync(p).isFile() && fs.statSync(tmp).isFile()) out.push(tmp);
    } catch (e) { /* 둘 중 하나가 없음 */ }
  }
  return out;
}

module.exports = {
  MEDIA_TYPE_TAGS, READ_FIELDS, writableKind, canWrite, tagsFromMeta, writeArgs, readFileTags, writeFileTags, leftoverTemps, sameList, fitsIptc,
};

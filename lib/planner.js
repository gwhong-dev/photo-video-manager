// 파일 위치: lib/planner.js
// 역할: 미리보기 계획 만들기 (⚠️ 읽기만 함! 파일은 하나도 안 바꿔요)
//
// 파일마다 정하는 것
//   - 작업 종류: HEIC→JPG / MOV→MP4 / 복사(이름만 변경)
//   - 찍은 날짜 → 새 이름 (2025-03-28_200653_IMG_0433.jpg)
//   - 갈 위치 → 백업폴더\2025\03\28  (날짜 없으면 _날짜없음)
//   - 이름이 겹치면 → 중복인지 확인 → 중복이면 건너뜀, 다르면 _1

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const D = require('./dates');
const { sameFile } = require('./paths');
const { createAlbumDates } = require('./album-info');
const { sameContent, mayBeSameContent } = require('./content-hash');

// 처리할 확장자
const PHOTO_EXT = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.dng'];
const VIDEO_EXT = ['.mov', '.mp4', '.m4v', '.avi', '.mkv', '.wmv', '.3gp'];

// 영상 파일인지 (확장자로 판단)
const isVideoPath = (p) => VIDEO_EXT.includes(path.extname(p).toLowerCase());

// exiftool 이 파일 "내용"(앞 바이트)으로 알아낸 종류(FileType) → 맞는 확장자
//   예) 이름은 .JPG 인데 앞 바이트가 "ftyp qt" 면 FileType 은 MOV (라이브 포토 영상) (2026-11-18 실사용)
//   목록에 없는 종류이거나 못 읽었으면 확장자를 그대로 믿어요
const CONTENT_EXT = {
  JPEG: '.jpg', PNG: '.png', HEIC: '.heic', HEIF: '.heic', GIF: '.gif', BMP: '.bmp', WEBP: '.webp', TIFF: '.tif', DNG: '.dng',
  MOV: '.mov', MP4: '.mp4', M4V: '.m4v', AVI: '.avi', MKV: '.mkv', WMV: '.wmv', '3GP': '.3gp',
};
// 같은 종류로 보는 확장자 (.jpeg = .jpg, .tiff = .tif, .heif = .heic)
//   HEIC 와 HEIF 는 같은 형식이에요. 일부 안드로이드 HEIC(mif1)는 exiftool 이 HEIF 라고 해요 (#124 검증 ⚠️)
const SAME_EXT = { '.jpeg': '.jpg', '.tiff': '.tif', '.heif': '.heic' };

// 내용 기준 확장자. 확장자가 내용과 맞거나 내용을 모르면 확장자 그대로
//   사진 ↔ 영상이 바뀐 것, 사진끼리 형식이 다른 것(내용 JPEG 인 .HEIC 등)만 내용을 따라요
//   영상끼리(내용 MOV 인 .mp4 등)는 지금처럼 확장자대로 둬요 (재생 · 변환에 문제가 없고, 이미 가져온 파일의 판단이 바뀌지 않게)
function contentExt(ext, fileType) {
  const real = CONTENT_EXT[String(fileType || '').toUpperCase()];
  if (!real || (SAME_EXT[ext] || ext) === real) return ext;
  if (VIDEO_EXT.includes(ext) && VIDEO_EXT.includes(real)) return ext;
  return real;
}
// 정보(meta)의 내용이 영상인지
const isVideoContent = (meta) => !!meta && VIDEO_EXT.includes(CONTENT_EXT[String(meta.FileType || '').toUpperCase()] || '');

const NO_DATE_DIR = '_날짜없음';
const MOVED_DIR = '_정리완료원본'; // 휴지통 없는 드라이브에서 정리한 원본을 옮겨 두는 곳 (다시 읽지 않음)

// 읽어 올 정보 (날짜 + 중복 판단용 + 로그 참고용)
const META_TAGS = [
  ...D.SHOT_TAGS,
  'PhotoIdentifier', 'ImageUniqueID', 'ContentIdentifier', // 고유 ID
  'Model', 'SubSecTimeOriginal',                           // 기기, 0.001초
  'GPSLatitude#', 'GPSLongitude#',                         // 장소 (숫자로)
  'XMP-dc:Subject',                                        // 태그 (PhotoSync 앨범 이름, 미디어 종류)
  'FileType',                                              // 내용으로 본 진짜 종류 (확장자와 다를 수 있어요)
];
// 가로 · 세로: 같은 촬영이라도 원본이 백업에 있는 것보다 크면 가져오려고 읽어요 (개선 11)
const DIM_TAGS = ['ImageWidth', 'ImageHeight'];
// 같은 촬영 비교용 (작업 기록에 담는 원본 정보 · 백업에 이미 있는 파일 읽기 · 실행 직전 확인이 같이 써요)
const COMPARE_TAGS = ['PhotoIdentifier', 'ImageUniqueID', 'ContentIdentifier', 'Model', 'SubSecTimeOriginal', ...DIM_TAGS];

// 건너뛸 폴더 이름
const SKIP_DIRS = ['$RECYCLE.BIN', 'System Volume Information'];

const isWin = process.platform === 'win32';
// 경로 비교용 열쇠 (윈도우는 대소문자 구분 안 함)
const keyOf = (p) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));

// a 폴더가 b 폴더 안(또는 같은 곳)에 있는지
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// 작업 종류 & 새 확장자
function kindOf(ext) {
  if (ext === '.heic' || ext === '.heif') return { kind: 'heic2jpg', newExt: '.jpg', label: 'HEIC→JPG' };
  if (ext === '.mov') return { kind: 'mov2mp4', newExt: '.mp4', label: 'MOV→MP4' };
  return { kind: 'copy', newExt: ext === '.jpeg' ? '.jpg' : ext, label: '이름만' };
}

// ---------- 1) 파일 찾기 ----------
// 들어가지 않을 폴더인지 (walk와 walkAsync가 같은 규칙을 써요)
function skipDir(name, full, excludeDirs) {
  if (name.startsWith('.') || SKIP_DIRS.includes(name) || name === MOVED_DIR) return true;
  if (/^\d{4}년도$/.test(name)) return true; // "2025년도" 같은 후가공 폴더는 절대 안 건드림
  return excludeDirs.some((x) => keyOf(x) === keyOf(full));
}

// 처리할 사진/영상 파일이면 확장자를, 아니면 null (숨김/작업중 파일 제외)
function mediaExt(name) {
  if (name.startsWith('.') || name.includes('.__tmp__')) return null;
  const ext = path.extname(name).toLowerCase();
  return PHOTO_EXT.includes(ext) || VIDEO_EXT.includes(ext) ? ext : null;
}

const fileInfo = (full, st, ext) => ({ path: full, size: st.size, mtimeMs: st.mtimeMs, ext, isVideo: VIDEO_EXT.includes(ext) });

// onDirError(dir): 못 읽은 폴더(또는 그 안의 파일 정보를 못 읽은 폴더)를 알려 줘요 (선택).
//   갤러리가 "읽다 만 폴더 안의 파일을 없어졌다고 착각"하지 않으려고 써요. 못 읽어도 하던 일은 계속해요
function walk(root, includeSub, excludeDirs, onCount, onDirError) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (onDirError) onDirError(dir);
      continue; // 권한 없는 폴더는 건너뛰기
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (includeSub && !skipDir(ent.name, full, excludeDirs)) stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = mediaExt(ent.name);
      if (!ext) continue;
      try {
        files.push(fileInfo(full, fs.statSync(full), ext));
      } catch (e) {
        if (onDirError) onDirError(dir); // 파일 정보를 못 읽음 → 이 폴더는 끝까지 읽지 못한 걸로 알림
        continue;
      }
      if (onCount && files.length % 500 === 0) onCount(files.length);
    }
  }
  return files;
}

// walk와 같은 규칙인데 fs.promises로 하나씩 차례로 읽어요 (USB 드라이브에서도 앱 화면이 멈추지 않게)
//   갤러리 폴더 읽기에서만 써요. 가져오기는 walk 그대로예요
async function walkAsync(root, includeSub, excludeDirs, onCount, onDirError) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (onDirError) onDirError(dir);
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (includeSub && !skipDir(ent.name, full, excludeDirs)) stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = mediaExt(ent.name);
      if (!ext) continue;
      try {
        files.push(fileInfo(full, await fsp.stat(full), ext));
      } catch (e) {
        if (onDirError) onDirError(dir);
        continue;
      }
      if (onCount && files.length % 500 === 0) onCount(files.length);
    }
  }
  return files;
}

// ---------- 2) 정보 한꺼번에 읽기 (500개씩) ----------
//   et 가 여러 개를 켜 둔 것(ExifToolPool, size)이면 묶음 여러 개를 동시에 읽어요 (파일이 많을 때 미리보기가 빨라져요)
//   결과는 묶음 순서대로 합쳐요 (동시에 읽어도 같은 결과)
async function readMetaMap(et, paths, tags, onProgress) {
  const chunks = [];
  for (let i = 0; i < paths.length; i += 500) chunks.push(paths.slice(i, i + 500));
  const results = new Array(chunks.length);
  let next = 0;
  let read = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const n = next++;
      results[n] = await et.read(chunks[n], tags);
      read += chunks[n].length;
      if (onProgress) onProgress(read, paths.length);
    }
  };
  const lanes = Math.min(Math.max(1, et.size || 1), chunks.length);
  await Promise.all(Array.from({ length: lanes }, worker));
  const map = new Map();
  for (const list of results) for (const m of list || []) map.set(keyOf(m.SourceFile), m);
  return map;
}

// 정보 읽기 + 영상의 Keys:CreationDate 합치기 (가져오기 계획과 갤러리 읽기가 같이 써요)
//   files: walk()가 돌려준 목록 ({ path, isVideo }). 결과: Map<keyOf(경로), 정보>
//   영상의 진짜 "찍은 시각"은 Keys:CreationDate (QuickTime CreateDate는 전송한 시각)
//   exiftool 결과에는 그룹 이름이 빠져서 다른 CreationDate와 섞일 수 있어요 → 영상만 따로 한 번 더 읽어 KeysCreationDate로 넣어요
//   onKeysProgress(읽은 수, 전체): 영상 촬영일 읽기 진행 (없어도 돼요)
async function readMetaWithKeys(et, files, tags, onProgress, onKeysProgress) {
  const metaMap = await readMetaMap(et, files.map((f) => f.path), tags, onProgress);
  // 이름은 사진이어도 내용이 영상이면(FileType 을 읽은 경우) 영상 촬영일도 읽어요
  const videoPaths = files.filter((f) => f.isVideo || isVideoContent(metaMap.get(keyOf(f.path)))).map((f) => f.path);
  if (onKeysProgress) onKeysProgress(0, videoPaths.length);
  const keysMap = await readMetaMap(et, videoPaths, ['Keys:CreationDate'], onKeysProgress);
  for (const [k, keys] of keysMap) {
    if (keys.CreationDate) metaMap.set(k, { ...(metaMap.get(k) || {}), KeysCreationDate: keys.CreationDate });
  }
  return metaMap;
}

// ---------- 중복 판단 도우미 ----------

// 파일 지문(해시) — 같은 파일은 다시 계산 안 하게 기억
const hashCache = new Map();
function fileHash(p) {
  const k = keyOf(p);
  if (hashCache.has(k)) return hashCache.get(k);
  const job = new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(p)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
  hashCache.set(k, job);
  return job;
}

async function sameBytes(a, b) {
  try {
    const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
    if (sa.size !== sb.size) return false;
    const [ha, hb] = await Promise.all([fileHash(a), fileHash(b)]);
    return ha === hb;
  } catch (e) {
    return false; // 못 읽으면 "다른 파일"로 보고 안전하게 둘 다 보존
  }
}

// 같은 촬영인지 — 애플 고유 ID로만 판단 (명세: 기기·GPS 정보는 판단에 안 써요)
//   둘 중 하나라도 ID가 없으면 "다른 촬영" → 지문(해시)이 다르면 _1로 둘 다 보존
function sameShot(a, b) {
  if (!a || !b) return false;
  const idA = a.PhotoIdentifier || a.ImageUniqueID || a.ContentIdentifier;
  const idB = b.PhotoIdentifier || b.ImageUniqueID || b.ContentIdentifier;
  return !!(idA && idB && idA === idB);
}

// 원본(a)이 다른 파일(b)보다 화소가 많은지 — 같은 촬영인데 백업에는 작은 사본만 있는 경우 (개선 11)
//   예) iCloud 공유 앨범 축소본: 사진 1536x2048 · 라이브 포토 영상 960x720, 원본은 4032x3024 · 1920x1440
//   가로×세로를 곱해서 비교해요 (세로로 돌린 것도 같게). 둘 중 하나라도 모르면 false → 지금처럼 중복으로 봐요
function biggerShot(a, b) {
  const px = (m) => {
    const w = Number(m && m.ImageWidth);
    const h = Number(m && m.ImageHeight);
    return w > 0 && h > 0 ? w * h : null;
  };
  const pa = px(a);
  const pb = px(b);
  return pa != null && pb != null && pa > pb;
}

// 결과: 'same'(완전 중복) / 'similar'(같은 사진, 다른 버전) / 'different'
//   canHash=false → 변환할 파일(HEIC/MOV)이라 지문 비교가 불가능한 경우
//                   → 같은 촬영이면 "이미 변환해 둔 것"으로 보고 중복 처리
async function compare({ srcPath, srcMeta, canHash }, { otherPath, otherMeta }) {
  if (canHash && (await sameBytes(srcPath, otherPath))) return 'same';
  // 변환할 파일이 같은 촬영이어도 백업에 있는 것보다 크면 다른 파일로 봐요 → 번호 붙여 둘 다 보존 (개선 11)
  if (sameShot(srcMeta, otherMeta)) return canHash ? 'similar' : biggerShot(srcMeta, otherMeta) ? 'different' : 'same';
  return 'different';
}

// 이전 작업 기록의 열쇠: 원본 경로 + 크기 + 수정 시각 (셋 다 같으면 같은 원본으로 봐요)
function priorKey(src, size, mtimeMs) {
  return `${keyOf(src)}|${size}|${mtimeMs}`;
}

// ---------- 미리보기 진행 표시 ----------
const PLAN_STEPS = 6;
const fmtNum = (n) => Number(n).toLocaleString('en-US');
// 남은 초 → "1분 안" / "약 12분" / "약 1시간 20분"
function fmtLeft(sec) {
  if (sec < 60) return '1분 안';
  const m = Math.round(sec / 60);
  if (m < 60) return `약 ${m}분`;
  return `약 ${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ''}`;
}
// onStatus 에 "[n/전체단계] 이름... 몇 / 전체 (남은 시간)" 을 보내는 도우미
//   tick 은 0.3초에 한 번만 보내요 (화면이 너무 자주 바뀌지 않게). force 면 바로
//   남은 시간은 이 단계를 시작한 뒤 5초가 지나야 보여요 (처음엔 속도를 몰라서)
function createProgress(onStatus, steps, now = () => Date.now()) {
  let n = 0;
  let label = '';
  let start = now();
  let last = 0;
  const stage = (no, name) => {
    n = no;
    label = name;
    start = now();
    last = 0;
    onStatus(`[${n}/${steps}단계] ${label}...`);
  };
  const tick = (done, total, force = false) => {
    const t = now();
    if (!force && t - last < 300 && !(total && done >= total)) return;
    last = t;
    const el = (t - start) / 1000;
    const left = total && done > 0 && done < total && el >= 5 ? ` (남은 시간 ${fmtLeft((el / done) * (total - done))})` : '';
    const count = total ? `${fmtNum(done)} / ${fmtNum(total)}` : `${fmtNum(done)}개`;
    onStatus(`[${n}/${steps}단계] ${label}... ${count}${left}`);
  };
  return { stage, tick };
}

// ---------- 화면·로그에 보여줄 상태 ----------
const STATUS_LABEL = { todo: '예정', done: '✅ 완료', dup: '⏭ 중복', fail: '❌ 실패', broken: '⚠ 재생 불가', skip: '✔ 이미 정리됨' };

// 상태 이름 — "건너뜀"이어도 같은 파일인지 몰라서 건너뛴 건 "이미 정리됨"이라고 하면 안 돼요
function statusLabelOf(it) {
  if (it.status === 'skip' && it.check) return '⚠ 확인 필요';
  return STATUS_LABEL[it.status] || it.status;
}

// "주의할 것만" 목록에 넣을지
function isIssue(it) {
  return it.status === 'dup' || it.status === 'fail' || it.status === 'broken' || it.renamed || it.relDir === NO_DATE_DIR || !!it.check || !!it.typeNote;
}

// ---------- 메인: 계획 만들기 ----------
// onStatus(글자) 로 진행 상황을 화면에 알려줘요
// deps.sameFile: 같은 파일인지 확인하는 함수 (점검 때 "모름"을 흉내 내려고 바꿔 끼울 수 있게)
// deps.priorResults: 이전 작업에서 변환을 끝낸 원본 Map<priorKey, 결과 파일 경로> (lib/job.js priorResults)
async function makePlan({ source, backupRoot, includeSub }, et, onStatus = () => {}, deps = {}) {
  const isSameFile = deps.sameFile || sameFile;
  hashCache.clear();

  // 백업 폴더가 가져올 폴더 안에 있으면 → 백업 폴더는 빼고 찾기 (이미 정리된 것 다시 처리 방지)
  const exclude = isInside(backupRoot, source) && keyOf(backupRoot) !== keyOf(source) ? [backupRoot] : [];

  // 진행 표시: "[2/6단계] 📅 촬영 정보 읽기... 4,000 / 80,189 (남은 시간 약 12분)"
  //   단계마다 몇 번째인지 · 몇 개 중 몇 개인지 · 남은 시간을 보여 줘서, 멈춘 건지 도는 건지 알 수 있게 해요 (2026-11-14 사용자 요청)
  const progress = createProgress(onStatus, PLAN_STEPS);

  progress.stage(1, '📂 파일 찾기');
  const files = walk(source, includeSub, exclude, (n) => progress.tick(n));
  files.sort((a, b) => a.path.localeCompare(b.path));

  progress.stage(2, '📅 촬영 정보 읽기');
  progress.tick(0, files.length, true);
  const metaMap = await readMetaWithKeys(
    et,
    files,
    [...META_TAGS, ...DIM_TAGS],
    (d, t) => progress.tick(d, t),
    (d, t) => {
      if (d === 0) progress.stage(3, '🎬 영상 촬영일 읽기');
      progress.tick(d, t, d === 0);
    }
  );

  // ---------- 3) 파일마다 새 이름 & 위치 정하기 ----------
  const dateFromAlbum = createAlbumDates(); // iCloud 공유 앨범의 AlbumInfo.json (폴더마다 한 번만 읽음)
  const items = files.map((f, i) => {
    const meta = { ...(metaMap.get(keyOf(f.path)) || {}) };
    const fileName = path.basename(f.path);
    const base = path.basename(f.path, path.extname(f.path));
    // 종류는 내용 기준 (이름은 .JPG 인데 내용이 MOV 면 MOV→MP4)
    const ext = contentExt(f.ext, meta.FileType);
    const { kind, newExt, label } = kindOf(ext);
    const typeNote = ext !== f.ext ? `이름은 ${path.extname(f.path)} 이지만 내용은 ${meta.FileType}` : '';
    // 촬영 정보 → 파일 이름 → 앨범 정보(iCloud 공유 앨범) 순서로 찾아요
    const found = D.dateFromMeta(meta) || D.dateFromName(fileName) || dateFromAlbum(f.path);

    let relDir, name;
    if (found) {
      relDir = path.join(...D.toFolders(found.parts));
      name = D.buildName(base, found.parts, newExt); // 날짜 두 번 안 붙게
    } else {
      relDir = NO_DATE_DIR;
      name = base + newExt; // 날짜를 모르니 원본 이름 그대로
    }

    return {
      i,
      src: f.path,
      size: f.size,
      srcMtimeMs: f.mtimeMs, // 다음 작업에서 "이미 변환한 원본"을 알아보려고 적어 둬요
      kind,
      label,
      isVideo: VIDEO_EXT.includes(ext), // 내용 기준 (처리할 때 재생 확인을 할지 정해요)
      typeNote, // 확장자와 내용이 다르면 그 설명 (주의할 것만 목록에 보여요)
      converted: kind !== 'copy',
      relDir,
      name,
      dest: path.join(backupRoot, relDir, name),
      date: found ? D.toExif(found.parts) : null,
      dateFrom: found ? found.from : '없음',
      refDate: found ? null : D.fmtLocal(f.mtimeMs), // 날짜없음 파일의 참고 날짜 (수정 날짜)
      model: meta.Model || '',
      gps: meta.GPSLatitude != null ? `${Number(meta.GPSLatitude).toFixed(5)},${Number(meta.GPSLongitude).toFixed(5)}` : '',
      subject: meta.Subject != null ? [].concat(meta.Subject) : [], // 태그 (MP4로 바꿀 때 다시 넣어 줘요)
      meta: pick(meta, COMPARE_TAGS),
      status: 'todo',
      note: typeNote,
      renamed: false,
      newFolder: false,
    };
  });

  // ---------- 3-1) 이름과 상관없이 내용이 같은 파일 찾기 (명세 v1.2) ----------
  //   예) Windows가 복사할 때 붙인 IMG_5267(1).JPG = IMG_5267.JPG → 이름이 달라서 예전에는 둘 다 저장됐어요
  //   크기가 같은 파일끼리만 지문(해시)을 비교해요 (전부 계산하면 느려서)
  // ① 이번에 가져오는 원본끼리: 지문이 같으면 앞의 것만 처리하고 나머지는 "같은 파일"로 건너뜀
  const bySize = new Map();
  for (const it of items) {
    if (!it.size) continue;
    if (!bySize.has(it.size)) bySize.set(it.size, []);
    bySize.get(it.size).push(it);
  }
  progress.stage(4, '🔍 가져올 파일끼리 같은 파일 찾기');
  const sameSizeTotal = [...bySize.values()].reduce((n, g) => n + (g.length < 2 ? 0 : g.length), 0);
  let sameSizeDone = 0;
  progress.tick(0, sameSizeTotal, true);
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    const firstByHash = new Map();
    for (const it of group) {
      progress.tick(++sameSizeDone, sameSizeTotal);
      let h;
      try {
        h = await fileHash(it.src);
      } catch (e) {
        continue; // 못 읽으면 비교 안 함 → 둘 다 보존
      }
      const first = firstByHash.get(h);
      if (!first) {
        firstByHash.set(h, it);
        continue;
      }
      it.status = 'dup';
      it.dupOfItem = first.i;
      it.dupOf = null;
      it.note = `같은 파일 (${path.basename(first.src)})`;
    }
  }

  // ② 백업의 같은 날짜 폴더에 이미 있는 파일과: 크기·지문이 같으면 "이미 있음"으로 건너뜀
  //    (HEIC·MOV처럼 변환할 파일은 결과가 원본과 달라서 여기서는 비교 안 함 → 아래 이름·애플 ID 확인)
  const sizesCache = new Map();
  const filesWithSize = (dir) => {
    const k = keyOf(dir);
    if (!sizesCache.has(k)) {
      const list = [];
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!e.isFile() || e.name.includes('.__tmp__')) continue;
          const p = path.join(dir, e.name);
          try {
            list.push({ path: p, size: fs.statSync(p).size });
          } catch (err) {
            // 못 읽는 파일은 비교 안 함
          }
        }
      } catch (e) {
        // 폴더 없음
      }
      sizesCache.set(k, list);
    }
    return sizesCache.get(k);
  };
  progress.stage(5, '🗂 백업 폴더에 이미 있는지 확인');
  const backupCands = items.filter((it) => it.status === 'todo' && !it.converted && it.size);
  let backupDone = 0;
  progress.tick(0, backupCands.length, true);
  for (const it of backupCands) {
    progress.tick(++backupDone, backupCands.length);
    for (const f of filesWithSize(path.dirname(it.dest))) {
      if (f.size !== it.size) continue;
      if (isSameFile(f.path, it.src) !== false) continue; // 자기 자신(또는 모름)은 아래 이름 확인에서 처리
      let same = false;
      try {
        same = (await fileHash(f.path)) === (await fileHash(it.src));
      } catch (e) {
        same = false;
      }
      if (same) {
        it.status = 'dup';
        it.dupOf = f.path;
        it.dupOfItem = null;
        it.note = `이미 있음 (내용이 같은 ${path.basename(f.path)})`;
        break;
      }
    }
  }

  // ③ 이전 작업에서 이미 변환해 둔 원본 (M4, 2026-11-04 사용자 결정)
  //    HEIC·MOV는 변환 결과가 원본과 달라 지문 비교를 못 하고, 애플 ID가 없으면 같은 촬영인지도 몰라요
  //    → 같은 폴더를 다시 미리보기하면 _1 복사본이 또 생겼어요
  //    이전 작업 기록에 원본 경로, 크기, 수정 시각이 모두 같은 원본이 있고, 그 결과 파일이 백업 폴더에 있으면 "이미 정리됨"으로 건너뛰어요
  //    (이미 정리됨은 원본 정리 대상이 아니에요. 원본은 그대로 남아요)
  //    애플 ID가 있는 원본은 여기서 건너뛰지 않아요 → 아래 이름 확인에서 "같은 촬영"이 되어 원본 정리 대상이 될 수 있어요
  const prior = deps.priorResults;
  if (prior && prior.size) {
    for (const it of items) {
      if (it.status !== 'todo' || !it.converted) continue;
      if (it.meta && (it.meta.PhotoIdentifier || it.meta.ImageUniqueID || it.meta.ContentIdentifier)) continue;
      const dest = prior.get(priorKey(it.src, it.size, it.srcMtimeMs));
      if (!dest || !isInside(dest, backupRoot) || !fs.existsSync(dest)) continue;
      it.status = 'skip';
      it.note = `이전 작업에서 이미 변환함 (${path.basename(dest)}). 원본은 남아요`;
    }
  }

  // ④ 변환할 파일(HEIC·MOV)을 같은 날짜 폴더의 기존 결과와 애플 ID로 비교 (이름이 달라도)
  //    예) 옛 프로그램이 만든 IMG_0001.jpg 와 iCloud HEIC→JPG 가 이름이 달라서 둘 다 저장되던 문제
  //    기준은 이름 겹침 확인과 같아요: 애플 ID(PhotoIdentifier, ContentIdentifier)가 같으면 "이미 변환해 둔 것"
  //    (ImageUniqueID는 여러 회사 카메라가 같은 값을 넣기도 해서, 이름을 안 보는 이 비교에는 안 써요)
  //    결과 확장자가 같은 파일끼리만 봐요. 건너뛰기만 하고 원본 정리는 정리 직전 확인(lib/cleaner.js)이 그대로 다시 해요
  // 기존 파일 정보 읽기 결과는 ④와 아래 이름 겹침 확인이 같이 써요 (같은 파일을 두 번 읽지 않게)
  const existingMeta = new Map();
  const existingTried = new Set();
  const readExisting = async (paths) => {
    const need = paths.filter((f) => !existingTried.has(keyOf(f)));
    for (const f of need) existingTried.add(keyOf(f));
    if (need.length) for (const [k, m] of await readMetaMap(et, need, COMPARE_TAGS, (d, t) => progress.tick(d, t))) existingMeta.set(k, m);
  };
  const idOfMeta = (m) => (m && (m.PhotoIdentifier || m.ContentIdentifier)) || null;
  const idCands = items.filter((it) => it.status === 'todo' && it.converted && idOfMeta(it.meta));
  if (idCands.length) {
    progress.stage(5, '🗂 변환 파일을 백업 폴더와 애플 ID로 비교');
    const folderFiles = new Map(); // 폴더 → 기존 파일 경로 목록
    const listIn = (dir) => {
      const k = keyOf(dir);
      if (!folderFiles.has(k)) {
        let list = [];
        try {
          list = fs.readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isFile() && !e.name.includes('.__tmp__'))
            .map((e) => path.join(dir, e.name));
        } catch (e) {
          list = []; // 폴더 없음
        }
        folderFiles.set(k, list);
      }
      return folderFiles.get(k);
    };
    const sameExt = (a, b) => path.extname(a).toLowerCase() === path.extname(b).toLowerCase();
    const toRead = new Set();
    for (const it of idCands) for (const f of listIn(path.dirname(it.dest))) if (sameExt(f, it.name)) toRead.add(f);
    await readExisting([...toRead]);
    for (const it of idCands) {
      const id = idOfMeta(it.meta);
      const hits = listIn(path.dirname(it.dest)).filter((f) => sameExt(f, it.name) && idOfMeta(existingMeta.get(keyOf(f))) === id);
      // 원본보다 작은 사본(공유 앨범 축소본)은 "이미 있음"이 아니에요 → 원본을 가져와요 (개선 11)
      const hit = hits.find((f) => !biggerShot(it.meta, existingMeta.get(keyOf(f))));
      if (!hit) {
        if (hits.length) it.note = `백업에는 작은 사본만 있어서 가져와요 (${path.basename(hits[0])})`;
        continue;
      }
      it.status = 'dup';
      it.dupOf = hit;
      it.dupOfItem = null;
      it.sameShot = true; // 원본 정리 직전에 촬영 날짜와 가로×세로까지 다시 봐요
      it.note = `이미 있음 (같은 촬영 ${path.basename(hit)})`;
    }
  }

  // ⑤ MOV→MP4 로 바꿀 영상을 같은 날짜 폴더의 기존 MP4 와 "화면 데이터 지문"으로 비교 (2026-11-24 실사용)
  //    애플 ID(ContentIdentifier)는 라이브 포토 영상에만 있어요. 보통 아이폰 영상에는 없어서 ④에서 못 찾았어요
  //    → 이미 백업한 영상을 이름만 다르게(IMG_0001(1).MOV, 다른 폴더의 같은 영상) 다시 가져오면 2개씩 저장됐어요
  //    변환은 화면 데이터를 그대로 옮겨서(-c:v copy) 원본 MOV 와 결과 MP4 의 화면 데이터 지문이 같아요 (lib/tools.js videoStreamHash)
  //    크기가 비슷한 MP4 만 지문을 계산해요 (화면 데이터가 같으면 결과는 원본보다 조금 작거나 거의 같아요)
  //    원본 정리 직전에 지문을 한 번 더 비교해요 (lib/cleaner.js sameVideo)
  const videoHashOf = deps.videoHashOf;
  const vidCands = videoHashOf ? items.filter((it) => it.status === 'todo' && it.kind === 'mov2mp4' && it.size) : [];
  const mayBeSameVideo = (srcSize, mp4Size) => mp4Size <= srcSize * 1.05 + 1024 * 1024 && mp4Size >= srcSize * 0.3;
  if (vidCands.length) {
    const vHash = new Map(); // 경로 → 지문 (한 파일은 한 번만 계산)
    const vHashOf = async (p) => {
      const k = keyOf(p);
      if (!vHash.has(k)) vHash.set(k, await videoHashOf(p).catch(() => null));
      return vHash.get(k);
    };
    const withCands = vidCands
      .map((it) => ({ it, cands: filesWithSize(path.dirname(it.dest)).filter((f) => path.extname(f.path).toLowerCase() === '.mp4' && mayBeSameVideo(it.size, f.size)) }))
      .filter((x) => x.cands.length);
    if (withCands.length) {
      progress.stage(5, '🎞 영상을 백업 폴더의 영상과 내용으로 비교');
      let vidDone = 0;
      progress.tick(0, withCands.length, true);
      for (const { it, cands } of withCands) {
        progress.tick(++vidDone, withCands.length);
        const h = await vHashOf(it.src);
        if (!h) continue; // 못 읽으면 비교 안 함 → 예전처럼 처리
        for (const f of cands) {
          if (isSameFile(f.path, it.src) !== false) continue;
          if ((await vHashOf(f.path)) !== h) continue;
          it.status = 'dup';
          it.dupOf = f.path;
          it.dupOfItem = null;
          it.sameVideo = true; // 원본 정리 직전에 화면 데이터 지문을 다시 비교해요
          it.note = `이미 있음 (영상 내용이 같은 ${path.basename(f.path)})`;
          break;
        }
      }
    }
  }

  // ---------- 4) 이름 겹침 확인 ----------
  progress.stage(6, '🔤 겹치는 이름 확인');

  // 폴더마다 이미 있는 파일 이름 (한 번만 읽기)
  const dirCache = new Map();
  const namesIn = (dir) => {
    const k = keyOf(dir);
    if (!dirCache.has(k)) {
      let set = null; // null = 폴더 없음
      try {
        set = new Set(fs.readdirSync(dir).map((n) => (isWin ? n.toLowerCase() : n)));
      } catch (e) {
        set = null;
      }
      dirCache.set(k, set);
    }
    return dirCache.get(k);
  };

  // 겹칠 수 있는 기존 파일 모으기 → 정보 한꺼번에 읽기
  const existingToRead = new Set();
  for (const it of items) {
    if (it.status !== 'todo') continue; // 위에서 이미 중복으로 정해진 건 자리를 안 정해요
    const dir = path.dirname(it.dest);
    const set = namesIn(dir);
    it.newFolder = set === null;
    if (!set) continue;
    const ext = path.extname(it.name);
    const stem = path.basename(it.name, ext);
    const re = new RegExp('^' + escapeRe(stem) + '(_\\d+)?' + escapeRe(ext) + '$', isWin ? 'i' : '');
    for (const n of set) if (re.test(n)) existingToRead.add(path.join(dir, n));
  }
  // 기존 파일 정보 읽기와 이름 확인은 숫자 · 속도가 달라서 따로 시작 시각을 잡아요 (남은 시간이 섞이지 않게)
  progress.stage(6, '🔤 이미 있는 파일 정보 읽기');
  await readExisting([...existingToRead]); // ④에서 읽은 파일은 다시 안 읽어요

  // 차례대로 자리 정하기
  progress.stage(6, '🔤 겹치는 이름 확인');
  const taken = new Map(); // 이번 계획에서 차지한 자리 → 그 item
  let checked = 0;
  for (const it of items) {
    checked++;
    progress.tick(checked, items.length);
    if (it.status !== 'todo') continue; // 내용이 같은 파일로 이미 정해짐

    const dir = path.dirname(it.dest);
    const ext = path.extname(it.name);
    const stem = path.basename(it.name, ext);
    const set = namesIn(dir);

    for (let n = 0; ; n++) {
      const cand = n === 0 ? `${stem}${ext}` : `${stem}_${n}${ext}`;
      const abs = path.join(dir, cand);
      const k = keyOf(abs);
      const planned = taken.get(k);
      const exists = set && set.has(isWin ? cand.toLowerCase() : cand);

      // 원본이 이미 그 자리에 있음 (백업 폴더 안 파일을 다시 넣은 경우)
      //   경로 글자가 달라도(네트워크 드라이브, 폴더 연결 등) 진짜 같은 파일이면 여기서 걸러요
      //   같은지 확실하지 않으면(null) 역시 건너뜀 → 자기 자신을 "중복"으로 보고 정리하는 일 방지
      const same = k === keyOf(it.src) ? true : exists ? isSameFile(abs, it.src) : false;
      if (same !== false) {
        it.status = 'skip';
        if (same === null) {
          // 모름 → 백업 안 된 파일일 수 있어요. "이미 정리됨"이 아니라 "확인 필요"로 (정리 대상도 아님)
          it.check = true;
          it.note = `이미 있는 파일(${cand})과 같은 파일인지 확인하지 못해서 건너뜀 — 백업되지 않았을 수 있어요`;
        } else {
          it.note = '이미 정리된 파일';
        }
        break;
      }

      // 빈 자리 → 여기로!
      if (!planned && !exists) {
        it.dest = abs;
        it.name = cand;
        it.renamed = n > 0;
        taken.set(k, it);
        break;
      }

      // 자리가 차 있음 → 같은 파일인지 비교
      let verdict;
      let infoOnly = false; // 바이트는 다르지만 내용 지문이 같음 (백업 파일에 태그를 쓴 경우)
      if (planned) {
        // 이번에 같이 가져오는 다른 원본 파일과 겹침 (원본끼리 비교)
        verdict = await compare(
          { srcPath: it.src, srcMeta: it.meta, canHash: true },
          { otherPath: planned.src, otherMeta: planned.meta }
        );
      } else {
        // 백업 폴더에 이미 있는 파일과 겹침 (변환하는 파일은 지문 비교 불가)
        verdict = await compare(
          { srcPath: it.src, srcMeta: it.meta, canHash: !it.converted },
          { otherPath: abs, otherMeta: existingMeta.get(k) }
        );
        // 바이트가 다르면 내용 지문으로 한 번 더 (2026-11-23, lib/content-hash.js)
        //   백업 파일에 태그를 쓰면 바이트 지문이 바뀌어서, 같은 사진을 다시 가져올 때 _1 로 하나 더 저장되던 것을 막아요
        //   가로세로 · 애플 ID 가 다르면 읽지 않아요 (파일 전체를 읽어서 느려요). "같은 사진 다른 버전"보다 이게 앞서요
        //   변환할 파일은 내용 자체가 달라서 비교할 수 없어요
        if (verdict !== 'same' && !it.converted && et && mayBeSameContent(it.meta, existingMeta.get(k))) {
          const r = await sameContent(et, it.src, abs);
          if (r.same) {
            verdict = 'same';
            infoOnly = true;
          }
        }
      }

      // dupOf: 남아 있을 파일 (원본 지울 때 이게 있는지 꼭 확인해요)
      if (verdict === 'same') {
        it.status = 'dup';
        it.dupOf = planned ? null : abs;
        it.dupOfItem = planned ? planned.i : null;
        it.note = planned ? `같은 파일 (${path.basename(planned.src)})` : infoOnly ? `이미 있음 (${cand}, 태그 · 정보만 다름)` : `이미 있음 (${cand})`;
        // 변환할 파일이 애플 ID로 "같은 촬영"이 된 경우 → 원본 정리 직전에 촬영 날짜와 가로×세로까지 다시 봐요 (lib/cleaner.js)
        if (!planned && it.converted) it.sameShot = true;
        break;
      }
      if (verdict === 'similar') {
        it.status = 'dup';
        it.dupOf = planned ? null : abs;
        it.dupOfItem = planned ? planned.i : null;
        it.note = `같은 사진 다른 버전 — 확인 필요 (${cand})`;
        it.check = true;
        break;
      }
      // 다른 파일 → 번호 올려서 다음 자리
    }
  }

  // ---------- 5) "같은 파일"이 가리키는 원본이 나중에 중복·이미 정리됨이 됐으면 → 진짜 남을 파일로 이어 주기 ----------
  for (const it of items) {
    if (it.status !== 'dup' || it.dupOfItem == null) continue;
    let keep = items[it.dupOfItem];
    for (let n = 0; keep && keep.status === 'dup' && keep.dupOfItem != null && n < items.length; n++) keep = items[keep.dupOfItem];
    if (!keep || keep === it) continue;
    if (keep.check) it.check = true; // 남을 쪽이 "확인 필요"면 이것도 확인 필요
    if (keep.status === 'dup' && keep.dupOf) {
      it.dupOf = keep.dupOf; // 백업에 이미 있는 파일
      it.dupOfItem = null;
    } else if (keep.status === 'skip' && !keep.check && isInside(keep.src, backupRoot)) {
      it.dupOf = keep.src; // 이미 정리돼 있는 그 파일 (백업 폴더 안)
      it.dupOfItem = null;
    } else if (keep.status === 'skip') {
      // 백업 폴더 밖의 원본이 건너뛰어진 경우(이전 작업 기록, 확인 필요) → 남길 파일이 확실하지 않아 정리 대상에서 빼요
      it.dupOf = null;
      it.dupOfItem = null;
    } else {
      it.dupOfItem = keep.i;
    }
  }

  return { createdAt: Date.now(), source, backupRoot, includeSub, items, stats: summarize(items) };
}

// 개수 요약
function summarize(items) {
  const s = { total: items.length, todo: 0, heic: 0, mov: 0, copy: 0, noDate: 0, dup: 0, check: 0, renamed: 0, skip: 0, unsure: 0, newFolders: 0, byFrom: { 촬영정보: 0, 파일이름: 0, 앨범정보: 0, 없음: 0 } };
  const newDirs = new Set();
  for (const it of items) {
    s.byFrom[it.dateFrom]++;
    if (it.status === 'dup') { s.dup++; if (it.check) s.check++; continue; }
    if (it.status === 'skip') { if (it.check) s.unsure++; else s.skip++; continue; } // unsure: 같은 파일인지 모름
    s.todo++;
    if (it.kind === 'heic2jpg') s.heic++;
    else if (it.kind === 'mov2mp4') s.mov++;
    else s.copy++;
    if (it.relDir === NO_DATE_DIR) s.noDate++;
    if (it.renamed) s.renamed++;
    if (it.newFolder) newDirs.add(keyOf(path.dirname(it.dest)));
  }
  s.newFolders = newDirs.size;
  return s;
}

function pick(obj, keys) {
  const o = {};
  for (const k of keys) if (obj[k] != null) o[k] = obj[k];
  return o;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { createProgress, fmtLeft, makePlan, walk, walkAsync, META_TAGS, COMPARE_TAGS, readMetaWithKeys, summarize, contentExt, isVideoContent, sameShot, biggerShot, sameBytes, keyOf, priorKey, isInside, isVideoPath, NO_DATE_DIR, MOVED_DIR, STATUS_LABEL, statusLabelOf, isIssue };

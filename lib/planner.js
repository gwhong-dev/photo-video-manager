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

// 처리할 확장자
const PHOTO_EXT = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.dng'];
const VIDEO_EXT = ['.mov', '.mp4', '.m4v', '.avi', '.mkv', '.wmv', '.3gp'];

const NO_DATE_DIR = '_날짜없음';
const MOVED_DIR = '_정리완료원본'; // 휴지통 없는 드라이브에서 정리한 원본을 옮겨 두는 곳 (다시 읽지 않음)

// 읽어 올 정보 (날짜 + 중복 판단용 + 로그 참고용)
const META_TAGS = [
  ...D.SHOT_TAGS,
  'PhotoIdentifier', 'ImageUniqueID', 'ContentIdentifier', // 고유 ID
  'Model', 'SubSecTimeOriginal',                           // 기기, 0.001초
  'GPSLatitude#', 'GPSLongitude#',                         // 장소 (숫자로)
  'XMP-dc:Subject',                                        // 태그 (PhotoSync 앨범 이름, 미디어 종류)
];
const COMPARE_TAGS = ['PhotoIdentifier', 'ImageUniqueID', 'ContentIdentifier', 'Model', 'SubSecTimeOriginal'];

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
function walk(root, includeSub, excludeDirs, onCount) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue; // 권한 없는 폴더는 건너뛰기
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!includeSub) continue;
        if (ent.name.startsWith('.') || SKIP_DIRS.includes(ent.name) || ent.name === MOVED_DIR) continue;
        if (/^\d{4}년도$/.test(ent.name)) continue; // "2025년도" 같은 후가공 폴더는 절대 안 건드림
        if (excludeDirs.some((x) => keyOf(x) === keyOf(full))) continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (ent.name.startsWith('.') || ent.name.includes('.__tmp__')) continue; // 숨김/작업중 파일
      const ext = path.extname(ent.name).toLowerCase();
      if (!PHOTO_EXT.includes(ext) && !VIDEO_EXT.includes(ext)) continue;
      try {
        const st = fs.statSync(full);
        files.push({ path: full, size: st.size, mtimeMs: st.mtimeMs, ext, isVideo: VIDEO_EXT.includes(ext) });
      } catch (e) {
        continue;
      }
      if (files.length % 500 === 0) onCount(files.length);
    }
  }
  return files;
}

// ---------- 2) 정보 한꺼번에 읽기 (500개씩) ----------
async function readMetaMap(et, paths, tags, onProgress) {
  const map = new Map();
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500);
    const list = await et.read(chunk, tags);
    for (const m of list) map.set(keyOf(m.SourceFile), m);
    if (onProgress) onProgress(Math.min(i + 500, paths.length), paths.length);
  }
  return map;
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

// 결과: 'same'(완전 중복) / 'similar'(같은 사진, 다른 버전) / 'different'
//   canHash=false → 변환할 파일(HEIC/MOV)이라 지문 비교가 불가능한 경우
//                   → 같은 촬영이면 "이미 변환해 둔 것"으로 보고 중복 처리
async function compare({ srcPath, srcMeta, canHash }, { otherPath, otherMeta }) {
  if (canHash && (await sameBytes(srcPath, otherPath))) return 'same';
  if (sameShot(srcMeta, otherMeta)) return canHash ? 'similar' : 'same';
  return 'different';
}

// ---------- 메인: 계획 만들기 ----------
// onStatus(글자) 로 진행 상황을 화면에 알려줘요
async function makePlan({ source, backupRoot, includeSub }, et, onStatus = () => {}) {
  hashCache.clear();

  // 백업 폴더가 가져올 폴더 안에 있으면 → 백업 폴더는 빼고 찾기 (이미 정리된 것 다시 처리 방지)
  const exclude = isInside(backupRoot, source) && keyOf(backupRoot) !== keyOf(source) ? [backupRoot] : [];

  onStatus('📂 파일 찾는 중...');
  const files = walk(source, includeSub, exclude, (n) => onStatus(`📂 파일 찾는 중... ${n}개`));
  files.sort((a, b) => a.path.localeCompare(b.path));

  onStatus(`📅 촬영 정보 읽는 중... 0 / ${files.length}`);
  const metaMap = await readMetaMap(et, files.map((f) => f.path), META_TAGS, (d, t) =>
    onStatus(`📅 촬영 정보 읽는 중... ${d} / ${t}`)
  );

  // 영상의 진짜 "찍은 시각"은 Keys:CreationDate (QuickTime CreateDate는 전송한 시각)
  //   exiftool 결과에는 그룹 이름이 빠져서 다른 CreationDate와 섞일 수 있어요 → 영상만 따로 한 번 더 읽기
  const videoPaths = files.filter((f) => f.isVideo).map((f) => f.path);
  const keysMap = await readMetaMap(et, videoPaths, ['Keys:CreationDate']);

  // ---------- 3) 파일마다 새 이름 & 위치 정하기 ----------
  const items = files.map((f, i) => {
    const meta = { ...(metaMap.get(keyOf(f.path)) || {}) };
    const keys = keysMap.get(keyOf(f.path));
    if (keys && keys.CreationDate) meta.KeysCreationDate = keys.CreationDate;
    const fileName = path.basename(f.path);
    const base = path.basename(f.path, path.extname(f.path));
    const { kind, newExt, label } = kindOf(f.ext);
    const found = D.dateFromMeta(meta) || D.dateFromName(fileName);

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
      kind,
      label,
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
      note: '',
      renamed: false,
      newFolder: false,
    };
  });

  // ---------- 4) 이름 겹침 확인 ----------
  onStatus('🔍 겹치는 이름 확인 중...');

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
    const dir = path.dirname(it.dest);
    const set = namesIn(dir);
    it.newFolder = set === null;
    if (!set) continue;
    const ext = path.extname(it.name);
    const stem = path.basename(it.name, ext);
    const re = new RegExp('^' + escapeRe(stem) + '(_\\d+)?' + escapeRe(ext) + '$', isWin ? 'i' : '');
    for (const n of set) if (re.test(n)) existingToRead.add(path.join(dir, n));
  }
  const existingMeta = await readMetaMap(et, [...existingToRead], COMPARE_TAGS);

  // 차례대로 자리 정하기
  const taken = new Map(); // 이번 계획에서 차지한 자리 → 그 item
  let checked = 0;
  for (const it of items) {
    checked++;
    if (checked % 200 === 0) onStatus(`🔍 겹치는 이름 확인 중... ${checked} / ${items.length}`);

    const dir = path.dirname(it.dest);
    const ext = path.extname(it.name);
    const stem = path.basename(it.name, ext);
    const set = namesIn(dir);

    for (let n = 0; ; n++) {
      const cand = n === 0 ? `${stem}${ext}` : `${stem}_${n}${ext}`;
      const abs = path.join(dir, cand);
      const k = keyOf(abs);

      // 원본이 이미 그 자리에 있음 (백업 폴더 안 파일을 다시 넣은 경우)
      if (k === keyOf(it.src)) {
        it.status = 'skip';
        it.note = '이미 정리된 파일';
        break;
      }

      const planned = taken.get(k);
      const exists = set && set.has(isWin ? cand.toLowerCase() : cand);

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
      }

      // dupOf: 남아 있을 파일 (원본 지울 때 이게 있는지 꼭 확인해요)
      if (verdict === 'same') {
        it.status = 'dup';
        it.dupOf = planned ? null : abs;
        it.dupOfItem = planned ? planned.i : null;
        it.note = planned ? `같은 파일 (${path.basename(planned.src)})` : `이미 있음 (${cand})`;
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

  return { createdAt: Date.now(), source, backupRoot, includeSub, items, stats: summarize(items) };
}

// 개수 요약
function summarize(items) {
  const s = { total: items.length, todo: 0, heic: 0, mov: 0, copy: 0, noDate: 0, dup: 0, check: 0, renamed: 0, skip: 0, newFolders: 0, byFrom: { 촬영정보: 0, 파일이름: 0, 없음: 0 } };
  const newDirs = new Set();
  for (const it of items) {
    s.byFrom[it.dateFrom]++;
    if (it.status === 'dup') { s.dup++; if (it.check) s.check++; continue; }
    if (it.status === 'skip') { s.skip++; continue; }
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

module.exports = { makePlan, summarize, sameShot, sameBytes, keyOf, NO_DATE_DIR, MOVED_DIR };

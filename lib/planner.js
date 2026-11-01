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

// 처리할 확장자
const PHOTO_EXT = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.dng'];
const VIDEO_EXT = ['.mov', '.mp4', '.m4v', '.avi', '.mkv', '.wmv', '.3gp'];

// 영상 파일인지 (확장자로 판단)
const isVideoPath = (p) => VIDEO_EXT.includes(path.extname(p).toLowerCase());

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

// ---------- 화면·로그에 보여줄 상태 ----------
const STATUS_LABEL = { todo: '예정', done: '✅ 완료', dup: '⏭ 중복', fail: '❌ 실패', broken: '⚠ 재생 불가', skip: '✔ 이미 정리됨' };

// 상태 이름 — "건너뜀"이어도 같은 파일인지 몰라서 건너뛴 건 "이미 정리됨"이라고 하면 안 돼요
function statusLabelOf(it) {
  if (it.status === 'skip' && it.check) return '⚠ 확인 필요';
  return STATUS_LABEL[it.status] || it.status;
}

// "주의할 것만" 목록에 넣을지
function isIssue(it) {
  return it.status === 'dup' || it.status === 'fail' || it.status === 'broken' || it.renamed || it.relDir === NO_DATE_DIR || !!it.check;
}

// ---------- 메인: 계획 만들기 ----------
// onStatus(글자) 로 진행 상황을 화면에 알려줘요
// deps.sameFile: 같은 파일인지 확인하는 함수 (점검 때 "모름"을 흉내 내려고 바꿔 끼울 수 있게)
async function makePlan({ source, backupRoot, includeSub }, et, onStatus = () => {}, deps = {}) {
  const isSameFile = deps.sameFile || sameFile;
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

  // ---------- 3-1) 이름과 상관없이 내용이 같은 파일 찾기 (명세 v1.2) ----------
  //   예) Windows가 복사할 때 붙인 IMG_5267(1).JPG = IMG_5267.JPG → 이름이 달라서 예전에는 둘 다 저장됐어요
  //   크기가 같은 파일끼리만 지문(해시)을 비교해요 (전부 계산하면 느려서)
  onStatus('🔍 내용이 같은 파일 찾는 중...');

  // ① 이번에 가져오는 원본끼리: 지문이 같으면 앞의 것만 처리하고 나머지는 "같은 파일"로 건너뜀
  const bySize = new Map();
  for (const it of items) {
    if (!it.size) continue;
    if (!bySize.has(it.size)) bySize.set(it.size, []);
    bySize.get(it.size).push(it);
  }
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    const firstByHash = new Map();
    for (const it of group) {
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
  for (const it of items) {
    if (it.status !== 'todo' || it.converted || !it.size) continue;
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
  const existingMeta = await readMetaMap(et, [...existingToRead], COMPARE_TAGS);

  // 차례대로 자리 정하기
  const taken = new Map(); // 이번 계획에서 차지한 자리 → 그 item
  let checked = 0;
  for (const it of items) {
    checked++;
    if (checked % 200 === 0) onStatus(`🔍 겹치는 이름 확인 중... ${checked} / ${items.length}`);
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
    } else if (keep.status === 'skip' && !keep.check) {
      it.dupOf = keep.src; // 이미 정리돼 있는 그 파일
      it.dupOfItem = null;
    } else {
      it.dupOfItem = keep.i;
    }
  }

  return { createdAt: Date.now(), source, backupRoot, includeSub, items, stats: summarize(items) };
}

// 개수 요약
function summarize(items) {
  const s = { total: items.length, todo: 0, heic: 0, mov: 0, copy: 0, noDate: 0, dup: 0, check: 0, renamed: 0, skip: 0, unsure: 0, newFolders: 0, byFrom: { 촬영정보: 0, 파일이름: 0, 없음: 0 } };
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

module.exports = { makePlan, summarize, sameShot, sameBytes, keyOf, isVideoPath, NO_DATE_DIR, MOVED_DIR, STATUS_LABEL, statusLabelOf, isIssue };

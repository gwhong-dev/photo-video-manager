// 파일 위치: lib/similar-discard.js
// 역할: 비슷한 사진에서 "버림"으로 고른 사진을 확인하고 옮기기 (단계 4, docs/개발개요-v3.md 4-2)
//   ⚠️ 영구 삭제는 절대 안 해요
//   - 하드디스크(휴지통 있음) → 휴지통
//   - USB·SD카드·네트워크·종류 모름, 또는 휴지통이 "바로 제거" 설정 → 백업 폴더\_정리완료원본\<원래 상대 경로> 로 이동
//     (이 폴더는 갤러리가 읽지 않아요. 지우는 것은 사용자가 확인한 뒤 직접)
//   - 휴지통이 실패하면 이동으로 넘어가요. 휴지통이 실패했는데 파일이 없어졌으면 어디로 갔는지 몰라서 실패로 남겨요
//   - 옮기기 "전에" 로그에 "예정" 줄을 먼저 적어요 (도중에 꺼져도 어떤 파일이었는지 남게)
//   - 백업 폴더 밖의 사진(또는 _정리완료원본 안)은 휴지통에도 보내지 않고 실패로 남겨요
//   - 묶음은 지금 DB로 다시 계산해서 확인해요 (화면이 보낸 묶음을 믿지 않음)
//   - 한 묶음을 모두 버리는 것은 화면에서 사용자가 "모두 버리기"로 고른 묶음만 (whole 로 받은 번호, 2026-11-24 사용자 요청)
//     지금 묶음의 사진이 모두 whole 안에 있어야 해요. 다시 묶이며 새 사진이 들어와 모두 버림이 된 묶음은 거절
//   - 그 밖의 묶음은: 옮기기 직전에 그 묶음에서 남길 사진이 적어도 한 장 디스크에 그대로(크기와 수정 시각) 있어야 옮겨요
//     (앱을 켠 채 탐색기에서 남길 사진을 지우거나 고친 경우. 버릴 사진 쪽은 changedSince가 봐요)
//   - 휴지통 용량을 넘으면 확인 창에 경고 (원본 정리와 같은 기준, lib/cleaner.js binWarnings: 휴지통에 이미 든 크기도 더함)
//   - 라이브 포토: 버리는 사진의 짝 영상(lib/live-pair.js: 같은 이름, 5초 이하, 찍은 시각 3초 안) 한 개도 같이 옮겨요 (2026-11-04 사용자 결정)
//     같은 이름의 다른 파일이 버릴 것 말고도 있으면(어느 사진의 짝인지 모름, 긴 일반 영상) 짝 영상은 그대로 둬요
//     짝 영상은 맨 끝에, 같은 이름의 버릴 사진을 모두 옮긴 뒤에만 옮겨요. 짝 영상만 실패하면 사진은 옮긴 채로 실패를 따로 세요
//   - Electron은 쓰지 않아요 (lib/ 규칙). 휴지통 함수와 드라이브 판단은 밖에서 받아요
//
// 모양
//   checkDiscard(db, root, ids, whole = []) → { files: [{ id, path, name, size, mtimeMs, keepers: [{ path, size, mtimeMs }]|null(모두 버리는 묶음),
//       pair: { path, size, mtimeMs, siblings: [같이 버리는 같은 이름 사진의 경로] }|null }],
//     groups: 건드리는 묶음 수, emptied: 한 장도 안 남는 묶음 수 }
//     (틀리면 사람이 읽을 Error)
//   discardInfo(files, { driveKindOf, recycleOf, binUsedOf, statfs }) → { count, bytes, trash: 휴지통으로 갈 수, move: 옮길 수, pairs: 짝 영상 수, warnings: [글] }
//     (trash와 move는 사진 수예요. 짝 영상은 사진과 같은 곳으로 가요)
//   discardFiles({ root, files, trash, driveKindOf, recycleOf, logger, onProgress })
//     → { trashed, moved, fail, pairs: 옮긴 짝 영상 수, pairFail, done: [옮긴 파일의 경로, 짝 영상 포함], logPath }

const fs = require('fs');
const path = require('path');
const { MOVED_DIR } = require('./planner');
const { buildGroups } = require('./similar');
const { canUseRecycleBin, DRIVE_LABEL } = require('./platform');
const { moveIntoCleaned, binWarnings, noBinUsed, realRootOf } = require('./cleaner');
const { now } = require('./logger');

const MAX_DISCARD = 20000; // 한 번에 옮기는 최대 장수
const { isLivePair } = require('./live-pair');
const noRecycleInfo = async () => null;

// 라이브 포토 짝 영상: 같은 폴더, 같은 이름의 짧은 영상 한 개 (lib/live-pair.js)
//   같은 이름의 다른 파일이 버릴 사진 말고도 있으면(어느 사진의 짝인지 모름, 긴 일반 영상 등) null
function pairOf(db, root, f, want) {
  if (typeof db.sameStem !== 'function') return null;
  const stem = f.path.slice(0, f.path.length - path.extname(f.path).length);
  const same = db.sameStem(root, stem).filter((x) => x.id !== f.id);
  const videos = same.filter((x) => x.mediaType === 'video' && isLivePair(f, x));
  const others = same.filter((x) => !videos.includes(x));
  if (videos.length !== 1 || others.some((x) => !want.has(x.id))) return null;
  // 같은 이름의 다른 사진도 버리면, 짝 영상은 번호가 작은 사진에만 붙여요 (두 번 옮기지 않게)
  if (others.some((x) => x.id < f.id)) return null;
  const v = videos[0];
  return { path: v.path, size: v.size, mtimeMs: v.mtimeMs, siblings: others.map((x) => x.path) };
}

function checkDiscard(db, root, ids, whole = []) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('버릴 사진을 골라 주세요');
  if (ids.length > MAX_DISCARD) throw new Error(`한 번에 ${MAX_DISCARD.toLocaleString('en-US')}장까지만 옮길 수 있어요`);
  if (!ids.every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('파일 번호 목록이 올바르지 않아요');
  const want = new Set(ids);
  if (want.size !== ids.length) throw new Error('같은 사진이 두 번 들어 있어요');
  // 모두 버리기로 고른 묶음의 번호들: 버릴 목록 안에 있어야 해요
  if (whole == null) whole = [];
  if (!Array.isArray(whole) || !whole.every((n) => Number.isSafeInteger(n) && want.has(n))) throw new Error('파일 번호 목록이 올바르지 않아요');
  const wholeSet = new Set(whole);
  // 지금 DB로 묶음을 다시 만들어요
  const groups = buildGroups(db.similarRows(root));
  const groupOf = new Map();
  groups.forEach((g, k) => g.ids.forEach((id) => groupOf.set(id, k)));
  const touched = new Set();
  for (const id of ids) {
    if (!groupOf.has(id)) throw new Error('목록이 바뀌었어요. 화면을 다시 불러온 뒤 골라 주세요');
    touched.add(groupOf.get(id));
  }
  const emptied = new Set();
  for (const k of touched) {
    if (!groups[k].ids.every((id) => want.has(id))) continue;
    // 한 장도 안 남는 묶음: 사용자가 이 묶음 전체를 "모두 버리기"로 고른 경우만
    if (!groups[k].ids.every((id) => wholeSet.has(id))) throw new Error('묶음이 바뀌어 남길 사진이 없어졌어요. 화면을 다시 불러온 뒤 골라 주세요');
    emptied.add(k);
  }
  const fileOf = (id) => {
    const f = db.getFile(id);
    if (!f || f.missing || f.root !== root || f.mediaType !== 'photo') throw new Error('목록이 바뀌었어요. 화면을 다시 불러온 뒤 골라 주세요');
    return f;
  };
  // 묶음마다 남는 사진들 (옮기기 직전에 디스크에 그대로 있는지 다시 봐요). 모두 버리는 묶음은 null (볼 것이 없음)
  const keepersOf = new Map();
  for (const k of touched) {
    if (emptied.has(k)) {
      keepersOf.set(k, null);
      continue;
    }
    keepersOf.set(k, groups[k].ids.filter((id) => !want.has(id)).map((id) => {
      const f = fileOf(id);
      return { path: f.path, size: f.size, mtimeMs: f.mtimeMs };
    }));
  }
  const files = [];
  for (const id of ids) {
    const f = fileOf(id);
    files.push({ id: f.id, path: f.path, name: f.name, size: f.size, mtimeMs: f.mtimeMs, keepers: keepersOf.get(groupOf.get(id)), pair: pairOf(db, root, f, want) });
  }
  return { files, groups: touched.size, emptied: emptied.size };
}

// 갤러리에서 고른 사진 · 영상을 휴지통으로 옮기기 전 확인 (2026-11-16 사용자 결정: 사진첩에서 보다가 필요 없는 건 바로 지우기)
//   비슷한 사진과 달리 묶음 조건은 없어요 (사람이 직접 고른 것). 그 밖의 안전은 같아요:
//   지금 백업 폴더의 사라지지 않은 파일만, 옮기기 직전에 크기 · 수정 시각이 그대로인지(changedSince), 백업 폴더 밖은 안 옮김
//   라이브 포토: 고른 사진의 짝 영상도 같이 (짝 영상을 따로 골랐으면 그 파일로 한 번만 옮겨요)
//   돌려주는 값은 checkDiscard 와 같은 모양 { files, groups: 0 }. files 의 keepers 는 없어요 (지킬 묶음이 없음)
function checkSelected(db, root, ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('옮길 사진을 골라 주세요');
  if (ids.length > MAX_DISCARD) throw new Error(`한 번에 ${MAX_DISCARD.toLocaleString('en-US')}장까지만 옮길 수 있어요`);
  if (!ids.every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('파일 번호 목록이 올바르지 않아요');
  const want = new Set(ids);
  if (want.size !== ids.length) throw new Error('같은 사진이 두 번 들어 있어요');
  const picked = ids.map((id) => {
    const f = db.getFile(id);
    if (!f || f.missing || f.root !== root || (f.mediaType !== 'photo' && f.mediaType !== 'video')) throw new Error('목록이 바뀌었어요. 화면을 다시 불러온 뒤 골라 주세요');
    return f;
  });
  const pickedPaths = new Set(picked.map((f) => f.path));
  const files = picked.map((f) => {
    let pair = f.mediaType === 'photo' ? pairOf(db, root, f, want) : null;
    if (pair && pickedPaths.has(pair.path)) pair = null; // 짝 영상도 직접 골랐음 → 그 파일로 옮겨요 (두 번 옮기지 않게)
    return { id: f.id, path: f.path, name: f.name, size: f.size, mtimeMs: f.mtimeMs, pair };
  });
  return { files, groups: 0 };
}

// 휴지통을 쓸 수 있는 파일인지 (드라이브 종류 + "바로 제거" 설정)
async function binUsable(p, driveKindOf, recycleOf) {
  const kind = await driveKindOf(p);
  const recycle = await recycleOf(p);
  return { kind, useBin: canUseRecycleBin(kind) && !(recycle && recycle.nuke), nuke: !!(recycle && recycle.nuke), maxBytes: recycle ? recycle.maxBytes ?? null : null };
}

async function discardInfo(files, { driveKindOf, recycleOf = (driveKindOf && driveKindOf.recycleOf) || noRecycleInfo, binUsedOf = (driveKindOf && driveKindOf.binUsedOf) || noBinUsed, statfs = fs.statfsSync }) {
  let trash = 0;
  let move = 0;
  let bytes = 0;
  let pairs = 0;
  const bins = new Map(); // 드라이브 → { bytes, maxBytes } (휴지통으로 가는 것만)
  for (const f of files) {
    // 짝 영상은 같은 폴더라 사진과 같은 곳으로 가요 → 크기만 더해요
    const size = (Number(f.size) || 0) + (f.pair ? Number(f.pair.size) || 0 : 0);
    if (f.pair) pairs++;
    bytes += size;
    const { useBin, maxBytes } = await binUsable(f.path, driveKindOf, recycleOf);
    if (!useBin) {
      move++;
      continue;
    }
    trash++;
    // 진짜 경로의 드라이브 (휴지통 설정을 찾는 기준과 같게, #74 검증 ⚠️)
    const drive = realRootOf(f.path);
    if (!bins.has(drive)) bins.set(drive, { bytes: 0, maxBytes });
    bins.get(drive).bytes += size;
  }
  // 휴지통 용량을 넘으면 경고 (원본 정리와 같은 기준: 휴지통에 이미 든 크기도 더함, 못 읽으면 이번분만 + 안내)
  const warnings = [];
  for (const [drive, b] of bins) {
    warnings.push(...(await binWarnings(drive, b.bytes, b.maxBytes, { binUsedOf, statfs, failReasonOf: driveKindOf && driveKindOf.binFailReason })).warnings);
  }
  return { count: files.length, bytes, trash, move, pairs, warnings };
}

// 목록을 읽은 뒤 파일이 바뀌었는지 (크기나 수정 시각이 다르면 화면에서 본 사진이 아닐 수 있어요)
//   mtimeMs가 없으면(점검용 목록) 비교하지 않아요
function changedSince(f) {
  if (f.mtimeMs == null) return false;
  const st = fs.statSync(f.path);
  return st.size !== f.size || st.mtimeMs !== f.mtimeMs;
}

// 그 묶음에서 남길 사진이 디스크에 한 장도 그대로 남아 있지 않은지
//   keepers가 없으면(점검용 목록 · 모두 버리기로 고른 묶음) 보지 않아요. checkDiscard는 그 밖에는 늘 넣어요
function keeperGone(f) {
  if (!Array.isArray(f.keepers)) return false;
  return !f.keepers.some((k) => {
    try {
      const st = fs.statSync(k.path);
      return st.isFile() && st.size === k.size && st.mtimeMs === k.mtimeMs;
    } catch (e) {
      return false;
    }
  });
}

// 백업 폴더 안의 사진인지 (밖이거나 이미 _정리완료원본 안이면 휴지통에도 보내지 않아요)
function insideRoot(root, p) {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== MOVED_DIR;
}

//   logKind · logTitle: 로그 파일 이름 앞부분과 첫 줄 (갤러리에서 고른 사진은 'gallery-trash' · '갤러리에서 휴지통으로')
async function discardFiles({ root, files, trash, driveKindOf, recycleOf = (driveKindOf && driveKindOf.recycleOf) || noRecycleInfo, logger, onProgress = () => {}, logKind = 'similar-discard', logTitle = '비슷한 사진 버리기' }) {
  const log = logger.newLog(logKind, `# ${logTitle} / ${now()} / ${files.length}장\n# 백업 폴더: ${root}\n# 시간\t방법\t사진\t옮긴 곳\n# "예정" 줄 다음에 결과 줄이 없으면 그 사진을 옮기는 도중에 꺼진 것`);
  let trashed = 0;
  let moved = 0;
  let fail = 0;
  let pairs = 0;
  let pairFail = 0;
  const done = [];
  // 결과 줄은 적지 못해도 계속해요 (옮긴 목록을 잃으면 DB에 "사라짐"을 못 적어요). 못 적은 줄 수는 돌려줘요
  let logFail = 0;
  const note = (line) => {
    try {
      log.write(line);
    } catch (e) {
      logFail++;
    }
  };
  // 파일 한 개 옮기기 → 'trash' | 'move' (실패하면 Error). what: 로그 줄 앞에 붙이는 말 ('' 사진, '짝 영상 ')
  const moveOne = async (p, what) => {
    const { kind, useBin, nuke } = await binUsable(p, driveKindOf, recycleOf);
    // 예정 줄은 꼭 먼저 적어요. 못 적으면 이 파일은 옮기지 않아요 (부른 쪽 catch에서 실패로 셈)
    log.write(`${now()}\t${what}예정(${useBin ? '휴지통' : '이동'})\t${p}`);
    let trashErr = null;
    if (useBin) {
      try {
        await trash(p);
      } catch (err) {
        trashErr = err;
      }
    }
    if (useBin && !trashErr) {
      done.push(p);
      note(`${now()}\t${what}휴지통\t${p}`);
      return 'trash';
    }
    if (trashErr && !fs.existsSync(p)) throw new Error(`휴지통 결과를 알 수 없어요 (${trashErr.message})`);
    if (trashErr) note(`${now()}\t${what}휴지통 실패 → 이동\t${p}\t${trashErr.message}`);
    const dest = moveIntoCleaned(root, p, '백업 폴더 밖의 사진이라 옮기지 않았어요');
    done.push(p);
    note(`${now()}\t${what}이동(${DRIVE_LABEL[kind] || kind}${nuke ? ', 바로 제거 설정' : ''})\t${p}\t${dest}`);
    return 'move';
  };
  const pairJobs = []; // 사진을 옮긴 뒤 맨 끝에 옮길 짝 영상
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    let photoDone = false;
    try {
      if (!insideRoot(root, f.path)) throw new Error('백업 폴더 밖의 사진이라 옮기지 않았어요');
      if (changedSince(f)) throw new Error('목록을 읽은 뒤 파일이 바뀌어서 옮기지 않았어요');
      if (keeperGone(f)) throw new Error('이 묶음에서 남길 사진이 백업 폴더에 없거나 바뀌어서 옮기지 않았어요');
      if ((await moveOne(f.path, '')) === 'trash') trashed++;
      else moved++;
      photoDone = true;
    } catch (err) {
      fail++;
      note(`${now()}\t실패\t${f.path}\t${err.message}`);
    }
    if (photoDone && f.pair) pairJobs.push(f.pair);
    if (k % 20 === 0 || k === files.length - 1) {
      try {
        onProgress({ done: k + 1, total: files.length });
      } catch (e) { /* 알림 실패는 무시 */ }
    }
  }
  // 짝 영상: 맨 끝에, 같은 이름의 버릴 사진을 모두 옮겼을 때만 (한 장이라도 남았으면 그 사진의 짝일 수 있어요)
  const moved1 = new Set(done);
  for (const pr of pairJobs) {
    try {
      if ((pr.siblings || []).some((p) => !moved1.has(p))) throw new Error('같은 이름의 다른 사진을 옮기지 못해서 짝 영상은 그대로 뒀어요');
      if (!insideRoot(root, pr.path)) throw new Error('백업 폴더 밖의 파일이라 옮기지 않았어요');
      if (!fs.existsSync(pr.path)) throw new Error('짝 영상이 이미 없어요');
      if (changedSince(pr)) throw new Error('목록을 읽은 뒤 파일이 바뀌어서 옮기지 않았어요');
      await moveOne(pr.path, '짝 영상 ');
      pairs++;
    } catch (err) {
      pairFail++;
      note(`${now()}\t짝 영상 실패\t${pr.path}\t${err.message}`);
    }
  }
  note(`# 끝 / 휴지통 ${trashed}, 이동 ${moved}, 실패 ${fail}, 짝 영상 ${pairs}, 짝 영상 실패 ${pairFail}`);
  return { trashed, moved, fail, pairs, pairFail, done, logFail, logPath: log.path };
}

module.exports = { checkDiscard, checkSelected, discardInfo, discardFiles, pairOf, MAX_DISCARD };

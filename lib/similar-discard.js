// 파일 위치: lib/similar-discard.js
// 역할: 비슷한 사진에서 "버림"으로 고른 사진을 확인하고 옮기기 (단계 4, docs/개발개요-v3.md 4-2)
//   ⚠️ 영구 삭제는 절대 안 해요
//   - 하드디스크(휴지통 있음) → 휴지통
//   - USB·SD카드·네트워크·종류 모름, 또는 휴지통이 "바로 제거" 설정 → 백업 폴더\_정리완료원본\<원래 상대 경로> 로 이동
//     (이 폴더는 갤러리가 읽지 않아요. 지우는 것은 사용자가 확인한 뒤 직접)
//   - 휴지통이 실패하면 이동으로 넘어가요. 휴지통이 실패했는데 파일이 없어졌으면 어디로 갔는지 몰라서 실패로 남겨요
//   - 옮기기 "전에" 로그에 "예정" 줄을 먼저 적어요 (도중에 꺼져도 어떤 파일이었는지 남게)
//   - 백업 폴더 밖의 사진(또는 _정리완료원본 안)은 휴지통에도 보내지 않고 실패로 남겨요
//   - 묶음마다 적어도 한 장은 남아야 해요. 묶음을 지금 DB로 다시 계산해서 확인해요 (화면이 보낸 묶음을 믿지 않음)
//   - Electron은 쓰지 않아요 (lib/ 규칙). 휴지통 함수와 드라이브 판단은 밖에서 받아요
//
// 모양
//   checkDiscard(db, root, ids) → { files: [{ id, path, name, size }], groups: 건드리는 묶음 수 }  (틀리면 사람이 읽을 Error)
//   discardInfo(files, { driveKindOf, recycleOf }) → { count, bytes, trash: 휴지통으로 갈 수, move: 옮길 수 }
//   discardFiles({ root, files, trash, driveKindOf, recycleOf, logger, onProgress })
//     → { trashed, moved, fail, done: [옮긴 파일의 경로], logPath }

const fs = require('fs');
const path = require('path');
const { MOVED_DIR } = require('./planner');
const { buildGroups } = require('./similar');
const { canUseRecycleBin, DRIVE_LABEL } = require('./platform');
const { moveIntoCleaned } = require('./cleaner');
const { now } = require('./logger');

const MAX_DISCARD = 20000; // 한 번에 옮기는 최대 장수
const noRecycleInfo = async () => null;

function checkDiscard(db, root, ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('버릴 사진을 골라 주세요');
  if (ids.length > MAX_DISCARD) throw new Error(`한 번에 ${MAX_DISCARD.toLocaleString('en-US')}장까지만 옮길 수 있어요`);
  if (!ids.every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('파일 번호 목록이 올바르지 않아요');
  const want = new Set(ids);
  if (want.size !== ids.length) throw new Error('같은 사진이 두 번 들어 있어요');
  // 지금 DB로 묶음을 다시 만들어요
  const groups = buildGroups(db.similarRows(root));
  const groupOf = new Map();
  groups.forEach((g, k) => g.ids.forEach((id) => groupOf.set(id, k)));
  const touched = new Set();
  for (const id of ids) {
    if (!groupOf.has(id)) throw new Error('목록이 바뀌었어요. 화면을 다시 불러온 뒤 골라 주세요');
    touched.add(groupOf.get(id));
  }
  for (const k of touched) {
    if (groups[k].ids.every((id) => want.has(id))) throw new Error('묶음마다 적어도 한 장은 남겨 주세요');
  }
  const files = [];
  for (const id of ids) {
    const f = db.getFile(id);
    if (!f || f.missing || f.root !== root || f.mediaType !== 'photo') throw new Error('목록이 바뀌었어요. 화면을 다시 불러온 뒤 골라 주세요');
    files.push({ id: f.id, path: f.path, name: f.name, size: f.size, mtimeMs: f.mtimeMs });
  }
  return { files, groups: touched.size };
}

// 휴지통을 쓸 수 있는 파일인지 (드라이브 종류 + "바로 제거" 설정)
async function binUsable(p, driveKindOf, recycleOf) {
  const kind = await driveKindOf(p);
  const recycle = await recycleOf(p);
  return { kind, useBin: canUseRecycleBin(kind) && !(recycle && recycle.nuke), nuke: !!(recycle && recycle.nuke) };
}

async function discardInfo(files, { driveKindOf, recycleOf = (driveKindOf && driveKindOf.recycleOf) || noRecycleInfo }) {
  let trash = 0;
  let move = 0;
  let bytes = 0;
  for (const f of files) {
    bytes += Number(f.size) || 0;
    const { useBin } = await binUsable(f.path, driveKindOf, recycleOf);
    if (useBin) trash++;
    else move++;
  }
  return { count: files.length, bytes, trash, move };
}

// 목록을 읽은 뒤 파일이 바뀌었는지 (크기나 수정 시각이 다르면 화면에서 본 사진이 아닐 수 있어요)
//   mtimeMs가 없으면(점검용 목록) 비교하지 않아요
function changedSince(f) {
  if (f.mtimeMs == null) return false;
  const st = fs.statSync(f.path);
  return st.size !== f.size || st.mtimeMs !== f.mtimeMs;
}

// 백업 폴더 안의 사진인지 (밖이거나 이미 _정리완료원본 안이면 휴지통에도 보내지 않아요)
function insideRoot(root, p) {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== MOVED_DIR;
}

async function discardFiles({ root, files, trash, driveKindOf, recycleOf = (driveKindOf && driveKindOf.recycleOf) || noRecycleInfo, logger, onProgress = () => {} }) {
  const log = logger.newLog('similar-discard', `# 비슷한 사진 버리기 / ${now()} / ${files.length}장\n# 백업 폴더: ${root}\n# 시간\t방법\t사진\t옮긴 곳\n# "예정" 줄 다음에 결과 줄이 없으면 그 사진을 옮기는 도중에 꺼진 것`);
  let trashed = 0;
  let moved = 0;
  let fail = 0;
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
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    try {
      if (!insideRoot(root, f.path)) throw new Error('백업 폴더 밖의 사진이라 옮기지 않았어요');
      if (changedSince(f)) throw new Error('목록을 읽은 뒤 파일이 바뀌어서 옮기지 않았어요');
      const { kind, useBin, nuke } = await binUsable(f.path, driveKindOf, recycleOf);
      // 예정 줄은 꼭 먼저 적어요. 못 적으면 이 사진은 옮기지 않아요 (아래 catch에서 실패로 셈)
      log.write(`${now()}\t예정(${useBin ? '휴지통' : '이동'})\t${f.path}`);
      let trashErr = null;
      if (useBin) {
        try {
          await trash(f.path);
        } catch (err) {
          trashErr = err;
        }
      }
      if (useBin && !trashErr) {
        trashed++;
        done.push(f.path);
        note(`${now()}\t휴지통\t${f.path}`);
      } else {
        if (trashErr && !fs.existsSync(f.path)) throw new Error(`휴지통 결과를 알 수 없어요 (${trashErr.message})`);
        if (trashErr) note(`${now()}\t휴지통 실패 → 이동\t${f.path}\t${trashErr.message}`);
        const dest = moveIntoCleaned(root, f.path, '백업 폴더 밖의 사진이라 옮기지 않았어요');
        moved++;
        done.push(f.path);
        note(`${now()}\t이동(${DRIVE_LABEL[kind] || kind}${nuke ? ', 바로 제거 설정' : ''})\t${f.path}\t${dest}`);
      }
    } catch (err) {
      fail++;
      note(`${now()}\t실패\t${f.path}\t${err.message}`);
    }
    if (k % 20 === 0 || k === files.length - 1) {
      try {
        onProgress({ done: k + 1, total: files.length });
      } catch (e) { /* 알림 실패는 무시 */ }
    }
  }
  note(`# 끝 / 휴지통 ${trashed}, 이동 ${moved}, 실패 ${fail}`);
  return { trashed, moved, fail, done, logFail, logPath: log.path };
}

module.exports = { checkDiscard, discardInfo, discardFiles, MAX_DISCARD };

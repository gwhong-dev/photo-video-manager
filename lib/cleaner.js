// 파일 위치: lib/cleaner.js
// 역할: 원본 정리 — 어떤 원본을 정리해도 되는지 고르기
//
// 정리해도 되는 원본 (결과 파일이 백업 폴더에 확실히 있을 때만)
//   - 완료(done): 결과 파일이 있음
//   - 중복(dup): "확인 필요"가 아니고, 남길 파일이 있고, 그 파일과 지문(해시)까지 같을 때만
//       → HEIC·MOV처럼 변환된 중복은 지문이 같을 수 없어서 정리 안 하고 남겨요
//   - 실패 / 대기 / 이미 정리됨 → 남겨 둠
//
// 정리 방법 (⚠️ 영구 삭제는 절대 안 해요)
//   - 하드디스크(휴지통 있음) → 휴지통
//   - USB·SD카드·네트워크·종류 모름(휴지통 없음) → 가져올 폴더\_정리완료원본 으로 이동 (폴더 구조 유지)
//   - 휴지통이 "바로 제거"로 설정된 하드디스크 → 휴지통에 보내면 영구 삭제될 수 있어서 똑같이 이동

const fs = require('fs');
const path = require('path');
const { keyOf, MOVED_DIR } = require('./planner');
const { createDriveKindOf, canUseRecycleBin, DRIVE_LABEL } = require('./platform');
const { sameFile, hashFile } = require('./paths'); // hashFile: 정리 직전에 매번 새로 계산
const { now } = require('./logger');

// 원본 대신 남아 있을 결과 파일
function keepPathOf(job, it) {
  if (it.finalPath) return it.finalPath;
  if (it.dupOf) return it.dupOf;
  if (it.dupOfItem != null) {
    const keep = job.items[it.dupOfItem];
    if (keep && keep.status === 'done' && keep.finalPath) return keep.finalPath;
  }
  return null;
}

// 두 파일 크기가 같은지 (못 읽으면 다르다고 봐요)
function sameSize(a, b) {
  try {
    return fs.statSync(a).size === fs.statSync(b).size;
  } catch (e) {
    return false;
  }
}

// 빠른 확인 (지문 계산 없이) — 배너에 "정리할 수 있는 원본 N개" 보여줄 때
//   중복은 크기까지 봐요: 크기가 다르면 정리 직전 확인에서 어차피 빠져서, 배너 개수와 확인 창 개수가 달라져요
function cleanCandidates(job) {
  if (!job) return [];
  return job.items.filter((it) => {
    if (it.trashed || it.movedTo) return false; // 이미 정리함
    if (it.status !== 'done' && it.status !== 'dup') return false;
    if (it.status === 'dup' && it.check) return false; // 확인 필요 → 사람이 봐야 해요
    if (!fs.existsSync(it.src)) return false;
    const keep = keepPathOf(job, it);
    // 남길 파일이 원본과 "확실히 다른 파일"일 때만 (경로가 달라도 같은 파일일 수 있어요 → lib/paths.js)
    if (!keep || keyOf(keep) === keyOf(it.src) || !fs.existsSync(keep) || sameFile(keep, it.src) !== false) return false;
    return it.status !== 'dup' || sameSize(keep, it.src);
  });
}

// 결과 파일이 멀쩡한지: 0바이트가 아니고, 열어서 읽을 수 있고, (기록해 둔 지문이 있으면) 지문이 같은지
async function resultOk(p, expectedHash, hashOf) {
  try {
    if (fs.statSync(p).size === 0) return false;
    const fd = fs.openSync(p, 'r');
    try {
      fs.readSync(fd, Buffer.alloc(1), 0, 1, 0); // 실제로 읽히는지
    } finally {
      fs.closeSync(fd);
    }
    if (expectedHash) return (await hashOf(p)) === expectedHash;
    return true;
  } catch (e) {
    return false;
  }
}

// 정리 직전의 엄격한 확인
//   완료: 결과 파일이 멀쩡해야 (0바이트 아님, 읽힘, 저장할 때 기록한 지문과 같음)
//   중복: 남길 파일과 지문까지 같아야
//   hashOf: 지문 계산 함수 (점검 때 바꿔 끼울 수 있게)
//   onProgress({ done, total }): 파일 하나 확인할 때마다 (큰 영상이 많으면 1분 넘게 걸려서 화면에 보여줘요)
async function cleanTargets(job, { hashOf = hashFile, onProgress = () => {} } = {}) {
  const out = [];
  const list = cleanCandidates(job);
  for (let k = 0; k < list.length; k++) {
    const it = list[k];
    const keep = keepPathOf(job, it);
    if (it.status === 'done') {
      if (await resultOk(keep, it.resultHash, hashOf)) out.push(it);
    } else {
      try {
        // 크기가 다르면 지문도 다름
        if (fs.statSync(keep).size === fs.statSync(it.src).size && (await resultOk(keep, null, hashOf)) && (await hashOf(it.src)) === (await hashOf(keep))) {
          out.push(it);
        }
      } catch (e) {
        // 못 읽으면 안전하게 남겨 둠
      }
    }
    onProgress({ done: k + 1, total: list.length });
  }
  return out;
}

// 휴지통 설정을 알 수 없을 때 (점검의 가짜 드라이브 판단 등)
const noRecycleInfo = async () => null;

// 정리하기 전에 보여줄 정보: 개수, 용량, 드라이브별 방법, 경고
//   driveKindOf / recycleOf / statfs: 점검 때 가짜 함수로 바꿔 끼울 수 있게
//   드라이브 종류는 부를 때마다 새로 확인해요 (USB를 바꿔 꽂았을 수 있어서)
async function cleanInfo(job, targets, { driveKindOf = createDriveKindOf(), recycleOf = driveKindOf.recycleOf || noRecycleInfo, statfs = fs.statfsSync } = {}) {
  const groups = new Map(); // 드라이브 + 종류 + 방법별 (C: 안의 폴더에 연결된 USB는 따로 묶임)
  for (const it of targets) {
    const root = path.parse(it.src).root;
    const kind = await driveKindOf(it.src);
    const recycle = await recycleOf(it.src);
    const nuke = !!(recycle && recycle.nuke);
    const method = canUseRecycleBin(kind) && !nuke ? 'trash' : 'move';
    const key = `${root}|${kind}|${method}`;
    if (!groups.has(key)) {
      groups.set(key, { root, kind, label: DRIVE_LABEL[kind], method, nuke: canUseRecycleBin(kind) && nuke, maxBytes: recycle ? recycle.maxBytes : null, count: 0, bytes: 0 });
    }
    const d = groups.get(key);
    d.count++;
    d.bytes += it.size || 0;
  }

  const drives = [...groups.values()];
  const warnings = [];
  for (const d of drives) {
    if (d.nuke) warnings.push(`${d.root} 드라이브: 휴지통이 "바로 제거"로 설정돼 있어요 → 영구 삭제되지 않게 휴지통 대신 _정리완료원본으로 옮겨요`);
    if (d.method !== 'trash') continue;
    // 휴지통 용량보다 크면, 넘치는 건 Windows가 먼저 버린 것부터 비워요
    //   이번 정리분 + 이 작업에서 이미 휴지통에 보낸 것까지 더해서 확인
    const already = ((job && job.items) || [])
      .filter((it) => it.trashed && path.parse(it.src).root === d.root)
      .reduce((a, it) => a + (it.size || 0), 0);
    // 휴지통 설정을 읽었으면 그 크기로 확인
    if (d.maxBytes != null) {
      if (d.bytes + already > d.maxBytes) {
        const gb = (d.maxBytes / 1024 ** 3).toFixed(1);
        warnings.push(`${d.root} 드라이브: 휴지통 설정 크기(${gb}GB)를 넘어요 → 먼저 휴지통에 보낸 원본이 자동으로 비워질 수 있어요`);
      }
      continue;
    }
    // 설정을 모르면 보통 크기(드라이브의 5% 정도)로 짐작
    try {
      const s = statfs(d.root);
      if (d.bytes + already > s.blocks * s.bsize * 0.05) {
        warnings.push(`${d.root} 드라이브: 휴지통 용량(드라이브의 약 5%)을 넘을 수 있어요 → 먼저 휴지통에 보낸 원본이 자동으로 비워질 수 있어요`);
      }
    } catch (e) {
      // 확인 못 하면 넘어감
    }
  }
  return { count: targets.length, bytes: drives.reduce((a, d) => a + d.bytes, 0), drives, warnings };
}

// 같은 이름이 이미 있으면 _1, _2 ... (절대 덮어쓰지 않음)
function freePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let n = 1; ; n++) {
    const cand = `${stem}_${n}${ext}`;
    if (!fs.existsSync(cand)) return cand;
  }
}

// 휴지통 없는 드라이브: 가져올 폴더\_정리완료원본\<원래 상대 경로> 로 옮기기
//   같은 드라이브 안에서 이름만 바꾸는 것(rename)이라 공간을 쓰지 않아요.
//   다른 드라이브로는 옮기지 않아요 (복사 후 지우기 = 위험해서 실패로 남김)
function moveToCleanedDir(job, src) {
  const rel = path.relative(job.source, src);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('가져올 폴더 밖의 파일이라 옮기지 않았어요');
  const dest = freePath(path.join(job.source, MOVED_DIR, rel));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return dest;
}

// 원본 정리 실행
//   trash: 휴지통으로 보내는 함수 (앱에서는 Electron의 shell.trashItem, 점검 때는 가짜)
//   드라이브 종류는 정리할 때마다 새로 확인해요
//   휴지통이 실패하거나 "바로 제거"로 설정돼 있으면 → 영구 삭제하지 않고 _정리완료원본으로 이동
async function cleanOriginals({ job, store, targets, logger, trash, driveKindOf = createDriveKindOf(), recycleOf = driveKindOf.recycleOf || noRecycleInfo, onProgress = () => {} }) {
  const log = logger.newLog('clean', `# 원본 정리 / ${now()} / ${targets.length}개\n# 시간\t방법\t원본\t옮긴 곳 또는 남아 있는 결과 파일`);
  let trashed = 0;
  let moved = 0;
  let fail = 0;
  for (let k = 0; k < targets.length; k++) {
    const it = targets[k];
    try {
      const kind = await driveKindOf(it.src);
      const recycle = await recycleOf(it.src);
      const useBin = canUseRecycleBin(kind) && !(recycle && recycle.nuke);
      let trashErr = null;
      if (useBin) {
        try {
          await trash(it.src);
        } catch (err) {
          trashErr = err;
        }
      }
      if (useBin && !trashErr) {
        store.mark(job, it.i, { trashed: true });
        trashed++;
        log.write(`${now()}\t휴지통\t${it.src}\t${keepPathOf(job, it)}`);
      } else {
        // 휴지통이 실패했는데 원본이 이미 없어졌다면 → 어디로 갔는지 모르니 이동하지 않고 실패로 기록
        if (trashErr && !fs.existsSync(it.src)) throw new Error(`휴지통 결과를 알 수 없어요 (${trashErr.message})`);
        if (trashErr) log.write(`${now()}\t휴지통 실패 → 이동\t${it.src}\t${trashErr.message}`);
        const dest = moveToCleanedDir(job, it.src);
        store.mark(job, it.i, { movedTo: dest });
        moved++;
        log.write(`${now()}\t이동(${DRIVE_LABEL[kind]}${canUseRecycleBin(kind) && !useBin ? ', 바로 제거 설정' : ''})\t${it.src}\t${dest}`);
      }
    } catch (err) {
      fail++;
      log.write(`${now()}\t실패\t${it.src}\t${err.message}`);
    }
    if (k % 20 === 0 || k === targets.length - 1) onProgress({ done: k + 1, total: targets.length });
  }
  log.write(`# 끝 / 휴지통 ${trashed}, 이동 ${moved}, 실패 ${fail}`);
  return { trashed, moved, fail, logPath: log.path };
}

module.exports = { hashFile, keepPathOf, cleanCandidates, cleanTargets, cleanInfo, cleanOriginals };

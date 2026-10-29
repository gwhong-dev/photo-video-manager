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

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { keyOf, MOVED_DIR } = require('./planner');
const { driveKind, canUseRecycleBin, DRIVE_LABEL } = require('./platform');
const { sameFile } = require('./paths');
const { now } = require('./logger');

// 파일 지문(해시) — 정리 직전에 매번 새로 계산해요 (예전 값 안 믿음)
function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(p)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

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

// 빠른 확인 (파일이 있는지만) — 배너에 "정리할 수 있는 원본 N개" 보여줄 때
function cleanCandidates(job) {
  if (!job) return [];
  return job.items.filter((it) => {
    if (it.trashed || it.movedTo) return false; // 이미 정리함
    if (it.status !== 'done' && it.status !== 'dup') return false;
    if (it.status === 'dup' && it.check) return false; // 확인 필요 → 사람이 봐야 해요
    if (!fs.existsSync(it.src)) return false;
    const keep = keepPathOf(job, it);
    // 남길 파일이 원본과 "확실히 다른 파일"일 때만 (경로가 달라도 같은 파일일 수 있어요 → lib/paths.js)
    return !!keep && keyOf(keep) !== keyOf(it.src) && fs.existsSync(keep) && sameFile(keep, it.src) === false;
  });
}

// 정리 직전의 엄격한 확인 — 중복은 지문까지 같아야 대상
//   hashOf: 지문 계산 함수 (점검 때 바꿔 끼울 수 있게)
async function cleanTargets(job, { hashOf = hashFile } = {}) {
  const out = [];
  for (const it of cleanCandidates(job)) {
    if (it.status === 'done') {
      out.push(it);
      continue;
    }
    const keep = keepPathOf(job, it);
    try {
      if (fs.statSync(keep).size !== fs.statSync(it.src).size) continue; // 크기가 다르면 지문도 다름
      if ((await hashOf(it.src)) === (await hashOf(keep))) out.push(it);
    } catch (e) {
      // 못 읽으면 안전하게 남겨 둠
    }
  }
  return out;
}

// 정리하기 전에 보여줄 정보: 개수, 용량, 드라이브별 방법, 경고
//   driveKindOf / statfs: 점검 때 가짜 함수로 바꿔 끼울 수 있게
async function cleanInfo(job, targets, { driveKindOf = driveKind, statfs = fs.statfsSync } = {}) {
  const byRoot = new Map();
  for (const it of targets) {
    const root = path.parse(it.src).root;
    if (!byRoot.has(root)) {
      const kind = await driveKindOf(it.src);
      byRoot.set(root, { root, kind, label: DRIVE_LABEL[kind], method: canUseRecycleBin(kind) ? 'trash' : 'move', count: 0, bytes: 0 });
    }
    const d = byRoot.get(root);
    d.count++;
    d.bytes += it.size || 0;
  }

  const drives = [...byRoot.values()];
  const warnings = [];
  for (const d of drives) {
    if (d.method !== 'trash') continue;
    // 휴지통 용량(보통 드라이브의 5% 정도)보다 크면, 넘치는 건 Windows가 바로 지울 수 있어요
    try {
      const s = statfs(d.root);
      if (d.bytes > s.blocks * s.bsize * 0.05) warnings.push(`${d.root} 드라이브: 휴지통 용량보다 클 수 있어요 → 일부는 휴지통에 안 남을 수 있어요`);
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
async function cleanOriginals({ job, store, targets, logger, trash, driveKindOf = driveKind, onProgress = () => {} }) {
  const log = logger.newLog('clean', `# 원본 정리 / ${now()} / ${targets.length}개\n# 시간\t방법\t원본\t옮긴 곳 또는 남아 있는 결과 파일`);
  let trashed = 0;
  let moved = 0;
  let fail = 0;
  for (let k = 0; k < targets.length; k++) {
    const it = targets[k];
    try {
      const kind = await driveKindOf(it.src);
      if (canUseRecycleBin(kind)) {
        await trash(it.src);
        store.mark(job, it.i, { trashed: true });
        trashed++;
        log.write(`${now()}\t휴지통\t${it.src}\t${keepPathOf(job, it)}`);
      } else {
        const dest = moveToCleanedDir(job, it.src);
        store.mark(job, it.i, { movedTo: dest });
        moved++;
        log.write(`${now()}\t이동(${DRIVE_LABEL[kind]})\t${it.src}\t${dest}`);
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

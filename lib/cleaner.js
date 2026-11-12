// 파일 위치: lib/cleaner.js
// 역할: 원본 정리 — 어떤 원본을 정리해도 되는지 고르기
//
// 정리해도 되는 원본 (결과 파일이 백업 폴더에 확실히 있을 때만)
//   - 완료(done): 결과 파일이 있음
//   - 중복(dup): "확인 필요"가 아니고, 남길 파일이 있고, 그 파일과 지문(해시)까지 같을 때만
//   - 변환할 파일(HEIC·MOV)의 중복: 지문이 같을 수 없어서, 미리보기에서 애플 ID로 같은 촬영이 된 것(sameShot)만
//       정리 직전에 원본과 남길 파일의 정보를 다시 읽어 애플 ID, 촬영 날짜, 가로×세로가 모두 같을 때 정리 (2026-11-04 사용자 결정)
//       (MP4 결과에는 애플 ID를 옮기지 않아서 영상은 사실상 남아요. 정보를 못 읽으면 남겨 둬요)
//   - 실패 / 재생 불가 / 대기 / 이미 정리됨 → 남겨 둠
//   - 남을 파일이 영상이면 정리 직전에 재생되는지도 확인 (이 확인이 생기기 전에 백업된 손상 영상을 걸러요)
//
// 정리 방법 (⚠️ 영구 삭제는 절대 안 해요)
//   - 하드디스크(휴지통 있음) → 휴지통
//   - USB·SD카드·네트워크·종류 모름(휴지통 없음) → 가져올 폴더\_정리완료원본 으로 이동 (폴더 구조 유지)
//   - 휴지통이 "바로 제거"로 설정된 하드디스크 → 휴지통에 보내면 영구 삭제될 수 있어서 똑같이 이동

const fs = require('fs');
const path = require('path');
const { keyOf, isVideoPath, MOVED_DIR } = require('./planner');
const { probeVideo } = require('./tools');
const { createDriveKindOf, canUseRecycleBin, DRIVE_LABEL } = require('./platform');
const { sameFile, hashFile, realPath } = require('./paths');

// 파일이 실제로 있는 드라이브 (C:\사진 이 D: 로 연결된 폴더면 D:\)
//   휴지통 크기와 휴지통 설정을 같은 드라이브 기준으로 읽으려고 진짜 경로로 봐요 (#72 · #74 검증 ⚠️)
const realRootOf = (p) => path.parse(realPath(p)).root;
const { now } = require('./logger');
const D = require('./dates');

// 변환된 중복이 남길 파일과 같은 촬영인지: 애플 ID, 촬영 날짜, 가로×세로 (가로세로가 바뀐 것은 같다고 봐요: 세로 사진은 변환할 때 방향을 맞춰요)
//   애플 ID는 PhotoIdentifier, ContentIdentifier만 (ImageUniqueID는 여러 회사 카메라가 같은 값을 넣기도 해서 정리 판단에는 안 써요)
//   0.001초(SubSecTimeOriginal)와 수정 시각(ModifyDate)도 원본에 있으면 같아야 해요 (같은 이름으로 다시 내보낸 편집본을 거르려고)
//   readMeta(경로 목록) → Map<keyOf(경로), 정보>. 하나라도 모르거나 다르면 false
async function convertedDupOk(it, keep, readMeta) {
  let meta;
  try {
    meta = await readMeta([it.src, keep]);
  } catch (e) {
    return false;
  }
  const a = meta.get(keyOf(it.src));
  const b = meta.get(keyOf(keep));
  if (!a || !b) return false;
  const idOf = (m) => m.PhotoIdentifier || m.ContentIdentifier || null;
  if (!idOf(a) || idOf(a) !== idOf(b)) return false;
  for (const tag of ['SubSecTimeOriginal', 'ModifyDate']) {
    if (a[tag] != null && String(a[tag]) !== String(b[tag])) return false;
  }
  const da = D.dateFromMeta(a);
  const db = D.dateFromMeta(b);
  if (!da || !db || D.toExif(da.parts) !== D.toExif(db.parts)) return false;
  const dims = (m) => [Number(m.ImageWidth), Number(m.ImageHeight)];
  const [aw, ah] = dims(a);
  const [bw, bh] = dims(b);
  if (![aw, ah, bw, bh].every((n) => Number.isFinite(n) && n > 0)) return false;
  return (aw === bw && ah === bh) || (aw === bh && ah === bw);
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

// 파일 정보 한 번 읽기 (없거나 못 읽으면 null)
function statOrNull(p) {
  try {
    return fs.statSync(p, { bigint: true }); // bigint: Windows 파일 ID가 커서 보통 숫자로는 잘려요
  } catch (e) {
    return null;
  }
}

// 빠른 확인 (지문 계산 없이) — 배너에 "정리할 수 있는 원본 N개" 보여줄 때
//   중복은 크기까지 봐요: 크기가 다르면 정리 직전 확인에서 어차피 빠져서, 배너 개수와 확인 창 개수가 달라져요
//   원본마다 디스크는 두 번만 읽어요 (원본 1번, 남길 파일 1번). 있는지 · 같은 파일인지 · 크기를 그 정보로 봐요
//   (전에는 6번: 중복 6만 개면 36만 번이라 미리보기 직후 멈출 수 있었음, #49 검증)
function cleanCandidates(job) {
  if (!job) return [];
  return job.items.filter((it) => {
    if (it.trashed || it.movedTo) return false; // 이미 정리함
    if (it.status !== 'done' && it.status !== 'dup') return false;
    if (it.status === 'dup' && it.check) return false; // 확인 필요 → 사람이 봐야 해요
    const src = statOrNull(it.src);
    if (!src) return false; // 원본이 없음
    const keep = keepPathOf(job, it);
    if (!keep || keyOf(keep) === keyOf(it.src)) return false;
    const kept = statOrNull(keep);
    // 남길 파일이 원본과 "확실히 다른 파일"일 때만 (경로가 달라도 같은 파일일 수 있어요 → lib/paths.js)
    if (!kept || sameFile(keep, it.src, kept, src) !== false) return false;
    if (it.status !== 'dup') return true;
    // 변환된 중복은 크기가 다를 수밖에 없어요 → 애플 ID로 같은 촬영이 된 것만 (정리 직전에 날짜와 가로×세로까지 다시 봐요)
    if (it.converted) return !!it.sameShot && !!it.dupOf;
    return kept.size === src.size;
  });
}

// 지문 다시 쓰기 (확인 창에서 계산한 지문을 실제 정리 때 다시 써요, 2026-11-09 사용자 결정)
//   파일의 크기 · 수정 시각 · 변경 시각(ctime) · 파일 번호(ino)가 계산할 때와 하나라도 다르면 다시 계산해요
//   변경 시각은 프로그램이 수정 시각을 예전 값으로 되돌려도 바뀌어요 (같은 크기로 덮어쓴 파일을 거르려고, #70 검증 ⚠️)
//   → 확인 창을 띄운 뒤 파일이 바뀌었으면 정리 직전 확인에서 그대로 걸러져요 (안전 확인은 빠지지 않음)
//   정리 한 번(확인 창 → 정리)에만 쓰고 버려요. 앱이 켜진 동안 계속 기억하지 않아요
//   돌려주는 함수에 .stats = { computed: 계산한 수, reused: 다시 쓴 수 } (점검용)
function createHashCache(hashOf = hashFile) {
  const memo = new Map(); // 경로 → { sig, hash }
  const sigOf = (p) => {
    const s = fs.statSync(p, { bigint: true });
    return `${s.size}|${s.mtimeNs}|${s.ctimeNs}|${s.dev}|${s.ino}`;
  };
  const cached = async (p) => {
    const before = sigOf(p); // 못 읽으면 오류 → 부르는 쪽에서 "남겨 둠"
    const m = memo.get(p);
    if (m && m.sig === before) {
      cached.stats.reused++;
      return m.hash;
    }
    const hash = await hashOf(p);
    cached.stats.computed++;
    // 계산하는 도중에 바뀌었으면 기억하지 않아요 (다음에 다시 계산)
    if (sigOf(p) === before) memo.set(p, { sig: before, hash });
    else memo.delete(p);
    return hash;
  };
  cached.stats = { computed: 0, reused: 0 };
  return cached;
}

// 지문 계산 개수를 "지금부터" 세기 (원본 정리 로그 끝 줄에 남기려고, 2026-11-11 사용자 결정)
//   확인 창에서 이미 계산한 개수는 빼고, 실제 정리 직전 확인에서 다시 계산한 수 · 다시 쓴 수만 세요
//   돌려주는 함수를 부르면 { computed, reused }. createHashCache로 만든 함수가 아니면 null (로그에 안 적음)
function countHashesFrom(hashOf) {
  const s = hashOf && hashOf.stats;
  if (!s) return () => null;
  const start = { computed: s.computed, reused: s.reused };
  return () => ({ computed: s.computed - start.computed, reused: s.reused - start.reused });
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
//   ffprobe: 영상 확인 도구 경로. 없으면 재생되는지 모르니 영상 원본은 남겨 둬요
//   store, logger: 손상을 찾으면 "재생 불가"로 기록하고 로그를 남겨요 (배너 개수도 다음부터 맞아요)
//   readMeta: 변환된 중복 확인용 정보 읽기 (없으면 변환된 중복은 남겨 둬요)
async function cleanTargets(job, { hashOf = hashFile, onProgress = () => {}, ffprobe = null, store = null, logger = null, readMeta = null } = {}) {
  const out = [];
  const list = cleanCandidates(job);
  let log = null;
  for (let k = 0; k < list.length; k++) {
    const it = list[k];
    const keep = keepPathOf(job, it);
    const v = isVideoPath(keep) ? await probeVideo(ffprobe, keep) : { ok: true };
    if (v.ok === false) {
      if (store) store.mark(job, it.i, { status: 'broken', note: `백업에 남을 파일이 재생되지 않아서 원본을 남겨 둠 (${v.reason})` });
      if (logger) {
        if (!log) log = logger.newLog('clean-check', `# 정리 직전 확인 / ${now()}\n# 시간\t상태\t원본\t남을 파일\t메모`);
        log.write(`${now()}\t재생불가\t${it.src}\t${keep}\t${v.reason}`);
      }
    } else if (v.ok === null) {
      // 모름 → 남겨 둠 (손상이라고 단정하지는 않아요)
    } else if (it.status === 'done') {
      if (await resultOk(keep, it.resultHash, hashOf)) out.push(it);
    } else if (it.converted) {
      if (readMeta && (await resultOk(keep, null, hashOf)) && (await convertedDupOk(it, keep, readMeta))) out.push(it);
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
// 휴지통에 든 크기를 확인할 수 없을 때 (Windows가 아님, 점검의 가짜 드라이브 판단 등) → 안내 없이 이번 작업분만
const noBinUsed = async () => undefined;

// 정리하기 전에 보여줄 정보: 개수, 용량, 드라이브별 방법, 경고
//   driveKindOf / recycleOf / binUsedOf / statfs: 점검 때 가짜 함수로 바꿔 끼울 수 있게
//   드라이브 종류는 부를 때마다 새로 확인해요 (USB를 바꿔 꽂았을 수 있어서)
//   binUsedOf(드라이브): 휴지통에 이미 든 크기. 숫자면 그걸 더하고, null(못 읽음)이면 이번 작업분만 세고 안내 한 줄
async function cleanInfo(job, targets, { driveKindOf = createDriveKindOf(), recycleOf = driveKindOf.recycleOf || noRecycleInfo, binUsedOf = driveKindOf.binUsedOf || noBinUsed, statfs = fs.statfsSync } = {}) {
  const groups = new Map(); // 드라이브 + 종류 + 방법별 (C: 안의 폴더에 연결된 USB는 따로 묶임)
  for (const it of targets) {
    const root = realRootOf(it.src);
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
    // 이 작업에서 먼저 휴지통에 보낸 원본 (휴지통 크기를 못 읽을 때만 대신 더해요)
    const already = ((job && job.items) || [])
      .filter((it) => it.trashed && realRootOf(it.src) === d.root)
      .reduce((a, it) => a + (it.size || 0), 0);
    const r = await binWarnings(d.root, d.bytes, d.maxBytes, { binUsedOf, fallbackBytes: already, statfs, failReasonOf: driveKindOf.binFailReason });
    d.binUsed = r.used;
    warnings.push(...r.warnings);
  }
  return { count: targets.length, bytes: drives.reduce((a, d) => a + d.bytes, 0), drives, warnings };
}

// 휴지통 용량 경고 (원본 정리와 비슷한 사진 버리기가 같이 써요)
//   이번에 보낼 크기 + 휴지통에 이미 든 크기(다른 작업 · 다른 프로그램에서 버린 것까지)로 판단해요
//   binUsedOf(드라이브): 숫자 = 든 크기, null · 오류 = 못 읽음, undefined = 확인할 휴지통 없음(Windows 아님 · 점검)
//   못 읽으면 fallbackBytes(이 작업에서 이미 보낸 것)만 더하고 안내 한 줄
//   휴지통 크기를 읽으면 이 작업에서 먼저 보낸 것도 그 안에 들어 있어요 → fallbackBytes는 더하지 않음 (두 번 세지 않게)
//   돌려주는 값: { used: 읽은 크기 또는 null, warnings: [글] }
//   failReasonOf(드라이브): 못 읽은 까닭 ('timeout'이면 안내 글에 "시간이 너무 오래 걸렸어요"를 덧붙여요)
async function binWarnings(driveRoot, bytes, maxBytes, { binUsedOf = noBinUsed, fallbackBytes = 0, statfs = fs.statfsSync, failReasonOf = null } = {}) {
  let used = null;
  try {
    used = await binUsedOf(driveRoot);
  } catch (e) {
    used = null; // 읽다 실패 = 못 읽음
  }
  const known = typeof used === 'number' && Number.isFinite(used) && used >= 0;
  const warnings = [];
  const w = binOverflowText(driveRoot, bytes + (known ? used : fallbackBytes), maxBytes, statfs);
  if (w) warnings.push(w);
  if (used !== undefined && !known) {
    const slow = (failReasonOf && failReasonOf(driveRoot)) === 'timeout' ? ' (휴지통에 파일이 많아 시간이 너무 오래 걸렸어요)' : '';
    warnings.push(`${driveRoot} 드라이브: 휴지통에 이미 든 크기를 읽지 못했어요${slow} → 용량 경고는 이 작업에서 휴지통으로 보내는 것만 세어 계산했어요`);
  }
  return { used: known ? used : null, warnings };
}

// 휴지통 용량보다 크면, 넘치는 건 Windows가 먼저 버린 것부터 비워요 → 경고 한 줄 (넘지 않으면 null)
//   maxBytes: 휴지통 설정 크기. 모르면 null → 보통 크기(드라이브의 5% 정도)로 짐작
//   원본 정리와 비슷한 사진 버리기가 같이 써요
function binOverflowText(driveRoot, bytes, maxBytes, statfs = fs.statfsSync) {
  if (maxBytes != null) {
    if (bytes <= maxBytes) return null;
    const gb = (maxBytes / 1024 ** 3).toFixed(1);
    return `${driveRoot} 드라이브: 휴지통 설정 크기(${gb}GB)를 넘어요 → 휴지통에 먼저 들어 있던 파일부터 자동으로 비워질 수 있어요`;
  }
  try {
    const s = statfs(driveRoot);
    if (bytes > s.blocks * s.bsize * 0.05) {
      return `${driveRoot} 드라이브: 휴지통 용량(드라이브의 약 5%)을 넘을 수 있어요 → 휴지통에 먼저 들어 있던 파일부터 자동으로 비워질 수 있어요`;
    }
  } catch (e) {
    // 확인 못 하면 넘어감
  }
  return null;
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
  return moveIntoCleaned(job.source, src, '가져올 폴더 밖의 파일이라 옮기지 않았어요');
}

// baseDir\_정리완료원본\<baseDir 기준 상대 경로> 로 옮기기 (원본 정리, 비슷한 사진 버리기가 같이 써요)
//   baseDir 밖의 파일이나 이미 _정리완료원본 안의 파일은 옮기지 않아요. 같은 이름이 있으면 _1, _2 (덮어쓰지 않음)
function moveIntoCleaned(baseDir, src, outsideText = '폴더 밖의 파일이라 옮기지 않았어요') {
  const rel = path.relative(baseDir, src);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(outsideText);
  if (rel.split(path.sep)[0] === MOVED_DIR) throw new Error('이미 정리한 원본 폴더 안의 파일이에요');
  const dest = freePath(path.join(baseDir, MOVED_DIR, rel));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return dest;
}

// 원본 정리 실행
//   trash: 휴지통으로 보내는 함수 (앱에서는 Electron의 shell.trashItem, 점검 때는 가짜)
//   드라이브 종류는 정리할 때마다 새로 확인해요
//   휴지통이 실패하거나 "바로 제거"로 설정돼 있으면 → 영구 삭제하지 않고 _정리완료원본으로 이동
//   hashStats: 정리 직전 확인의 지문 개수 { computed, reused } (countHashesFrom). 있으면 끝 줄 뒤에 붙여요
async function cleanOriginals({ job, store, targets, logger, trash, driveKindOf = createDriveKindOf(), recycleOf = driveKindOf.recycleOf || noRecycleInfo, onProgress = () => {}, hashStats = null }) {
  const log = logger.newLog('clean', `# 원본 정리 / ${now()} / ${targets.length}개\n# 시간\t방법\t원본\t옮긴 곳 또는 남아 있는 결과 파일\n# "예정" 줄 다음에 결과 줄이 없으면 그 파일을 옮기는 도중에 꺼진 것`);
  let trashed = 0;
  let moved = 0;
  let fail = 0;
  for (let k = 0; k < targets.length; k++) {
    const it = targets[k];
    try {
      const kind = await driveKindOf(it.src);
      const recycle = await recycleOf(it.src);
      const useBin = canUseRecycleBin(kind) && !(recycle && recycle.nuke);
      // 옮기기 "전에" 먼저 적어요 → 옮기는 도중에 꺼져도 어떤 파일을 건드리고 있었는지 로그에 남아요 (L3)
      log.write(`${now()}\t예정(${useBin ? '휴지통' : '이동'})\t${it.src}\t${keepPathOf(job, it)}`);
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
  // 끝 줄은 "# 끝"으로 시작해야 정리 화면(lib/clean-history.js)이 끝까지 적힌 기록으로 읽어요
  const hashText = hashStats ? ` / 지문 다시 계산 ${hashStats.computed}개, 재사용 ${hashStats.reused}개` : '';
  log.write(`# 끝 / 휴지통 ${trashed}, 이동 ${moved}, 실패 ${fail}${hashText}`);
  return { trashed, moved, fail, logPath: log.path };
}

module.exports = { hashFile, createHashCache, countHashesFrom, keepPathOf, cleanCandidates, cleanTargets, convertedDupOk, cleanInfo, cleanOriginals, moveIntoCleaned, binOverflowText, binWarnings, noBinUsed, realRootOf };

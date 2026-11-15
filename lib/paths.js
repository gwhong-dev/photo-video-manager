// 파일 위치: lib/paths.js
// 역할: "진짜 같은 파일·폴더인지" 확인하기
//
// 왜?  같은 폴더도 여러 경로로 열 수 있어요.
//      예) Z:\backup (네트워크 드라이브) = \\NAS\photo\backup, 폴더 연결(junction), subst 드라이브
//      경로 글자만 비교하면 "다른 파일"로 착각해서, 백업 파일을 자기 자신의 중복으로 보고 정리할 수 있어요.
//
// 그래서 두 가지로 확인해요
//   1) 드라이브 일련번호(dev) + 파일 ID(ino) — Windows가 파일마다 붙이는 번호
//   2) realpath — 연결·바로가기를 풀어서 나온 진짜 경로
//   확실하지 않으면 null(모름) → 부르는 쪽에서 "정리 안 함" 같은 안전한 쪽으로 처리해요

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const isWin = process.platform === 'win32';

// 파일 지문(해시) — 매번 새로 계산해요 (예전 값 안 믿음)
function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(p)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

// 파일 "서명": 크기 · 수정 시각 · 변경 시각(ctime) · 드라이브 번호 · 파일 번호 (stat 을 { bigint: true } 로 읽은 것)
//   내용을 바꾸면 수정 시각이, 수정 시각을 예전 값으로 되돌려도 변경 시각이, 지우고 같은 이름으로 다시 만들면 파일 번호가 바뀌어요
//   → 서명이 같으면 "그 뒤로 이 파일을 아무도 건드리지 않았다"로 봐요 (지문을 다시 계산하지 않으려고, 2026-11-15 결정)
function sigOfStat(s) {
  return `${s.size}|${s.mtimeNs}|${s.ctimeNs}|${s.dev}|${s.ino}`;
}
// 파일 서명 읽기 (없거나 못 읽으면 null)
async function fileSig(p) {
  try {
    return sigOfStat(await fs.promises.stat(p, { bigint: true }));
  } catch (e) {
    return null;
  }
}

const norm = (p) => (isWin ? p.toLowerCase() : p);

// 연결을 풀어낸 진짜 경로 (없는 파일이면 그냥 절대 경로)
function realPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (e) {
    return path.resolve(p);
  }
}

// 같은 파일인지: true(같음) / false(다름) / null(확실하지 않음)
//   sa, sb: 이미 읽어 둔 파일 정보(statSync bigint)가 있으면 넘겨요 → 디스크를 다시 읽지 않아요 (원본이 많을 때 빠르게)
//   bigint 정보만 써요. 보통 숫자 정보는 Windows 파일 ID가 잘려서 같은 파일을 다르다고 볼 수 있어서 다시 읽어요 (#53 검증)
const bigStat = (s) => (s && typeof s.ino === 'bigint' && typeof s.dev === 'bigint' ? s : null);
function sameFile(a, b, sa = null, sb = null) {
  try {
    sa = bigStat(sa) || fs.statSync(a, { bigint: true });
    sb = bigStat(sb) || fs.statSync(b, { bigint: true });
  } catch (e) {
    return null; // 둘 중 하나를 못 읽음
  }
  // 파일 ID를 믿을 수 있으면 (0이 아니면) 그것으로 판단
  if (sa.ino !== 0n && sb.ino !== 0n && sa.dev !== 0n && sb.dev !== 0n) {
    return sa.dev === sb.dev && sa.ino === sb.ino;
  }
  // 파일 ID가 없는 곳(일부 네트워크 드라이브 등) → 진짜 경로가 같으면 같은 파일, 아니면 모름
  return norm(realPath(a)) === norm(realPath(b)) ? true : null;
}

// child가 parent 안(또는 같은 곳)에 있는지 — 진짜 경로 기준
function isInsideReal(child, parent) {
  const rel = path.relative(norm(realPath(parent)), norm(realPath(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// 후가공 폴더 이름 (예: 2025년도)
const POST_DIR_RE = /^\d{4}년도$/;

// 가져올 폴더 / 백업 폴더 조합 확인 → { ok, reason }
//   거부: 같은 폴더 / 백업 폴더 안쪽 / 백업 폴더를 포함하는 상위 폴더 / 후가공 폴더(2025년도) 안쪽
function validateFolders(source, backupRoot) {
  if (!source || !fs.existsSync(source)) return { ok: false, reason: '가져올 폴더를 찾을 수 없어요' };
  if (!backupRoot || !fs.existsSync(backupRoot)) return { ok: false, reason: '백업 폴더를 찾을 수 없어요' };

  const rs = realPath(source);
  if (rs.split(path.sep).some((seg) => POST_DIR_RE.test(seg))) {
    return { ok: false, reason: '"2025년도" 같은 후가공 폴더(또는 그 안쪽)는 가져올 폴더로 고를 수 없어요' };
  }
  if (sameFile(source, backupRoot) === true || isInsideReal(source, backupRoot)) {
    return { ok: false, reason: '백업 폴더(또는 그 안쪽 폴더)는 가져올 폴더로 고를 수 없어요. 이미 정리된 파일이라서요' };
  }
  if (isInsideReal(backupRoot, source)) {
    return { ok: false, reason: '백업 폴더를 안에 품고 있는 상위 폴더는 가져올 폴더로 고를 수 없어요' };
  }
  return { ok: true, reason: null };
}

// 폴더를 "고르는 순간" 확인 — 다른 쪽 폴더가 아직 없거나(USB를 뺌) 안 골랐으면 막지 않아요
//   (미리보기를 누를 때 validateFolders로 전부 다시 확인해요)
//   단, 고른 가져올 폴더가 후가공 폴더면 바로 거부
function validatePick(source, backupRoot) {
  const has = (p) => !!p && fs.existsSync(p);
  if (has(source) && has(backupRoot)) return validateFolders(source, backupRoot);
  if (has(source) && realPath(source).split(path.sep).some((seg) => POST_DIR_RE.test(seg))) {
    return { ok: false, reason: '"2025년도" 같은 후가공 폴더(또는 그 안쪽)는 가져올 폴더로 고를 수 없어요' };
  }
  return { ok: true, reason: null };
}

module.exports = { hashFile, sigOfStat, fileSig, realPath, sameFile, isInsideReal, validateFolders, validatePick, POST_DIR_RE };

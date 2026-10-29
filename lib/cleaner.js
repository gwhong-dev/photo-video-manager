// 파일 위치: lib/cleaner.js
// 역할: 원본 정리 — 어떤 원본을 정리해도 되는지 고르기
//
// 정리해도 되는 원본 (결과 파일이 백업 폴더에 확실히 있을 때만)
//   - 완료(done): 결과 파일이 있음
//   - 중복(dup): "확인 필요"가 아니고, 남길 파일이 있고, 그 파일과 지문(해시)까지 같을 때만
//       → HEIC·MOV처럼 변환된 중복은 지문이 같을 수 없어서 정리 안 하고 남겨요
//   - 실패 / 대기 / 이미 정리됨 → 남겨 둠

const fs = require('fs');
const crypto = require('crypto');
const { keyOf } = require('./planner');

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

// 이 원본 대신 남아 있을 결과 파일
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
    return !!keep && keyOf(keep) !== keyOf(it.src) && fs.existsSync(keep);
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

module.exports = { hashFile, keepPathOf, cleanCandidates, cleanTargets };

// 파일 위치: lib/import-screening.js
// 역할: 가져오기 전 거르기 · 가져올 때 태그 한 번에 (2026-11-18 사용자 결정) 의 판단만 모은 곳
//   설계: docs/superpowers/specs/2026-11-18-import-screening-design.md
//   Electron · DB 를 모르는 계산만 있어요 (점검을 일반 Node 로 돌려요). 파일은 읽기만 해요 (같은 폴더인지 볼 때)
//   - screenConflict: 거를 폴더가 진행 중인 작업의 가져올 폴더와 겹치는지
//   - defaultTagName · importTagOf: 태그 이름 (기본값 = 가져올 폴더 이름, 태그 이름 규칙 cleanTagName)
//   - tagTargets: 회차가 끝난 뒤 태그를 붙일 백업 쪽 파일 경로

const path = require('path');
const { isInsideReal } = require('./paths');
const { cleanTagName } = require('./manual-tags');

// 거를 폴더가 진행 중인 작업의 가져올 폴더와 같거나 안쪽 · 바깥쪽이면 참
//   (작업 목록에 있는 원본을 거르기에서 옮기면 다음 실행에서 실패가 생겨요, 설계 4-2)
function screenConflict(jobSource, source) {
  if (!jobSource || !source) return false;
  return isInsideReal(source, jobSource) || isInsideReal(jobSource, source);
}

// 기본 태그 이름: 가져올 폴더 이름을 태그 이름 규칙으로 다듬은 것. 규칙에 안 맞으면 '' (화면은 빈칸 + 끔)
function defaultTagName(source) {
  if (typeof source !== 'string' || !source.trim()) return ''; // 빈 경로를 지금 폴더로 풀지 않게
  try {
    return cleanTagName(path.basename(path.resolve(String(source || ''))));
  } catch (e) {
    return '';
  }
}

// 실행 때 화면이 보낸 태그 → 작업에 적을 이름. 안 붙이면(null · undefined · '') null, 규칙에 안 맞으면 사람이 읽을 Error
function importTagOf(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  return cleanTagName(raw);
}

// 원본 대신 백업 폴더에 남는 파일 (중복이면 이미 있던 파일, lib/cleaner.js keepPathOf 와 같은 순서)
function keepPathOf(job, it) {
  if (it.finalPath) return it.finalPath;
  if (it.dupOf) return it.dupOf;
  if (it.dupOfItem != null) {
    const keep = job.items[it.dupOfItem];
    if (keep && keep.status === 'done' && keep.finalPath) return keep.finalPath;
  }
  return null;
}

// 미리보기 때 이미 "중복"이던 원본은 회차에서 처리하지 않아요 → 첫 회차(아직 결과 파일이 하나도 없음)에 같이 붙여요
//   회차를 시작하기 전에 불러서 기억해 둬요
const isFirstRun = (job) => !job.items.some((it) => it.finalPath);

// 태그 붙일 경로: batch = 이번 회차에 처리한 항목들 (nextTodo 결과, 처리 뒤 상태가 적혀 있음)
//   done → 결과 파일, dup → 남는 파일 (확인 필요 check 인 "비슷한 다른 버전"은 빼요: 이번 사진과 같은지 확실하지 않아서)
//   withPlanDups: 첫 회차면 미리보기 때부터 중복이던 항목의 남는 파일도
//   백업 폴더(job.backupRoot) 안의 경로만, 겹치지 않게
function tagTargets(job, batch, { withPlanDups = false } = {}) {
  const out = [];
  const seen = new Set();
  const add = (it) => {
    if (it.check) return;
    if (it.status !== 'done' && it.status !== 'dup') return;
    const p = keepPathOf(job, it);
    if (!p) return;
    const rel = path.relative(path.resolve(job.backupRoot), path.resolve(p));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    const k = path.resolve(p).toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(p);
  };
  for (const it of batch || []) add(it);
  if (withPlanDups) {
    const inBatch = new Set((batch || []).map((it) => it.i));
    for (const it of job.items) if (it.status === 'dup' && !it.finalPath && !inBatch.has(it.i)) add(it);
  }
  return out;
}

module.exports = { screenConflict, defaultTagName, importTagOf, keepPathOf, isFirstRun, tagTargets };

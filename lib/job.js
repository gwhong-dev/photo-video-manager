// 파일 위치: lib/job.js
// 역할: 작업 목록 저장 & 이어하기 (게임 세이브 파일 같은 것)
//
// jobs 폴더
//   current.json          ← 미리보기로 만든 계획 전체 (처음 한 번 저장)
//   current.progress.log  ← 파일 1개 끝날 때마다 한 줄씩 추가 (가볍고, 꺼져도 안전)
//   done\                 ← 끝난 작업 보관

const fs = require('fs');
const path = require('path');

// 파일 이름용 시간 (예: 2026-10-13_004603)
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

class JobStore {
  constructor(dir) {
    this.dir = dir;
    this.planPath = path.join(dir, 'current.json');
    this.progPath = path.join(dir, 'current.progress.log');
    fs.mkdirSync(dir, { recursive: true });
  }

  exists() {
    return fs.existsSync(this.planPath);
  }

  // 새 작업 만들기
  //   계획 없이 진행 기록만 남아 있으면(지난 close가 반쯤 실패) 지우지 않고 done 폴더에 보관해요 (L5)
  create(plan) {
    const job = { ...plan, id: stamp() };
    if (fs.existsSync(this.progPath)) this._archiveProgress(stamp(), 'orphan');
    fs.writeFileSync(this.planPath, JSON.stringify(job), 'utf8');
    return job;
  }

  // 진행 기록을 done 폴더로 옮겨요 (같은 이름이 있으면 _1, _2)
  _archiveProgress(st, reason) {
    const doneDir = path.join(this.dir, 'done');
    fs.mkdirSync(doneDir, { recursive: true });
    const base = path.join(doneDir, `${st}_${reason}.progress.log`);
    let dest = base;
    for (let n = 1; fs.existsSync(dest); n++) dest = base.replace(/\.progress\.log$/, `_${n}.progress.log`);
    fs.renameSync(this.progPath, dest);
  }

  // 저장된 작업 불러오기 (진행 기록을 다시 적용)
  load() {
    if (!this.exists()) return null;
    const job = JSON.parse(fs.readFileSync(this.planPath, 'utf8'));
    if (fs.existsSync(this.progPath)) {
      const lines = fs.readFileSync(this.progPath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const { i, ...patch } = JSON.parse(line);
          if (job.items[i]) Object.assign(job.items[i], patch);
        } catch (e) {
          // 꺼지면서 반쯤 써진 마지막 줄은 무시
        }
      }
    }
    return job;
  }

  // 파일 1개 상태 기록
  mark(job, i, patch) {
    Object.assign(job.items[i], patch);
    fs.appendFileSync(this.progPath, JSON.stringify({ i, ...patch }) + '\n', 'utf8');
  }

  // 작업 끝 → done 폴더로 보관
  //   진행 기록을 먼저 옮기고 계획을 옮겨요. 계획 옮기기가 실패하면 진행 기록을 되돌려 놓아요 (L5)
  //   → 반쯤 실패해도 "계획은 있는데 진행 기록이 없음"(처음부터 다시 하는 것으로 보임)이나 "기록만 남아 다음 작업이 지움"이 되지 않아요
  close(reason) {
    if (!this.exists()) return;
    const doneDir = path.join(this.dir, 'done');
    fs.mkdirSync(doneDir, { recursive: true });
    const st = stamp();
    const hadProgress = fs.existsSync(this.progPath);
    let progDest = null;
    if (hadProgress) {
      progDest = path.join(doneDir, `${st}_${reason}.progress.log`);
      fs.renameSync(this.progPath, progDest);
    }
    try {
      fs.renameSync(this.planPath, path.join(doneDir, `${st}_${reason}.json`));
    } catch (e) {
      if (progDest) {
        try { fs.renameSync(progDest, this.progPath); } catch (e2) { /* 되돌리기도 실패하면 기록은 done 폴더에 남아 있어요 */ }
      }
      throw e;
    }
  }
}

// 원본을 정리해도 되는지는 lib/cleaner.js 에서 골라요

// 현재 상태 숫자
function jobStats(job) {
  const s = { total: job.items.length, todo: 0, done: 0, dup: 0, fail: 0, broken: 0, skip: 0, trashed: 0 };
  for (const it of job.items) {
    s[it.status] = (s[it.status] || 0) + 1;
    if (it.trashed) s.trashed++;
  }
  return s;
}

module.exports = { JobStore, jobStats };

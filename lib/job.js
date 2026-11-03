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

// 같은 이름이 이미 있으면 _1, _2 ... (같은 1초 안에 두 번 보관해도 덮어쓰지 않게)
function freeName(p) {
  if (!fs.existsSync(p)) return p;
  const ext = p.endsWith('.progress.log') ? '.progress.log' : path.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let n = 1; ; n++) {
    const cand = `${stem}_${n}${ext}`;
    if (!fs.existsSync(cand)) return cand;
  }
}

// 계획 파일 + 진행 기록 → 작업 (진행 기록을 다시 적용)
function readJob(planPath, progPath) {
  const job = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  if (fs.existsSync(progPath)) {
    const lines = fs.readFileSync(progPath, 'utf8').split('\n');
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
  //   지난 작업의 진행 기록이 남아 있으면(보관이 반쯤 실패) 지우지 않고 done\ 에 보관해요 (L5)
  create(plan) {
    const job = { ...plan, id: stamp() };
    if (fs.existsSync(this.progPath)) this._keepProgress('orphan');
    fs.writeFileSync(this.planPath, JSON.stringify(job), 'utf8');
    return job;
  }

  // 진행 기록을 done\ 으로 옮기기. 이름 바꾸기가 안 되면 복사한 뒤 지워요 (둘 다 안 되면 오류 → 기록을 잃지 않음)
  //   suffix: 계획 파일 이름에 붙은 `_1` 같은 꼬리 (계획과 진행 기록이 같은 이름 짝이 되게)
  _keepProgress(reason, st = stamp(), suffix = '') {
    const doneDir = path.join(this.dir, 'done');
    fs.mkdirSync(doneDir, { recursive: true });
    const dest = freeName(path.join(doneDir, `${st}_${reason}${suffix}.progress.log`));
    try {
      fs.renameSync(this.progPath, dest);
    } catch (e) {
      fs.copyFileSync(this.progPath, dest);
      fs.unlinkSync(this.progPath);
    }
    return dest;
  }

  // 저장된 작업 불러오기 (진행 기록을 다시 적용)
  load() {
    if (!this.exists()) return null;
    return readJob(this.planPath, this.progPath);
  }

  // 이전 작업에서 변환을 끝낸 원본 → Map<keyFn(원본, 크기, 수정 시각), 결과 파일> (M4, 2026-11-04 사용자 결정)
  //   지금 작업과 done\ 의 보관 작업을 모두 봐요. 수정 시각이 적힌 작업(이 기능 뒤에 만든 것)만 써요
  //   한 작업 파일이 깨져 있어도 나머지는 계속 읽어요 (onError로 알림)
  priorResults(keyFn, onError = () => {}) {
    const map = new Map();
    const pairs = [];
    const doneDir = path.join(this.dir, 'done');
    try {
      for (const n of fs.readdirSync(doneDir)) {
        if (n.endsWith('.json')) pairs.push([path.join(doneDir, n), path.join(doneDir, `${n.slice(0, -'.json'.length)}.progress.log`)]);
      }
    } catch (e) { /* 보관 폴더 없음 */ }
    pairs.sort((a, b) => a[0].localeCompare(b[0])); // 오래된 것부터 → 같은 원본이면 나중 결과가 이겨요
    if (this.exists()) pairs.push([this.planPath, this.progPath]);
    for (const [plan, prog] of pairs) {
      let job;
      try {
        job = readJob(plan, prog);
      } catch (e) {
        onError(path.basename(plan), e);
        continue;
      }
      for (const it of job.items || []) {
        if (it.status !== 'done' || !it.converted || !it.finalPath || it.srcMtimeMs == null) continue;
        map.set(keyFn(it.src, it.size, it.srcMtimeMs), it.finalPath);
      }
    }
    return map;
  }

  // 파일 1개 상태 기록
  mark(job, i, patch) {
    Object.assign(job.items[i], patch);
    fs.appendFileSync(this.progPath, JSON.stringify({ i, ...patch }) + '\n', 'utf8');
  }

  // 작업 끝 → done 폴더로 보관
  close(reason) {
    if (!this.exists()) return;
    const doneDir = path.join(this.dir, 'done');
    fs.mkdirSync(doneDir, { recursive: true });
    // 계획 파일을 먼저 옮겨요 (진행 기록을 먼저 옮기다 멈추면, 다음에 켤 때 기록 없는 계획을 처음부터 다시 돌리게 돼요)
    const st = stamp();
    const base = path.join(doneDir, `${st}_${reason}`);
    const planDest = freeName(base + '.json');
    const suffix = planDest.slice(base.length, planDest.length - '.json'.length); // '' 또는 '_1'
    fs.renameSync(this.planPath, planDest);
    if (fs.existsSync(this.progPath)) this._keepProgress(reason, st, suffix);
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

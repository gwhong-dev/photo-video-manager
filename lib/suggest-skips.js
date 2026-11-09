// 파일 위치: lib/suggest-skips.js
// 역할: 위치 제안에서 건너뛴 사진 목록 파일(userData/suggest-skips.json) 읽기와 쓰기.
//   비슷한 사진에서 "모두 남기기"를 누른 사진 목록(userData/similar-keeps.json)도 같은 모양으로 써요 (label만 달라요)
//   모양: { "paths": ["..."], "batches": { "묶음 번호": ["..."] } }. DB를 새로 만들어도 남도록 번호가 아닌 경로로 적어요.
//   batches: 위치 제안에서 일부만 넣을 때 체크를 끈 사진 중 그 넣기 때문에 새로 건너뛴 경로. 그 묶음을 되돌리면 빼요
//   (넣기 전부터 건너뛰어 있던 사진과 "이 묶음 건너뛰기"로 건너뛴 사진은 여기 없어서 되돌려도 그대로예요)
//   저장에 실패해도 이번 실행 동안은 기억해요. 값 넣기를 막을 일이 아니라서 오류를 던지지 않아요.
//
// Electron 없이 일반 Node에서도 돌아가요 (사진 파일은 건드리지 않고, 이 목록 파일만 읽고 써요).

const fs = require('fs');
const path = require('path');
const { stamp } = require('./logger');

// 목록 하나를 다루는 도구를 만들어요. onError(무엇을 하다가, 오류): 로그에 남길 곳, label: 로그에 적을 목록 이름
function createSkips(filePath, { onError, label = '건너뛴 사진 목록' }) {
  let paths = new Set();
  let batches = new Map(); // 묶음 번호 → 그 넣기 때문에 건너뛴 경로들

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data || !Array.isArray(data.paths) || !data.paths.every((p) => typeof p === 'string')) {
      throw new Error(`${label}의 모양이 달라요`);
    }
    paths = new Set(data.paths);
    const b = data.batches === undefined ? {} : data.batches; // 옛 파일에는 없어요
    if (!b || typeof b !== 'object' || Array.isArray(b)
      || !Object.values(b).every((l) => Array.isArray(l) && l.every((p) => typeof p === 'string'))) {
      // 묶음 기록만 깨졌으면 그것만 버리고 건너뛴 사진 목록은 살려요 (되돌리기로 빼지 못할 뿐이에요, #65 검증)
      onError(`${label}의 묶음 기록 읽기`, new Error('모양이 달라서 묶음 기록만 비워요'));
    } else {
      batches = new Map(Object.entries(b));
    }
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') {
      onError(`${label} 읽기`, e);
      // 깨진 파일은 지우지 않고 이름을 바꿔 보관해요
      try {
        fs.renameSync(filePath, `${filePath}.broken-${stamp()}`);
      } catch (e2) {
        onError('깨진 목록 보관', e2);
      }
    }
  }

  // 임시 파일에 다 쓴 뒤 이름을 바꿔요 (쓰다가 꺼져도 앞 목록이 깨지지 않게)
  const save = () => {
    const tmp = `${filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // 목록에서 이미 빠진 경로만 남은 묶음은 지워요 (파일이 끝없이 커지지 않게)
      for (const [id, list] of batches) {
        const still = list.filter((p) => paths.has(p));
        if (still.length) batches.set(id, still);
        else batches.delete(id);
      }
      const data = { paths: [...paths] };
      if (batches.size) data.batches = Object.fromEntries(batches);
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, filePath);
      return true;
    } catch (e) {
      onError(`${label} 쓰기`, e);
      return false;
    }
  };

  return {
    paths: () => paths,
    // 돌려주는 값은 파일에 저장했는지예요
    // batchId를 주면 이번에 새로 더한 경로를 그 묶음에 적어 둬요 (되돌리기에서 빼려고)
    add(list, batchId = null) {
      const fresh = [];
      for (const p of list) {
        if (!paths.has(p)) fresh.push(p);
        paths.add(p);
      }
      if (batchId && fresh.length) batches.set(batchId, [...new Set([...(batches.get(batchId) || []), ...fresh])]);
      // 번호 없이 건너뛰면("이 묶음 건너뛰기") 사용자가 따로 건너뛴 거예요. 앞 넣기를 되돌려도 남도록 묶음 기록에서 빼요 (#65 검증)
      if (!batchId) {
        const own = new Set(list);
        for (const [id, l] of batches) batches.set(id, l.filter((p) => !own.has(p)));
      }
      return save();
    },
    // 묶음을 되돌릴 때: 그 넣기 때문에 건너뛴 경로를 빼요. 적어 둔 것이 없으면 파일을 건드리지 않아요
    //   돌려주는 값: { removed: 뺀 개수, saved: 파일에 저장했는지 }
    undoBatch(batchId) {
      const list = batches.get(batchId);
      if (!list) return { removed: 0, saved: true };
      batches.delete(batchId);
      let removed = 0;
      for (const p of list) if (paths.delete(p)) removed++;
      return { removed, saved: save() };
    },
    clear() {
      paths = new Set();
      batches = new Map();
      return save();
    },
  };
}

module.exports = { createSkips };

// 파일 위치: lib/suggest-skips.js
// 역할: 위치 제안에서 건너뛴 사진 목록 파일(userData/suggest-skips.json) 읽기와 쓰기.
//   비슷한 사진에서 "모두 남기기"를 누른 사진 목록(userData/similar-keeps.json)도 같은 모양으로 써요 (label만 달라요)
//   모양: { "paths": ["..."] }. DB를 새로 만들어도 남도록 번호가 아닌 경로로 적어요.
//   저장에 실패해도 이번 실행 동안은 기억해요. 값 넣기를 막을 일이 아니라서 오류를 던지지 않아요.
//
// Electron 없이 일반 Node에서도 돌아가요 (사진 파일은 건드리지 않고, 이 목록 파일만 읽고 써요).

const fs = require('fs');
const path = require('path');
const { stamp } = require('./logger');

// 목록 하나를 다루는 도구를 만들어요. onError(무엇을 하다가, 오류): 로그에 남길 곳, label: 로그에 적을 목록 이름
function createSkips(filePath, { onError, label = '건너뛴 사진 목록' }) {
  let paths = new Set();

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data || !Array.isArray(data.paths) || !data.paths.every((p) => typeof p === 'string')) {
      throw new Error(`${label}의 모양이 달라요`);
    }
    paths = new Set(data.paths);
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
      fs.writeFileSync(tmp, JSON.stringify({ paths: [...paths] }), 'utf8');
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
    add(list) {
      for (const p of list) paths.add(p);
      return save();
    },
    clear() {
      paths = new Set();
      return save();
    },
  };
}

module.exports = { createSkips };

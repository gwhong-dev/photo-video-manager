// 파일 위치: lib/logger.js
// 역할: 작업 로그 파일 만들기 (plan_ / run_ / clean_ ...)
//   logs 폴더 위치를 밖에서 받아요 → 점검(npm run check) 때는 임시 폴더에 써요.

const fs = require('fs');
const path = require('path');

// 파일 이름용 시간 (예: 2026-10-13_004603)
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 로그 안에 적는 시간
const now = () => new Date().toLocaleString('ko-KR');

function createLogger(logDir) {
  return {
    dir: logDir,
    newLog(prefix, header) {
      fs.mkdirSync(logDir, { recursive: true });
      // 같은 1초 안에 또 만들면 이름이 겹쳐요 → 절대 덮어쓰지 않고 _1, _2 붙이기
      //   'wx' = 파일이 없을 때만 새로 만들기 (있으면 오류 → 다음 번호로)
      const base = `${prefix}_${stamp()}`;
      for (let n = 0; ; n++) {
        const p = path.join(logDir, n === 0 ? `${base}.txt` : `${base}_${n}.txt`);
        try {
          fs.writeFileSync(p, header + '\n', { encoding: 'utf8', flag: 'wx' });
          return { path: p, write: (line) => fs.appendFileSync(p, line + '\n', 'utf8') };
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
      }
    },
  };
}

module.exports = { createLogger, stamp, now };

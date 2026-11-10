// 파일 위치: scripts/postinstall.js
// 역할: npm install 이 끝나면 Electron 실행 파일을 받아요 (예전 postinstall 과 같은 일)
//   Electron 은 개발용 패키지라서 `npm install --omit=dev` 로 설치하면 아예 없어요.
//   그때는 받을 것이 없으니 오류 없이 건너뛰어요 (예전에는 여기서 설치 전체가 실패했어요)

const fs = require('fs');
const path = require('path');

const installer = path.join(__dirname, '..', 'node_modules', 'electron', 'install.js');
if (fs.existsSync(installer)) {
  require(installer); // Electron 이 스스로 실행 파일을 받아요 (이미 있으면 바로 끝나요)
} else {
  console.log('Electron 이 설치되지 않아서 실행 파일 받기를 건너뛰어요 (--omit=dev 설치)');
}

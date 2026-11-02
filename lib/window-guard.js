// 파일 위치: lib/window-guard.js
// 역할: 앱 창이 앱 화면 밖으로 나가지 못하게 막아요.
//   앱 창에 다른 주소나 파일이 열리면 그 페이지가 preload의 기능(사진 목록, 값 넣기)까지 쓸 수 있어요.
//   사진을 창에 끌어다 놓았을 때 갤러리가 그 사진으로 바뀌어 버리는 일도 이걸로 막아요.
//   외부 사이트는 앱 창 대신 기본 브라우저로 열어요 (지도 출처 버튼, gallery-main.js).

const path = require('path');
const { fileURLToPath } = require('url');

// url이 앱 화면 파일(screens) 중 하나인지. 주소 뒤의 ?, #은 보지 않아요
function isAppScreen(url, screens) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:') return false;
    const file = path.resolve(fileURLToPath(u)).toLowerCase(); // Windows 경로는 대소문자를 가리지 않아요
    return screens.some((s) => path.resolve(s).toLowerCase() === file);
  } catch {
    return false; // 읽을 수 없는 주소는 막아요
  }
}

// 창에 막기를 걸어요. onBlocked(종류, 주소): 막았을 때 기록용
function guardWindow(webContents, screens, onBlocked) {
  const stop = (kind) => (e, url) => {
    if (isAppScreen(url, screens)) return;
    e.preventDefault();
    onBlocked(kind, url);
  };
  webContents.on('will-navigate', stop('창 이동'));
  webContents.on('will-redirect', stop('창 이동'));
  webContents.setWindowOpenHandler(({ url }) => {
    onBlocked('새 창', url);
    return { action: 'deny' };
  });
}

module.exports = { isAppScreen, guardWindow };

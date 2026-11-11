// 파일 위치: lib/open-folder.js
// 역할: 화면의 "폴더 열기" (백업 폴더 열기 등)
//   화면이 보낸 경로가 실제 폴더일 때만 열어요. 파일이나 없는 경로는 열지 않아요
//   (파일을 열면 그 파일의 기본 프로그램이 실행될 수 있어서요)
//   isDir · openPath 는 main 이 넘겨줘요. 점검 때는 가짜를 넘겨요

async function openFolderOnly(p, { isDir, openPath }) {
  if (typeof p !== 'string' || !p) return false;
  let dir = false;
  try {
    dir = isDir(p);
  } catch {
    dir = false; // 없는 경로, 읽을 수 없는 경로
  }
  if (!dir) return false;
  await openPath(p);
  return true;
}

module.exports = { openFolderOnly };

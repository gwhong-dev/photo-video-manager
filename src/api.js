// 파일 위치: src/api.js
// 역할: 화면이 main 쪽(window.api.gallery)에 부탁하는 길을 한 곳에 모아요
//   electron 밖(브라우저로 열었을 때)에는 window.api가 없어서, 그때는 "준비 안 됨" 오류를 줘요.

function gallery() {
  const g = window.api && window.api.gallery;
  if (!g) throw new Error('프로그램 안에서만 쓸 수 있는 화면이에요');
  return g;
}

// Electron이 오류 앞에 붙이는 "Error invoking remote method ..." 를 떼고 사람이 읽을 글만 남겨요
export function errorText(e) {
  return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export const api = {
  getState: () => gallery().getState(),
  listDays: (filter) => gallery().listDays(filter),
  listFiles: (day, filter) => gallery().listFiles(day, filter),
  getFile: (id) => gallery().getFile(id),
  // 날짜와 위치 직접 넣기
  listIds: (filter) => gallery().listIds(filter),
  getCopySource: (id) => gallery().getCopySource(id),
  previewEdit: (ids, edit) => gallery().previewEdit(ids, edit),
  applyEdit: (ids, edit) => gallery().applyEdit(ids, edit),
  undoLast: (batchId) => gallery().undoLast(batchId), // 버튼에 적힌 묶음의 번호. 마지막 묶음이 바뀌었으면 main이 거절해요
  // 위치 제안
  listSuggestions: () => gallery().listSuggestions(),
  skipSuggestions: (ids) => gallery().skipSuggestions(ids),
  clearSuggestionSkips: () => gallery().clearSuggestionSkips(),
  rescan: () => gallery().rescan(),
  openScreen: (name) => gallery().openScreen(name),
  // 구독을 끊는 함수를 돌려줘요 (React에서 정리할 때 써요)
  onScanProgress: (cb) => gallery().onScanProgress(cb),
  onLibraryChanged: (cb) => gallery().onLibraryChanged(cb),
};

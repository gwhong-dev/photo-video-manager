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
  previewFallback: (id) => gallery().previewFallback(id), // 방금 받은 미리보기가 원본 대신 작은 썸네일인지 (참/거짓)
  // 날짜와 위치 직접 넣기
  listIds: (filter) => gallery().listIds(filter),
  getCopySource: (id) => gallery().getCopySource(id),
  previewEdit: (ids, edit) => gallery().previewEdit(ids, edit),
  applyEdit: (ids, edit) => gallery().applyEdit(ids, edit),
  undoLast: (batchId) => gallery().undoLast(batchId), // 버튼에 적힌 묶음의 번호. 마지막 묶음이 바뀌었으면 main이 거절해요
  // 위치 제안
  listSuggestions: () => gallery().listSuggestions(),
  skipSuggestions: (ids, batchId) => gallery().skipSuggestions(ids, batchId), // batchId: 일부만 넣은 넣기의 번호 (되돌리면 다시 빠져요)
  clearSuggestionSkips: () => gallery().clearSuggestionSkips(),
  // 지도에서 위치 고르기
  searchPlace: (query) => gallery().searchPlace(query),
  placeName: (id, ask) => gallery().placeName(id, ask),
  tagList: () => gallery().tagList(),
  mapPoints: () => gallery().mapPoints(),
  mapPlace: (lat, lng, ask) => gallery().mapPlace(lat, lng, ask),
  cleanHistory: () => gallery().cleanHistory(),
  openCleaned: (which) => gallery().openCleaned(which),
  selectionTags: (ids) => gallery().selectionTags(ids),
  previewTag: (ids, edit) => gallery().previewTag(ids, edit),
  applyTag: (ids, edit) => gallery().applyTag(ids, edit),
  createTag: (name) => gallery().createTag(name),
  setTagHotkey: (name, key) => gallery().setTagHotkey(name, key), // key: 1~9 또는 null(빼기)
  previewTagRename: (from, to) => gallery().previewTagRename(from, to), // { merge } = 같은 이름의 내 태그가 있으면 합치기
  renameTag: (from, to, merge) => gallery().renameTag(from, to, merge),
  deleteTag: (name) => gallery().deleteTag(name),
  openMapCredit: () => gallery().openMapCredit(),
  // 비슷한 사진
  listSimilar: () => gallery().listSimilar(),
  keepAllSimilar: (ids) => gallery().keepAllSimilar(ids), // "모두 남기기"를 다음 실행에도 기억
  clearSimilarKeeps: () => gallery().clearSimilarKeeps(),
  previewDiscard: (ids, whole) => gallery().previewDiscard(ids, whole || []), // whole = 모두 버리는 묶음의 번호 (2026-11-24)
  discardSimilar: (ids, whole) => gallery().discardSimilar(ids, whole || []),
  previewTrash: (ids) => gallery().previewTrash(ids), // 갤러리에서 고른 사진 휴지통으로: 미리보기
  trashSelected: (ids) => gallery().trashSelected(ids), // 갤러리에서 고른 사진 휴지통으로: 옮기기
  previewRotate: (id) => gallery().previewRotate(id), // 돌리기: 미리보기 (원본 바꾸기면 어디로 옮기는지)
  rotate: (id, turn, mode) => gallery().rotate(id, turn, mode), // 돌리기: 실행 (mode 'copy' | 'replace')
  onSimilarProgress: (cb) => gallery().onSimilarProgress(cb),
  aiState: () => gallery().aiState(),
  aiDownload: () => gallery().aiDownload(),
  onAiProgress: (cb) => gallery().onAiProgress(cb),
  // 날짜 없음 채우기 (_날짜없음 → 앨범 정보 날짜의 날짜 폴더)
  fillPreview: () => gallery().fillPreview(),
  fillRun: (token) => gallery().fillRun(token),
  fillUndo: () => gallery().fillUndo(),
  fillPickFolder: () => gallery().fillPickFolder(),
  fillClearFolders: () => gallery().fillClearFolders(),
  rescan: () => gallery().rescan(),
  openScreen: (name) => gallery().openScreen(name),
  // 구독을 끊는 함수를 돌려줘요 (React에서 정리할 때 써요)
  onScanProgress: (cb) => gallery().onScanProgress(cb),
  onLibraryChanged: (cb) => gallery().onLibraryChanged(cb),
};

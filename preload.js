// 파일 위치: preload.js
// 역할: 화면(index.html)과 뇌(main.js)를 안전하게 이어주는 다리 🌉

const { contextBridge, ipcRenderer } = require('electron');

// 알림을 받기 시작하고, 그만 받을 때 부르는 함수를 돌려줘요
function subscribe(channel, cb) {
  const handler = (e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  // 상태 / 설정 / 도구
  getState: () => ipcRenderer.invoke('get-state'),
  checkTools: () => ipcRenderer.invoke('check-tools'),
  pickTool: (name) => ipcRenderer.invoke('pick-tool', name),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  selectFolder: (title, defaultPath) => ipcRenderer.invoke('select-folder', title, defaultPath),
  checkFolders: (source, backupRoot) => ipcRenderer.invoke('check-folders', source, backupRoot),

  // 미리보기 → 실행
  makePlan: (opts) => ipcRenderer.invoke('make-plan', opts),
  getRows: (filter) => ipcRenderer.invoke('get-rows', filter),
  startJob: () => ipcRenderer.invoke('start-job'),
  spaceInfo: (batchSize) => ipcRenderer.invoke('space-info', batchSize),
  runBatch: (batchSize) => ipcRenderer.invoke('run-batch', batchSize),
  retryFailed: () => ipcRenderer.invoke('retry-failed'),
  pause: () => ipcRenderer.invoke('pause'),

  // 원본 정리 / 작업 끝내기
  trashInfo: () => ipcRenderer.invoke('trash-info'),
  // opts.binOverflow: 휴지통이 모자란 드라이브를 'trash'(그래도 휴지통) 또는 'move'(_정리완료원본으로)
  trashOriginals: (opts) => ipcRenderer.invoke('trash-originals', { binOverflow: opts && opts.binOverflow === 'trash' ? 'trash' : 'move' }),
  // 🔍 샘플 확인: 다시 뽑기, 크게 열기 (경로 없이 번호로만)
  cleanSample: () => ipcRenderer.invoke('clean-sample'),
  openCleanSample: (key) => ipcRenderer.invoke('clean-sample-open', key),
  closeJob: (reason) => ipcRenderer.invoke('close-job', reason),

  // 폴더 열기
  openLogs: () => ipcRenderer.invoke('open-logs'),
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),

  // 진행 상황 받기
  onPlanStatus: (cb) => ipcRenderer.on('plan-status', (e, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on('progress', (e, data) => cb(data)),
  // 처음 켤 때 정리할 원본 개수를 다 세면 받아요 (수만 개면 몇 분 걸려서 화면은 먼저 열어요)
  onJobInfo: (cb) => subscribe('job-info', cb),
  onTrashProgress: (cb) => ipcRenderer.on('trash-progress', (e, data) => cb(data)),
  onCleanCheckProgress: (cb) => ipcRenderer.on('clean-check-progress', (e, data) => cb(data)),

  // 갤러리 (gallery-main.js). 화면은 파일 경로를 모르고, 이미지는 pvm://thumb/<id> 로만 받아요
  gallery: {
    getState: () => ipcRenderer.invoke('gallery:get-state'),
    listDays: (filter) => ipcRenderer.invoke('gallery:list-days', filter),
    listFiles: (day, filter) => ipcRenderer.invoke('gallery:list-files', day, filter),
    getFile: (id) => ipcRenderer.invoke('gallery:get-file', id),
    previewFallback: (id) => ipcRenderer.invoke('gallery:preview-fallback', id), // 미리보기가 작은 썸네일로 대신한 것인지
    // 날짜와 위치 직접 넣기 (경로 없이 id로만 부탁해요)
    listIds: (filter) => ipcRenderer.invoke('gallery:list-ids', filter),
    getCopySource: (id) => ipcRenderer.invoke('gallery:get-copy-source', id),
    previewEdit: (ids, edit) => ipcRenderer.invoke('gallery:preview-edit', ids, edit),
    applyEdit: (ids, edit) => ipcRenderer.invoke('gallery:apply-edit', ids, edit),
    undoLast: (batchId) => ipcRenderer.invoke('gallery:undo-last', batchId),
    // 위치 제안
    listSuggestions: () => ipcRenderer.invoke('gallery:list-suggestions'),
    skipSuggestions: (ids, batchId) => ipcRenderer.invoke('gallery:skip-suggestions', ids, batchId ?? null),
    clearSuggestionSkips: () => ipcRenderer.invoke('gallery:clear-suggestion-skips'),
    // 지도에서 위치 고르기: 장소 검색 결과 [{ name, lat, lng }], 지도 출처 링크 열기 (주소는 main이 정해요)
    searchPlace: (query) => ipcRenderer.invoke('gallery:search-place', query),
    placeName: (id, ask) => ipcRenderer.invoke('gallery:place-name', id, ask),
    tagList: () => ipcRenderer.invoke('gallery:tag-list'),
    mapPoints: () => ipcRenderer.invoke('gallery:map-points'),
    mapPlace: (lat, lng, ask) => ipcRenderer.invoke('gallery:map-place', lat, lng, ask),
    cleanHistory: () => ipcRenderer.invoke('gallery:clean-history'),
    openCleaned: (which) => ipcRenderer.invoke('gallery:open-cleaned', which),
    selectionTags: (ids) => ipcRenderer.invoke('gallery:selection-tags', ids),
    previewTag: (ids, edit) => ipcRenderer.invoke('gallery:tag-preview', ids, edit),
    applyTag: (ids, edit) => ipcRenderer.invoke('gallery:tag-apply', ids, edit),
    openMapCredit: () => ipcRenderer.invoke('gallery:open-map-credit'),
    // 비슷한 사진: 묶음 목록, 버리기 미리보기, 버리기 (id로만)
    listSimilar: () => ipcRenderer.invoke('gallery:similar-list'),
    keepAllSimilar: (ids) => ipcRenderer.invoke('gallery:similar-keep-all', ids),
    clearSimilarKeeps: () => ipcRenderer.invoke('gallery:similar-clear-keeps'),
    previewDiscard: (ids) => ipcRenderer.invoke('gallery:similar-preview', ids),
    discardSimilar: (ids) => ipcRenderer.invoke('gallery:similar-discard', ids),
    onSimilarProgress: (cb) => subscribe('gallery:similar-progress', cb),
    // PC 안 AI 비교: 상태 보기, 모델 받기 (화면 확인 창에서 누른 뒤에만), 진행 알림
    aiState: () => ipcRenderer.invoke('gallery:ai-state'),
    aiDownload: () => ipcRenderer.invoke('gallery:ai-download'),
    onAiProgress: (cb) => subscribe('gallery:ai-progress', cb),
    fillPreview: () => ipcRenderer.invoke('gallery:fill-preview'), // 날짜없음 채우기: 후보 미리보기 (아무것도 옮기지 않음)
    fillRun: (token) => ipcRenderer.invoke('gallery:fill-run', token),
    fillUndo: () => ipcRenderer.invoke('gallery:fill-undo'),
    fillPickFolder: () => ipcRenderer.invoke('gallery:fill-pick-folder'),
    fillClearFolders: () => ipcRenderer.invoke('gallery:fill-clear-folders'),
    onFillProgress: (cb) => subscribe('gallery:fill-progress', cb),
    rescan: () => ipcRenderer.invoke('gallery:rescan'),
    openScreen: (name) => ipcRenderer.invoke('gallery:open-screen', name), // 'import' | 'gallery'
    // 구독을 끊는 함수를 돌려줘요
    onScanProgress: (cb) => subscribe('gallery:scan-progress', cb),
    onLibraryChanged: (cb) => subscribe('gallery:library-changed', cb),
  },
});

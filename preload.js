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
  // opts.tag: 가져온 사진에 붙일 태그 이름 (글자만 넘겨요. 없으면 안 붙임, main 이 이름 규칙으로 다시 확인해요)
  startJob: (opts) => ipcRenderer.invoke('start-job', { tag: opts && typeof opts.tag === 'string' ? opts.tag : null }),
  // 비슷한 사진 먼저 거르기: 경로를 보내지 않아요 (main 이 설정의 가져올 폴더로 정해요)
  screenStart: () => ipcRenderer.invoke('screen-start'),
  spaceInfo: (batchSize) => ipcRenderer.invoke('space-info', batchSize),
  runBatch: (batchSize) => ipcRenderer.invoke('run-batch', batchSize),
  retryFailed: () => ipcRenderer.invoke('retry-failed'),
  pause: () => ipcRenderer.invoke('pause'),

  // 원본 정리 / 작업 끝내기
  trashInfo: () => ipcRenderer.invoke('trash-info'),
  // opts.binOverflow: 휴지통이 모자란 드라이브를 'trash'(그래도 휴지통) 또는 'move'(_정리완료원본으로)
  // opts.keep: 중복 비교에서 "남기기"한 줄 번호들 (정수만 넘겨요)
  trashOriginals: (opts) => ipcRenderer.invoke('trash-originals', {
    binOverflow: opts && opts.binOverflow === 'trash' ? 'trash' : 'move',
    keep: opts && Array.isArray(opts.keep) ? opts.keep.filter(Number.isInteger) : [],
  }),
  // 🔍 샘플 확인: 다시 뽑기, 크게 열기 (경로 없이 번호로만)
  cleanSample: () => ipcRenderer.invoke('clean-sample'),
  openCleanSample: (key) => ipcRenderer.invoke('clean-sample-open', key),
  // 🔁 중복 비교: 다음 줄들, 줄의 작은 그림(data 주소), 크게 열기. side 는 'keep'(남는 파일) / 'src'(정리될 원본)
  cleanCompareRows: (offset) => ipcRenderer.invoke('clean-compare-rows', offset),
  cleanCompareThumb: (key, side) => ipcRenderer.invoke('clean-compare-thumb', key, side === 'src' ? 'src' : 'keep'),
  openCleanCompare: (key, side) => ipcRenderer.invoke('clean-compare-open', key, side === 'src' ? 'src' : 'keep'),
  closeJob: (reason) => ipcRenderer.invoke('close-job', reason),

  // 폴더 열기
  openLogs: () => ipcRenderer.invoke('open-logs'),
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),

  // 진행 상황 받기
  onPlanStatus: (cb) => ipcRenderer.on('plan-status', (e, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on('progress', (e, data) => cb(data)),
  // 처음 켤 때 정리할 원본 개수를 다 세면 받아요 (수만 개면 몇 분 걸려서 화면은 먼저 열어요)
  onJobInfo: (cb) => subscribe('job-info', cb),
  // 가져올 때 태그를 붙인 결과 (회차 끝 다시 읽기가 끝난 뒤 와요)
  onImportTag: (cb) => subscribe('import-tag', cb),
  // 작은 진행 창(최소화했을 때 뜨는 창)에서 일시정지 · 이어서 실행을 눌렀을 때
  onMiniPause: (cb) => subscribe('mini-pause', cb),
  onMiniResume: (cb) => subscribe('mini-resume', cb),
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
    // 태그 만들기 · 이름 바꾸기 · 지우기 · 단축키 숫자 (2026-11-18). 이름과 숫자만 넘겨요
    createTag: (name) => ipcRenderer.invoke('gallery:tag-create', name),
    setTagHotkey: (name, key) => ipcRenderer.invoke('gallery:tag-hotkey', name, key),
    previewTagRename: (from, to) => ipcRenderer.invoke('gallery:tag-rename-preview', from, to),
    renameTag: (from, to, merge) => ipcRenderer.invoke('gallery:tag-rename', from, to, merge === true),
    deleteTag: (name) => ipcRenderer.invoke('gallery:tag-delete', name),
    openMapCredit: () => ipcRenderer.invoke('gallery:open-map-credit'),
    // 비슷한 사진: 묶음 목록, 버리기 미리보기, 버리기 (id로만)
    listSimilar: () => ipcRenderer.invoke('gallery:similar-list'),
    keepAllSimilar: (ids) => ipcRenderer.invoke('gallery:similar-keep-all', ids),
    clearSimilarKeeps: () => ipcRenderer.invoke('gallery:similar-clear-keeps'),
    previewDiscard: (ids) => ipcRenderer.invoke('gallery:similar-preview', ids),
    discardSimilar: (ids) => ipcRenderer.invoke('gallery:similar-discard', ids),
    onSimilarProgress: (cb) => subscribe('gallery:similar-progress', cb),
    // 갤러리에서 고른 사진 휴지통으로: 미리보기(몇 장이 어디로, 아무것도 옮기지 않음), 옮기기 (id로만)
    previewTrash: (ids) => ipcRenderer.invoke('gallery:trash-preview', ids),
    trashSelected: (ids) => ipcRenderer.invoke('gallery:trash-selected', ids),
    // 사진 · 영상 돌리기 (한 장, id로만): 미리보기(원본 바꾸기면 어디로 옮기는지), 실행(turn 90 · 180 · 270, mode 'copy' | 'replace')
    previewRotate: (id) => ipcRenderer.invoke('gallery:rotate-preview', id),
    rotate: (id, turn, mode) => ipcRenderer.invoke('gallery:rotate', id, turn, mode),
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
    // 태그를 파일에 쓰기 (31 ②): 쓸 장수 · 남은 공간 보기 → 쓰기 (진행 알림, 닫을 때 묻기)
    tagWriteInfo: () => ipcRenderer.invoke('gallery:tag-write-info'),
    tagWrite: () => ipcRenderer.invoke('gallery:tag-write'),
    onTagWriteProgress: (cb) => subscribe('gallery:tag-write-progress', cb),
    onTagWriteAsk: (cb) => subscribe('gallery:tag-write-ask', cb),
    rescan: () => ipcRenderer.invoke('gallery:rescan'),
    openScreen: (name) => ipcRenderer.invoke('gallery:open-screen', name), // 'import' | 'gallery'
    // 구독을 끊는 함수를 돌려줘요
    onScanProgress: (cb) => subscribe('gallery:scan-progress', cb),
    onLibraryChanged: (cb) => subscribe('gallery:library-changed', cb),
  },
});

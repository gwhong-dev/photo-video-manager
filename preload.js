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
  pause: () => ipcRenderer.invoke('pause'),

  // 원본 정리 / 작업 끝내기
  trashInfo: () => ipcRenderer.invoke('trash-info'),
  trashOriginals: () => ipcRenderer.invoke('trash-originals'),
  closeJob: (reason) => ipcRenderer.invoke('close-job', reason),

  // 폴더 열기
  openLogs: () => ipcRenderer.invoke('open-logs'),
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),

  // 진행 상황 받기
  onPlanStatus: (cb) => ipcRenderer.on('plan-status', (e, msg) => cb(msg)),
  onProgress: (cb) => ipcRenderer.on('progress', (e, data) => cb(data)),
  onTrashProgress: (cb) => ipcRenderer.on('trash-progress', (e, data) => cb(data)),
  onCleanCheckProgress: (cb) => ipcRenderer.on('clean-check-progress', (e, data) => cb(data)),

  // 갤러리 (gallery-main.js). 화면은 파일 경로를 모르고, 이미지는 pvm://thumb/<id> 로만 받아요
  gallery: {
    getState: () => ipcRenderer.invoke('gallery:get-state'),
    listDays: (filter) => ipcRenderer.invoke('gallery:list-days', filter),
    listFiles: (day, filter) => ipcRenderer.invoke('gallery:list-files', day, filter),
    getFile: (id) => ipcRenderer.invoke('gallery:get-file', id),
    rescan: () => ipcRenderer.invoke('gallery:rescan'),
    openScreen: (name) => ipcRenderer.invoke('gallery:open-screen', name), // 'import' | 'gallery'
    // 구독을 끊는 함수를 돌려줘요
    onScanProgress: (cb) => subscribe('gallery:scan-progress', cb),
    onLibraryChanged: (cb) => subscribe('gallery:library-changed', cb),
  },
});

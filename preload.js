// 파일 위치: preload.js
// 역할: 화면(index.html)과 뇌(main.js)를 안전하게 이어주는 다리 🌉

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 상태 / 설정 / 도구
  getState: () => ipcRenderer.invoke('get-state'),
  checkTools: () => ipcRenderer.invoke('check-tools'),
  pickTool: (name) => ipcRenderer.invoke('pick-tool', name),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  selectFolder: (title, defaultPath) => ipcRenderer.invoke('select-folder', title, defaultPath),

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
});

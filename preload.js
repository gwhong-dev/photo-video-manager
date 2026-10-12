const { contextBridge, ipcRenderer } = require('electron');

// 화면에서 쓸 수 있는 기능을 'api'라는 이름으로 열어주기
contextBridge.exposeInMainWorld('api', {
  selectFolder: (title) => ipcRenderer.invoke('select-folder', title),
  makePlan: (opts) => ipcRenderer.invoke('make-plan', opts),
  runPlan: () => ipcRenderer.invoke('run-plan'),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),
  // 진행 상황이 올 때마다 실행할 함수 등록
  onProgress: (callback) =>
    ipcRenderer.on('progress', (event, data) => callback(data)),
});

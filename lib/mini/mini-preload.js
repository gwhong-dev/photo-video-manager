// 파일 위치: lib/mini/mini-preload.js
// 역할: 작은 진행 창(mini-progress.html)과 main.js 를 잇는 다리
//   작은 창은 글자를 받아 보여 주고, 버튼 4가지(일시정지 · 이어서 실행 · 큰 창 열기 · 간단히/자세히)만 보내요
//   파일 경로나 다른 기능은 열어 두지 않아요

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mini', {
  // 상태 받기: { view: 보여 줄 글자, compact: 간단히(한 줄)인지 }
  onState: (cb) => ipcRenderer.on('mini:state', (e, data) => cb(data)),
  pause: () => ipcRenderer.send('mini:pause'),
  resume: () => ipcRenderer.send('mini:resume'),
  openMain: () => ipcRenderer.send('mini:open'),
  setCompact: (on) => ipcRenderer.send('mini:compact', on === true),
  // 화면 크기를 알려 주면 main 이 창 크기를 맞춰요 (오른쪽 아래 모서리는 그대로)
  fit: (w, h) => ipcRenderer.send('mini:fit', Number(w) || 0, Number(h) || 0),
});

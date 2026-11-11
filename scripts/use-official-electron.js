// 파일 위치: scripts/use-official-electron.js
// 역할: exe 를 만든 뒤(npm run dist), release\win-unpacked 의 exe 를 Electron 공식 원본(electron.exe) 복사본으로 바꿔요
//   왜: 이 PC는 Windows 의 Smart App Control(스마트 앱 컨트롤)이 켜져 있어서, electron-builder 가 이름표를 고쳐
//   새로 만든 서명 없는 exe 는 "응용 프로그램 제어 정책이 차단" 으로 안 켜져요 (2026-11-11 확인).
//   공식 원본은 Windows 가 이미 아는 파일이라 막히지 않아요. 파일 이름만 바꾸는 건 내용이 같아서 괜찮아요
//   Electron 은 exe 옆 resources\app.asar 가 있으면 그 앱을 켜요. 그래서 앱 파일 · 설정 폴더 · 바로가기는 그대로예요
//   대신 exe 를 고칠 수 없어서 퓨즈(exe 안 스위치)와 아이콘 · 버전 이름표는 Electron 기본값이에요

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP = path.join(__dirname, '..');
const OFFICIAL = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
const TARGET = path.join(APP, 'release', 'win-unpacked', 'photo-video-manager.exe');

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function main() {
  if (process.platform !== 'win32') {
    console.log('윈도우가 아니라서 건너뛰어요');
    return;
  }
  if (!fs.existsSync(OFFICIAL)) throw new Error(`공식 electron.exe 가 없어요: ${OFFICIAL} (npm install 을 먼저 해 주세요)`);
  if (!fs.existsSync(TARGET)) throw new Error(`만든 exe 가 없어요: ${TARGET} (npm run dist 가 끝났는지 확인해 주세요)`);
  fs.copyFileSync(OFFICIAL, TARGET);
  if (sha(OFFICIAL) !== sha(TARGET)) throw new Error('복사한 exe 가 공식 원본과 달라요');
  console.log(`exe 를 공식 Electron 원본으로 바꿨어요: ${TARGET}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { OFFICIAL, TARGET, sha };

// 파일 위치: lib/platform.js
// 역할: 운영체제(Windows/Mac)마다 다른 코드를 모아 두는 곳
//   지금은 "드라이브 종류" 하나 — 휴지통이 있는 드라이브인지 알아야 해서요.
//   (나중에 Mac 버전을 만들 때 이 파일만 고치면 돼요)

const path = require('path');
const { execFile } = require('child_process');

// Windows가 알려 주는 드라이브 종류 번호 → 이름
const DRIVE_TYPES = { 2: 'removable', 3: 'fixed', 4: 'network', 5: 'cdrom' };
const cache = new Map(); // 드라이브 문자별로 한 번만 물어보기

// 드라이브 종류: 'fixed'(하드디스크) | 'removable'(USB·SD) | 'network' | 'cdrom' | 'unknown'
//   못 알아내면 'unknown' → 휴지통 없는 쪽으로 안전하게 처리돼요
function driveKind(p) {
  if (process.platform !== 'win32') return Promise.resolve('unknown');
  const full = path.resolve(p);
  if (full.startsWith('\\\\')) return Promise.resolve('network'); // \\서버\폴더
  const m = /^([a-zA-Z]):/.exec(full);
  if (!m) return Promise.resolve('unknown');
  const letter = m[1].toUpperCase();
  if (!cache.has(letter)) {
    cache.set(
      letter,
      new Promise((resolve) => {
        const cmd = `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'").DriveType`;
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
          resolve(err ? 'unknown' : DRIVE_TYPES[String(stdout).trim()] || 'unknown');
        });
      })
    );
  }
  return cache.get(letter);
}

// 휴지통을 쓸 수 있는 드라이브인지 (하드디스크만)
const canUseRecycleBin = (kind) => kind === 'fixed';

// 화면·로그에 보여줄 이름
const DRIVE_LABEL = { fixed: '하드디스크', removable: 'USB 또는 SD카드', network: '네트워크', cdrom: 'CD 또는 DVD', unknown: '종류 모름' };

module.exports = { driveKind, canUseRecycleBin, DRIVE_LABEL };

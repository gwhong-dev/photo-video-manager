// 파일 위치: lib/platform.js
// 역할: 운영체제(Windows/Mac)마다 다른 코드를 모아 두는 곳
//   지금은 "드라이브 종류" 하나 — 휴지통이 있는 드라이브인지 알아야 해서요.
//   (나중에 Mac 버전을 만들 때 이 파일만 고치면 돼요)

const { execFile } = require('child_process');
const { realPath } = require('./paths');

// Windows가 알려 주는 드라이브 종류 번호 → 이름
const DRIVE_TYPES = { 2: 'removable', 3: 'fixed', 4: 'network', 5: 'cdrom' };

// Windows에서 드라이브 정보 표 읽기 (PowerShell 1번)
//   volumes: 볼륨 목록 (C:\ 뿐 아니라 "폴더에 연결된 USB" 같은 C:\mnt\usb\ 도 나와요)
//   disks:   드라이브 문자 목록 (네트워크 드라이브 Z: 등)
function fetchTablesWin() {
  const cmd =
    '$v = @(Get-CimInstance Win32_Volume | Select-Object Name, DriveType);' +
    '$l = @(Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, DriveType);' +
    '@{ volumes = $v; disks = $l } | ConvertTo-Json -Compress -Depth 3';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
      try {
        resolve(err ? null : JSON.parse(String(stdout).trim()));
      } catch (e) {
        resolve(null); // 못 읽으면 null → 모든 드라이브 'unknown' (휴지통 안 씀)
      }
    });
  });
}

// 경로 하나 → 드라이브 종류 (표만 보고 판단하는 순수 함수)
//   1) \\서버\폴더 → network
//   2) 볼륨 목록에서 경로 앞부분이 가장 길게 맞는 것 (폴더에 연결된 USB를 찾으려고)
//   3) 드라이브 문자 목록
//   4) 그래도 모르면 unknown
function resolveKind(fullPath, tables) {
  if (fullPath.startsWith('\\\\')) return 'network';
  if (!tables) return 'unknown';
  const p = fullPath.toLowerCase();
  let best = null;
  for (const v of [].concat(tables.volumes || [])) {
    const name = String(v.Name || '').toLowerCase();
    if (!name || name.startsWith('\\\\?\\')) continue; // 문자 없는 볼륨 이름은 경로와 비교 불가
    const prefix = name.endsWith('\\') ? name : name + '\\';
    if (p.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, type: v.DriveType };
  }
  if (best) return DRIVE_TYPES[best.type] || 'unknown';
  const m = /^([a-z]):/.exec(p);
  if (m) {
    const d = [].concat(tables.disks || []).find((x) => String(x.DeviceID || '').toLowerCase() === m[1] + ':');
    if (d) return DRIVE_TYPES[d.DriveType] || 'unknown';
  }
  return 'unknown';
}

// 드라이브 종류 판단기 만들기 — 정리 한 번마다 새로 만들어요 (예전 판단을 계속 믿지 않으려고)
//   만든 판단기 안에서는 표를 한 번만 읽어요 (파일마다 PowerShell을 켜지 않게)
//   드라이브 종류: 'fixed'(하드디스크) | 'removable'(USB·SD) | 'network' | 'cdrom' | 'unknown'
function createDriveKindOf({ fetchTables = process.platform === 'win32' ? fetchTablesWin : async () => null } = {}) {
  let tables;
  return async (p) => {
    if (tables === undefined) tables = await fetchTables();
    return resolveKind(realPath(p), tables);
  };
}

// 한 번만 물어볼 때
const driveKind = (p) => createDriveKindOf()(p);

// 휴지통을 쓸 수 있는 드라이브인지 (하드디스크만)
const canUseRecycleBin = (kind) => kind === 'fixed';

// 화면·로그에 보여줄 이름
const DRIVE_LABEL = { fixed: '하드디스크', removable: 'USB 또는 SD카드', network: '네트워크', cdrom: 'CD 또는 DVD', unknown: '종류 모름' };

module.exports = { driveKind, createDriveKindOf, resolveKind, canUseRecycleBin, DRIVE_LABEL };

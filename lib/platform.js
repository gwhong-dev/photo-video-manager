// 파일 위치: lib/platform.js
// 역할: 운영체제(Windows/Mac)마다 다른 코드를 모아 두는 곳
//   "드라이브 종류"와 "휴지통 설정" — 휴지통을 믿고 쓸 수 있는 드라이브인지 알아야 해서요.
//   (나중에 Mac 버전을 만들 때 이 파일만 고치면 돼요)

const { execFile } = require('child_process');
const { realPath } = require('./paths');

// Windows가 알려 주는 드라이브 종류 번호 → 이름
const DRIVE_TYPES = { 2: 'removable', 3: 'fixed', 4: 'network', 5: 'cdrom' };

// Windows에서 드라이브 정보 표 읽기 (PowerShell 1번, 읽기만 해요)
//   volumes: 볼륨 목록 (C:\ 뿐 아니라 "폴더에 연결된 USB" 같은 C:\mnt\usb\ 도 나와요)
//   disks:   드라이브 문자 목록 (네트워크 드라이브 Z: 등)
//   recycle: 볼륨별 휴지통 설정 (레지스트리 = Windows 설정 저장소). max: 최대 크기(MB), nuke: 1이면 "바로 제거"
function fetchTablesWin() {
  const cmd =
    '$v = @(Get-CimInstance Win32_Volume | Select-Object Name, DriveType, DeviceID);' +
    '$l = @(Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, DriveType);' +
    "$r = @(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume' -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath; @{ id = $_.PSChildName; max = $p.MaxCapacity; nuke = $p.NukeOnDelete } });" +
    '@{ volumes = $v; disks = $l; recycle = $r } | ConvertTo-Json -Compress -Depth 3';
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

// PowerShell이 찍은 휴지통 크기 글자 → 바이트 숫자. 숫자만 있을 때만 받아요, 아니면 null(못 읽음)
//   Number('')는 0이라서, 출력이 비면 "휴지통이 비었음"으로 잘못 볼 수 있었어요 (#72 검증 ⚠️)
function parseBinUsed(stdout) {
  const t = String(stdout || '').trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

// Windows 휴지통에 지금 든 크기 (드라이브 하나, 바이트). 못 읽으면 null
//   SHQueryRecycleBin = 탐색기가 휴지통 크기를 셀 때 쓰는 Windows 기능 (읽기만 해요)
//   드라이브 경로는 환경 변수로 넘겨요 (명령 글자에 끼워 넣지 않아서 경로에 따옴표가 있어도 안전)
function fetchBinUsedWin(root) {
  const cmd =
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;" +
    'public static class PvmBin{[StructLayout(LayoutKind.Sequential)] public struct Info{public int cbSize;public long size;public long items;}' +
    '[DllImport("shell32.dll",CharSet=CharSet.Unicode)] public static extern int SHQueryRecycleBin(string root,ref Info info);' +
    "public static long Used(string root){Info i=new Info();i.cbSize=Marshal.SizeOf(typeof(Info));return SHQueryRecycleBin(root,ref i)==0?i.size:-1;}}';" +
    '[PvmBin]::Used($env:PVM_BIN_ROOT)';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 20000, env: { ...process.env, PVM_BIN_ROOT: root } }, (err, stdout) => {
      resolve(err ? null : parseBinUsed(stdout));
    });
  });
}

// 볼륨 목록에서 경로 앞부분이 가장 길게 맞는 볼륨 찾기 (폴더에 연결된 USB를 찾으려고)
function bestVolume(fullPath, tables) {
  const p = fullPath.toLowerCase();
  let best = null;
  for (const v of [].concat(tables.volumes || [])) {
    const name = String(v.Name || '').toLowerCase();
    if (!name || name.startsWith('\\\\?\\')) continue; // 문자 없는 볼륨 이름은 경로와 비교 불가
    const prefix = name.endsWith('\\') ? name : name + '\\';
    if (p.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { prefix, volume: v };
  }
  return best && best.volume;
}

// 경로 하나 → 드라이브 종류 (표만 보고 판단하는 순수 함수)
//   1) \\서버\폴더 → network
//   2) 볼륨 목록에서 가장 길게 맞는 것
//   3) 드라이브 문자 목록
//   4) 그래도 모르면 unknown
function resolveKind(fullPath, tables) {
  if (fullPath.startsWith('\\\\')) return 'network';
  if (!tables) return 'unknown';
  const p = fullPath.toLowerCase();
  const best = bestVolume(fullPath, tables);
  if (best) return DRIVE_TYPES[best.DriveType] || 'unknown';
  const m = /^([a-z]):/.exec(p);
  if (m) {
    const d = [].concat(tables.disks || []).find((x) => String(x.DeviceID || '').toLowerCase() === m[1] + ':');
    if (d) return DRIVE_TYPES[d.DriveType] || 'unknown';
  }
  return 'unknown';
}

// 경로 하나 → 그 볼륨의 휴지통 설정 (표만 보고 판단하는 순수 함수)
//   볼륨 번호 {…} 로 레지스트리 값과 연결해요. 모르면 null
//   돌려주는 값: { maxBytes: 최대 크기(바이트, 값이 없으면 null), nuke: "바로 제거"면 true }
function resolveRecycle(fullPath, tables) {
  if (!tables || fullPath.startsWith('\\\\')) return null;
  const volume = bestVolume(fullPath, tables);
  const id = volume && /\{[^}]+\}/.exec(String(volume.DeviceID || ''));
  if (!id) return null;
  const entry = [].concat(tables.recycle || []).find((r) => String(r.id || '').toLowerCase() === id[0].toLowerCase());
  if (!entry) return null;
  return { maxBytes: typeof entry.max === 'number' ? entry.max * 1024 * 1024 : null, nuke: entry.nuke === 1 };
}

// 드라이브 종류 판단기 만들기 — 정리 한 번마다 새로 만들어요 (예전 판단을 계속 믿지 않으려고)
//   만든 판단기 안에서는 표를 한 번만 읽어요 (파일마다 PowerShell을 켜지 않게)
//   드라이브 종류: 'fixed'(하드디스크) | 'removable'(USB·SD) | 'network' | 'cdrom' | 'unknown'
//   판단기.recycleOf(경로): 같은 표로 휴지통 설정 찾기
//   판단기.binUsedOf(드라이브): 휴지통에 이미 든 크기 (바이트). 못 읽으면 null, Windows가 아니면 undefined(확인할 휴지통 없음)
function createDriveKindOf({ fetchTables = process.platform === 'win32' ? fetchTablesWin : async () => null, fetchBinUsed = process.platform === 'win32' ? fetchBinUsedWin : null } = {}) {
  let tables;
  const read = async () => {
    if (tables === undefined) tables = await fetchTables();
    return tables;
  };
  const driveKindOf = async (p) => resolveKind(realPath(p), await read());
  driveKindOf.recycleOf = async (p) => resolveRecycle(realPath(p), await read());
  const used = new Map(); // 드라이브별로 한 번만 읽어요
  driveKindOf.binUsedOf = async (root) => {
    if (!fetchBinUsed) return undefined;
    if (!used.has(root)) used.set(root, await fetchBinUsed(root));
    return used.get(root);
  };
  return driveKindOf;
}

// 한 번만 물어볼 때
const driveKind = (p) => createDriveKindOf()(p);

// 휴지통을 쓸 수 있는 드라이브인지 (하드디스크만)
const canUseRecycleBin = (kind) => kind === 'fixed';

// 화면·로그에 보여줄 이름
const DRIVE_LABEL = { fixed: '하드디스크', removable: 'USB 또는 SD카드', network: '네트워크', cdrom: 'CD 또는 DVD', unknown: '종류 모름' };

module.exports = { driveKind, createDriveKindOf, fetchBinUsedWin, parseBinUsed, resolveKind, resolveRecycle, canUseRecycleBin, DRIVE_LABEL };

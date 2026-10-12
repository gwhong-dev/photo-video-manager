// 파일 위치: lib/tools.js
// 역할: 외부 프로그램(exiftool, ImageMagick, FFmpeg) 찾기 + 실행하기

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 외부 프로그램 실행 → { code, stdout, stderr } (화면이 멈추지 않게 비동기로)
function runCmd(exe, args) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject); // 프로그램이 없을 때
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// 실패하면 에러를 던지는 버전
async function runOrThrow(exe, args, name) {
  const r = await runCmd(exe, args);
  if (r.code !== 0) {
    const last = (r.stderr || r.stdout).trim().split(/\r?\n/).pop() || '알 수 없는 오류';
    throw new Error(`${name}: ${last}`);
  }
  return r;
}

// 도구마다 찾아볼 위치 목록 (앞에서부터 먼저)
// 1) 설정에서 직접 지정한 경로
// 2) 프로그램 폴더 안 tools 폴더 (나중에 exe로 만들 때 같이 넣을 곳)
// 3) 그냥 이름만 (PATH에 등록돼 있으면 실행됨)
function candidates(name, settingPath, appDir) {
  const t = (...p) => path.join(appDir, 'tools', ...p);
  const list = {
    exiftool: [t('exiftool', 'exiftool.exe'), t('exiftool', 'exiftool'), 'exiftool'],
    magick: [t('imagemagick', 'magick.exe'), 'magick'],
    ffmpeg: [t('ffmpeg', 'bin', 'ffmpeg.exe'), t('ffmpeg', 'ffmpeg.exe'), 'ffmpeg'],
  }[name];
  return settingPath ? [settingPath, ...list] : list;
}

// 버전 확인용 옵션
const VERSION_ARGS = { exiftool: ['-ver'], magick: ['-version'], ffmpeg: ['-version'], ffprobe: ['-version'] };

// 실행해 보고 되면 버전 글자 돌려주기
async function tryTool(name, exe) {
  // 경로가 적혀 있는데 파일이 없으면 바로 실패
  if (path.isAbsolute(exe) && !fs.existsSync(exe)) return null;
  try {
    const r = await runCmd(exe, VERSION_ARGS[name]);
    if (r.code !== 0) return null;
    return (r.stdout || r.stderr).trim().split(/\r?\n/)[0];
  } catch (e) {
    return null;
  }
}

// ffmpeg 옆에 있는 ffprobe 찾기
function ffprobeFrom(ffmpegPath) {
  if (!path.isAbsolute(ffmpegPath)) return 'ffprobe';
  const ext = path.extname(ffmpegPath); // ".exe" 또는 ""
  return path.join(path.dirname(ffmpegPath), 'ffprobe' + ext);
}

// 모든 도구 찾기 → { exiftool: { ok, path, version }, magick: ..., ffmpeg: ..., ffprobe: ... }
async function detectTools(settings, appDir) {
  const result = {};
  for (const name of ['exiftool', 'magick', 'ffmpeg']) {
    result[name] = { ok: false, path: null, version: null };
    for (const exe of candidates(name, settings[name], appDir)) {
      const version = await tryTool(name, exe);
      if (version) {
        result[name] = { ok: true, path: exe, version };
        break;
      }
    }
  }
  // ffprobe는 ffmpeg 옆에 같이 설치돼요
  const probe = result.ffmpeg.ok ? ffprobeFrom(result.ffmpeg.path) : 'ffprobe';
  const probeVer = await tryTool('ffprobe', probe);
  result.ffprobe = { ok: !!probeVer, path: probeVer ? probe : null, version: probeVer };
  return result;
}

module.exports = { runCmd, runOrThrow, detectTools };

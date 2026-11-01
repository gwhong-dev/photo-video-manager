// 파일 위치: lib/tools.js
// 역할: 외부 프로그램(exiftool, ImageMagick, FFmpeg) 찾기 + 실행하기

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 외부 프로그램 실행 → { code, stdout, stderr } (화면이 멈추지 않게 비동기로)
//   options.timeoutMs: 이 시간이 넘으면 프로그램을 끄고 { code: null, timedOut: true, stdout, stderr }로 끝나요
//   (기본은 시간 제한 없음 → 인자 없이 부르던 기존 호출은 그대로예요)
function runCmd(exe, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let child;
    let timer = null;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
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
    child.on('error', (e) => finish(reject, e)); // 프로그램이 없을 때
    child.on('close', (code) => finish(resolve, { code, stdout, stderr }));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill(); } catch (e) { /* 이미 끝남 */ }
        finish(resolve, { code: null, timedOut: true, stdout, stderr });
      }, timeoutMs);
    }
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

// 영상이 재생될 수 있는지 ffprobe로 확인 (영상 앞쪽 정보만 읽어서 12GB도 0.1초 안에 끝나요)
//   → { ok: true } 정상 / { ok: false, reason } 손상 / { ok: null, reason } 확인 못 함 (ffprobe 없음)
//   ⚠️ 목차(moov)가 없는 파일은 잡지만, 목차는 멀쩡한데 내용이 망가진 파일은 못 잡아요 (끝까지 읽어야 해서)
async function probeVideo(ffprobe, file) {
  if (!ffprobe) return { ok: null, reason: 'ffprobe를 찾지 못했어요' };
  let r;
  try {
    r = await runCmd(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
  } catch (e) {
    return { ok: null, reason: `ffprobe를 실행하지 못했어요 (${e.message})` };
  }
  if (r.code !== 0) {
    // 맨 앞 줄에 진짜 이유가 있어요 (예: moov atom not found). "[mov,mp4 @ 0000...]" 부분은 뺌
    const first = r.stderr.trim().split(/\r?\n/)[0] || '알 수 없는 오류';
    return { ok: false, reason: first.replace(/^\[[^\]]*\]\s*/, '') };
  }
  if (!/video/.test(r.stdout)) return { ok: false, reason: '영상 트랙이 없어요' };
  return { ok: true };
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

module.exports = { runCmd, runOrThrow, detectTools, probeVideo };

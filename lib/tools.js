// 파일 위치: lib/tools.js
// 역할: 외부 프로그램(exiftool, ImageMagick, FFmpeg) 찾기 + 실행하기

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 외부 프로그램 실행 → { code, stdout, stderr } (화면이 멈추지 않게 비동기로)
//   options.timeoutMs: 이 시간이 넘으면 프로그램을 끄고 { code: null, timedOut: true, stdout, stderr }로 끝나요
//   (기본은 시간 제한 없음 → 인자 없이 부르던 기존 호출은 그대로예요)
//   끄고 나서 프로그램이 완전히 끝나길(close) 최대 KILL_WAIT_MS 기다려요.
//   윈도우에서는 꺼지는 중인 프로그램이 파일을 잡고 있을 수 있어서, 바로 끝내면 임시 파일을 못 지워요
const KILL_WAIT_MS = 2000;

function runCmd(exe, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let child;
    let timer = null;
    let done = false;
    let timedOut = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const timedOutResult = () => ({ code: null, timedOut: true, stdout, stderr });
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
    // 프로그램이 없을 때. 이미 시간 초과로 끄는 중이면 오류가 아니라 시간 초과로 끝내요
    child.on('error', (e) => (timedOut ? finish(resolve, timedOutResult()) : finish(reject, e)));
    child.on('close', (code) => finish(resolve, timedOut ? timedOutResult() : { code, stdout, stderr }));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch (e) { /* 이미 끝남 */ }
        // close를 기다리되, 안 와도 KILL_WAIT_MS 뒤에는 반드시 끝내요 (finish가 이 타이머도 치워요)
        timer = setTimeout(() => finish(resolve, timedOutResult()), KILL_WAIT_MS);
      }, timeoutMs);
    }
  });
}

// 영상의 "화면 데이터만" 지문 (첫 번째 영상 트랙, SHA256) → 못 읽으면 null
//   MOV→MP4 변환은 화면 데이터를 그대로 옮겨요(-c:v copy, lib/processor.js)
//   → 파일 전체 지문은 달라도, 원본 MOV 와 결과 MP4 의 이 지문은 똑같아요
//   이름이 다른 같은 영상(IMG_0001(1).MOV 같은 복사본)이 백업에 또 저장되는 것을 막는 데 써요 (2026-11-24)
//   파일을 끝까지 읽어요 (큰 영상은 몇 초). 다른 영상이 같은 지문이 될 일은 없어요
const VIDEO_HASH_TIMEOUT_MS = 10 * 60 * 1000;
async function videoStreamHash(ffmpeg, file, { timeoutMs = VIDEO_HASH_TIMEOUT_MS } = {}) {
  if (!ffmpeg || !file) return null;
  try {
    const r = await runCmd(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], { timeoutMs });
    if (r.code !== 0) return null;
    const m = /SHA256=([0-9a-f]{64})/i.exec(r.stdout || '');
    return m ? m[1].toLowerCase() : null;
  } catch (e) {
    return null; // ffmpeg 없음 등 → 비교 안 함
  }
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
    // 형식 이름도 같이 읽어요 (MOV→MP4 변환이 ffprobe를 한 번 더 켜지 않게)
    r = await runCmd(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', file]);
  } catch (e) {
    return { ok: null, reason: `ffprobe를 실행하지 못했어요 (${e.message})` };
  }
  if (r.code !== 0) {
    // 맨 앞 줄에 진짜 이유가 있어요 (예: moov atom not found). "[mov,mp4 @ 0000...]" 부분은 뺌
    const first = r.stderr.trim().split(/\r?\n/)[0] || '알 수 없는 오류';
    return { ok: false, reason: first.replace(/^\[[^\]]*\]\s*/, '') };
  }
  if (!/video/.test(r.stdout)) return { ok: false, reason: '영상 트랙이 없어요' };
  // 줄마다 "형식,종류" (예: hevc,video / aac,audio). 첫 영상 · 첫 소리 형식만
  let video = '';
  let audio = '';
  let audioCount = 0; // 소리 트랙 수 (MOV→MP4 는 첫 번째만 옮겨서, 2개 이상이면 작업 메모에 남겨요)
  for (const line of r.stdout.split(/\r?\n/)) {
    const [name, type] = line.trim().split(',');
    if (type === 'video' && !video) video = name;
    if (type === 'audio') {
      audioCount++;
      if (!audio) audio = name;
    }
  }
  return { ok: true, video, audio, audioCount };
}

// 도구마다 찾아볼 위치 목록 (앞에서부터 먼저)
// 1) 설정에서 직접 지정한 경로
// 2) 받은 폴더들 안의 tools 폴더 (앞 폴더부터). appDir 은 폴더 하나 또는 목록
//    exe 로 만든 앱은 설정 폴더(%APPDATA%\photo-video-manager)와 exe 옆을 넘겨요 (main.js toolsBaseDirs)
// 3) 그냥 이름만 (PATH에 등록돼 있으면 실행됨)
function candidates(name, settingPath, appDir) {
  const list = [];
  for (const dir of [].concat(appDir).filter(Boolean)) {
    const t = (...p) => path.join(dir, 'tools', ...p);
    list.push(...{
      exiftool: [t('exiftool', 'exiftool.exe'), t('exiftool', 'exiftool')],
      magick: [t('imagemagick', 'magick.exe')],
      ffmpeg: [t('ffmpeg', 'bin', 'ffmpeg.exe'), t('ffmpeg', 'ffmpeg.exe')],
    }[name]);
  }
  list.push(name); // PATH
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

module.exports = { runCmd, runOrThrow, detectTools, probeVideo, videoStreamHash, candidates };

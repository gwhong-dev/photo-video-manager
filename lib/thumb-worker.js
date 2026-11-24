// 파일 위치: lib/thumb-worker.js
// 역할: 작은 그림을 만드는 "따로 도는 프로그램"(자식 프로세스) 쪽 코드 (2026-11-24, lib/thumb-proc.js 가 띄워요)
//   왜 따로: sharp(libvips)가 어떤 사진에서 앱 전체를 꺼뜨린 일이 있었어요 (원본 정리 창, 0xc0000409)
//     → 여기서 꺼지면 이 프로그램만 꺼지고, 앱은 그 그림을 "그림 없음"으로 보여 주고 계속 돌아요
//   받는 것: { id, p(파일 경로), tools, tempBase, px, videoTimeoutMs } → 보내는 것: { id, b64(webp 내용, 못 만들면 null) }
//   파일은 읽기만 해요. 임시 파일은 tempBase(설정 폴더 아래) 옆에만 만들고 지워요

const { photoBuffer, videoBuffer } = require('./thumbs');
const { isVideoPath } = require('./planner');

// Electron utilityProcess 는 process.parentPort, 점검(node child_process.fork)은 process.send 로 주고받아요
const port = process.parentPort;
const send = (msg) => (port ? port.postMessage(msg) : process.send(msg));

async function handle(msg) {
  if (!msg || !Number.isInteger(msg.id) || typeof msg.p !== 'string') return;
  let b64 = null;
  try {
    const tools = msg.tools || {};
    const buf = isVideoPath(msg.p)
      ? await videoBuffer({ path: msg.p, durationSec: Number.isFinite(msg.durationSec) ? msg.durationSec : 1 }, tools, msg.tempBase, msg.videoTimeoutMs)
      : await photoBuffer({ path: msg.p }, msg.px, tools, msg.tempBase);
    if (buf && buf.length) b64 = Buffer.from(buf).toString('base64');
  } catch (e) {
    b64 = null; // 깨진 파일 · 도구 없음 → 그림 없이 이름만
  }
  send({ id: msg.id, b64 });
}

if (port) port.on('message', (e) => handle(e.data));
else {
  process.on('message', handle);
  process.on('disconnect', () => process.exit(0)); // 부른 쪽이 꺼지면 같이 꺼져요
}

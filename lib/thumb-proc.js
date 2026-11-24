// 파일 위치: lib/thumb-proc.js
// 역할: 작은 그림을 "따로 도는 프로그램"(lib/thumb-worker.js)에 맡기기 (2026-11-24)
//   왜: 원본 정리 창에서 sharp(libvips)가 어떤 사진에서 앱 전체를 꺼뜨렸어요 (0xc0000409, 실사용)
//     → 그림은 자식 프로세스에서 만들어요. 그 프로그램이 꺼지면 기다리던 그림만 null(그림 없음)이고, 다음 그림 때 새로 띄워요
//   createProcMake(...) 가 돌려주는 make(경로, { tools, tempBase, px, durationSec })  (px · durationSec 은 이번 그림만 따로 정할 때, 갤러리 썸네일 · 큰 그림) → webp 내용(Buffer) 또는 null
//     lib/dup-compare.js createCompareThumbs 의 make 자리에 그대로 끼워요
//   spawn(file) → { postMessage(msg), on('message' | 'exit', fn), kill() }
//     main 은 Electron utilityProcess.fork, 점검은 node child_process.fork 로 만들어 넘겨요 (lib 는 Electron 을 직접 쓰지 않아요)

const path = require('path');

const WORKER_FILE = path.join(__dirname, 'thumb-worker.js');
const REQ_TIMEOUT_MS = 90000; // 그림 하나를 이만큼 기다려도 답이 없으면 멈춘 것으로 보고 프로그램을 꺼요 (영상 FFmpeg 30초보다 넉넉히)
const IDLE_MS = 60000; // 이만큼 쓰지 않으면 프로그램을 꺼서 메모리를 돌려줘요 (다음 그림 때 다시 띄워요)

function createProcMake({ spawn, file = WORKER_FILE, px, videoTimeoutMs, timeoutMs = REQ_TIMEOUT_MS, idleMs = IDLE_MS, onCrash = () => {} } = {}) {
  let child = null;
  let seq = 0;
  let crashes = 0;
  let idleTimer = null;
  const pending = new Map(); // 번호 → { resolve, timer }

  // 기다리던 그림은 모두 "그림 없음"으로
  const settleAll = () => {
    for (const r of pending.values()) {
      clearTimeout(r.timer);
      r.resolve(null);
    }
    pending.clear();
  };

  // 프로그램 끄기 (일부러 끈 것은 child 를 먼저 비워서 "꺼짐"으로 세지 않아요)
  const stop = () => {
    clearTimeout(idleTimer);
    const c = child;
    child = null;
    settleAll();
    if (c) {
      try {
        c.kill();
      } catch (e) {
        // 이미 꺼졌으면 넘어가요
      }
    }
  };

  const armIdle = () => {
    clearTimeout(idleTimer);
    if (pending.size || !child) return;
    idleTimer = setTimeout(() => {
      if (!pending.size) stop();
    }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  };

  const start = () => {
    const c = spawn(file);
    c.on('message', (msg) => {
      if (c !== child || !msg) return;
      const r = pending.get(msg.id);
      if (!r) return;
      pending.delete(msg.id);
      clearTimeout(r.timer);
      r.resolve(typeof msg.b64 === 'string' && msg.b64 ? Buffer.from(msg.b64, 'base64') : null);
      armIdle();
    });
    c.on('exit', (code) => {
      if (c !== child) return; // 일부러 끈 것
      child = null;
      crashes++;
      try {
        onCrash({ code, pending: pending.size });
      } catch (e) {
        // 기록이 실패해도 그림 일은 계속
      }
      settleAll();
    });
    return c;
  };

  const make = (p, { tools, tempBase, px: reqPx, durationSec } = {}) =>
    new Promise((resolve) => {
      clearTimeout(idleTimer);
      try {
        if (!child) child = start();
      } catch (e) {
        child = null;
        resolve(null);
        return;
      }
      const id = ++seq;
      const timer = setTimeout(() => {
        if (pending.has(id)) stop(); // 멈춘 것 같아요 → 끄고 기다리던 것은 그림 없이
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      try {
        child.postMessage({ id, p, tools: tools || {}, tempBase, px: reqPx || px, durationSec, videoTimeoutMs });
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
  make.close = stop;
  make.stats = () => ({ running: !!child, pending: pending.size, crashes });
  return make;
}

module.exports = { createProcMake, WORKER_FILE };

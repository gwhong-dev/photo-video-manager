// 파일 위치: scripts/launch-check.js
// 역할: 앱 창을 띄워서 화면 글자와 오류만 읽고, 창을 닫아 정상 종료시키기 (점검 항목 1)
//   버튼은 하나도 누르지 않아요.
//   remote debugging = 프로그램 밖에서 화면 내용을 읽는 통로 (이 PC 안에서만 열림)

const { spawn } = require('child_process');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchCheck(appDir, { port = 9333, waitMs = 4000 } = {}) {
  const exe = path.join(appDir, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const child = spawn(exe, ['.', `--remote-debugging-port=${port}`], { cwd: appDir });
  let mainOut = '';
  child.stdout.on('data', (d) => (mainOut += d));
  child.stderr.on('data', (d) => (mainOut += d));
  let exitCode = null;
  let spawnError = null;
  child.on('exit', (c) => (exitCode = c));
  // 실행 파일이 없거나 시작에 실패하면 (예: npm install 때 Electron을 못 받음) 기다리지 않고 바로 끝내기
  child.on('error', (e) => {
    spawnError = e;
    if (exitCode === null) exitCode = -1; // 기다림 반복문이 바로 끝나게
  });

  // 창(페이지)이 뜰 때까지 기다리기 (최대 30초)
  let page = null;
  for (let i = 0; i < 60 && !page && exitCode === null; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = list.find((t) => t.type === 'page');
    } catch (e) {
      // 아직 안 뜸
    }
  }
  if (!page) {
    child.kill();
    const why = spawnError ? `Electron을 실행하지 못함 (${spawnError.code || spawnError.message}). npm install로 Electron을 다시 받아 주세요` : '창이 뜨지 않음';
    return { ok: false, title: '', text: '', errors: [why], exitCode, mainOut };
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  await send('Log.enable');

  await sleep(waitMs); // 도구 찾기가 끝날 시간
  const title = (await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.result.value;
  const text = (await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })).result.result.value;

  // 창 닫기 → 앱이 스스로 종료 (exiftool 정리 포함)
  send('Runtime.evaluate', { expression: 'window.close()' });
  for (let i = 0; i < 20 && exitCode === null; i++) await sleep(500);
  if (exitCode === null) {
    child.kill();
    errors.push('10초 안에 안 꺼져서 강제 종료');
  }
  try {
    ws.close();
  } catch (e) {
    // 이미 닫힘
  }
  return { ok: errors.length === 0 && exitCode === 0, title, text, errors, exitCode, mainOut };
}

module.exports = { launchCheck };

// 직접 실행: node scripts/launch-check.js
if (require.main === module) {
  launchCheck(path.join(__dirname, '..')).then((r) => {
    console.log(`제목: ${r.title}\n----- 화면 글자 -----\n${r.text}\n----- 오류 -----\n${r.errors.join('\n') || '(없음)'}\n종료 코드: ${r.exitCode}`);
    process.exit(r.ok ? 0 : 1);
  });
}

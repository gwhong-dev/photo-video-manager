// 파일 위치: scripts/launch-check.js
// 역할: 앱 창을 띄워서 화면 글자와 오류만 읽고, 창을 닫아 정상 종료시키기 (점검 항목 1)
//   버튼은 기본으로 하나도 누르지 않아요. clickText 를 주면 그 글자가 든 버튼 하나만 눌러 봐요 (메뉴 이동 확인용)
//   remote debugging = 프로그램 밖에서 화면 내용을 읽는 통로 (이 PC 안에서만 열림)

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 앱을 띄우기 전에 main 쪽 파일 문법부터 확인해요.
//   문법 오류가 있는 채로 Electron을 켜면 "main process 오류" 대화상자가 사용자 화면에 떠서 점검이 멈춰 버려요
const MAIN_FILES = ['main.js', 'gallery-main.js', 'preload.js'];
function syntaxErrors(appDir) {
  const errors = [];
  for (const f of MAIN_FILES) {
    const full = path.join(appDir, f);
    if (!fs.existsSync(full)) continue;
    const r = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
    if (r.status !== 0) errors.push(`${f} 문법 오류: ${String(r.stderr || r.error || '').trim().split(/\r?\n/).slice(0, 6).join(' ')}`);
  }
  return errors;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// env: 앱에 더 넘길 환경변수 (점검 전용 PVM_USER_DATA, PVM_START_SCREEN)
//   PVM_USER_DATA를 안 주면 임시 pvm-check- 폴더를 만들어 넘기고 끝나면 지워요 (진짜 사용자 설정을 읽지 않게. 직접 실행도 마찬가지)
// exe: 점검용으로 다른 Electron 실행 파일을 쓸 때 (기본은 appDir 안의 것)
async function launchCheck(appDir, opts = {}) {
  const env = { ...(opts.env || {}) };
  let made = null;
  if (!env.PVM_USER_DATA) {
    made = fs.mkdtempSync(path.join(os.tmpdir(), 'pvm-check-'));
    env.PVM_USER_DATA = made;
  }
  try {
    return await launchOnce(appDir, { ...opts, env });
  } finally {
    if (made) {
      try {
        fs.rmSync(made, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (e) { /* 못 지워도 점검 임시 폴더라 나중에 check.js가 정리해요 */ }
    }
  }
}

// until: 화면 글자에 이 글이 나올 때까지 더 기다려요 (최대 untilMs). probe: 화면에서 더 읽고 싶은 값(자바스크립트 식)
// clickText: until 을 기다린 뒤 이 글자가 든 버튼 하나를 눌러요. clickUntil: 누른 뒤 화면 글자에 이 글이 나올 때까지 기다려요 (최대 untilMs)
//   결과의 clicked 는 버튼을 찾아 눌렀는지예요 (clickText 를 안 주면 undefined)
//   thenClickText, thenClickUntil: 그다음에 누를 버튼 하나 더 (메뉴를 연 뒤 탭을 누를 때)
async function launchOnce(appDir, { port = 9333, waitMs = 4000, env = {}, exe: exeOverride, until = '', untilMs = 20000, probe = '', clickText = '', clickUntil = '', thenClickText = '', thenClickUntil = '' } = {}) {
  const bad = syntaxErrors(appDir);
  if (bad.length) return { ok: false, title: '', text: '', errors: bad, exitCode: null, mainOut: '' };
  const exe = exeOverride || path.join(appDir, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const child = spawn(exe, ['.', `--remote-debugging-port=${port}`], { cwd: appDir, env: { ...process.env, ...env } });
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
    // Electron이 일찍 끝났으면 main 쪽 출력(불러오다 난 오류)의 앞부분도 같이 알려요
    const hint = exitCode !== null && mainOut.trim() ? ` / 출력: ${mainOut.trim().split(/\r?\n/).slice(0, 3).join(' ')}` : '';
    return { ok: false, title: '', text: '', errors: [why + hint], exitCode, mainOut };
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
  const readText = async () => (await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })).result.result.value;
  if (until) {
    for (let waited = 0; waited < untilMs && !String(await readText()).includes(until); waited += 500) await sleep(500);
  }
  // 글자가 든 버튼 하나를 누르고, 화면에 다음 글이 나올 때까지 기다려요
  const clickButton = async (label, waitFor) => {
    const expr = `(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.innerText || '').includes(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`;
    const done = (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.result.value === true;
    if (done && waitFor) {
      for (let waited = 0; waited < untilMs && !String(await readText()).includes(waitFor); waited += 500) await sleep(500);
    }
    return done;
  };
  let clicked;
  if (clickText) {
    clicked = await clickButton(clickText, clickUntil);
    if (clicked && thenClickText) clicked = await clickButton(thenClickText, thenClickUntil);
  }
  const title = (await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.result.value;
  const text = await readText();
  // probe가 약속(비동기 함수)이면 끝날 때까지 기다려요
  const probed = probe ? (await send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: true })).result.result.value : undefined;

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
  return { ok: errors.length === 0 && exitCode === 0, title, text, probed, clicked, errors, exitCode, mainOut };
}

module.exports = { launchCheck };

// 직접 실행: node scripts/launch-check.js
if (require.main === module) {
  launchCheck(path.join(__dirname, '..')).then((r) => {
    console.log(`제목: ${r.title}\n----- 화면 글자 -----\n${r.text}\n----- 오류 -----\n${r.errors.join('\n') || '(없음)'}\n종료 코드: ${r.exitCode}`);
    process.exit(r.ok ? 0 : 1);
  });
}

// 파일 위치: scripts/check-parallel.js
// 역할: 점검을 같은 PC 에서 여러 개 돌려도 안 부딪히는지 · 멈춘 점검이 끝나는지 점검 (49). scripts/check.js 의 ITEMS 끝에 붙어요
//   빠르게 이 파일만 돌릴 때: node scripts/check-parallel.js
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { sub } = require('./check-gallery');
const { freePort, cleanupTempDirs, TEMP_PREFIX } = require('./check-guard');
const { launchCheck } = require('./launch-check');

const APP = path.join(__dirname, '..');
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const items = [
  {
    no: 49,
    name: '점검 동시 실행 · 제한 시간',
    async run() {
      const out = [];

      // 49a 빈 포트: 실제로 열 수 있고, 연달아 골라도 값이 다름 (고정 포트가 아님)
      {
        const ports = [];
        for (let i = 0; i < 3; i++) ports.push(await freePort());
        const opened = await Promise.all(ports.map((p) => new Promise((r) => {
          const s = net.createServer();
          s.once('error', () => r(false));
          s.listen(p, '127.0.0.1', () => s.close(() => r(true)));
        })));
        const fixed = ports.some((p) => p >= 9333 && p <= 9344);
        out.push(sub('49a 빈 포트를 골라 씀 (열 수 있음, 예전 고정 포트 9333~9344 아님)', opened.every(Boolean) && !fixed, JSON.stringify({ ports, opened })));
      }

      // 49b 앱 2개를 동시에 띄워도 둘 다 정상 (예전엔 같은 포트라 서로 방해)
      {
        const [a, b] = await Promise.all([launchCheck(APP), launchCheck(APP)]);
        out.push(sub('49b 앱 2개 동시 실행 둘 다 정상', a.ok && b.ok && !!a.title && !!b.title,
          JSON.stringify({ a: [a.ok, a.errors.slice(0, 1)], b: [b.ok, b.errors.slice(0, 1)] })));
      }

      // 49c 임시 폴더 정리: 이번 폴더만 (실패면 남김), 오래된 남의 폴더만, 다른 이름 · 새 폴더는 그대로
      {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pvm-parallel-root-'));
        try {
          const mk = (name, ageH) => {
            const d = path.join(root, name);
            fs.mkdirSync(d);
            const t = new Date(Date.now() - ageH * 3600 * 1000);
            fs.utimesSync(d, t, t);
            return d;
          };
          const mine = mk(`${TEMP_PREFIX}mine`, 0);
          mk(`${TEMP_PREFIX}other-fresh`, 0.1);
          mk(`${TEMP_PREFIX}other-old`, 5);
          mk('unrelated-old', 5);
          const left = () => fs.readdirSync(root).sort();
          const failedRun = cleanupTempDirs(mine, true, { tmpRoot: root, log: () => {} });
          const afterFail = left();
          const passRun = cleanupTempDirs(mine, false, { tmpRoot: root, log: () => {} });
          const afterPass = left();
          const ok = JSON.stringify(failedRun) === JSON.stringify([`${TEMP_PREFIX}other-old`])
            && afterFail.join() === ['pvm-check-mine', 'pvm-check-other-fresh', 'unrelated-old'].join()
            && JSON.stringify(passRun) === JSON.stringify([`${TEMP_PREFIX}mine`])
            && afterPass.join() === ['pvm-check-other-fresh', 'unrelated-old'].join();
          out.push(sub('49c 임시 폴더 정리는 이번 폴더와 3시간 지난 것만', ok, JSON.stringify({ failedRun, afterFail, passRun, afterPass })));
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }

      // 49d 제한 시간: 멈춘 점검 흉내 (자식 프로세스를 띄워 놓고 안 끝남) → 시간이 지나면 자식까지 정리하고 종료 코드 1
      {
        const script = `
          const { spawn } = require('child_process');
          const { startWatchdog, trackChild } = require(${JSON.stringify(path.join(__dirname, 'check-guard.js'))});
          const kid = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
          trackChild(kid);
          const kid2 = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); // 추적 안 한 자식 (exiftool 흉내)
          console.log('PIDS ' + kid.pid + ' ' + kid2.pid);
          startWatchdog();
          setInterval(() => {}, 1000);
        `;
        const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, PVM_CHECK_TIMEOUT_MIN: '0.03' } });
        let o = '';
        child.stdout.on('data', (d) => (o += d));
        const code = await new Promise((r) => {
          const t = setTimeout(() => { child.kill(); r('안 끝남'); }, 60000);
          child.on('exit', (c) => { clearTimeout(t); r(c); });
        });
        await sleep(500);
        const m = /PIDS (\d+) (\d+)/.exec(o);
        const pids = m ? [Number(m[1]), Number(m[2])] : [];
        const left = pids.filter(alive);
        for (const p of left) { try { process.kill(p); } catch (e) { /* 무시 */ } }
        out.push(sub('49d 멈춘 점검은 제한 시간에 끝나고 자식 프로세스도 정리됨', code === 1 && pids.length === 2 && left.length === 0, JSON.stringify({ code, pids, left })));
      }
      return out;
    },
  },
];

module.exports = { items };

// 이 파일만 돌릴 때
if (require.main === module) {
  (async () => {
    for (const it of items) {
      for (const s of await it.run({})) console.log(`${s.status === 'ok' ? '✅' : '❌'} ${s.label} ${s.detail || ''}`);
    }
    process.exit(0);
  })();
}

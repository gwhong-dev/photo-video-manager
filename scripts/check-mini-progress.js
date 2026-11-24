// 파일 위치: scripts/check-mini-progress.js
// 역할: 작은 진행 창(큰 창을 최소화하면 오른쪽 아래에 뜨는 창) 점검 (70). scripts/check.js 의 ITEMS 끝에 붙어요
//   글자 만들기(lib/mini-progress.js), 작업 표시줄 막대 색, 창 자리, 작은 창이 열어 둔 기능, 창 막기를 확인해요
//   사진 · 파일은 건드리지 않아요 (순수 함수와 파일 글자만 봐요)
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { sub } = require('./check-gallery');
const m = require('../lib/mini-progress');
const { isAppScreen } = require('../lib/window-guard');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const MINI_HTML = path.join(ROOT, 'lib', 'mini', 'mini-progress.html');
const MINI_PRELOAD = path.join(ROOT, 'lib', 'mini', 'mini-preload.js');

// 작은 창 preload 를 가짜 electron 으로 돌려서, 화면에 열어 준 기능 이름과 보내는 채널을 모아요
function loadMiniPreload() {
  const exposed = {};
  const sent = [];
  const listened = [];
  const fake = {
    contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api; } },
    ipcRenderer: {
      send: (ch, ...args) => sent.push([ch, ...args]),
      on: (ch) => listened.push(ch),
      invoke: () => { throw new Error('invoke 는 쓰지 않아요'); },
    },
  };
  const code = fs.readFileSync(MINI_PRELOAD, 'utf8');
  vm.runInNewContext(code, { require: (name) => (name === 'electron' ? fake : (() => { throw new Error(`${name} 은 불러오지 않아요`); })()) });
  return { exposed, sent, listened };
}

const items = [
  {
    no: 70,
    name: '작은 진행 창',
    async run() {
      const out = [];

      // 70a 남은 시간 글자
      const r = [m.fmtRemain(null), m.fmtRemain(30), m.fmtRemain(40 * 60), m.fmtRemain(65 * 60), m.fmtRemain(120 * 60)];
      out.push(sub('70a 남은 시간 (모름, 1분 안, 40분, 1시간 5분, 2시간)',
        r[0] === '' && r[1] === '1분 안에 끝나요' && r[2] === '40분 남음' && r[3] === '1시간 5분 남음' && r[4] === '2시간 남음', r.join(' / ')));

      // 70b 가져오기 실행 중: 퍼센트 · 개수 · 지금 파일 · 속도 · 일시정지 버튼
      const run = m.importProgress({ done: 500, dup: 100, fail: 20, broken: 0, total: 1000, remainSec: 2400, name: 'IMG_0001.HEIC', bytesDone: 1024 ** 3, bytesTotal: 2 * 1024 ** 3, bytesPerSec: 40 * 1024 ** 2 });
      const v = m.view(run);
      out.push(sub('70b 실행 중 글자 (62%, 40분 남음, 완료 · 중복 · 실패, 일시정지 가능)',
        v.pctText === '62%' && v.side === '40분 남음' && v.counts.join(',') === '완료 500,중복 100,실패 20' && v.file === 'IMG_0001.HEIC'
          && v.speed === '40.0 MB/s' && v.bytes === '1.0 GB / 2.0 GB' && v.canPause && v.lineText === '40분 남음' && v.title === '가져오기 중',
        JSON.stringify({ pct: v.pctText, side: v.side, counts: v.counts, speed: v.speed, bytes: v.bytes })));

      // 70c 일시정지를 누르면 "멈추는 중"이 다음 진행 알림에도 남고, 끝나면 이어서 실행 버튼
      const pausing = m.importProgress({ done: 510, total: 1000 }, { ...run, pausing: true });
      const paused = m.importEnd(pausing, { done: 600, dup: 100, fail: 20, paused: true }, 540);
      const pv = m.view(paused);
      out.push(sub('70c 일시정지: 멈추는 중 유지, 끝나면 노랑 막대 · "540개 이어서 실행"',
        pausing.pausing === true && paused.phase === 'paused' && pv.resume === '540개 이어서 실행' && pv.left === '남은 파일 540개'
          && pv.lineText === '일시정지됨' && !pv.canPause && m.taskbar(paused).mode === 'paused',
        `${pv.resume} / ${pv.lineText} / ${m.taskbar(paused).mode}`));

      // 70c2 일시정지 없이 회차만 끝났는데 남은 파일이 있으면 "끝났어요"가 아니라 "이번 회차 끝" + 이어서 실행 (2026-11-24 앱 확인에서 찾음)
      //   큰 창이 최소화돼 있으면 원본 확인 질문을 미뤘다가 큰 창이 보일 때 물어요 (보이지 않는 질문 창이 화면을 붙잡지 않게)
      {
        const be = m.view(m.importEnd(m.textStage(run, 'import', '정리할 수 있는 원본 개수를 세는 중'), { done: 3, paused: false }, 3, 5));
        const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        const later = /visibilityState === 'hidden'[^\n]*trashOfferLater = true/.test(html) && /addEventListener\('visibilitychange'/.test(html);
        out.push(sub('70c2 회차 끝 + 남은 파일 → "이번 회차 끝" · "3개 이어서 실행" · 남은 5개, 단계 글자 지움, 최소화 중엔 원본 확인 질문을 미룸',
          be.phase === 'paused' && be.title === '가져오기 이번 회차 끝' && be.lineText === '이번 회차 끝' && be.resume === '3개 이어서 실행' && be.left === '남은 파일 5개' && be.note === '' && later,
          `${be.title} / ${be.resume} / ${be.left} / 미루기 ${later}`));
      }

      // 70d 끝 · 멈춤 · 오류: 다 끝났으면 이어서 실행 없음, 메모리 부족 · 오류는 빨강
      const done = m.view(m.importEnd(run, { done: 1030, dup: 202, fail: 2, paused: true }, 0));
      const low = m.importEnd(run, { done: 1, memoryLow: '메모리 부족', paused: true }, 10);
      const err = m.failed(run, 'import', new Error("Error invoking remote method 'run-batch': Error: 백업 폴더를 찾을 수 없어요"));
      out.push(sub('70d 끝 "✓ 끝났어요 완료 1,030, 중복 202, 실패 2", 메모리 부족 · 오류는 빨강',
        done.doneText === '✓ 끝났어요' && done.lineText === '완료 1,030, 중복 202, 실패 2' && !done.resume
          && low.phase === 'error' && err.message === '백업 폴더를 찾을 수 없어요' && m.taskbar(low).mode === 'error' && m.taskbar(err).mode === 'error',
        `${done.lineText} / ${err.message}`));

      // 70e 원본 확인 · 정리: 개수로 퍼센트, 일시정지 없음. 퍼센트 없는 단계는 글자만 · 흐르는 막대
      const clean = m.view(m.countProgress('clean', { done: 1204, total: 3410 }, '원본을 정리하는 중'));
      const text = m.textStage(run, 'import', '정리할 수 있는 원본 개수를 세는 중');
      const tv = m.view(text);
      const cleanDone = m.view(m.cleanEnd({ trashed: 3000, moved: 400, fail: 10 }));
      out.push(sub('70e 원본 정리 35% (일시정지 없음), 글자만 단계, 정리 끝 개수',
        clean.pctText === '35%' && clean.side === '1,204 / 3,410' && !clean.canPause && clean.title === '원본 정리 중'
          && tv.pct === null && tv.lineText === '정리할 수 있는 원본 개수를 세는 중' && !tv.canPause && tv.counts.length === 3
          && m.taskbar(text).mode === 'indeterminate' && cleanDone.lineText === '휴지통 3,000, 이동 400, 실패 10',
        `${clean.pctText} ${clean.side} / ${tv.lineText} / ${cleanDone.lineText}`));

      // 70f 작업 표시줄 막대: 실행 중 초록(normal) 62%, 끝 · 없음은 지움
      const tb = m.taskbar(run);
      out.push(sub('70f 작업 표시줄 막대 (실행 중 0.62 normal, 끝 · 없음은 -1)',
        tb.mode === 'normal' && tb.value === 0.62 && m.taskbar(null).value === -1 && m.taskbar(m.importEnd(run, { done: 1 }, 0)).value === -1,
        JSON.stringify(tb)));

      // 70g 창 자리: 일하는 영역 오른쪽 아래(여백 12), 크기가 바뀌어도 오른쪽 아래 모서리는 그대로
      const c = m.cornerOf({ x: 0, y: 0, width: 1920, height: 1040 }, 340, 200);
      const k = m.resizeKeepCorner({ x: 1568, y: 828, width: 340, height: 200 }, 420, 42);
      out.push(sub('70g 창 자리 (오른쪽 아래, 크기 바꿔도 모서리 그대로)',
        c.x === 1568 && c.y === 828 && k.x + k.width === 1908 && k.y + k.height === 1028 && k.width === 420,
        `${JSON.stringify(c)} → ${JSON.stringify(k)}`));

      // 70h 작은 창이 열어 둔 기능은 6개뿐 (파일 · 다른 기능 없음), 보내는 채널은 mini: 로 시작
      {
        let ok = false;
        let detail = '';
        try {
          const { exposed, sent, listened } = loadMiniPreload();
          const api = exposed.mini || {};
          const names = Object.keys(api).sort().join(',');
          api.pause(); api.resume(); api.openMain(); api.setCompact('yes'); api.fit('340', 'x'); api.onState(() => {});
          const chans = sent.map((s) => s[0]);
          ok = Object.keys(exposed).join(',') === 'mini' && names === 'fit,onState,openMain,pause,resume,setCompact'
            && chans.every((ch) => ch.startsWith('mini:')) && listened.join(',') === 'mini:state'
            && sent.find((s) => s[0] === 'mini:compact')[1] === false && JSON.stringify(sent.find((s) => s[0] === 'mini:fit').slice(1)) === '[340,0]';
          detail = `${names} / ${chans.join(',')}`;
        } catch (e) {
          detail = e.message;
        }
        out.push(sub('70h 작은 창 preload 는 버튼 6가지만 (간단히 값은 true 일 때만 켬)', ok, detail));
      }

      // 70i 창 막기 · 화면 파일: 작은 창 파일만 열리고, 외부 주소 · 다른 파일은 막혀요. 화면은 외부 자료를 읽지 않아요
      {
        const html = fs.readFileSync(MINI_HTML, 'utf8');
        const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
        const allow = isAppScreen(pathToFileURL(MINI_HTML).href + '?x=1', [MINI_HTML]);
        const block = !isAppScreen('https://example.com/', [MINI_HTML]) && !isAppScreen(pathToFileURL(path.join(ROOT, 'index.html')).href, [MINI_HTML]);
        const csp = /default-src 'none'/.test(html) && !/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, ''));
        const guarded = /guardWindow\(miniWin\.webContents, \[MINI_FILE\]/.test(main);
        const senderCheck = (main.match(/if \(!?fromMini\(e\)/g) || []).length >= 5;
        out.push(sub('70i 작은 창은 자기 화면만 (창 막기 · 보낸 창 확인 · 외부 주소 없음)', allow && block && csp && guarded && senderCheck,
          `허용 ${allow}, 막기 ${block}, CSP ${csp}, 창 막기 ${guarded}, 보낸 창 확인 ${senderCheck}`));
      }

      // 70j 검증 지적 반영 (2026-11-24 #145): ▶ 두 번 눌러도 한 번만 시작, 이어서 실행 개수는 작은 창 글자와 같게,
      //   시작 전에 멈춘 경우(도구 없음 · 메모리 부족)도 작은 창에 알림, 큰 창을 다른 모니터로 옮기면 작은 창도 따라감
      {
        const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
        const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        const miniHtml = fs.readFileSync(MINI_HTML, 'utf8');
        const checks = {
          '큰 창 한 번만': /if \(busy \|\| starting\) return;/.test(html) && /if \(!trashOfferLater \|\| busy \|\| starting/.test(html),
          'main 한 번만': /miniResuming \|\| running/.test(main),
          '작은 창 버튼 막기': /\$\('resumeBtn'\)\.disabled = \$\('lResume'\)\.disabled = true/.test(miniHtml),
          '개수 같게': /send\('mini-resume', lastBatchN\)/.test(main) && /onMiniResume\(\(n\) =>[\s\S]{0,200}runBatch\(Number\.isInteger\(n\)/.test(html),
          '도구 없음 알림': /endMini\(mini\.failed\(miniState, 'import', err\)\);\s*throw err;/.test(main),
          '메모리 부족 알림': /endMini\(mini\.importEnd\(miniState, out, 0\)\)/.test(main),
          '모니터 따라감': /getDisplayMatching\(b\)\.id !== display\.id/.test(main),
        };
        const bad = Object.keys(checks).filter((k) => !checks[k]);
        const low = m.view(m.importEnd(paused, { done: 0, memoryLow: '메모리 부족' }, 0));
        out.push(sub('70j ▶ 한 번만 · 이어서 실행 개수 같게 · 시작 전 멈춤도 작은 창에 · 다른 모니터 따라감',
          bad.length === 0 && low.phase === 'error' && !low.resume, bad.length ? `빠짐: ${bad.join(', ')}` : `${Object.keys(checks).length}개 확인`));
      }

      return out;
    },
  },
];

module.exports = { items };

// 이 파일만 돌릴 때: node scripts/check-mini-progress.js
if (require.main === module) {
  (async () => {
    let failed = 0;
    for (const s of await items[0].run({})) {
      if (s.status === 'fail') failed++;
      console.log(`${s.status === 'ok' ? '✅' : '❌'} ${s.label}${s.detail ? ' — ' + s.detail : ''}`);
    }
    process.exit(failed ? 1 : 0);
  })();
}

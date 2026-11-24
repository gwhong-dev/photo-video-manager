// 파일 위치: lib/mini-progress.js
// 역할: 작은 진행 창(큰 창을 최소화하면 오른쪽 아래에 뜨는 창)에 보여 줄 상태 · 글자 만들기
//   main.js 가 진행 알림을 받을 때마다 상태(state)를 만들고, view(state) 글자를 작은 창에 보내요
//   작업 표시줄 아이콘 막대도 taskbar(state) 로 정해요
//   전자(Electron) 없이 도는 순수 함수만 있어요 → scripts/check-mini-progress.js 가 확인해요
//
// state 모양
//   { job: 'import'(가져오기) | 'check'(원본 확인) | 'clean'(원본 정리),
//     phase: 'running' | 'paused' | 'done' | 'error',
//     done, total: 진행 개수 (total 이 없으면 퍼센트 없이 글자만),
//     remainSec, name(지금 파일), bytesDone, bytesTotal, bytesPerSec,
//     counts: [[이름, 개수], ...], note: 한 줄 설명, message: 끝 · 멈춤 안내,
//     pausing: 일시정지를 눌러 멈추는 중, resumeN: 이어서 실행할 개수 }

const TITLES = { import: '가져오기', check: '원본 확인', clean: '원본 정리' };

const num = (n) => Number(n || 0).toLocaleString('ko-KR');

function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// 남은 시간: "40분 남음", "1시간 5분 남음". 모르면 빈 글자
function fmtRemain(sec) {
  const s = Number(sec);
  if (sec == null || !Number.isFinite(s) || s < 0) return '';
  if (s < 60) return '1분 안에 끝나요';
  const min = Math.ceil(s / 60);
  if (min < 60) return `${min}분 남음`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}시간 ${m}분 남음` : `${h}시간 남음`;
}

// 가져오기 진행 (lib/runner.js 의 onProgress). 처리한 수 = 완료 + 중복 + 실패 + 재생 불가
function importProgress(p, prev = null) {
  const handled = (p.done || 0) + (p.dup || 0) + (p.fail || 0) + (p.broken || 0);
  return {
    job: 'import',
    phase: 'running',
    done: handled,
    total: p.total || 0,
    remainSec: p.remainSec,
    name: p.name || '',
    bytesDone: p.bytesDone || 0,
    bytesTotal: p.bytesTotal || 0,
    bytesPerSec: p.bytesPerSec || 0,
    counts: [['완료', p.done || 0], ['중복', p.dup || 0], ['실패', p.fail || 0]],
    pausing: !!(prev && prev.job === 'import' && prev.phase === 'running' && prev.pausing),
  };
}

// 원본 확인 · 정리 진행 ({ done, total }). job: 'check' | 'clean', note: 한 줄 설명
function countProgress(job, p, note) {
  return { job, phase: 'running', done: p.done || 0, total: p.total || 0, note };
}

// 퍼센트를 모르는 단계 (예: 회차 끝에 원본 개수 세기). 앞 상태의 개수는 남겨요
function textStage(prev, job, note) {
  return { job, phase: 'running', total: 0, note, counts: prev && prev.job === job ? prev.counts : undefined };
}

// 가져오기 회차가 끝났을 때. r = run-batch 결과, resumeN = 이어서 실행할 개수(다음 회차), leftN = 남은 파일 전체
//   남은 파일이 있으면 일시정지와 같은 모양(노랑, 이어서 실행 버튼). 일시정지가 아니면 "이번 회차 끝" 이라고 써요
function importEnd(prev, r, resumeN, leftN = resumeN) {
  const prevBase = prev && prev.job === 'import' ? prev : { job: 'import', done: 0, total: 0 };
  const base = { ...prevBase, note: '' }; // "원본 개수를 세는 중" 같은 단계 글자는 끝나면 지워요
  const counts = [['완료', r.done || 0], ['중복', r.dup || 0], ['실패', r.fail || 0]];
  if (r.memoryLow) return { ...base, phase: 'error', counts, message: 'PC 메모리가 부족해 멈췄어요. 큰 창에서 안내를 확인해 주세요', pausing: false };
  if (r.stopped) return { ...base, phase: 'error', counts, message: String(r.stopped), pausing: false };
  if (resumeN > 0) return { ...base, phase: 'paused', batchEnd: !r.paused, counts, resumeN, leftN: Math.max(leftN || 0, resumeN), pausing: false, name: '' };
  return { ...base, phase: 'done', counts, pausing: false };
}

// 원본 정리가 끝났을 때 (lib/cleaner.js cleanOriginals 결과)
function cleanEnd(r) {
  const counts = [['휴지통', r.trashed || 0], ['이동', r.moved || 0], ['실패', r.fail || 0]];
  return { job: 'clean', phase: 'done', done: 1, total: 1, counts };
}

// 원본 확인이 끝났을 때 (정리할지는 큰 창에서 골라요)
function checkEnd() {
  return { job: 'check', phase: 'done', done: 1, total: 1, message: '큰 창에서 정리할지 골라 주세요' };
}

// 오류로 멈췄을 때
function failed(prev, job, err) {
  const msg = err && err.message ? err.message : String(err || '알 수 없는 오류');
  const base = prev && prev.job === job ? prev : { job, done: 0, total: 0 };
  return { ...base, job, phase: 'error', message: msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), pausing: false };
}

const pctOf = (s) => (s && s.total > 0 ? Math.max(0, Math.min(100, Math.floor(((s.done || 0) / s.total) * 100))) : null);

// 작은 창에 보낼 글자. 작은 창은 이 글자를 그대로 넣기만 해요
function view(s) {
  if (!s) return null;
  const name = TITLES[s.job] || '작업';
  const pct = pctOf(s);
  const counts = (s.counts || []).map(([k, n]) => `${k} ${num(n)}`);
  const running = s.phase === 'running';
  const pausedText = s.batchEnd ? '이번 회차 끝' : '일시정지됨';
  const v = {
    phase: s.phase,
    title: `${name} ${{ running: '중', paused: pausedText, done: '끝', error: '멈춤' }[s.phase] || ''}`.trim(),
    pct,
    pctText: pct == null ? '' : `${pct}%`,
    side: '',
    counts,
    file: running && s.job === 'import' ? s.name || '' : '',
    speed: running && s.bytesPerSec ? `${fmtBytes(s.bytesPerSec)}/s` : '',
    bytes: s.job === 'import' && s.bytesTotal ? `${fmtBytes(s.bytesDone)} / ${fmtBytes(s.bytesTotal)}` : '',
    note: s.note || '',
    message: s.message || '',
    canPause: running && s.job === 'import' && pct != null,
    pausing: !!s.pausing,
    resume: s.phase === 'paused' && s.resumeN > 0 ? `${num(s.resumeN)}개 이어서 실행` : '',
    left: s.phase === 'paused' && s.resumeN > 0 ? `남은 파일 ${num(s.leftN || s.resumeN)}개` : '',
    doneText: s.phase === 'done' ? '✓ 끝났어요' : s.phase === 'error' ? '⚠ 멈췄어요' : '',
  };
  if (running) {
    if (s.job === 'import' && pct != null) v.side = fmtRemain(s.remainSec);
    else if (pct != null) v.side = `${num(s.done)} / ${num(s.total)}`;
  } else if (s.phase === 'paused') v.side = pausedText;
  // 간단히(한 줄)에서 가운데 글자: 실행 중이면 남은 시간, 글자만 단계면 설명
  v.lineText = running ? v.side || v.note : s.phase === 'paused' ? pausedText : counts.join(', ') || v.message;
  return v;
}

// 작업 표시줄 아이콘 막대 (BrowserWindow.setProgressBar 에 넘길 값)
//   실행 중 = 초록(normal), 퍼센트를 모르면 흐르는 막대(indeterminate), 일시정지 = 노랑(paused), 오류 = 빨강(error), 끝 · 없음 = 지움(-1)
function taskbar(s) {
  if (!s || s.phase === 'done') return { value: -1, mode: 'none' };
  const pct = pctOf(s);
  const frac = pct == null ? null : pct / 100;
  if (s.phase === 'running') return frac == null ? { value: 2, mode: 'indeterminate' } : { value: frac, mode: 'normal' };
  if (s.phase === 'paused') return { value: Math.max(frac || 0, 0.01), mode: 'paused' };
  return { value: frac && frac > 0 ? frac : 1, mode: 'error' };
}

// 작은 창 자리: 큰 창이 있던 화면의 일하는 영역(작업 표시줄 뺀 곳) 오른쪽 아래, 여백 12
function cornerOf(workArea, w, h, margin = 12) {
  return { x: Math.round(workArea.x + workArea.width - w - margin), y: Math.round(workArea.y + workArea.height - h - margin), width: w, height: h };
}

// 크기가 바뀔 때 오른쪽 아래 모서리는 그대로 두고 늘리고 줄여요 (끌어서 옮긴 자리를 지켜요)
function resizeKeepCorner(bounds, w, h) {
  return { x: bounds.x + bounds.width - w, y: bounds.y + bounds.height - h, width: w, height: h };
}

module.exports = { fmtBytes, fmtRemain, importProgress, countProgress, textStage, importEnd, cleanEnd, checkEnd, failed, view, taskbar, cornerOf, resizeKeepCorner, TITLES };

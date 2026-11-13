// 파일 위치: scripts/check-korean-hook.js
// 역할: 한국어 답변 훅(.claude/hooks/korean-reply.js) 점검 (51). scripts/check.js 의 ITEMS 끝에 붙어요
//   영어 위주 글은 막고, 한국어 글 · 코드 · 경로 · 주소가 섞인 한국어 글은 통과시키는지 확인해요
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sub } = require('./check-gallery');
const hook = require('../.claude/hooks/korean-reply');

const HOOK = path.join(__dirname, '..', '.claude', 'hooks', 'korean-reply.js');
const u = (t, extra = {}) => JSON.stringify({ type: 'user', message: { content: t }, ...extra });
const toolResult = () => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
const a = (t) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const wrap = (recap) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__ccd_turn__wrap_up', input: { recap, ask: 'Merge it?', actions: [{ label: 'Merge' }] } }] } });

const EN = 'Here is where everything stands. Everything you asked for is running in parallel and the preview is in progress.';
const KO = 'PR #103 을 머지했어요. 새 코드로 `lib/runner.js` 실행을 다시 시작했어요 (https://github.com/gwhong-dev/photo-video-manager/pull/103).';
const KO_NAMES = 'PR #104 의 Stop hook 에서 transcript_path, stop_hook_active, decision block reason 형식을 확인했어요.';

// 훅을 실제처럼 실행 (stdin 에 입력 JSON)
function runHook(input) {
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8' });
}

const items = [
  {
    no: 51,
    name: '한국어 답변 훅',
    async run() {
      const out = [];
      out.push(sub('51a 영어 위주 마지막 글 → 다시 쓰게 막음', /마지막 보고/.test(hook.verdict([u('질문'), a(EN)]) || '')));
      out.push(sub('51b 한국어 글 (코드 · 경로 · 주소 섞임) → 통과', hook.verdict([u('질문'), a(KO)]) === null));
      out.push(sub('51c 영어 wrap_up 요약 → 막음', /마지막 보고/.test(hook.verdict([u('질문'), a(KO), wrap('The first folder is done with 0 failures, and Claude is now running the preview.')]) || '')));
      out.push(sub('51d 도구 결과 뒤 영어 마지막 글 → 막음', !!hook.verdict([u('질문'), a(KO), toolResult(), a(EN)])));
      out.push(sub('51e 지난 턴 영어, 이번 턴 한국어 → 통과', hook.verdict([u('a'), a(EN), u('b'), a(KO)]) === null));
      out.push(sub('51f 영어 코드 블록만 있는 한국어 글 → 통과', hook.verdict([u('a'), a('결과예요\n```\nnpm run check && git push origin feature/import-speed and many more english words here\n```')]) === null));
      out.push(sub('51g 코드 이름이 많은 한국어 글 → 통과 (오탐 없음)', hook.verdict([u('a'), a(KO_NAMES)]) === null));
      const mid = hook.verdict([u('a'), a(EN), toolResult(), a(KO)]) || '';
      out.push(sub('51h 중간 글만 영어 → 보고 반복 없이 한 줄로 알리게 막음', /중간 안내 글/.test(mid), mid.slice(0, 40)));
      out.push(sub('51i 턴 중간 시스템 줄(isMeta)은 새 턴이 아님 → 그 앞 영어도 봄', !!hook.verdict([u('a'), a(EN), u('스킬 내용', { isMeta: true }), a(KO)])));
      out.push(sub('51j 기록에 아직 없는 마지막 글(last_assistant_message)도 봄', /마지막 보고/.test(hook.verdict([u('a'), a(KO)], EN) || '')));

      // 실제처럼 실행
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvm-check-korean-'));
      try {
        const file = path.join(tmp, 't.jsonl');
        fs.writeFileSync(file, [u('질문'), a(EN)].join('\n'));
        const r1 = runHook({ transcript_path: file, stop_hook_active: false });
        let blocked = false;
        try { blocked = JSON.parse(r1.stdout).decision === 'block'; } catch (e) { /* 출력 없음 */ }
        out.push(sub('51k 실제 실행: 영어 보고 → block 출력', r1.status === 0 && blocked, r1.stdout.slice(0, 60)));
        const r2 = runHook({ transcript_path: file, stop_hook_active: true });
        out.push(sub('51l 다시 쓰는 중(stop_hook_active) → 통과 (한 턴에 한 번만 막음)', r2.status === 0 && r2.stdout === '', r2.stdout.slice(0, 60)));
        const r3 = runHook({ transcript_path: path.join(tmp, '없는 파일') });
        out.push(sub('51m 기록 파일이 없으면 조용히 통과', r3.status === 0 && r3.stdout === '', `종료 ${r3.status}, 출력 "${r3.stdout}"`));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      return out;
    },
  },
];

module.exports = { items };

// 이 파일만 돌릴 때: node scripts/check-korean-hook.js
if (require.main === module) {
  items[0].run().then((subs) => {
    let failed = 0;
    for (const s of subs) {
      if (s.status === 'fail') failed++;
      console.log(`${s.status === 'ok' ? '✅' : '❌'} ${s.label}${s.detail ? ' — ' + s.detail : ''}`);
    }
    process.exit(failed ? 1 : 0);
  });
}

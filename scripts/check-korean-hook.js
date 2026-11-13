// 파일 위치: scripts/check-korean-hook.js
// 역할: 한국어 답변 훅(.claude/hooks/korean-reply.js) 점검 (51). scripts/check.js 의 ITEMS 끝에 붙어요
//   영어 위주 글은 막고, 한국어 글 · 코드 · 경로 · 주소가 섞인 한국어 글은 통과시키는지 확인해요
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const path = require('path');
const { spawnSync } = require('child_process');
const { sub } = require('./check-gallery');
const hook = require('../.claude/hooks/korean-reply');

const u = (t) => JSON.stringify({ type: 'user', message: { content: t } });
const toolResult = () => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
const a = (t) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const wrap = (recap) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__ccd_turn__wrap_up', input: { recap, ask: 'Merge it?', actions: [{ label: 'Merge' }] } }] } });

const EN = 'Here is where everything stands. Everything you asked for is running in parallel and the preview is in progress.';
const KO = 'PR #103 을 머지했어요. 새 코드로 `lib/runner.js` 실행을 다시 시작했어요 (https://github.com/gwhong-dev/photo-video-manager/pull/103).';

const items = [
  {
    no: 51,
    name: '한국어 답변 훅',
    async run() {
      const out = [];
      out.push(sub('51a 영어 위주 글 → 막음', !!hook.verdict([u('질문'), a(EN)], false)));
      out.push(sub('51b 한국어 글 (코드 · 경로 · 주소 섞임) → 통과', hook.verdict([u('질문'), a(KO)], false) === null));
      out.push(sub('51c 영어 wrap_up 요약 → 막음', !!hook.verdict([u('질문'), a(KO), wrap('The first folder is done with 0 failures, and Claude is now running the preview.')], false)));
      out.push(sub('51d 도구 결과 뒤 영어 글도 이번 턴으로 봄 → 막음', !!hook.verdict([u('질문'), a(KO), toolResult(), a(EN)], false)));
      out.push(sub('51e 지난 턴 영어, 이번 턴 한국어 → 통과', hook.verdict([u('a'), a(EN), u('b'), a(KO)], false) === null));
      out.push(sub('51f 다시 쓰는 중 마지막 글이 한국어 → 통과 (계속 막히지 않음)', hook.verdict([u('a'), a(EN), a(KO)], true) === null));
      out.push(sub('51g 영어 코드 블록만 있는 한국어 글 → 통과', hook.verdict([u('a'), a('결과예요\n```\nnpm run check && git push origin feature/import-speed and many more english words here\n```')], false) === null));
      // 51h 훅을 실제처럼 실행: 대화 기록 파일이 없으면 조용히 끝남 (대화를 멈추지 않음)
      const r = spawnSync(process.execPath, [path.join(__dirname, '..', '.claude', 'hooks', 'korean-reply.js')], { input: '{"transcript_path":"없는 파일"}', encoding: 'utf8' });
      out.push(sub('51h 기록 파일이 없으면 조용히 통과', r.status === 0 && r.stdout === '', `종료 ${r.status}, 출력 "${r.stdout}"`));
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

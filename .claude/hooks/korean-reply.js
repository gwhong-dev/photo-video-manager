// 파일 위치: .claude/hooks/korean-reply.js
// 역할: Claude 가 대답을 끝내기 직전(Stop 훅)에, 이번 턴에 사용자에게 보인 글이 영어 위주면 막고 한국어로 다시 쓰게 해요
//   CLAUDE.md 6절 "답변은 한국어". 2026-11-14 긴 작업 끝 보고가 영어로 나가서 만든 장치예요
//   보는 것: 이번 턴의 Claude 글(text)과 wrap_up 의 요약 · 질문 · 버튼 글자
//   빼고 세는 것: 코드 블록, `코드`, 주소, 파일 경로, 링크 주소 (영어여도 괜찮은 것들)
//   다시 쓰는 중(stop_hook_active)이면 마지막 글 하나만 봐요 (앞의 영어 글 때문에 계속 막히지 않게)

const fs = require('fs');

// 글에서 영어여도 되는 부분 빼기
function stripAllowed(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ') // 코드 블록
    .replace(/`[^`\n]*`/g, ' ') // `코드`
    .replace(/\]\([^)]*\)/g, '] ') // [글](링크 주소) 의 주소
    .replace(/https?:\/\/\S+/g, ' ') // 주소
    .replace(/[A-Za-z]:[\\/][^\s)]*/g, ' ') // C:\... 경로
    .replace(/(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+/g, ' ') // a/b/c 경로
    .replace(/\b[\w-]+\.(?:js|json|md|html|css|mjs|bat|txt|log|jpg|png|mp4|mov|heic)\b/gi, ' '); // 파일 이름
}

// 영어 위주인지: 영어 글자가 30개 넘고, 한글이 영어 글자의 1/3 보다 적으면
function isMostlyEnglish(text) {
  const t = stripAllowed(text);
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const hangul = (t.match(/[가-힣]/g) || []).length;
  return latin > 30 && hangul * 3 < latin;
}

// 대화 기록(JSONL)에서 이번 턴에 Claude 가 사용자에게 보인 글 목록
function turnTexts(lines) {
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (e) {
      // 반쯤 써진 줄은 무시
    }
  }
  // 마지막 "사용자 글"(도구 결과가 아닌 user) 뒤부터가 이번 턴
  let start = 0;
  entries.forEach((e, i) => {
    if (e.type !== 'user' || !e.message) return;
    const c = e.message.content;
    const isToolResult = Array.isArray(c) && c.length > 0 && c.every((b) => b && b.type === 'tool_result');
    if (!isToolResult) start = i + 1;
  });
  const out = [];
  for (const e of entries.slice(start)) {
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (b.type === 'text' && b.text) out.push(b.text);
      if (b.type === 'tool_use' && /wrap_up$/.test(b.name || '') && b.input) {
        const parts = [b.input.recap, b.input.ask, ...((b.input.actions || []).map((a) => a && a.label))];
        out.push(parts.filter(Boolean).join('\n'));
      }
    }
  }
  return out;
}

// 막을지 판단 → 막으면 이유 글, 아니면 null
function verdict(lines, retrying) {
  const texts = turnTexts(lines);
  const check = retrying ? texts.slice(-1) : texts;
  const bad = check.filter(isMostlyEnglish);
  if (!bad.length) return null;
  const sample = bad[0].replace(/\s+/g, ' ').slice(0, 80);
  return `사용자에게 보인 글이 영어 위주예요 ("${sample}…"). CLAUDE.md 6절: 답변은 한국어. 변명 없이 같은 내용을 한국어로 다시 써 주세요 (wrap_up 을 썼다면 한국어로 다시 부르기).`;
}

module.exports = { stripAllowed, isMostlyEnglish, turnTexts, verdict };

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    try {
      const h = JSON.parse(input || '{}');
      if (!h.transcript_path || !fs.existsSync(h.transcript_path)) return;
      const lines = fs.readFileSync(h.transcript_path, 'utf8').split('\n');
      const reason = verdict(lines, !!h.stop_hook_active);
      if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    } catch (e) {
      // 훅이 고장 나도 대화는 멈추지 않게 조용히 끝내요
    }
  });
}

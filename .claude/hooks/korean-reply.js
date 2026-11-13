// 파일 위치: .claude/hooks/korean-reply.js
// 역할: Claude 가 대답을 끝내기 직전(Stop 훅)에, 이번 턴에 사용자에게 보인 글이 영어 위주면 막고 한국어로 쓰게 해요
//   CLAUDE.md 6절 "답변은 한국어". 2026-11-14 긴 작업 끝 보고가 영어로 나가서 만든 장치예요
//   보는 것: 이번 턴의 Claude 글(text)과 wrap_up 의 요약 · 질문 · 버튼 글자, 훅 입력의 마지막 글
//   빼고 세는 것: 코드 블록, `코드`, 주소, 파일 경로 · 이름, snake_case · camelCase 낱말 (영어여도 괜찮은 것들)
//   마지막 보고(마지막 글 · wrap_up)가 영어면 → 한국어로 다시 쓰게
//   중간 안내 글만 영어면 → 보고를 반복하지 말고 요점만 한국어 한 줄로
//   한 턴에 한 번만 막아요: 다시 쓰는 중(stop_hook_active)이면 그냥 통과 (계속 막혀 헛돌지 않게)

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
    .replace(/\b[\w-]+\.(?:js|json|md|html|css|mjs|bat|txt|log|jpg|png|mp4|mov|heic)\b/gi, ' ') // 파일 이름
    .replace(/\b\w*(?:_\w*|[a-z][A-Z])\w*\b/g, ' '); // snake_case · camelCase 낱말 (코드 이름)
}

// 영어 위주인지: 낱말 수로 비교
//   영어 낱말(2글자 이상)이 6개 넘고, 한글이 든 낱말이 영어 낱말의 절반보다 적으면 영어 위주
//   (PR · CI · Stop 같은 영어 이름이 몇 개 섞인 한국어 글은 통과)
function isMostlyEnglish(text) {
  const t = stripAllowed(text);
  const en = (t.match(/\b[A-Za-z]{2,}\b/g) || []).length;
  const ko = (t.match(/\S*[가-힣]\S*/g) || []).length;
  return en > 6 && ko * 2 < en;
}

// 대화 기록(JSONL)에서 이번 턴에 Claude 가 사용자에게 보인 글 목록 → [{ text, wrap, final }]
//   final = 마지막 보고 (마지막 wrap_up 과 그 뒤 글, wrap_up 이 없으면 마지막 글)
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
  //   턴 중간에 끼는 시스템 줄(스킬 불러오기, 다른 세션 메시지 = isMeta)과 자동 요약(isCompactSummary)은 새 턴이 아니에요
  let start = 0;
  entries.forEach((e, i) => {
    if (e.type !== 'user' || !e.message || e.isMeta || e.isCompactSummary) return;
    const c = e.message.content;
    const isToolResult = Array.isArray(c) && c.length > 0 && c.every((b) => b && b.type === 'tool_result');
    if (!isToolResult) start = i + 1;
  });
  const out = [];
  for (const e of entries.slice(start)) {
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    for (const b of e.message.content) {
      if (b.type === 'text' && b.text) out.push({ text: b.text, wrap: false });
      if (b.type === 'tool_use' && /wrap_up$/.test(b.name || '') && b.input) {
        const parts = [b.input.recap, b.input.ask, ...((b.input.actions || []).map((a) => a && a.label))];
        out.push({ text: parts.filter(Boolean).join('\n'), wrap: true });
      }
    }
  }
  const lastWrap = out.map((x) => x.wrap).lastIndexOf(true);
  const finalFrom = lastWrap >= 0 ? lastWrap : out.length - 1;
  return out.map((x, i) => ({ ...x, final: i >= finalFrom }));
}

// 막을지 판단 → 막으면 이유 글, 아니면 null
//   lastMessage: 훅 입력의 마지막 글 (기록 파일에 아직 안 쓰였을 수 있어서 같이 봐요)
function verdict(lines, lastMessage) {
  const texts = turnTexts(lines);
  const tail = texts.length ? texts[texts.length - 1].text.trim() : '';
  if (lastMessage && String(lastMessage).trim() !== tail) {
    // 기록에 없던 마지막 글이 진짜 마지막 보고 (wrap_up 은 그대로 마지막 보고로 둬요)
    texts.forEach((x) => { if (!x.wrap) x.final = false; });
    texts.push({ text: String(lastMessage), wrap: false, final: true });
  }
  const bad = texts.filter((x) => isMostlyEnglish(x.text));
  if (!bad.length) return null;
  const last = bad[bad.length - 1];
  const sample = last.text.replace(/\s+/g, ' ').slice(0, 80);
  if (bad.some((x) => x.final)) {
    return `마지막 보고가 영어 위주예요 ("${sample}…"). CLAUDE.md 6절: 답변은 한국어. 변명 없이 같은 내용을 한국어로 다시 써 주세요 (wrap_up 을 썼다면 한국어로 다시 부르기).`;
  }
  return `중간 안내 글 ${bad.length}개가 영어였어요 ("${sample}…"). 보고는 다시 쓰지 말고, 그 안내의 요점만 한국어 한 줄로 알린 뒤 끝내세요. 다음부터 중간 글도 한국어로.`;
}

module.exports = { stripAllowed, isMostlyEnglish, turnTexts, verdict };

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8'); // 한글이 조각 경계에서 깨지지 않게
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    try {
      const h = JSON.parse(input || '{}');
      if (h.stop_hook_active) return; // 이미 한 번 막았어요 → 이번엔 통과 (한 턴에 한 번만)
      const lines = h.transcript_path && fs.existsSync(h.transcript_path) ? fs.readFileSync(h.transcript_path, 'utf8').split('\n') : [];
      if (!lines.length && !h.last_assistant_message) return;
      const reason = verdict(lines, h.last_assistant_message);
      if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
    } catch (e) {
      // 훅이 고장 나도 대화는 멈추지 않게 조용히 끝내요
    }
  });
}

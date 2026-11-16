// 파일 위치: src/similar-view.mjs
// 역할: "비슷한 사진" 화면의 계산 (React 없이 점검할 수 있게 따로 둬요. 점검 37)
//   표시: 묶음마다 처음에는 keepId 한 장만 "남김", 나머지는 "버림"
//     keepId = 추천 1장 (lib/similar.js pickBest, 까닭은 keepReason). 나머지는 처음엔 버림 (2026-11-16 사용자 결정: 정리의 목적은 버리기)
//     예외로 처음부터 "남김": 지문도 AI 특징값도 없는 사진(softIds), 전에 "모두 남기기"를 누른 사진(keptIds)
//   화면에 보인 묶음은 그 표시를 overrides(Map<id, 값>)에 적어 둬요 (pinMarks)
//     값: 'keep' · 'discard' = 사용자가 직접 고른 것 (누름 · 모두 남기기), 'auto-keep' · 'auto-discard' = 처음 표시를 적어 둔 것
//     → 사용자가 하나라도 고른 묶음은 목록을 다시 받아 keepId가 바뀌어도 본 표시가 그대로예요
//     → 아직 아무것도 안 고른 묶음은 지문 · 흐림 · AI 특징값이 뒤에서 만들어져 추천이 바뀌면 새 추천에 맞춰 다시 맞춰요
//       (2026-11-16 앱 확인: 그대로 두면 "추천" 사진이 "버림", 다른 사진이 "남김"으로 남아 헷갈림)
//     → 버릴 번호는 적어 둔 "버림"만 세요. 아직 화면에 안 보인 묶음의 사진은 버리지 않아요
//   묶음마다 적어도 한 장은 남아야 해요 (마지막 남김을 버림으로 바꾸려 하면 거절)

// 처음 표시 (사용자가 아직 안 바꾼 사진)
function firstMark(group, id) {
  if (id === group.keepId) return 'keep';
  if ((group.softIds || []).includes(id) || (group.keptIds || []).includes(id)) return 'keep';
  return 'discard';
}

// 적어 둔 값 → 'keep' | 'discard' | null
const valueOf = (o) => (o === 'keep' || o === 'auto-keep' ? 'keep' : o === 'discard' || o === 'auto-discard' ? 'discard' : null);
// 사용자가 직접 고른 값인지
const chosen = (o) => o === 'keep' || o === 'discard';

// 사진 한 장의 표시
export function markOf(group, id, overrides) {
  return valueOf(overrides && overrides.get(id)) || firstMark(group, id);
}

// 표시 바꾸기 → { overrides: 새 Map, refused: 거절했으면 true }
export function toggleMark(group, id, overrides) {
  const next = new Map(overrides || []);
  const now = markOf(group, id, overrides);
  if (now === 'keep') {
    const keeps = group.ids.filter((x) => markOf(group, x, overrides) === 'keep');
    if (keeps.length <= 1) return { overrides: overrides || new Map(), refused: true };
  }
  next.set(id, now === 'keep' ? 'discard' : 'keep');
  return { overrides: next, refused: false };
}

// 이 묶음은 모두 남기기
export function keepAll(group, overrides) {
  const next = new Map(overrides || []);
  for (const id of group.ids) next.set(id, 'keep');
  return next;
}

// 화면에 보인 묶음의 표시를 적어 둬요 (바뀐 것이 없으면 같은 Map을 그대로 돌려줘요)
//   처음 보이는 사진: keepId(와 softIds, keptIds)만 남김, 나머지 버림
//   이미 본 묶음에 새로 들어온 사진도 같은 규칙이에요 (2026-11-16 사용자 지적: 처음엔 추천 1장만 남김, 남길 사진만 눌러 바꿈)
//     AI 특징값 · 지문이 뒤에서 만들어지며 묶음이 커져도 새 사진이 모두 "남김"으로 쌓이지 않게
//   사용자가 아무것도 안 고른 묶음은 지금 추천에 맞춰 다시 맞춰요. 하나라도 고른 묶음은 적어 둔 표시 그대로
//   다시 묶이며 한 묶음이 모두 버림이 되면 그 묶음은 옮기지 않아요 (discardIds, main 도 다시 확인)
export function pinMarks(groups, overrides) {
  let next = null;
  const put = (id, v) => {
    if (!next) next = new Map(overrides || []);
    next.set(id, v);
  };
  for (const g of groups || []) {
    const touched = g.ids.some((id) => chosen(overrides && overrides.get(id)));
    for (const id of g.ids) {
      const cur = overrides && overrides.get(id);
      if (touched && cur !== undefined) continue;
      const want = `auto-${firstMark(g, id)}`;
      if (cur !== want) put(id, want);
    }
  }
  return next || overrides || new Map();
}

// 버릴 사진 번호들: 적어 둔 "버림"만 (pinMarks로 화면에 보인 묶음). 혹시 한 묶음이 전부 버림이면 그 묶음은 빼요 (main도 다시 확인해요)
export function discardIds(groups, overrides) {
  const out = [];
  for (const g of groups || []) {
    const gone = g.ids.filter((id) => overrides && valueOf(overrides.get(id)) === 'discard');
    if (gone.length === g.ids.length) continue;
    out.push(...gone);
  }
  return out;
}

// 이 묶음만 지금 옮기기: 이 묶음에서 고정된 "버림"만 (모두 버림이면 빈 목록. main도 다시 확인해요)
export function groupDiscardIds(group, overrides) {
  return discardIds([group], overrides);
}

// 이 묶음만 옮기는 버튼 글자 (확인 창에서 어디로 가는지 다시 보여 줘요)
export function groupReviewLabel(n) {
  return n > 0 ? `이 묶음에서 버릴 ${count(n)}장 옮기기` : '';
}

// 묶음 제목 옆 설명: 이어 찍기로만 묶인 묶음 (AI 로 같은 장면을 확인했을 때만 생겨요)
export function groupNote(group) {
  if (!group || !group.timeOnly) return '';
  return group.aiChecked ? 'AI 로 같은 장면을 확인한, 1분 안에 이어 찍은 사진' : '1분 안에 이어 찍은 사진';
}

// 추천 까닭 한 줄 (묶음 제목 아래)
export function recommendText(group) {
  if (!group || !group.keepReason) return '';
  return `추천 1장: ${group.keepReason}. 나머지를 버릴지, 다른 사진을 남길지, 여러 장 남길지 골라 주세요.`;
}

// ---------- PC 안 AI 비교 (④) ----------
const mb = (n) => Math.round(Number(n || 0) / 1e6).toLocaleString('ko-KR');

// AI 상태 한 줄 → { text, sub, button } (button 이 있으면 누르면 확인 창이 떠요). 다 끝났으면 text ''
//   모델이 없으면 이어 찍기(1분) 묶음을 만들지 않아서, 받으면 무엇이 달라지는지 화면 맨 위에 알려요 (2026-11-16 사용자 지적)
export function aiLine(s) {
  if (!s) return { text: '', sub: '', button: '' };
  if (s.model === 'downloading') return { text: `AI 모델 받는 중 ${mb(s.got)} / ${mb(s.bytes)}MB`, sub: '', button: '' };
  if (s.model !== 'ready') {
    const head = `AI 비교(${mb(s.bytes)}MB)를 받으면 1분 안에 이어 찍은 사진도 장면별로 묶어요.`;
    const sub = '지금은 3초 안에 이어 찍었거나 모양이 거의 같은 사진만 묶어요. 모델 파일은 한 번만 받고, 사진은 보내지 않아요.';
    return { text: s.error ? `${s.error} ${head}` : head, sub, button: `AI 모델 ${mb(s.bytes)}MB 받기` };
  }
  if (s.error) return { text: s.error, sub: '', button: '' };
  if (!s.total || s.done >= s.total) return { text: '', sub: '', button: '' };
  if (s.waiting) return { text: `AI 특징값 ${count(s.done)} / ${count(s.total)}장. 가져오기가 끝나면 이어서 만들어요.`, sub: '', button: '' };
  return { text: `AI 특징값 만드는 중 ${count(s.done)} / ${count(s.total)}장. 끝나면 묶음이 바뀔 수 있어요.`, sub: '', button: '' };
}

// 모델 받기 확인 창 글
export function aiConfirmLines(s) {
  const size = mb(s && s.bytes);
  return [
    `huggingface.co 에서 CLIP 이미지 모델 파일(${size}MB, MIT 라이선스)을 한 번 받아요.`,
    '받은 파일은 이 PC 의 설정 폴더(models)에 두고, 원래 파일과 같은지 확인한 뒤에 써요.',
    '사진, 파일 이름, 폴더 경로는 보내지 않아요. 받은 뒤에는 인터넷 없이 이 PC 안에서만 사진을 비교해요.',
    '사진 5.5만 장이면 처음 한 번 약 1시간 동안 뒤에서 만들어요 (가져오기 중에는 쉬어요).',
  ];
}

export function aiConfirmLabel(s) {
  return `${mb(s && s.bytes)}MB 받기`;
}


// 목록을 다시 받았을 때: 지금 목록에 없는 사진의 기록은 지워요
export function pruneOverrides(groups, overrides) {
  const alive = new Set();
  for (const g of groups || []) for (const id of g.ids) alive.add(id);
  const next = new Map();
  for (const [id, v] of overrides || []) if (alive.has(id)) next.set(id, v);
  return next;
}

const count = (n) => Number(n || 0).toLocaleString('ko-KR');

// 아래쪽 버튼: 고른 수를 보여 주고 누르면 확인 창이 떠요
export function reviewLabel(n) {
  return n > 0 ? `버릴 사진 ${count(n)}장 확인하기` : '버릴 사진이 없어요';
}

// 확인 창의 실행 버튼: 어디로 가는지 말해요
export function discardLabel(info) {
  if (!info || !info.count) return '';
  if (info.move === 0) return `${count(info.count)}장 휴지통으로 옮기기`;
  if (info.trash === 0) return `${count(info.count)}장 정리완료원본 폴더로 옮기기`;
  return `${count(info.count)}장 옮기기`;
}

// 확인 창 설명
export function previewLines(info) {
  if (!info || !info.count) return [];
  const lines = [`묶음 ${count(info.groups)}개에서 ${count(info.count)}장을 옮겨요.`];
  if (info.trash > 0) lines.push(`휴지통으로 ${count(info.trash)}장`);
  if (info.move > 0) lines.push(`휴지통이 없는 드라이브라 백업 폴더 안 _정리완료원본 폴더로 ${count(info.move)}장 (갤러리에는 안 보이고, 지우는 것은 직접 확인한 뒤에 해 주세요)`);
  if (info.pairs > 0) lines.push(`라이브 포토의 짝 영상 ${count(info.pairs)}개도 사진과 같은 곳으로 옮겨요`);
  for (const w of info.warnings || []) lines.push(`주의: ${w}`);
  return lines;
}

// 끝난 뒤 알림 한 줄
export function resultText(r) {
  if (!r) return '';
  const parts = [];
  if (r.trashed) parts.push(`휴지통으로 ${count(r.trashed)}장`);
  if (r.moved) parts.push(`_정리완료원본 폴더로 ${count(r.moved)}장`);
  let text = parts.length ? `${parts.join(', ')} 옮겼어요.` : '옮긴 사진이 없어요.';
  if (r.pairs) text += ` 라이브 포토의 짝 영상 ${count(r.pairs)}개도 같이 옮겼어요.`;
  if (r.fail) text += ` ${count(r.fail)}장은 옮기지 못했어요${r.logName ? ` (로그 ${r.logName})` : ''}.`;
  if (r.pairFail) text += ` 짝 영상 ${count(r.pairFail)}개는 옮기지 못했어요${r.logName ? ` (로그 ${r.logName})` : ''}.`;
  if (r.logFail) text += ` 로그에 ${count(r.logFail)}줄을 적지 못했어요 (디스크 공간을 확인해 주세요).`;
  return text;
}

// 지문 진행 글
export function progressText(p) {
  if (!p || !p.total) return '';
  if (p.done >= p.total) return '';
  if (p.waiting) return `사진 지문 ${count(p.done)} / ${count(p.total)}장. 가져오기가 끝나면 이어서 만들어요.`;
  return `사진 지문 만드는 중 ${count(p.done)} / ${count(p.total)}장. 끝나면 묶음이 더 생길 수 있어요.`;
}

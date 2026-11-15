// 파일 위치: src/similar-view.mjs
// 역할: "비슷한 사진" 화면의 계산 (React 없이 점검할 수 있게 따로 둬요. 점검 37)
//   표시: 묶음마다 처음에는 keepId 한 장만 "남김", 나머지는 "버림"
//     예외로 처음부터 "남김": 지문 없이 시간만으로 들어온 사진과 60초 이어 찍기로 들어온 사진(softIds), 전에 "모두 남기기"를 누른 사진(keptIds)
//     이어 찍기로만 묶인 묶음(timeOnly)은 모든 사진이 softIds 라 처음엔 모두 남김이에요 (2026-11-16 사용자 결정)
//   화면에 보인 묶음은 그 표시를 overrides(Map<id, 'keep'|'discard'>)에 고정해요 (pinMarks)
//     → 목록을 다시 받아 keepId가 바뀌어도 사용자가 본 표시는 그대로예요
//     → 버릴 번호는 고정된 "버림"만 세요. 아직 화면에 안 보인 묶음의 사진은 버리지 않아요
//   묶음마다 적어도 한 장은 남아야 해요 (마지막 남김을 버림으로 바꾸려 하면 거절)

// 처음 표시 (사용자가 아직 안 바꾼 사진)
function firstMark(group, id) {
  if (id === group.keepId) return 'keep';
  if ((group.softIds || []).includes(id) || (group.keptIds || []).includes(id)) return 'keep';
  return 'discard';
}

// 사진 한 장의 표시
export function markOf(group, id, overrides) {
  const o = overrides && overrides.get(id);
  if (o === 'keep' || o === 'discard') return o;
  return firstMark(group, id);
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

// 화면에 보인 묶음의 표시를 고정해요 (바뀐 것이 없으면 같은 Map을 그대로 돌려줘요)
//   처음 보이는 묶음: keepId(와 softIds, keptIds)만 남김, 나머지 버림
//   이미 본 묶음에 새로 들어온 사진: 남김 (사용자가 버림을 고르기 전에는 버리지 않아요)
export function pinMarks(groups, overrides) {
  let next = null;
  const put = (id, v) => {
    if (!next) next = new Map(overrides || []);
    next.set(id, v);
  };
  for (const g of groups || []) {
    const seen = g.ids.some((id) => overrides && overrides.has(id));
    for (const id of g.ids) {
      if (overrides && overrides.has(id)) continue;
      put(id, seen ? 'keep' : firstMark(g, id));
    }
  }
  return next || overrides || new Map();
}

// 버릴 사진 번호들: 고정된 "버림"만 (pinMarks로 화면에 보인 묶음). 혹시 한 묶음이 전부 버림이면 그 묶음은 빼요 (main도 다시 확인해요)
export function discardIds(groups, overrides) {
  const out = [];
  for (const g of groups || []) {
    const gone = g.ids.filter((id) => overrides && overrides.get(id) === 'discard');
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

// 묶음 제목 옆 설명: 이어 찍기로만 묶인 묶음은 처음엔 모두 남김이라고 알려요
export function groupNote(group) {
  if (!group || !group.timeOnly) return '';
  return group.aiChecked ? 'AI 로 같은 장면을 확인한 이어 찍은 사진이라 처음엔 모두 남김' : '이어 찍은 사진이라 처음엔 모두 남김';
}

// ---------- PC 안 AI 비교 (④) ----------
const mb = (n) => Math.round(Number(n || 0) / 1e6).toLocaleString('ko-KR');

// AI 상태 한 줄 → { text, button } (button 이 있으면 누르면 확인 창이 떠요). 다 끝났으면 text ''
export function aiLine(s) {
  if (!s) return { text: '', button: '' };
  if (s.model === 'downloading') return { text: `AI 모델 받는 중 ${mb(s.got)} / ${mb(s.bytes)}MB`, button: '' };
  if (s.model !== 'ready') {
    const head = 'AI 로 같은 장면을 더 잘 가릴 수 있어요. 모델 파일을 한 번 받아야 해요.';
    return { text: s.error ? `${s.error} ${head}` : head, button: `AI 모델 ${mb(s.bytes)}MB 받기` };
  }
  if (s.error) return { text: s.error, button: '' };
  if (!s.total || s.done >= s.total) return { text: '', button: '' };
  if (s.waiting) return { text: `AI 특징값 ${count(s.done)} / ${count(s.total)}장. 가져오기가 끝나면 이어서 만들어요.`, button: '' };
  return { text: `AI 특징값 만드는 중 ${count(s.done)} / ${count(s.total)}장. 끝나면 묶음이 바뀔 수 있어요.`, button: '' };
}

// 모델 받기 확인 창 글
export function aiConfirmLines(s) {
  const size = mb(s && s.bytes);
  return [
    `huggingface.co 에서 CLIP 이미지 모델 파일(${size}MB, MIT 라이선스)을 한 번 받아요.`,
    '받은 파일은 이 PC 의 설정 폴더(models)에 두고, 원래 파일과 같은지 확인한 뒤에 써요.',
    '사진 · 파일 이름 · 폴더 경로는 보내지 않아요. 받은 뒤에는 인터넷 없이 이 PC 안에서만 사진을 비교해요.',
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

// 파일 위치: src/trash-view.mjs
// 역할: 갤러리에서 고른 사진을 휴지통으로 옮기는 확인 창의 글 (2026-11-16 사용자 결정)
//   화면(React)과 떼어 놓아서 점검(scripts/check-gallery-trash.js)이 바로 부를 수 있어요
//   옮기는 방법은 비슷한 사진 버리기와 같아서, 끝난 뒤 알림은 similar-view.mjs 의 resultText 를 같이 써요

const count = (n) => Number(n || 0).toLocaleString('ko-KR');

// 확인 창 버튼: 결과를 말해요 ("3장 휴지통으로 옮기기")
export function trashLabel(info) {
  if (!info || !info.count) return '';
  if (info.move === 0) return `${count(info.count)}장 휴지통으로 옮기기`;
  if (info.trash === 0) return `${count(info.count)}장 정리완료원본 폴더로 옮기기`;
  return `${count(info.count)}장 옮기기`;
}

// 확인 창 설명 줄
export function trashLines(info) {
  if (!info || !info.count) return [];
  const lines = [`고른 ${count(info.count)}장을 옮겨요.`];
  if (info.trash > 0) lines.push(`휴지통으로 ${count(info.trash)}장`);
  if (info.move > 0) lines.push(`휴지통이 없는 드라이브라 백업 폴더 안 _정리완료원본 폴더로 ${count(info.move)}장 (갤러리에는 안 보이고, 지우는 것은 직접 확인한 뒤에 해 주세요)`);
  if (info.pairs > 0) lines.push(`라이브 포토의 짝 영상 ${count(info.pairs)}개도 사진과 같은 곳으로 옮겨요`);
  for (const w of info.warnings || []) lines.push(`주의: ${w}`);
  return lines;
}

// 확인 창 아래 안내 한 줄: 어디서 되살릴 수 있는지 사실대로 (#119 검증 ⚠️)
//   휴지통 용량 주의가 있으면 휴지통에서 다 되살릴 수 없을 수 있어서 위의 주의를 먼저 보라고 해요
export function trashHint(info) {
  if (!info || !info.count) return '';
  if ((info.warnings || []).length) return '사진 파일은 지우지 않아요. 위의 주의를 먼저 확인해 주세요.';
  if (info.trash === 0) return '사진 파일은 지우지 않아요. _정리완료원본 폴더에서 되돌릴 수 있어요.';
  if (info.move > 0) return '사진 파일은 지우지 않아요. 휴지통이나 _정리완료원본 폴더에서 되돌릴 수 있어요.';
  return '사진 파일은 지우지 않아요. 휴지통에서 되살릴 수 있어요.';
}

// 메뉴 · 패널 버튼 글자
export function trashMenuLabel(n) {
  return `${count(n)}장 휴지통으로 옮기기`;
}

// 날짜 칸 링크: "이 날 4장 휴지통으로" (2026-11-21 사용자 요청. 누르면 확인 창이 열려요, 끝에 → 를 붙이지 않아요)
export function dayTrashLabel(n) {
  return `이 날 ${count(n)}장 휴지통으로`;
}

// Delete 키로 창을 열어도 되는지: 글 쓰는 칸에 있거나 다른 창이 열려 있으면 안 열어요
//   target: 키를 누른 곳 (document.activeElement), open: 다른 창이 열려 있는지
export function deleteKeyOpens(key, target, open) {
  if (key !== 'Delete') return false;
  if (open) return false;
  const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if (target && target.isContentEditable) return false;
  return true;
}

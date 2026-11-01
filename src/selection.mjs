// 파일 위치: src/selection.mjs
// 역할: 여러 장 선택 계산 (React 없이 값만 다뤄요. 그래서 점검 25번에서도 바로 불러 확인해요)
//   sel = { ids: Set<파일 번호>, anchor, focus }
//     anchor = Shift+클릭 범위의 시작이 되는 칸, focus = 오른쪽 패널에 자세히 보여 줄 칸 (없으면 null)
//   받은 sel은 절대 바꾸지 않고, 바뀐 새 sel을 돌려줘요 (React가 바뀐 줄 알아채게)
//   nextSelection(sel, { id, ctrl, shift, dayFiles }) → 칸을 클릭했을 때의 새 선택
//   selectionOf(ids)               → 목록 전체 / 이 날 모두 선택처럼 한꺼번에 고른 선택
//   selectionForMenu(sel, id)      → 우클릭한 칸이 선택 밖이면 그 칸만 고른 선택

export const EMPTY_SELECTION = Object.freeze({ ids: new Set(), anchor: null, focus: null });

const idOf = (f) => (f !== null && typeof f === 'object' ? f.id : f);

// 그 칸 한 장만 고른 선택
function only(id) {
  return { ids: new Set([id]), anchor: id, focus: id };
}

// dayFiles(그 날의 파일 목록)에서 anchor와 id 사이(양 끝 포함)의 번호들. anchor가 그 날에 없으면 null
function rangeIds(anchor, id, dayFiles) {
  if (anchor === null || !Array.isArray(dayFiles)) return null;
  const ids = dayFiles.map(idOf);
  const from = ids.indexOf(anchor);
  const to = ids.indexOf(id);
  if (from < 0 || to < 0) return null;
  return ids.slice(Math.min(from, to), Math.max(from, to) + 1);
}

export function nextSelection(sel, { id, ctrl = false, shift = false, dayFiles } = {}) {
  const cur = sel || EMPTY_SELECTION;
  if (shift) {
    // Shift+클릭: 같은 날 안에서 anchor부터 누른 칸까지. anchor가 없거나 다른 날이면 그 칸 한 장
    const range = rangeIds(cur.anchor, id, dayFiles);
    if (!range) return only(id);
    const ids = ctrl ? new Set([...cur.ids, ...range]) : new Set(range); // Ctrl도 함께 누르면 기존 선택에 더해요
    return { ids, anchor: cur.anchor, focus: id };
  }
  if (ctrl) {
    // Ctrl+클릭: 없으면 더하고, 있으면 빼요
    const ids = new Set(cur.ids);
    if (!ids.delete(id)) {
      ids.add(id);
      return { ids, anchor: id, focus: id };
    }
    // 뺀 칸이 focus였으면 남은 것 중 마지막 칸으로 (다 비면 null)
    const left = [...ids];
    const focus = cur.focus !== id ? cur.focus : left.length ? left[left.length - 1] : null;
    return { ids, anchor: id, focus };
  }
  return only(id);
}

// 한꺼번에 고른 선택: 어느 한 칸이 기준이 아니라서 anchor, focus는 없어요
export function selectionOf(ids) {
  return { ids: new Set(ids), anchor: null, focus: null };
}

// 우클릭: 이미 고른 칸이면 선택을 그대로 두고, 선택 밖의 칸이면 그 칸만 골라요
export function selectionForMenu(sel, id) {
  return sel && sel.ids.has(id) ? sel : only(id);
}

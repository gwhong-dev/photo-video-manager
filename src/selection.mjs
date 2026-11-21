// 파일 위치: src/selection.mjs
// 역할: 여러 장 선택 계산 (React 없이 값만 다뤄요. 그래서 점검 25번에서도 바로 불러 확인해요)
//   sel = { ids: Set<파일 번호>, anchor, focus }
//     anchor = Shift+클릭 범위의 시작이 되는 칸, focus = 오른쪽 패널에 자세히 보여 줄 칸 (없으면 null)
//   받은 sel은 절대 바꾸지 않고, 바뀐 새 sel을 돌려줘요 (React가 바뀐 줄 알아채게)
//   nextSelection(sel, { id, ctrl, shift, dayFiles }) → 칸을 클릭했을 때의 새 선택
//     dayFiles = Shift 범위를 셀 목록 (화면 순서). 보통은 그 날의 파일, 날을 넘는 범위면 목록 전체 번호(listIds)
//   needsWholeList(sel, { shift, dayFiles }) → Shift 범위가 다른 날로 넘어가서 목록 전체 번호가 필요한지
//   selectionOf(ids)               → 목록 전체 / 이 날 모두 선택처럼 한꺼번에 고른 선택
//   selectionForMenu(sel, id)      → 우클릭한 칸이 선택 밖이면 그 칸만 고른 선택
//   filterScope(filter)            → 선택을 비워야 하는 기준이 같은지 비교하는 글자 (정렬은 빼요)
//   viewMatches(view, filter)      → 화면에 보이는 목록이 지금 필터의 목록인지

export const EMPTY_SELECTION = Object.freeze({ ids: new Set(), anchor: null, focus: null });

const idOf = (f) => (f !== null && typeof f === 'object' ? f.id : f);

// 그 칸 한 장만 고른 선택
function only(id) {
  return { ids: new Set([id]), anchor: id, focus: id };
}

// dayFiles(그 날의 파일 목록, 또는 목록 전체 번호)에서 anchor와 id 사이(양 끝 포함)의 번호들. anchor가 그 목록에 없으면 null
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
    // Shift+클릭: anchor부터 누른 칸까지 (다른 날이면 App 이 목록 전체 번호를 dayFiles 로 넘겨요). anchor가 없거나 목록에 없으면 그 칸 한 장
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

// Shift+클릭인데 anchor 가 그 날 목록에 없으면(다른 날을 먼저 골랐으면) 목록 전체 번호가 있어야 범위를 셀 수 있어요
//   (윈도우 탐색기처럼 날을 넘어 범위를 고르게. 2026-11-21 사용자 지적 "쉬프트 범위 선택이 안 됨")
export function needsWholeList(sel, { shift = false, dayFiles } = {}) {
  if (!shift || !sel || sel.anchor === null || sel.anchor === undefined) return false;
  if (!Array.isArray(dayFiles)) return true;
  return !dayFiles.some((f) => idOf(f) === sel.anchor);
}

// 한꺼번에 고른 선택: 어느 한 칸이 기준이 아니라서 anchor, focus는 없어요
export function selectionOf(ids) {
  return { ids: new Set(ids), anchor: null, focus: null };
}

// 우클릭: 이미 고른 칸이면 선택을 그대로 두고, 선택 밖의 칸이면 그 칸만 골라요
export function selectionForMenu(sel, id) {
  return sel && sel.ids.has(id) ? sel : only(id);
}

// 선택이 "같은 사진들"인지 가르는 기준: 종류 탭, 정보 없음 탭(있으면 정보 없는 사진 화면), 검색어, 태그, 지도에서 고른 곳. 정렬은 같은 사진들이라 뺐어요
export function filterScope(filter) {
  const f = filter || {};
  return [f.tab || 'all', f.info || '', f.query || '', f.tag || '', f.area ? JSON.stringify(f.area) : ''].join('|');
}

// 필터를 바꾸면 새 목록이 올 때까지 옛 목록이 잠깐 화면에 남아요. 그 사이에는 고르기를 받지 않아요
//   (옛 목록의 번호가 새 필터의 선택에 섞여 보지 못한 사진에 값이 들어가는 일을 막으려고)
export function viewMatches(view, filter) {
  return !!view && filterScope(view.filter) === filterScope(filter);
}

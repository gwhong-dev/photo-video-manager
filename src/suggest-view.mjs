// 파일 위치: src/suggest-view.mjs
// 역할: 위치 제안 화면에서 "어느 묶음을 보여 줄지, 어느 사진을 넣기에서 뺐는지" 계산. React 없이 값만 다뤄서 점검에서도 불러 확인해요

// 묶음 이름표: 같은 날 같은 근거 사진이면 같은 묶음이에요
export const groupKey = (group) => `${group.day}:${group.source.id}`;

// 빠른 두 번 누름의 뒤쪽인지 (detail = 연달아 누른 횟수, 키보드로 누르면 0).
//   넣기가 금방 끝나면 같은 자리 버튼이 다음 묶음의 버튼이 돼요. 보지 않은 묶음에 값이 들어가지 않게 받지 않아요
export const isRepeatClick = (event) => event.detail > 1;

// 목록을 새로 받은 뒤 보여 줄 것을 정해요
//   current: { key, unchecked } 지금 보던 묶음과 넣기에서 뺀 사진 번호들 (없으면 null)
//   보던 묶음이 남아 있으면 그대로 두고 사라진 번호만 지워요. 없어졌으면 첫 묶음을 처음 상태로. 묶음이 없으면 null
export function settleView(groups, current) {
  if (!groups.length) return null;
  const same = current ? groups.find((g) => groupKey(g) === current.key) : null;
  if (!same) return { key: groupKey(groups[0]), unchecked: new Set() };
  const ids = new Set(same.targets.map((t) => t.id));
  return { key: current.key, unchecked: new Set([...current.unchecked].filter((id) => ids.has(id))) };
}

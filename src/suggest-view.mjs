// 파일 위치: src/suggest-view.mjs
// 역할: 위치 제안 화면에서 "어느 묶음을 보여 줄지, 어느 사진을 넣기에서 뺐는지" 계산. React 없이 값만 다뤄서 점검에서도 불러 확인해요

// 묶음 이름표: 같은 날 같은 근거 사진이면 같은 묶음이에요
export const groupKey = (group) => `${group.day}:${group.source.id}`;

// 빠른 두 번 누름의 뒤쪽인지 (detail = 연달아 누른 횟수, 키보드로 누르면 0).
//   넣기가 금방 끝나면 같은 자리 버튼이 다음 묶음의 버튼이 돼요. 보지 않은 묶음에 값이 들어가지 않게 받지 않아요
export const isRepeatClick = (event) => event.detail > 1;

// 체크 상태는 "처음 상태에서 사람이 바꾼 사진 번호(flipped)"로 기억해요 (설계서 12절)
//   처음 상태: 기기 정보 있는 사진은 체크, 기기 정보 없는 사진(noDevice)은 꺼짐
//   이렇게 하면 같은 묶음에 사진이 새로 생겨도 그 사진은 자동으로 처음 상태가 돼요
export const isChecked = (target, flipped) => !target.noDevice !== flipped.has(target.id);

// 넣을 사진 번호들
export const checkedIds = (group, flipped) => group.targets.filter((t) => isChecked(t, flipped)).map((t) => t.id);

// 건너뛴 사진으로 기억할 번호들: 기기 정보 있는 사진 중 사람이 끈 것만.
//   처음부터 꺼져 있던 사진(기기 정보 없음)은 기억하지 않아요. 섞인 묶음에서 보지도 않은 사진이 사라지지 않게
export const rememberIds = (group, flipped) => group.targets.filter((t) => !t.noDevice && flipped.has(t.id)).map((t) => t.id);

// 모두 체크한 상태의 flipped: 처음에 꺼져 있던 사진(기기 정보 없음)만 바꾼 것
export const checkAll = (group) => new Set(group.targets.filter((t) => t.noDevice).map((t) => t.id));

// 넣기가 끝난 뒤의 마무리: 건너뛴 사진 저장이 거절돼도 값은 이미 들어갔으니, 되돌리기 줄이 나오게 finish까지 꼭 불러요
//   오류는 finish 뒤에 알려요. finish가 띄우는 안내("바꿀 사진이 없어서")가 오류를 덮지 않게
export async function finishApply(left, skip, onSkipError, finish) {
  let failed = null;
  if (left.length) {
    try {
      await skip(left);
    } catch (e) {
      failed = e;
    }
  }
  await finish();
  if (failed) onSkipError(failed);
}

// 목록을 새로 받은 뒤 보여 줄 것을 정해요
//   current: { key, flipped, ids } 지금 보던 묶음, 처음 상태에서 바꾼 사진 번호들, 보이던 사진 번호들 (없으면 null. ids는 없어도 돼요)
//   보던 묶음이 남아 있으면 그대로 두고 사라진 번호만 지워요
//   묶음 이름표가 바뀌었어도(다시 읽기로 근거 사진이 다른 사진으로 바뀜) 보던 사진이 가장 많이 든 묶음이 있으면 거기 머물러요.
//   그래야 사람이 끈 체크가 풀리지 않아요. 보던 사진이 든 묶음이 하나도 없으면 첫 묶음을 처음 상태로. 묶음이 없으면 null
export function settleView(groups, current) {
  if (!groups.length) return null;
  const same = current ? groups.find((g) => groupKey(g) === current.key) || mostOverlapping(groups, current) : null;
  if (!same) return { key: groupKey(groups[0]), flipped: new Set() };
  const ids = new Set(same.targets.map((t) => t.id));
  return { key: groupKey(same), flipped: new Set([...current.flipped].filter((id) => ids.has(id))) };
}

// 보던 사진(ids와 flipped)이 가장 많이 든 묶음. 하나도 겹치지 않으면 null
function mostOverlapping(groups, current) {
  const seen = new Set([...(current.ids || []), ...current.flipped]);
  let best = null;
  let bestCount = 0;
  for (const g of groups) {
    const count = g.targets.filter((t) => seen.has(t.id)).length;
    if (count > bestCount) {
      best = g;
      bestCount = count;
    }
  }
  return best;
}

// 목록 응답을 받는 순서 정리. 요청마다 번호를 매기고(next), 응답이 오면 받을지 정해요(accept)
//   받는 기준은 "마지막으로 보낸 요청인지"가 아니라 "지금 화면에 있는 것보다 새 응답인지"예요.
//   느린 PC에서 폴더를 읽는 동안에는 응답이 오기 전에 새 요청이 또 나가요. 마지막 요청만 받으면 모든 응답이 버려져
//   화면이 계속 "계산하는 중"에 머물러요. 늦게 온 옛 응답(더 새 응답이 이미 화면에 있음)만 버려요
//   markApplied: 넣기가 끝난 시점. 그 뒤에 보낸 요청의 응답에만 "넣은 뒤" 보기 규칙(맨 앞 묶음)을 써요 (afterApply가 한 번만 참)
export function createLoadOrder() {
  let sent = 0;
  let shown = 0;
  let appliedAt = null;
  return {
    next: () => ++sent,
    accept(ticket) {
      if (ticket <= shown) return false;
      shown = ticket;
      return true;
    },
    markApplied: () => { appliedAt = sent; },
    afterApply(ticket) {
      if (appliedAt === null || ticket <= appliedAt) return false;
      appliedAt = null;
      return true;
    },
  };
}

// 넣기가 끝나고 목록을 새로 받은 뒤 보여 줄 것: 보던 묶음이 남아 있어도 맨 앞 묶음을 처음 상태로 보여 줘요
//   섞인 묶음은 넣은 뒤 기기 정보 없는 사진만 남는데, 거기 머물면 기기 정보 있는 다음 묶음이 뒤로 밀리고
//   체크 0장 화면에서 건너뛰기를 누르게 돼서 처음부터 꺼져 있던 사진이 건너뛴 목록으로 사라져요
export const viewAfterApply = (groups, _current) => settleView(groups, null);

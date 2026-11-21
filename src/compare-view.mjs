// 파일 위치: src/compare-view.mjs
// 역할: "비슷한 사진" 비교 창의 계산 (React 없이 점검할 수 있게 따로 둬요. 점검 64)
//   2026-11-21 사용자 요청: 묶음 사진을 크게 보며 ←/→ 로 넘기다가, 가장 좋은 사진을 Space 로 고정하면 왼쪽에 고정되고,
//   오른쪽에서 나머지를 넘기며 ↑ = 버림, ↓ = 남김. 두 사진은 같은 자리 · 같은 배율로 같이 확대돼요
//
// 보기 상태 view = { z, fx, fy }
//   z: 화면 맞춤 대비 배율 (1 = 칸에 맞춤), fx · fy: 칸 가운데에 오는 사진 자리 (0~1, 사진 너비 · 높이에 대한 비율)
//   두 칸이 같은 view 를 써서 같은 자리를 같은 배율로 보여 줘요 (사진 크기가 달라도 비율로 맞춰요)

export const MAX_ZOOM_PX = 4; // 원본 1픽셀이 화면 4픽셀이 될 때까지만 확대
export const FIT_VIEW = Object.freeze({ z: 1, fx: 0.5, fy: 0.5 });

// 칸에 맞추는 배율 (사진 1픽셀 → 화면 몇 픽셀)
export function fitScale(nat, box) {
  if (!nat || !box || !nat.w || !nat.h || !box.w || !box.h) return 1;
  return Math.min(box.w / nat.w, box.h / nat.h);
}

// 화면에 그릴 자리 → { w, h, left, top } (칸 안의 픽셀)
export function layoutOf(nat, box, view) {
  const v = view || FIT_VIEW;
  const s = fitScale(nat, box) * v.z;
  const w = (nat && nat.w ? nat.w : 0) * s;
  const h = (nat && nat.h ? nat.h : 0) * s;
  return { w, h, left: box.w / 2 - v.fx * w, top: box.h / 2 - v.fy * h };
}

// 배율이 칸 맞춤(1)보다 작아지거나 원본 4배를 넘지 않게, 맞춤일 때는 가운데로
export function clampView(view, nat, box) {
  const maxZ = Math.max(1, (MAX_ZOOM_PX / fitScale(nat, box)) || 1);
  const z = Math.min(maxZ, Math.max(1, Number(view.z) || 1));
  if (z === 1) return { ...FIT_VIEW };
  // 사진 밖 빈 곳이 가운데로 오지 않게 (가운데 자리는 0~1 안)
  const fx = Math.min(1, Math.max(0, Number(view.fx)));
  const fy = Math.min(1, Math.max(0, Number(view.fy)));
  return { z, fx: Number.isFinite(fx) ? fx : 0.5, fy: Number.isFinite(fy) ? fy : 0.5 };
}

// 마우스 자리(칸 안 픽셀 point)를 그대로 두고 factor 배 확대 · 축소 (휠)
export function zoomAt(view, nat, box, point, factor) {
  const before = layoutOf(nat, box, view);
  if (!before.w || !before.h) return view;
  // 마우스 아래 사진 자리 (비율)
  const px = (point.x - before.left) / before.w;
  const py = (point.y - before.top) / before.h;
  const z = view.z * factor;
  const s = fitScale(nat, box) * z;
  const w = nat.w * s;
  const h = nat.h * s;
  // 그 자리가 다시 마우스 아래 오게 가운데 자리를 옮겨요
  const fx = (box.w / 2 - (point.x - px * w)) / w;
  const fy = (box.h / 2 - (point.y - py * h)) / h;
  return clampView({ z, fx, fy }, nat, box);
}

// 끌어서 옮기기 (dx · dy 화면 픽셀)
export function panBy(view, nat, box, dx, dy) {
  const l = layoutOf(nat, box, view);
  if (!l.w || !l.h) return view;
  return clampView({ z: view.z, fx: view.fx - dx / l.w, fy: view.fy - dy / l.h }, nat, box);
}

// 맞춤 ↔ 원본 크기(100%) 바꾸기 (더블클릭). 원본 크기로 갈 때는 point 자리를 크게
export function toggleActual(view, nat, box, point) {
  if (view.z > 1.001) return { ...FIT_VIEW };
  const actual = 1 / fitScale(nat, box); // 원본 1픽셀 = 화면 1픽셀이 되는 배율
  if (actual <= 1.001) return { ...FIT_VIEW }; // 칸보다 작은 사진은 이미 원본 크기
  return zoomAt(view, nat, box, point || { x: box.w / 2, y: box.h / 2 }, actual / view.z);
}

// 오른쪽(넘겨 볼) 사진 목록: 묶음 순서에서 고정한 사진만 빼요
export function browseIds(group, pinnedId) {
  return (group && group.ids ? group.ids : []).filter((id) => id !== pinnedId);
}

// ←/→ 로 넘기기 (끝에서 멈춰요)
export function stepId(ids, current, dir) {
  if (!ids.length) return null;
  const i = ids.indexOf(current);
  if (i < 0) return ids[0];
  return ids[Math.min(ids.length - 1, Math.max(0, i + dir))];
}

// 키 → 할 일 ('prev' | 'next' | 'pin' | 'discard' | 'keep' | 'close' | null)
//   ←/→ 넘기기, Space 고정, ↑ 버림, ↓ 남김, Esc 닫기. 꾹 눌러 반복된 ↑ · ↓ · Space 는 무시해요 (여러 장이 한 번에 바뀌지 않게)
//   Ctrl · Alt · 한글 조합 중이면 무시
export function compareKey(e) {
  if (!e || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return null;
  const k = e.key;
  if (k === 'Escape') return 'close';
  if (k === 'ArrowLeft') return 'prev';
  if (k === 'ArrowRight') return 'next';
  if (e.repeat) return null;
  if (k === ' ' || k === 'Spacebar' || e.code === 'Space') return 'pin';
  if (k === 'ArrowUp') return 'discard';
  if (k === 'ArrowDown') return 'keep';
  return null;
}

// ↑ · ↓ 로 정한 뒤 다음에 볼 사진: 오른쪽 목록에서 다음 사진 (마지막이면 그대로)
export function afterDecide(ids, current) {
  return stepId(ids, current, 1);
}

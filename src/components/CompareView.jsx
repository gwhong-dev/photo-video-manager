// 파일 위치: src/components/CompareView.jsx
// 역할: "비슷한 사진" 비교 창 — 묶음 사진을 크게 보며 남길 사진 고르기 (2026-11-21 사용자 요청)
//   1) 처음에는 사진 한 장을 크게: ←/→ 로 넘겨 봐요
//   2) 가장 좋은 사진에서 Space → 그 사진이 왼쪽에 고정돼요 (남김). 아직 아무것도 안 고른 묶음이면 원래 추천은 버림으로
//   3) 오른쪽에서 나머지를 ←/→ 로 넘기며 ↑ = 버림, ↓ = 남김 (정하면 다음 사진으로). 오른쪽에서 Space 를 다시 누르면 고정을 바꿔요
//   확대: 휠 = 마우스 자리 확대, 끌기 = 옮기기, 더블클릭 = 맞춤 ↔ 원본 크기. 두 칸이 같은 자리 · 같은 배율로 같이 움직여요
//   표시는 비슷한 사진 화면과 같은 값(overrides)을 써요. 실제로 옮기는 건 확인 창에서만 해요 (영구 삭제 없음)
//   다 골랐으면 위쪽 "이 묶음에서 버릴 N장 옮기기" 또는 Delete → 이 창을 닫고 비슷한 사진 화면의 같은 확인 창을 열어요
//     (2026-11-21 사용자 요청 "선택 완료됐으면 삭제도 바로 가능하게")
//   원본 사진은 pvm://original/<id> (못 그리는 형식 · 못 읽으면 pvm://preview/<id> 1200px 로 대신)
//   원본(수 MB)을 다 읽고 풀 때까지는 이미 받아 둔 썸네일을 같은 자리에 크게 깔아 둬요
//     (원본을 바로 그리면 열 때 · 넘길 때 화면이 잠깐 멈췄어요, 2026-11-24 사용자 요청 "크게 보기 열 때 버벅임")

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { formatCount, formatTakenAt } from '../format.mjs';
import { groupDiscardIds, groupReviewLabel, markOf, pinBest, setMark } from '../similar-view.mjs';
import { FIT_VIEW, afterDecide, browseIds, compareKey, layoutOf, panBy, stepId, toggleActual, zoomAt } from '../compare-view.mjs';
import LivePhoto from './LivePhoto.jsx';

// 큰 사진 한 칸 (view 를 두 칸이 같이 써요)
// openedAt: 비교 창이 열린 시각. 사진 칸을 더블클릭하는 습관으로 두 번째 클릭이 이 창에 떨어져도 원본 크기로 바뀌지 않게 해요
const DOUBLE_CLICK_GRACE_MS = 600;
function Pane({ file, view, onView, label, mark, onMark, pinned, openedAt = 0 }) {
  const boxRef = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [nat, setNat] = useState(() => ({ w: file.width || 0, h: file.height || 0 }));
  // 어느 사진의 원본을 못 그렸는지 · 다 풀었는지를 번호로 기억해요 → 사진이 바뀐 첫 화면부터 바로 맞아요 (#150 검증 ⚠️)
  const [failedId, setFailedId] = useState(null); // 원본을 못 그려 미리보기(1200px)로 대신하는 사진
  const [readyId, setReadyId] = useState(null); // 원본(또는 미리보기)을 다 푼 사진 → 그 전엔 썸네일을 보여 줘요
  const src = failedId === file.id ? `pvm://preview/${file.id}` : `pvm://original/${file.id}`;
  const ready = readyId === file.id;
  const drag = useRef(null);
  const latest = useRef({ view, nat, box, onView });
  latest.current = { view, nat, box, onView };

  useEffect(() => {
    setNat({ w: file.width || 0, h: file.height || 0 });
  }, [file.id, file.width, file.height]);

  // 칸 크기 재기 (창 크기가 바뀌면 다시)
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(el);
    return () => { if (ro) ro.disconnect(); };
  }, []);

  // 휠 확대: React 의 휠은 막을 수 없어서(passive) 직접 걸어요
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const L = latest.current;
      const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
      L.onView(zoomAt(L.view, L.nat, L.box, { x: e.clientX - r.left, y: e.clientY - r.top }, factor));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const l = layoutOf(nat, box, view);
  const style = { width: `${l.w}px`, height: `${l.h}px`, left: `${l.left}px`, top: `${l.top}px` };
  const keep = mark === 'keep';
  return (
    <div className={`compare-pane${pinned ? ' pinned' : ''}`}>
      <div
        ref={boxRef}
        className={`compare-box${view.z > 1 ? ' zoomed' : ''}`}
        onPointerDown={(e) => {
          if (e.button !== 0 || e.target.closest('.live-button')) return; // 재생 버튼은 칸이 끌기로 가져가지 않아요 (#131 검증 ⚠️)
          drag.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dx = e.clientX - drag.current.x;
          const dy = e.clientY - drag.current.y;
          drag.current = { x: e.clientX, y: e.clientY };
          onView(panBy(view, nat, box, dx, dy));
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onDoubleClick={(e) => {
          if (e.target.closest('.live-button')) return;
          if (Date.now() - openedAt < DOUBLE_CLICK_GRACE_MS) return; // 열자마자 들어온 더블클릭은 무시
          const r = e.currentTarget.getBoundingClientRect();
          onView(toggleActual(view, nat, box, { x: e.clientX - r.left, y: e.clientY - r.top }));
        }}
      >
        {box.w > 0 && !ready && (
          <img key={`ph-${file.id}`} className="compare-img" src={`pvm://thumb/${file.id}`} alt="" draggable="false" style={style} />
        )}
        {box.w > 0 && (
          <img
            key={file.id}
            className="compare-img"
            src={src}
            alt=""
            draggable="false"
            decoding="async"
            style={style}
            onLoad={(e) => {
              const t = e.currentTarget;
              const id = file.id;
              if (t.naturalWidth && t.naturalHeight) setNat({ w: t.naturalWidth, h: t.naturalHeight });
              // 다 푼 뒤에 썸네일을 치워요 (받기만 하고 아직 안 풀었을 때 치우면 잠깐 빈 칸이 보여요)
              const done = () => { if (t.isConnected && t.dataset.id === String(id)) setReadyId(id); };
              if (typeof t.decode === 'function') t.decode().then(done, done);
              else done();
            }}
            onError={() => setFailedId(file.id)}
            data-id={file.id}
          />
        )}
        {!keep && <span className="similar-x compare-x" aria-hidden="true" />}
        <LivePhoto id={file.id} />
      </div>
      <div className="compare-foot">
        <span className="compare-label">{label}</span>
        <button type="button" className={`similar-mark${keep ? ' on' : ''}`} aria-pressed={keep} onClick={onMark}>{keep ? '남김' : '버림'}</button>
        <span className="similar-size">{file.width && file.height ? `${file.width}×${file.height}` : ''}</span>
        {file.blurry && <span className="similar-size">흐림</span>}
      </div>
    </div>
  );
}

// group: 비슷한 사진 묶음 { ids, files, keepId, takenAt }, overrides: 남김/버림 표시, onOverrides(새 Map), startId: 처음 볼 사진
// onReview(): 이 묶음의 버릴 사진 확인 창 열기 (없으면 버튼 · Delete 가 없어요)
export default function CompareView({ group, overrides, onOverrides, startId, onClose, onReview }) {
  const [pinned, setPinned] = useState(null);
  const [current, setCurrent] = useState(() => (group.ids.includes(startId) ? startId : group.keepId ?? group.ids[0]));
  const [view, setView] = useState(FIT_VIEW);
  const rootRef = useRef(null);
  const [openedAt] = useState(() => Date.now()); // 열린 시각 (Pane 더블클릭 무시에 써요)
  const fileOf = useCallback((id) => group.files.find((f) => f.id === id), [group]);
  const ids = pinned !== null ? browseIds(group, pinned) : group.ids;

  // 묶음이 바뀌어(목록을 다시 받음) 보던 사진이 없어지면 맞춰요
  useEffect(() => {
    const stillPinned = pinned !== null && group.ids.includes(pinned);
    if (pinned !== null && !stillPinned) setPinned(null);
    // 고정한 사진이 오른쪽에도 뜨지 않게, 오른쪽 목록(고정한 사진 뺌)의 첫 사진으로 (#131 검증 ⚠️)
    if (!group.ids.includes(current) || (stillPinned && current === pinned)) setCurrent(browseIds(group, stillPinned ? pinned : null)[0] ?? null);
  }, [group, pinned, current]);

  const decide = (want) => {
    if (current === null || current === undefined) return;
    // 마지막 남김도 버림으로 바꿀 수 있어요 (2026-11-24 사용자 요청)
    const r = setMark(group, current, want, overrides);
    onOverrides(r.overrides);
    setCurrent(afterDecide(ids, current));
  };
  const pin = () => {
    if (current === null || current === undefined) return;
    onOverrides(pinBest(group, current, overrides));
    const rest = browseIds(group, current);
    setPinned(current);
    // 오른쪽에는 고정한 사진 다음 사진부터 (없으면 첫 사진)
    const i = group.ids.indexOf(current);
    setCurrent(rest.find((x) => group.ids.indexOf(x) > i) ?? rest[0] ?? null);
  };
  const toggleOf = (id) => () => {
    const want = markOf(group, id, overrides) === 'keep' ? 'discard' : 'keep';
    const r = setMark(group, id, want, overrides);
    onOverrides(r.overrides);
  };

  // 키: ←/→ 넘기기, Space 고정, ↑ 버림, ↓ 남김, Esc 닫기 (창이 열린 동안 다른 화면 키로 가지 않게 막아요)
  const act = useRef(null);
  const gone = groupDiscardIds(group, overrides).length;
  const review = () => { if (onReview && gone > 0) onReview(); };
  act.current = { decide, pin, ids, current, onClose, review };
  // 비교 창이 열린 동안 뒤 화면은 inert: Tab 으로 뒤 버튼에 가서 확인 창을 비교 창 뒤에 여는 일이 없게 (#131 검증 ⚠️)
  useEffect(() => {
    const changed = [];
    for (let el = rootRef.current; el && el.parentElement && el !== document.body; el = el.parentElement) {
      for (const sib of el.parentElement.children) {
        if (sib === el || sib.inert || sib.tagName === 'SCRIPT') continue;
        sib.inert = true;
        changed.push(sib);
      }
    }
    return () => { for (const s of changed) s.inert = false; };
  }, []);

  useEffect(() => {
    const opener = document.activeElement;
    if (rootRef.current) rootRef.current.focus();
    const onKey = (e) => {
      const a = compareKey(e);
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      const A = act.current;
      if (a === 'close') A.onClose();
      else if (a === 'prev' || a === 'next') setCurrent(stepId(A.ids, A.current, a === 'next' ? 1 : -1));
      else if (a === 'pin') A.pin();
      else if (a === 'discard' || a === 'keep') A.decide(a);
      else if (a === 'review') A.review();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, []);

  const keeps = group.ids.filter((id) => markOf(group, id, overrides) === 'keep').length;
  const cur = current !== null && current !== undefined ? fileOf(current) : null;
  const pin1 = pinned !== null ? fileOf(pinned) : null;
  const pos = ids.indexOf(current) + 1;
  return (
    <div className="compare" role="dialog" aria-modal="true" aria-label="비슷한 사진 크게 비교" tabIndex={-1} ref={rootRef}>
      <div className="compare-top">
        <h2 className="compare-title">{group.takenAt ? formatTakenAt(group.takenAt) : '날짜 없음'}</h2>
        <span className="similar-count">{formatCount(group.ids.length)}장 중 남김 {formatCount(keeps)}장, 버림 {formatCount(group.ids.length - keeps)}장</span>
        <span className="compare-keys">
          <span><kbd>←</kbd><kbd>→</kbd> 넘기기</span>
          <span><kbd>Space</kbd> {pinned === null ? '가장 좋은 사진으로 고정' : '고정 바꾸기'}</span>
          <span><kbd>↑</kbd> 버림</span>
          <span><kbd>↓</kbd> 남김</span>
          <span>휠 확대, 더블클릭 원본 크기</span>
          {onReview && gone > 0 && <span><kbd>Delete</kbd> 버릴 사진 옮기기</span>}
        </span>
        <span className="compare-actions">
          <button type="button" onClick={() => setView(FIT_VIEW)} disabled={view.z === 1}>화면에 맞추기</button>
          <button type="button" className={onReview && gone > 0 ? '' : 'primary'} onClick={onClose}>비교 닫기</button>
          {onReview && gone > 0 && <button type="button" className="primary compare-review" onClick={review}>{groupReviewLabel(gone)}</button>}
        </span>
      </div>
      <div className={`compare-panes${pin1 ? ' two' : ''}`}>
        {pin1 && (
          <Pane key={`pin-${pin1.id}`} file={pin1} view={view} onView={setView} label="고정한 사진" mark={markOf(group, pin1.id, overrides)} onMark={toggleOf(pin1.id)} pinned openedAt={openedAt} />
        )}
        {cur ? (
          <Pane
            key={`cur-${cur.id}`}
            file={cur}
            view={view}
            onView={setView}
            label={pin1 ? `비교할 사진 ${formatCount(pos)} / ${formatCount(ids.length)}` : `${formatCount(pos)} / ${formatCount(ids.length)}${cur.id === group.keepId ? ' (추천)' : ''}`}
            mark={markOf(group, cur.id, overrides)}
            onMark={toggleOf(cur.id)}
            openedAt={openedAt}
          />
        ) : <div className="compare-pane empty">비교할 사진이 없어요</div>}
      </div>
      <div className="compare-strip" aria-label="묶음 사진">
        {group.files.map((f) => {
          const keep = markOf(group, f.id, overrides) === 'keep';
          return (
            <button
              key={f.id}
              type="button"
              className={`compare-thumb${keep ? ' keep' : ' discard'}${f.id === current ? ' current' : ''}${f.id === pinned ? ' pinned' : ''}`}
              aria-label={`${f.name} ${keep ? '남김' : '버림'}${f.id === pinned ? ', 고정한 사진' : ''}${f.id === current ? ', 지금 보는 사진' : ''}`}
              aria-current={f.id === current ? 'true' : undefined}
              onClick={() => { if (f.id !== pinned) setCurrent(f.id); }}
            >
              <img src={`pvm://thumb/${f.id}`} alt="" draggable="false" loading="lazy" />
              {!keep && <span className="similar-x" aria-hidden="true" />}
              {f.id === pinned && <span className="similar-best">고정</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

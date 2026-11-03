// 파일 위치: src/components/SimilarView.jsx
// 역할: "비슷한 사진" 화면 (단계 4, docs/개발개요-v3.md 4-2)
//   묶음마다 사진을 늘어놓고, 처음에는 가장 큰 사진 한 장만 "남김", 나머지는 "버림"으로 표시해요
//   사진을 누르면 오른쪽 패널에 크게 보이고, 사진 아래 표시 버튼으로 남김과 버림을 바꿔요 (묶음마다 한 장은 꼭 남아요)
//   아래 버튼 → 확인 창(몇 장이 휴지통으로, 몇 장이 _정리완료원본 폴더로 가는지) → 옮기기. 영구 삭제는 안 해요
//   남김/버림 표시에만 색연필 빨강을 써요 (CLAUDE.md 화면 디자인)
//   지문은 화면을 처음 열 때 만들기 시작해요. 다 만들면 목록을 다시 받아요

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api.js';
import { formatCount, formatTakenAt } from '../format.mjs';
import { discardIds, discardLabel, keepAll, markOf, previewLines, progressText, pruneOverrides, resultText, reviewLabel, toggleMark } from '../similar-view.mjs';
import EmptyState from './EmptyState.jsx';

const PAGE = 30; // 한 번에 보여 주는 묶음 수

// 사진 한 칸: 사진을 누르면 크게 보기, 아래 버튼으로 남김과 버림 바꾸기
function SimilarCell({ file, mark, focused, onFocus, onToggle, disabled }) {
  const [broken, setBroken] = useState(false);
  const keep = mark === 'keep';
  const size = file.width && file.height ? `${file.width}×${file.height}` : '';
  return (
    <div className={`similar-cell${keep ? ' keep' : ' discard'}`}>
      <button type="button" className={`cell${focused ? ' selected' : ''}`} aria-label={`${file.name} 크게 보기`} onClick={() => onFocus(file.id)}>
        {broken
          ? <span className="no-preview">미리보기 없음</span>
          : <img src={`pvm://thumb/${file.id}`} alt="" loading="lazy" draggable="false" onError={() => setBroken(true)} />}
        {!keep && <span className="similar-x" aria-hidden="true" />}
      </button>
      <button type="button" className="similar-mark" aria-pressed={keep} aria-label={`${file.name} ${keep ? '남김, 누르면 버림으로' : '버림, 누르면 남김으로'}`} disabled={disabled} onClick={() => onToggle(file.id)}>
        {keep ? '남김' : '버림'}
      </button>
      <span className="similar-size">{size}</span>
    </div>
  );
}

export default function SimilarView({ gen, focusId, onFocus, onNotice }) {
  const [data, setData] = useState(null); // { progress, groups }
  const [error, setError] = useState('');
  const [overrides, setOverrides] = useState(() => new Map());
  const [shown, setShown] = useState(PAGE);
  const [confirm, setConfirm] = useState(null); // { ids, info } 확인 창
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const d = await api.listSimilar();
      if (mine !== seq.current) return; // 늦게 온 옛 응답
      setData(d);
      setError('');
      setOverrides((o) => pruneOverrides(d.groups, o));
    } catch (e) {
      if (mine === seq.current) setError(errorText(e));
    }
  }, []);

  // 처음과 목록이 바뀔 때(gen) 다시 받아요
  useEffect(() => { load(); }, [gen, load]);
  // 지문 진행: 숫자만 바꾸고, 다 만들었으면 목록을 다시 받아요
  useEffect(() => {
    let off = () => {};
    try {
      off = api.onSimilarProgress((p) => {
        setData((d) => (d ? { ...d, progress: p } : d));
        if (!p.hashing) load();
      });
    } catch (e) { /* electron 밖 */ }
    return () => off();
  }, [load]);

  // 확인 창: 열리면 그만두기 버튼에 초점, Esc로 닫기 (옮기는 중에는 안 닫혀요)
  const cancelRef = useRef(null);
  useEffect(() => {
    if (!confirm) return undefined;
    if (cancelRef.current) cancelRef.current.focus();
    const onKey = (e) => {
      if (e.key !== 'Escape' || busyRef.current) return;
      e.stopPropagation();
      setConfirm(null);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [confirm]);

  const run = async (fn) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onNotice(errorText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (error) return <EmptyState title="비슷한 사진을 불러오지 못했어요" action={<button type="button" onClick={load}>다시 불러오기</button>}>{error}</EmptyState>;
  if (!data) return <EmptyState title="비슷한 사진을 찾는 중이에요" />;

  const groups = data.groups;
  const progress = progressText(data.progress);
  if (!groups.length) {
    return (
      <EmptyState title={progress ? '비슷한 사진을 찾는 중이에요' : '비슷한 사진이 없어요'}>
        {progress || '3초 안에 이어서 찍었거나 모양이 거의 같은 사진이 없어요.'}
      </EmptyState>
    );
  }

  const toggle = (group, id) => {
    const r = toggleMark(group, id, overrides);
    if (r.refused) onNotice('묶음마다 한 장은 남겨요. 다른 사진을 먼저 남김으로 바꿔 주세요.');
    else setOverrides(r.overrides);
  };
  const ids = discardIds(groups, overrides);
  const review = () => run(async () => {
    const info = await api.previewDiscard(ids);
    setConfirm({ ids, info });
  });
  const discard = () => run(async () => {
    const r = await api.discardSimilar(confirm.ids);
    setConfirm(null);
    onNotice(resultText(r));
    await load();
  });

  return (
    <section className="similar" aria-label="비슷한 사진">
      <div className="similar-top">
        <span>묶음 {formatCount(groups.length)}개, 버릴 사진 {formatCount(ids.length)}장</span>
        {progress && <span>{progress}</span>}
      </div>
      <div className="similar-body">
        {groups.slice(0, shown).map((g) => (
          <div className="similar-group" key={g.ids.join(',')}>
            <div className="similar-head">
              <h3 className="panel-heading">{g.takenAt ? formatTakenAt(g.takenAt) : '날짜 없음'}</h3>
              <span className="similar-count">{formatCount(g.ids.length)}장</span>
              <button type="button" className="link-button" disabled={busy || g.ids.every((id) => markOf(g, id, overrides) === 'keep')} onClick={() => setOverrides((o) => keepAll(g, o))}>
                이 묶음은 모두 남기기
              </button>
            </div>
            <div className="similar-grid">
              {g.files.map((f) => (
                <SimilarCell key={f.id} file={f} mark={markOf(g, f.id, overrides)} focused={focusId === f.id} onFocus={onFocus} onToggle={(id) => toggle(g, id)} disabled={busy} />
              ))}
            </div>
          </div>
        ))}
        {groups.length > shown && (
          <button type="button" className="similar-more" onClick={() => setShown((n) => n + PAGE)}>
            묶음 {formatCount(Math.min(PAGE, groups.length - shown))}개 더 보기 (남은 {formatCount(groups.length - shown)}개)
          </button>
        )}
      </div>
      <div className="similar-actions">
        <button type="button" className="primary" disabled={busy || ids.length === 0} onClick={review}>{reviewLabel(ids.length)}</button>
      </div>
      {confirm && (
        <div className="dialog-backdrop">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="similar-confirm-title">
            <h2 id="similar-confirm-title" className="dialog-title">버릴 사진 옮기기</h2>
            <div className="dialog-pick similar-confirm">
              {previewLines(confirm.info).map((l) => <p key={l}>{l}</p>)}
              <p className="panel-hint">사진 파일은 지우지 않아요. 휴지통에서 되살릴 수 있어요.</p>
            </div>
            <div className="dialog-foot">
              <button type="button" ref={cancelRef} disabled={busy} onClick={() => setConfirm(null)}>그만두기</button>
              <button type="button" className="primary" disabled={busy} onClick={discard}>{busy ? '옮기는 중' : discardLabel(confirm.info)}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

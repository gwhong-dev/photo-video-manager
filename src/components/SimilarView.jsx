// 파일 위치: src/components/SimilarView.jsx
// 역할: "비슷한 사진" 화면 (단계 4, docs/개발개요-v3.md 4-2)
//   묶음마다 사진을 늘어놓고, 처음에는 추천 1장(흐리지 않음 → 노출 → 크기 → 선명함 → 파일 크기 순)만 "남김", 나머지는 "버림"으로 표시해요
//   추천 사진에는 "추천" 표시, 묶음 제목 아래에 까닭 한 줄 (2026-11-16 사용자 결정)
//   사진을 누르면 오른쪽 패널에 크게 보이고, 사진 아래 표시 버튼으로 남김과 버림을 바꿔요 (묶음마다 한 장은 꼭 남아요)
//   아래 버튼 → 확인 창(몇 장이 휴지통으로, 몇 장이 _정리완료원본 폴더로 가는지) → 옮기기. 영구 삭제는 안 해요
//   남김/버림 표시에만 색연필 빨강을 써요 (CLAUDE.md 화면 디자인)
//   묶음마다 "이 묶음에서 버릴 N장 옮기기"로 그 묶음만 먼저 옮길 수 있어요. 아래 버튼은 화면에 보인 묶음 전체 (2026-11-16 사용자 요청)
//   흐린 사진(흐림 점수 0.5 이상)에는 "흐림" 표시. 이어 찍기(1분) 묶음은 AI 로 같은 장면을 확인했을 때만 생겨요
//   AI 모델이 없으면 맨 위 안내 줄에 "받으면 이어 찍은 사진도 장면별로 묶어요"와 받기 버튼 (받기는 확인 창에서 누를 때만)
//   지문은 백업 폴더를 읽은 뒤 뒤에서 미리 만들고, 화면을 열 때 남은 것도 만들어요. 다 만들면 목록을 다시 받아요
//   크게 비교 (2026-11-21 사용자 요청): 사진 클릭 한 번 · 사진을 고른 뒤 Space · 묶음의 "크게 보며 고르기" → CompareView
//     (처음엔 더블클릭이었는데 "클릭하면 왜 크게 안 뜨냐" 지적으로 클릭 한 번으로, 2026-11-21)
//     ←/→ 넘기기, Space 로 가장 좋은 사진 고정(왼쪽), 오른쪽에서 ↑ 버림 · ↓ 남김. 표시는 이 화면과 같은 값이에요

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api.js';
import { formatCount, formatTakenAt } from '../format.mjs';
import { aiConfirmLabel, aiConfirmLines, aiLine, discardIds, discardLabel, groupDiscardIds, groupNote, groupReviewLabel, keepAll, keptAfterDiscard, markOf, pinMarks, previewLines, progressText, pruneOverrides, recommendText, resultText, reviewLabel, toggleMark } from '../similar-view.mjs';
import EmptyState from './EmptyState.jsx';
import CompareView from './CompareView.jsx';

const PAGE = 30; // 한 번에 보여 주는 묶음 수

// PC 안 AI 비교 한 줄: 모델이 없으면 "받기" 버튼 → 확인 창(어디서 · 얼마나 · 무엇을 보내지 않는지) → 받기
//   모델은 이 확인 창에서 누를 때만 받아요 (2026-11-16 사용자 결정). 받은 뒤에는 특징값 만드는 진행만 보여요
function AiBar({ onNotice, onChanged }) {
  const [state, setState] = useState(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const wasEmbedding = useRef(false);
  useEffect(() => {
    let alive = true;
    api.aiState().then((s) => { if (alive) setState(s); }).catch(() => {});
    let off = () => {};
    try {
      off = api.onAiProgress((s) => {
        setState(s);
        // 특징값을 다 만들면 묶음이 바뀔 수 있어서 목록을 다시 받아요
        if (wasEmbedding.current && !s.embedding) onChanged();
        wasEmbedding.current = !!s.embedding;
      });
    } catch (e) { /* electron 밖 */ }
    return () => { alive = false; off(); };
  }, [onChanged]);
  const line = aiLine(state);
  if (!line.text) return null;
  const download = async () => {
    setBusy(true);
    try {
      setState(await api.aiDownload());
      setAsking(false);
    } catch (e) {
      setAsking(false);
      onNotice(errorText(e));
      try { setState(await api.aiState()); } catch (e2) { /* 그대로 */ }
    } finally {
      setBusy(false);
    }
  };
  // 화면 맨 위 안내 줄 (갤러리 안내 줄과 같은 모양). 받기 전에는 받으면 무엇이 달라지는지와 받기 버튼을 잘 보이게 (2026-11-16 사용자 지적)
  return (
    <>
      <div className="banners similar-ai"><div className="banner">
        <span className="banner-text">
          <strong>{line.text}</strong>
          {line.sub && <> <span className="banner-sub">{line.sub}</span></>}
        </span>
        {line.button && <button type="button" disabled={busy} onClick={() => setAsking(true)}>{line.button}</button>}
      </div></div>
      {asking && (
        <div className="dialog-backdrop">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="ai-confirm-title">
            <h2 id="ai-confirm-title" className="dialog-title">AI 모델 받기</h2>
            <div className="dialog-pick similar-confirm">
              {aiConfirmLines(state).map((l) => <p key={l}>{l}</p>)}
            </div>
            <div className="dialog-foot">
              <button type="button" disabled={busy} onClick={() => setAsking(false)}>그만두기</button>
              <button type="button" className="primary" disabled={busy} onClick={download}>{busy ? '받는 중' : aiConfirmLabel(state)}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// 사진 한 칸: 사진을 누르면 크게 보기, 아래 버튼으로 남김과 버림 바꾸기
function SimilarCell({ file, mark, best, focused, onFocus, onToggle, onOpen, disabled }) {
  const [broken, setBroken] = useState(false);
  const keep = mark === 'keep';
  const size = file.width && file.height ? `${file.width}×${file.height}` : '';
  return (
    <div className={`similar-cell${keep ? ' keep' : ' discard'}`}>
      <button type="button" className={`cell${focused ? ' selected' : ''}`} aria-label={`${file.name} 크게 보기`} onClick={() => onOpen(file.id)}>
        {broken
          ? <span className="no-preview">미리보기 없음</span>
          : <img src={`pvm://thumb/${file.id}`} alt="" loading="lazy" draggable="false" onError={() => setBroken(true)} />}
        {!keep && <span className="similar-x" aria-hidden="true" />}
        {file.blurry && <span className="similar-blur">흐림</span>}
        {best && <span className="similar-best">추천</span>}
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
  const [confirm, setConfirm] = useState(null); // { ids, info, keepIds } 확인 창 (keepIds = 옮긴 뒤 목록에서 뺄 남은 사진)
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState(null); // { key: 묶음 열쇠, startId } 크게 비교 창
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

  // 화면에 보인 묶음의 남김/버림 표시를 적어 둬요 (안 본 묶음은 버리지 않아요)
  //   사용자가 누른 묶음은 다시 받아도 그대로, 안 누른 묶음은 추천이 바뀌면 다시 맞춰요 (src/similar-view.mjs pinMarks)
  useEffect(() => {
    if (data) setOverrides((o) => pinMarks(data.groups.slice(0, shown), o));
  }, [data, shown]);

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

  // 사진을 고른 뒤 Space → 그 사진의 묶음을 크게 비교 (글 쓰는 칸 · 다른 창이 열려 있으면 안 열어요)
  const spaceRef = useRef(null);
  spaceRef.current = { data, shown, focusId, open: !!(compare || confirm) };
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== ' ' || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      const S = spaceRef.current;
      if (S.open || !S.data || S.focusId === null || S.focusId === undefined) return;
      const t = document.activeElement;
      const tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      if (document.querySelector('.dialog-backdrop')) return;
      const g = S.data.groups.slice(0, S.shown).find((x) => x.ids.includes(S.focusId));
      if (!g) return;
      e.preventDefault();
      setCompare({ key: g.ids.join(','), startId: S.focusId });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // 크게 비교 중인 묶음이 목록을 다시 받아 없어지면 창 상태도 비워요 (그대로 두면 Space 열기가 막히고, 나중에 묶음이 생기면 창이 갑자기 열려요, #131 검증 ⚠️)
  useEffect(() => {
    if (!compare || !data) return;
    const vis = data.groups.slice(0, shown);
    if (!vis.some((x) => x.ids.join(',') === compare.key || x.ids.includes(compare.startId))) setCompare(null);
  }, [compare, data, shown]);

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
    // 모두 남기기로 숨긴 묶음만 있으면 다시 보기 버튼을 보여 줘요
    const again = data.hiddenKept > 0
      ? <button type="button" disabled={busy} onClick={() => run(async () => { await api.clearSimilarKeeps(); await load(); })}>모두 남기기로 한 묶음 {formatCount(data.hiddenKept)}개 다시 보기</button>
      : null;
    // AI 안내 줄은 묶음이 없어도 맨 위에 보여요 (받으면 이어 찍은 사진 묶음이 생길 수 있어요)
    return (
      <section className="similar" aria-label="비슷한 사진">
        <AiBar onNotice={onNotice} onChanged={load} />
        <EmptyState title={progress ? '비슷한 사진을 찾는 중이에요' : '비슷한 사진이 없어요'} action={again}>
          {progress || '3초 안에 이어서 찍었거나, 모양이 거의 같거나, AI 로 같은 장면인 1분 안 사진이 없어요.'}
        </EmptyState>
      </section>
    );
  }

  const toggle = (group, id) => {
    const r = toggleMark(group, id, overrides);
    if (r.refused) onNotice('묶음마다 한 장은 남겨요. 다른 사진을 먼저 남김으로 바꿔 주세요.');
    else setOverrides(r.overrides);
  };
  // 모두 남기기: 화면 표시를 바로 바꾸고, 다음 실행에도 기억해요 (저장을 못 해도 이번 화면에서는 남김)
  const keepGroup = (g) => {
    setOverrides((o) => keepAll(g, o));
    api.keepAllSimilar(g.ids)
      .then((r) => { if (!r.saved) onNotice('모두 남기기를 기억하지 못했어요. 다음 실행에 다시 보일 수 있어요.'); })
      .catch((e) => onNotice(errorText(e)));
  };
  const showKept = () => run(async () => {
    const r = await api.clearSimilarKeeps();
    if (!r.saved) onNotice('숨긴 묶음 목록을 비우지 못했어요.');
    await load();
  });
  // 버릴 사진은 지금 화면에 보인 묶음에서만 세요 (#121 검증 지적: 새 묶음이 위에 생겨 30개 밖으로 밀린 묶음은
  //   표시를 다시 맞추지 않으므로, 옛 표시가 남은 채 버리지 않게)
  const ids = discardIds(groups.slice(0, shown), overrides);
  const review = () => run(async () => {
    const info = await api.previewDiscard(ids);
    setConfirm({ ids, info, keepIds: keptAfterDiscard(groups.slice(0, shown), overrides) });
  });
  // 이 묶음만 먼저: 같은 확인 창을 이 묶음의 버림만으로 열어요
  const reviewGroup = (g) => run(async () => {
    const gids = groupDiscardIds(g, overrides);
    if (!gids.length) return;
    const info = await api.previewDiscard(gids);
    setConfirm({ ids: gids, info, keepIds: keptAfterDiscard([g], overrides) });
  });
  const discard = () => run(async () => {
    const r = await api.discardSimilar(confirm.ids);
    const keepIds = confirm.keepIds || [];
    setConfirm(null);
    let text = resultText(r);
    // 하나라도 옮겼으면 그 묶음의 남은 사진은 "모두 남기기"로 기억해 목록에서 빼요 (다시 보기 버튼으로 되돌릴 수 있어요)
    //   못 옮긴 사진은 그대로 남아서 그 묶음은 다시 보여요
    if ((r.trashed || 0) + (r.moved || 0) > 0 && keepIds.length) {
      try {
        const k = await api.keepAllSimilar(keepIds);
        if (!k.saved) text += ' 남은 사진을 목록에서 빼지 못했어요 (다음에 다시 보일 수 있어요).';
      } catch (e) {
        text += ` ${errorText(e)}`;
      }
    }
    onNotice(text);
    await load();
  });

  return (
    <section className="similar" aria-label="비슷한 사진">
      <AiBar onNotice={onNotice} onChanged={load} />
      <div className="similar-top">
        <span>묶음 {formatCount(groups.length)}개, 버릴 사진 {formatCount(ids.length)}장</span>
        {progress && <span>{progress}</span>}

        {data.hiddenKept > 0 && (
          <button type="button" className="link-button" disabled={busy} onClick={showKept}>
            모두 남기기로 한 묶음 {formatCount(data.hiddenKept)}개 다시 보기
          </button>
        )}
      </div>
      <div className="similar-body">
        {groups.slice(0, shown).map((g) => {
          const gone = groupDiscardIds(g, overrides).length;
          const note = groupNote(g);
          const why = recommendText(g);
          return (
          <div className="similar-group" key={g.ids.join(',')}>
            <div className="similar-head">
              <h3 className="panel-heading">{g.takenAt ? formatTakenAt(g.takenAt) : '날짜 없음'}</h3>
              <span className="similar-count">{formatCount(g.ids.length)}장</span>
              {note && <span className="similar-count">{note}</span>}
              <span className="similar-head-actions">
                <button type="button" className="link-button" onClick={() => setCompare({ key: g.ids.join(','), startId: g.keepId })}>
                  크게 보며 고르기
                </button>
                <button type="button" className="link-button" disabled={busy || g.ids.every((id) => markOf(g, id, overrides) === 'keep')} onClick={() => keepGroup(g)}>
                  이 묶음은 모두 남기기
                </button>
                {gone > 0 && (
                  <button type="button" className="similar-group-go" disabled={busy} onClick={() => reviewGroup(g)}>{groupReviewLabel(gone)}</button>
                )}
              </span>
            </div>
            {why && <p className="similar-why">{why}</p>}
            <div className="similar-grid">
              {g.files.map((f) => (
                <SimilarCell key={f.id} file={f} mark={markOf(g, f.id, overrides)} best={f.id === g.keepId} focused
={focusId === f.id} onFocus={onFocus} onToggle={(id) => toggle(g, id)} onOpen={(id) => { onFocus(id); setCompare({ key: g.ids.join(','), startId: id }); }} disabled={busy} />
              ))}
            </div>
          </div>
          );
        })}
        {groups.length > shown && (
          <button type="button" className="similar-more" onClick={() => setShown((n) => n + PAGE)}>
            묶음 {formatCount(Math.min(PAGE, groups.length - shown))}개 더 보기 (남은 {formatCount(groups.length - shown)}개)
          </button>
        )}
      </div>
      <div className="similar-actions">
        <button type="button" className="primary" disabled={busy || ids.length === 0} onClick={review}>{reviewLabel(ids.length)}</button>
      </div>
      {compare && (() => {
        // 목록을 다시 받아 묶음이 바뀌면 열쇠로 다시 찾아요 (없어지면 창을 그리지 않아요)
        const g = groups.slice(0, shown).find((x) => x.ids.join(',') === compare.key)
          || groups.slice(0, shown).find((x) => x.ids.includes(compare.startId));
        if (!g) return null;
        // 다 골랐으면 비교 창을 닫고 같은 확인 창으로 (옮기기는 확인 창에서만)
        const onReview = () => { setCompare(null); reviewGroup(g); };
        return <CompareView group={g} overrides={overrides} onOverrides={setOverrides} startId={compare.startId} onClose={() => setCompare(null)} onReview={busy ? undefined : onReview} />;
      })()}
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

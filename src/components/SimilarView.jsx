// 파일 위치: src/components/SimilarView.jsx
// 역할: "비슷한 사진" 화면 (단계 4, docs/개발개요-v3.md 4-2)
//   묶음마다 사진을 늘어놓고, 처음에는 추천 1장(흐리지 않음 → 노출 → 크기 → 선명함 → 파일 크기 순)만 "남김", 나머지는 "버림"으로 표시해요
//   추천 사진에는 "추천" 표시, 묶음 제목 아래에 까닭 한 줄 (2026-11-16 사용자 결정)
//   사진을 누르면 오른쪽 패널에 크게 보이고, 사진 아래 표시 버튼으로 남김과 버림을 바꿔요 (한 묶음을 모두 버릴 수도 있어요, 2026-11-24)
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
import { aiConfirmLabel, aiConfirmLines, aiLine, discardAll, discardIds, discardLabel, groupAllLabel, groupDiscardIds, groupNote, groupReviewLabel, keepAll, keptAfterDiscard, markOf, pinMarks, previewLines, progressText, pruneOverrides, recommendText, resultText, reviewLabel, toggleMark, wholeIds, sizeText, videoDiscardIds, videoDiscardLabel, videoPreviewLines, videoProgressText, videoResultText, videoSummary } from '../similar-view.mjs';
import EmptyState from './EmptyState.jsx';
import CompareView from './CompareView.jsx';

const PAGE = 30; // 한 번에 보여 주는 묶음 수
const MAX_VIDEO = 20000; // 같은 영상을 한 번에 옮기는 최대 개수 (lib/similar-discard.js MAX_DISCARD 와 같게)

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

// 같은 영상 한 칸: 남김/버림이 정해져 있어서 누르지 않아요
function SameVideoCell({ file, keep }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className={`similar-cell${keep ? ' keep' : ' discard'}`}>
      <div className="cell empty">
        {broken
          ? <span className="no-preview">미리보기 없음</span>
          : <img src={`pvm://thumb/${file.id}`} alt="" loading="lazy" draggable="false" onError={() => setBroken(true)} />}
        {!keep && <span className="similar-x" aria-hidden="true" />}
      </div>
      <span className="similar-mark same-video-mark">{keep ? '남김' : '버림'}</span>
      <span className="similar-size same-video-name" title={file.name}>{file.name}</span>
      <span className="similar-size">{sizeText(file.size)}</span>
    </div>
  );
}

// 같은 영상 묶음 (두 번 저장된 백업 영상, 2026-11-24 사용자 요청): 비슷한 사진 화면 맨 위
//   남길 영상(이름에 꼬리가 없는 것)과 옮길 영상은 main 이 정해요. 확인 창을 보고 누를 때만 옮겨요
//   영상 지문은 main 이 뒤에서 하나씩 만들고(gallery:same-video-progress), 다 만들면 목록을 다시 받아요
// hold: 비슷한 사진을 옮기는 중이면 true → 그동안 온 목록 바뀜(gen)은 끝난 뒤 한 번만 다시 받아요 (옮기기 끝날 때 버벅임, 2026-11-24)
function SameVideoSection({ gen, onNotice, hold = false }) {
  const [data, setData] = useState(null); // { groups, pending, hashing, noFfmpeg }
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(null);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [confirm, setConfirm] = useState(null); // { ids, info }
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const seq = useRef(0);
  const cancelRef = useRef(null);

  const held = useRef(false); // 옮기는 중에 목록 바뀜이 와서 다시 받기를 미뤘는지
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const load = useCallback(async () => {
    held.current = false; // 지금 받으면 그 전 바뀜까지 다 담겨요
    const mine = ++seq.current;
    try {
      const d = await api.listSameVideo();
      if (mine !== seq.current) return; // 늦게 온 옛 응답
      setData(d);
      setError('');
    } catch (e) {
      if (mine === seq.current) setError(errorText(e));
    }
  }, []);
  // 처음과 목록이 바뀔 때(gen) 다시 받아요. 옮기는 중이면(내 것 · 비슷한 사진 쪽) 끝난 뒤로 미뤄요
  //   옮기기가 끝나면 main 의 "목록 바뀜" 알림과 옮기기 끝 다시 받기가 겹쳐 같은 목록을 두세 번 만들었어요
  useEffect(() => {
    if (busyRef.current || holdRef.current) { held.current = true; return; }
    load();
  }, [gen, load]);
  useEffect(() => {
    if (!hold && !busyRef.current && held.current) load();
  }, [hold, load]);
  useEffect(() => {
    let off = () => {};
    try {
      off = api.onSameVideoProgress((p) => {
        setProgress(p);
        if (!p.hashing) load();
      });
    } catch (e) { /* electron 밖 */ }
    return () => off();
  }, [load]);

  // 확인 창: 열리면 그만두기 버튼에 초점, Esc로 닫기 (옮기는 중에는 안 닫혀요)
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
      if (held.current) load(); // 옮기는 동안 미룬 목록 바뀜 (fn 안에서 이미 다시 받았으면 held 는 비어 있어요)
    }
  };
  const review = (ids) => run(async () => {
    if (!ids.length) return;
    const info = await api.previewSameVideo(ids);
    setConfirm({ ids, info });
  });
  const discard = () => run(async () => {
    const r = await api.discardSameVideo(confirm.ids);
    setConfirm(null);
    onNotice(videoResultText(r));
    await load();
  });

  if (error) return <div className="same-video"><p className="similar-why">같은 영상을 불러오지 못했어요. {error}</p></div>;
  if (!data) return null;
  const groups = data.groups || [];
  const all = videoDiscardIds(groups).slice(0, MAX_VIDEO);
  const prog = progress && progress.hashing ? videoProgressText(progress) : (data.hashing ? '같은 영상을 찾는 중이에요.' : '');
  const noFfmpeg = data.noFfmpeg ? `FFmpeg 가 없어서 같은 영상인지 확인하지 못했어요 (확인할 영상 ${formatCount(data.pending)}개). 가져오기 화면에서 FFmpeg 를 찾아 주세요.` : '';
  if (!groups.length && !prog && !noFfmpeg) return null;

  return (
    <div className="same-video" aria-label="같은 영상">
      <div className="similar-head">
        <h3 className="panel-heading">같은 영상</h3>
        {groups.length > 0 && <span className="similar-count">{videoSummary(groups)}</span>}
        <span className="similar-head-actions">
          {groups.length > 0 && (
            <button type="button" className="link-button" onClick={() => setOpen((o) => !o)}>{open ? '묶음 접기' : '묶음 펼쳐 보기'}</button>
          )}
          {all.length > 0 && (
            <button type="button" className="similar-group-go" disabled={busy} onClick={() => review(all)}>옮길 영상 {formatCount(all.length)}개 확인하기</button>
          )}
        </span>
      </div>
      {groups.length > 0 && <p className="similar-why">한 폴더에 두 번 저장된 영상이에요. 이름에 _1 같은 꼬리가 없는 영상을 남기고 나머지를 옮겨요.</p>}
      {prog && <p className="similar-why">{prog}</p>}
      {noFfmpeg && <p className="similar-why">{noFfmpeg}</p>}
      {open && groups.slice(0, shown).map((g) => (
        <div className="same-video-group" key={g.ids.join(',')}>
          <div className="similar-head">
            <span className="similar-count">{g.files[0].takenAt ? formatTakenAt(g.files[0].takenAt) : '날짜 없음'}</span>
            <span className="similar-head-actions">
              <button type="button" className="link-button" disabled={busy} onClick={() => review(g.ids.slice(1))}>이 묶음만 옮기기</button>
            </span>
          </div>
          <div className="similar-grid">
            {g.files.map((f) => <SameVideoCell key={f.id} file={f} keep={f.id === g.keepId} />)}
          </div>
        </div>
      ))}
      {open && groups.length > shown && (
        <button type="button" className="similar-more" onClick={() => setShown((n) => n + PAGE)}>
          묶음 {formatCount(Math.min(PAGE, groups.length - shown))}개 더 보기 (남은 {formatCount(groups.length - shown)}개)
        </button>
      )}
      {confirm && (
        <div className="dialog-backdrop">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="same-video-confirm-title">
            <h2 id="same-video-confirm-title" className="dialog-title">같은 영상 옮기기</h2>
            <div className="dialog-pick similar-confirm">
              {videoPreviewLines(confirm.info).map((l) => <p key={l}>{l}</p>)}
              <p className="panel-hint">영상 파일은 지우지 않아요. 휴지통에서 되살릴 수 있어요.</p>
            </div>
            <div className="dialog-foot">
              <button type="button" ref={cancelRef} disabled={busy} onClick={() => setConfirm(null)}>그만두기</button>
              <button type="button" className="primary" disabled={busy} onClick={discard}>{busy ? '확인하며 옮기는 중' : videoDiscardLabel(confirm.info)}</button>
            </div>
          </div>
        </div>
      )}
    </div>
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
  const [confirm, setConfirm] = useState(null); // { ids, whole, info, keepIds } 확인 창 (whole = 모두 버리는 묶음의 번호, keepIds = 옮긴 뒤 목록에서 뺄 남은 사진)
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState(null); // { key: 묶음 열쇠, startId } 크게 비교 창
  const busyRef = useRef(false);
  const seq = useRef(0);

  const held = useRef(false); // 옮기는 중에 목록 바뀜이 와서 다시 받기를 미뤘는지
  const load = useCallback(async () => {
    held.current = false; // 지금 받으면 그 전 바뀜까지 다 담겨요
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
  //   옮기는 중(busy)이면 끝난 뒤로 미뤄요: 옮기기가 끝나면 main 의 "목록 바뀜" 알림과 옮기기 끝 다시 받기가 겹쳐
  //   5만 장 라이브러리에서 한 번에 0.3초 걸리는 목록 만들기를 두세 번 했어요 (옮기기 끝날 때 버벅임, 2026-11-24)
  useEffect(() => {
    if (busyRef.current) { held.current = true; return; }
    load();
  }, [gen, load]);
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
      if (S.open || busyRef.current || !S.data || S.focusId === null || S.focusId === undefined) return; // 확인 창을 준비하는 중에도 안 열어요
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
      if (held.current) load(); // 옮기는 동안 미룬 목록 바뀜 (fn 안에서 이미 다시 받았으면 held 는 비어 있어요)
    }
  };

  if (error) return <EmptyState title="비슷한 사진을 불러오지 못했어요" action={<button type="button" onClick={load}>다시 불러오기</button>}>{error}</EmptyState>;
  if (!data) return <EmptyState title="비슷한 사진을 찾는 중이에요" />;

  const groups = data.groups;
  // 같은 영상 칸은 두 화면(사진 묶음 있음 / 없음)에서 같은 자리(AI 안내 줄 바로 아래)에 둬요
  //   자리가 같아야 사진 묶음이 처음 생겨도 이 칸이 새로 만들어지지 않아서, 열어 둔 확인 창이 닫히지 않아요 (#148 검증 지적)
  const videos = <div className="same-video-only"><SameVideoSection gen={gen} onNotice={onNotice} hold={busy} /></div>;
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
        {videos}
        <EmptyState title={progress ? '비슷한 사진을 찾는 중이에요' : '비슷한 사진이 없어요'} action={again}>
          {progress || '3초 안에 이어서 찍었거나, 모양이 거의 같거나, AI 로 같은 장면인 1분 안 사진이 없어요.'}
        </EmptyState>
      </section>
    );
  }

  const toggle = (group, id) => {
    // 마지막 남김도 버림으로 바꿀 수 있어요 (2026-11-24 사용자 요청: 한 묶음을 모두 버리고 싶을 때도 있음)
    setOverrides(toggleMark(group, id, overrides).overrides);
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
    const whole = wholeIds(groups.slice(0, shown), overrides);
    const info = await api.previewDiscard(ids, whole);
    setConfirm({ ids, whole, info, keepIds: keptAfterDiscard(groups.slice(0, shown), overrides) });
  });
  // 이 묶음만 먼저: 같은 확인 창을 이 묶음의 버림만으로 열어요
  const reviewGroup = (g) => run(async () => {
    const gids = groupDiscardIds(g, overrides);
    if (!gids.length) return;
    const whole = wholeIds([g], overrides);
    const info = await api.previewDiscard(gids, whole);
    setConfirm({ ids: gids, whole, info, keepIds: keptAfterDiscard([g], overrides) });
  });
  // 이 묶음 모두 버리기 (2026-11-24 사용자 요청): 모든 사진을 버림으로 바꾸고 바로 확인 창을 열어요
  //   그만두기를 눌러도 표시는 버림으로 남아요 (사진을 눌러 다시 남김으로 바꿀 수 있어요)
  const discardGroup = (g) => run(async () => {
    const next = discardAll(g, overrides);
    setOverrides(next);
    const gids = groupDiscardIds(g, next);
    const whole = wholeIds([g], next);
    const info = await api.previewDiscard(gids, whole);
    setConfirm({ ids: gids, whole, info, keepIds: [] });
  });
  const discard = () => run(async () => {
    const r = await api.discardSimilar(confirm.ids, confirm.whole || []);
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
      {videos}
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
                <button type="button" className="link-button" disabled={busy} onClick={() => discardGroup(g)}>
                  {groupAllLabel(g.ids.length)}
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
={focusId === f.id} onFocus={onFocus} onToggle={(id) => toggle(g, id)} onOpen={(id) => { if (busyRef.current) return; onFocus(id); setCompare({ key: g.ids.join(','), startId: id }); }} disabled={busy} />
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

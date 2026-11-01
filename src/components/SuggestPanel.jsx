// 파일 위치: src/components/SuggestPanel.jsx
// 역할: "위치 제안" 탭. 근거 사진과, 그 위치를 넣을 사진들을 묶음별로 하나씩 보여 줘요 (설계서 5절)
//   이 화면 자체가 미리보기예요. 사용자가 버튼을 눌렀을 때만 값이 들어가요
//   사진을 누르면 오른쪽 패널에 크게 보이고, 모서리 체크 칸을 끄면 넣기에서 빠져요 (뺀 사진은 건너뛴 사진으로 기억해요)
//   목록은 gen이 바뀔 때마다 다시 받고, 늦게 온 옛 응답은 버려요 (요청 번호)
//   넣기와 건너뛰기는 하는 동안 다시 눌러도 한 번만 실행돼요. 빠른 두 번 누름의 뒤쪽은 다음 묶음에 닿지 않게 받지 않아요

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api.js';
import { formatCount, formatTakenAt, gapText, suggestApplyLabel } from '../format.mjs';
import { groupKey, isRepeatClick, settleView } from '../suggest-view.mjs';
import EmptyState from './EmptyState.jsx';

const SKIP_NOT_SAVED = '건너뛴 사진을 파일에 저장하지 못했어요. 이번 실행 동안만 기억해요.';

// 근거 사진 큰 그림. 영상은 썸네일로 보여 줘요
function SourcePhoto({ source }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [source.id]);
  if (broken) return <div className="suggest-source-img"><span className="no-preview">미리보기 없음</span></div>;
  const kind = source.mediaType === 'video' ? 'thumb' : 'preview';
  return (
    <div className="suggest-source-img">
      <img src={`pvm://${kind}/${source.id}`} alt="" draggable="false" onError={() => setBroken(true)} />
    </div>
  );
}

// 넣을 사진 한 칸. 사진을 누르면 크게 보기, 체크 칸을 끄면 넣기에서 빼기
function TargetCell({ target, checked, focused, onFocus, onToggle }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className={`suggest-cell${checked ? '' : ' left-out'}`}>
      <button type="button" className={`cell${focused ? ' selected' : ''}`} aria-label={`${target.name} 크게 보기`} onClick={() => onFocus(target.id)}>
        {broken
          ? <span className="no-preview">미리보기 없음</span>
          : <img src={`pvm://thumb/${target.id}`} alt="" loading="lazy" draggable="false" onError={() => setBroken(true)} />}
      </button>
      <label className="suggest-check">
        <input type="checkbox" checked={checked} aria-label={`${target.name} 위치 넣기`} onChange={() => onToggle(target.id)} />
      </label>
      <span className="suggest-gap">{gapText(target.gapMinutes)}</span>
    </div>
  );
}

export default function SuggestPanel({ gen, focusId, onFocus, onApplied, onNotice }) {
  const [data, setData] = useState(null); // { groups, photoCount, skippedCount }
  const [error, setError] = useState('');
  const [view, setView] = useState(null); // { key, unchecked } 보여 줄 묶음과 넣기에서 뺀 사진 번호들
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const seq = useRef(0);
  const viewRef = useRef(null);
  viewRef.current = view;

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await api.listSuggestions();
      if (mine !== seq.current) return;
      setData(next);
      setError('');
      setView(settleView(next.groups, viewRef.current));
    } catch (e) {
      if (mine === seq.current) setError(errorText(e));
    }
  }, []);
  useEffect(() => { load(); }, [gen, load]);

  const group = data && view ? data.groups.find((g) => groupKey(g) === view.key) : null;

  // 새 묶음을 보여 줄 때는 근거 사진을 오른쪽 패널에 보여 줘요
  const groupSourceId = group ? group.source.id : null;
  useEffect(() => {
    if (groupSourceId !== null) onFocus(groupSourceId);
  }, [view && view.key, groupSourceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 넣기나 건너뛰기 한 번을 감싸요: 겹쳐 실행하지 않고, 끝나면 목록을 다시 받아요 (거절된 경우에도)
  const run = async (work) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    onNotice('');
    try {
      await work();
    } catch (e) {
      onNotice(errorText(e));
    }
    await load();
    busyRef.current = false;
    setBusy(false);
  };
  const skip = async (ids) => {
    const r = await api.skipSuggestions(ids);
    if (!r.saved) onNotice(SKIP_NOT_SAVED);
  };

  const toggle = (id) => setView((v) => {
    const unchecked = new Set(v.unchecked);
    if (unchecked.has(id)) unchecked.delete(id);
    else unchecked.add(id);
    return { ...v, unchecked };
  });
  const apply = () => run(async () => {
    const checked = group.targets.filter((t) => !view.unchecked.has(t.id)).map((t) => t.id);
    const left = group.targets.filter((t) => view.unchecked.has(t.id)).map((t) => t.id);
    const r = await api.applyEdit(checked, { source: 'copy', sourceId: group.source.id, date: false, time: false, location: true, via: 'suggest' });
    if (r.dropped) onNotice(`그 사이 위치가 생긴 ${formatCount(r.dropped)}장은 빼고 넣었어요.`);
    if (left.length) await skip(left);
    await onApplied(r);
  });
  const skipGroup = () => run(() => skip(group.targets.map((t) => t.id)));
  const clearSkips = () => run(async () => {
    const r = await api.clearSuggestionSkips();
    if (!r.saved) onNotice('건너뛴 사진 목록을 파일에서 비우지 못했어요. 이번 실행 동안만 다시 보여요.');
  });

  if (error) return <EmptyState title="위치 제안을 불러오지 못했어요" action={<button type="button" onClick={load}>다시 불러오기</button>}>{error}</EmptyState>;
  if (!data) return <EmptyState title="위치 제안을 계산하는 중이에요" />;

  const skippedButton = data.skippedCount > 0 && (
    <button type="button" className="link-button" disabled={busy} onClick={clearSkips}>건너뛴 {formatCount(data.skippedCount)}장 다시 보기</button>
  );
  if (!group) {
    return (
      <EmptyState title="제안할 사진이 없어요" action={skippedButton || undefined}>
        같은 날 60분 안에 찍은, 위치 있는 사진이 없으면 제안하지 않아요.
      </EmptyState>
    );
  }

  const checkedCount = group.targets.length - view.unchecked.size;
  return (
    <section className="suggest" aria-label="위치 제안">
      <div className="suggest-top">
        <span>남은 묶음 {formatCount(data.groups.length)}개, {formatCount(data.photoCount)}장</span>
        {skippedButton}
      </div>
      <div className="suggest-body">
        <div className="suggest-source">
          <h3 className="panel-heading">근거 사진</h3>
          <button type="button" className={`suggest-source-button${focusId === group.source.id ? ' selected' : ''}`} aria-label={`${group.source.name} 크게 보기`} onClick={() => onFocus(group.source.id)}>
            <SourcePhoto source={group.source} />
          </button>
          <p className="detail-sub">{formatTakenAt(group.source.takenAt)}</p>
          <p className="panel-hint">아래 사진을 이 사진과 같은 곳에서 찍었다면 위치를 넣어 주세요.</p>
        </div>
        <div className="suggest-targets">
          <h3 className="panel-heading">위치를 넣을 사진</h3>
          <div className="suggest-grid">
            {group.targets.map((t) => (
              <TargetCell key={t.id} target={t} checked={!view.unchecked.has(t.id)} focused={focusId === t.id} onFocus={onFocus} onToggle={toggle} />
            ))}
          </div>
        </div>
      </div>
      <div className="suggest-actions">
        <button type="button" className="primary" disabled={busy || checkedCount === 0} onClick={(e) => { if (!isRepeatClick(e)) apply(); }}>{suggestApplyLabel(checkedCount) || '넣을 사진을 골라 주세요'}</button>
        <button type="button" disabled={busy} onClick={(e) => { if (!isRepeatClick(e)) skipGroup(); }}>이 묶음 건너뛰기</button>
      </div>
    </section>
  );
}

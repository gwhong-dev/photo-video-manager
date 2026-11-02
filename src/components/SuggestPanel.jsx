// 파일 위치: src/components/SuggestPanel.jsx
// 역할: "위치 제안" 탭. 근거 사진과, 그 위치를 넣을 사진들을 묶음별로 하나씩 보여 줘요 (설계서 5절)
//   이 화면 자체가 미리보기예요. 사용자가 버튼을 눌렀을 때만 값이 들어가요
//   사진을 누르면 오른쪽 패널에 크게 보이고, 모서리 체크 칸을 끄면 넣기에서 빠져요
//   기기 정보 없는 사진은 처음에 체크가 꺼져 있어요 (설계서 12절). 넣을 때 건너뛴 사진으로 기억하는 것은
//   사람이 직접 끈 기기 정보 있는 사진뿐이에요. 처음부터 꺼져 있던 사진은 제안에 남아서 뒤쪽 묶음으로 다시 나와요
//   그래서 넣은 뒤에는 보던 묶음에 머물지 않고 맨 앞 묶음으로 가요
//   목록은 gen이 바뀔 때마다 다시 받아요. 화면에 있는 것보다 새 응답은 받고, 그보다 옛 응답만 버려요 (createLoadOrder).
//   마지막 요청의 응답만 받으면, 느린 PC에서 폴더를 읽는 동안 응답마다 새 요청이 나가서 화면이 계속 "계산하는 중"에 머물러요
//   다시 읽기로 근거 사진이 바뀌어 묶음 이름표가 달라져도, 보던 사진이 든 묶음에 머물러 끈 체크가 풀리지 않아요 (settleView)
//   넣기와 건너뛰기는 하는 동안 다시 눌러도 한 번만 실행돼요. 빠른 두 번 누름의 뒤쪽은 다음 묶음에 닿지 않게 받지 않아요

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api.js';
import { checkAllLabel, formatCount, formatTakenAt, gapText, suggestApplyLabel } from '../format.mjs';
import { checkAll, checkedIds, createLoadOrder, finishApply, groupKey, isChecked, isRepeatClick, receiveList, rememberIds } from '../suggest-view.mjs';
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
      {target.noDevice && <span className="suggest-nodevice">기기 정보 없음</span>}
    </div>
  );
}

export default function SuggestPanel({ gen, focusId, onFocus, onApplied, onNotice }) {
  const [data, setData] = useState(null); // { groups, photoCount, skippedCount }
  const [error, setError] = useState('');
  const [view, setView] = useState(null); // { key, flipped } 보여 줄 묶음과 처음 상태에서 바꾼 사진 번호들
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const order = useRef(null); // 요청 번호와 "넣은 뒤" 표시 (createLoadOrder)
  if (!order.current) order.current = createLoadOrder();
  const shown = useRef({ view: null, group: null }); // 지금 보이는 것. 렌더마다 맞추고, 응답을 받으면 receiveList가 바로 적어요

  const load = useCallback(async () => {
    const mine = order.current.next();
    try {
      const next = await api.listSuggestions();
      const got = receiveList(order.current, mine, next.groups, shown.current);
      if (!got) return; // 더 새 응답이 이미 화면에 있어요
      setData(next);
      setError('');
      setView(got.view);
    } catch (e) {
      if (order.current.accept(mine)) setError(errorText(e));
    }
  }, []);
  useEffect(() => { load(); }, [gen, load]);

  const group = data && view ? data.groups.find((g) => groupKey(g) === view.key) : null;
  shown.current.view = view; // 체크를 바꾼 것(flipped)도 다음 응답에 이어지게
  shown.current.group = group;

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
    const flipped = new Set(v.flipped);
    if (flipped.has(id)) flipped.delete(id);
    else flipped.add(id);
    return { ...v, flipped };
  });
  const checkAllTargets = () => setView((v) => ({ ...v, flipped: checkAll(group) }));
  const apply = () => run(async () => {
    const checked = checkedIds(group, view.flipped);
    const left = rememberIds(group, view.flipped); // 사람이 끈 사진만 건너뛴 사진으로 기억해요
    const r = await api.applyEdit(checked, { source: 'copy', sourceId: group.source.id, date: false, time: false, location: true, via: 'suggest' });
    order.current.markApplied(); // 이 뒤에 받는 목록에서는 맨 앞 묶음으로
    if (r.dropped) onNotice(`그 사이 위치가 생긴 ${formatCount(r.dropped)}장은 빼고 넣었어요.`);
    await finishApply(left, skip, (e) => onNotice(errorText(e)), () => onApplied(r));
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

  const checkedCount = checkedIds(group, view.flipped).length;
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
              <TargetCell key={t.id} target={t} checked={isChecked(t, view.flipped)} focused={focusId === t.id} onFocus={onFocus} onToggle={toggle} />
            ))}
          </div>
        </div>
      </div>
      <div className="suggest-actions">
        <button type="button" className="primary" disabled={busy || checkedCount === 0} onClick={(e) => { if (!isRepeatClick(e)) apply(); }}>{suggestApplyLabel(checkedCount) || '넣을 사진을 골라 주세요'}</button>
        <button type="button" disabled={busy || checkedCount === group.targets.length} onClick={(e) => { if (!isRepeatClick(e)) checkAllTargets(); }}>{checkAllLabel(group.targets.length)}</button>
        <button type="button" disabled={busy} onClick={(e) => { if (!isRepeatClick(e)) skipGroup(); }}>이 묶음 건너뛰기</button>
      </div>
    </section>
  );
}

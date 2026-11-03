// 파일 위치: src/components/EditDialog.jsx
// 역할: 날짜와 위치를 넣기 전에 항상 거치는 미리보기 창 (설계서 6, 8절)
//   mode="copy"   : 복사해 둔 사진의 날짜, 시간, 위치 중 넣을 것을 골라요 (기준 사진에 없는 값은 꺼져 있어요)
//   mode="direct" : 달력과 시간을 직접 골라요 (시간 기본 12:00:00)
//   mode="map"    : 지도에서 위치를 골라요 (MapPicker). 핀을 놓을 때마다 미리보기를 다시 만들어요
//   칸이 바뀔 때마다 main에 미리보기를 다시 부탁하고, 늦게 온 옛 응답은 버려요 (요청 번호)
//   현재 칸에 맞는 미리보기가 도착하기 전에는 넣기 버튼이 꺼져 있어요. 넣는 중에는 다시 눌러도 한 번만 저장돼요
//   창에 보이는 대상 장수는 고른 장수가 아니라 main이 계산한 값이에요 (사라진 사진과 기준 사진은 빠져요)
//   미리보기 오류는 창 안에 보이고 넣기 버튼은 꺼져요. 넣기 오류는 창을 연 채로 보여요

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../api.js';
import { applyLabel, formatCoords, formatCount, formatTakenAt } from '../format.mjs';
import { nextPin } from '../map-view.mjs';
import MapPicker from './MapPicker.jsx';

const DEFAULT_TIME = '12:00:00'; // 직접 넣기의 시간 기본값
const PICK_NONE = { date: false, time: false, location: false };

// 오늘 날짜 'YYYY-MM-DD' (달력에서 올해를 넘기지 못하게)
function todayText() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 기준 사진에 어떤 값이 있는지
function sourceHas(source) {
  const takenAt = source && typeof source.takenAt === 'string' ? source.takenAt : '';
  return {
    date: /^\d{4}-\d{2}-\d{2}/.test(takenAt),
    time: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(takenAt),
    location: !!source && typeof source.lat === 'number' && typeof source.lng === 'number',
  };
}

// 붙여넣기 칸의 처음 선택: 기준에 있는 값만. 보통은 위치만, 날짜 없음 탭에서 열었으면 날짜와 시간
function firstPick(has, prefer) {
  if (prefer === 'date' && has.date) return { date: true, time: has.time, location: false };
  if (has.location) return { ...PICK_NONE, location: true };
  if (has.date) return { date: true, time: has.time, location: false };
  return PICK_NONE;
}

// type="time" 값은 초가 0이면 "12:00"으로 줄여 줄 수 있어서 "12:00:00"으로 맞춰요
function fullTime(text) {
  if (/^\d{2}:\d{2}$/.test(text)) return `${text}:00`;
  return /^\d{2}:\d{2}:\d{2}$/.test(text) ? text : DEFAULT_TIME;
}

// 목록에 보여 줄 값 하나 (없으면 경고 노랑 "정보 없음")
function Value({ text }) {
  return text ? <span>{text}</span> : <span className="missing">정보 없음</span>;
}

// 파일 한 줄의 바뀌는 칸들을 만들어요: 바뀌는 것만 (날짜 시간 이름표만 바뀌는 경우는 날짜 줄을 보여 줘요)
function changeLines(item, kind) {
  const lines = [];
  const wantDate = kind === 'date' || kind === 'both';
  const wantLoc = kind === 'location' || kind === 'both';
  const dateDiff = item.before.takenAt !== item.after.takenAt;
  const locDiff = item.before.lat !== item.after.lat || item.before.lng !== item.after.lng;
  if (wantDate && (dateDiff || !locDiff)) {
    lines.push({ key: 'date', label: '날짜', before: formatTakenAt(item.before.takenAt), after: formatTakenAt(item.after.takenAt) });
  }
  if (wantLoc && (locDiff || !dateDiff)) {
    lines.push({ key: 'loc', label: '위치', before: formatCoords(item.before.lat, item.before.lng), after: formatCoords(item.after.lat, item.after.lng) });
  }
  return lines;
}

// mode, ids(고른 사진 번호들. 열 때의 것을 그대로 써요), source(복사해 둔 값), prefer('date'면 날짜부터 켬)
// onClose(): 그만두기, onApplied(결과): 넣기가 끝났을 때 (창은 App이 닫아요)
// startAt(지도를 처음 보여 줄 곳), onPinChosen(핀): 지도로 넣기가 끝났을 때 고른 곳을 알려요
export default function EditDialog({ mode, ids, source, prefer, startAt, onPinChosen, onClose, onApplied }) {
  const copy = mode === 'copy';
  const map = mode === 'map';
  const has = useMemo(() => sourceHas(source), [source]);
  const [pick, setPick] = useState(() => (copy ? firstPick(has, prefer) : PICK_NONE));
  const [day, setDay] = useState('');
  const [time, setTime] = useState(DEFAULT_TIME);
  const [pin, setPin] = useState(null); // 지도에서 고른 곳 { lat, lng }
  const [pv, setPv] = useState({ key: null, loading: false, preview: null, error: '' });
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const busy = useRef(false); // 같은 순간에 두 번 눌러도 한 번만 저장하려고 (state는 다음 그림에야 바뀌어서)
  const seq = useRef(0); // 미리보기 요청 번호
  const dialogRef = useRef(null);
  const maxDay = useMemo(todayText, []);

  // 지금 칸으로 만든 요청. 아직 다 안 골랐으면 null 과 이유
  let edit = null;
  let pending = '';
  if (copy) {
    if (!pick.date && !pick.location) pending = '넣을 항목을 골라 주세요';
    else edit = { source: 'copy', sourceId: source.id, date: pick.date, time: pick.date && pick.time, location: pick.location };
  } else if (map) {
    if (pin) edit = { source: 'pin', lat: pin.lat, lng: pin.lng };
    else pending = '지도에서 위치를 골라 주세요';
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    pending = '날짜를 골라 주세요';
  } else {
    edit = { source: 'direct', date: day, time: fullTime(time) };
  }
  const key = edit ? JSON.stringify(edit) : null;

  // ---------- 미리보기 부탁하기 ----------
  useEffect(() => {
    const mine = ++seq.current;
    if (!edit) {
      setPv({ key: null, loading: false, preview: null, error: '' });
      return;
    }
    setPv((p) => ({ ...p, key, loading: true, error: '' })); // 옛 목록은 흐리게 남겨 두고 새 응답을 기다려요
    api.previewEdit(ids, edit).then(
      (preview) => { if (mine === seq.current) setPv({ key, loading: false, preview, error: '' }); },
      (e) => { if (mine === seq.current) setPv({ key, loading: false, preview: null, error: errorText(e) }); },
    );
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Esc로 닫기, Tab이 창 밖으로 나가지 않게, 닫으면 초점을 원래 자리로 ----------
  const escState = useRef({ applying, onClose });
  escState.current = { applying, onClose };
  useEffect(() => {
    const opener = document.activeElement; // 창을 열기 전에 초점이 있던 곳
    const first = dialogRef.current && dialogRef.current.querySelector('input:not(:disabled)');
    (first || dialogRef.current).focus();
    // Esc는 문서 전체에서 받아요: 배경을 눌러 초점이 창 밖으로 나가도 닫히게
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (!escState.current.applying) escState.current.onClose();
    };
    document.addEventListener('keydown', onEsc, true);
    return () => {
      document.removeEventListener('keydown', onEsc, true);
      // 열기 전 자리가 아직 화면에 있으면 거기로 돌려놓아요 (메뉴처럼 사라졌으면 그대로 둬요)
      if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, []);
  // 배경을 눌러도 초점이 창 안에 남게 해요
  const keepFocus = (e) => {
    if (e.target === e.currentTarget) e.preventDefault();
  };
  const onKeyDown = (e) => {
    if (e.key !== 'Tab') return;
    // 지도 칸과 핀(tabindex), 확대 버튼(링크)도 Tab으로 갈 수 있어서 같이 세요
    const items = [...dialogRef.current.querySelectorAll('input:not(:disabled), button:not(:disabled), a[href], [tabindex="0"]')];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // ---------- 결과 읽기 ----------
  const fresh = !!edit && pv.key === key; // 지금 칸에 맞는 응답(또는 기다리는 중)인지
  const preview = edit && pv.preview ? pv.preview : null; // 칸을 바꾼 직후에는 옛 목록을 흐리게 보여 줘요
  const stale = !!preview && (!fresh || pv.loading);
  const counts = preview ? preview.counts : null;
  const label = counts ? applyLabel(counts.changed, preview.kind) : '';
  const ready = fresh && !pv.loading && !pv.error && !!preview && !!label && !applying;

  let buttonText = label;
  if (applying) buttonText = '넣는 중';
  else if (!edit) buttonText = pending;
  else if (pv.error) buttonText = '넣을 수 없어요';
  else if (!fresh || pv.loading || !preview) buttonText = '미리보기 만드는 중';
  else if (!label) buttonText = '바꿀 사진이 없어요';

  const apply = async () => {
    if (!ready || busy.current) return;
    busy.current = true;
    setApplying(true);
    setApplyError('');
    try {
      const result = await api.applyEdit(ids, edit);
      if (map && onPinChosen) onPinChosen(pin); // 다음에 지도 창을 열 때의 처음 위치
      onApplied(result); // 창은 App이 닫아요. 여기서는 다시 누를 수 없게 그대로 둬요
    } catch (e) {
      setApplyError(errorText(e));
      busy.current = false;
      setApplying(false);
    }
  };

  const togglePick = (name) => setPick((p) => {
    const next = { ...p, [name]: !p[name] };
    if (!next.date) next.time = false; // 시간은 날짜와 함께일 때만
    return next;
  });

  // ---------- 그리기 ----------
  const takenText = source ? formatTakenAt(source.takenAt) : '';
  const dateOnlyText = source ? formatTakenAt(String(source.takenAt || '').slice(0, 10)) : '';
  const timeText = has.time && takenText.startsWith(dateOnlyText) ? takenText.slice(dateOnlyText.length).trim() : '';
  const total = counts ? counts.changed + counts.same : 0;

  return (
    <div className="dialog-backdrop" onMouseDown={keepFocus}>
      <div ref={dialogRef} className={`dialog${map ? ' map-dialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby="edit-title" tabIndex={-1} onKeyDown={onKeyDown}>
        <h2 id="edit-title" className="dialog-title">{copy ? '붙여넣기' : map ? '지도에서 위치 고르기' : '날짜 직접 넣기'}</h2>

        {map ? (
          <div className="dialog-pick">
            <MapPicker value={pin} onChange={(next) => setPin((p) => nextPin(p, next, applying))} startAt={startAt} disabled={applying} />
            <p className="map-coords">{pin ? `고른 위치 ${formatCoords(pin.lat, pin.lng)}${pin.name ? ` (${pin.name})` : ''}` : '지도를 누르면 핀이 놓여요. 핀은 끌어서 옮길 수 있어요.'}</p>
          </div>
        ) : copy ? (
          <fieldset className="dialog-pick">
            <legend className="dialog-sub">기준 사진 {source.name}. 이 사진은 대상에서 빠져요</legend>
            <label className={has.date ? '' : 'off'}>
              <input type="checkbox" checked={pick.date} disabled={!has.date} onChange={() => togglePick('date')} />
              <span>날짜</span>
              <span className="dialog-value">{has.date ? dateOnlyText : '기준 사진에 없어요'}</span>
            </label>
            <label className={has.time && pick.date ? '' : 'off'}>
              <input type="checkbox" checked={pick.time} disabled={!has.time || !pick.date} onChange={() => togglePick('time')} />
              <span>시간</span>
              <span className="dialog-value">{has.time ? timeText : has.date ? '기준 사진에 없어요' : ''}</span>
            </label>
            <label className={has.location ? '' : 'off'}>
              <input type="checkbox" checked={pick.location} disabled={!has.location} onChange={() => togglePick('location')} />
              <span>위치</span>
              <span className="dialog-value">{has.location ? formatCoords(source.lat, source.lng) : '기준 사진에 없어요'}</span>
            </label>
            <p className="dialog-sub">날짜와 시간을 함께 고르면 사진마다 1초씩 늘려서 넣어요. 날짜만 고르면 각 사진의 시간은 그대로예요.</p>
          </fieldset>
        ) : (
          <div className="dialog-pick">
            <label>
              <span>날짜</span>
              <input type="date" value={day} min="1900-01-01" max={maxDay} onChange={(e) => setDay(e.target.value)} />
            </label>
            <label>
              <span>시간</span>
              <input type="time" step="1" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
            <p className="dialog-sub">여러 장이면 사진마다 1초씩 늘려서 넣어요. 시간대는 +09:00이에요.</p>
          </div>
        )}

        <div className="dialog-body">
          {pv.error && edit && <p className="dialog-error" role="alert">{pv.error}</p>}
          {counts && !pv.error && (
            <div className={stale ? 'stale' : ''}>
              <p className="dialog-counts">
                <span>대상 {formatCount(total)}장</span>
                <span>바뀜 {formatCount(counts.changed)}장</span>
                <span>그대로 {formatCount(counts.same)}장</span>
                {counts.overwrite > 0 && <span className="warn">원래 값이 있음 {formatCount(counts.overwrite)}장</span>}
                {counts.excluded > 0 && <span>제외 {formatCount(counts.excluded)}장</span>}
              </p>
              {counts.excluded > 0 && <p className="dialog-sub dialog-note">제외한 사진은 기준 사진이거나 폴더에서 사라진 사진이에요.</p>}
              {preview.items.length > 0 ? (
                <ul className="edit-list" aria-label="바뀌는 내용">
                  {preview.items.map((it) => (
                    <li key={it.id} className={`edit-row${it.hadValue ? ' had' : ''}`}>
                      <span className="edit-name">{it.name}</span>
                      <span className="edit-values">
                        {it.status === 'same'
                          ? <span className="edit-same">그대로</span>
                          : changeLines(it, preview.kind).map((l) => (
                            <span key={l.key} className="edit-line">
                              <span className="edit-kind">{l.label}</span>
                              <Value text={l.before} /> <span className="edit-arrow" aria-hidden="true">→</span> <Value text={l.after} />
                            </span>
                          ))}
                      </span>
                    </li>
                  ))}
                  {preview.more > 0 && <li className="edit-more">외 {formatCount(preview.more)}장</li>}
                </ul>
              ) : (
                <p className="dialog-sub">대상이 되는 사진이 없어요.</p>
              )}
            </div>
          )}
          {!edit && <p className="dialog-sub">{pending}. 고르면 바뀌는 내용을 먼저 보여 드려요.</p>}
        </div>

        {applyError && <p className="dialog-error" role="alert">{applyError}</p>}
        <div className="dialog-foot">
          <button type="button" onClick={onClose} disabled={applying}>그만두기</button>
          <button type="button" className="primary" onClick={apply} disabled={!ready}>{buttonText}</button>
        </div>
      </div>
    </div>
  );
}

// 파일 위치: src/components/TagDialog.jsx
// 역할: 태그를 붙이거나 떼기 전에 항상 거치는 미리보기 창 (단계 5)
//   mode="tagAdd"    : 태그 이름을 적어요 (있는 태그 이름을 보여 줘서 골라 쓸 수 있어요)
//   mode="tagRemove" : 고른 사진들에 내가 붙인 태그 중 하나를 골라요
//   이름이 바뀔 때마다 main에 미리보기를 다시 부탁하고, 늦게 온 옛 응답은 버려요 (요청 번호)
//   지금 이름에 맞는 미리보기가 오기 전에는 실행 버튼이 꺼져 있어요. 100장 이상이면 장수 확인 체크를 한 번 더 받아요
//   태그는 DB와 기록 파일에만 저장돼요. 사진 파일에는 쓰지 않아요

import React, { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api.js';
import { formatCount, manyCheckText, needsManyCheck, tagApplyLabel } from '../format.mjs';

const NAME_DELAY_MS = 200; // 입력을 멈추고 이 시간이 지나면 미리보기

// mode, ids(열 때 고른 사진 번호들), onClose(), onApplied(결과)
export default function TagDialog({ mode, ids, onClose, onApplied }) {
  const adding = mode === 'tagAdd';
  const [text, setText] = useState(''); // 붙이기: 적고 있는 이름
  const [name, setName] = useState(''); // 미리보기를 부탁할 이름 (붙이기는 입력을 멈춘 뒤, 떼기는 고른 것)
  const [known, setKnown] = useState([]); // 붙이기: 있는 태그 이름들, 떼기: 고른 사진들의 태그와 장수
  const [knownError, setKnownError] = useState('');
  const [pv, setPv] = useState({ key: null, loading: false, preview: null, error: '' });
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [manyOk, setManyOk] = useState(null);
  const busy = useRef(false);
  const seq = useRef(0);
  const dialogRef = useRef(null);

  // 고를 목록 읽기
  useEffect(() => {
    let alive = true;
    const load = adding
      ? api.tagList().then((r) => [...r.manual, ...r.album].map((t) => t.name).filter((n, i, all) => all.indexOf(n) === i))
      : api.selectionTags(ids);
    load.then(
      (list) => { if (alive) setKnown(list); },
      (e) => { if (alive) setKnownError(errorText(e)); },
    );
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 붙이기: 입력을 멈추고 0.2초 뒤에 미리보기 이름으로
  useEffect(() => {
    if (!adding) return undefined;
    const timer = setTimeout(() => setName(text), NAME_DELAY_MS);
    return () => clearTimeout(timer);
  }, [adding, text]);

  const edit = name.trim() ? { op: adding ? 'add' : 'remove', name } : null;
  const key = edit ? JSON.stringify(edit) : null;
  useEffect(() => {
    const mine = ++seq.current;
    if (!edit) {
      setPv({ key: null, loading: false, preview: null, error: '' });
      return;
    }
    setPv((p) => ({ ...p, key, loading: true, error: '' }));
    api.previewTag(ids, edit).then(
      (preview) => { if (mine === seq.current) setPv({ key, loading: false, preview, error: '' }); },
      (e) => { if (mine === seq.current) setPv({ key, loading: false, preview: null, error: errorText(e) }); },
    );
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Esc로 닫기, Tab이 창 밖으로 나가지 않게, 닫으면 초점을 원래 자리로 (EditDialog와 같아요) ----------
  const escState = useRef({ applying, onClose });
  escState.current = { applying, onClose };
  useEffect(() => {
    const opener = document.activeElement;
    const first = dialogRef.current && dialogRef.current.querySelector('input:not(:disabled), button.tag-choice');
    (first || dialogRef.current).focus();
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (!escState.current.applying) escState.current.onClose();
    };
    document.addEventListener('keydown', onEsc, true);
    return () => {
      document.removeEventListener('keydown', onEsc, true);
      if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, []);
  const keepFocus = (e) => {
    if (e.target === e.currentTarget) e.preventDefault();
  };
  const onKeyDown = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...dialogRef.current.querySelectorAll('input:not(:disabled), button:not(:disabled)')];
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
  const typing = adding && text !== name; // 아직 입력을 멈추지 않았어요
  const fresh = !!edit && pv.key === key && !typing;
  const preview = edit && pv.preview ? pv.preview : null;
  const stale = !!preview && (!fresh || pv.loading);
  const counts = preview ? preview.counts : null;
  const label = counts ? tagApplyLabel(counts.changed, preview.kind, preview.name) : '';
  const many = !!counts && needsManyCheck(counts.changed);
  const manyChecked = manyOk === key;
  const ready = fresh && !pv.loading && !pv.error && !!label && !applying && (!many || manyChecked);

  let buttonText = label;
  if (applying) buttonText = adding ? '붙이는 중' : '떼는 중';
  else if (!edit) buttonText = adding ? '태그 이름을 적어 주세요' : '뗄 태그를 골라 주세요';
  else if (pv.error) buttonText = adding ? '붙일 수 없어요' : '뗄 수 없어요';
  else if (!fresh || pv.loading || !preview) buttonText = '미리보기 만드는 중';
  else if (!label) buttonText = adding ? '모두 이미 붙어 있어요' : '바꿀 사진이 없어요';
  else if (many && !manyChecked) buttonText = '위의 장수를 확인해 주세요';

  const apply = async () => {
    if (!ready || busy.current) return;
    busy.current = true;
    setApplying(true);
    setApplyError('');
    try {
      onApplied(await api.applyTag(ids, edit));
    } catch (e) {
      setApplyError(errorText(e));
      busy.current = false;
      setApplying(false);
    }
  };
  const onEnter = (e) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      apply();
    }
  };

  const total = counts ? counts.changed + counts.same : 0;
  return (
    <div className="dialog-backdrop" onMouseDown={keepFocus}>
      <div ref={dialogRef} className="dialog tag-dialog" role="dialog" aria-modal="true" aria-labelledby="tag-title" tabIndex={-1} onKeyDown={onKeyDown}>
        <h2 id="tag-title" className="dialog-title">{adding ? '태그 붙이기' : '태그 떼기'}</h2>

        <div className="dialog-pick">
          {adding ? (
            <>
              <label>
                <span>이름</span>
                <input type="text" className="tag-input" list="tag-names" maxLength={40} value={text} disabled={applying}
                  placeholder="예: 여행, 가족, 공연" onChange={(e) => setText(e.target.value)} onKeyDown={onEnter} />
              </label>
              <datalist id="tag-names">{known.map((n) => <option key={n} value={n} />)}</datalist>
              <p className="dialog-sub">태그는 이 프로그램 안에만 저장돼요. 사진 파일은 바뀌지 않아요.</p>
            </>
          ) : known.length > 0 ? (
            <div className="tag-choices" role="radiogroup" aria-label="뗄 태그">
              {known.map((t) => (
                <button key={t.name} type="button" role="radio" aria-checked={name === t.name}
                  className={`tag-choice${name === t.name ? ' on' : ''}`} disabled={applying} onClick={() => setName(t.name)}>
                  {t.name} <span className="menu-count">{formatCount(t.count)}</span>
                </button>
              ))}
            </div>
          ) : (
            !knownError && <p className="dialog-sub">고른 사진에 내가 붙인 태그가 없어요. 앨범에서 가져온 태그는 뗄 수 없어요.</p>
          )}
          {knownError && <p className="dialog-error" role="alert">{knownError}</p>}
        </div>

        <div className="dialog-body">
          {pv.error && edit && <p className="dialog-error" role="alert">{pv.error}</p>}
          {counts && !pv.error && (
            <div className={stale ? 'stale' : ''}>
              <p className="dialog-counts">
                <span>대상 {formatCount(total)}장</span>
                <span>바뀜 {formatCount(counts.changed)}장</span>
                <span>그대로 {formatCount(counts.same)}장</span>
                {counts.excluded > 0 && <span>제외 {formatCount(counts.excluded)}장</span>}
              </p>
              {counts.excluded > 0 && <p className="dialog-sub dialog-note">제외한 사진은 폴더에서 사라진 사진이에요.</p>}
              {many && (
                <label className="dialog-many">
                  <input type="checkbox" checked={manyChecked} disabled={applying || stale} onChange={(e) => setManyOk(e.target.checked ? key : null)} />
                  <span>{manyCheckText(counts.changed)}</span>
                </label>
              )}
              <ul className="edit-list" aria-label="바뀌는 내용">
                {preview.items.map((it) => (
                  <li key={it.id} className="edit-row">
                    <span className="edit-name">{it.name}</span>
                    <span className="edit-values">
                      {it.status === 'same'
                        ? <span className="edit-same">{adding ? '이미 붙어 있음' : '이 태그 없음'}</span>
                        : <span className="edit-line">{adding ? `'${preview.name}' 붙임` : `'${preview.name}' 뗌`}</span>}
                    </span>
                  </li>
                ))}
                {preview.more > 0 && <li className="edit-more">외 {formatCount(preview.more)}장</li>}
              </ul>
            </div>
          )}
          {!edit && <p className="dialog-sub">{adding ? '이름을 적으면' : '태그를 고르면'} 바뀌는 사진을 먼저 보여 드려요.</p>}
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

// 파일 위치: src/components/TagManageDialog.jsx
// 역할: 내가 만든 태그 관리 창 (2026-11-18 사용자 승인)
//   mode="create" : 새 태그 만들기. 사진 없이도 목록에 남아요 (0장)
//   mode="rename" : 이름 바꾸기. 같은 이름의 내 태그가 이미 있으면 "합칠까요?"를 한 번 더 물어요
//   mode="delete" : 지우기. 붙은 장수를 보여 주고, 태그만 떼요 (사진 · 영상 파일은 그대로). 지운 뒤 되돌리기 줄이 떠요
//   바꾼 것은 DB와 기록 파일에 먼저 저장돼요. 파일에는 "N장 파일에 태그 쓰기"를 눌러야 써요 (31 ②)

import React, { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api.js';
import { formatCount } from '../format.mjs';

// 실행 버튼 글 (결과를 말해요)
function createLabel(name) {
  return name ? `'${name}' 태그 만들기` : '태그 이름을 적어 주세요';
}
function renameLabel(count) {
  return count > 0 ? `${formatCount(count)}장의 태그 이름 바꾸기` : '태그 이름 바꾸기';
}
function mergeLabel(count, from, to) {
  return count > 0 ? `${formatCount(count)}장을 '${to}' 태그로 합치기` : `'${from}'을 '${to}' 태그로 합치기`;
}
function deleteLabel(count, name) {
  return count > 0 ? `${formatCount(count)}장에서 '${name}' 태그 지우기` : `'${name}' 태그 지우기`;
}

// tag = { name, count, hotkey } (create 는 없음), onClose(), onDone(결과, 알림 글)
export default function TagManageDialog({ mode, tag, onClose, onDone }) {
  const [text, setText] = useState(mode === 'rename' ? tag.name : '');
  const [merge, setMerge] = useState(null); // 이름 바꾸기에서 합치기를 물을 때 { from, to, count, toCount }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const cancelRef = useRef(null);

  // 열리면 입력 칸(지우기는 "그만두기")에 초점, Esc 로 닫기 (하는 중에는 안 닫혀요). 닫히면 원래 자리로 초점
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement;
    const first = mode === 'delete' ? cancelRef.current : inputRef.current;
    if (first) {
      first.focus();
      if (mode === 'rename' && first.select) first.select();
    }
    const onKey = (e) => {
      if (e.key !== 'Escape' || busyRef.current) return;
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Tab 이 창 밖으로 나가지 않게
  const onTrap = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...dialogRef.current.querySelectorAll('input:not(:disabled), button:not(:disabled)')];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const run = async (fn) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const name = text.trim();
  const go = () => run(async () => {
    if (mode === 'create') {
      const r = await api.createTag(text);
      onDone(r, `'${r.name}' 태그를 만들었어요. 사진을 고른 뒤 붙이거나, 숫자를 정해 단축키로 붙일 수 있어요.`);
    } else if (mode === 'delete') {
      const r = await api.deleteTag(tag.name);
      onDone(r, `'${r.name}' 태그를 지웠어요.`);
    } else if (merge) {
      const r = await api.renameTag(merge.from, merge.to, true);
      onDone(r, `'${r.from}' 태그를 '${r.name}' 태그로 합쳤어요.`);
    } else {
      // 먼저 같은 이름이 있는지 물어보고, 있으면 합치기를 한 번 더 확인받아요
      const pv = await api.previewTagRename(tag.name, text);
      if (pv.merge) {
        setMerge(pv);
        return;
      }
      const r = await api.renameTag(tag.name, text, false);
      onDone(r, `태그 이름을 '${r.name}'(으)로 바꿨어요.`);
    }
  });
  const onEnter = (e) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (name) go();
    }
  };

  let title = '새 태그 만들기';
  let button = createLabel(name);
  if (mode === 'rename') {
    title = merge ? '태그 합치기' : '태그 이름 바꾸기';
    button = merge ? mergeLabel(merge.count, merge.from, merge.to) : renameLabel(tag.count);
  } else if (mode === 'delete') {
    title = '태그 지우기';
    button = deleteLabel(tag.count, tag.name);
  }
  if (busy) button = '하는 중';
  const canGo = !busy && (mode === 'delete' || !!name);

  return (
    <div className="dialog-backdrop">
      <div ref={dialogRef} className="dialog tag-dialog tag-manage" role="dialog" aria-modal="true" aria-labelledby="tag-manage-title" onKeyDown={onTrap}>
        <h2 id="tag-manage-title" className="dialog-title">{title}</h2>
        <div className="dialog-pick">
          {mode === 'delete' ? (
            <>
              <p>{tag.count > 0 ? `'${tag.name}' 태그가 붙은 ${formatCount(tag.count)}장에서 이 태그만 떼요.` : `'${tag.name}' 태그에는 붙은 사진이 없어요.`}</p>
              <p className="dialog-sub">사진과 영상 파일은 '파일에 태그 쓰기'를 누르기 전까지 그대로예요.{tag.count > 0 ? ' 지운 뒤 바로 되돌릴 수 있어요.' : ''}</p>
            </>
          ) : merge ? (
            <>
              <p>{`'${merge.to}' 태그가 이미 있어요 (${formatCount(merge.toCount)}장).`}</p>
              <p className="dialog-sub">{`합치면 '${merge.from}'이 붙은 ${formatCount(merge.count)}장에 '${merge.to}'가 붙고, '${merge.from}'은 목록에서 빠져요. 사진 파일은 그대로예요.`}</p>
            </>
          ) : (
            <>
              <label>
                <span>이름</span>
                <input ref={inputRef} type="text" className="tag-input" maxLength={40} value={text} disabled={busy}
                  placeholder="예: 여행, 가족, 공연" onChange={(e) => { setText(e.target.value); setError(''); }} onKeyDown={onEnter} />
              </label>
              <p className="dialog-sub">
                {mode === 'rename'
                  ? `'${tag.name}'이 붙은 사진과 영상 모두에 바뀐 이름이 보여요. 사진 파일은 바뀌지 않아요.`
                  : '태그는 이 프로그램 안에만 저장돼요. 사진 파일은 바뀌지 않아요.'}
              </p>
            </>
          )}
          {error && <p className="dialog-error" role="alert">{error}</p>}
        </div>
        <div className="dialog-foot">
          {merge && <button type="button" disabled={busy} onClick={() => setMerge(null)}>다른 이름 적기</button>}
          <button type="button" ref={cancelRef} disabled={busy} onClick={onClose}>그만두기</button>
          <button type="button" className="primary" disabled={!canGo} onClick={go}>{button}</button>
        </div>
      </div>
    </div>
  );
}

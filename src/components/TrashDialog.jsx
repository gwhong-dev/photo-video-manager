// 파일 위치: src/components/TrashDialog.jsx
// 역할: 갤러리에서 고른 사진을 휴지통으로 옮기기 전에 항상 거치는 확인 창 (2026-11-16 사용자 결정)
//   열리면 main 에 미리보기를 부탁해서 몇 장이 어디로(휴지통 / _정리완료원본) 가는지 보여 줘요. 아무것도 옮기지 않아요
//   "N장 휴지통으로 옮기기"를 눌러야 옮겨요. 처음 초점은 "그만두기" (Enter 를 잘못 눌러도 옮기지 않게)
//   영구 삭제는 안 해요. 옮기는 중에는 닫히지 않아요

import React, { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api.js';
import { trashLabel, trashLines } from '../trash-view.mjs';
import { resultText } from '../similar-view.mjs';

// ids = 열 때 고른 사진 번호들, onClose() = 그만두기, onDone(알림 글) = 옮긴 뒤
export default function TrashDialog({ ids, onClose, onDone }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const cancelRef = useRef(null);

  // 미리보기 (몇 장이 어디로)
  useEffect(() => {
    let alive = true;
    api.previewTrash(ids).then(
      (r) => { if (alive) setInfo(r); },
      (e) => { if (alive) setError(errorText(e)); },
    );
    return () => { alive = false; };
  }, [ids]);

  // 열리면 그만두기에 초점, Esc 로 닫기 (옮기는 중에는 안 닫혀요)
  useEffect(() => {
    if (cancelRef.current) cancelRef.current.focus();
    const onKey = (e) => {
      if (e.key !== 'Escape' || busyRef.current) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const go = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const r = await api.trashSelected(ids);
      onDone(resultText(r));
    } catch (e) {
      setError(errorText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="trash-title">
        <h2 id="trash-title" className="dialog-title">고른 사진 옮기기</h2>
        <div className="dialog-pick similar-confirm">
          {!info && !error && <p className="panel-hint">확인하는 중이에요</p>}
          {info && trashLines(info).map((l) => <p key={l}>{l}</p>)}
          {info && <p className="panel-hint">사진 파일은 지우지 않아요. 휴지통에서 되살릴 수 있어요.</p>}
          {error && <p className="panel-hint" role="alert">{error}</p>}
        </div>
        <div className="dialog-foot">
          <button type="button" ref={cancelRef} disabled={busy} onClick={onClose}>그만두기</button>
          <button type="button" className="primary" disabled={busy || !info || !info.count} onClick={go}>{busy ? '옮기는 중' : trashLabel(info)}</button>
        </div>
      </div>
    </div>
  );
}

// 파일 위치: src/components/TrashDialog.jsx
// 역할: 갤러리에서 고른 사진을 휴지통으로 옮기기 전에 항상 거치는 확인 창 (2026-11-16 사용자 결정)
//   열리면 main 에 미리보기를 부탁해서 몇 장이 어디로(휴지통 / _정리완료원본) 가는지 보여 줘요. 아무것도 옮기지 않아요
//   "N장 휴지통으로 옮기기"를 눌러야 옮겨요. 처음 초점은 "그만두기" (Enter 를 잘못 눌러도 옮기지 않게)
//   버튼 글자는 처음부터 고른 장수로 보여 주고, 누르는 건 확인 결과가 온 뒤에만 돼요 (2026-11-21 사용자 지적: 버튼이 1~2초 늦게 떠요)
//   Delete 키: 한 번 = 창 열기(App), 창에서 한 번 더 = 옮기기. 꾹 눌러 반복된 키 · 확인 결과가 나오기 전에 누른 키는 무시해요 (src/trash-view.mjs dialogDeleteAction)
//   영구 삭제는 안 해요. 옮기는 중에는 닫히지 않아요

import React, { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api.js';
import { dialogDeleteAction, trashHint, trashLabel, trashLines } from '../trash-view.mjs';
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
  // 키 처리는 한 번만 걸어서, 지금 값은 ref 로 읽어요
  const goRef = useRef(go);
  goRef.current = go;
  const stateRef = useRef({ info, error });
  stateRef.current = { info, error };

  // 열리면 그만두기에 초점, Esc 로 닫기 (옮기는 중에는 안 닫혀요). 닫히면 열기 전 자리로 초점을 돌려줘요
  //   한 번만 걸어요: App 이 다시 그릴 때마다(폴더 읽기 진행 등) 초점이 "그만두기"로 튀지 않게 (#119 검증 ⚠️)
  //   창을 연 Delete 키는 이 창이 그려지기 전에 끝나서 여기로 오지 않아요 → 옮기려면 한 번 더 눌러야 해요
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement;
    if (cancelRef.current) cancelRef.current.focus();
    const onKey = (e) => {
      if (e.key === 'Delete') {
        e.preventDefault();
        e.stopPropagation(); // 갤러리의 Delete(창 열기)로 가지 않게
        if (dialogDeleteAction(e, { busy: busyRef.current, ...stateRef.current }) === 'go') goRef.current();
        return;
      }
      if (e.key !== 'Escape' || busyRef.current) return;
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, []);

  const ready = !!(info && info.count);
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="trash-title">
        <h2 id="trash-title" className="dialog-title">고른 사진 옮기기</h2>
        <div className="dialog-pick similar-confirm">
          {!info && !error && <p className="panel-hint">어디로 옮길지 확인하는 중이에요</p>}
          {info && trashLines(info).map((l) => <p key={l}>{l}</p>)}
          {info && <p className="panel-hint">{trashHint(info)}</p>}
          {ready && !busy && !error && <p className="panel-hint">Delete 키를 한 번 더 누르면 바로 옮겨요.</p>}
          {error && <p className="panel-hint" role="alert">{error}</p>}
        </div>
        <div className="dialog-foot">
          <button type="button" ref={cancelRef} disabled={busy} onClick={onClose}>그만두기</button>
          <button type="button" className="primary" disabled={busy || !ready} onClick={go} title="Delete 키로도 옮길 수 있어요">{busy ? '옮기는 중' : trashLabel(info, error ? 0 : ids.length)}</button>
        </div>
      </div>
    </div>
  );
}

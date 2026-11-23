// 파일 위치: src/components/RotateBar.jsx
// 역할: 자세히 보기 패널의 돌리기 버튼과 저장 고르기 (2026-11-23 사용자 요청, 나중에 할 일 23)
//   왼쪽 · 오른쪽 버튼을 누르면 위 미리보기만 돌아가요 (파일은 그대로)
//   돌린 뒤에만 저장 버튼이 나와요: "돌린 복사본 저장"(원본 그대로) / "돌린 모습으로 원본 바꾸기"(옛 원본은 휴지통)
//   저장은 main(gallery:rotate)이 해요. 화면은 파일 번호 · 각도 · 방식만 보내요

import React, { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api.js';
import { nextTurn, replaceHint, rotateResultText, turnText } from '../rotate-view.mjs';

// file = 지금 보는 파일, turn = 화면에서 돌린 각도, onTurn(각도) = 돌리기 버튼
export default function RotateBar({ file, turn, onTurn }) {
  const [info, setInfo] = useState(null); // 원본 바꾸기 미리보기 (어디로 옮기는지)
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [ask, setAsk] = useState(0); // 원본 바꾸기가 실패하면 늘려서 미리보기를 다시 물어봐요

  // 처음 돌렸을 때 한 번만 미리보기를 물어봐요 (아무것도 옮기지 않아요)
  //   main 은 미리보기를 한 번 쓰면 잊어요 → 원본 바꾸기가 실패한 뒤에는 새로 물어봐야 다시 누를 수 있어요 (#138 검증 ⚠️)
  const asked = turn !== 0;
  useEffect(() => {
    if (!asked) return undefined;
    let alive = true;
    if (ask === 0) setError(''); // 다시 묻는 중에는 방금 난 오류 글을 지우지 않아요
    api.previewRotate(file.id).then(
      (r) => { if (alive) setInfo(r); },
      (e) => { if (alive) setError(errorText(e)); },
    );
    return () => { alive = false; };
  }, [file.id, asked, ask]);

  const turnBy = (step) => {
    if (busyRef.current) return;
    setDone('');
    onTurn(nextTurn(turn, step));
  };
  const save = async (mode) => {
    if (busyRef.current || !turn) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      const r = await api.rotate(file.id, turn, mode);
      setDone(rotateResultText(r));
      setInfo(null);
      onTurn(0);
    } catch (e) {
      setError(errorText(e));
      if (mode === 'replace') { setInfo(null); setAsk((n) => n + 1); } // 확인 창 내용을 새로 받아 와요
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="rotate-bar">
      <div className="rotate-buttons">
        <button type="button" disabled={busy} onClick={() => turnBy(-90)}>왼쪽으로 돌리기</button>
        <button type="button" disabled={busy} onClick={() => turnBy(90)}>오른쪽으로 돌리기</button>
      </div>
      {turn !== 0 && (
        <div className="rotate-save">
          <p className="detail-sub">{turnText(turn)} 아직 파일은 그대로예요.</p>
          {info && <p className="detail-sub">{replaceHint(info)}</p>}
          <button type="button" className="primary" disabled={busy} onClick={() => save('copy')}>{busy ? '저장하는 중' : '돌린 복사본 저장'}</button>
          <button type="button" disabled={busy || !info} onClick={() => save('replace')}>돌린 모습으로 원본 바꾸기</button>
          <button type="button" disabled={busy} onClick={() => onTurn(0)}>돌리기 취소</button>
        </div>
      )}
      {error && <p className="detail-sub" role="alert">{error}</p>}
      {done && !error && <p className="detail-sub" role="status">{done}</p>}
    </div>
  );
}

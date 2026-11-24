// 파일 위치: src/components/TagWriteDialog.jsx
// 역할: "태그를 파일에 쓰기" 창 (31 ②, docs/decisions/2026-11-23-태그-파일에-쓰기.md)
//   열면 쓸 장수, 형식, 빈 공간만 보여 줘요 (아무것도 쓰지 않아요). 버튼을 눌러야 써요
//   쓰는 동안은 닫을 수 없어요. 끝나면 결과와 못 쓴 사진(이름, 이유)을 보여 줘요
//   못 쓴 사진은 "쓰지 않은 태그"로 남아서, 다시 누르면 남은 것만 이어서 써요

import React, { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api.js';
import { infoLines, resultText, writeButtonText } from '../tag-write-view.mjs';

// onClose(), onDone(결과) — onDone 은 끝날 때마다 불러요 (목록과 띠를 다시 읽게)
export default function TagWriteDialog({ onClose, onDone }) {
  const [info, setInfo] = useState(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const dialogRef = useRef(null);

  const load = () => {
    api.tagWriteInfo().then(setInfo, (e) => setError(errorText(e)));
  };
  useEffect(() => {
    load();
    let off = () => {};
    try {
      off = api.onTagWriteProgress((p) => { if (busy.current) setProgress(p); });
    } catch (e) { /* 진행 알림 없이도 써져요 */ }
    const opener = document.activeElement;
    dialogRef.current.focus();
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (!busy.current) onClose();
    };
    document.addEventListener('keydown', onEsc, true);
    return () => {
      off();
      document.removeEventListener('keydown', onEsc, true);
      if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    if (busy.current || !info || !(info.writable > 0) || !info.enough) return;
    busy.current = true;
    setRunning(true);
    setError('');
    setResult(null);
    setProgress(null);
    try {
      const r = await api.tagWrite();
      setResult(r);
      onDone(r);
    } catch (e) {
      setError(errorText(e));
    } finally {
      busy.current = false;
      setRunning(false);
      load(); // 남은 장수를 다시 읽어요 (못 쓴 것은 그대로 남아요)
    }
  };

  const ready = !!info && !running && info.writable > 0 && info.enough;
  const failed = result && result.failed ? result.failed : [];
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy.current) onClose(); }}>
      <div className="dialog tag-write-dialog" role="dialog" aria-modal="true" aria-labelledby="tag-write-title" tabIndex={-1} ref={dialogRef}>
        <h2 className="dialog-title" id="tag-write-title">태그를 파일에 쓰기</h2>
        <p className="dialog-sub dialog-note">
          붙인 태그를 사진과 영상 파일 안에 써요. 그림과 영상 내용, 수정 시각은 바꾸지 않아요.
          쓴 뒤에 다시 읽어 태그와 내용이 그대로인지 확인해요. 잘못 붙인 태그는 태그를 되돌린 뒤 다시 쓰면 파일도 돌아가요.
        </p>
        <div className="dialog-counts tag-write-lines">
          {infoLines(info).map((l, i) => <span key={i} className={l.warn ? 'tag-write-warn' : undefined}>{l.text}</span>)}
        </div>
        {result && <p className="dialog-sub">{resultText(result)}</p>}
        {failed.length > 0 && (
          <div className="dialog-body tag-write-failed">
            {failed.map((f, i) => (
              <div className="tag-write-row" key={`${f.name}-${i}`}>
                <span className="fill-file">{f.name}</span>
                <span className="dialog-sub">{f.why}</span>
              </div>
            ))}
          </div>
        )}
        {error && <p className="dialog-error">{error}</p>}
        <div className="dialog-foot">
          <button type="button" onClick={onClose} disabled={running}>닫기</button>
          <button type="button" onClick={run} disabled={!ready}>{writeButtonText(info, running, progress)}</button>
        </div>
      </div>
    </div>
  );
}

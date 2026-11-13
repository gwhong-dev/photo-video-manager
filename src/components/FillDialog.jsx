// 파일 위치: src/components/FillDialog.jsx
// 역할: "날짜 없는 사진을 날짜 폴더로 옮기기" 미리보기 창 (정보 없는 사진 > 날짜 없음 탭)
//   열면 바로 후보를 계산해요 (아무것도 옮기지 않아요). 버튼을 눌러야 옮겨요.
//   앨범 정보(AlbumInfo.json)를 못 찾은 사진이 있으면 앨범 폴더를 직접 고를 수 있어요 (고르면 후보를 다시 계산)
//   옮기기만 하고 삭제하지 않아요. 끝난 뒤에는 되돌리기 줄(FillBanner)에서 한 번에 되돌릴 수 있어요

import React, { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api.js';

const STATE_TEXT = {
  move: '옮기기',
  dup: '이미 있어요, 옮기지 않아요',
  protected: '내가 넣은 정보가 있어요',
  ambiguous: '날짜가 둘이라 건너뛰어요',
  nodate: '날짜를 못 찾았어요',
};
const HOW_TEXT = { job: '가져온 원본 폴더의 앨범 정보', folder: '고른 앨범 폴더의 앨범 정보' };
const n = (v) => v.toLocaleString('en-US');

// onClose(), onDone(결과)
export default function FillDialog({ onClose, onDone }) {
  const [pv, setPv] = useState({ loading: true, data: null, error: '' });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const busy = useRef(false);
  const dialogRef = useRef(null);

  const load = () => {
    const mine = ++seq.current;
    setPv((p) => ({ ...p, loading: true, error: '' }));
    api.fillPreview().then(
      (data) => { if (mine === seq.current) setPv({ loading: false, data, error: '' }); },
      (e) => { if (mine === seq.current) setPv({ loading: false, data: null, error: errorText(e) }); },
    );
  };
  useEffect(() => {
    load();
    const opener = document.activeElement;
    dialogRef.current.focus();
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (!busy.current) onClose();
    };
    document.addEventListener('keydown', onEsc, true);
    return () => {
      document.removeEventListener('keydown', onEsc, true);
      if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pickFolder = async () => {
    setError('');
    try {
      const r = await api.fillPickFolder();
      if (r.picked) load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const clearFolders = async () => {
    setError('');
    try {
      await api.fillClearFolders();
      load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const run = async () => {
    if (busy.current || !pv.data || !pv.data.counts.move) return;
    busy.current = true;
    setRunning(true);
    setError('');
    try {
      onDone(await api.fillRun(pv.data.token));
    } catch (e) {
      setError(errorText(e));
      busy.current = false;
      setRunning(false);
    }
  };

  const d = pv.data;
  const c = d ? d.counts : null;
  const ready = !!c && !pv.loading && !running && c.move > 0;
  let buttonText = '후보를 찾는 중';
  if (running) buttonText = '옮기는 중';
  else if (c && !pv.loading) buttonText = c.move > 0 ? `${n(c.move)}장 날짜 폴더로 옮기기` : '옮길 사진이 없어요';

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy.current) onClose(); }}>
      <div className="dialog fill-dialog" role="dialog" aria-modal="true" aria-labelledby="fill-title" tabIndex={-1} ref={dialogRef}>
        <h2 className="dialog-title" id="fill-title">날짜 후보 확인하기</h2>
        <p className="dialog-sub dialog-note">앨범 정보에서 찾은 날짜로 사진을 날짜 폴더로 옮겨요. 사진 내용은 바꾸지 않고, 지우지 않아요. 옮긴 뒤에는 한 번에 되돌릴 수 있어요.</p>
        {pv.error && <p className="dialog-error">{pv.error}</p>}
        {c && (
          <div className="dialog-counts">
            <span>옮길 수 있음 {n(c.move)}장</span>
            {c.dup > 0 && <span>이미 있음 {n(c.dup)}장</span>}
            {c.protected > 0 && <span>내가 넣은 정보가 있음 {n(c.protected)}장</span>}
            {c.ambiguous > 0 && <span className="warn">날짜가 둘이라 건너뜀 {n(c.ambiguous)}장</span>}
            <span className="warn">날짜를 못 찾음 {n(c.noDate)}장</span>
          </div>
        )}
        <div className={`dialog-body fill-list${pv.loading ? ' stale' : ''}`}>
          {pv.loading && !d && <p className="dialog-sub">날짜 후보를 찾는 중이에요</p>}
          {d && d.items.map((it, i) => (
            <div className="fill-row" key={`${it.name}-${i}`}>
              <div className="fill-name">
                <span className="fill-file">{it.name}</span>
                {it.status === 'move' && <span className="dialog-sub fill-file">{it.newName}</span>}
              </div>
              <div className="fill-day">{it.day || ''}</div>
              <div className="dialog-sub">{it.status === 'move' ? `${STATE_TEXT.move}, ${HOW_TEXT[it.via] || ''}` : (it.note || STATE_TEXT[it.status])}</div>
            </div>
          ))}
          {d && d.more > 0 && <p className="dialog-sub">그 밖에 {n(d.more)}장이 더 있어요</p>}
          {d && d.items.length === 0 && !pv.loading && <p className="dialog-sub">날짜 없음 폴더에 사진이 없어요.</p>}
        </div>
        {c && c.noDate + c.ambiguous > 0 && !pv.loading && (
          <p className="dialog-sub">
            날짜를 못 찾은 사진이 있어요. 가져올 때 쓴 iCloud 공유 앨범 폴더가 그대로 있다면 그 폴더를 골라 주세요.
            {d.folders.length > 0 && ` 고른 폴더: ${d.folders.join(', ')}`}
          </p>
        )}
        {error && <p className="dialog-error">{error}</p>}
        <div className="dialog-foot">
          <button type="button" className="link-button" onClick={pickFolder} disabled={running || pv.loading}>앨범 폴더 고르기</button>
          {d && d.folders.length > 0 && <button type="button" className="link-button" onClick={clearFolders} disabled={running || pv.loading}>고른 폴더 지우기</button>}
          <button type="button" onClick={onClose} disabled={running}>닫기</button>
          <button type="button" onClick={run} disabled={!ready}>{buttonText}</button>
        </div>
      </div>
    </div>
  );
}

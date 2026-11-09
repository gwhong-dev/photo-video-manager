// 파일 위치: src/components/CleanView.jsx
// 역할: "정리" 화면 가운데 (사용자 승인 2026-11-09, 가 = 기록 보기, 읽기만)
//   위: 가져올 폴더 · 백업 폴더의 _정리완료원본 (파일 수, 크기, 폴더 열기)
//   아래: 정리 기록 (원본 정리, 비슷한 사진 버리기). 누르면 오른쪽 패널(CleanPanel)에 그 기록의 파일들이 나와요
//   아무것도 옮기거나 지우지 않아요

import React, { useEffect, useState } from 'react';
import { api, errorText } from '../api.js';
import { formatBytes } from '../format.mjs';
import EmptyState from './EmptyState.jsx';

const num = (n) => n.toLocaleString('en-US');

// picked = 고른 기록 id, onPick(기록 또는 null)
export default function CleanView({ gen, picked, onPick }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [openError, setOpenError] = useState('');

  useEffect(() => {
    let alive = true;
    api.cleanHistory().then(
      (d) => {
        if (!alive) return;
        setData(d);
        setError('');
      },
      (e) => { if (alive) setError(errorText(e)); },
    );
    return () => { alive = false; };
  }, [gen]);

  const openFolder = async (which) => {
    setOpenError('');
    try {
      await api.openCleaned(which);
    } catch (e) {
      setOpenError(errorText(e));
    }
  };

  if (error) {
    return <EmptyState title="정리 기록을 불러오지 못했어요">{error}</EmptyState>;
  }
  if (!data) return null; // 받는 중

  return (
    <div className="clean-view">
      <h2 className="clean-heading">정리한 원본을 옮겨 둔 폴더 (_정리완료원본)</h2>
      <p className="clean-note">휴지통이 없는 드라이브(USB 등)에서 정리한 원본은 지우지 않고 이 폴더로 옮겨 둬요. 휴지통으로 보낸 파일은 Windows 휴지통에서 되살릴 수 있어요.</p>
      <ul className="clean-folders">
        {data.folders.map((f) => (
          <li key={f.which} className="clean-folder">
            <span className="clean-folder-name">{f.label}</span>
            {!f.set && <span className="clean-dim">폴더를 아직 정하지 않았어요</span>}
            {f.set && !f.exists && <span className="clean-dim">옮겨 둔 원본이 없어요</span>}
            {f.exists && (
              <>
                <span>{num(f.files)}{f.capped ? '개 이상' : '개'}</span>
                <span className="clean-dim">{formatBytes(f.bytes)}</span>
                <button type="button" onClick={() => openFolder(f.which)}>{f.label}의 _정리완료원본 열기</button>
              </>
            )}
          </li>
        ))}
      </ul>
      {openError && <p className="clean-error" role="alert">{openError}</p>}

      <h2 className="clean-heading">정리 기록</h2>
      {data.sessions.length === 0 && <p className="clean-note">아직 정리한 적이 없어요.</p>}
      {data.sessions.length > 0 && (
        <table className="clean-table">
          <thead>
            <tr>
              <th scope="col">언제</th>
              <th scope="col">무엇</th>
              <th scope="col">휴지통</th>
              <th scope="col">옮김</th>
              <th scope="col">실패</th>
              <th scope="col"><span className="sr-only">상태</span></th>
            </tr>
          </thead>
          <tbody>
            {data.sessions.map((s) => (
              <tr key={s.id} className={picked === s.id ? 'on' : ''}>
                <td>
                  <button type="button" className="clean-row" onClick={() => onPick(s)}>{s.at || s.id}</button>
                </td>
                <td>{s.label}</td>
                <td>{num(s.trash)}</td>
                <td>{num(s.move)}</td>
                <td>{num(s.fail)}</td>
                <td className="clean-dim">{s.finished ? '' : '끝까지 기록되지 않음'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

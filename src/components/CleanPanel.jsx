// 파일 위치: src/components/CleanPanel.jsx
// 역할: "정리" 화면 오른쪽 패널. 고른 기록의 파일 이름과 어디로 갔는지 (휴지통, _정리완료원본, 실패)
//   파일 이름만 보여요 (경로는 main 이 화면에 주지 않아요)

import React from 'react';

// pending = "예정" 줄만 있고 결과 줄이 없는 파일 (옮기던 중 꺼졌거나 결과를 적지 못함). 목록 맨 앞에 와요
const HOW_TEXT = { trash: '휴지통', move: '_정리완료원본', fail: '실패', pending: '결과가 기록되지 않음' };
const num = (n) => n.toLocaleString('en-US');

export default function CleanPanel({ session }) {
  if (!session) {
    return (
      <aside className="panel clean-panel">
        <p className="panel-hint">정리 기록을 누르면 그때 옮긴 파일이 여기에 나와요.</p>
      </aside>
    );
  }
  return (
    <aside className="panel clean-panel">
      <h2 className="clean-panel-title">{session.label}</h2>
      <p className="clean-dim">{session.at}</p>
      <p className="clean-counts">
        <span>휴지통 {num(session.trash)}개</span>
        <span>옮김 {num(session.move)}개</span>
        <span>실패 {num(session.fail)}개</span>
      </p>
      {!session.finished && (
        <p className="clean-note">이 기록은 끝 줄이 없어요. 정리하는 도중에 프로그램이 꺼졌을 수 있어요.</p>
      )}
      {session.pending > 0 && (
        <p className="clean-note">'결과가 기록되지 않음' 파일 {num(session.pending)}개는 옮기는 도중이었어요. 원래 자리, 휴지통, _정리완료원본 중 어디에 있는지 확인해 주세요.</p>
      )}
      <ul className="clean-files">
        {session.files.map((f, i) => (
          <li key={`${i}-${f.name}`} className={`clean-file ${f.how}`}>
            <span className="clean-file-name">{f.pair ? `${f.name} (짝 영상)` : f.name}</span>
            <span className="clean-dim">{HOW_TEXT[f.how]}</span>
            {f.note && <span className="clean-file-note">{f.note}</span>}
          </li>
        ))}
      </ul>
      {session.more > 0 && <p className="clean-dim">그 밖에 {num(session.more)}개 (로그 파일에 다 있어요)</p>}
    </aside>
  );
}

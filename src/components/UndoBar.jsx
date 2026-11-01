// 파일 위치: src/components/UndoBar.jsx
// 역할: 마지막으로 넣은 정보를 되돌리는 얇은 줄 (설계서 7절)
//   두 곳에서 써요
//   - "정보 없는 사진" 화면의 "내가 넣은 정보" 탭 위쪽: 마지막 묶음이 있으면 늘 보여요 (variant="top")
//   - 값을 넣은 직후 ScanBanner 아래: "124장에 위치를 넣었어요" + 되돌리기, 닫을 수 있어요 (variant="after")
//   되돌리기는 마지막 묶음부터 차례로만 돼요. 눌러서 처리하는 동안은 버튼을 꺼서 두 번 눌리지 않게 해요

import React from 'react';
import { appliedText, undoLabel } from '../format.mjs';

// batch = state.lastBatch { id, kind, count, createdAt }
// busy = 되돌리는 중(글자도 바뀜), disabled = 새 상태를 기다리는 중(글자는 그대로, 버튼만 꺼짐)
export default function UndoBar({ batch, variant, busy, disabled, onUndo, onDismiss }) {
  if (!batch) return null;
  const label = undoLabel(batch.count, batch.kind);
  if (!label) return null;
  const after = variant === 'after';
  return (
    <div className="banners">
      <div className="banner" role="status">
        <div className="banner-text">
          {after ? <strong>{appliedText(batch.count, batch.kind)}</strong> : <strong>마지막으로 넣은 정보</strong>}
          {after
            ? <span className="banner-sub"> 잘못 넣었다면 바로 되돌릴 수 있어요</span>
            : <span className="banner-sub"> 마지막에 넣은 것부터 차례로 되돌려요</span>}
        </div>
        <button type="button" onClick={onUndo} disabled={busy || disabled}>{busy ? '되돌리는 중' : label}</button>
        {after && <button type="button" className="link-button" onClick={onDismiss}>닫기</button>}
      </div>
    </div>
  );
}

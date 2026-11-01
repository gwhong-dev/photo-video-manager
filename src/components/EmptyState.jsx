// 파일 위치: src/components/EmptyState.jsx
// 역할: 보여 줄 사진이 없을 때의 안내 (제목, 설명, 버튼 하나). 갤러리 가운데 영역을 채워요

import React from 'react';

export default function EmptyState({ title, children, action, extra }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {extra}
      {action}
    </div>
  );
}

// 파일 위치: src/components/TagWriteBanner.jsx
// 역할: 갤러리 · 태그 화면 위쪽 안내 줄 "파일에 쓰지 않은 태그가 N장에 있어요" (31 ②)
//   버튼을 누르면 쓰기 창(TagWriteDialog)이 열려요. 띠에서 바로 쓰지 않아요

import React from 'react';
import { bannerText } from '../tag-write-view.mjs';

// info = gallery:tag-write-info 결과, disabled = 다른 창이 열려 있을 때
export default function TagWriteBanner({ info, disabled, onOpen }) {
  const t = bannerText(info);
  if (!t) return null;
  return (
    <div className="banners">
      <div className="banner tag-write-banner" role="status">
        <div className="banner-text">
          <strong>{t.title}</strong>
          <span className="banner-sub">{t.sub}</span>
        </div>
        <button type="button" onClick={onOpen} disabled={disabled}>{t.button}</button>
      </div>
    </div>
  );
}

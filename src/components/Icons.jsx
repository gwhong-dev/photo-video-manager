// 파일 위치: src/components/Icons.jsx
// 역할: 사이드바와 도구줄에 쓰는 작은 그림 (선으로 그린 SVG. 색은 글자색을 따라가요)

import React from 'react';

function Svg({ children, size = 16 }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const ImportIcon = () => (
  <Svg><path d="M8 2v8M4.8 7 8 10.2 11.2 7M2.5 13h11" /></Svg>
);
export const GalleryIcon = () => (
  <Svg><rect x="2" y="2.5" width="12" height="11" rx="1" /><circle cx="5.6" cy="6" r="1.1" /><path d="m2.5 12 3.4-3.4 2.4 2.2 2-1.8 3.2 3" /></Svg>
);
export const WarnIcon = () => (
  <Svg><path d="M8 2.2 14 12.8H2L8 2.2Z" /><path d="M8 6.6v3M8 11.2v.1" /></Svg>
);
export const SimilarIcon = () => (
  <Svg><rect x="2" y="4.5" width="8" height="9" rx="1" /><path d="M6 4.5V3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-1.5" /></Svg>
);
export const TagIcon = () => (
  <Svg><path d="M2.5 2.5h5.2l6 6-4.9 4.9-6.3-6.3V2.5Z" /><circle cx="5.3" cy="5.3" r="0.9" /></Svg>
);
export const MapIcon = () => (
  <Svg><path d="M8 14s4.5-4 4.5-7.3a4.5 4.5 0 0 0-9 0C3.5 10 8 14 8 14Z" /><circle cx="8" cy="6.7" r="1.5" /></Svg>
);
export const CleanIcon = () => (
  <Svg><path d="M3 4.5h10M6.2 4.5V3h3.6v1.5M4.2 4.5l.6 8.5h6.4l.6-8.5" /></Svg>
);
export const SearchIcon = () => (
  <Svg size={15}><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.3 3.3" /></Svg>
);
export const CloseIcon = () => (
  <Svg size={14}><path d="m4 4 8 8M12 4l-8 8" /></Svg>
);

// 파일 위치: src/components/MapPanel.jsx
// 역할: 지도 화면의 오른쪽 패널 (단계 6). 고른 핀의 장수, 찍은 기간, 최근 사진 9장, 갤러리로 가는 버튼
//   장소 이름(서울, 수원)과 "사진을 많이 찍은 곳" 목록은 다음 단계(6-2)에서 붙여요

import React, { useState } from 'react';
import { countText, rangeText } from '../places-view.mjs';

function Thumb({ id }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="map-thumb">
      {broken ? <span className="no-preview">미리보기 없음</span> : <img src={`pvm://thumb/${id}`} alt="" loading="lazy" draggable="false" onError={() => setBroken(true)} />}
    </div>
  );
}

// picked = 고른 묶음 요약 (src/places-view.mjs summarize) 또는 null, located = 위치가 있는 사진 수 (받는 중이면 null)
export default function MapPanel({ picked, located, onShowArea }) {
  if (!picked) {
    return (
      <aside className="panel map-panel">
        <p className="panel-hint">핀을 누르면 그 곳에서 찍은 사진이 여기에 나와요.</p>
        {located > 0 && <p className="panel-hint map-located">위치가 있는 사진 {countText(located)}장</p>}
      </aside>
    );
  }
  return (
    <aside className="panel map-panel">
      <h2 className="map-count">{countText(picked.count)}장</h2>
      <p className="map-range">{rangeText(picked.first, picked.last)}{picked.area.year ? ` (${picked.area.year}년 탭)` : ''}</p>
      <div className="map-thumbs">
        {picked.recent.map((id) => <Thumb key={id} id={id} />)}
      </div>
      <button type="button" className="primary map-show" onClick={() => onShowArea(picked.area)}>
        {countText(picked.count)}장 갤러리에서 보기
      </button>
    </aside>
  );
}

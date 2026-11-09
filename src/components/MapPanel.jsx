// 파일 위치: src/components/MapPanel.jsx
// 역할: 지도 화면의 오른쪽 패널 (단계 6). 고른 핀의 이름, 장수, 찍은 기간, 최근 사진 9장, 갤러리로 가는 버튼
//   그 아래 "사진을 많이 찍은 곳" (누르면 지도가 그곳으로 가서 그 핀을 골라요)
//   이름은 시 · 군 단위로 인터넷에서 받아요 (MapView). 아직 못 받았거나 못 받으면 장수만 보여요

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

// picked = 고른 묶음 요약 (src/places-view.mjs summarize + name) 또는 null, located = 위치가 있는 사진 수 (받는 중이면 null)
// top = 많이 찍은 곳 [{ key, count, lat, lng, name, asking }], onGoto(그 곳)
export default function MapPanel({ picked, located, top, onShowArea, onGoto }) {
  const topList = top && top.length > 0 && (
    <>
      <h3 className="panel-heading map-top-heading">사진을 많이 찍은 곳</h3>
      <ul className="map-top-list">
        {top.map((t) => (
          <li key={t.key}>
            <button type="button" className={picked && picked.key === t.key ? 'on' : ''} onClick={() => onGoto(t)}>
              <span>{t.name || (t.asking ? '이름 받는 중' : '이름 없는 곳')}</span>
              <span className="map-top-count">{countText(t.count)}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
  if (!picked) {
    return (
      <aside className="panel map-panel">
        <p className="panel-hint">핀을 누르면 그 곳에서 찍은 사진이 여기에 나와요.</p>
        {located > 0 && <p className="panel-hint map-located">위치가 있는 사진 {countText(located)}장</p>}
        {topList}
      </aside>
    );
  }
  return (
    <aside className="panel map-panel">
      {picked.name && <h2 className="map-name">{picked.name}</h2>}
      <p className={picked.name ? 'map-count small' : 'map-count'}>{countText(picked.count)}장</p>
      <p className="map-range">{rangeText(picked.first, picked.last)}{picked.area.year ? ` (${picked.area.year}년 탭)` : ''}</p>
      <div className="map-thumbs">
        {picked.recent.map((id) => <Thumb key={id} id={id} />)}
      </div>
      <button type="button" className="primary map-show" onClick={() => onShowArea(picked.area)}>
        {picked.name ? `${picked.name} 사진 ${countText(picked.count)}장 갤러리에서 보기` : `${countText(picked.count)}장 갤러리에서 보기`}
      </button>
      {topList}
    </aside>
  );
}

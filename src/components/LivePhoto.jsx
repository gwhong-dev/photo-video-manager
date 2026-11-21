// 파일 위치: src/components/LivePhoto.jsx
// 역할: 라이브 포토 · 모션 포토의 움직이는 부분 재생 (2026-11-21 사용자 요청: "라이브 포토인데 재생이 안 되는 거야?")
//   영상은 pvm://live/<사진 번호> 로 받아요 (lib/media-protocol.js: 같은 이름의 짝 영상, 없으면 JPG 끝에 붙은 영상)
//   영상이 없으면(보통 사진은 204, 이상한 번호는 404) 아무것도 그리지 않아요. 있으면 "움직이는 사진" 버튼이 보이고, 누르고 있는 동안 재생해요
//   영상은 부모 칸 위에 꽉 차게(비율 유지) 겹쳐 그려요 → 부모는 position: relative 여야 해요
//   재생하지 못하면(이 PC 가 못 여는 영상 형식) 안내 한 줄

import React, { useEffect, useRef, useState } from 'react';

export default function LivePhoto({ id }) {
  const [state, setState] = useState('checking'); // checking | ready | none | broken
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef(null);

  useEffect(() => {
    setState('checking');
    setPlaying(false);
  }, [id]);

  const start = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation(); // 비교 창 칸의 끌기 · 확대로 가지 않게
    }
    const v = videoRef.current;
    if (!v || state !== 'ready') return;
    setPlaying(true);
    try { v.currentTime = 0; } catch (err) { /* 처음으로 못 돌려도 그대로 */ }
    const p = v.play();
    if (p && typeof p.catch === 'function') p.catch(() => { setPlaying(false); setState('broken'); });
  };
  const stop = () => {
    const v = videoRef.current;
    if (v) v.pause();
    setPlaying(false);
  };

  if (id === null || id === undefined || state === 'none') return null;
  return (
    <>
      <video
        key={id}
        ref={videoRef}
        className={`live-video${playing ? ' playing' : ''}`}
        src={`pvm://live/${id}`}
        preload="metadata"
        playsInline
        aria-hidden="true"
        onLoadedMetadata={() => setState((s) => (s === 'checking' ? 'ready' : s))}
        onError={() => setState((s) => (s === 'checking' ? 'none' : 'broken'))}
        onEnded={() => setPlaying(false)}
      />
      {state === 'ready' && (
        <button
          type="button"
          className="live-button"
          aria-pressed={playing}
          title="누르고 있는 동안 움직이는 사진을 재생해요"
          onPointerDown={start}
          onPointerUp={stop}
          onPointerLeave={stop}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.repeat) start(e); }}
          onKeyUp={(e) => { if (e.key === 'Enter') stop(); }}
        >
          {playing ? '재생 중' : '▶ 움직이는 사진'}
        </button>
      )}
      {state === 'broken' && <span className="live-note">움직이는 부분은 이 PC 에서 재생할 수 없는 영상이에요</span>}
    </>
  );
}

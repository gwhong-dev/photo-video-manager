// 파일 위치: src/components/VideoPlayer.jsx
// 역할: 갤러리 오른쪽 패널에서 영상 재생 (2026-11-27 필수 기능 순위 2위 "앱 안 영상 재생")
//   pvm://video/<id> 로 원본을 받아요 (화면은 파일 경로를 몰라요). 건너뛰기는 구간 요청(Range)으로 돼요 (gallery-main.js)
//   처음에는 썸네일(poster)만 보이고, 재생 버튼을 눌러야 영상을 받기 시작해요 (preload="metadata": 길이 · 크기만 먼저)
//   이 PC 가 못 여는 형식(AVI · WMV 등)이면 onUnplayable 을 불러요 → 미리보기가 썸네일과 안내 한 줄로 바뀌어요

import React from 'react';

export const UNPLAYABLE_TEXT = '이 PC 에서 재생하지 못하는 영상 형식이에요. 썸네일만 보여 줘요';

// file = 고른 영상 (id · mtimeMs · thumbState), onUnplayable = 재생하지 못할 때
export default function VideoPlayer({ file, onUnplayable }) {
  const v = file.mtimeMs || 0; // 파일이 바뀌면(돌려서 저장 등) 새로 받아요
  const poster = file.thumbState === 'failed' ? undefined : `pvm://preview/${file.id}?v=${v}`;
  return (
    <video
      key={file.id}
      className="video-player"
      src={`pvm://video/${file.id}?v=${v}`}
      poster={poster}
      controls
      preload="metadata"
      playsInline
      onError={onUnplayable}
    />
  );
}

// 파일 위치: src/components/PreviewNote.jsx
// 역할: 원본을 못 읽어서(드라이브가 빠짐 등) 미리보기를 작은 썸네일로 대신 보여 줄 때 안내 한 줄 (2026-11-11 사용자 결정)
//   <img>는 응답 헤더를 못 읽어서, 그림을 다 받은 뒤(onLoad) main에 "방금 것이 썸네일이었나"를 물어봐요
//   색은 흐린 글자. 경고 노랑은 "정보 없음" 전용이라 쓰지 않아요 (CLAUDE.md 화면 디자인)

import React, { useCallback, useRef, useState } from 'react';
import { api } from '../api.js';

export const PREVIEW_NOTE_TEXT = '원본이 연결되지 않아 작은 그림으로 보여요';

// usePreviewNote(id) → { small, onLoad }. onLoad를 <img onLoad>에 걸어요. 다른 사진의 답은 쓰지 않아요 (사진이 바뀌면 안내가 사라져요)
export function usePreviewNote(id) {
  const [small, setSmall] = useState({ id: null, value: false });
  const current = useRef(id);
  current.current = id;
  const onLoad = useCallback(() => {
    const asked = id;
    Promise.resolve()
      .then(() => api.previewFallback(asked))
      .then(
        (v) => { if (current.current === asked) setSmall({ id: asked, value: v === true }); },
        () => {}, // 물어보지 못해도 그림은 그대로 보여요
      );
  }, [id]);
  return { small: small.id === id && small.value, onLoad };
}

// 안내 한 줄. 버튼 안에도 들어가서 <p> 대신 <span>을 써요
export function PreviewNote({ show }) {
  return show ? <span className="preview-note">{PREVIEW_NOTE_TEXT}</span> : null;
}

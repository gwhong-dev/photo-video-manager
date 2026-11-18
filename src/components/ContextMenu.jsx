// 파일 위치: src/components/ContextMenu.jsx
// 역할: 사진 칸을 우클릭했을 때 뜨는 작은 메뉴 (설계서 8절)
//   항목: 날짜와 위치 복사 (한 장일 때만) / N장에 붙여넣기 (복사한 값이 있을 때만) / N장에 날짜 직접 넣기 / N장 위치 지도에서 고르기
//         / N장에 태그 붙이기 / N장에서 태그 떼기 / N장 휴지통으로 옮기기
//   바깥을 누르거나 Esc를 누르거나 창 크기, 스크롤이 바뀌면 닫혀요. 창 끝에서 잘리지 않게 위치를 맞춰요
//   메뉴가 어떤 사진에 대한 것인지(선택)는 App이 알고 있어서, 여기서는 눌렀다고 알리기만 해요

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatCount } from '../format.mjs';
import { trashMenuLabel } from '../trash-view.mjs';
import { quickTagLabel } from '../tag-keys.mjs';

const EDGE = 8; // 창 가장자리에서 띄울 거리

// at = { x, y } 우클릭한 자리, count = 선택한 장수, canCopy = 복사할 수 있는지(한 장일 때), hasCopy = 복사해 둔 값이 있는지
//   onTrash = 고른 사진을 휴지통으로 (확인 창을 거쳐요, 2026-11-16). 없으면 항목을 안 그려요
//   quick = 단축키 숫자를 정한 태그 [{ name, hotkey }] (2026-11-18). 항목마다 "N장에 '여행' 붙이기"와 숫자, 누르면 onQuickTag(숫자)
//   단축키 글자(T, 숫자)는 CSS 로 오른쪽에 그려요 (data-key). 버튼 글자에는 들어가지 않아요
export default function ContextMenu({ at, count, canCopy, hasCopy, onCopy, onPaste, onDirect, onMap, onTagAdd, onTagRemove, onTrash, onClose, quick = [], onQuickTag }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });

  // 메뉴 크기를 잰 뒤, 오른쪽이나 아래로 넘치면 안쪽으로 당겨요 (그려지기 전에 바로 맞춰서 깜빡이지 않아요)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const left = Math.max(EDGE, Math.min(at.x, window.innerWidth - w - EDGE));
    const top = Math.max(EDGE, Math.min(at.y, window.innerHeight - h - EDGE));
    setPos({ left, top });
  }, [at.x, at.y]);

  // 열리면 첫 항목에 초점을 줘서 키보드로 바로 쓸 수 있게 해요
  useEffect(() => {
    const first = ref.current && ref.current.querySelector('button');
    if (first) first.focus();
  }, []);

  // 닫기: 바깥 누르기, Esc, 창 크기와 스크롤, 창이 초점을 잃을 때
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    document.addEventListener('wheel', onClose, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
      document.removeEventListener('wheel', onClose, true);
    };
  }, [onClose]);

  // 위아래 화살표로 항목 사이를 오가요
  const onMenuKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = [...ref.current.querySelectorAll('button')];
    const i = buttons.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  const n = formatCount(count);
  return (
    <div ref={ref} className="context-menu" role="menu" aria-label="사진 메뉴" style={pos} onKeyDown={onMenuKey} onContextMenu={(e) => e.preventDefault()}>
      {canCopy && <button type="button" role="menuitem" onClick={onCopy}>날짜와 위치 복사</button>}
      {hasCopy && <button type="button" role="menuitem" onClick={onPaste}>{n}장에 붙여넣기</button>}
      <button type="button" role="menuitem" onClick={onDirect}>{n}장에 날짜 직접 넣기</button>
      <button type="button" role="menuitem" onClick={onMap}>{n}장 위치 지도에서 고르기</button>
      <button type="button" role="menuitem" data-key="T" onClick={onTagAdd}>{n}장에 태그 붙이기</button>
      {onQuickTag && quick.map((t) => (
        <button key={t.name} type="button" role="menuitem" className="quick-tag" data-key={String(t.hotkey)} onClick={() => onQuickTag(t.hotkey)}>{quickTagLabel(count, t.name)}</button>
      ))}
      <button type="button" role="menuitem" onClick={onTagRemove}>{n}장에서 태그 떼기</button>
      {onTrash && <button type="button" role="menuitem" className="trash-button" onClick={onTrash}>{trashMenuLabel(count)}</button>}
    </div>
  );
}

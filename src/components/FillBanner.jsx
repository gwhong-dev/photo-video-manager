// 파일 위치: src/components/FillBanner.jsx
// 역할: 정보 없는 사진 > "날짜 없음" 탭 위쪽 안내 줄 (날짜 후보 확인하기 + 마지막으로 옮긴 것 되돌리기)
//   후보는 버튼을 눌러야 계산해요 (탭을 열 때마다 폴더를 읽지 않아요)

import React from 'react';

// lastFill = state.lastFill { count, at } 또는 null, busy = 되돌리는 중, disabled = 새 상태를 기다리는 중
export default function FillBanner({ noDate, lastFill, busy, disabled, onOpen, onUndo }) {
  return (
    <div className="banners">
      <div className="banner fill-banner" role="status">
        <div className="banner-text">
          <strong>날짜 없는 사진 {noDate.toLocaleString('en-US')}장</strong>
          <span className="banner-sub"> iCloud 공유 앨범 사진은 앨범 정보에서 날짜를 찾아 날짜 폴더로 옮길 수 있어요. 누르기 전에는 아무것도 바뀌지 않아요</span>
        </div>
        <button type="button" onClick={onOpen} disabled={busy}>날짜 후보 확인하기</button>
        {lastFill && (
          <button type="button" className="link-button" onClick={onUndo} disabled={busy || disabled}>
            {busy ? '되돌리는 중' : `마지막으로 옮긴 ${lastFill.count.toLocaleString('en-US')}장 되돌리기`}
          </button>
        )}
      </div>
    </div>
  );
}

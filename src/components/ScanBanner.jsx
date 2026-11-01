// 파일 위치: src/components/ScanBanner.jsx
// 역할: 도구줄 아래에 얇게 뜨는 안내 줄 (읽는 중, 폴더 연결 안 됨, 도구 없음, 목록 새로 만듦, 읽기 문제, 화면 전환 거절 이유)
//   목록은 그대로 보이게 두고, 무슨 일인지만 알려요 (docs/superpowers/specs/2026-11-01-gallery-design.md 9절)

import React from 'react';
import { formatCount } from '../format.mjs';

function Line({ title, children, action, role }) {
  return (
    <div className="banner" role={role}>
      <div className="banner-text">
        <strong>{title}</strong>
        {children && <span> {children}</span>}
      </div>
      {action}
    </div>
  );
}

export default function ScanBanner({ state, recovered, notice, onDismissNotice, onRescan, rescanning }) {
  if (!state) return null;
  const scan = state.scan || {};
  const lines = [];

  if (notice) {
    lines.push(
      <Line key="notice" role="alert" title={notice} action={<button type="button" className="link-button" onClick={onDismissNotice}>닫기</button>} />,
    );
  }
  if (scan.scanning) {
    const reading = scan.phase === 'reading' && scan.total > 0;
    lines.push(
      <div className="banner" key="scan" role="status">
        <div className="banner-text">
          <strong>{reading ? '사진 정보 읽는 중' : '사진 찾는 중'}</strong>
          <span> {reading ? `${formatCount(scan.done)} / ${formatCount(scan.total)}` : scan.done > 0 ? `${formatCount(scan.done)}개 찾음` : ''}</span>
          {state.total > 0 && <span className="banner-sub"> 읽는 동안에도 아래 목록을 볼 수 있어요</span>}
        </div>
        {reading && <div className="progress" aria-hidden="true"><div style={{ width: `${Math.min(100, (scan.done / scan.total) * 100)}%` }} /></div>}
      </div>,
    );
  }
  if (recovered) {
    lines.push(<Line key="recovered" title="목록 파일이 깨져서 새로 만들었어요">사진은 그대로예요. 폴더를 처음부터 다시 읽고 있어요.</Line>);
  }
  // 폴더 연결이 끊겼을 때: 마지막으로 읽은 목록은 그대로 보여 줘요 (사진이 하나도 없으면 빈 화면 쪽에서 알려요)
  if (state.root && !state.connected && state.total > 0) {
    lines.push(
      <Line
        key="disconnected"
        title="폴더 연결 안 됨"
        action={<button type="button" onClick={onRescan} disabled={rescanning}>백업 폴더 다시 읽기</button>}
      >
        USB나 외장 드라이브를 연결한 뒤 눌러 주세요. 지금 보이는 목록은 마지막으로 읽은 내용이에요.
      </Line>,
    );
  }
  if (state.root && state.tools && !state.tools.exiftool) {
    lines.push(
      <Line key="exiftool" title="exiftool을 찾지 못했어요">
        새 사진의 정보를 읽을 수 없어요. 이미 읽어 둔 목록은 그대로 보여요. 가져오기 화면에서 exiftool 위치를 정해 주세요.
      </Line>,
    );
  }
  if (state.root && state.tools && !state.tools.ffmpeg) {
    lines.push(
      <Line key="ffmpeg" title="FFmpeg를 찾지 못했어요">
        영상 미리보기는 만들 수 없어요. 사진은 그대로 볼 수 있어요.
      </Line>,
    );
  }
  if (state.scanStatus === 'error' && !scan.scanning) {
    lines.push(
      <Line
        key="error"
        role="alert"
        title="폴더를 읽다가 문제가 생겼어요"
        action={<button type="button" onClick={onRescan} disabled={rescanning}>백업 폴더 다시 읽기</button>}
      >
        사진 파일은 그대로예요. 다시 눌러 주세요.
      </Line>,
    );
  }

  if (!lines.length) return null;
  return <div className="banners">{lines}</div>;
}

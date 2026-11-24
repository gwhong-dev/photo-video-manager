// 파일 위치: src/components/Sidebar.jsx
// 역할: 왼쪽 메뉴와 "내가 만든 태그" 목록
//   메뉴: 가져오기, 갤러리, 정보 없는 사진, 비슷한 사진, 태그 (지금 있는 화면 다섯). 나머지는 다음 단계에서 만들어서 흐리게 꺼 둬요
//   갤러리, 정보 없는 사진, 비슷한 사진, 태그는 같은 창 안에서 바뀌는 화면이에요 (onScreen)
//   파일에서 읽은 태그(앨범 이름 등)도 "내가 만든 태그"에 같이 모여요 (2026-11-24, 31 ②: 태그를 파일에도 쓰면서 하나로 합침)
//   내가 만든 태그 옆에 "새 태그" 버튼 (2026-11-18). 단축키 숫자를 정한 태그는 숫자를 같이 보여 줘요
//   태그를 누르면 그 태그만 보고, 다시 누르면 풀려요
//   가져오기 전 거르기 중(state.screening)에는 갤러리 · 비슷한 사진만 열려요. 나머지 메뉴와 "새 태그"는 꺼요 (설계 4-1)

import React from 'react';
import { formatCount } from '../format.mjs';
import { CleanIcon, GalleryIcon, ImportIcon, MapIcon, SimilarIcon, TagIcon, WarnIcon } from './Icons.jsx';

function MenuRow({ icon, label, count, note, active, disabled, onClick, countClass, why }) {
  return (
    <button
      type="button"
      className={`menu-row${active ? ' active' : ''}`}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      title={disabled ? (why || '다음 단계에서 만들어요') : undefined}
      onClick={onClick}
    >
      {icon}
      <span className="menu-label">{label}</span>
      {note && <span className="menu-note">{note}</span>}
      {count !== undefined && <span className={`menu-count ${countClass || ''}`}>{formatCount(count)}</span>}
    </button>
  );
}

export default function Sidebar({ state, screen, filter, onOpenImport, onScreen, onPickTag, onNewTag, onRescan, rescanning }) {
  const s = state || {};
  const showCounts = !!(state && state.root && !state.dbError);
  const mine = (showCounts && s.manualTags) || [];
  const screening = !!s.screening;
  const off = screening ? '거르기를 끝낸 뒤에 쓸 수 있어요' : undefined; // 거르기 중에 꺼 둔 메뉴의 안내
  const tagRows = (list) => list.map((t) => {
    const on = filter.tag === t.name;
    return (
      <button
        key={t.name}
        type="button"
        className={`menu-row tag-row${on ? ' active' : ''}`}
        aria-pressed={on}
        title={on ? '다시 누르면 전체로 돌아가요' : undefined}
        onClick={() => onPickTag(on ? null : t.name)}
      >
        <TagIcon />
        <span className="menu-label">{t.name}</span>
        {Number.isInteger(t.hotkey) && <span className="tag-key" title={`사진을 고른 뒤 숫자 ${t.hotkey} 키를 누르면 붙어요`}>{t.hotkey}</span>}
        <span className="menu-count">{formatCount(t.count)}</span>
      </button>
    );
  });
  return (
    <aside className="side">
      <nav className="menu" aria-label="화면">
        <MenuRow icon={<ImportIcon />} label="가져오기" note={s.jobPending ? '이어할 작업 있음' : ''} onClick={onOpenImport} />
        <MenuRow icon={<GalleryIcon />} label="갤러리" count={showCounts ? s.total : undefined} active={screen === 'gallery'} onClick={() => onScreen('gallery')} />
        <MenuRow icon={<WarnIcon />} label="정보 없는 사진" count={showCounts && !screening ? s.noInfo : undefined} countClass="warn" active={screen === 'missing'} onClick={() => onScreen('missing')} disabled={screening} why={off} />
        <MenuRow icon={<SimilarIcon />} label="비슷한 사진" active={screen === 'similar'} onClick={() => onScreen('similar')} disabled={!showCounts} />
        <MenuRow icon={<TagIcon />} label="태그" count={showCounts && !screening ? s.tagCount : undefined} active={screen === 'tags'} onClick={() => onScreen('tags')} disabled={!showCounts || screening} why={off} />
        <MenuRow icon={<MapIcon />} label="지도" active={screen === 'map'} onClick={() => onScreen('map')} disabled={!showCounts || screening} why={off} />
        <MenuRow icon={<CleanIcon />} label="정리" active={screen === 'clean'} onClick={() => onScreen('clean')} disabled={!showCounts || screening} why={off} />
      </nav>

      {showCounts && !screening && (
        <>
          <div className="side-heading-row">
            <h2 className="side-heading">내가 만든 태그</h2>
            <button type="button" className="link-button side-new" onClick={onNewTag}>새 태그</button>
          </div>
          {mine.length > 0 && <div className="tag-list">{tagRows(mine)}</div>}
        </>
      )}

      {showCounts && (
        <div className="side-foot">
          <button type="button" className="link-button" onClick={onRescan} disabled={rescanning || !!(s.scan && s.scan.scanning)}>
            {screening ? '가져올 폴더 다시 읽기' : '백업 폴더 다시 읽기'}
          </button>
        </div>
      )}
    </aside>
  );
}

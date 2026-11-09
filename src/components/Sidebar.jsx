// 파일 위치: src/components/Sidebar.jsx
// 역할: 왼쪽 메뉴와 "앨범에서 가져온 태그" 목록
//   메뉴: 가져오기, 갤러리, 정보 없는 사진, 비슷한 사진, 태그 (지금 있는 화면 다섯). 나머지는 다음 단계에서 만들어서 흐리게 꺼 둬요
//   갤러리, 정보 없는 사진, 비슷한 사진, 태그는 같은 창 안에서 바뀌는 화면이에요 (onScreen)
//   태그 목록은 "내가 붙인 태그"와 "앨범에서 가져온 태그" 두 묶음이에요
//   태그를 누르면 그 태그만 보고, 다시 누르면 풀려요

import React from 'react';
import { formatCount } from '../format.mjs';
import { CleanIcon, GalleryIcon, ImportIcon, MapIcon, SimilarIcon, TagIcon, WarnIcon } from './Icons.jsx';

function MenuRow({ icon, label, count, note, active, disabled, onClick, countClass }) {
  return (
    <button
      type="button"
      className={`menu-row${active ? ' active' : ''}`}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      title={disabled ? '다음 단계에서 만들어요' : undefined}
      onClick={onClick}
    >
      {icon}
      <span className="menu-label">{label}</span>
      {note && <span className="menu-note">{note}</span>}
      {count !== undefined && <span className={`menu-count ${countClass || ''}`}>{formatCount(count)}</span>}
    </button>
  );
}

export default function Sidebar({ state, screen, filter, onOpenImport, onScreen, onPickTag, onRescan, rescanning }) {
  const s = state || {};
  const showCounts = !!(state && state.root && !state.dbError);
  const tags = (showCounts && s.tags) || [];
  const mine = (showCounts && s.manualTags) || [];
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
        <span className="menu-count">{formatCount(t.count)}</span>
      </button>
    );
  });
  return (
    <aside className="side">
      <nav className="menu" aria-label="화면">
        <MenuRow icon={<ImportIcon />} label="가져오기" note={s.jobPending ? '이어할 작업 있음' : ''} onClick={onOpenImport} />
        <MenuRow icon={<GalleryIcon />} label="갤러리" count={showCounts ? s.total : undefined} active={screen === 'gallery'} onClick={() => onScreen('gallery')} />
        <MenuRow icon={<WarnIcon />} label="정보 없는 사진" count={showCounts ? s.noInfo : undefined} countClass="warn" active={screen === 'missing'} onClick={() => onScreen('missing')} />
        <MenuRow icon={<SimilarIcon />} label="비슷한 사진" active={screen === 'similar'} onClick={() => onScreen('similar')} disabled={!showCounts} />
        <MenuRow icon={<TagIcon />} label="태그" count={showCounts ? s.tagCount : undefined} active={screen === 'tags'} onClick={() => onScreen('tags')} disabled={!showCounts} />
        <MenuRow icon={<MapIcon />} label="지도" active={screen === 'map'} onClick={() => onScreen('map')} disabled={!showCounts} />
        <MenuRow icon={<CleanIcon />} label="정리" active={screen === 'clean'} onClick={() => onScreen('clean')} disabled={!showCounts} />
      </nav>

      {mine.length > 0 && (
        <>
          <h2 className="side-heading">내가 붙인 태그</h2>
          <div className="tag-list">{tagRows(mine)}</div>
        </>
      )}
      {tags.length > 0 && (
        <>
          <h2 className="side-heading">앨범에서 가져온 태그</h2>
          <div className="tag-list">{tagRows(tags)}</div>
        </>
      )}

      {showCounts && (
        <div className="side-foot">
          <button type="button" className="link-button" onClick={onRescan} disabled={rescanning || !!(s.scan && s.scan.scanning)}>
            백업 폴더 다시 읽기
          </button>
        </div>
      )}
    </aside>
  );
}

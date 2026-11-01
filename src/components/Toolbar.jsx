// 파일 위치: src/components/Toolbar.jsx
// 역할: 가운데 위쪽 도구줄 (탭, 검색창, 정렬, 목록 전체 선택)
//   갤러리 화면의 탭은 종류(전체, 사진, 영상, 스크린샷), 정보 없는 사진 화면의 탭은 빠진 정보(위치 없음, 날짜 없음, 내가 넣은 정보)
//   검색어는 App이 0.2초 뒤에 적용해요 (여기서는 입력 글자만 다뤄요)

import React from 'react';
import { formatCount } from '../format.mjs';
import { CloseIcon, SearchIcon } from './Icons.jsx';

const TABS = [
  ['all', '전체'],
  ['photo', '사진'],
  ['video', '영상'],
  ['screenshot', '스크린샷'],
];

// 정보 없는 사진 화면의 탭: [filter.info 값, 글자, state에서 개수를 읽는 이름]
const INFO_TABS = [
  ['noLocation', '위치 없음', 'noLocation'],
  ['noDate', '날짜 없음', 'noDate'],
  ['manual', '내가 넣은 정보', 'manualCount'],
];

export default function Toolbar({ screen, state, filter, searchText, onSearchText, onTab, onInfo, onSort, onSelectAll, selectingAll }) {
  const missing = screen === 'missing';
  const s = state || {};
  return (
    <header className="toolbar">
      {missing ? (
        <div className="tabs" role="tablist" aria-label="빠진 정보">
          {INFO_TABS.map(([key, label, countKey]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter.info === key}
              className={`tab${filter.info === key ? ' active' : ''}`}
              onClick={() => onInfo(key)}
            >
              {label} <span className="tab-count">{formatCount(s[countKey] || 0)}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="tabs" role="tablist" aria-label="종류">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter.tab === key}
              className={`tab${filter.tab === key ? ' active' : ''}`}
              onClick={() => onTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <label className="search">
        <SearchIcon />
        <input
          type="search"
          value={searchText}
          placeholder="파일 이름, 태그, 날짜 검색"
          aria-label="파일 이름, 태그, 날짜 검색"
          onChange={(e) => onSearchText(e.target.value)}
        />
        {searchText && (
          <button type="button" className="icon-button" aria-label="검색어 지우기" onClick={() => onSearchText('')}>
            <CloseIcon />
          </button>
        )}
      </label>
      <select className="sort" value={filter.sort} aria-label="정렬" onChange={(e) => onSort(e.target.value)}>
        <option value="newest">찍은 날짜 최신순</option>
        <option value="oldest">찍은 날짜 오래된순</option>
      </select>
      <button type="button" className="link-button" onClick={onSelectAll} disabled={selectingAll}>목록 전체 선택</button>
    </header>
  );
}

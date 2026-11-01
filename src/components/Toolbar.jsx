// 파일 위치: src/components/Toolbar.jsx
// 역할: 가운데 위쪽 도구줄 (탭, 검색창, 정렬)
//   검색어는 App이 0.2초 뒤에 적용해요 (여기서는 입력 글자만 다뤄요)

import React from 'react';
import { CloseIcon, SearchIcon } from './Icons.jsx';

const TABS = [
  ['all', '전체'],
  ['photo', '사진'],
  ['video', '영상'],
  ['screenshot', '스크린샷'],
];

export default function Toolbar({ filter, searchText, onSearchText, onTab, onSort }) {
  return (
    <header className="toolbar">
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
    </header>
  );
}

// 파일 위치: src/components/TagsView.jsx
// 역할: "태그" 화면 (단계 5). 내가 붙인 태그와 앨범에서 가져온 태그를 장수와 함께 보여 줘요
//   태그를 누르면 갤러리에서 그 태그의 사진만 보여요 (onPick)
//   태그 붙이기와 떼기는 갤러리에서 사진을 고른 뒤 우클릭 메뉴나 오른쪽 패널에서 해요

import React, { useEffect, useState } from 'react';
import { api, errorText } from '../api.js';
import { formatCount } from '../format.mjs';
import { TagIcon } from './Icons.jsx';

function TagGroup({ title, tags, empty, onPick }) {
  return (
    <section className="tags-group" aria-label={title}>
      <h2 className="panel-heading">{title}</h2>
      {tags.length ? (
        <div className="tags-rows">
          {tags.map((t) => (
            <button key={t.name} type="button" className="menu-row tag-row" onClick={() => onPick(t.name)}>
              <TagIcon />
              <span className="menu-label">{t.name}</span>
              <span className="menu-count">{formatCount(t.count)}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="panel-hint">{empty}</p>
      )}
    </section>
  );
}

// gen = 목록이 바뀔 때마다 올라가는 번호 (다시 읽기), onPick(이름) = 태그를 눌렀을 때
export default function TagsView({ gen, onPick }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api.tagList().then(
      (r) => { if (alive) { setList(r); setError(''); } },
      (e) => { if (alive) setError(errorText(e)); },
    );
    return () => { alive = false; };
  }, [gen]);
  if (error) return <p className="panel-hint" role="alert">{error}</p>;
  if (!list) return null;
  return (
    <div className="tags-view">
      <p className="panel-hint">태그를 누르면 그 태그의 사진만 갤러리에 보여요. 태그는 갤러리에서 사진을 고른 뒤 우클릭 메뉴나 오른쪽 패널에서 붙여요.</p>
      <TagGroup title="내가 붙인 태그" tags={list.manual} empty="아직 붙인 태그가 없어요." onPick={onPick} />
      <TagGroup title="앨범에서 가져온 태그" tags={list.album} empty="앨범에서 가져온 태그가 없어요." onPick={onPick} />
    </div>
  );
}

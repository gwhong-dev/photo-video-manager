// 파일 위치: src/components/TagsView.jsx
// 역할: "태그" 화면 (단계 5). 내가 만든 태그와 앨범에서 가져온 태그를 장수와 함께 보여 줘요
//   태그를 누르면 갤러리에서 그 태그의 사진만 보여요 (onPick)
//   내가 만든 태그 (2026-11-18): 새 태그 만들기, 단축키 숫자(1~9) 정하기, 이름 바꾸기, 지우기
//     만들기 · 이름 바꾸기 · 지우기 창은 App 이 열어요 (onManage). 숫자는 여기서 바로 정해요
//   앨범에서 가져온 태그는 파일에서 읽은 것이라 바꿀 수 없어요 (읽기 전용)
//   태그 붙이기와 떼기는 갤러리에서 사진을 고른 뒤 우클릭 메뉴, 오른쪽 패널, 단축키(T, 숫자)로 해요

import React, { useEffect, useState } from 'react';
import { api, errorText } from '../api.js';
import { formatCount } from '../format.mjs';
import { hotkeyText } from '../tag-keys.mjs';
import { TagIcon } from './Icons.jsx';

const KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

function TagButton({ t, onPick }) {
  return (
    <button type="button" className="menu-row tag-row" onClick={() => onPick(t.name)}>
      <TagIcon />
      <span className="menu-label">{t.name}</span>
      <span className="menu-count">{formatCount(t.count)}</span>
    </button>
  );
}

// 내가 만든 태그 한 줄: 이름(누르면 갤러리) · 숫자 고르기 · 이름 바꾸기 · 지우기
function MineRow({ t, all, busy, onPick, onKey, onManage }) {
  const owner = (k) => all.find((x) => x.hotkey === k && x.name !== t.name);
  return (
    <div className="tag-manage-row">
      <TagButton t={t} onPick={onPick} />
      <label className="tag-key-pick">
        <span>숫자</span>
        <select value={t.hotkey === null || t.hotkey === undefined ? '' : String(t.hotkey)} disabled={busy}
          aria-label={`'${t.name}' 태그의 단축키 숫자`} onChange={(e) => onKey(t.name, e.target.value === '' ? null : Number(e.target.value))}>
          <option value="">없음</option>
          {KEYS.map((k) => {
            const o = owner(k);
            return <option key={k} value={String(k)}>{o ? `${k} (지금 '${o.name}')` : String(k)}</option>;
          })}
        </select>
      </label>
      <button type="button" className="link-button" disabled={busy} onClick={() => onManage('rename', t)}>이름 바꾸기</button>
      <button type="button" className="link-button" disabled={busy} onClick={() => onManage('delete', t)}>지우기</button>
    </div>
  );
}

// gen = 목록이 바뀔 때마다 올라가는 번호 (다시 읽기), onPick(이름) = 태그를 눌렀을 때
// onManage(mode, tag) = 만들기 · 이름 바꾸기 · 지우기 창 열기, onChanged(알림 글) = 숫자를 바꾼 뒤 (목록 다시 읽기)
export default function TagsView({ gen, onPick, onManage, onChanged }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api.tagList().then(
      (r) => { if (alive) { setList(r); setError(''); } },
      (e) => { if (alive) setError(errorText(e)); },
    );
    return () => { alive = false; };
  }, [gen]);

  const setKey = async (name, key) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.setTagHotkey(name, key);
      onChanged(hotkeyText(r.name, r.hotkey, r.moved));
    } catch (e) {
      onChanged(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="panel-hint" role="alert">{error}</p>;
  if (!list) return null;
  return (
    <div className="tags-view">
      <p className="panel-hint">태그를 누르면 그 태그의 사진만 갤러리에 보여요. 갤러리에서 사진을 고른 뒤 T 를 누르면 붙이기 창이 열리고, 숫자를 누르면 그 숫자로 정한 태그가 바로 붙어요.</p>
      <section className="tags-group" aria-label="내가 만든 태그">
        <div className="tags-head">
          <h2 className="panel-heading">내가 만든 태그</h2>
          <button type="button" className="tags-new" onClick={() => onManage('create', null)}>새 태그 만들기</button>
        </div>
        {list.manual.length ? (
          <div className="tags-rows">
            {list.manual.map((t) => <MineRow key={t.name} t={t} all={list.manual} busy={busy} onPick={onPick} onKey={setKey} onManage={onManage} />)}
          </div>
        ) : (
          <p className="panel-hint">아직 만든 태그가 없어요. 새 태그를 만들거나, 갤러리에서 사진을 고른 뒤 붙이면 여기에 모여요.</p>
        )}
      </section>
      <section className="tags-group" aria-label="앨범에서 가져온 태그">
        <h2 className="panel-heading">앨범에서 가져온 태그</h2>
        {list.album.length ? (
          <>
            <p className="panel-hint">사진 파일에서 읽은 태그라 이름을 바꾸거나 지울 수 없어요.</p>
            <div className="tags-rows">{list.album.map((t) => <TagButton key={t.name} t={t} onPick={onPick} />)}</div>
          </>
        ) : (
          <p className="panel-hint">앨범에서 가져온 태그가 없어요.</p>
        )}
      </section>
    </div>
  );
}

// 파일 위치: src/components/DetailPanel.jsx
// 역할: 오른쪽 패널. 고른 사진의 큰 미리보기, 파일 이름, 찍은 시각과 어디서 읽었는지, 위치와 어디서 읽었는지, 기기, 크기, 용량, 태그
//   위치가 있으면 장소 이름: 저장해 둔 이름은 바로, 없으면 "장소 이름 보기" 버튼 (누를 때만 좌표 하나가 OpenStreetMap 서버로 나가요)
//   없는 값은 경고 노랑 "정보 없음". 아무것도 안 골랐으면 안내 문구
//   여러 장을 고르면 "N장 선택함"과 우클릭 메뉴와 같은 버튼들 (우클릭을 모르는 사람을 위해). 한 장일 때도 사진 정보 아래에 같은 버튼들
//   복사해 둔 값이 있으면 어느 사진의 값인지와 날짜, 위치를 작게 보여 줘요
//   파일 경로는 화면이 몰라요 (getFile이 주지 않아요). 이미지는 pvm://preview/<id> 로만 받아요

import React, { useEffect, useState } from 'react';
import { api, errorText } from '../api.js';
import { formatBytes, formatCoords, formatCount, formatDuration, formatTakenAt } from '../format.mjs';
import { PreviewNote, usePreviewNote } from './PreviewNote.jsx';
import { trashMenuLabel } from '../trash-view.mjs';

const SOURCE_TEXT = { exif: '사진 파일에서 읽음', filename: '파일 이름에서 읽음', manual: '내가 넣은 값' };
const LOCATION_SOURCE_TEXT = { exif: '사진 파일에서 읽음', manual: '내가 넣은 값' };

function Missing() {
  return <span className="missing">정보 없음</span>;
}

function Row({ label, children, sub }) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>
        {children}
        {sub && <div className="detail-sub">{sub}</div>}
      </dd>
    </div>
  );
}

// 값 넣기 버튼들: 우클릭 메뉴와 같은 일을 해요. count = 고른 장수
//   onTrash: 고른 사진을 휴지통으로 (확인 창을 거쳐요, 2026-11-16). 없으면 버튼을 안 그려요
function Actions({ count, canCopy, hasCopy, onCopy, onPaste, onDirect, onMap, onTagAdd, onTagRemove, onTrash }) {
  const n = formatCount(count);
  return (
    <div className="panel-actions">
      {canCopy && <button type="button" onClick={onCopy}>날짜와 위치 복사</button>}
      {hasCopy && <button type="button" onClick={onPaste}>{n}장에 붙여넣기</button>}
      <button type="button" onClick={onDirect}>{n}장에 날짜 직접 넣기</button>
      <button type="button" onClick={onMap}>{n}장 위치 지도에서 고르기</button>
      <button type="button" data-key="T" onClick={onTagAdd} title="T 키로도 열 수 있어요">{n}장에 태그 붙이기</button>
      <button type="button" onClick={onTagRemove}>{n}장에서 태그 떼기</button>
      {onTrash && <button type="button" className="trash-button" onClick={onTrash} title="Delete 키로도 열 수 있어요">{trashMenuLabel(count)}</button>}
    </div>
  );
}

// 복사해 둔 값 요약: 어느 사진의 값인지, 날짜, 위치
function CopyNote({ source }) {
  const taken = formatTakenAt(source.takenAt);
  const coords = formatCoords(source.lat, source.lng);
  return (
    <section className="copy-note" aria-label="복사한 값">
      <h3 className="panel-heading">복사한 값</h3>
      <p className="detail-sub copy-name">{source.name}</p>
      <dl className="detail-list">
        <Row label="날짜">{taken || <Missing />}</Row>
        <Row label="위치">{coords || <Missing />}</Row>
      </dl>
    </section>
  );
}

// 장소 이름: 저장해 둔 것은 바로 읽고(인터넷 안 나감), 버튼을 누르면 서버에 물어봐요
//   state: { key, name, busy, error }. name null = 아직 모름, '' = 이름 없는 곳
function PlaceName({ file }) {
  const key = `${file.id}:${file.lat},${file.lng}`;
  const [st, setSt] = useState({ key: null, name: null, busy: false, error: '' });
  useEffect(() => {
    let stale = false;
    setSt({ key, name: null, busy: false, error: '' });
    api.placeName(file.id, false).then(
      (r) => { if (!stale) setSt((s) => (s.key === key && s.name === null ? { ...s, name: r ? r.name : null } : s)); },
      () => {}, // 저장해 둔 이름을 못 읽으면 버튼만 보여요
    );
    return () => { stale = true; };
  }, [key, file.id]);
  if (st.key !== key) return null;
  if (st.name) return <div className="detail-sub place-name">{st.name}</div>;
  if (st.name === '') return <div className="detail-sub place-name">이름이 없는 곳이에요</div>;
  const ask = () => {
    setSt((s) => ({ ...s, busy: true, error: '' }));
    api.placeName(file.id, true).then(
      (r) => setSt((s) => (s.key === key ? { ...s, busy: false, name: r ? r.name : null } : s)),
      (e) => setSt((s) => (s.key === key ? { ...s, busy: false, error: errorText(e) } : s)),
    );
  };
  return (
    <div className="place-ask">
      <button type="button" className="link-button" onClick={ask} disabled={st.busy}>
        {st.busy ? '장소 이름 찾는 중' : '장소 이름 보기'}
      </button>
      {st.error ? (
        <div className="detail-sub" role="alert">{st.error}</div>
      ) : (
        <div className="detail-sub">누르면 이 위치 하나를 OpenStreetMap 서버로 보내요</div>
      )}
    </div>
  );
}

// 선택한 파일 정보를 가져와요. 목록이 갱신되면(gen) 화면을 비우지 않고 조용히 다시 읽어요
function useFileInfo(id, gen) {
  const [info, setInfo] = useState({ id: null, file: null, error: '' });
  useEffect(() => {
    if (id === null) return undefined;
    let stale = false; // 그 사이 다른 사진을 골랐으면 이 응답은 버려요
    api.getFile(id).then(
      (file) => { if (!stale) setInfo({ id, file, error: '' }); },
      (e) => { if (!stale) setInfo({ id, file: null, error: errorText(e) }); },
    );
    return () => { stale = true; };
  }, [id, gen]);
  return info.id === id ? info : { id, file: undefined, error: '' }; // file undefined = 아직 읽는 중
}

function Preview({ file }) {
  const [broken, setBroken] = useState(false);
  const note = usePreviewNote(file.id); // 원본 대신 작은 썸네일이면 안내 한 줄
  // 파일이 바뀌거나 썸네일 상태가 달라지면 한 번 더 시도해요 (같은 상태에서는 다시 시도하지 않아요)
  useEffect(() => setBroken(false), [file.id, file.thumbState]);
  const isVideo = file.mediaType === 'video';
  const failed = broken || (isVideo && file.thumbState === 'failed');
  // 사진 비율에 맞춰 칸 모양을 정해요 (너무 길쭉하거나 납작하면 3:4 ~ 8:5 사이로)
  const ratio = file.width && file.height ? Math.min(1.6, Math.max(0.75, file.width / file.height)) : 4 / 3;
  return (
    <>
      <div className="preview" style={{ aspectRatio: String(ratio) }}>
        {failed ? (
          <span className="no-preview">미리보기 없음</span>
        ) : (
          <img key={file.id} src={`pvm://preview/${file.id}`} alt="" onLoad={note.onLoad} onError={() => setBroken(true)} />
        )}
        {isVideo && formatDuration(file.durationSec) && <span className="badge">{formatDuration(file.durationSec)}</span>}
      </div>
      <PreviewNote show={!failed && note.small} />
    </>
  );
}

// selectedId = 자세히 보여 줄 사진, count = 고른 장수, copySource = 복사해 둔 값 (없으면 null)
// onCopy / onPaste / onDirect / onMap / onTagAdd / onTagRemove = 버튼을 눌렀을 때 (우클릭 메뉴와 같은 일)
// readOnly = 사진 정보만 보여 줘요 (위치 제안 화면). 값 넣기 버튼과 복사한 값 칸을 그리지 않아요
export default function DetailPanel({ selectedId, gen, count = 0, copySource = null, onCopy, onPaste, onDirect, onMap, onTagAdd, onTagRemove, onTrash, readOnly = false }) {
  const { file, error } = useFileInfo(selectedId, gen);
  const actions = readOnly ? null : (
    <Actions count={count} canCopy={count === 1} hasCopy={!!copySource} onCopy={onCopy} onPaste={onPaste} onDirect={onDirect} onMap={onMap} onTagAdd={onTagAdd} onTagRemove={onTagRemove} onTrash={count > 0 ? onTrash : undefined} />
  );

  let body;
  if (count >= 2) {
    body = (
      <>
        <h2 className="detail-name">{formatCount(count)}장 선택함</h2>
        <p className="panel-hint">고른 사진에 같은 날짜, 위치, 태그를 한 번에 넣을 수 있어요. 넣기 전에 바뀌는 내용을 먼저 보여 드려요.</p>
        {actions}
      </>
    );
  } else if (selectedId === null) {
    body = <p className="panel-hint">사진을 누르면 여기에 자세한 정보가 보여요.</p>;
  } else if (error) {
    body = <p className="panel-hint" role="alert">{error}</p>;
  } else if (file === undefined) {
    body = null; // 읽는 중
  } else if (file === null || file.missing) {
    body = <p className="panel-hint">이 파일은 폴더에서 사라져서 목록에 없어요.</p>;
  } else {
    const taken = formatTakenAt(file.takenAt);
    const coords = formatCoords(file.lat, file.lng);
    const size = file.width && file.height ? `${file.width} × ${file.height}` : '';
    const tags = file.tags || [];
    body = (
      <>
        <Preview file={file} />
        <h2 className="detail-name">{file.name}</h2>
        {file.readError && <p className="detail-sub">파일 정보를 다 읽지 못했어요</p>}
        <dl className="detail-list">
          <Row label="찍은 시각" sub={taken && SOURCE_TEXT[file.takenAtSource]}>{taken || <Missing />}</Row>
          <Row label="위치" sub={coords && LOCATION_SOURCE_TEXT[file.locationSource]}>
            {coords || <Missing />}
            {coords && <PlaceName file={file} />}
          </Row>
          <Row label="기기">{file.model || <Missing />}</Row>
          <Row label="크기">{size || <Missing />}</Row>
          {file.mediaType === 'video' && <Row label="길이">{formatDuration(file.durationSec) || <Missing />}</Row>}
          <Row label="용량">{formatBytes(file.size) || <Missing />}</Row>
          <Row label="태그">
            {tags.length ? (
              <span className="chips">{tags.map((t) => <span className={`chip${t.mine || t.source === 'manual' ? ' mine' : ''}`} key={t.name} title={t.mine || t.source === 'manual' ? '내가 붙인 태그' : undefined}>{t.name}</span>)}</span>
            ) : (
              <Missing />
            )}
          </Row>
        </dl>
        {actions}
      </>
    );
  }
  return (
    <aside className="panel" aria-label="사진 정보">
      {body}
      {copySource && !readOnly && <CopyNote source={copySource} />}
    </aside>
  );
}

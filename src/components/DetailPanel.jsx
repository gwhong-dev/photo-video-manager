// 파일 위치: src/components/DetailPanel.jsx
// 역할: 오른쪽 패널. 고른 사진의 큰 미리보기, 파일 이름, 찍은 시각과 어디서 읽었는지, 위치, 기기, 크기, 용량, 태그
//   없는 값은 경고 노랑 "정보 없음". 아무것도 안 골랐으면 안내 문구
//   파일 경로는 화면이 몰라요 (getFile이 주지 않아요). 이미지는 pvm://preview/<id> 로만 받아요

import React, { useEffect, useState } from 'react';
import { api, errorText } from '../api.js';
import { formatBytes, formatCoords, formatDuration, formatTakenAt } from '../format.mjs';

const SOURCE_TEXT = { exif: '사진 파일에서 읽음', filename: '파일 이름에서 읽음' };

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
  // 파일이 바뀌거나 썸네일 상태가 달라지면 한 번 더 시도해요 (같은 상태에서는 다시 시도하지 않아요)
  useEffect(() => setBroken(false), [file.id, file.thumbState]);
  const isVideo = file.mediaType === 'video';
  const failed = broken || (isVideo && file.thumbState === 'failed');
  // 사진 비율에 맞춰 칸 모양을 정해요 (너무 길쭉하거나 납작하면 3:4 ~ 8:5 사이로)
  const ratio = file.width && file.height ? Math.min(1.6, Math.max(0.75, file.width / file.height)) : 4 / 3;
  return (
    <div className="preview" style={{ aspectRatio: String(ratio) }}>
      {failed ? (
        <span className="no-preview">미리보기 없음</span>
      ) : (
        <img key={file.id} src={`pvm://preview/${file.id}`} alt="" onError={() => setBroken(true)} />
      )}
      {isVideo && formatDuration(file.durationSec) && <span className="badge">{formatDuration(file.durationSec)}</span>}
    </div>
  );
}

export default function DetailPanel({ selectedId, gen }) {
  const { file, error } = useFileInfo(selectedId, gen);

  let body;
  if (selectedId === null) {
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
          <Row label="위치">{coords || <Missing />}</Row>
          <Row label="기기">{file.model || <Missing />}</Row>
          <Row label="크기">{size || <Missing />}</Row>
          {file.mediaType === 'video' && <Row label="길이">{formatDuration(file.durationSec) || <Missing />}</Row>}
          <Row label="용량">{formatBytes(file.size) || <Missing />}</Row>
          <Row label="태그">
            {tags.length ? (
              <span className="chips">{tags.map((t) => <span className="chip" key={t.name}>{t.name}</span>)}</span>
            ) : (
              <Missing />
            )}
          </Row>
        </dl>
      </>
    );
  }
  return <aside className="panel" aria-label="사진 정보">{body}</aside>;
}

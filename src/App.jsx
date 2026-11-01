// 파일 위치: src/App.jsx
// 역할: 갤러리 화면의 뼈대. 지금은 "상태 안내"만 보여 줘요 (격자, 검색, 패널은 다음 작업에서 붙여요)
//   보여 주는 상태: 읽는 중 / 백업 폴더 안 정함 / 폴더 연결 안 됨 / DB 열기 실패 / 기본 요약

import React, { useCallback, useEffect, useState } from 'react';
import { api, errorText } from './api.js';

// 가져오기 화면으로 가는 버튼 (작업 중이면 main이 거절하고 이유를 알려 줘요)
function OpenImportButton() {
  const [why, setWhy] = useState('');
  const open = async () => {
    setWhy('');
    try {
      await api.openScreen('import');
    } catch (e) {
      setWhy(errorText(e));
    }
  };
  return (
    <>
      <button type="button" onClick={open}>가져오기 화면 열기</button>
      {why && <p className="faint" role="alert">{why}</p>}
    </>
  );
}

function Notice({ title, children }) {
  return (
    <div className="notice">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [recovered, setRecovered] = useState(false); // main은 "목록 파일 새로 만듦"을 한 번만 알려 줘서 여기서 기억해요

  const refresh = useCallback(async () => {
    try {
      const s = await api.getState();
      if (s.recovered) setRecovered(true);
      setState(s);
      setLoadError('');
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, []);

  // 처음 한 번 읽고, 읽기 진행과 목록 갱신 알림이 오면 다시 읽어요
  useEffect(() => {
    refresh();
    let offScan = () => {};
    let offChanged = () => {};
    try {
      offScan = api.onScanProgress((scan) => setState((s) => (s ? { ...s, scan } : s)));
      offChanged = api.onLibraryChanged(() => refresh());
    } catch (e) { /* electron 밖이면 알림 없이 보여 줘요 */ }
    return () => {
      offScan();
      offChanged();
    };
  }, [refresh]);

  let body;
  if (loadError) {
    body = (
      <Notice title="갤러리 정보를 가져오지 못했어요">
        <p className="error">{loadError}</p>
        <button type="button" onClick={refresh}>다시 불러오기</button>
      </Notice>
    );
  } else if (!state) {
    body = <Notice title="불러오는 중이에요" />;
  } else if (state.dbError) {
    body = (
      <Notice title="갤러리 목록을 열지 못했어요">
        <p>사진 파일은 그대로예요. 가져오기 화면은 평소처럼 쓸 수 있어요.</p>
        <p className="error">{state.dbError}</p>
        <OpenImportButton />
      </Notice>
    );
  } else if (!state.root) {
    body = (
      <Notice title="백업 폴더를 아직 정하지 않았어요">
        <p>가져오기 화면에서 백업 폴더를 정하면, 그 안의 사진과 영상이 날짜별로 여기에 모여요.</p>
        <OpenImportButton />
      </Notice>
    );
  } else if (!state.connected) {
    body = (
      <Notice title="백업 폴더가 연결되어 있지 않아요">
        <p className="error">{state.root}</p>
        <p>USB나 외장 드라이브를 연결한 뒤 다시 열어 주세요. 이미 읽어 둔 목록은 그대로 있어요.</p>
        <OpenImportButton />
      </Notice>
    );
  } else {
    const scan = state.scan || {};
    body = (
      <Notice title={`사진과 영상 ${state.total.toLocaleString('ko-KR')}개`}>
        {state.noDate > 0 && <p>찍은 날짜를 모르는 파일 {state.noDate.toLocaleString('ko-KR')}개</p>}
        {scan.scanning && <p className="faint">폴더를 읽는 중이에요 ({scan.done.toLocaleString('ko-KR')} / {scan.total.toLocaleString('ko-KR')})</p>}
        <OpenImportButton />
      </Notice>
    );
  }

  return (
    <div className="shell">
      <aside className="side">
        <h1>사진/영상 관리</h1>
        {state && state.jobPending && <p>이어서 할 가져오기 작업이 있어요</p>}
        {recovered && <p>목록 파일이 깨져서 새로 만들었어요. 사진은 다시 읽는 중이에요</p>}
      </aside>
      <main className="main">{body}</main>
    </div>
  );
}

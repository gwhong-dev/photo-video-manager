// 파일 위치: src/App.jsx
// 역할: 갤러리 화면 전체. 왼쪽 메뉴(Sidebar), 가운데(Toolbar, ScanBanner, DayGrid), 오른쪽 패널(DetailPanel)을 이어 붙이고
//   필터(탭, 검색, 정렬, 태그), 날짜 목록, 선택한 사진, 폴더 읽기 상태를 들고 있어요
//   읽는 도중에도 목록이 제자리에서 갱신돼요: 알림이 와도 0.5초에 한 번만 다시 불러오고, 스크롤과 선택은 그대로 둬요

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from './api.js';
import DayGrid from './components/DayGrid.jsx';
import DetailPanel from './components/DetailPanel.jsx';
import EmptyState from './components/EmptyState.jsx';
import ScanBanner from './components/ScanBanner.jsx';
import Sidebar from './components/Sidebar.jsx';
import Toolbar from './components/Toolbar.jsx';

const START_FILTER = { tab: 'all', sort: 'newest', query: '', tag: null };
const SEARCH_DELAY_MS = 200; // 입력을 멈추고 이 시간이 지나면 검색
const REFRESH_GAP_MS = 500; // 목록 갱신 알림은 이 간격에 한 번만 받아들여요

export default function App() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [recovered, setRecovered] = useState(false); // main은 "목록 파일 새로 만듦"을 한 번만 알려 줘서 여기서 기억해요
  const [filter, setFilter] = useState(START_FILTER);
  const [searchText, setSearchText] = useState('');
  const [view, setView] = useState(null); // { key, filter, days, gen } 지금 보이는 날짜 목록
  const [daysError, setDaysError] = useState('');
  const [gen, setGen] = useState(0); // 목록이 갱신될 때마다 올라가요
  const [selectedId, setSelectedId] = useState(null);
  const [notice, setNotice] = useState(''); // 화면 전환이 거절된 이유 등
  const [rescanning, setRescanning] = useState(false);

  // ---------- 상태 읽기 ----------
  const refresh = useCallback(async () => {
    try {
      const s = await api.getState();
      if (s.recovered) setRecovered(true);
      scanningRef.current = !!(s.scan && s.scan.scanning);
      setState(s);
      setLoadError('');
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, []);

  // 목록 갱신 알림: 맨 처음 것은 바로, 그 뒤는 0.5초에 한 번만 (읽는 동안 수백 번 와도 화면이 덜덜거리지 않게)
  const throttle = useRef({ last: 0, timer: null });
  const scanningRef = useRef(false); // 지금 폴더를 읽는 중인지 (끝난 순간을 알아채려고)
  const notifyChanged = useCallback(() => {
    const t = throttle.current;
    const run = () => {
      t.last = Date.now();
      t.timer = null;
      refresh();
      setGen((g) => g + 1);
    };
    const wait = t.last + REFRESH_GAP_MS - Date.now();
    if (wait <= 0) run();
    else if (!t.timer) t.timer = setTimeout(run, wait);
  }, [refresh]);

  useEffect(() => {
    refresh();
    let offScan = () => {};
    let offChanged = () => {};
    try {
      offScan = api.onScanProgress((scan) => {
        setState((s) => (s ? { ...s, scan } : s));
        // 읽기가 끝났을 때 개수와 목록을 한 번 더 맞춰요
        if (scanningRef.current && !scan.scanning) notifyChanged();
        scanningRef.current = !!scan.scanning;
      });
      offChanged = api.onLibraryChanged(notifyChanged);
    } catch (e) { /* electron 밖이면 알림 없이 보여 줘요 */ }
    const t = throttle.current;
    return () => {
      offScan();
      offChanged();
      if (t.timer) clearTimeout(t.timer);
    };
  }, [refresh, notifyChanged]);

  // ---------- 검색어는 입력을 멈추고 0.2초 뒤에 적용 ----------
  useEffect(() => {
    if (searchText === filter.query) return undefined;
    const timer = setTimeout(() => setFilter((f) => ({ ...f, query: searchText })), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText, filter.query]);

  // ---------- 날짜 목록 ----------
  const hasList = !!(state && state.root && !state.dbError);
  const filterKey = JSON.stringify(filter);
  useEffect(() => {
    if (!hasList) {
      setView(null);
      return undefined;
    }
    let stale = false; // 그 사이 필터가 또 바뀌었으면 이 응답은 버려요
    api.listDays(filter).then(
      (days) => {
        if (stale) return;
        setView({ key: filterKey, filter, days, gen });
        setDaysError('');
      },
      (e) => { if (!stale) setDaysError(errorText(e)); },
    );
    return () => { stale = true; };
  }, [hasList, filterKey, gen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 버튼들 ----------
  const openImport = async () => {
    setNotice('');
    try {
      await api.openScreen('import');
    } catch (e) {
      setNotice(errorText(e)); // 작업 중이면 main이 거절하고 이유를 알려 줘요
    }
  };
  const rescan = async () => {
    setRescanning(true);
    try {
      await api.rescan();
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setRescanning(false);
    }
  };
  const setField = (patch) => setFilter((f) => ({ ...f, ...patch }));
  const clearSearch = () => {
    setSearchText('');
    setField({ query: '' });
  };
  const clearFilters = () => {
    setSearchText('');
    setFilter({ ...START_FILTER, sort: filter.sort });
  };

  // ---------- 가운데에 보여 줄 것 ----------
  const importButton = <button type="button" onClick={openImport}>가져오기 화면 열기</button>;
  let center;
  if (loadError) {
    center = (
      <EmptyState title="갤러리 정보를 가져오지 못했어요" action={<button type="button" onClick={refresh}>다시 불러오기</button>}>
        {loadError}
      </EmptyState>
    );
  } else if (!state) {
    center = <EmptyState title="불러오는 중이에요" />;
  } else if (state.dbError) {
    center = (
      <EmptyState title="갤러리 목록을 열지 못했어요" action={importButton} extra={<p className="error">{state.dbError}</p>}>
        사진 파일은 그대로예요. 가져오기 화면은 평소처럼 쓸 수 있어요.
      </EmptyState>
    );
  } else if (!state.root) {
    center = (
      <EmptyState title="백업 폴더를 아직 정하지 않았어요" action={importButton}>
        가져오기 화면에서 백업 폴더를 정하면, 그 안의 사진과 영상이 날짜별로 여기에 모여요.
      </EmptyState>
    );
  } else if (state.total === 0) {
    const scanning = state.scan && state.scan.scanning;
    if (!state.connected) {
      center = (
        <EmptyState title="폴더 연결 안 됨" action={<button type="button" onClick={rescan} disabled={rescanning}>백업 폴더 다시 읽기</button>}>
          USB나 외장 드라이브를 연결한 뒤 눌러 주세요. 아직 읽어 둔 사진이 없어요.
        </EmptyState>
      );
    } else if (scanning) {
      center = <EmptyState title="사진을 찾는 중이에요">찾는 대로 여기에 날짜별로 모여요.</EmptyState>;
    } else if (state.tools && !state.tools.exiftool) {
      center = <EmptyState title="아직 읽어 둔 사진이 없어요" action={importButton}>exiftool을 찾으면 백업 폴더의 사진을 읽어 와요.</EmptyState>;
    } else {
      center = (
        <EmptyState title="백업 폴더에 사진이나 영상이 없어요" action={importButton}>
          가져오기 화면에서 사진을 옮겨 오면 여기에 모여요.
        </EmptyState>
      );
    }
  } else if (daysError && !view) {
    center = (
      <EmptyState title="사진 목록을 불러오지 못했어요" action={<button type="button" onClick={() => setGen((g) => g + 1)}>다시 불러오기</button>}>
        {daysError}
      </EmptyState>
    );
  } else if (view && view.days.length === 0) {
    const searching = !!view.filter.query;
    center = (
      <EmptyState
        title="찾는 사진이 없어요"
        action={searching
          ? <button type="button" onClick={clearSearch}>검색어 지우기</button>
          : <button type="button" onClick={clearFilters}>전체 사진 보기</button>}
      >
        {searching ? '다른 낱말로 찾아 보세요. 파일 이름, 태그, 날짜로 찾을 수 있어요.' : '이 조건에 맞는 사진이 아직 없어요.'}
      </EmptyState>
    );
  } else if (view) {
    center = <DayGrid view={view} selectedId={selectedId} onSelect={setSelectedId} />;
  } else {
    center = null; // 날짜 목록을 받는 중
  }

  const showTools = !!(state && state.root && !state.dbError && state.total > 0);
  return (
    <div className="shell">
      <Sidebar
        state={state}
        filter={filter}
        onOpenImport={openImport}
        onPickTag={(tag) => setField({ tag })}
        onRescan={rescan}
        rescanning={rescanning}
      />
      <main className="main">
        {showTools && (
          <Toolbar
            filter={filter}
            searchText={searchText}
            onSearchText={setSearchText}
            onTab={(tab) => setField({ tab })}
            onSort={(sort) => setField({ sort })}
          />
        )}
        <ScanBanner
          state={state}
          recovered={recovered}
          notice={notice}
          onDismissNotice={() => setNotice('')}
          onRescan={rescan}
          rescanning={rescanning}
        />
        <div className="center">{center}</div>
      </main>
      {showTools && <DetailPanel selectedId={selectedId} gen={gen} />}
    </div>
  );
}

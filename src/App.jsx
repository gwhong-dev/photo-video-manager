// 파일 위치: src/App.jsx
// 역할: 갤러리 화면 전체. 왼쪽 메뉴(Sidebar), 가운데(Toolbar, ScanBanner, DayGrid), 오른쪽 패널(DetailPanel)을 이어 붙이고
//   화면(갤러리 / 정보 없는 사진), 필터(탭, 검색, 정렬, 태그), 날짜 목록, 고른 사진들, 폴더 읽기 상태를 들고 있어요
//   두 화면은 같은 창 안에서 바뀌어요 (정보 없는 사진 화면은 filter.info 가 있는 갤러리와 같은 격자예요)
//   읽는 도중에도 목록이 제자리에서 갱신돼요: 알림이 와도 0.5초에 한 번만 다시 불러오고, 스크롤과 선택은 그대로 둬요
//   고른 사진들(selection)은 탭, 필터(검색어와 태그 포함), 화면이 바뀌면 비워요. 정렬이 바뀔 때와 목록 갱신 때는 그대로 둬요

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from './api.js';
import DayGrid from './components/DayGrid.jsx';
import DetailPanel from './components/DetailPanel.jsx';
import EmptyState from './components/EmptyState.jsx';
import ScanBanner from './components/ScanBanner.jsx';
import Sidebar from './components/Sidebar.jsx';
import Toolbar from './components/Toolbar.jsx';
import { EMPTY_SELECTION, nextSelection, selectionForMenu, selectionOf } from './selection.mjs';

const START_FILTER = { tab: 'all', sort: 'newest', query: '', tag: null };
const SEARCH_DELAY_MS = 200; // 입력을 멈추고 이 시간이 지나면 검색
const REFRESH_GAP_MS = 500; // 목록 갱신 알림은 이 간격에 한 번만 받아들여요
const MISSING_FILTER = { ...START_FILTER, info: 'noLocation' }; // 정보 없는 사진 화면을 처음 열 때

// 정보 없는 사진 화면의 탭이 비었을 때 보여 줄 문구
const EMPTY_INFO_TEXT = {
  noLocation: ['위치 없는 사진이 없어요', '모든 사진에 위치가 있어요. 스크린샷은 위치 없음에 세지 않아요.'],
  noDate: ['날짜 없는 사진이 없어요', '모든 사진에 찍은 날짜가 있어요.'],
  manual: ['직접 넣은 정보가 아직 없어요', '날짜나 위치를 직접 넣은 사진이 여기에 모여요.'],
};

export default function App() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [recovered, setRecovered] = useState(false); // main은 "목록 파일 새로 만듦"을 한 번만 알려 줘서 여기서 기억해요
  const [filter, setFilter] = useState(START_FILTER);
  const [searchText, setSearchText] = useState('');
  const [view, setView] = useState(null); // { key, filter, days, gen } 지금 보이는 날짜 목록
  const [daysError, setDaysError] = useState('');
  const [gen, setGen] = useState(0); // 목록이 갱신될 때마다 올라가요
  const [screen, setScreen] = useState('gallery'); // 'gallery' | 'missing' (같은 창 안의 화면 전환)
  const [selection, setSelection] = useState(EMPTY_SELECTION); // { ids, anchor, focus }
  const [cellMenuAt, setCellMenuAt] = useState(null); // 작업 7: 우클릭한 자리 { x, y }. 우클릭 메뉴가 이 값을 읽어 그려요
  const [selectingAll, setSelectingAll] = useState(false); // "목록 전체 선택"으로 번호를 받아오는 중
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
      if (t.timer) {
        clearTimeout(t.timer);
        t.timer = null;
      }
    };
  }, [refresh, notifyChanged]);

  // ---------- 고른 사진 비우기 ----------
  // 화면, 탭, 검색어, 태그가 달라지면 비워요 (정렬은 같은 사진들이라 그대로). 그려지기 전에 바로 바꿔서 한 번도 어긋나게 보이지 않아요
  const scope = `${screen}|${filter.tab}|${filter.info || ''}|${filter.query}|${filter.tag || ''}`;
  const [scopeSeen, setScopeSeen] = useState(scope);
  if (scopeSeen !== scope) {
    setScopeSeen(scope);
    setSelection(EMPTY_SELECTION);
    setCellMenuAt(null);
  }
  const scopeRef = useRef(scope); // 비동기 응답이 "그 사이 필터가 바뀌었나"를 알 수 있게
  scopeRef.current = scope;

  // ---------- 검색어는 입력을 멈추고 0.2초 뒤에 적용 ----------
  useEffect(() => {
    if (searchText === filter.query) return undefined;
    const timer = setTimeout(() => setFilter((f) => ({ ...f, query: searchText })), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText, filter.query]);

  // ---------- 날짜 목록 ----------
  const hasList = !!(state && state.root && !state.dbError);
  const filterKey = JSON.stringify(filter);
  // 요청 번호: 더 새 요청의 응답이 이미 화면에 들어갔을 때만 옛 응답을 버려요
  //   (읽는 동안 0.5초마다 새 요청이 시작돼도, 느린 응답이 계속 버려져 화면이 굶지 않게)
  const daysSeq = useRef({ started: 0, applied: 0 });
  useEffect(() => {
    const seq = daysSeq.current;
    if (!hasList) {
      seq.applied = ++seq.started; // 이미 나간 요청의 응답은 모두 버려요
      setView(null);
      return;
    }
    const mine = ++seq.started;
    api.listDays(filter).then(
      (days) => {
        if (mine < seq.applied) return;
        seq.applied = mine;
        setView({ key: filterKey, filter, days, gen });
        setDaysError('');
      },
      (e) => { if (mine >= seq.applied) setDaysError(errorText(e)); },
    );
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
    setFilter({ ...START_FILTER, sort: filter.sort, ...(filter.info ? { info: filter.info } : {}) }); // 정보 없는 사진 화면이면 그 탭은 그대로
  };
  // 화면 바꾸기: 필터는 처음 모양으로 (정보 없는 사진 화면은 위치 없음 탭부터), 정렬만 그대로
  const goScreen = (next) => {
    if (next === screen) return;
    setScreen(next);
    setSearchText('');
    setFilter({ ...(next === 'missing' ? MISSING_FILTER : START_FILTER), sort: filter.sort });
  };

  // ---------- 고르기 ----------
  const onCellClick = useCallback((file, event, dayFiles) => {
    const ctrl = event.ctrlKey || event.metaKey;
    setSelection((sel) => nextSelection(sel, { id: file.id, ctrl, shift: event.shiftKey, dayFiles }));
  }, []);
  // 우클릭: 선택 밖의 칸이면 그 칸만 골라요. 메뉴 그리기는 작업 7
  const onCellMenu = useCallback((file, event) => {
    setSelection((sel) => selectionForMenu(sel, file.id));
    setCellMenuAt({ x: event.clientX, y: event.clientY });
  }, []);
  // 번호를 받아오는 사이 필터가 바뀌었으면 그 결과는 버려요
  const selectIds = async (load) => {
    const at = scopeRef.current;
    try {
      const ids = await load();
      if (scopeRef.current === at) setSelection(selectionOf(ids));
    } catch (e) {
      if (scopeRef.current === at) setNotice(errorText(e));
    }
  };
  const selectDay = (day) => selectIds(() => api.listFiles(day, view.filter).then((files) => files.map((f) => f.id)));
  const selectAll = async () => {
    setSelectingAll(true);
    try {
      await selectIds(() => api.listIds(view ? view.filter : filter));
    } finally {
      setSelectingAll(false);
    }
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
  } else if (view && view.days.length === 0 && view.filter.info && !view.filter.query && !view.filter.tag && EMPTY_INFO_TEXT[view.filter.info]) {
    const [title, text] = EMPTY_INFO_TEXT[view.filter.info];
    center = <EmptyState title={title}>{text}</EmptyState>;
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
    center = <DayGrid view={view} selection={selection} onCellClick={onCellClick} onCellMenu={onCellMenu} onSelectDay={selectDay} />;
  } else {
    center = null; // 날짜 목록을 받는 중
  }

  const showTools = !!(state && state.root && !state.dbError && state.total > 0);
  return (
    <div className="shell">
      <Sidebar
        state={state}
        screen={screen}
        filter={filter}
        onOpenImport={openImport}
        onScreen={goScreen}
        onPickTag={(tag) => setField({ tag })}
        onRescan={rescan}
        rescanning={rescanning}
      />
      <main className="main">
        {showTools && (
          <Toolbar
            screen={screen}
            state={state}
            filter={filter}
            searchText={searchText}
            onSearchText={setSearchText}
            onTab={(tab) => setField({ tab })}
            onInfo={(info) => setField({ info })}
            onSort={(sort) => setField({ sort })}
            onSelectAll={selectAll}
            selectingAll={selectingAll}
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
      {showTools && <DetailPanel selectedId={selection.focus} gen={gen} />}
    </div>
  );
}

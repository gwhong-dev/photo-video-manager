// 파일 위치: src/App.jsx
// 역할: 갤러리 화면 전체. 왼쪽 메뉴(Sidebar), 가운데(Toolbar, ScanBanner, DayGrid), 오른쪽 패널(DetailPanel)을 이어 붙이고
//   화면(갤러리 / 정보 없는 사진), 필터(탭, 검색, 정렬, 태그), 날짜 목록, 고른 사진들, 폴더 읽기 상태를 들고 있어요
//   두 화면은 같은 창 안에서 바뀌어요 (정보 없는 사진 화면은 filter.info 가 있는 갤러리와 같은 격자예요)
//   읽는 도중에도 목록이 제자리에서 갱신돼요: 알림이 와도 0.5초에 한 번만 다시 불러오고, 스크롤과 선택은 그대로 둬요
//   고른 사진들(selection)은 탭, 필터(검색어와 태그 포함), 화면이 바뀌면 비워요. 정렬이 바뀔 때와 목록 갱신 때는 그대로 둬요
//   날짜와 위치 넣기: 우클릭 메뉴(ContextMenu)나 오른쪽 패널 버튼 -> 미리보기 창(EditDialog) -> 넣기 -> 되돌리기 줄(UndoBar)
//   복사한 값(copySource)은 기준 사진의 번호와 요약만 기억해요. 화면을 바꿔도 남고, 프로그램을 끄면 사라져요
//   번호는 sessionStorage에도 적어 두어서 가져오기 화면에 다녀와도 남고, 목록이 바뀔 때마다 요약을 DB에서 다시 읽어요
//   값을 넣은 뒤와 되돌린 뒤에는 선택을 비워요. 오류와 "N장 위치를 되돌렸어요" 알림은 모두 기존 notice 줄로 보여요
//   화면을 바꿔도 검색어는 그대로예요 (선택은 비워져요)
//   위치 제안 탭(suggestOpen)을 열면 격자 대신 SuggestPanel을 보여 주고, 오른쪽 패널은 읽기 전용이 돼요
//   지도에서 마지막으로 고른 곳(lastPin)은 다음에 지도 창을 열 때의 처음 위치예요. 프로그램을 끄면 사라져요
//   태그 (단계 5): 우클릭 메뉴나 오른쪽 패널 -> 태그 창(TagDialog) -> 붙이기·떼기 -> 같은 되돌리기 줄
//   태그 화면(TagsView)에서 태그를 누르면 갤러리 화면으로 가서 그 태그의 사진만 보여요
//   가져오기 전 거르기 (2026-11-18, state.screening): 가져올 폴더를 비슷한 사진 화면으로 열어요. 쓸 수 있는 건 비슷한 사진 · 갤러리 격자 ·
//   휴지통으로 옮기기뿐이에요 (날짜 · 위치 · 태그 · 지도 · 정리는 main 도 막아요). 맨 위 띠의 "거르기 끝내고 가져오기로"로 가져오기 화면으로

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from './api.js';
import ContextMenu from './components/ContextMenu.jsx';
import DayGrid from './components/DayGrid.jsx';
import DetailPanel from './components/DetailPanel.jsx';
import EditDialog from './components/EditDialog.jsx';
import SimilarView from './components/SimilarView.jsx';
import EmptyState from './components/EmptyState.jsx';
import ScanBanner from './components/ScanBanner.jsx';
import Sidebar from './components/Sidebar.jsx';
import SuggestPanel from './components/SuggestPanel.jsx';
import TagDialog from './components/TagDialog.jsx';
import TagManageDialog from './components/TagManageDialog.jsx';
import TagsView from './components/TagsView.jsx';
import MapView from './components/MapView.jsx';
import MapPanel from './components/MapPanel.jsx';
import CleanView from './components/CleanView.jsx';
import CleanPanel from './components/CleanPanel.jsx';
import Toolbar from './components/Toolbar.jsx';
import UndoBar from './components/UndoBar.jsx';
import FillBanner from './components/FillBanner.jsx';
import FillDialog from './components/FillDialog.jsx';
import TrashDialog from './components/TrashDialog.jsx';
import { deleteKeyOpens } from './trash-view.mjs';
import { formatCount, needsManyCheck, undoneText } from './format.mjs';
import { alreadyText, noKeyText, quickTags, tagKeyAction, tagOfKey } from './tag-keys.mjs';
import { EMPTY_SELECTION, filterScope, needsWholeList, nextSelection, selectionForMenu, selectionOf, viewMatches } from './selection.mjs';
import { pickTable, remainingAfter, selectionPick } from './pick-view.mjs';

const START_FILTER = { tab: 'all', sort: 'newest', query: '', tag: null, area: null }; // area: 지도에서 고른 곳 { rects, year }
const SEARCH_DELAY_MS = 200; // 입력을 멈추고 이 시간이 지나면 검색
const REFRESH_GAP_MS = 500; // 목록 갱신 알림은 이 간격에 한 번만 받아들여요
const MISSING_FILTER = { ...START_FILTER, info: 'noLocation' }; // 정보 없는 사진 화면을 처음 열 때

// 정보 없는 사진 화면의 탭이 비었을 때 보여 줄 문구
const EMPTY_INFO_TEXT = {
  noLocation: ['위치 없는 사진이 없어요', '모든 사진에 위치가 있어요. 스크린샷은 위치 없음에 세지 않아요.'],
  noDate: ['날짜 없는 사진이 없어요', '모든 사진에 찍은 날짜가 있어요.'],
  manual: ['직접 넣은 정보가 아직 없어요', '날짜나 위치를 직접 넣은 사진이 여기에 모여요.'],
};

// 복사해 둔 사진 번호를 창이 다시 불러와도 남게 적어 둬요 (프로그램을 끄면 사라져요). 저장소를 못 쓰면 없이 동작해요
const COPY_KEY = 'pvm.copySourceId';
function readCopyId() {
  try {
    const n = Number(window.sessionStorage.getItem(COPY_KEY));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (e) {
    return null;
  }
}
function writeCopyId(id) {
  try {
    if (id == null) window.sessionStorage.removeItem(COPY_KEY);
    else window.sessionStorage.setItem(COPY_KEY, String(id));
  } catch (e) { /* 저장 못 해도 이번 화면에서는 그대로 써요 */ }
}

export default function App() {
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [recovered, setRecovered] = useState(false); // main은 "목록 파일 새로 만듦"을 한 번만 알려 줘서 여기서 기억해요
  const [filter, setFilter] = useState(START_FILTER);
  const [searchText, setSearchText] = useState('');
  const [view, setView] = useState(null); // { key, filter, days, gen } 지금 보이는 날짜 목록
  const [daysError, setDaysError] = useState('');
  const [gen, setGen] = useState(0); // 목록이 갱신될 때마다 올라가요
  const [screen, setScreen] = useState('gallery'); // 'gallery' | 'missing' | 'similar' | 'tags' | 'map' | 'clean' (같은 창 안의 화면 전환)
  const [cleanPick, setCleanPick] = useState(null); // 정리 화면에서 고른 기록
  const [mapPick, setMapPick] = useState(null); // 지도에서 고른 핀의 요약 (src/places-view.mjs summarize)
  const [mapLocated, setMapLocated] = useState(null); // 위치가 있는 사진 수 (지도 패널 안내용)
  const [mapTop, setMapTop] = useState([]); // 사진을 많이 찍은 곳 (지도 패널)
  const [mapGoto, setMapGoto] = useState(null); // 패널에서 누른 많이 찍은 곳 { key, seq } → 지도가 그 묶음을 고르고 그곳을 보여 줘요
  const mapViewRef = useRef({ center: null, zoom: null, year: null, gotoSeq: 0 }); // 지도 화면을 다시 열 때 이어서 보여 줄 곳 (gotoSeq: 처리한 많이 찍은 곳 번호)
  const [similarFocus, setSimilarFocus] = useState(null); // 비슷한 사진 화면에서 오른쪽 패널에 보여 줄 사진 번호
  const [selection, setSelection] = useState(EMPTY_SELECTION); // { ids, anchor, focus }
  const selectionRef = useRef(selection); // 칸 클릭(바뀌지 않는 함수)에서 지금 선택을 보려고
  selectionRef.current = selection;
  const [cellMenuAt, setCellMenuAt] = useState(null); // 우클릭한 자리 { x, y }. 있으면 우클릭 메뉴를 그려요
  const [copySource, setCopySource] = useState(null); // 복사해 둔 값 { id, name, takenAt, lat, lng } (파일 경로 없음)
  const [dialog, setDialog] = useState(null); // 미리보기 창: { mode: 'copy' | 'direct' | 'map' | 'suggest' | 'tagAdd' | 'tagRemove', ids, prefer, startAt, place, more }. 열 때의 선택을 그대로 담아요
  const [lastPin, setLastPin] = useState(null); // 이번 실행에서 지도로 마지막에 넣은 곳 { lat, lng }
  const [justApplied, setJustApplied] = useState(null); // 방금 넣은 묶음 { batchId }. 넣은 직후 알림 줄을 보여 줘요
  const [undoing, setUndoing] = useState(false);
  const [fillOpen, setFillOpen] = useState(false); // 날짜 없음 채우기 창
  const [trashIds, setTrashIds] = useState(null); // 휴지통으로 옮기기 확인 창에 담은 사진 번호 (열 때의 선택 그대로, 2026-11-16)
  const [fillUndoing, setFillUndoing] = useState(false);
  const [syncing, setSyncing] = useState(false); // 넣은 직후 새 상태(마지막 묶음)를 받아오는 중. 그동안 되돌리기 버튼을 꺼요
  const [selectingAll, setSelectingAll] = useState(false); // "목록 전체 선택"으로 번호를 받아오는 중
  const [notice, setNotice] = useState(''); // 화면 전환이 거절된 이유 등
  const [rescanning, setRescanning] = useState(false);
  // "위치 제안" 탭을 보는 중인지. filter.info 에 넣으면 격자 목록을 헛되이 읽어서 따로 둬요
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestFocus, setSuggestFocus] = useState(null); // 위치 제안에서 오른쪽 패널에 보여 줄 사진 번호
  const screening = !!(state && state.screening); // 가져오기 전 거르기 중인지
  // 거르기로 열리면 처음 한 번 비슷한 사진 화면부터 보여 줘요 (거르기 중에 갤러리로 가도 다시 돌려놓지 않아요)
  const screenOpened = useRef(false);
  useEffect(() => {
    if (screening && !screenOpened.current) {
      screenOpened.current = true;
      setScreen('similar');
    }
  }, [screening]);

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
  const scope = `${screen}|${suggestOpen}|${filterScope(filter)}`;
  const [scopeSeen, setScopeSeen] = useState(scope);
  if (scopeSeen !== scope) {
    setScopeSeen(scope);
    setSelection(EMPTY_SELECTION);
    setCellMenuAt(null);
  }
  const scopeRef = useRef(scope); // 비동기 응답이 "그 사이 필터가 바뀌었나"를 알 수 있게
  scopeRef.current = scope;
  // 필터를 바꾼 직후에는 옛 목록이 잠깐 남아 있어요. 그 사이의 고르기는 받지 않아요 (옛 목록의 번호가 섞이지 않게)
  const viewCurrent = viewMatches(view, filter);
  const viewCurrentRef = useRef(viewCurrent);
  viewCurrentRef.current = viewCurrent;
  const viewFilterRef = useRef(null); // 날을 넘는 Shift 범위에서 목록 전체 번호를 받을 필터
  viewFilterRef.current = view ? view.filter : null;

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
  // 화면 바꾸기: 필터는 처음 모양으로 (정보 없는 사진 화면은 위치 없음 탭부터), 정렬과 검색어는 그대로
  //   (갤러리에서 날짜를 찾아 복사한 뒤 정보 없는 사진 화면으로 가도 그 검색이 남아 있게). 고른 사진은 화면이 바뀌어서 비워져요
  const goScreen = (next) => {
    if (next === screen) return;
    if (screening && next !== 'gallery' && next !== 'similar') {
      setNotice('가져오기 전 거르기 중에는 갤러리와 비슷한 사진 화면만 쓸 수 있어요. 거르기를 끝낸 뒤에 해 주세요.');
      return;
    }
    setSuggestOpen(false);
    setSimilarFocus(null);
    setScreen(next);
    setFilter({ ...(next === 'missing' ? MISSING_FILTER : START_FILTER), sort: filter.sort, query: filter.query });
  };

  // 태그 화면에서 태그를 누르면: 갤러리 화면으로 가서 그 태그만 (검색어는 지워서 그 태그의 사진이 다 보이게)
  const pickTagFromList = (tag) => {
    setSuggestOpen(false);
    setSimilarFocus(null);
    setScreen('gallery');
    setSearchText('');
    setFilter({ ...START_FILTER, sort: filter.sort, tag });
  };

  // 지도에서 고른 곳의 사진을 갤러리에서: 그 영역(칸 목록)과 연도로 거른 갤러리 (검색어는 지워서 다 보이게)
  const showArea = (area) => {
    setSuggestOpen(false);
    setSimilarFocus(null);
    setScreen('gallery');
    setSearchText('');
    setFilter({ ...START_FILTER, sort: filter.sort, area });
  };

  // ---------- 고르기 ----------
  const onCellClick = useCallback((file, event, dayFiles) => {
    if (!viewCurrentRef.current) return;
    const pick = { id: file.id, ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey };
    if (!needsWholeList(selectionRef.current, { ...pick, dayFiles })) {
      setSelection((sel) => nextSelection(sel, { ...pick, dayFiles }));
      return;
    }
    // 다른 날에서 시작한 Shift 범위: 목록 전체 번호(화면 순서)를 받아 그 사이를 모두 골라요
    //   받는 사이 필터 · 정렬이 바뀌었거나 다른 칸을 또 눌러 선택이 달라졌으면 버려요 (늦게 온 결과가 새 선택을 덮지 않게)
    //   받기에 실패하면 누른 칸 한 장만 (예전처럼)
    const at = scopeRef.current;
    const before = selectionRef.current;
    const asked = viewFilterRef.current;
    api.listIds(asked)
      .then((ids) => ids, () => null)
      .then((ids) => {
        if (scopeRef.current !== at || selectionRef.current !== before || viewFilterRef.current !== asked) return;
        setSelection((sel) => nextSelection(sel, { ...pick, dayFiles: ids || dayFiles }));
      });
  }, []);
  // 우클릭: 선택 밖의 칸이면 그 칸만 골라요. 메뉴는 아래 render에서 cellMenuAt 으로 그려요
  const onCellMenu = useCallback((file, event) => {
    if (!viewCurrentRef.current) return;
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
  const selectDay = (day) => viewCurrent && selectIds(() => api.listFiles(day, view.filter).then((files) => files.map((f) => f.id)));
  const selectAll = async () => {
    if (!viewCurrent) return;
    setSelectingAll(true);
    try {
      await selectIds(() => api.listIds(view.filter));
    } finally {
      setSelectingAll(false);
    }
  };

  // ---------- 복사해 둔 값 이어 가기 ----------
  // 가져오기 화면에 다녀오면 화면을 새로 불러와서 state가 비어요. 번호만 sessionStorage에 두고 다시 읽어요
  const copyIdRef = useRef(readCopyId());
  const keepCopy = (source) => {
    copyIdRef.current = source ? source.id : null;
    writeCopyId(copyIdRef.current);
    setCopySource(source);
  };
  // 처음 켤 때와 목록이 바뀔 때마다(gen) 요약을 DB 값으로 맞춰요
  useEffect(() => {
    const id = copyIdRef.current;
    if (id == null) return undefined;
    let alive = true;
    api.getCopySource(id).then(
      (source) => {
        if (!alive || copyIdRef.current !== id) return; // 그사이 다른 사진을 복사했으면 버려요
        // null이면(켜는 중이라 목록이 아직 없거나 사진이 사라짐) 지금 요약을 그대로 둬요. 붙여 넣을 때 main이 다시 확인해요
        if (source) setCopySource(source);
      },
      () => { /* 읽기 실패면 지금 요약을 그대로 둬요. 붙여 넣을 때 main이 다시 읽어요 */ },
    );
    return () => { alive = false; };
  }, [gen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 날짜와 위치 넣기 ----------
  const closeMenu = useCallback(() => setCellMenuAt(null), []);
  // 복사: 한 장일 때만. 값은 main이 DB에서 읽어 줘요 (화면은 번호와 요약만 기억)
  const copyValue = async () => {
    setCellMenuAt(null);
    if (selection.ids.size !== 1) return;
    const [id] = selection.ids;
    try {
      const source = await api.getCopySource(id);
      if (!source) {
        setNotice('이 사진은 폴더에서 사라져서 복사할 수 없어요.');
      } else if (!source.takenAt && !(typeof source.lat === 'number' && typeof source.lng === 'number')) {
        setNotice('이 사진에는 복사할 날짜나 위치가 없어요.');
      } else {
        keepCopy(source);
        setNotice('');
      }
    } catch (e) {
      setNotice(errorText(e));
    }
  };
  // ---------- 고른 사진에 근처 사진 위치 제안 (2026-11-21) ----------
  //   갤러리 · 정보 없는 사진 화면에서 사진을 고르면, 그 백업 폴더의 제안 표를 목록 번호(gen)마다 한 번 받아요
  //   (위치 제안 탭이 쓰는 listSuggestions 응답의 picks). 고른 사진 중 위치 없는 사진에 제안이 있으면 버튼이 생겨요
  const pickScreen = (screen === 'gallery' || screen === 'missing') && !suggestOpen && !screening && !!(state && state.root);
  //   폴더를 읽는 동안에는 목록 번호가 자주 바뀌어서 받지 않아요 (끝난 뒤 한 번만)
  const scanningNow = !!(state && state.scan && state.scan.scanning);
  const wantPick = pickScreen && !scanningNow && selection.ids.size > 0;
  const [pickTab, setPickTab] = useState({ gen: -1, table: null });
  useEffect(() => {
    if (!wantPick || pickTab.gen === gen) return undefined;
    let alive = true;
    api.listSuggestions().then(
      (res) => { if (alive) setPickTab({ gen, table: pickTable(res) }); },
      () => { if (alive) setPickTab({ gen, table: null }); }, // 못 받으면 버튼만 안 보여요 (지도에서 고르기는 그대로)
    );
    return () => { alive = false; };
  }, [wantPick, gen]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = useMemo(
    () => (wantPick && pickTab.gen === gen ? selectionPick(selection.ids, pickTab.table) : null),
    [wantPick, pickTab, gen, selection.ids],
  );

  // 미리보기 창 열기. 열 때 고른 사진 번호를 그대로 담아 두어서, 창이 열린 동안 선택이 바뀌어도 대상은 같아요
  //   지도 창은 근처 사진 제안이 있으면 그 위치에서 열려요 (없으면 마지막으로 고른 곳)
  //   근처 사진 위치 넣기(suggest)는 첫 곳의 사진만 담아요. 남은 곳이 있으면 넣은 뒤에도 선택을 남겨요
  const openDialog = (mode) => {
    setCellMenuAt(null);
    if (selection.ids.size === 0 || (mode === 'copy' && !copySource)) return;
    if (mode === 'suggest' && !pick) return;
    setNotice('');
    if (mode === 'suggest') {
      setDialog({ mode, ids: pick.places[0].ids, place: pick.places[0], more: pick.places.length > 1 });
      return;
    }
    const startAt = mode === 'map' && pick ? { lat: pick.places[0].source.lat, lng: pick.places[0].source.lng } : null;
    setDialog({ mode, ids: [...selection.ids], prefer: filter.info === 'noDate' ? 'date' : 'location', startAt });
  };
  // 넣기가 끝났을 때: 창을 닫고 선택을 비우고, 상태와 목록을 바로 다시 읽어요 (되돌리기 줄이 곧 나타나도록)
  //   keep: 근처 사진 위치 넣기가 아직 남은 곳이 있으면, 넣은 사진만 빼고 선택을 남겨요 (다음 곳 버튼이 바로 보이게)
  //   (넣은 사진을 남기면 위치 없음 탭에서 목록에서 빠진 사진이 휴지통 · 지도 고르기 대상에 남아요)
  //   dropped: 그 사이 위치가 생겨 main 이 뺀 장수 (위치 제안 탭과 같은 안내)
  const onApplied = async (result, { keep = null } = {}) => {
    setDialog(null);
    const changed = !!(result && result.count);
    if (keep && changed) {
      const rest = remainingAfter(selection.ids, keep);
      setSelection(rest.length ? selectionOf(rest) : EMPTY_SELECTION);
    } else {
      setSelection(EMPTY_SELECTION);
    }
    if (!changed) {
      setNotice('바꿀 사진이 없어서 아무것도 넣지 않았어요.');
      return;
    }
    if (result.dropped) setNotice(`그 사이 위치가 생긴 ${formatCount(result.dropped)}장은 빼고 넣었어요.`);
    // 새 상태가 오기 전에는 되돌리기 줄에 앞 묶음의 글이 남아 있을 수 있어서, 도착할 때까지 버튼을 꺼요
    setSyncing(true);
    setJustApplied({ batchId: result.batchId, name: result.name || null });
    setGen((g) => g + 1);
    try {
      await refresh();
    } finally {
      setSyncing(false);
    }
  };

  // ---------- 태그 만들기 · 이름 바꾸기 · 지우기 (2026-11-18) ----------
  //   창(TagManageDialog)은 태그 화면과 왼쪽 메뉴 "새 태그"에서 열어요. 사진을 고르지 않아도 돼요
  const [tagEdit, setTagEdit] = useState(null); // { mode: 'create' | 'rename' | 'delete', tag }
  // 끝났을 때: 사진이 바뀐 묶음이면 되돌리기 줄을, 아니면(빈 태그) 알림 글을 보여 줘요
  const onTagManaged = async (result, text) => {
    setTagEdit(null);
    setNotice('');
    if (result && result.batchId) {
      setSyncing(true);
      setJustApplied({ batchId: result.batchId, name: result.name || null });
    } else if (text) {
      setNotice(text);
    }
    setGen((g) => g + 1);
    try {
      await refresh();
    } finally {
      setSyncing(false);
    }
  };

  // ---------- 숫자 단축키로 바로 붙이기 (2026-11-18) ----------
  //   태그 화면에서 그 숫자로 정한 태그를 고른 사진에 붙여요. 미리보기 창 없이 바로 붙이고 되돌리기 줄을 보여 줘요
  //   이미 모두 붙어 있으면 아무것도 안 해요 (떼지 않아요: 잘못 눌러도 태그가 사라지지 않게. 떼기는 떼기 창이나 되돌리기로)
  //   100장 이상이면 바로 붙이지 않고 이름을 적어 둔 붙이기 창을 열어요 (장수 확인을 한 번 더 받는 규칙, 2026-11-04)
  //   붙인 뒤에도 선택은 그대로 둬요 (같은 사진에 다른 숫자 태그를 이어서 붙일 수 있게)
  const quickBusy = useRef(false);
  const quickTag = async (key) => {
    setCellMenuAt(null);
    if (quickBusy.current || selection.ids.size === 0) return;
    const name = tagOfKey((state && state.manualTags) || [], key);
    if (!name) {
      setNotice(noKeyText(key));
      return;
    }
    const ids = [...selection.ids];
    if (needsManyCheck(ids.length)) {
      setNotice('');
      setDialog({ mode: 'tagAdd', ids, name });
      return;
    }
    quickBusy.current = true;
    setNotice('');
    try {
      const r = await api.applyTag(ids, { op: 'add', name });
      if (!r || !r.count) {
        setNotice(alreadyText(ids.length, name));
        return;
      }
      setSyncing(true);
      setJustApplied({ batchId: r.batchId, name: r.name || name });
      setGen((g) => g + 1);
      await refresh();
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      quickBusy.current = false;
      setSyncing(false);
    }
  };
  // 되돌리기: 마지막 묶음부터. batchId = 버튼에 적힌 묶음의 번호 (main이 지금 마지막 묶음과 다르면 거절해요)
  //   새 상태를 받아올 때까지 버튼을 계속 꺼 둬서, 두 번 눌러도 앞 묶음까지 되돌리지 않게 해요
  const undoRef = useRef(false);
  const undo = async (batchId) => {
    if (undoRef.current) return;
    undoRef.current = true;
    setUndoing(true);
    setNotice('');
    try {
      const result = await api.undoLast(batchId);
      if (!result) {
        setNotice('되돌릴 작업이 없어요.');
      } else {
        // 되돌린 사진은 목록에서 빠지거나 바뀌어요. 선택이 남아 있으면 이미 목록에 없는 사진에 다음 작업이 갈 수 있어서 비워요
        setSelection(EMPTY_SELECTION);
        // 그 넣기에서 체크를 꺼 건너뛴 사진을 목록 파일에서 빼지 못했으면 알려요 (이번 실행 동안은 다시 보여요)
        const skipNote = result.skipsSaved === false ? ' 건너뛴 사진 목록은 파일에 저장하지 못해서 이번 실행 동안만 다시 보여요.' : '';
        setNotice(undoneText(result.count, result.kind) + skipNote);
      }
      setJustApplied(null);
    } catch (e) {
      setNotice(errorText(e));
    }
    try {
      await refresh(); // 성공해도 거절돼도 최신 마지막 묶음을 다시 읽어요
      setGen((g) => g + 1);
    } finally {
      undoRef.current = false;
      setUndoing(false);
    }
  };

  // 고른 사진 휴지통으로 (2026-11-16 사용자 결정: 사진첩에서 보다가 필요 없는 건 바로 지우기)
  //   갤러리 · 정보 없는 사진 화면에서만. 열 때 고른 번호를 그대로 담아서, 창이 열린 동안 선택이 바뀌어도 대상은 같아요
  const trashScreen = screen === 'gallery' || screen === 'missing';
  const openTrash = () => {
    setCellMenuAt(null);
    if (!trashScreen || suggestOpen || selection.ids.size === 0) return;
    setNotice('');
    setTrashIds([...selection.ids]);
  };
  // 날짜 칸의 "이 날 N장 휴지통으로" (2026-11-21 사용자 요청: 스크린샷처럼 그날 통째로 버릴 사진이 많을 때 한 번에)
  //   그날 사진 · 영상을 모두 고른 뒤 같은 확인 창을 열어요. 옮기기는 확인 창에서 눌러야만 해요
  //   번호를 받는 사이 화면 · 필터가 바뀌었거나 다른 창이 열렸으면 열지 않아요. 받는 중에 또 눌러도 한 번만
  const dayTrashBusy = useRef(false);
  const openWindowsRef = useRef(false);
  openWindowsRef.current = !!(dialog || fillOpen || trashIds || tagEdit);
  const trashDay = async (day) => {
    setCellMenuAt(null);
    if (!viewCurrent || !trashScreen || suggestOpen || openWindowsRef.current || dayTrashBusy.current) return;
    dayTrashBusy.current = true;
    const at = scopeRef.current;
    try {
      const files = await api.listFiles(day, view.filter);
      const ids = Array.isArray(files) ? files.map((f) => f.id) : [];
      if (scopeRef.current !== at || openWindowsRef.current || ids.length === 0) return;
      setCellMenuAt(null); // 받는 사이 우클릭 메뉴가 열렸으면 닫아요 (그날 전체에 메뉴의 태그가 붙지 않게, #127 검증 ⚠️)
      setSelection(selectionOf(ids)); // 오른쪽 패널도 같은 장수를 보여 줘요
      setNotice('');
      setTrashIds(ids);
    } catch (e) {
      if (scopeRef.current === at) setNotice(errorText(e));
    } finally {
      dayTrashBusy.current = false;
    }
  };
  const onTrashDone = async (text) => {
    setTrashIds(null);
    setSelection(EMPTY_SELECTION);
    setNotice(text);
    setGen((g) => g + 1);
    await refresh();
  };
  // Delete 키로 확인 창 열기 (글 쓰는 칸 · 다른 창이 열려 있으면 안 열어요)
  useEffect(() => {
    const onKey = (e) => {
      const open = !!(dialog || fillOpen || trashIds || cellMenuAt || tagEdit);
      if (!deleteKeyOpens(e.key, document.activeElement, open)) return;
      if (!trashScreen || suggestOpen || selection.ids.size === 0) return;
      e.preventDefault();
      openTrash();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  // 태그 단축키: T = 붙이기 창, 숫자 1~9 = 정한 태그 바로 붙이기 (Delete 와 같은 화면 · 같은 조건, 글 쓰는 칸에서는 안 돼요)
  useEffect(() => {
    const onKey = (e) => {
      const open = !!(dialog || fillOpen || trashIds || cellMenuAt || tagEdit);
      const act = tagKeyAction(e, document.activeElement, open);
      if (!act) return;
      if (!showTools || !trashScreen || suggestOpen || screening || selection.ids.size === 0) return; // 거르기 중에는 태그를 붙이지 않아요
      e.preventDefault();
      if (act.type === 'open') openDialog('tagAdd');
      else quickTag(act.key);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  // 날짜 없음 채우기: 옮긴 뒤 / 되돌린 뒤에는 목록과 개수를 다시 읽어요
  const onFillDone = async (r) => {
    setFillOpen(false);
    setSelection(EMPTY_SELECTION);
    const parts = [`${r.moved.toLocaleString('en-US')}장을 날짜 폴더로 옮겼어요.`];
    if (r.fail) parts.push(`${r.fail.toLocaleString('en-US')}장은 옮기지 못했어요.`);
    if (r.skipped) parts.push(`${r.skipped.toLocaleString('en-US')}장은 이미 없어서 건너뛰었어요.`);
    setNotice(parts.join(' ') + ' 잘못 옮겼다면 위의 되돌리기로 한 번에 되돌릴 수 있어요.');
    setGen((g) => g + 1);
    await refresh();
  };
  const undoFill = async () => {
    if (fillUndoing) return;
    setFillUndoing(true);
    setNotice('');
    try {
      const r = await api.fillUndo();
      const parts = [`${r.restored.toLocaleString('en-US')}장을 원래 자리로 되돌렸어요.`];
      if (r.fail) parts.push(`${r.fail.toLocaleString('en-US')}장은 원래 자리에 같은 이름이 있어서 그대로 뒀어요.`);
      if (r.skipped) parts.push(`${r.skipped.toLocaleString('en-US')}장은 옮겨진 파일이 없어서 건너뛰었어요.`);
      setNotice(parts.join(' '));
      setSelection(EMPTY_SELECTION);
    } catch (e) {
      setNotice(errorText(e));
    }
    try {
      await refresh();
      setGen((g) => g + 1);
    } finally {
      setFillUndoing(false);
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
  } else if (screening && state.total === 0) {
    // 거르기 중: 가져올 폴더를 읽는 중이거나 사진이 없어요
    const scanning = (state.scan && state.scan.scanning) || !state.tools;
    center = scanning
      ? <EmptyState title="가져올 폴더의 사진을 찾는 중이에요">찾는 대로 비슷한 사진을 묶어 보여 줘요.</EmptyState>
      : (
        <EmptyState title={state.connected ? '가져올 폴더에 사진이나 영상이 없어요' : '가져올 폴더 연결 안 됨'} action={<button type="button" onClick={openImport}>거르기 끝내고 가져오기로</button>}>
          {state.connected ? '거를 사진이 없어요. 가져오기 화면으로 돌아가 주세요.' : 'USB나 외장 드라이브를 연결한 뒤 왼쪽 아래 "가져올 폴더 다시 읽기"를 눌러 주세요.'}
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
    } else if (scanning || !state.tools) {
      // tools가 null이면 아직 도구(exiftool 등)를 찾는 중이에요. 찾고 나면 바로 읽기가 시작되니 같은 안내를 보여 줘요
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
  } else if (screen === 'similar') {
    center = <SimilarView gen={gen} focusId={similarFocus} onFocus={setSimilarFocus} onNotice={setNotice} />;
  } else if (screen === 'tags') {
    center = (
      <TagsView gen={gen} onPick={pickTagFromList} onManage={(mode, tag) => { setNotice(''); setTagEdit({ mode, tag }); }}
        onChanged={(text) => { setNotice(text); setGen((g) => g + 1); refresh(); }} />
    );
  } else if (screen === 'clean') {
    center = <CleanView picked={cleanPick && cleanPick.id} onPick={setCleanPick} />;
  } else if (screen === 'map') {
    center = <MapView gen={gen} noLocation={state.noLocation} picked={mapPick} onPick={setMapPick} onLoaded={setMapLocated} onTop={setMapTop} goto={mapGoto} onGoMissing={() => goScreen('missing')} viewRef={mapViewRef} />;
  } else if (suggestOpen) {
    center = <SuggestPanel gen={gen} focusId={suggestFocus} onFocus={setSuggestFocus} onApplied={onApplied} onNotice={setNotice} />;
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
    center = <DayGrid view={view} selection={selection} onCellClick={onCellClick} onCellMenu={onCellMenu} onSelectDay={selectDay}
      onTrashDay={trashScreen && !suggestOpen ? trashDay : undefined} />;
  } else {
    center = null; // 날짜 목록을 받는 중
  }

  const showTools = !!(state && state.root && !state.dbError && state.total > 0);
  // 되돌리기 줄: "내가 넣은 정보" 탭에서는 위쪽에 늘, 그 밖에서는 넣은 직후에만 (같은 줄이 두 번 보이지 않게)
  const lastBatch = (state && state.lastBatch) || null;
  const manualTab = screen === 'missing' && filter.info === 'manual' && !suggestOpen;
  const showTopUndo = showTools && manualTab && !!lastBatch;
  const showAfterUndo = showTools && !manualTab && !!lastBatch && !!justApplied && justApplied.batchId === lastBatch.id;
  // 오른쪽 패널에 자세히 보여 줄 사진: 한 장만 골랐으면 그 사진 ("이 날 모두 선택"이 한 장짜리 날이어도 보이게)
  const soleId = selection.ids.size === 1 ? [...selection.ids][0] : null;
  return (
    <div className="shell">
      <Sidebar
        state={state}
        screen={screen}
        filter={filter}
        onOpenImport={openImport}
        onScreen={goScreen}
        onPickTag={(tag) => {
          if (screen === 'similar' || screen === 'tags' || screen === 'map' || screen === 'clean') {
            pickTagFromList(tag); // 격자가 없는 화면이면 갤러리로 가요
            return;
          }
          setSuggestOpen(false); // 위치 제안 탭에는 태그 목록이 없어서, 고른 태그의 사진이 보이는 격자로 돌아가요
          setField({ tag });
        }}
        onNewTag={() => { setNotice(''); setTagEdit({ mode: 'create', tag: null }); }}
        onRescan={rescan}
        rescanning={rescanning}
      />
      <main className="main">
        {screening && (
          <div className="area-bar screen-bar">
            <span>가져오기 전 거르기: {state.screening.name} (사진 {Number(state.total || 0).toLocaleString('en-US')}장)</span>
            <button type="button" onClick={openImport}>거르기 끝내고 가져오기로</button>
          </div>
        )}
        {showTools && screen !== 'similar' && screen !== 'tags' && screen !== 'map' && screen !== 'clean' && (
          <Toolbar
            screen={screen}
            state={state}
            filter={filter}
            searchText={searchText}
            onSearchText={setSearchText}
            onTab={(tab) => setField({ tab })}
            onInfo={(info) => {
              setSuggestOpen(false);
              setField({ info });
            }}
            suggestOpen={suggestOpen}
            onSuggest={() => {
              setSuggestFocus(null);
              setSuggestOpen(true);
            }}
            onSort={(sort) => setField({ sort })}
            onSelectAll={selectAll}
            selectingAll={selectingAll || !viewCurrent}
          />
        )}
        {showTools && screen === 'gallery' && filter.area && (
          <div className="area-bar">
            <span>지도에서 고른 곳의 사진만 보여요{filter.area.year ? ` (${filter.area.year}년)` : ''}</span>
            <button type="button" onClick={() => goScreen('map')}>지도로 돌아가기</button>
            <button type="button" onClick={clearFilters}>전체 사진 보기</button>
          </div>
        )}
        {showTopUndo && <UndoBar batch={lastBatch} variant="top" busy={undoing} disabled={syncing} onUndo={() => undo(lastBatch.id)} />}
        <ScanBanner
          state={state}
          recovered={recovered}
          notice={notice}
          onDismissNotice={() => setNotice('')}
          onRescan={rescan}
          rescanning={rescanning}
        />
        {showTools && screen === 'missing' && filter.info === 'noDate' && !suggestOpen && (state.noDate > 0 || !!state.lastFill) && (
          <FillBanner noDate={state.noDate} lastFill={state.lastFill || null} busy={fillUndoing} disabled={syncing} onOpen={() => setFillOpen(true)} onUndo={undoFill} />
        )}
        {showAfterUndo && <UndoBar batch={lastBatch} variant="after" busy={undoing} disabled={syncing} onUndo={() => undo(lastBatch.id)} onDismiss={() => setJustApplied(null)} name={justApplied.name} />}
        <div className="center">{center}</div>
      </main>
      {showTools && screen === 'map' && <MapPanel picked={mapPick} located={mapLocated} top={mapTop} onShowArea={showArea} onGoto={(t) => setMapGoto((g) => ({ key: t.key, seq: (g ? g.seq : 0) + 1 }))} />}
      {showTools && screen === 'clean' && <CleanPanel session={cleanPick} />}
      {showTools && screen !== 'map' && screen !== 'clean' && (
        <DetailPanel
          selectedId={screen === 'similar' ? similarFocus : screen === 'tags' ? null : suggestOpen ? suggestFocus : (soleId !== null ? soleId : selection.focus)}
          readOnly={suggestOpen || screen === 'similar' || screen === 'tags'}
          gen={gen}
          count={selection.ids.size}
          copySource={copySource}
          onCopy={copyValue}
          onPaste={() => openDialog('copy')}
          onDirect={() => openDialog('direct')}
          onMap={() => openDialog('map')}
          pick={pick}
          onSuggest={() => openDialog('suggest')}
          onTagAdd={() => openDialog('tagAdd')}
          onTagRemove={() => openDialog('tagRemove')}
          onTrash={trashScreen && !suggestOpen ? openTrash : undefined}
          trashOnly={screening}
        />
      )}
      {showTools && cellMenuAt && selection.ids.size > 0 && (
        <ContextMenu
          at={cellMenuAt}
          count={selection.ids.size}
          canCopy={selection.ids.size === 1}
          hasCopy={!!copySource}
          onCopy={copyValue}
          onPaste={() => openDialog('copy')}
          onDirect={() => openDialog('direct')}
          onMap={() => openDialog('map')}
          pick={pick}
          onSuggest={() => openDialog('suggest')}
          onTagAdd={() => openDialog('tagAdd')}
          onTagRemove={() => openDialog('tagRemove')}
          onTrash={trashScreen && !suggestOpen ? openTrash : undefined}
          quick={quickTags(state.manualTags)}
          onQuickTag={trashScreen && !suggestOpen ? quickTag : undefined}
          trashOnly={screening}
          onClose={closeMenu}
        />
      )}
      {tagEdit && <TagManageDialog mode={tagEdit.mode} tag={tagEdit.tag} onClose={() => setTagEdit(null)} onDone={onTagManaged} />}
      {fillOpen && <FillDialog onClose={() => setFillOpen(false)} onDone={onFillDone} />}
      {trashIds && <TrashDialog ids={trashIds} onClose={() => setTrashIds(null)} onDone={onTrashDone} />}
      {dialog && (dialog.mode === 'tagAdd' || dialog.mode === 'tagRemove') && <TagDialog mode={dialog.mode} ids={dialog.ids} initialName={dialog.name || ''} onClose={() => setDialog(null)} onApplied={onApplied} />}
      {dialog && dialog.mode !== 'tagAdd' && dialog.mode !== 'tagRemove' && <EditDialog mode={dialog.mode} ids={dialog.ids} source={dialog.mode === 'suggest' ? dialog.place.source : copySource} place={dialog.place || null} prefer={dialog.prefer} startAt={dialog.startAt || lastPin} onPinChosen={setLastPin} onClose={() => setDialog(null)} onApplied={(r) => onApplied(r, { keep: dialog.mode === 'suggest' && dialog.more ? dialog.ids : null })} />}
    </div>
  );
}

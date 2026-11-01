// 파일 위치: src/components/DayGrid.jsx
// 역할: 날짜별 사진 격자. 왼쪽에 날짜 칸(10.28, 요일, 장수), 오른쪽에 정사각형 칸들
//   - 줄 계산은 grid-layout.mjs (buildRows), 화면 근처의 줄만 그리는 것은 @tanstack/react-virtual (가상 스크롤)
//   - 창 너비는 ResizeObserver로 재서 한 줄 칸 수를 정해요 (창을 줄이면 칸 수가 줄어요)
//   - 날짜별 파일 목록은 화면에 들어온 날만 한 번 가져와 기억해요. 필터가 바뀌면 싹 비우고,
//     목록이 갱신되면(gen이 오르면) 옛 목록을 보여 둔 채 새로 받아 바꿔 끼워요 (깜빡이거나 스크롤이 튀지 않게)

import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api } from '../api.js';
import { formatCount, formatDuration } from '../format.mjs';
import { buildRows, formatDayLabel, rowHeight } from '../grid-layout.mjs';

const GAP = 4; // 칸 사이 간격
const DAY_GAP = 28; // 날 사이 여백
const MIN_CELL = 112; // 칸의 최소 크기. 이보다 좁아지면 칸 수를 줄여요
const FETCH_DELAY_MS = 100; // 빨리 스크롤하는 동안은 가져오지 않고, 멈춘 뒤 보이는 날만 가져와요
const MAX_CACHED_DAYS = 300; // 기억해 두는 날 수 (넘으면 오래된 것부터, 지금 안 보이는 날만 지워요)
const PAD_X = 24; // 좌우 여백
const PAD_TOP = 8;
const DATE_GUTTER = 16; // 날짜 칸과 사진 사이

// 너비(px)로 날짜 칸 너비, 한 줄 칸 수, 칸 크기를 정해요 (너비를 모르면 0칸)
export function computeLayout(width) {
  const dateCol = width < 620 ? 84 : 110;
  if (!(width > 0)) return { dateCol, cols: 0, cell: MIN_CELL };
  const avail = Math.max(0, width - PAD_X * 2 - dateCol - DATE_GUTTER);
  const cols = Math.max(1, Math.floor((avail + GAP) / (MIN_CELL + GAP)));
  const cell = Math.max(48, Math.floor((avail - GAP * (cols - 1)) / cols));
  return { dateCol, cols, cell };
}

const rowKey = (row) => `${row.day === null ? 'none' : row.day}|${row.dayRowIndex}`;

// 칸 하나. 같은 사진이면 다시 그리지 않아요 (스크롤할 때 가벼워지게)
const Cell = memo(function Cell({ file, selected, onSelect }) {
  const [broken, setBroken] = useState(false);
  // 썸네일 상태가 바뀌면(만드는 중 → 완료) 한 번 더 시도해요. 같은 상태에서는 다시 시도하지 않아요
  useEffect(() => setBroken(false), [file.thumbState]);
  const failed = broken || file.thumbState === 'failed';
  const duration = file.mediaType === 'video' ? formatDuration(file.durationSec) : '';
  return (
    <button type="button" className={`cell${selected ? ' selected' : ''}`} aria-label={file.name} aria-pressed={selected} onClick={() => onSelect(file.id)}>
      {failed ? (
        <span className="no-preview">미리보기 없음</span>
      ) : (
        <img src={`pvm://thumb/${file.id}`} alt="" loading="lazy" draggable="false" onError={() => setBroken(true)} />
      )}
      {duration && <span className="badge">{duration}</span>}
    </button>
  );
});

function DayLabel({ row }) {
  const label = formatDayLabel(row.day);
  return (
    <div className="day-label">
      {row.showYear && label.year && <div className="day-year">{label.year}년</div>}
      <div className={`day-date${label.weekday ? '' : ' nodate'}`}>{label.date}</div>
      {label.weekday && <div className="day-weekday">{label.weekday}</div>}
      <div className="day-count">{formatCount(row.dayCount)}장</div>
    </div>
  );
}

// view = { key, filter, days, gen }: 지금 화면에 보이는 목록 (key는 필터가 같은지, gen은 몇 번째 갱신인지)
export default function DayGrid({ view, selectedId, onSelect }) {
  const scrollRef = useRef(null);
  const [width, setWidth] = useState(0);
  const layout = useMemo(() => computeLayout(width), [width]);
  const { cols, cell, dateCol } = layout;
  const rows = useMemo(() => buildRows(view.days, cols), [view.days, cols]);

  // ---------- 너비 재기 ----------
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const read = () => setWidth(el.clientWidth);
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---------- 줄 위치 (스크롤 위치를 지켜 주는 데 써요) ----------
  const offsets = useMemo(() => {
    const out = new Array(rows.length + 1);
    let y = PAD_TOP;
    for (let i = 0; i < rows.length; i++) {
      out[i] = y;
      y += rowHeight(rows[i], cell, GAP, DAY_GAP);
    }
    out[rows.length] = y;
    return out;
  }, [rows, cell]);

  // 칸 크기가 바뀌면 줄 높이가 달라지므로 getItemKey를 새로 만들어 가상 스크롤이 높이를 다시 계산하게 해요
  const getItemKey = useCallback((i) => (rows[i] ? rowKey(rows[i]) : i), [rows, cell]); // eslint-disable-line react-hooks/exhaustive-deps
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rowHeight(rows[i], cell, GAP, DAY_GAP),
    getItemKey,
    overscan: 4,
    paddingStart: PAD_TOP,
    paddingEnd: 32,
  });
  const items = virtualizer.getVirtualItems();

  // ---------- 날짜별 파일 기억 ----------
  const cacheRef = useRef(null); // { key, map: day → { gen, files }, inflight: day → 요청한 gen }
  const [, bump] = useReducer((n) => n + 1, 0);
  const anchorRef = useRef(null); // 스크롤 맨 위에 보이던 줄과 그 안에서의 위치

  // 필터가 바뀌면 기억을 비우고 맨 위로 가요
  useLayoutEffect(() => {
    cacheRef.current = { key: view.key, map: new Map(), inflight: new Map() };
    anchorRef.current = null;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [view.key]);

  const cache = cacheRef.current && cacheRef.current.key === view.key ? cacheRef.current : null;

  // 화면에 보이는 날 목록 (이 글자가 바뀔 때만 새로 가져와요)
  const visibleDays = [];
  for (const it of items) {
    const row = rows[it.index];
    if (row && !visibleDays.includes(row.day)) visibleDays.push(row.day);
  }
  const visibleKey = visibleDays.map((d) => (d === null ? 'none' : d)).join(',');

  const visibleRef = useRef(visibleDays);
  visibleRef.current = visibleDays; // 비동기 응답이 "지금 보이는 날"을 알 수 있게

  // 보이는 날이 0.1초 동안 그대로일 때만 가져와요 (이 effect는 보이는 날이 바뀔 때마다 다시 돌고, 이전 예약은 취소돼요)
  useEffect(() => {
    const timer = setTimeout(() => {
      const c = cacheRef.current;
      if (!c || c.key !== view.key) return;
      for (const day of visibleRef.current) {
        const have = c.map.get(day);
        if (have && have.gen >= view.gen) continue; // 이미 최신
        if (c.inflight.has(day) && c.inflight.get(day) >= view.gen) continue; // 이미 받는 중
        const gen = view.gen;
        c.inflight.set(day, gen);
        const done = () => { if (c.inflight.get(day) === gen) c.inflight.delete(day); };
        api.listFiles(day, view.filter).then(
          (files) => {
            done();
            if (cacheRef.current !== c || !Array.isArray(files)) return; // 필터가 바뀌었거나 이상한 응답이면 버려요
            const prev = c.map.get(day);
            if (prev && prev.gen > gen) return; // 더 새 응답이 이미 들어와 있어요
            c.map.delete(day); // 다시 넣어서 "가장 최근"으로
            c.map.set(day, { gen, files });
            // 너무 많이 쌓이면 오래된 것부터 지워요 (지금 보이는 날은 남겨요)
            if (c.map.size > MAX_CACHED_DAYS) {
              const keep = new Set(visibleRef.current);
              for (const k of c.map.keys()) {
                if (c.map.size <= MAX_CACHED_DAYS) break;
                if (!keep.has(k)) c.map.delete(k);
              }
            }
            bump();
          },
          // 실패하면 요청 표시를 지워요. 스스로 다시 시도하지는 않고, 보이는 날이 바뀌거나 목록이 갱신될 때 다시 시도해요
          done,
        );
      }
    }, FETCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [visibleKey, view.key, view.gen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 스크롤 위치 지키기 ----------
  const rowIndexAt = (y) => {
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || !rows.length) return;
    const i = rowIndexAt(el.scrollTop);
    anchorRef.current = { key: rowKey(rows[i]), day: rows[i].day, delta: el.scrollTop - offsets[i] };
  };
  // 줄이 달라졌을 때(새 사진이 읽혀 날짜가 늘거나 창 너비가 바뀜) 보던 줄이 같은 자리에 오도록 맞춰요
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchorRef.current;
    if (!el || !a || !rows.length || el.scrollTop === 0) return;
    let j = rows.findIndex((r) => rowKey(r) === a.key);
    let target;
    if (j >= 0) {
      target = offsets[j] + a.delta;
    } else {
      j = rows.findIndex((r) => r.day === a.day);
      if (j < 0) return;
      target = offsets[j];
    }
    if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target;
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="grid-scroll" ref={scrollRef} onScroll={onScroll} style={{ '--date-col': `${dateCol}px`, '--cell': `${cell}px`, '--cols': cols }}>
      <div className="grid-inner" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((it) => {
          const row = rows[it.index];
          if (!row) return null;
          const entry = cache && cache.map.get(row.day);
          return (
            <div key={it.key} className="day-row" style={{ height: it.size, transform: `translateY(${it.start}px)` }}>
              <div className="date-col">{row.isFirstOfDay && <DayLabel row={row} />}</div>
              <div className="cells">
                {Array.from({ length: row.count }, (_, k) => {
                  const file = entry && entry.files[row.startIndex + k];
                  return file ? (
                    <Cell key={file.id} file={file} selected={file.id === selectedId} onSelect={onSelect} />
                  ) : (
                    <div key={`empty-${k}`} className="cell empty" />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

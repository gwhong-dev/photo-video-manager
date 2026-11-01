// 파일 위치: src/grid-layout.mjs
// 역할: 갤러리 격자의 "줄 계산"과 날짜 이름표 (React 없이 숫자와 글자만 다뤄요. 그래서 점검에서도 바로 불러 확인해요)
//   buildRows(days, cols)  → 날짜 묶음을 줄로 쪼갠 목록
//   formatDayLabel(day)    → 왼쪽 날짜 칸에 쓸 글자 { date, weekday, year }
//   rowHeight(row, cell, gap, dayGap) → 한 줄의 높이 (가상 스크롤이 써요)

const WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

// days: [{ day: '2026-10-28' | null, count }] (날짜 없는 묶음은 맨 끝에 와요)
// 돌려주는 줄: { day, dayRowIndex, startIndex, count, dayCount, isFirstOfDay, showYear }
//   count = 이 줄에 들어갈 칸 수, startIndex = 그 날 파일 목록에서 이 줄이 시작하는 위치
//   showYear = 목록 첫 묶음이거나 앞 묶음과 해가 다를 때, 그 묶음의 첫 줄에서만 참
export function buildRows(days, cols) {
  const rows = [];
  if (!Array.isArray(days) || !Number.isFinite(cols) || cols < 1) return rows;
  const perRow = Math.floor(cols);
  let prevYear = null; // 앞 묶음의 해 (처음에는 없음)
  days.forEach((d) => {
    const total = Math.max(0, Math.floor(Number(d && d.count) || 0));
    if (total === 0) return;
    const year = yearOf(d.day);
    const showYear = prevYear === null || year !== prevYear;
    prevYear = year;
    const rowCount = Math.ceil(total / perRow);
    for (let r = 0; r < rowCount; r++) {
      const startIndex = r * perRow;
      rows.push({
        day: d.day,
        dayRowIndex: r,
        startIndex,
        count: Math.min(perRow, total - startIndex),
        dayCount: total,
        isFirstOfDay: r === 0,
        showYear: r === 0 && showYear,
      });
    }
  });
  return rows;
}

function yearOf(day) {
  return typeof day === 'string' ? day.slice(0, 4) : '';
}

// 날짜 글자를 만들어요. 요일은 시간대의 영향을 받지 않게 UTC로 계산해요
export function formatDayLabel(day) {
  if (day === null || day === undefined) return { date: '날짜 없음' };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!m) return { date: String(day) };
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
  return { date: `${m[2]}.${m[3]}`, weekday, year: m[1] };
}

// 한 줄의 높이: 칸 높이 + 칸 사이 간격. 그 날의 마지막 줄 밑에는 날 사이 여백을 더해요
export function rowHeight(row, cell, gap, dayGap) {
  const last = row.startIndex + row.count >= row.dayCount;
  return cell + gap + (last ? dayGap : 0);
}

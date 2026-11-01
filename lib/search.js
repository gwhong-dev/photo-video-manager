// 파일 위치: lib/search.js
// 역할: 검색어(글자 한 줄)를 낱말로 나누고, 낱말마다 "찾을 모양"을 만들어요
//   - SQL은 여기 없어요. SQL 만들기는 lib/db.js의 buildWhere가 해요 (여기서는 LIKE에 넣을 모양만 만듦)
//   - 낱말끼리는 AND, 한 낱말 안에서는 "파일 이름 또는 태그 또는 날짜"로 찾아요
//
// 모양: parseQuery('2026년 10월 수원') → [{ like, dateLike }, ...]
//   like     이름과 태그에 쓰는 LIKE 모양 ('%낱말%'). %, _, \ 는 글자 그대로 찾게 \ 를 붙여 둠 (ESCAPE '\' 와 함께 써요)
//   dateLike 찍은 날(taken_day, 'YYYY-MM-DD')에 쓰는 LIKE 모양. 날짜 모양이 아니면 null

// LIKE에서 특별한 글자(%, _, \)를 글자 그대로 찾도록 \ 를 붙여요
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => '\\' + c);
}

const two = (n) => String(n).padStart(2, '0');
const validMonth = (m) => m >= 1 && m <= 12;
const validDay = (d) => d >= 1 && d <= 31;

// 낱말이 날짜 모양이면 taken_day용 LIKE 모양을, 아니면 null을 돌려줘요
//   2026 → 2026-%            2026년 → 2026-%
//   2026-10, 2026.10, 2026년 10월 → 2026-10-%
//   2026-10-28, 2026.10.28, 2026년 10월 28일 → 2026-10-28   (한 자리 월과 일도 받아요: 2026.1.5 → 2026-01-05)
//   10.28, 10-28 → %-10-28   (연도 상관없이)
function dateLikeOf(word) {
  let m;
  if ((m = /^(\d{4})(?:년)?$/.exec(word))) return `${m[1]}-%`;
  if ((m = /^(\d{4})(?:[-.]|년\s*)(\d{1,2})(?:월)?$/.exec(word))) {
    return validMonth(+m[2]) ? `${m[1]}-${two(m[2])}-%` : null;
  }
  if ((m = /^(\d{4})(?:[-.]|년\s*)(\d{1,2})(?:[-.]|월\s*)(\d{1,2})(?:일)?$/.exec(word))) {
    return validMonth(+m[2]) && validDay(+m[3]) ? `${m[1]}-${two(m[2])}-${two(m[3])}` : null;
  }
  if ((m = /^(\d{1,2})[-.](\d{1,2})$/.exec(word))) {
    return validMonth(+m[1]) && validDay(+m[2]) ? `%-${two(m[1])}-${two(m[2])}` : null;
  }
  return null;
}

// 공백으로 나누되, "2026년 10월", "2026년 10월 28일"처럼 공백이 든 날짜는 한 낱말로 합쳐요
const SPLIT = /\d{4}\s*년\s*\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?|\S+/g;

function parseQuery(text) {
  if (typeof text !== 'string') return [];
  const words = text.match(SPLIT) || [];
  return words.map((w) => ({ like: `%${escapeLike(w)}%`, dateLike: dateLikeOf(w) }));
}

module.exports = { parseQuery };

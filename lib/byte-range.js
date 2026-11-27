// 파일 위치: lib/byte-range.js
// 역할: 영상 건너뛰기용 "구간 요청(Range)" 풀기 (2026-11-27 앱 안 영상 재생)
//   화면의 영상 재생기는 뒤쪽으로 건너뛸 때 "bytes=1000000-" 처럼 파일의 일부만 달라고 해요.
//   일부만 돌려주지(206) 않으면 건너뛰기가 안 되거나 처음부터 다시 받아요.
//   Electron 은 쓰지 않아요 (lib/ 규칙). protocol.handle 연결은 gallery-main.js 에서 해요
//
// 모양: parseRange(headerText, size)
//   → null                  : 구간 요청 없음 · 여러 구간 · 모르는 모양 → 파일 전체(200)
//   → { start, end }        : 이 구간만 (end 포함) → 206
//   → { unsatisfiable: true }: 파일보다 뒤를 달라고 함 → 416

const fs = require('fs');
const { Readable } = require('stream');

function parseRange(header, size) {
  if (typeof header !== 'string' || !Number.isSafeInteger(size) || size < 0) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header); // 쉼표(여러 구간)가 있으면 맞지 않아 전체로 보내요
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    // "bytes=-500" = 끝에서 500바이트
    const n = Number(m[2]);
    if (n === 0) return { unsatisfiable: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return null; // 뒤집힌 구간은 무시하고 전체로
  }
  if (!Number.isSafeInteger(start) || start >= size) return { unsatisfiable: true };
  return { start, end };
}

// 파일 응답 만들기: 구간 요청이 있으면 그 구간만 206, 파일 밖이면 416, 없으면 전체 200
//   큰 영상을 통째로 메모리에 올리지 않게 파일을 조금씩 읽어 흘려보내요
async function fileRangeResponse(filePath, headers, rangeHeader) {
  const { size } = await fs.promises.stat(filePath);
  const range = parseRange(rangeHeader, size);
  const h = { ...headers, 'Accept-Ranges': 'bytes' };
  if (range && range.unsatisfiable) return new Response(null, { status: 416, headers: { ...h, 'Content-Range': `bytes */${size}` } });
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  h['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
  if (range) h['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const body = size === 0 ? null : Readable.toWeb(fs.createReadStream(filePath, { start, end }));
  return new Response(body, { status: range ? 206 : 200, headers: h });
}

module.exports = { parseRange, fileRangeResponse };

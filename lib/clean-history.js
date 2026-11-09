// 파일 위치: lib/clean-history.js
// 역할: "정리" 화면 (사용자 승인 2026-11-09, 가 = 기록 보기, 읽기만)
//   - 정리 기록: 로그 폴더의 원본 정리(clean_*) · 비슷한 사진 버리기(similar-discard_*) 로그를 읽어
//     언제, 몇 장을 휴지통 · _정리완료원본으로 옮겼는지, 실패 · 도중에 꺼짐을 알려 줘요
//   - _정리완료원본 폴더: 가져올 폴더와 백업 폴더 안의 그 폴더가 있는지, 파일 수와 크기
//   화면에는 파일 이름만 보내요 (경로는 주지 않아요). 폴더 열기는 main 이 정한 경로만 열어요
//   아무것도 옮기거나 지우지 않아요

const fs = require('fs');
const path = require('path');
const { MOVED_DIR } = require('./planner');

const LOG_RE = /^(clean|similar-discard)_\d{4}-\d{2}-\d{2}_\d{6}(_\d+)?\.txt$/; // clean-check_ 같은 다른 로그는 빼요
const MAX_SESSIONS = 100; // 최근 기록 수
const MAX_FILES = 300; // 기록 하나에 보여 줄 파일 줄 수
const MAX_WALK = 200000; // 폴더 크기를 셀 때 파일 수 상한 (넘으면 "이상"으로)
const KIND_LABEL = { clean: '원본 정리', 'similar-discard': '비슷한 사진 버리기' };

// 로그 한 줄의 "방법" 칸 → trash | move | fail | null(세지 않는 줄: 예정, 휴지통 실패 → 이동 안내)
function howOf(method) {
  if (method.includes('예정') || method.includes('휴지통 실패')) return null;
  if (method.includes('실패')) return 'fail';
  if (method.includes('휴지통')) return 'trash';
  if (method.includes('이동')) return 'move';
  return null;
}

// 로그 파일 하나 → { id, kind, label, at, planned, trash, move, fail, finished, files: [{ name, how, pair, note }], more }
//   id 는 파일 이름이에요 (화면이 이 값으로 고르지만, 열거나 지우는 데는 쓰지 않아요)
function parseLog(name, text) {
  const kind = name.startsWith('similar-discard_') ? 'similar-discard' : 'clean';
  const lines = text.split(/\r?\n/);
  const head = lines[0] || '';
  const m = head.match(/^#\s*[^/]+\/\s*([^/]+?)\s*\/\s*(\d+)/);
  const out = {
    id: name,
    kind,
    label: KIND_LABEL[kind],
    at: m ? m[1] : '',
    planned: m ? Number(m[2]) : null,
    trash: 0,
    move: 0,
    fail: 0,
    finished: false,
    files: [],
    more: 0,
  };
  for (const line of lines.slice(1)) {
    if (line.startsWith('# 끝')) {
      out.finished = true;
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    const [, method = '', src = '', extra = ''] = line.split('\t');
    const how = howOf(method);
    if (!how) continue;
    out[how] += 1;
    if (out.files.length >= MAX_FILES) {
      out.more += 1;
      continue;
    }
    out.files.push({
      name: path.win32.basename(src) || path.posix.basename(src), // Windows 경로든 아니든 이름만
      how,
      pair: method.startsWith('짝 영상'),
      note: how === 'fail' ? extra.slice(0, 200) : '',
    });
  }
  return out;
}

// 로그 폴더 → 최근 정리 기록 (새것부터)
function readCleanHistory(logDir, { limit = MAX_SESSIONS } = {}) {
  let names;
  try {
    names = fs.readdirSync(logDir).filter((n) => LOG_RE.test(n));
  } catch (e) {
    return []; // 로그 폴더가 아직 없음
  }
  // 이름의 시각(YYYY-MM-DD_HHMMSS)으로 새것부터. 같은 시각이면 _1, _2 순서
  const stampOf = (n) => n.replace(/^(clean|similar-discard)_/, '');
  names.sort((a, b) => stampOf(b).localeCompare(stampOf(a)) || b.localeCompare(a));
  const out = [];
  for (const n of names.slice(0, limit)) {
    try {
      out.push(parseLog(n, fs.readFileSync(path.join(logDir, n), 'utf8')));
    } catch (e) { /* 못 읽는 로그는 건너뛰어요 */ }
  }
  return out;
}

// 폴더 안 파일 수와 크기 (링크는 따라가지 않아요). 너무 많으면 MAX_WALK 에서 멈추고 capped
function folderStats(dir) {
  let files = 0;
  let bytes = 0;
  let capped = false;
  const stack = [dir];
  while (stack.length && !capped) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(p).size;
        } catch (err) { /* 그사이 사라짐 */ }
        if (files >= MAX_WALK) {
          capped = true;
          break;
        }
      }
    }
  }
  return { files, bytes, capped };
}

// 가져올 폴더 · 백업 폴더 안의 _정리완료원본 → [{ which, label, exists, files, bytes, capped }] (경로는 주지 않아요)
function cleanedFolders({ source, backupRoot }) {
  const list = [
    ['source', '가져올 폴더', source],
    ['backup', '백업 폴더', backupRoot],
  ];
  return list.map(([which, label, base]) => {
    const dir = cleanedDirOf(base);
    let exists = false;
    try {
      exists = !!dir && fs.statSync(dir).isDirectory();
    } catch (e) {
      exists = false;
    }
    return { which, label, set: !!base, exists, ...(exists ? folderStats(dir) : { files: 0, bytes: 0, capped: false }) };
  });
}

// 그 폴더의 _정리완료원본 경로 (폴더를 정하지 않았으면 null). 화면은 which 만 보내고 경로는 여기서 정해요
function cleanedDirOf(base) {
  const b = String(base || '').trim();
  return b ? path.join(path.resolve(b), MOVED_DIR) : null;
}

module.exports = { readCleanHistory, parseLog, cleanedFolders, cleanedDirOf, folderStats, howOf };

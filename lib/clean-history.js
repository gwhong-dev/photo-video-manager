// 파일 위치: lib/clean-history.js
// 역할: "정리" 화면 (사용자 승인 2026-11-09, 가 = 기록 보기, 읽기만)
//   - 정리 기록: 로그 폴더의 원본 정리(clean_*) · 비슷한 사진 버리기(similar-discard_*) · 같은 영상 정리(same-video_*) 로그를 읽어
//     언제, 몇 장을 휴지통 · _정리완료원본으로 옮겼는지, 실패 · 도중에 꺼짐을 알려 줘요
//   - _정리완료원본 폴더: 지금 가져올 폴더 · 백업 폴더, 그리고 기록에 남은 예전 폴더의 그 폴더가 있는지, 파일 수와 크기
//   화면에는 파일 · 폴더 이름만 보내요 (경로는 주지 않아요). 폴더 열기는 main 이 정한 경로만 열어요
//   아무것도 옮기거나 지우지 않아요
//   폴더를 세고 로그를 읽는 일은 모두 비동기예요 (느린 USB에서도 앱 창이 멈추지 않게, 검증 2026-11-09)

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { MOVED_DIR } = require('./planner');

const LOG_RE = /^(clean|similar-discard|same-video)_\d{4}-\d{2}-\d{2}_\d{6}(_\d+)?\.txt$/; // clean-check_ 같은 다른 로그는 빼요
const MAX_SESSIONS = 100; // 최근 기록 수
const MAX_FILES = 300; // 기록 하나에 보여 줄 파일 줄 수 (결과가 기록되지 않은 파일은 이 수와 상관없이 다 보여요)
const MAX_WALK = 200000; // 폴더 크기를 셀 때 파일 수 상한 (넘으면 "이상"으로)
const MAX_OLD = 8; // 기록에서 찾은 예전 폴더는 최근 것부터 이만큼만
const STAT_BATCH = 64; // 파일 크기를 한 번에 몇 개씩 물어볼지
const KIND_LABEL = { clean: '원본 정리', 'similar-discard': '비슷한 사진 버리기', 'same-video': '같은 영상 정리' };
const MOVED_RE = new RegExp(`[\\\\/]${MOVED_DIR}(?:[\\\\/]|$)`); // 옮긴 곳 경로에서 "\_정리완료원본\" 자리

// 로그 한 줄의 "방법" 칸 → plan(예정) | trash | move | fail | null(세지 않는 줄: 휴지통 실패 → 이동 안내)
function howOf(method) {
  if (method.includes('휴지통 실패')) return null;
  if (method.includes('예정')) return 'plan';
  if (method.includes('실패')) return 'fail';
  if (method.includes('휴지통')) return 'trash';
  if (method.includes('이동')) return 'move';
  return null;
}

// Windows 경로든 아니든 마지막 이름만
const baseName = (p) => path.win32.basename(p) || path.posix.basename(p);

// 실패 이유를 화면에 보여도 되는 글로: 경로는 이름만, Node 오류 글은 코드만, 그래도 경로 모양이 남으면 정해진 문장만
//   예) "EPERM: operation not permitted, ... 'C:\사용자\a.jpg'" → "옮기지 못했어요 (EPERM)"
//       "휴지통 결과를 알 수 없어요 (EBUSY: ...)" → "휴지통 결과를 알 수 없어요 (EBUSY)"
//       우리가 쓴 한글 문장은 그대로
function safeNote(text) {
  let t = String(text || '').slice(0, 1000);
  t = t.replace(/'([^']*[\\/][^']*)'/g, (m, p) => `'${baseName(p)}'`); // 따옴표 안 경로 → 이름만
  // "EPERM: 설명..." → "EPERM". 따옴표 안의 이름에 괄호가 있어도("a (1).jpg") 통째로 넘겨요 (#60 검증)
  t = t.replace(/\b([A-Z][A-Z0-9_]{2,}): [^()']*(?:'[^']*'[^()']*)*/g, '$1');
  const code = (t.match(/\b(E[A-Z0-9_]{2,})\b/) || [])[1];
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(t.trim())) return `옮기지 못했어요 (${t.trim()})`;
  if (/[A-Za-z]:[\\/]|\\\\|(^|[\s('"])\/[^\s/]/.test(t)) return code ? `옮기지 못했어요 (${code})` : '옮기지 못했어요';
  return t.slice(0, 200);
}

// 옮긴 곳 경로 → 그 _정리완료원본을 품은 폴더 (없으면 null). "E:\_정리완료원본\a.jpg" → "E:\"
function baseOfMoved(dest) {
  const s = String(dest || '');
  const m = s.match(MOVED_RE);
  if (!m) return null;
  const b = s.slice(0, m.index);
  if (/^[A-Za-z]:$/.test(b)) return `${b}\\`; // 드라이브 맨 위
  return b || null;
}

// 로그 파일 하나 → 화면용 기록 { id, kind, label, at, planned, trash, move, fail, pending, finished, files: [{ name, how, pair, note }], more }
//   + movedBases (화면에 보내지 않는 값: 이 기록에서 옮긴 _정리완료원본의 위 폴더 경로들)
//   id 는 파일 이름이에요 (화면이 이 값으로 고르지만, 열거나 지우는 데는 쓰지 않아요)
//   "예정" 줄 다음에 그 파일의 결과 줄(휴지통, 이동, 실패)이 없으면 how 'pending' (옮기던 중 꺼졌거나 결과를 못 적음)
function parseLogFull(name, text) {
  const kind = name.startsWith('similar-discard_') ? 'similar-discard' : name.startsWith('same-video_') ? 'same-video' : 'clean';
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
    pending: 0,
    finished: false,
    files: [],
    more: 0,
  };
  const waiting = new Map(); // 원본 경로 → { name, pair } (예정만 있고 결과가 아직 없음)
  const bases = new Set();
  for (const line of lines.slice(1)) {
    if (line.startsWith('# 끝')) {
      out.finished = true;
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    const [, method = '', src = '', extra = ''] = line.split('\t');
    const how = howOf(method);
    if (!how) continue;
    const pair = method.startsWith('짝 영상');
    if (how === 'plan') {
      waiting.set(src, { name: baseName(src), pair });
      continue;
    }
    waiting.delete(src);
    out[how] += 1;
    if (how === 'move') {
      const b = baseOfMoved(extra);
      if (b) bases.add(b);
    }
    if (out.files.length >= MAX_FILES) {
      out.more += 1;
      continue;
    }
    out.files.push({ name: baseName(src), how, pair, note: how === 'fail' ? safeNote(extra) : '' });
  }
  // 결과가 없는 파일은 확인해야 하니 맨 앞에, 줄 수 상한과 상관없이
  const pend = [...waiting.values()].map((w) => ({ name: w.name, how: 'pending', pair: w.pair, note: '' }));
  out.pending = pend.length;
  out.files = [...pend, ...out.files];
  return { session: out, movedBases: [...bases] };
}

// 화면용 기록만 (점검에서 써요)
function parseLog(name, text) {
  return parseLogFull(name, text).session;
}

// 로그 폴더 → { sessions: 최근 정리 기록 (새것부터), oldBases: [{ kind, base }] (기록에 남은 _정리완료원본 위 폴더, 새것부터) }
async function readCleanHistory(logDir, { limit = MAX_SESSIONS } = {}) {
  let names;
  try {
    names = (await fsp.readdir(logDir)).filter((n) => LOG_RE.test(n));
  } catch (e) {
    return { sessions: [], oldBases: [] }; // 로그 폴더가 아직 없음
  }
  // 이름의 시각(YYYY-MM-DD_HHMMSS)으로 새것부터. 같은 시각이면 _1, _2 순서
  const stampOf = (n) => n.replace(/^(clean|similar-discard|same-video)_/, '');
  names.sort((a, b) => stampOf(b).localeCompare(stampOf(a)) || b.localeCompare(a));
  const read = await Promise.all(names.slice(0, limit).map(async (n) => {
    try {
      return parseLogFull(n, await fsp.readFile(path.join(logDir, n), 'utf8'));
    } catch (e) {
      return null; // 못 읽는 로그는 건너뛰어요
    }
  }));
  const sessions = [];
  const oldBases = [];
  for (const r of read) {
    if (!r) continue;
    sessions.push(r.session);
    for (const base of r.movedBases) oldBases.push({ kind: r.session.kind, base });
  }
  return { sessions, oldBases };
}

// 폴더 안 파일 수와 크기 (링크는 따라가지 않아요). 너무 많으면 max 에서 멈추고 capped, 못 읽은 폴더가 있으면 partial
async function folderStats(dir, { max = MAX_WALK } = {}) {
  let files = 0;
  let bytes = 0;
  let capped = false;
  let partial = false;
  const stack = [dir];
  while (stack.length && !capped) {
    const d = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch (e) {
      partial = true;
      continue;
    }
    const filePaths = [];
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) filePaths.push(p);
    }
    for (let i = 0; i < filePaths.length && !capped; i += STAT_BATCH) {
      const chunk = filePaths.slice(i, i + Math.min(STAT_BATCH, max - files));
      const sizes = await Promise.all(chunk.map((p) => fsp.stat(p).then((s) => s.size, () => 0))); // 그사이 사라지면 0
      files += chunk.length;
      for (const s of sizes) bytes += s;
      if (files >= max) capped = true;
    }
  }
  return { files, bytes, capped, partial };
}

// 그 폴더의 _정리완료원본 경로 (폴더를 정하지 않았으면 null). 화면은 key 만 보내고 경로는 여기서 정해요
function cleanedDirOf(base) {
  const b = String(base || '').trim();
  return b ? path.join(path.resolve(b), MOVED_DIR) : null;
}

const isDirAsync = (p) => fsp.stat(p).then((s) => s.isDirectory(), () => false);
// 같은 폴더인지 비교할 열쇠 (Windows 는 대소문자를 가리지 않아요)
const sameKey = (dir) => (process.platform === 'win32' ? dir.toLowerCase() : dir);
const keyOfDir = (dir) => `old-${crypto.createHash('sha1').update(sameKey(dir)).digest('hex').slice(0, 12)}`;
// 화면에 보여 줄 폴더 이름 ("E:\" 처럼 드라이브 맨 위면 "E:")
const folderName = (base) => baseName(String(base).replace(/[\\/]+$/, '')) || String(base).replace(/[\\/]+$/, '');

// _정리완료원본 폴더 목록 → { folders: 화면용 [{ key, label, name, set, reachable, exists, files, bytes, capped, partial }], dirs: Map(key → 경로) }
//   지금 설정의 가져올 폴더(key 'source') · 백업 폴더('backup')는 늘 보이고,
//   기록에서 찾은 예전 폴더는 지금 설정과 다른 것만, _정리완료원본이 있거나 드라이브가 빠져 있을 때만 보여요
//   경로는 dirs 에만 있고 화면에는 주지 않아요
async function cleanedFolders({ source, backupRoot, oldBases = [] }) {
  const list = [
    { key: 'source', label: '가져올 폴더', base: source, current: true },
    { key: 'backup', label: '백업 폴더', base: backupRoot, current: true },
  ];
  const seen = new Set(list.map((f) => cleanedDirOf(f.base)).filter(Boolean).map(sameKey));
  for (const { kind, base } of oldBases) {
    const dir = cleanedDirOf(base);
    if (!dir || seen.has(sameKey(dir))) continue;
    seen.add(sameKey(dir));
    list.push({ key: keyOfDir(dir), label: kind === 'clean' ? '예전 가져올 폴더' : '예전 백업 폴더', base, current: false });
  }
  const dirs = new Map();
  const folders = [];
  let olds = 0;
  for (const f of list) {
    if (!f.current && olds >= MAX_OLD) break; // 예전 폴더는 화면에 보이는 것만 세어 MAX_OLD개까지 (#60 검증)
    const dir = cleanedDirOf(f.base);
    const set = !!dir;
    const baseDir = set ? path.resolve(String(f.base).trim()) : null;
    // 예전 폴더는 드라이브 맨 위로 연결을 봐요. 드라이브는 있는데 폴더가 없으면 지워진 것이라 안 보여요 (#60 검증)
    const reachable = set && (await isDirAsync(f.current ? baseDir : path.parse(baseDir).root));
    const exists = reachable && (await isDirAsync(dir));
    if (!f.current && reachable && !exists) continue; // 예전 폴더인데 _정리완료원본이 이제 없음 → 안 보여요
    if (!f.current) olds++;
    if (exists) dirs.set(f.key, dir);
    const stats = exists ? await folderStats(dir) : { files: 0, bytes: 0, capped: false, partial: false };
    folders.push({ key: f.key, label: f.label, name: set ? folderName(f.base) : '', set, reachable, exists, ...stats });
  }
  return { folders, dirs };
}

module.exports = { readCleanHistory, parseLog, cleanedFolders, cleanedDirOf, folderStats, howOf, safeNote, baseOfMoved };

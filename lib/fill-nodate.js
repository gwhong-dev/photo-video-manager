// 파일 위치: lib/fill-nodate.js
// 역할: 백업 폴더의 "_날짜없음" 에 들어가 있는 사진을, 앨범 정보(AlbumInfo.json)의 날짜로 날짜 폴더로 옮기기
//   (가져올 때 날짜를 못 찾아 _날짜없음 으로 간 iCloud 공유 앨범 사진을 나중에 채우는 2단계)
//
// ⚠️ 옮기기만 해요. 영구 삭제도, 사진 내용 바꾸기도, 덮어쓰기도 없어요.
//   - 이름은 가져올 때와 같은 규칙(lib/dates.js buildName)으로 날짜 앞붙이기, 폴더는 2025\04\10
//   - 이름이 겹치면 내용 지문을 비교해서 같으면 "이미 있음"으로 두고(옮기지 않음), 다르면 _1 _2 를 붙여요
//   - 옮기기 전에 "예정"을 로그와 되돌리기 기록에 먼저 적고, 되돌리기 기록은 userData\fill-nodate\ 에 남겨요
//   - 되돌리기: 옮긴 파일을 원래 자리(_날짜없음)로. 원래 자리에 같은 이름이 생겼으면 덮어쓰지 않고 건너뛰어요
//   - 날짜를 정하는 앨범 정보 찾는 법
//       1) 가져오기 기록(jobs)에 이 파일의 원본 경로가 있으면, 그 원본 폴더의 AlbumInfo.json
//       2) 원본 폴더가 이미 없거나 기록이 없으면, 사용자가 고른 앨범 폴더(예: iCloud Shared Albums) 아래에서 파일 이름으로
//          (같은 이름이 서로 다른 날짜로 여러 앨범에 있으면 어느 것인지 몰라서 건너뛰어요)
//   - DB 는 건드리지 않아요 (옮긴 뒤 갤러리가 폴더를 다시 읽어서 맞춰요)
//   - Electron 은 쓰지 않아요 (lib/ 규칙)
//
// 모양
//   historyFromJobs(jobsDir) → Map<경로 열쇠, 원본 경로>   (가져오기 기록에서 "결과 파일 → 원본")
//   planFill({ root, history, albumDirs, isProtected }) → Promise<{ items, counts }>   (읽기만)
//   runFill({ root, items, logger, journalDir, onProgress }) → Promise<{ moved, fail, skipped, pairs, logPath, journalPath }>
//   undoFill({ journalPath, logger }) → Promise<{ restored, fail, skipped, logPath }>
//   lastFillRun(journalDir, root) → { id, count, at, journalPath } | null   (되돌리지 않은 가장 최근 묶음)

const fs = require('fs');
const path = require('path');
const D = require('./dates');
const { hashFile } = require('./paths');
const { readJob } = require('./job');
const { loadAlbumDir, createAlbumDates } = require('./album-info');
const { now, stamp } = require('./logger');

const NO_DATE_DIR = '_날짜없음';
const MOVED_DIR = '_정리완료원본';
const MAX_ALBUM_DIRS = 5000; // 앨범 폴더 찾기에서 볼 폴더 수 상한 (이상하게 큰 폴더 방어)
const PREVIEW_LINES = 100; // 화면에 줄 목록 수

const isWin = process.platform === 'win32';
const keyOf = (p) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));
const pad = (n) => String(n).padStart(2, '0');
const dayText = (p) => `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
const isInside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// ---------- 가져오기 기록 → "결과 파일 → 원본" ----------
// jobsDir: userData\jobs (current.json + done\*.json). 깨진 기록 하나는 건너뛰어요
function historyFromJobs(jobsDir, onError = () => {}) {
  const pairs = [];
  const doneDir = path.join(jobsDir, 'done');
  try {
    for (const n of fs.readdirSync(doneDir)) {
      if (n.endsWith('.json')) pairs.push([path.join(doneDir, n), path.join(doneDir, `${n.slice(0, -'.json'.length)}.progress.log`)]);
    }
  } catch (e) { /* 보관 폴더 없음 */ }
  pairs.sort((a, b) => a[0].localeCompare(b[0])); // 오래된 것부터 → 같은 결과 파일이면 나중 기록이 이겨요
  const cur = path.join(jobsDir, 'current.json');
  if (fs.existsSync(cur)) pairs.push([cur, path.join(jobsDir, 'current.progress.log')]);
  const map = new Map();
  for (const [plan, prog] of pairs) {
    let job;
    try {
      job = readJob(plan, prog);
    } catch (e) {
      onError(path.basename(plan), e);
      continue;
    }
    for (const it of job.items || []) {
      // 날짜없음으로 간 파일만 필요해요 (finalPath 의 바로 윗 폴더 이름으로 거름)
      if (it.status !== 'done' || !it.finalPath || !it.src) continue;
      if (path.basename(path.dirname(it.finalPath)) !== NO_DATE_DIR) continue;
      map.set(keyOf(it.finalPath), it.src);
    }
  }
  return map;
}

// ---------- 사용자가 고른 앨범 폴더 아래의 AlbumInfo.json 모으기 ----------
// → Map(소문자 파일 이름 → { parts, from } | 'ambiguous')
function indexAlbumDirs(dirs) {
  const index = new Map();
  let seen = 0;
  const visit = (dir) => {
    if (seen++ > MAX_ALBUM_DIRS) return;
    const map = loadAlbumDir(dir);
    if (map) {
      for (const [name, found] of map) {
        const had = index.get(name);
        if (!had) index.set(name, found);
        else if (had !== 'ambiguous' && dayText(had.parts) !== dayText(found.parts)) index.set(name, 'ambiguous');
      }
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink()) visit(path.join(dir, e.name)); // 연결 폴더는 따라가지 않아요
    }
  };
  for (const d of dirs || []) visit(d);
  return index;
}

// 이름 앞붙이기가 끝난 새 파일 이름 (확장자는 소문자, .jpeg 는 .jpg)
function newNameOf(fileName, parts) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  const lower = ext.toLowerCase();
  return D.buildName(base, parts, lower === '.jpeg' ? '.jpg' : lower);
}

// ---------- 미리보기 (읽기만) ----------
//   isProtected(경로) → true 면 그 파일은 건너뛰어요 (직접 넣은 값 · 태그가 경로에 묶여 있어서 옮기면 잃어요)
async function planFill({ root, history = new Map(), albumDirs = [], isProtected = () => false }) {
  const noDateDir = path.join(root, NO_DATE_DIR);
  let names = [];
  try {
    names = fs.readdirSync(noDateDir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.includes('.__tmp__')).map((e) => e.name);
  } catch (e) { /* 폴더 없음 → 옮길 것 없음 */ }
  names.sort((a, b) => a.localeCompare(b));

  const dateFromAlbum = createAlbumDates();
  const folderIndex = indexAlbumDirs(albumDirs);
  const taken = new Set(); // 이번 계획에서 차지한 자리
  const dirFiles = new Map(); // 폴더 → [{ name, size }] (겹침 확인용, 한 번만 읽기)
  const filesIn = (dir) => {
    const k = keyOf(dir);
    if (!dirFiles.has(k)) {
      let list = [];
      try {
        list = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.includes('.__tmp__'))
          .map((e) => {
            try {
              return { name: e.name, size: fs.statSync(path.join(dir, e.name)).size };
            } catch (err) {
              return null;
            }
          }).filter(Boolean);
      } catch (e) { /* 폴더 없음 */ }
      dirFiles.set(k, list);
    }
    return dirFiles.get(k);
  };

  const items = [];
  const counts = { total: names.length, move: 0, dup: 0, noDate: 0, ambiguous: 0, protected: 0, renamed: 0, fromJobs: 0, fromFolder: 0 };
  for (const name of names) {
    const from = path.join(noDateDir, name);
    let st;
    try {
      st = fs.statSync(from);
    } catch (e) {
      continue;
    }
    const item = { from, name, size: st.size, newName: null, relDir: null, dest: null, day: null, via: null, status: 'nodate', note: '' };
    items.push(item);

    // 1) 가져오기 기록의 원본 폴더
    let found = null;
    const src = history.get(keyOf(from));
    if (src) {
      found = dateFromAlbum(src);
      if (found) item.via = 'job';
    }
    // 2) 사용자가 고른 앨범 폴더
    if (!found && folderIndex.size) {
      const hit = folderIndex.get(name.toLowerCase());
      if (hit === 'ambiguous') {
        item.status = 'ambiguous';
        item.note = '같은 이름이 날짜가 다른 앨범에 여러 개 있어서 어느 날짜인지 몰라요';
        counts.ambiguous++;
        continue;
      }
      if (hit) {
        found = hit;
        item.via = 'folder';
      }
    }
    if (!found) {
      item.note = '앨범 정보에서 날짜를 찾지 못했어요';
      counts.noDate++;
      continue;
    }
    if (isProtected(from)) {
      item.status = 'protected';
      item.day = dayText(found.parts);
      item.note = '직접 넣은 날짜 · 위치 · 태그가 있어서 옮기지 않아요 (옮기면 잃어요)';
      counts.protected++;
      continue;
    }

    item.day = dayText(found.parts);
    item.relDir = path.join(...D.toFolders(found.parts));
    item.newName = newNameOf(name, found.parts);
    const dir = path.join(root, item.relDir);

    // 이름 겹침: 같은 폴더에 내용이 같은 파일이 있으면 "이미 있음", 아니면 빈 자리를 찾아요
    const ext = path.extname(item.newName);
    const stem = path.basename(item.newName, ext);
    let dupOf = null;
    for (const f of filesIn(dir)) {
      if (f.size !== st.size) continue;
      try {
        if ((await hashFile(path.join(dir, f.name))) === (await hashFile(from))) {
          dupOf = f.name;
          break;
        }
      } catch (e) { /* 못 읽으면 다른 파일로 봐요 (둘 다 남김) */ }
    }
    if (dupOf) {
      item.status = 'dup';
      item.dest = path.join(dir, dupOf);
      item.note = `날짜 폴더에 내용이 같은 사진이 이미 있어요 (${dupOf}). 옮기지 않아요`;
      counts.dup++;
      continue;
    }
    const exists = new Set(filesIn(dir).map((f) => (isWin ? f.name.toLowerCase() : f.name)));
    for (let n = 0; ; n++) {
      const cand = n === 0 ? `${stem}${ext}` : `${stem}_${n}${ext}`;
      const abs = path.join(dir, cand);
      if (exists.has(isWin ? cand.toLowerCase() : cand) || taken.has(keyOf(abs))) continue;
      taken.add(keyOf(abs));
      item.dest = abs;
      item.newName = cand;
      if (n > 0) {
        item.note = '같은 이름이 있어서 _번호를 붙여요';
        counts.renamed++;
      }
      break;
    }
    item.status = 'move';
    counts.move++;
    if (item.via === 'job') counts.fromJobs++;
    else counts.fromFolder++;
  }
  return { items, counts };
}

// 화면에 줄 모양: 파일 경로는 빼고 이름만, 앞 100줄 (옮길 것을 먼저)
function toFillPreview(plan) {
  const order = { move: 0, dup: 1, protected: 2, ambiguous: 3, nodate: 4 };
  const sorted = [...plan.items].sort((a, b) => order[a.status] - order[b.status]);
  const lines = sorted.slice(0, PREVIEW_LINES).map((it) => ({
    name: it.name, newName: it.newName, day: it.day, status: it.status, via: it.via, note: it.note,
  }));
  return { counts: { ...plan.counts }, items: lines, more: sorted.length - lines.length };
}

// ---------- 옮기기 ----------
function appendLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

function freeSlot(dest) {
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const stem = path.basename(dest, ext);
  for (let n = 1; ; n++) {
    const cand = path.join(dir, `${stem}_${n}${ext}`);
    if (!fs.existsSync(cand)) return cand;
  }
}

// plan.items 중 status 'move' 만 옮겨요. 한 파일이 실패해도 다음으로 가요
async function runFill({ root, items, logger, journalDir, onProgress = () => {}, isProtected = () => false }) {
  const todo = items.filter((it) => it.status === 'move');
  const noDateDir = path.join(root, NO_DATE_DIR);
  const id = stamp();
  fs.mkdirSync(journalDir, { recursive: true });
  let journalPath = path.join(journalDir, `fill_${id}.jsonl`);
  for (let n = 1; fs.existsSync(journalPath); n++) journalPath = path.join(journalDir, `fill_${id}_${n}.jsonl`);
  appendLine(journalPath, { type: 'run', root, at: new Date().toISOString(), count: todo.length });
  const log = logger.newLog('fill-nodate', `# 날짜없음 채우기 / ${now()} / ${todo.length}장\n# 백업 폴더: ${root}\n# 방법: 앨범 정보(AlbumInfo.json) 날짜로 날짜 폴더에 옮기기 (옮기기만, 삭제 없음)\n# 시간\t결과\t이전 → 새 경로\n# "예정" 줄 다음에 결과 줄이 없으면 그 사진을 옮기는 도중에 꺼진 것. 되돌리기 기록: ${journalPath}`);

  const r = { moved: 0, fail: 0, skipped: 0, pairs: [], logPath: log.path, journalPath };
  let i = 0;
  for (const it of todo) {
    i++;
    onProgress({ done: i - 1, total: todo.length });
    const line = (what, extra = '') => log.write(`${now()}\t${what}\t${it.from} → ${it.dest}${extra}`);
    // 안전 확인: 원본은 _날짜없음 바로 아래, 도착은 백업 폴더 안의 날짜 폴더 (화면이나 계획을 믿지 않고 다시 봐요)
    const fromOk = keyOf(path.dirname(it.from)) === keyOf(noDateDir);
    const destOk = isInside(it.dest, root) && !isInside(it.dest, noDateDir) && !isInside(it.dest, path.join(root, MOVED_DIR));
    if (!fromOk || !destOk) {
      r.fail++;
      line('건너뜀', ' (안전 확인 실패: 위치가 맞지 않아요)');
      continue;
    }
    if (isProtected(it.from)) {
      r.skipped++; // 미리보기 뒤에 직접 값 · 태그가 생겼어요 (옮기면 잃어요)
      line('건너뜀', ' (직접 넣은 날짜 · 위치 · 태그가 있어요)');
      continue;
    }
    if (!fs.existsSync(it.from)) {
      r.skipped++;
      line('건너뜀', ' (원래 파일이 이미 없어요)');
      continue;
    }
    let dest = it.dest;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) dest = freeSlot(dest); // 미리보기 뒤에 생긴 같은 이름도 덮어쓰지 않아요
      it.dest = dest;
      line('예정'); // 옮기기 전에 먼저 적어요
      appendLine(journalPath, { type: 'move', from: it.from, to: dest, size: fs.statSync(it.from).size });
      fs.renameSync(it.from, dest); // 같은 백업 폴더 안 이동 (복사 · 삭제 없음)
      r.moved++;
      r.pairs.push({ from: it.from, to: dest });
      line('옮김');
    } catch (e) {
      r.fail++;
      line('실패', ` (${e && e.code ? e.code : '오류'})`);
      try { fs.rmdirSync(path.dirname(dest)); } catch (err) { /* 비어 있지 않으면 그대로 */ }
    }
  }
  onProgress({ done: todo.length, total: todo.length });
  log.write(`# 끝: 옮김 ${r.moved} / 건너뜀 ${r.skipped} / 실패 ${r.fail}`);
  return r;
}

// ---------- 되돌리기 ----------
function readJournal(journalPath) {
  const out = { run: null, moves: [], undone: false };
  for (const raw of fs.readFileSync(journalPath, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let o;
    try {
      o = JSON.parse(raw);
    } catch (e) {
      continue; // 끝이 잘린 줄은 무시
    }
    if (o.type === 'run') out.run = o;
    else if (o.type === 'move' && typeof o.from === 'string' && typeof o.to === 'string') out.moves.push(o);
    else if (o.type === 'undone') out.undone = true;
  }
  return out;
}

// 옮긴 파일을 원래 자리로. "예정"만 적고 안 옮겨진 줄(to 가 없음)과 이미 되돌린 줄은 건너뛰어요
async function undoFill({ journalPath, logger, isProtected = () => false }) {
  const j = readJournal(journalPath);
  if (!j.run) throw new Error('되돌리기 기록을 읽을 수 없어요');
  if (j.undone) throw new Error('이미 되돌린 기록이에요');
  const noDateDir = path.join(j.run.root, NO_DATE_DIR);
  const log = logger.newLog('fill-nodate-undo', `# 날짜없음 채우기 되돌리기 / ${now()} / ${j.moves.length}장\n# 백업 폴더: ${j.run.root}`);
  const r = { restored: 0, fail: 0, skipped: 0, pairs: [], logPath: log.path };
  for (const m of j.moves.slice().reverse()) {
    const line = (what, extra = '') => log.write(`${now()}\t${what}\t${m.to} → ${m.from}${extra}`);
    const ok = keyOf(path.dirname(m.from)) === keyOf(noDateDir) && isInside(m.to, j.run.root);
    if (!ok) {
      r.fail++;
      line('건너뜀', ' (안전 확인 실패)');
      continue;
    }
    if (!fs.existsSync(m.to)) {
      r.skipped++; // 예정만 적히고 못 옮겼거나, 사용자가 이미 옮겼어요
      line('건너뜀', ' (옮겨진 파일이 없어요)');
      continue;
    }
    // 옮길 때 적어 둔 크기와 다르면 그 자리에 나중에 생긴 다른 파일이에요 → 끌어오지 않아요
    if (typeof m.size === 'number' && fs.statSync(m.to).size !== m.size) {
      r.fail++;
      line('건너뜀', ' (옮긴 파일과 크기가 달라요)');
      continue;
    }
    if (isProtected(m.to)) {
      r.fail++; // 옮긴 뒤 새 자리에 직접 값 · 태그를 넣었어요 (되돌리면 잃어요)
      line('건너뜀', ' (직접 넣은 날짜 · 위치 · 태그가 있어요)');
      continue;
    }
    if (fs.existsSync(m.from)) {
      r.fail++; // 원래 자리에 같은 이름이 생겼어요 → 덮어쓰지 않아요
      line('건너뜀', ' (원래 자리에 같은 이름이 있어요)');
      continue;
    }
    try {
      fs.mkdirSync(noDateDir, { recursive: true });
      fs.renameSync(m.to, m.from);
      r.restored++;
      r.pairs.push({ from: m.from, to: m.to });
      line('되돌림');
      // 내가 비운 날짜 폴더만 정리해요 (비어 있을 때만 지워져요)
      for (let d = path.dirname(m.to); isInside(d, j.run.root) && d !== path.resolve(j.run.root); d = path.dirname(d)) {
        try {
          fs.rmdirSync(d);
        } catch (e) {
          break;
        }
      }
    } catch (e) {
      r.fail++;
      line('실패', ` (${e && e.code ? e.code : '오류'})`);
    }
  }
  // 실패가 남았으면 "되돌림 끝"으로 적지 않아요 (원인을 풀고 다시 되돌릴 수 있게)
  if (r.fail === 0) appendLine(journalPath, { type: 'undone', at: new Date().toISOString(), restored: r.restored, skipped: r.skipped });
  log.write(`# 끝: 되돌림 ${r.restored} / 건너뜀 ${r.skipped} / 실패 ${r.fail}`);
  return r;
}

// 되돌리지 않은 가장 최근 묶음 (이 백업 폴더의 것만)
function lastFillRun(journalDir, root) {
  let names = [];
  try {
    names = fs.readdirSync(journalDir).filter((n) => /^fill_.*\.jsonl$/.test(n)).sort();
  } catch (e) {
    return null;
  }
  for (let i = names.length - 1; i >= 0; i--) {
    const journalPath = path.join(journalDir, names[i]);
    let j;
    try {
      j = readJournal(journalPath);
    } catch (e) {
      continue;
    }
    if (!j.run || keyOf(j.run.root) !== keyOf(root)) continue;
    if (j.undone || j.moves.length === 0) return null; // 가장 최근 묶음이 이미 되돌려졌으면 더 옛것은 건드리지 않아요
    return { id: names[i].slice('fill_'.length, -'.jsonl'.length), count: j.moves.length, at: j.run.at, journalPath };
  }
  return null;
}

module.exports = { historyFromJobs, indexAlbumDirs, planFill, toFillPreview, runFill, undoFill, lastFillRun, newNameOf, NO_DATE_DIR };

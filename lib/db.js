// 파일 위치: lib/db.js
// 역할: 갤러리 DB (SQLite 파일 library.db) 열기, 구조, 그리고 모든 SQL
//   - SQL은 이 파일에만 둬요. 값은 항상 ? 자리에 넘겨요 (글자를 SQL에 이어 붙이지 않음)
//   - Node에 들어 있는 node:sqlite를 써요 (실험 기능이라 한 곳에 모아 둠)
//   - DB 안의 값은 모두 사진 폴더에서 다시 만들 수 있어요 → DB가 깨지면 이름을 바꿔 두고 새로 만들어요
//   - 사진 파일은 절대 건드리지 않아요. 이 파일이 쓰는 건 DB 파일뿐이에요
//
// 모양: openDb(파일경로) → { db, recovered }

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { stamp } = require('./logger');

const SCHEMA_VERSION = 1;

// 구조 (docs/superpowers/specs/2026-11-01-gallery-design.md 5절)
// 표를 먼저 만들고 칸을 확인한 뒤에 색인을 만들어요 (다른 구조의 파일이면 색인 만들기에서 엉뚱한 오류가 나지 않게)
const TABLES = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  root TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  taken_at TEXT,
  taken_offset TEXT,
  taken_day TEXT,
  taken_at_source TEXT,
  lat REAL,
  lng REAL,
  location_source TEXT,
  model TEXT,
  width INTEGER,
  height INTEGER,
  duration_sec REAL,
  thumb_state TEXT NOT NULL DEFAULT 'none',
  missing INTEGER NOT NULL DEFAULT 0,
  read_error TEXT
);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS file_tags (
  file_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (file_id, tag_id)
);
`;
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_files_day ON files (root, missing, taken_day);
CREATE INDEX IF NOT EXISTS idx_files_type_day ON files (root, missing, media_type, taken_day);
CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags (tag_id);
`;

// 사진/영상 표시 이름 태그 중 "스크린샷" 탭을 판단하는 이름 (source가 mediaType인 것만)
const SCREENSHOT_TAG = '스크린샷';

// DB 한 줄 → 화면/다른 모듈이 쓰는 모양 (이름은 camelCase)
function fullRow(r) {
  return {
    id: r.id,
    root: r.root,
    path: r.path,
    name: r.name,
    mediaType: r.media_type,
    size: r.size,
    mtimeMs: r.mtime_ms,
    takenAt: r.taken_at,
    takenOffset: r.taken_offset,
    takenDay: r.taken_day,
    takenAtSource: r.taken_at_source,
    lat: r.lat,
    lng: r.lng,
    locationSource: r.location_source,
    model: r.model,
    width: r.width,
    height: r.height,
    durationSec: r.duration_sec,
    thumbState: r.thumb_state,
    missing: r.missing,
    readError: r.read_error,
  };
}

// undefined는 SQLite에 못 넘기므로 null로 바꿔요
const nul = (v) => (v === undefined ? null : v);

// 조회 조건 만들기: 이 root의 보이는(missing=0) 파일 + 탭 + 태그
//   반환: { where: 'SQL 조건', params: [값...] }  (파일 표의 별칭은 f)
//   검색어(filter.query)는 작업 3에서 여기에 더해요
function buildWhere(root, filter = {}) {
  const parts = ['f.root = ?', 'f.missing = 0'];
  const params = [root];
  const tab = filter.tab || 'all';
  if (tab === 'photo') {
    // 탭은 겹치지 않아요: 스크린샷은 사진 탭에서 빠지고 스크린샷 탭에만 나와요
    parts.push(`f.media_type = 'photo' AND NOT EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
      WHERE ft.file_id = f.id AND ft.source = 'mediaType' AND t.name = ?)`);
    params.push(SCREENSHOT_TAG);
  } else if (tab === 'video') {
    parts.push("f.media_type = 'video'");
  } else if (tab === 'screenshot') {
    parts.push(`EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
      WHERE ft.file_id = f.id AND ft.source = 'mediaType' AND t.name = ?)`);
    params.push(SCREENSHOT_TAG);
  }
  if (filter.tag) {
    parts.push(`EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
      WHERE ft.file_id = f.id AND ft.source = 'album' AND t.name = ?)`);
    params.push(filter.tag);
  }
  return { where: parts.join(' AND '), params };
}

// 정렬 방향 (SQL에 글자를 넣는 곳이라 정해진 값만 허용)
const dirOf = (filter) => (filter && filter.sort === 'oldest' ? 'ASC' : 'DESC');

// 이 모듈이 직접 판단한 "구조가 이상한 DB" 오류 (이름을 바꿔 보관해도 되는 경우)
class BrokenDbError extends Error {}

// 이름을 바꿔 보관해도 되는 오류인가? 파일 자체가 DB가 아니거나(NOTADB 26) 깨진(CORRUPT 11) 경우, 또는 구조 확인에서 걸린 경우만.
//   다른 프로그램이 쓰는 중(BUSY 5, LOCKED 6), 권한(PERM 3, READONLY 8, CANTOPEN 14), 디스크 가득(FULL 13) 같은 건
//   멀쩡한 DB일 수 있으니 절대 이름을 바꾸지 않고 그대로 오류를 알려요.
//   errcode 아래 8비트가 기본 오류 코드예요 (세부 코드는 위쪽 비트에 붙음)
function isCorruptionError(e) {
  if (!e) return false;
  if (e instanceof BrokenDbError) return true;
  if (typeof e.errcode !== 'number') return false;
  const primary = e.errcode & 0xff;
  return primary === 26 || primary === 11;
}

// 열어 본 파일이 쓸 수 있는 DB인지 확인하고 구조를 만들어요. 문제가 있으면 오류를 던져요.
function openAndPrepare(file, busyTimeoutMs) {
  const raw = new DatabaseSync(file);
  try {
    // 가장 먼저: 다른 연결이 쓰는 중이면 잠깐 기다려요
    raw.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}`);
    // 쓰레기 파일이면 여기서 "file is not a database" 오류가 나요
    const check = raw.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || check[0].quick_check !== 'ok') throw new BrokenDbError('DB 검사 실패');
    const version = raw.prepare('PRAGMA user_version').get().user_version;
    if (version > SCHEMA_VERSION) throw new BrokenDbError(`더 새로운 구조(${version})의 DB`);
    raw.exec('PRAGMA journal_mode = WAL'); // 읽기와 쓰기가 덜 막히는 방식
    raw.exec('PRAGMA synchronous = NORMAL');
    raw.exec(TABLES);
    // 표는 있는데 칸이 모자란 파일(다른 프로그램 DB 등)도 걸러내요
    try {
      raw.prepare('SELECT id, root, path, name, media_type, size, mtime_ms, taken_at, taken_offset, taken_day, taken_at_source, lat, lng, location_source, model, width, height, duration_sec, thumb_state, missing, read_error FROM files LIMIT 0').all();
      raw.prepare('SELECT id, name FROM tags LIMIT 0').all();
      raw.prepare('SELECT file_id, tag_id, source FROM file_tags LIMIT 0').all();
    } catch (e) {
      throw new BrokenDbError(`표 구조가 달라요: ${e.message}`);
    }
    raw.exec(INDEXES);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return raw;
  } catch (e) {
    try { raw.close(); } catch (e2) { /* 이미 닫힘 */ }
    throw e;
  }
}

// 깨진 DB 파일(과 -wal, -shm)을 library.db.broken-시각 으로 이름을 바꿔 보관해요 (지우지 않음)
function keepBroken(file) {
  const base = `${file}.broken-${stamp()}`;
  let target = base;
  for (let n = 1; fs.existsSync(target); n++) target = `${base}_${n}`;
  fs.renameSync(file, target);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(file + ext)) fs.renameSync(file + ext, target + ext);
  }
  return target;
}

// options.busyTimeoutMs: 다른 연결이 쓰는 중일 때 기다리는 시간 (기본 3초)
function openDb(filePath, options = {}) {
  const busyTimeoutMs = options.busyTimeoutMs === undefined ? 3000 : options.busyTimeoutMs;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let raw;
  let recovered = false;
  try {
    raw = openAndPrepare(filePath, busyTimeoutMs);
  } catch (e) {
    // 깨진 파일일 때만 이름을 바꿔요. 그 밖의 오류(잠김, 권한, 디스크 가득 등)는 파일을 두고 그대로 알려요
    if (!isCorruptionError(e) || !fs.existsSync(filePath)) throw e;
    keepBroken(filePath);
    raw = openAndPrepare(filePath, busyTimeoutMs);
    recovered = true;
  }
  return { db: makeApi(raw), recovered };
}

// 열린 DB를 감싸서 갤러리가 쓰는 함수들을 만들어요
function makeApi(raw) {
  // 같은 SQL은 한 번만 준비해요
  const cache = new Map();
  const st = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  // 한 트랜잭션으로 묶기: 중간에 오류가 나면 전부 되돌려요
  function tx(fn) {
    raw.exec('BEGIN');
    try {
      const r = fn();
      raw.exec('COMMIT');
      return r;
    } catch (e) {
      try { raw.exec('ROLLBACK'); } catch (e2) { /* 이미 끝남 */ }
      throw e;
    }
  }

  const UPSERT = `
    INSERT INTO files (root, path, name, media_type, size, mtime_ms, taken_at, taken_offset, taken_day,
      taken_at_source, lat, lng, location_source, model, width, height, duration_sec, read_error,
      thumb_state, missing)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 0)
    ON CONFLICT(path) DO UPDATE SET
      root = excluded.root, name = excluded.name, media_type = excluded.media_type,
      size = excluded.size, mtime_ms = excluded.mtime_ms, taken_at = excluded.taken_at,
      taken_offset = excluded.taken_offset, taken_day = excluded.taken_day,
      taken_at_source = excluded.taken_at_source, lat = excluded.lat, lng = excluded.lng,
      location_source = excluded.location_source, model = excluded.model,
      width = excluded.width, height = excluded.height, duration_sec = excluded.duration_sec,
      read_error = excluded.read_error, thumb_state = 'none', missing = 0
    RETURNING id`;

  return {
    // 파일 여러 개 저장 (새 파일은 추가, 같은 path는 갱신). 한 트랜잭션.
    //   바뀐 파일은 썸네일을 다시 만들도록 none으로, missing은 0으로 되돌리고 태그를 통째로 바꿔요
    upsertFiles(rows) {
      if (!rows || !rows.length) return;
      tx(() => {
        for (const r of rows) {
          const { id } = st(UPSERT).get(
            r.root, r.path, r.name, r.mediaType, r.size, r.mtimeMs,
            nul(r.takenAt), nul(r.takenOffset), nul(r.takenDay), nul(r.takenAtSource),
            nul(r.lat), nul(r.lng), nul(r.locationSource), nul(r.model),
            nul(r.width), nul(r.height), nul(r.durationSec), nul(r.readError),
          );
          st('DELETE FROM file_tags WHERE file_id = ?').run(id);
          for (const t of r.tags || []) {
            st('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(t.name);
            const tagId = st('SELECT id FROM tags WHERE name = ?').get(t.name).id;
            st('INSERT OR REPLACE INTO file_tags (file_id, tag_id, source) VALUES (?, ?, ?)').run(id, tagId, t.source);
          }
        }
      });
    },

    // 이 root에서 이미 아는 파일 (사라진 것 포함) → Map<path, { size, mtimeMs, readError, missing }>
    knownFiles(root) {
      const map = new Map();
      for (const r of st('SELECT path, size, mtime_ms, read_error, missing FROM files WHERE root = ?').all(root)) {
        map.set(r.path, { size: r.size, mtimeMs: r.mtime_ms, readError: r.read_error, missing: r.missing });
      }
      return map;
    },

    // 파일이 폴더에서 사라졌다고 표시(1)하거나 되돌려요(0). 한 트랜잭션.
    setMissing(paths, missing) {
      if (!paths || !paths.length) return;
      const flag = missing ? 1 : 0;
      tx(() => {
        for (const p of paths) st('UPDATE files SET missing = ? WHERE path = ?').run(flag, p);
      });
    },

    // 날짜별 개수. 날짜 없음(day: null)은 정렬과 관계없이 맨 끝
    listDays(root, filter) {
      const { where, params } = buildWhere(root, filter);
      const sql = `SELECT f.taken_day AS day, COUNT(*) AS count FROM files f WHERE ${where}
        GROUP BY f.taken_day ORDER BY f.taken_day IS NULL, f.taken_day ${dirOf(filter)}`;
      return st(sql).all(...params).map((r) => ({ day: r.day, count: r.count }));
    },

    // 하루치 파일 목록 (day가 null이면 날짜 없는 파일)
    listFiles(root, day, filter) {
      const { where, params } = buildWhere(root, filter);
      const dayCond = day === null || day === undefined ? 'f.taken_day IS NULL' : 'f.taken_day = ?';
      const dayParams = day === null || day === undefined ? [] : [day];
      const order = day === null || day === undefined
        ? 'f.name, f.id'
        : `f.taken_at ${dirOf(filter)}, f.name, f.id`;
      const sql = `SELECT f.id, f.name, f.media_type, f.duration_sec, f.thumb_state FROM files f
        WHERE ${where} AND ${dayCond} ORDER BY ${order}`;
      return st(sql).all(...params, ...dayParams).map((r) => ({
        id: r.id,
        name: r.name,
        mediaType: r.media_type,
        durationSec: r.duration_sec,
        thumbState: r.thumb_state,
      }));
    },

    // 파일 한 개의 모든 값 + 태그 (없으면 null). 사라진 파일(missing)도 id로는 돌려줘요
    getFile(id) {
      const r = st('SELECT * FROM files WHERE id = ?').get(id);
      if (!r) return null;
      const tags = st(`SELECT t.name AS name, ft.source AS source FROM file_tags ft
        JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = ? ORDER BY t.name`).all(id)
        .map((t) => ({ name: t.name, source: t.source }));
      return { ...fullRow(r), tags };
    },

    // 사이드바용 요약: 전체 개수, 날짜 없음, 앨범 태그(많은 순)
    summary(root) {
      const total = st('SELECT COUNT(*) AS n FROM files WHERE root = ? AND missing = 0').get(root).n;
      const noDate = st('SELECT COUNT(*) AS n FROM files WHERE root = ? AND missing = 0 AND taken_day IS NULL').get(root).n;
      const tags = st(`SELECT t.name AS name, COUNT(*) AS count FROM file_tags ft
        JOIN tags t ON t.id = ft.tag_id JOIN files f ON f.id = ft.file_id
        WHERE f.root = ? AND f.missing = 0 AND ft.source = 'album'
        GROUP BY t.id ORDER BY count DESC, t.name`).all(root)
        .map((t) => ({ name: t.name, count: t.count }));
      return { total, noDate, tagCount: tags.length, tags };
    },

    // 썸네일 상태 바꾸기: none | ready | failed
    setThumbState(id, state) {
      st('UPDATE files SET thumb_state = ? WHERE id = ?').run(state, id);
    },

    // 썸네일을 만들어야 할 파일 (최신 날짜부터, 사라진 파일 제외) → 전체 값 한 줄씩 (태그 없음)
    nextThumbJobs(root, limit) {
      return st(`SELECT * FROM files WHERE root = ? AND missing = 0 AND thumb_state = 'none'
        ORDER BY taken_day IS NULL, taken_day DESC, id LIMIT ?`).all(root, limit).map(fullRow);
    },

    // 썸네일 만들기에 실패했던 파일을 다시 대기로
    resetFailedThumbs(root) {
      st("UPDATE files SET thumb_state = 'none' WHERE root = ? AND thumb_state = 'failed'").run(root);
    },

    close() {
      cache.clear();
      raw.close();
    },
  };
}

module.exports = { openDb, isCorruptionError, SCHEMA_VERSION };

// 파일 위치: lib/db.js
// 역할: 갤러리 DB (SQLite 파일 library.db) 열기, 구조, 그리고 모든 SQL
//   - SQL은 이 파일에만 둬요. 값은 항상 ? 자리에 넘겨요 (글자를 SQL에 이어 붙이지 않음)
//   - Node에 들어 있는 node:sqlite를 써요 (실험 기능이라 한 곳에 모아 둠)
//   - DB 안의 값은 거의 모두 사진 폴더에서 다시 만들 수 있어요 → DB가 깨지면 이름을 바꿔 두고 새로 만들어요
//     (예외: 사용자가 직접 넣은 날짜와 위치는 manual_values 표에만 있어요. 구조 버전 2부터)
//   - 사진 파일은 절대 건드리지 않아요. 이 파일이 쓰는 건 DB 파일뿐이에요
//
// 모양: openDb(파일경로) → { db, recovered }

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { stamp } = require('./logger');
const { parseQuery } = require('./search');

const SCHEMA_VERSION = 2;

// 구조 (docs/superpowers/specs/2026-11-01-gallery-design.md 5절, 직접 넣은 값은 2026-11-01-missing-info-design.md 4절)
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
-- 직접 넣은 값. 파일을 다시 읽을 때마다 여기 값을 files에 다시 덮어 써요
--   files와는 id가 아니라 경로로 이어요 (files를 읽기 전에 복구해도 값이 남도록)
CREATE TABLE IF NOT EXISTS manual_values (
  path TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  taken_at TEXT,
  taken_offset TEXT,
  lat REAL,
  lng REAL,
  orig_known INTEGER NOT NULL DEFAULT 0,
  orig_taken_at TEXT,
  orig_taken_offset TEXT,
  orig_taken_day TEXT,
  orig_taken_at_source TEXT,
  orig_lat REAL,
  orig_lng REAL,
  orig_location_source TEXT
);
-- 비슷한 사진 지문 (단계 4). 파일 경로 + 크기 + 수정 시각이 files와 같을 때만 맞는 값이에요 (파일이 바뀌면 다시 계산)
--   dhash: 16글자 16진수(64칸), 만들 수 없었으면 NULL. 이 표는 언제든 다시 만들 수 있어요
--   구조 버전은 올리지 않아요 (옛 빌드가 새 버전 DB를 "깨짐"으로 보고 다시 만들지 않게. 옛 빌드는 이 표를 모르고 지나가요)
CREATE TABLE IF NOT EXISTS photo_hashes (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  dhash TEXT
);
-- 작업 한 번 = 묶음 하나
CREATE TABLE IF NOT EXISTS edit_batches (
  id TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  undone_at TEXT
);
-- 묶음이 바꾼 파일별 "이전 상태"와 "이후 상태" (되돌릴 때 이전 상태를 써요)
CREATE TABLE IF NOT EXISTS edit_items (
  batch_id TEXT NOT NULL,
  path TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  PRIMARY KEY (batch_id, path)
);
`;
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_files_day ON files (root, missing, taken_day);
CREATE INDEX IF NOT EXISTS idx_files_type_day ON files (root, missing, media_type, taken_day);
CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags (tag_id);
`;

// 사진/영상 표시 이름 태그 중 "스크린샷" 탭을 판단하는 이름 (source가 mediaType인 것만)
const SCREENSHOT_TAG = '스크린샷';

// LIKE에서 \ 를 "다음 글자는 그대로"라는 표시로 써요 (lib/search.js가 %, _, \ 앞에 \ 를 붙여 줌)
const LIKE_ESCAPE = String.raw`ESCAPE '\'`;

// "스크린샷이 아니다 / 스크린샷이다" 조건 (? 자리에 SCREENSHOT_TAG를 넘겨요). 사진 탭, 정보 없음 필터가 같이 써요
const IS_SCREENSHOT_SQL = `EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
      WHERE ft.file_id = f.id AND ft.source = 'mediaType' AND t.name = ?)`;
const NOT_SCREENSHOT_SQL = `NOT ${IS_SCREENSHOT_SQL}`;

// 정보 없음 조건 (파일 표의 별칭은 f). 값이 없는지는 IS NULL로 봐요 (위도 0도 값이에요)
//   위치 없음: 위도가 없는 파일. 스크린샷은 위치가 없는 게 당연하니 뺀다 (? 1개: SCREENSHOT_TAG)
//   날짜 없음: 찍은 날이 없는 파일 (스크린샷도 포함)
//   직접 넣음: 날짜나 위치의 출처가 manual
//   정보 없음 합계: 날짜 없음 또는 위치 없음 (? 1개: SCREENSHOT_TAG). 둘 다 없는 파일도 한 번만 세요
const NO_LOCATION_SQL = `f.lat IS NULL AND ${NOT_SCREENSHOT_SQL}`;
const NO_DATE_SQL = 'f.taken_day IS NULL';
const MANUAL_SQL = "(f.taken_at_source = 'manual' OR f.location_source = 'manual')";
const NO_INFO_SQL = `(${NO_DATE_SQL} OR (${NO_LOCATION_SQL}))`;

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
//   검색어(filter.query): 공백으로 나눈 낱말이 모두 맞아야 해요 (AND).
//   한 낱말은 파일 이름 또는 태그(앨범, 종류 모두) 또는 날짜에 맞으면 돼요. %, _ 는 글자 그대로 찾아요 (LIKE_ESCAPE)
function buildWhere(root, filter = {}) {
  const parts = ['f.root = ?', 'f.missing = 0'];
  const params = [root];
  const tab = filter.tab || 'all';
  if (tab === 'photo') {
    // 탭은 겹치지 않아요: 스크린샷은 사진 탭에서 빠지고 스크린샷 탭에만 나와요
    parts.push(`f.media_type = 'photo' AND ${NOT_SCREENSHOT_SQL}`);
    params.push(SCREENSHOT_TAG);
  } else if (tab === 'video') {
    parts.push("f.media_type = 'video'");
  } else if (tab === 'screenshot') {
    parts.push(IS_SCREENSHOT_SQL);
    params.push(SCREENSHOT_TAG);
  }
  // 정보 없음 필터 (noLocation | noDate | manual). 다른 값이면 조건을 더하지 않아요
  if (filter.info === 'noLocation') {
    parts.push(NO_LOCATION_SQL);
    params.push(SCREENSHOT_TAG);
  } else if (filter.info === 'noDate') {
    parts.push(NO_DATE_SQL);
  } else if (filter.info === 'manual') {
    parts.push(MANUAL_SQL);
  }
  if (filter.tag) {
    parts.push(`EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
      WHERE ft.file_id = f.id AND ft.source = 'album' AND t.name = ?)`);
    params.push(filter.tag);
  }
  for (const term of parseQuery(filter.query)) {
    const alt = [
      `f.name LIKE ? ${LIKE_ESCAPE}`,
      `EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
        WHERE ft.file_id = f.id AND t.name LIKE ? ${LIKE_ESCAPE})`,
    ];
    params.push(term.like, term.like);
    if (term.dateLike !== null) {
      alt.push(`f.taken_day LIKE ? ${LIKE_ESCAPE}`);
      params.push(term.dateLike);
    }
    parts.push(`(${alt.join(' OR ')})`);
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

// 칸 확인(SELECT 준비)에서 난 오류를 어떻게 다룰지 정해요.
//   SQLITE_ERROR(1, 예: no such column)만 "표 구조가 달라요"로 바꿔요 → 이름 바꿔 보관 대상
//   잠김(5, 6), 입출력 오류(10), 디스크 가득(13) 같은 건 멀쩡한 DB일 수 있으니 오류를 그대로 돌려줘요 (던지는 건 부른 쪽)
function structureErrorOf(e) {
  if (e && typeof e.errcode === 'number' && (e.errcode & 0xff) === 1) {
    return new BrokenDbError(`표 구조가 달라요: ${e.message}`);
  }
  return e;
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
      raw.prepare('SELECT path, root, taken_at, taken_offset, lat, lng, orig_known, orig_taken_at, orig_taken_offset, orig_taken_day, orig_taken_at_source, orig_lat, orig_lng, orig_location_source FROM manual_values LIMIT 0').all();
      raw.prepare('SELECT id, root, kind, count, created_at, undone_at FROM edit_batches LIMIT 0').all();
      raw.prepare('SELECT batch_id, path, before_json, after_json FROM edit_items LIMIT 0').all();
      raw.prepare('SELECT path, size, mtime_ms, dhash FROM photo_hashes LIMIT 0').all();
    } catch (e) {
      throw structureErrorOf(e);
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

  // ---------- 직접 넣은 값 (manual_values) ----------
  //   files의 날짜/위치 칸은 항상 "화면에 보일 값"이에요. 직접 넣은 값이 있으면 그 값, 없으면 orig_ (파일에서 읽은 값).
  //   값이 없는지는 항상 === null 로 비교해요 (위도 0, 경도 0도 값이에요)

  // manual_values에 있는 값으로 files 줄을 다시 계산해요 (files 줄이 없거나 orig_를 아직 모르면 아무것도 안 해요)
  function applyManualToFile(p) {
    const m = st('SELECT * FROM manual_values WHERE path = ?').get(p);
    if (!m || m.orig_known !== 1) return;
    // 날짜: 직접 넣은 시각이 있으면 그 값, 없으면 파일에서 읽은 값
    if (m.taken_at !== null) {
      st("UPDATE files SET taken_at = ?, taken_offset = ?, taken_day = ?, taken_at_source = 'manual' WHERE path = ?")
        .run(m.taken_at, m.taken_offset, m.taken_at.slice(0, 10), p);
    } else {
      st('UPDATE files SET taken_at = ?, taken_offset = ?, taken_day = ?, taken_at_source = ? WHERE path = ?')
        .run(m.orig_taken_at, m.orig_taken_offset, m.orig_taken_day, m.orig_taken_at_source, p);
    }
    // 위치도 따로 같은 규칙
    if (m.lat !== null) {
      st("UPDATE files SET lat = ?, lng = ?, location_source = 'manual' WHERE path = ?").run(m.lat, m.lng, p);
    } else {
      st('UPDATE files SET lat = ?, lng = ?, location_source = ? WHERE path = ?')
        .run(m.orig_lat, m.orig_lng, m.orig_location_source, p);
    }
  }

  // 직접 넣은 값 한 개를 저장하고 files에 반영해요. 값이 null(또는 날짜도 위치도 없음)이면 줄을 지우고 파일 값으로 돌려요.
  //   처음 저장할 때 files 줄이 있으면 지금 값을 orig_에 보관해요 (없으면 orig_known 0, 나중에 upsertFiles가 채움)
  //   반드시 tx 안에서 불러요
  function writeManual(p, root, value) {
    const had = st('SELECT 1 AS x FROM manual_values WHERE path = ?').get(p);
    if (value === null || (value.takenAt === null && value.lat === null)) {
      if (!had) return;
      // 먼저 "직접 넣은 값 없음"으로 바꿔서 files를 파일 값으로 돌려 놓고, 그다음 줄을 지워요
      st('UPDATE manual_values SET taken_at = NULL, taken_offset = NULL, lat = NULL, lng = NULL WHERE path = ?').run(p);
      applyManualToFile(p);
      st('DELETE FROM manual_values WHERE path = ?').run(p);
      return;
    }
    if (!had) {
      const f = st('SELECT * FROM files WHERE path = ?').get(p);
      if (f) {
        st(`INSERT INTO manual_values (path, root, orig_known, orig_taken_at, orig_taken_offset, orig_taken_day,
          orig_taken_at_source, orig_lat, orig_lng, orig_location_source) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`).run(
          p, root, f.taken_at, f.taken_offset, f.taken_day, f.taken_at_source, f.lat, f.lng, f.location_source,
        );
      } else {
        st('INSERT INTO manual_values (path, root, orig_known) VALUES (?, ?, 0)').run(p, root);
      }
    }
    st('UPDATE manual_values SET root = ?, taken_at = ?, taken_offset = ?, lat = ?, lng = ? WHERE path = ?')
      .run(root, nul(value.takenAt), nul(value.takenOffset), nul(value.lat), nul(value.lng), p);
    applyManualToFile(p);
  }

  // 이 root에서 되돌리지 않은 마지막 묶음 (rowid가 큰 것이 나중에 만든 것)
  const lastBatchOf = (root) => st(`SELECT id, kind, count, created_at FROM edit_batches
    WHERE root = ? AND undone_at IS NULL ORDER BY rowid DESC LIMIT 1`).get(root);

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
          // 직접 넣은 값이 있으면: orig_를 방금 읽은 파일 값으로 고치고, 직접 넣은 값을 다시 덮어 써요
          if (st('SELECT 1 AS x FROM manual_values WHERE path = ?').get(r.path)) {
            st(`UPDATE manual_values SET orig_known = 1, orig_taken_at = ?, orig_taken_offset = ?, orig_taken_day = ?,
              orig_taken_at_source = ?, orig_lat = ?, orig_lng = ?, orig_location_source = ? WHERE path = ?`).run(
              nul(r.takenAt), nul(r.takenOffset), nul(r.takenDay), nul(r.takenAtSource),
              nul(r.lat), nul(r.lng), nul(r.locationSource), r.path,
            );
            applyManualToFile(r.path);
          }
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

    // ---------- 비슷한 사진 지문 ----------
    // 지문을 아직 안 만든 사진 (이 root, 사라진 것 제외, 파일이 바뀌었으면 다시) → 전체 값 한 줄씩, 오래된 id부터
    hashJobs(root, limit) {
      return st(`SELECT f.* FROM files f LEFT JOIN photo_hashes h
          ON h.path = f.path AND h.size = f.size AND h.mtime_ms = f.mtime_ms
        WHERE f.root = ? AND f.missing = 0 AND f.media_type = 'photo' AND h.path IS NULL
        ORDER BY f.id LIMIT ?`).all(root, limit).map(fullRow);
    },

    // 지문 저장 (만들 수 없었으면 dhash null → 다시 시도하지 않아요. 파일이 바뀌면 다시)
    setHash(p, size, mtimeMs, dhash) {
      st('INSERT OR REPLACE INTO photo_hashes (path, size, mtime_ms, dhash) VALUES (?, ?, ?, ?)').run(p, size, mtimeMs, nul(dhash));
    },

    // 지문 진행: 이 root의 보이는 사진 수와 지문을 끝낸(실패 포함) 수
    hashProgress(root) {
      return st(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN h.path IS NULL THEN 0 ELSE 1 END), 0) AS done
        FROM files f LEFT JOIN photo_hashes h ON h.path = f.path AND h.size = f.size AND h.mtime_ms = f.mtime_ms
        WHERE f.root = ? AND f.missing = 0 AND f.media_type = 'photo'`).get(root);
    },

    // 묶기에 쓰는 줄: 이 root의 보이는 사진 → [{ id, name, takenAt, width, height, size, model, dhash }]
    //   지문이 없거나(아직, 실패) 파일이 바뀐 뒤면 dhash null
    similarRows(root) {
      return st(`SELECT f.id, f.name, f.taken_at, f.width, f.height, f.size, f.model, h.dhash
        FROM files f LEFT JOIN photo_hashes h ON h.path = f.path AND h.size = f.size AND h.mtime_ms = f.mtime_ms
        WHERE f.root = ? AND f.missing = 0 AND f.media_type = 'photo' ORDER BY f.id`).all(root)
        .map((r) => ({ id: r.id, name: r.name, takenAt: r.taken_at, width: r.width, height: r.height, size: r.size, model: r.model, dhash: r.dhash }));
    },

    // 썸네일 이름을 만드는 값 (모든 폴더, 사라진 파일 포함) → [{ path, size, mtimeMs }]
    //   썸네일 정리가 "아직 쓰는 썸네일"을 가려낼 때 써요
    thumbKeys() {
      return st('SELECT path, size, mtime_ms FROM files').all().map((r) => ({ path: r.path, size: r.size, mtimeMs: r.mtime_ms }));
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

    // 조건에 맞는 파일 id 전체 (목록 전체 선택용). 순서는 listDays 순서대로 날짜마다 listFiles 순서와 같아요
    listIds(root, filter) {
      const { where, params } = buildWhere(root, filter);
      const dir = dirOf(filter);
      // 날짜 없는 파일은 이름, id 순 / 날짜 있는 파일은 찍은 시각(정렬 방향), 이름, id 순
      const sql = `SELECT f.id AS id FROM files f WHERE ${where}
        ORDER BY f.taken_day IS NULL, f.taken_day ${dir},
          CASE WHEN f.taken_day IS NULL THEN NULL ELSE f.taken_at END ${dir}, f.name, f.id`;
      return st(sql).all(...params).map((r) => r.id);
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

    // 사이드바용 요약: 전체 개수, 날짜 없음, 위치 없음(스크린샷 제외), 정보 없음 합계, 직접 넣은 수, 앨범 태그(많은 순)
    summary(root) {
      const total = st('SELECT COUNT(*) AS n FROM files WHERE root = ? AND missing = 0').get(root).n;
      const noDate = st('SELECT COUNT(*) AS n FROM files WHERE root = ? AND missing = 0 AND taken_day IS NULL').get(root).n;
      const info = st(`SELECT
          COALESCE(SUM(CASE WHEN ${NO_LOCATION_SQL} THEN 1 ELSE 0 END), 0) AS no_location,
          COALESCE(SUM(CASE WHEN ${NO_INFO_SQL} THEN 1 ELSE 0 END), 0) AS no_info,
          COALESCE(SUM(CASE WHEN ${MANUAL_SQL} THEN 1 ELSE 0 END), 0) AS manual_count
        FROM files f WHERE f.root = ? AND f.missing = 0`).get(SCREENSHOT_TAG, SCREENSHOT_TAG, root);
      const tags = st(`SELECT t.name AS name, COUNT(*) AS count FROM file_tags ft
        JOIN tags t ON t.id = ft.tag_id JOIN files f ON f.id = ft.file_id
        WHERE f.root = ? AND f.missing = 0 AND ft.source = 'album'
        GROUP BY t.id ORDER BY count DESC, t.name`).all(root)
        .map((t) => ({ name: t.name, count: t.count }));
      return {
        total, noDate, noLocation: info.no_location, noInfo: info.no_info, manualCount: info.manual_count,
        tagCount: tags.length, tags,
      };
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

    // ---------- 직접 넣은 값 ----------
    // 직접 넣은 값 한 개 → { takenAt, takenOffset, lat, lng } (없으면 null)
    getManual(p) {
      const m = st('SELECT taken_at, taken_offset, lat, lng FROM manual_values WHERE path = ?').get(p);
      return m ? { takenAt: m.taken_at, takenOffset: m.taken_offset, lat: m.lat, lng: m.lng } : null;
    },

    // 값 넣기 한 번 = 묶음 하나. 한 트랜잭션이라 중간에 오류가 나면 전부 되돌려져요 (같은 id를 또 넣어도 오류)
    //   items: [{ path, before: 바꾸기 전 직접 넣은 값|null, after: 넣을 값 }]
    applyManualBatch({ id, root, kind, createdAt, items }) {
      tx(() => {
        st('INSERT INTO edit_batches (id, root, kind, count, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, root, kind, items.length, createdAt);
        for (const it of items) {
          st('INSERT INTO edit_items (batch_id, path, before_json, after_json) VALUES (?, ?, ?, ?)')
            .run(id, it.path, JSON.stringify(nul(it.before)), JSON.stringify(it.after));
          writeManual(it.path, root, it.after);
        }
      });
    },

    // 묶음 되돌리기. 그 root의 마지막 묶음만 되돌릴 수 있어요 (같은 파일을 여러 묶음이 바꿨을 때 순서가 꼬이지 않게)
    undoBatch(id, undoneAt) {
      tx(() => {
        const b = st('SELECT root FROM edit_batches WHERE id = ?').get(id);
        const last = b ? lastBatchOf(b.root) : null;
        if (!last || last.id !== id) throw new Error('마지막 묶음만 되돌릴 수 있어요');
        for (const it of st('SELECT path, before_json FROM edit_items WHERE batch_id = ?').all(id)) {
          writeManual(it.path, b.root, JSON.parse(it.before_json));
        }
        st('UPDATE edit_batches SET undone_at = ? WHERE id = ?').run(undoneAt, id);
      });
    },

    // 이 root에서 되돌리지 않은 마지막 묶음 (없으면 null)
    lastBatch(root) {
      const b = lastBatchOf(root);
      return b ? { id: b.id, kind: b.kind, count: b.count, createdAt: b.created_at } : null;
    },

    // 묶음이 바꾼 파일별 "이전 상태 / 넣은 값" (로그용). 넣은 순서대로. 이전 상태가 없었으면 before는 null
    batchItems(id) {
      return st('SELECT path, before_json, after_json FROM edit_items WHERE batch_id = ? ORDER BY rowid').all(id)
        .map((r) => ({ path: r.path, before: JSON.parse(r.before_json), after: JSON.parse(r.after_json) }));
    },

    // 묶음 상태: none(없음) | applied(적용됨) | undone(되돌림)
    batchStatus(id) {
      const b = st('SELECT undone_at FROM edit_batches WHERE id = ?').get(id);
      if (!b) return 'none';
      return b.undone_at === null ? 'applied' : 'undone';
    },

    // id 여러 개의 전체 값 (태그 없음). 입력 순서대로, 없는 id와 겹치는 id는 건너뛰어요
    //   id 목록은 JSON 하나로 넘겨서 같은 SQL을 계속 써요 (2만 장이라도 변수 개수 제한에 안 걸림)
    getFilesByIds(ids) {
      if (!ids || !ids.length) return [];
      const byId = new Map();
      for (const r of st('SELECT * FROM files WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids))) {
        byId.set(r.id, fullRow(r));
      }
      const out = [];
      for (const id of ids) {
        const f = byId.get(id);
        if (f) {
          out.push(f);
          byId.delete(id);
        }
      }
      return out;
    },

    // 위치 제안 계산에 쓸 칸만 읽어요. 이 폴더의 파일 중 사라지지 않고 스크린샷이 아닌 것
    listSuggestionRows(root) {
      return st(`SELECT f.id, f.path, f.name, f.media_type, f.taken_at, f.taken_day, f.taken_at_source, f.lat, f.lng, f.location_source, f.model
        FROM files f WHERE f.root = ? AND f.missing = 0 AND ${NOT_SCREENSHOT_SQL}`).all(root, SCREENSHOT_TAG).map((r) => ({
        id: r.id,
        path: r.path,
        name: r.name,
        mediaType: r.media_type,
        takenAt: r.taken_at,
        takenDay: r.taken_day,
        takenAtSource: r.taken_at_source,
        lat: r.lat,
        lng: r.lng,
        locationSource: r.location_source,
        model: r.model,
      }));
    },

    close() {
      cache.clear();
      raw.close();
    },
  };
}

module.exports = { openDb, isCorruptionError, structureErrorOf, SCHEMA_VERSION };

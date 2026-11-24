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
const { isLivePair, LIVE_MAX_SEC } = require('./live-pair');
const { DatabaseSync } = require('node:sqlite');
const { stamp } = require('./logger');
const { parseQuery } = require('./search');
const { isTagKind, tidyTagName } = require('./manual-tags');

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
-- 비슷한 사진 흐림 점수 (2026-11-16). photo_hashes 와 같은 방식 (경로 + 크기 + 수정 시각이 files와 같을 때만 맞는 값)
--   blur: 0~1 (클수록 흐림, lib/similar.js blurOf), 만들 수 없었으면 NULL. light: 밝기 0~1 (추천 1장 고르기의 노출 비교). 언제든 다시 만들 수 있어서 구조 버전은 올리지 않아요
CREATE TABLE IF NOT EXISTS photo_blur (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  blur REAL,
  light REAL
);
-- PC 안 AI 특징값 (2026-11-16, lib/similar-ai.js). photo_hashes 와 같은 방식 (경로 + 크기 + 수정 시각이 files와 같을 때만)
--   model: 만든 모델 이름 (바뀌면 다시 만들어요). vec: 512바이트 (-127~127 정수), 만들 수 없었으면 NULL
--   언제든 다시 만들 수 있어서 구조 버전은 올리지 않아요. 나중에 사람 / 동물 / 풍경 자동 분류도 이 값을 써요
CREATE TABLE IF NOT EXISTS photo_embeds (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  model TEXT NOT NULL,
  vec BLOB
);
-- 영상 화면 데이터 지문 (2026-11-24, "같은 영상" 묶음). photo_hashes 와 같은 방식 (경로 + 크기 + 수정 시각이 files와 같을 때만)
--   hash: ffmpeg 로 화면 데이터만 읽은 sha256 (lib/tools.js videoStreamHash), 만들 수 없었으면 NULL
--   언제든 다시 만들 수 있어서 구조 버전은 올리지 않아요
CREATE TABLE IF NOT EXISTS video_hashes (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  hash TEXT
);
-- 장소 이름 (좌표 → 이름). 사용자가 "장소 이름 보기"를 눌러 받아 온 것만 있어요 (2026-11-04)
--   place_key: 소수점 3자리로 줄인 '위도,경도'. name: 받아 온 이름 ('' = 이름 없는 곳)
--   언제든 다시 받을 수 있는 값이라 구조 버전은 올리지 않아요 (photo_hashes와 같은 이유)
CREATE TABLE IF NOT EXISTS place_names (
  place_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  saved_at TEXT NOT NULL
);
-- 내가 붙인 태그 (단계 5). files와는 경로로 이어요 (다시 읽어도, DB를 새로 만들어도 기록 파일에서 되살려요)
--   files를 다시 읽을 때마다 여기 있는 태그를 file_tags에 source 'manual'로 다시 넣어요
--   구조 버전은 올리지 않아요 (옛 빌드가 새 버전 DB를 "깨짐"으로 보고 다시 만들지 않게. 옛 빌드는 이 표를 모르고 지나가요)
CREATE TABLE IF NOT EXISTS manual_tags (
  path TEXT NOT NULL,
  root TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (path, name)
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
-- 내가 만든 태그의 정의 (2026-11-18): 사진이 하나도 없는 빈 태그도 여기 남아요. hotkey = 갤러리 단축키 숫자(1~9, 없으면 NULL)
--   내가 붙인 태그(manual_tags)의 이름은 모두 여기에도 있어요 (붙일 때 같이 넣고, 켤 때 빠진 것을 채워요)
--   폴더를 다시 읽어도 안 건드려요. 구조 버전은 올리지 않아요 (옛 빌드는 이 표를 모르고 지나가요)
CREATE TABLE IF NOT EXISTS tag_names (
  root TEXT NOT NULL,
  name TEXT NOT NULL,
  hotkey INTEGER,
  PRIMARY KEY (root, name)
);
-- 묶음이 바꾼 태그 정의의 "이전 / 이후" (이름 바꾸기 · 지우기 · 새 이름으로 붙이기). 값은 null(없음) 또는 { hotkey }
CREATE TABLE IF NOT EXISTS edit_tag_defs (
  batch_id TEXT NOT NULL,
  name TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  PRIMARY KEY (batch_id, name)
);
-- 파일에 적힌 태그를 마지막으로 읽은(또는 쓴) 목록 (31 ②, 2026-11-24). file_json = 정렬한 이름 JSON 배열, NULL = 아직 모름
--   사진의 태그 목록(manual_tags)과 이 목록이 다르면 "파일에 쓰지 않은 태그"가 있는 사진이에요
--   파일을 다시 읽었을 때 이 목록과 달라졌으면, 다른 프로그램(탐색기 등)에서 바꾼 것만큼 태그 목록에도 반영해요
--   구조 버전은 올리지 않아요 (옛 빌드는 이 표를 모르고 지나가요)
CREATE TABLE IF NOT EXISTS tag_sync (
  path TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  file_json TEXT
);
`;
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_files_day ON files (root, missing, taken_day);
CREATE INDEX IF NOT EXISTS idx_files_type_day ON files (root, missing, media_type, taken_day);
CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags (tag_id);
CREATE INDEX IF NOT EXISTS idx_manual_tags_name ON manual_tags (root, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_names_key ON tag_names (root, hotkey) WHERE hotkey IS NOT NULL;
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
      WHERE ft.file_id = f.id AND ft.source IN ('album', 'manual') AND t.name = ?)`);
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
  // 지도에서 고른 곳 (단계 6): 지도 묶음의 칸들(rects)과 연도. 칸은 지도 계산(src/places-view.mjs)과 같은 경계 규칙이에요
  //   위도는 아래쪽 경계를 빼고 위쪽 경계를 넣고(s < lat <= n), 경도는 왼쪽을 넣고 오른쪽을 빼요(w <= lng < e) → 이웃 칸과 겹치지 않아요
  if (filter.area && Array.isArray(filter.area.rects) && filter.area.rects.length) {
    const ors = filter.area.rects.map(() => '(f.lat > ? AND f.lat <= ? AND f.lng >= ? AND f.lng < ?)');
    parts.push(`(${ors.join(' OR ')})`);
    for (const r of filter.area.rects) params.push(r.s, r.n, r.w, r.e);
    if (filter.area.year) {
      parts.push('f.taken_day LIKE ?');
      params.push(`${filter.area.year}-%`);
    }
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
      raw.prepare('SELECT path, size, mtime_ms, blur FROM photo_blur LIMIT 0').all();
      raw.prepare('SELECT path, size, mtime_ms, model, vec FROM photo_embeds LIMIT 0').all();
      raw.prepare('SELECT path, size, mtime_ms, hash FROM video_hashes LIMIT 0').all();
      // 밝기 칸이 없는 표(만들던 중의 빌드)면 칸만 더해요 (지우지 않아요)
      if (!raw.prepare('PRAGMA table_info(photo_blur)').all().some((c) => c.name === 'light')) raw.exec('ALTER TABLE photo_blur ADD COLUMN light REAL');
      raw.prepare('SELECT place_key, name, saved_at FROM place_names LIMIT 0').all();
      raw.prepare('SELECT path, root, name FROM manual_tags LIMIT 0').all();
      raw.prepare('SELECT root, name, hotkey FROM tag_names LIMIT 0').all();
      raw.prepare('SELECT batch_id, name, before_json, after_json FROM edit_tag_defs LIMIT 0').all();
      raw.prepare('SELECT path, root, file_json FROM tag_sync LIMIT 0').all();
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

  // ---------- 내가 붙인 태그 (manual_tags) ----------
  // 태그 이름 → tags 표 번호 (없으면 만들어요)
  const tagIdOf = (name) => {
    st('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
    return st('SELECT id FROM tags WHERE name = ?').get(name).id;
  };
  // manual_tags 에 있는 태그를 그 경로의 file_tags 에 source 'manual'로 다시 넣어요 (files 줄이 없으면 아무것도 안 해요)
  //   같은 이름의 앨범 태그가 이미 있으면 앨범 태그로 남겨요 (떼어도 앨범 태그는 그대로)
  function syncManualTags(p) {
    const f = st('SELECT id FROM files WHERE path = ?').get(p);
    if (!f) return;
    st("DELETE FROM file_tags WHERE file_id = ? AND source = 'manual'").run(f.id);
    for (const t of st('SELECT name FROM manual_tags WHERE path = ?').all(p)) {
      st("INSERT OR IGNORE INTO file_tags (file_id, tag_id, source) VALUES (?, ?, 'manual')").run(f.id, tagIdOf(t.name));
    }
  }
  // 한 경로의 내가 붙인 태그를 names 목록으로 통째로 바꿔요. 반드시 tx 안에서 불러요
  //   붙인 이름은 태그 정의(tag_names)에도 넣어요 (사진에서 다 떼도 목록에 남게)
  function writeManualTags(p, root, names) {
    st('DELETE FROM manual_tags WHERE path = ?').run(p);
    for (const name of names || []) {
      st('INSERT OR IGNORE INTO manual_tags (path, root, name) VALUES (?, ?, ?)').run(p, root, name);
      st('INSERT OR IGNORE INTO tag_names (root, name) VALUES (?, ?)').run(root, name);
    }
    syncManualTags(p);
  }
  // 태그 정의 하나를 value 로 맞춰요. 반드시 tx 안에서 불러요
  //   value null = 정의를 지워요. 단, 아직 그 이름이 붙은 사진이 있으면 지우지 않아요 (붙은 태그가 목록에서 사라지지 않게)
  //   value { hotkey } = 정의를 만들거나 단축키를 바꿔요. 그 숫자를 다른 태그가 쓰고 있으면 이 태그는 숫자 없이 둬요
  function writeTagDef(root, name, value) {
    if (value === null) {
      if (st('SELECT 1 AS x FROM manual_tags WHERE root = ? AND name = ? LIMIT 1').get(root, name)) return;
      st('DELETE FROM tag_names WHERE root = ? AND name = ?').run(root, name);
      return;
    }
    st('INSERT OR IGNORE INTO tag_names (root, name) VALUES (?, ?)').run(root, name);
    const key = value.hotkey === undefined ? null : value.hotkey;
    const taken = key === null ? null : st('SELECT name FROM tag_names WHERE root = ? AND hotkey = ?').get(root, key);
    st('UPDATE tag_names SET hotkey = ? WHERE root = ? AND name = ?').run(taken && taken.name !== name ? null : key, root, name);
  }
  // 정의 여러 개: 지우는 것부터 (이름 바꾸기에서 옛 이름의 숫자를 새 이름으로 옮길 때 겹치지 않게)
  //   값을 넣을 이름들의 숫자는 먼저 모두 비우고 넣어요 (합치기를 되돌릴 때, 숫자를 돌려받을 태그보다 아직 그 숫자를 쥔 태그가
  //   뒤에 있어도 숫자가 사라지지 않게 — #122 검증 ❌)
  const writeTagDefs = (root, defs, pick) => {
    const list = (defs || []).map((d) => ({ name: d.name, value: pick(d) }));
    const sets = list.filter((x) => x.value !== null);
    for (const d of list.filter((x) => x.value === null)) writeTagDef(root, d.name, null);
    for (const d of sets) st('UPDATE tag_names SET hotkey = NULL WHERE root = ? AND name = ?').run(root, d.name);
    for (const d of sets) writeTagDef(root, d.name, d.value);
  };
  const tagDefOf = (root, name) => {
    const r = st('SELECT name, hotkey FROM tag_names WHERE root = ? AND name = ?').get(root, name);
    return r ? { name: r.name, hotkey: r.hotkey } : null;
  };
  // ---------- 파일에 적힌 태그와 맞추기 (31 ②) ----------
  const parseList = (j) => {
    try {
      const v = JSON.parse(j);
      return Array.isArray(v) ? v.map(String) : null;
    } catch (e) {
      return null;
    }
  };
  const sortedUnique = (list) => [...new Set(list)].sort();
  const sameSet = (a, b) => {
    const x = sortedUnique(a);
    const y = sortedUnique(b);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  };
  const manualListOf = (p) => st('SELECT name FROM manual_tags WHERE path = ? ORDER BY name').all(p).map((r) => r.name);
  // 파일에 적힌 태그를 마지막으로 읽은 목록 (모르면 null)
  const fileBaseOf = (p) => {
    const r = st('SELECT file_json FROM tag_sync WHERE path = ?').get(p);
    return r && r.file_json != null ? parseList(r.file_json) : null;
  };
  const setFileBase = (p, root, list) => {
    st(`INSERT INTO tag_sync (path, root, file_json) VALUES (?, ?, ?)
      ON CONFLICT (path) DO UPDATE SET root = excluded.root, file_json = excluded.file_json`)
      .run(p, root, list == null ? null : JSON.stringify(sortedUnique(list)));
  };
  // 파일에서 바뀐 만큼만 목록에 반영해요 (세 갈래 합치기)
  //   base(지난번 파일 태그)가 없으면: 목록 ∪ 지금 파일 태그 (옛 빌드에서 붙인 태그 + 파일 태그, 아무것도 잃지 않게)
  //   있으면: 파일에서 새로 생긴 태그는 더하고, 파일에서 없어진 태그는 빼요. 앱에서만 바꾼 것(아직 안 씀)은 그대로 둬요
  function mergeFileChange(list, base, fileNow) {
    const out = new Set(list);
    if (base == null) {
      for (const n of fileNow) out.add(n);
    } else {
      for (const n of fileNow) if (!base.includes(n)) out.add(n);
      for (const n of base) if (!fileNow.includes(n)) out.delete(n);
    }
    return [...out].sort();
  }
  // 지금 파일 태그(fileNow)를 받아 그 경로의 태그 목록을 맞추고, 되돌리기 기록(태그 묶음의 전후 목록)에도 같은 변화를 넣어요
  //   (되돌렸을 때 다른 프로그램에서 더한 태그까지 사라지지 않게). 반드시 tx 안에서 불러요. 목록을 바꿨으면 true
  function adoptFileTags(p, root, fileNow) {
    const base = fileBaseOf(p);
    const list = manualListOf(p);
    const next = mergeFileChange(list, base, fileNow);
    let changed = false;
    if (!sameSet(next, list)) {
      writeManualTags(p, root, next);
      changed = true;
    }
    if (base == null || !sameSet(base, fileNow)) {
      for (const it of st(`SELECT i.batch_id AS id, b.kind AS kind, i.before_json AS b, i.after_json AS a FROM edit_items i
        JOIN edit_batches b ON b.id = i.batch_id WHERE i.path = ? AND b.undone_at IS NULL`).all(p)) {
        if (!isTagKind(it.kind)) continue;
        const before = mergeFileChange(parseList(it.b) || [], base, fileNow);
        const after = mergeFileChange(parseList(it.a) || [], base, fileNow);
        st('UPDATE edit_items SET before_json = ?, after_json = ? WHERE batch_id = ? AND path = ?')
          .run(JSON.stringify(before), JSON.stringify(after), it.id, p);
      }
    }
    setFileBase(p, root, fileNow);
    return changed;
  }

  // 묶음 종류에 맞게 값 쓰기 (태그 묶음이면 태그 목록, 아니면 직접 넣은 날짜·위치)
  const writeItem = (kind, p, root, value) => (isTagKind(kind) ? writeManualTags(p, root, value) : writeManual(p, root, value));

  // 라이브 포토 짝 영상 후보: 그날 찍은 짧은 영상을 한 번에 읽어 이름(확장자 뺀 경로)으로 모아요 (lib/live-pair.js 규칙)
  //   사진마다 따로 찾으면 6만 장에서 몇 초씩 걸려요. 날짜 없는 사진은 찍은 시각을 몰라 짝이 될 수 없어서 읽지 않아요
  const stemOf = (p) => p.slice(0, p.length - path.extname(p).length);
  const liveVideosOf = (root, day) => {
    const map = new Map();
    if (day === null || day === undefined) return map;
    const rows = st(`SELECT path, taken_at, duration_sec FROM files
      WHERE root = ? AND missing = 0 AND media_type = 'video' AND taken_day = ? AND duration_sec > 0 AND duration_sec <= ?`).all(root, day, LIVE_MAX_SEC);
    for (const v of rows) {
      const k = stemOf(v.path);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ path: v.path, takenAt: v.taken_at, durationSec: v.duration_sec });
    }
    return map;
  };

  // 이 root에서 되돌리지 않은 마지막 묶음 (만든 시각이 늦은 것, 같으면 rowid가 큰 것)
  //   rowid만 보면, 켤 때 늦게 복구한 옛 묶음이 사용자의 마지막 묶음보다 뒤로 와서 되돌리기 대상이 바뀌어요

  //   created_at은 ISO 시각(UTC) 글자라 글자 순서 = 시간 순서예요
  const lastBatchOf = (root) => st(`SELECT id, kind, count, created_at FROM edit_batches
    WHERE root = ? AND undone_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(root);

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
          // 태그 (31 ②): 종류 태그(사진 · 비디오 · 스크린샷)만 파일에서 읽은 그대로 넣고,
          //   나머지 태그는 파일에서 바뀐 만큼 태그 목록(manual_tags)에 반영한 뒤 목록을 source 'manual'로 넣어요
          //   읽기에 실패한 파일은 파일 태그를 모르는 것이라 목록을 건드리지 않아요
          st('DELETE FROM file_tags WHERE file_id = ?').run(id);
          const fileNow = [];
          for (const t of r.tags || []) {
            if (t.source === 'mediaType') st('INSERT OR REPLACE INTO file_tags (file_id, tag_id, source) VALUES (?, ?, ?)').run(id, tagIdOf(t.name), t.source);
            else if (t.name) fileNow.push(t.name);
          }
          if (!r.readError) adoptFileTags(r.path, r.root, sortedUnique(fileNow));
          syncManualTags(r.path);
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
    // 지문이나 흐림 점수를 아직 안 만든 사진 (이 root, 사라진 것 제외, 파일이 바뀌었으면 다시) → 전체 값 한 줄씩, 오래된 id부터
    //   + needHash, needBlur: 어느 쪽이 없는지
    //   afterId: 이 번호 다음부터 (한 회차 안에서 앞으로만 나아가요. 못 만든 사진을 다시 읽느라 느려지지 않게)
    //   readyOnly: 참이면 썸네일이 이미 있는 사진만 (뒤에서 미리 계산할 때)
    hashJobs(root, limit, afterId = 0, { readyOnly = false } = {}) {
      return st(`SELECT f.*, h.path IS NULL AS need_hash, b.path IS NULL AS need_blur FROM files f
        LEFT JOIN photo_hashes h ON h.path = f.path AND h.size = f.size AND h.mtime_ms = f.mtime_ms
        LEFT JOIN photo_blur b ON b.path = f.path AND b.size = f.size AND b.mtime_ms = f.mtime_ms
        WHERE f.root = ? AND f.missing = 0 AND f.media_type = 'photo' AND (h.path IS NULL OR b.path IS NULL) AND f.id > ?
          ${readyOnly ? "AND f.thumb_state = 'ready'" : ''}
        ORDER BY f.id LIMIT ?`).all(root, afterId, limit).map((r) => ({ ...fullRow(r), needHash: !!r.need_hash, needBlur: !!r.need_blur }));
    },

    // 지문 저장 (만들 수 없었으면 dhash null → 다시 시도하지 않아요. 파일이 바뀌면 다시)
    setHash(p, size, mtimeMs, dhash) {
      st('INSERT OR REPLACE INTO photo_hashes (path, size, mtime_ms, dhash) VALUES (?, ?, ?, ?)').run(p, size, mtimeMs, nul(dhash));
    },

    // 흐림 점수 저장 (만들 수 없었으면 null → 다시 시도하지 않아요. 파일이 바뀌면 다시)
    setBlur(p, size, mtimeMs, blur, light = null) {
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      st('INSERT OR REPLACE INTO photo_blur (path, size, mtime_ms, blur, light) VALUES (?, ?, ?, ?, ?)').run(p, size, mtimeMs, num(blur), num(light));
    },

    // 지문 진행: 이 root의 보이는 사진 수와 지문 · 흐림 점수를 둘 다 끝낸(실패 포함) 수
    hashProgress(root) {
      return st(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN h.path IS NULL OR b.path IS NULL THEN 0 ELSE 1 END), 0) AS done
        FROM files f LEFT JOIN photo_hashes h ON h.path = f.path AND h.size = f.size AND h.mtime_ms = f.mtime_ms
        LEFT JOIN photo_blur b ON b.path = f.path AND b.size = f.size AND b.mtime_ms = f.mtime_ms
        WHERE f.root = ? AND f.missing = 0 AND f.media_type = 'photo'`).get(root);
    },

    // 묶기에 쓰는 줄: 이 root의 보이는 사진 → [{ id, path, name, takenAt, takenAtSource, width, height, size, model, dhash, blur, light, vec, embedModel }]
    //   지문 · 흐림 점수 · 밝기 · AI 특징값(vec, Uint8Array, 복사하지 않아요)이 없거나(아직, 실패) 파일이 바뀐 뒤면 null. path는 main 안에서만 써요 (화면에 주지 않아요)
    //   화면 목록과 버리기 확인(lib/similar-discard.js)이 같은 줄을 써서 묶음이 같아요
    similarRows(root) {
      return st(`SELECT f.id, f.path, f.name, f.taken_at, f.taken_at_source, f.width, f.height, f.size, f.model, h.dhash, b.blur, b.light, e.vec, e.model AS embed_model
        FROM files f LEFT JOIN photo_hashes h ON h.path = f.path AND h.size = f.size AND h.mtime_ms = f.mtime_ms
        LEFT JOIN photo_blur b ON b.path = f.path AND b.size = f.size AND b.mtime_ms = f.mtime_ms
        LEFT JOIN photo_embeds e ON e.path = f.path AND e.size = f.size AND e.mtime_ms = f.mtime_ms
        WHERE f.root = ? AND f.missing = 0 AND f.media_type = 'photo' ORDER BY f.id`).all(root)
        .map((r) => ({ id: r.id, path: r.path, name: r.name, takenAt: r.taken_at, takenAtSource: r.taken_at_source, width: r.width, height: r.height, size: r.size, model: r.model, dhash: r.dhash, blur: r.blur, light: r.light, vec: r.vec || null, embedModel: r.vec ? r.embed_model : null }));
    },

    // ---------- 같은 영상 (화면 데이터 지문) ----------
    // 이 root의 보이는 영상 → [{ id, path, name, size, mtimeMs, width, height, takenAt, lat, lng, own, tagKey, vhash, vhashDone }]
    //   vhash: 지문 (아직 / 실패 / 파일이 바뀐 뒤면 null). vhashDone: 이 파일 그대로 지문을 계산해 봤는지 (실패 포함)
    //   own: 직접 넣은 값(manual_values)이나 직접 붙인 태그(manual_tags)가 있음
    //   ownKey: 그 값 · 태그를 이은 것 → 남길 영상과 다르면 버리지 않아요 (그 값이 없어지지 않게)
    //     같으면 버려도 돼요: 파일 안에 원래 있던 태그는 폴더를 읽을 때 manual_tags 로 들어가서, 두 번 저장된 영상은 둘 다 같은 값을 가져요
    //   tagKey: 붙은 태그 이름을 가나다순으로 이은 것 (남길 영상과 다르면 버리지 않아요)
    //   path는 main 안에서만 써요 (화면에 주지 않아요). 화면 목록과 옮기기 확인(lib/same-video.js)이 같은 줄을 써요
    videoRows(root) {
      return st(`SELECT f.id, f.path, f.name, f.size, f.mtime_ms, f.width, f.height, f.taken_at, f.lat, f.lng, v.path AS v_path, v.hash,
          (SELECT coalesce(mv.taken_at, '') || '|' || coalesce(mv.taken_offset, '') || '|' || coalesce(mv.lat, '') || '|' || coalesce(mv.lng, '') FROM manual_values mv WHERE mv.path = f.path) AS own_val,
          (SELECT group_concat(mt.name, char(10)) FROM manual_tags mt WHERE mt.path = f.path) AS own_tags,
          (SELECT group_concat(t.name, char(10)) FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id) AS tag_names
        FROM files f LEFT JOIN video_hashes v ON v.path = f.path AND v.size = f.size AND v.mtime_ms = f.mtime_ms
        WHERE f.root = ? AND f.missing = 0 AND f.media_type = 'video' ORDER BY f.id`).all(root)
        .map((r) => ({
          id: r.id, path: r.path, name: r.name, size: r.size, mtimeMs: r.mtime_ms, width: r.width, height: r.height,
          takenAt: r.taken_at, lat: r.lat, lng: r.lng, own: r.own_val != null || r.own_tags != null,
          ownKey: r.own_val != null || r.own_tags != null ? `${r.own_val || ''}\n#${r.own_tags ? String(r.own_tags).split('\n').sort().join('\n') : ''}` : '',
          tagKey: r.tag_names ? String(r.tag_names).split('\n').sort().join('\n') : '',
          vhash: r.hash || null, vhashDone: r.v_path != null,
        }));
    },

    // 영상 지문 저장 (만들 수 없었으면 hash null → 파일이 바뀔 때까지 다시 시도하지 않아요)
    setVideoHash(p, size, mtimeMs, hash) {
      st('INSERT OR REPLACE INTO video_hashes (path, size, mtime_ms, hash) VALUES (?, ?, ?, ?)').run(p, size, mtimeMs, typeof hash === 'string' && hash ? hash : null);
    },

    // ---------- PC 안 AI 특징값 ----------
    // 특징값을 아직 안 만든 사진 (이 root, 사라진 것 제외, 파일이나 모델이 바뀌었으면 다시) → 전체 값 한 줄씩, 오래된 id부터
    //   readyOnly: 참이면 썸네일이 이미 있는 사진만
    embedJobs(root, limit, afterId, model, { readyOnly = false } = {}) {
      return st(`SELECT f.* FROM files f
        LEFT JOIN photo_embeds e ON e.path = f.path AND e.size = f.size AND e.mtime_ms = f.mtime_ms AND e.model = ?
        WHERE f.root = ? AND f.missing = 0 AND f.media_type = 'photo' AND e.path IS NULL AND f.id > ?
          ${readyOnly ? "AND f.thumb_state = 'ready'" : ''}
        ORDER BY f.id LIMIT ?`).all(model, root, afterId, limit).map(fullRow);
    },

    // 특징값 저장 (만들 수 없었으면 vec null → 다시 시도하지 않아요. 파일이 바뀌면 다시)
    setEmbed(p, size, mtimeMs, model, vec) {
      st('INSERT OR REPLACE INTO photo_embeds (path, size, mtime_ms, model, vec) VALUES (?, ?, ?, ?, ?)').run(p, size, mtimeMs, model, vec && vec.length ? vec : null);
    },

    // 특징값 진행: 이 root의 보이는 사진 수와 이 모델로 끝낸(실패 포함) 수
    embedProgress(root, model) {
      return st(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN e.path IS NULL THEN 0 ELSE 1 END), 0) AS done
        FROM files f LEFT JOIN photo_embeds e ON e.path = f.path AND e.size = f.size AND e.mtime_ms = f.mtime_ms AND e.model = ?
        WHERE f.root = ? AND f.missing = 0 AND f.media_type = 'photo'`).get(model, root);
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
      const sql = `SELECT f.id, f.path, f.name, f.media_type, f.taken_at, f.duration_sec, f.thumb_state, f.mtime_ms FROM files f
        WHERE ${where} AND ${dayCond} ORDER BY ${order}`;
      const videos = liveVideosOf(root, day);
      return st(sql).all(...params, ...dayParams).map((r) => ({
        id: r.id,
        name: r.name,
        mediaType: r.media_type,
        durationSec: r.duration_sec,
        thumbState: r.thumb_state,
        // 파일이 바뀐 시각 (돌리기 뒤 썸네일을 새로 받게 주소에 붙여요, 2026-11-23)
        mtimeMs: r.mtime_ms,
        // 갤러리 "라이브" 표시 (경로는 화면에 주지 않아요)
        live: r.media_type === 'photo' && (videos.get(stemOf(r.path)) || []).some((v) => isLivePair({ path: r.path, takenAt: r.taken_at }, v)),
      }));
    },

    // 조건에 맞는 파일 id 전체 (목록 전체 선택용). 순서는 listDays 순서대로 날짜마다 listFiles 순서와 같아요
    // 지도 핀용 위치 목록 (단계 6): 위치가 있는 사진과 영상, 사라진 파일 제외 → [id, 위도, 경도, 찍은 날] (경로는 주지 않아요)
    //   6만 장이면 6만 줄이라 객체 대신 짧은 배열로 보내요
    mapPoints(root) {
      return st(`SELECT id, lat, lng, taken_day FROM files
        WHERE root = ? AND missing = 0 AND lat IS NOT NULL AND lng IS NOT NULL`).all(root)
        .map((r) => [r.id, r.lat, r.lng, r.taken_day]);
    },

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
      const mine = new Set(st('SELECT name FROM manual_tags WHERE path = ?').all(r.path).map((m) => m.name));
      const tags = st(`SELECT t.name AS name, ft.source AS source FROM file_tags ft
        JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = ? ORDER BY t.name`).all(id)
        .map((t) => ({ name: t.name, source: t.source, mine: mine.has(t.name) })); // mine: 내가 붙인 태그 (앨범 태그와 이름이 같아도)
      return { ...fullRow(r), tags };
    },

    // 사이드바용 요약: 전체 개수, 날짜 없음, 위치 없음(스크린샷 제외), 정보 없음 합계, 직접 넣은 수, 앨범 태그와 내가 붙인 태그(많은 순)
    //   tagCount: 태그 이름 수 (파일에서 읽은 태그도 내 태그에 합쳐져요, 31 ②)
    summary(root) {
      const total = st('SELECT COUNT(*) AS n FROM files WHERE root = ? AND missing = 0').get(root).n;
      const noDate = st('SELECT COUNT(*) AS n FROM files WHERE root = ? AND missing = 0 AND taken_day IS NULL').get(root).n;
      const info = st(`SELECT
          COALESCE(SUM(CASE WHEN ${NO_LOCATION_SQL} THEN 1 ELSE 0 END), 0) AS no_location,
          COALESCE(SUM(CASE WHEN ${NO_INFO_SQL} THEN 1 ELSE 0 END), 0) AS no_info,
          COALESCE(SUM(CASE WHEN ${MANUAL_SQL} THEN 1 ELSE 0 END), 0) AS manual_count
        FROM files f WHERE f.root = ? AND f.missing = 0`).get(SCREENSHOT_TAG, SCREENSHOT_TAG, root);
      // 앨범 태그 묶음은 31 ② 부터 없어요: 파일에 적힌 태그도 모두 태그 목록(manual_tags)에 들어가 고칠 수 있어요
      const tags = [];
      // 태그 장수는 manual_tags 로 세요
      //   사진이 없는 빈 태그(tag_names 에만 있음)도 0장으로 넣어요. hotkey = 단축키 숫자 (없으면 null)
      const counts = new Map(st(`SELECT m.name AS name, COUNT(*) AS count FROM manual_tags m
        JOIN files f ON f.path = m.path
        WHERE f.root = ? AND f.missing = 0
        GROUP BY m.name`).all(root).map((t) => [t.name, t.count]));
      const keys = new Map(st('SELECT name, hotkey FROM tag_names WHERE root = ?').all(root).map((t) => [t.name, t.hotkey]));
      const manualTags = [...new Set([...keys.keys(), ...counts.keys()])]
        .map((name) => ({ name, count: counts.get(name) || 0, hotkey: keys.get(name) ?? null }))
        .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const tagCount = new Set([...tags, ...manualTags].map((t) => t.name)).size;
      return {
        total, noDate, noLocation: info.no_location, noInfo: info.no_info, manualCount: info.manual_count,
        tagCount, tags, manualTags,
      };
    },

    // ---------- 장소 이름 ----------
    // 저장해 둔 이름 (없으면 null, 이름 없는 곳이면 '')
    getPlaceName(key) {
      const r = st('SELECT name FROM place_names WHERE place_key = ?').get(key);
      return r ? r.name : null;
    },
    setPlaceName(key, name, at) {
      st('INSERT OR REPLACE INTO place_names (place_key, name, saved_at) VALUES (?, ?, ?)').run(key, name, at);
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
      // 썸네일을 다시 만들면 지문도 다시 만들 수 있게, 이 폴더의 "지문 없음" 기록도 지워요
      st('DELETE FROM photo_hashes WHERE dhash IS NULL AND path IN (SELECT path FROM files WHERE root = ?)').run(root);
      st('DELETE FROM photo_blur WHERE blur IS NULL AND path IN (SELECT path FROM files WHERE root = ?)').run(root);
      st('DELETE FROM photo_embeds WHERE vec IS NULL AND path IN (SELECT path FROM files WHERE root = ?)').run(root);
      st('DELETE FROM video_hashes WHERE hash IS NULL AND path IN (SELECT path FROM files WHERE root = ?)').run(root);

    },

    // ---------- 직접 넣은 값 ----------
    // 직접 넣은 값 한 개 → { takenAt, takenOffset, lat, lng } (없으면 null)
    getManual(p) {
      const m = st('SELECT taken_at, taken_offset, lat, lng FROM manual_values WHERE path = ?').get(p);
      return m ? { takenAt: m.taken_at, takenOffset: m.taken_offset, lat: m.lat, lng: m.lng } : null;
    },

    // 켤 때 한 번: manual_tags 와 file_tags 를 다시 맞춰요
    //   옛 빌드로 켠 사이에 다시 읽은 파일은 file_tags 의 manual 줄이 지워져 있어서 (옛 빌드는 manual_tags 를 몰라요)
    //   → 빠진 줄만 넣어요. 바꾼 줄 수를 돌려줘요
    resyncManualTags() {
      return tx(() => {
        let n = 0;
        for (const m of st(`SELECT m.name AS name, f.id AS id FROM manual_tags m JOIN files f ON f.path = m.path
          WHERE NOT EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id AND t.name = m.name)`).all()) {
          st("INSERT OR IGNORE INTO file_tags (file_id, tag_id, source) VALUES (?, ?, 'manual')").run(m.id, tagIdOf(m.name));
          n++;
        }
        return n;
      });
    },

    // 켤 때 한 번: 띄어쓰기 글자만 다른 태그를 하나로 합쳐요 ("Prague 1"의 칸이 U+00A0인 것 → 보통 칸)
    //   이 빌드부터 새로 읽는 앨범 태그는 맞춰서 저장하지만, 전에 읽어 둔 파일(바뀌지 않아 다시 안 읽음)의 태그 줄은 그대로라서요
    //   옛 빌드가 다시 갈라 놓아도 다음에 켤 때 또 합쳐요. 합친 태그 수를 돌려줘요
    mergeSpacedTags() {
      return tx(() => {
        let n = 0;
        for (const t of st('SELECT id, name FROM tags').all()) {
          const clean = tidyTagName(t.name);
          if (!clean || clean === t.name) continue;
          const to = tagIdOf(clean);
          // 같은 사진에 두 이름이 다 있으면 줄은 하나만 남기고, 파일에서 읽은 태그(앨범 등)가 내가 붙인 태그(manual)를 이겨요
          //   upsertFiles 와 같은 규칙: manual 줄로 남으면 내 태그를 뗄 때 앨범 태그까지 사라지고 앨범 장수에서도 빠져요
          //   (WHERE true 는 SELECT 뒤 ON CONFLICT 를 SQLite 가 헷갈리지 않게 붙이는 것)
          st(`INSERT INTO file_tags (file_id, tag_id, source) SELECT file_id, ?, source FROM file_tags WHERE tag_id = ? AND true
            ON CONFLICT (file_id, tag_id) DO UPDATE SET source = excluded.source
            WHERE file_tags.source = 'manual' AND excluded.source <> 'manual'`).run(to, t.id);
          st('DELETE FROM file_tags WHERE tag_id = ?').run(t.id);
          st('DELETE FROM tags WHERE id = ?').run(t.id);
          n++;
        }
        return n;
      });
    },

    // ---------- 파일에 태그 쓰기 (31 ②) ----------
    // 켤 때 한 번: 옛 방식의 "앨범 태그" 줄(source 'album')을 태그 목록으로 옮겨요. 목록이 바뀐 사진 수를 돌려줘요
    //   이 빌드를 처음 켤 때 = 지금까지 읽은 파일 태그가 모두 태그 목록에 들어가요
    //   옛 빌드로 켠 사이에 다시 읽은 파일도 여기서 바뀐 만큼 반영해요
    //   마지막에, 읽은 파일 중 태그 기록이 없는 것은 "파일에 태그 없음" 으로 적어요 (읽기 실패 파일은 모름으로 둬요)
    adoptOldFileTags() {
      return tx(() => {
        let n = 0;
        const rows = st(`SELECT f.id AS id, f.path AS path, f.root AS root, json_group_array(t.name) AS names FROM file_tags ft
          JOIN tags t ON t.id = ft.tag_id JOIN files f ON f.id = ft.file_id
          WHERE ft.source = 'album' GROUP BY f.id`).all();
        for (const r of rows) {
          const names = sortedUnique((parseList(r.names) || []).map((x) => tidyTagName(x)).filter(Boolean));
          if (adoptFileTags(r.path, r.root, names)) n++;
          st("DELETE FROM file_tags WHERE file_id = ? AND source = 'album'").run(r.id);
          syncManualTags(r.path);
        }
        st("INSERT OR IGNORE INTO tag_sync (path, root, file_json) SELECT path, root, '[]' FROM files WHERE read_error IS NULL").run();
        return n;
      });
    },
    // 파일에 쓰지 않은 태그가 있는 사진인지 (앱의 목록과 파일에 적힌 목록이 다름)
    //   옮기면 경로에 묶인 목록을 잃어서, 날짜없음 채우기가 옮기지 않게 지켜요
    tagsPending(p) {
      return !sameSet(manualListOf(p), fileBaseOf(p) || []);
    },
    // 지금 파일 태그를 받아 목록을 맞추고 맞춘 목록을 돌려줘요 (쓰기 직전, 파일을 다시 읽은 결과로)
    adoptFileTagsNow(p, root, fileNow) {
      return tx(() => {
        adoptFileTags(p, root, sortedUnique(fileNow));
        return manualListOf(p);
      });
    },
    // 파일에 쓰지 않은 태그가 있는 사진 (이 폴더, 사라진 것 · 읽기 실패 제외) → [{ id, path, size, mtimeMs, list, base }]
    //   list: 앱의 태그 목록, base: 파일에 적힌 목록(모르면 null → 빈 목록으로 봐요)
    tagWritePending(root) {
      const rows = st(`SELECT f.id AS id, f.path AS path, f.size AS size, f.mtime_ms AS mtime_ms, s.file_json AS base,
          (SELECT json_group_array(name) FROM (SELECT name FROM manual_tags m WHERE m.path = f.path ORDER BY name)) AS list
        FROM files f LEFT JOIN tag_sync s ON s.path = f.path
        WHERE f.root = ? AND f.missing = 0 AND f.read_error IS NULL
          AND (EXISTS (SELECT 1 FROM manual_tags m WHERE m.path = f.path) OR (s.file_json IS NOT NULL AND s.file_json <> '[]'))
        ORDER BY f.path`).all(root);
      const out = [];
      for (const r of rows) {
        const list = parseList(r.list) || [];
        const base = r.base == null ? null : parseList(r.base);
        if (!sameSet(list, base || [])) out.push({ id: r.id, path: r.path, size: r.size, mtimeMs: r.mtime_ms, list, base });
      }
      return out;
    },
    // 파일에 쓴 뒤: 파일 태그 = 쓴 목록으로 적고, 파일 크기 · 수정 시각을 새 값으로 (다음에 폴더를 읽을 때 다시 읽지 않게)
    //   지문 · 흐림 · 특징 값도 크기만 바뀐 것이라 그대로 이어 써요 (그림은 그대로라서 다시 계산하지 않게)
    markTagsWritten(p, written, stat) {
      tx(() => {
        const f = st('SELECT root, size, mtime_ms FROM files WHERE path = ?').get(p);
        if (!f) return;
        setFileBase(p, f.root, written);
        if (!stat) return;
        st('UPDATE files SET size = ?, mtime_ms = ? WHERE path = ?').run(stat.size, stat.mtimeMs, p);
        for (const t of ['photo_hashes', 'photo_blur', 'photo_embeds', 'video_hashes']) {
          st(`UPDATE ${t} SET size = ?, mtime_ms = ? WHERE path = ? AND size = ? AND mtime_ms = ?`).run(stat.size, stat.mtimeMs, p, f.size, f.mtime_ms);
        }
      });
    },

    // 한 사진에 내가 붙인 태그 이름 목록 (이름 순)
    getManualTags(p) {
      return st('SELECT name FROM manual_tags WHERE path = ? ORDER BY name').all(p).map((r) => r.name);
    },

    // 복사본에도 직접 넣은 날짜 · 위치와 내가 붙인 태그를 같이 붙여요 (돌린 복사본, 2026-11-23)
    //   to 의 files 줄이 아직 없어도 돼요: 나중에 다시 읽을 때 upsertFiles 가 채워요
    copyManual(from, to, root) {
      //   새 이름에 예전 파일의 값 · 태그가 남아 있었으면 원본 것으로 갈아 끼워요 (원본에 없으면 지워요, #138 검증 ⚠️)
      tx(() => {
        const m = st('SELECT taken_at, taken_offset, lat, lng FROM manual_values WHERE path = ?').get(from);
        writeManual(to, root, m ? { takenAt: m.taken_at, takenOffset: m.taken_offset, lat: m.lat, lng: m.lng } : null);
        const names = st('SELECT name FROM manual_tags WHERE path = ? ORDER BY name').all(from).map((r) => r.name);
        writeManualTags(to, root, names);
        // 새 파일에 적힌 태그는 아직 몰라요 → 처음 읽을 때 목록과 합쳐요 (31 ②)
        st('DELETE FROM tag_sync WHERE path = ?').run(to);
      });
    },

    // 고른 사진들에 내가 붙인 태그와 장수 (떼기 창의 목록). 사라진 사진과 다른 폴더 사진은 빼요
    manualTagsOf(ids, root) {
      if (!ids || !ids.length) return [];
      return st(`SELECT m.name AS name, COUNT(*) AS count FROM manual_tags m JOIN files f ON f.path = m.path
        WHERE f.id IN (SELECT value FROM json_each(?)) AND f.root = ? AND f.missing = 0
        GROUP BY m.name ORDER BY count DESC, m.name`).all(JSON.stringify(ids), root)
        .map((r) => ({ name: r.name, count: r.count }));
    },

    // 값 넣기 한 번 = 묶음 하나. 한 트랜잭션이라 중간에 오류가 나면 전부 되돌려져요 (같은 id를 또 넣어도 오류)
    //   items: [{ path, before: 바꾸기 전 직접 넣은 값|null, after: 넣을 값 }]
    //   태그 묶음(tagAdd, tagRemove, tagRename, tagDelete)이면 before, after 는 그 사진에 내가 붙인 태그 이름 목록이에요
    //   defs: 태그 정의의 전후 [{ name, before, after }] (태그 묶음만, 없으면 빈 목록). 사진 값을 먼저 쓰고 정의를 맞춰요
    applyManualBatch({ id, root, kind, createdAt, items, defs }) {
      tx(() => {
        st('INSERT INTO edit_batches (id, root, kind, count, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, root, kind, items.length, createdAt);
        for (const it of items) {
          st('INSERT INTO edit_items (batch_id, path, before_json, after_json) VALUES (?, ?, ?, ?)')
            .run(id, it.path, JSON.stringify(nul(it.before)), JSON.stringify(it.after));
          writeItem(kind, it.path, root, it.after);
        }
        for (const d of defs || []) {
          st('INSERT INTO edit_tag_defs (batch_id, name, before_json, after_json) VALUES (?, ?, ?, ?)')
            .run(id, d.name, JSON.stringify(nul(d.before)), JSON.stringify(nul(d.after)));
        }
        writeTagDefs(root, defs, (d) => nul(d.after));
      });
    },

    // 묶음 되돌리기. 그 root의 마지막 묶음만 되돌릴 수 있어요 (같은 파일을 여러 묶음이 바꿨을 때 순서가 꼬이지 않게)
    //   태그 정의를 바꾼 묶음이면 정의도 이전으로 돌려요. 돌려준 값: 정의를 바꿨는지 (true / false)
    undoBatch(id, undoneAt) {
      return tx(() => {
        const b = st('SELECT root, kind FROM edit_batches WHERE id = ?').get(id);
        const last = b ? lastBatchOf(b.root) : null;
        if (!last || last.id !== id) throw new Error('마지막 묶음만 되돌릴 수 있어요');
        for (const it of st('SELECT path, before_json FROM edit_items WHERE batch_id = ?').all(id)) {
          const before = JSON.parse(it.before_json);
          writeItem(b.kind, it.path, b.root, isTagKind(b.kind) ? before || [] : before);
        }
        const defs = st('SELECT name, before_json FROM edit_tag_defs WHERE batch_id = ?').all(id)
          .map((d) => ({ name: d.name, before: JSON.parse(d.before_json) }));
        writeTagDefs(b.root, defs, (d) => d.before);
        st('UPDATE edit_batches SET undone_at = ? WHERE id = ?').run(undoneAt, id);
        return defs.length > 0;
      });
    },

    // ---------- 태그 정의 (2026-11-18): 빈 태그, 단축키, 이름 바꾸기 · 지우기 ----------
    // 정의 하나 { name, hotkey } (없으면 null)
    tagDef(root, name) {
      return tagDefOf(root, name);
    },
    // 이 폴더의 정의 목록 [{ name, hotkey }] (이름 순, 기록 파일에 적을 모양)
    tagDefList(root) {
      return st('SELECT name, hotkey FROM tag_names WHERE root = ? ORDER BY name').all(root).map((r) => ({ name: r.name, hotkey: r.hotkey }));
    },
    // 묶음 없이 정의만 바꿔요 (빈 태그 만들기, 단축키 정하기, 사진이 없는 태그의 이름 바꾸기 · 지우기). 한 트랜잭션
    //   defs: [{ name, after }] — after null 은 지우기(사진이 붙어 있으면 안 지움), { hotkey } 는 만들기 · 바꾸기
    setTagDefs(root, defs) {
      tx(() => writeTagDefs(root, defs, (d) => nul(d.after)));
    },
    // 단축키 정하기: 같은 숫자를 쓰던 다른 태그는 숫자가 빠져요 (숫자 하나에 태그 하나). key null = 빼기
    //   돌려준 값: 숫자를 뺏긴 태그 이름 (없으면 null)
    setTagHotkey(root, name, key) {
      return tx(() => {
        if (!tagDefOf(root, name)) throw new Error('그 태그를 찾을 수 없어요. 태그 목록을 다시 확인해 주세요.');
        let moved = null;
        if (key !== null) {
          const other = st('SELECT name FROM tag_names WHERE root = ? AND hotkey = ? AND name <> ?').get(root, key, name);
          if (other) {
            st('UPDATE tag_names SET hotkey = NULL WHERE root = ? AND name = ?').run(root, other.name);
            moved = other.name;
          }
        }
        st('UPDATE tag_names SET hotkey = ? WHERE root = ? AND name = ?').run(key, root, name);
        return moved;
      });
    },
    // 그 태그가 붙은 경로와 그 사진에 내가 붙인 태그 목록 [{ path, tags }] (이름 바꾸기 · 지우기 계산용, 이 폴더 것만)
    //   사라진 사진(missing)도 넣어요: 다시 나타나도 옛 이름이 남지 않게
    taggedPaths(root, name) {
      return st('SELECT path FROM manual_tags WHERE root = ? AND name = ? ORDER BY path').all(root, name)
        .map((r) => ({ path: r.path, tags: st('SELECT name FROM manual_tags WHERE path = ? ORDER BY name').all(r.path).map((t) => t.name) }));
    },
    // 켤 때 한 번: 내가 붙인 태그 이름 중 정의가 없는 것을 채워요 (이 기능 전에 붙인 태그). 채운 개수를 돌려줘요
    fillTagNames() {
      return tx(() => {
        const r = st('INSERT OR IGNORE INTO tag_names (root, name) SELECT DISTINCT root, name FROM manual_tags').run();
        return Number(r.changes) || 0;
      });
    },
    // 기록 파일의 마지막 정의 목록에 맞춰요 (켤 때, 묶음을 모두 다시 넣은 뒤). 정의가 바뀔 때마다 그 목록을 적어서 마지막 목록이 기준이에요
    //   - 목록에 없고 사진도 안 붙은 정의는 지워요 (묶음 다시 넣기로 생긴, 나중에 지운 태그가 되살아나지 않게 — #122 검증 ❌)
    //   - 목록에 있는데 없는 정의는 만들어요 (빈 태그)
    //   - 숫자는 모두 비운 뒤 목록대로 넣어요. 평소에는 DB와 같아서 바뀐 것이 0개예요. 바뀐 이름 수를 돌려줘요
    syncTagDefs(root, list) {
      return tx(() => {
        const before = new Map(st('SELECT name, hotkey FROM tag_names WHERE root = ?').all(root).map((r) => [r.name, r.hotkey]));
        const want = new Map((list || []).map((d) => [d.name, d.hotkey ?? null]));
        for (const name of before.keys()) {
          if (!want.has(name)) writeTagDef(root, name, null); // 사진이 붙어 있으면 지우지 않아요
        }
        st('UPDATE tag_names SET hotkey = NULL WHERE root = ?').run(root);
        for (const [name, key] of want) {
          st('INSERT OR IGNORE INTO tag_names (root, name) VALUES (?, ?)').run(root, name);
          if (key !== null) writeTagDef(root, name, { hotkey: key });
        }
        const after = new Map(st('SELECT name, hotkey FROM tag_names WHERE root = ?').all(root).map((r) => [r.name, r.hotkey]));
        let n = 0;
        for (const name of new Set([...before.keys(), ...after.keys()])) {
          if (!before.has(name) || !after.has(name) || before.get(name) !== after.get(name)) n++;
        }
        return n;
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

    // 확장자만 다른 파일들 (같은 폴더, 같은 이름): stem = 확장자를 뺀 경로 → 사라지지 않은 이 root 파일의 전체 값
    //   라이브 포토 짝(JPG + MP4)을 찾을 때 써요. '.'(0x2E)과 '/'(0x2F) 사이 범위라 경로 색인을 써요
    sameStem(root, stem) {
      return st('SELECT * FROM files WHERE path >= ? AND path < ? AND root = ? AND missing = 0').all(`${stem}.`, `${stem}/`, root)
        .map(fullRow)
        .filter((f) => !/[.\\/]/.test(f.path.slice(stem.length + 1)));
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

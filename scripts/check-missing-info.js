// 파일 위치: scripts/check-missing-info.js
// 역할: "정보 없는 사진" 점검 항목 (20번부터). scripts/check.js 의 ITEMS 끝에 붙어서 같이 돌아요.
//   빠르게 이 파일만 돌려 볼 때: node scripts/check-missing-info.js
//   (os.tmpdir()의 pvm-check- 임시 폴더에서 돌리고, 모두 통과하면 그 폴더를 지워요)
//
// ⚠️ 실제 사진과 실제 userData(library.db)는 쓰지 않아요.
//    모든 DB 파일은 점검 임시 폴더(env.tmp) 안에만 만들어요.
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { row, sub, withDb, newDbPath } = require('./check-gallery');

// 직접 넣은 값 한 개 (필요한 값만 덮어써서 써요)
const val = (over = {}) => ({ takenAt: null, takenOffset: null, lat: null, lng: null, ...over });

// 경로로 파일 한 개의 값을 찾아요 (path는 목록에 안 나오므로 날짜 목록을 거쳐 찾음)
function fileByPath(db, root, p) {
  for (const d of db.listDays(root, { tab: 'all', sort: 'newest', query: '', tag: null })) {
    for (const f of db.listFiles(root, d.day, { tab: 'all', sort: 'newest', query: '', tag: null })) {
      const full = db.getFile(f.id);
      if (full.path === p) return full;
    }
  }
  return null;
}

// DB 파일을 따로 열어서 한 줄만 읽어요 (값 넣기와 상관없이 실제로 저장된 칸을 보려고)
function peek(file, sql, ...params) {
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(file);
  try {
    return raw.prepare(sql).all(...params);
  } finally {
    raw.close();
  }
}

// 버전 1 구조 (이번 PR 이전의 DB)
const V1_SCHEMA = `
CREATE TABLE files (
  id INTEGER PRIMARY KEY, root TEXT NOT NULL, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  media_type TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
  taken_at TEXT, taken_offset TEXT, taken_day TEXT, taken_at_source TEXT,
  lat REAL, lng REAL, location_source TEXT, model TEXT, width INTEGER, height INTEGER,
  duration_sec REAL, thumb_state TEXT NOT NULL DEFAULT 'none', missing INTEGER NOT NULL DEFAULT 0, read_error TEXT
);
CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE file_tags (file_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, source TEXT NOT NULL, PRIMARY KEY (file_id, tag_id));
`;

const NEW_TABLES = ['manual_values', 'edit_batches', 'edit_items'];

// ---------- 점검 항목 ----------
const items = [
  {
    no: 20,
    name: '직접 넣은 값 저장',
    async run(env) {
      const out = [];
      const { DatabaseSync } = require('node:sqlite');
      const { openDb } = require('../lib/db');

      // 20a 버전 1 파일을 열면 값은 그대로, user_version 2, 새 표 3개
      {
        const file = newDbPath(env, 'v1');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const old = new DatabaseSync(file);
        old.exec(V1_SCHEMA);
        old.prepare(`INSERT INTO files (root, path, name, media_type, size, mtime_ms, taken_at, taken_day, taken_at_source, lat, lng, location_source)
          VALUES ('R1', 'R1/a.jpg', 'a.jpg', 'photo', 100, 1000, '2026-10-25T14:00:30', '2026-10-25', 'exif', 37.5, 127, 'gps')`).run();
        old.exec('PRAGMA user_version = 1');
        old.close();
        const opened = openDb(file);
        const f = fileByPath(opened.db, 'R1', 'R1/a.jpg');
        opened.db.close();
        const version = peek(file, 'PRAGMA user_version')[0].user_version;
        const tables = peek(file, "SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
        out.push(sub(
          '20a 버전 1 DB를 열면 값은 그대로, 구조 버전 2, 새 표 3개',
          !!f && f.lat === 37.5 && f.lng === 127 && f.locationSource === 'gps' && f.takenAt === '2026-10-25T14:00:30' && version === 2 && NEW_TABLES.every((t) => tables.includes(t)),
          `버전 ${version}, 표 ${tables.join(',')}`,
        ));
      }

      // 20b 값 넣기: files 값과 출처가 manual, 다른 칸은 그대로
      await withDb(env, 'manual-apply', (db) => {
        db.upsertFiles([row()]);
        db.applyManualBatch({
          id: 'b1', root: 'R1', kind: 'location', createdAt: '2026-11-01T10:00:00',
          items: [{ path: 'R1/a.jpg', before: null, after: val({ lat: 37.5, lng: 127 }) }],
        });
        const f = fileByPath(db, 'R1', 'R1/a.jpg');
        out.push(sub(
          '20b 위치 넣기: 위치와 출처만 manual, 날짜 칸은 그대로',
          f.lat === 37.5 && f.lng === 127 && f.locationSource === 'manual' && f.takenAtSource === 'exif' && f.takenAt === '2026-10-25T14:00:30' && f.takenDay === '2026-10-25',
          JSON.stringify([f.lat, f.lng, f.locationSource, f.takenAtSource, f.takenAt]),
        ));
        const m = db.getManual('R1/a.jpg');
        const last = db.lastBatch('R1');
        out.push(sub(
          '20b 넣은 값 조회와 묶음 기록',
          !!m && m.lat === 37.5 && m.lng === 127 && m.takenAt === null && m.takenOffset === null
            && db.getManual('R1/없음.jpg') === null && db.batchStatus('b1') === 'applied' && db.batchStatus('없는묶음') === 'none'
            && !!last && last.id === 'b1' && last.kind === 'location' && last.count === 1 && last.createdAt === '2026-11-01T10:00:00',
          JSON.stringify([m, last]),
        ));
      });

      // 20b 날짜 넣기: 날짜 칸과 찍은 날, 출처가 바뀌고 위치는 그대로
      await withDb(env, 'manual-date', (db) => {
        db.upsertFiles([row({ lat: 10, lng: 20, locationSource: 'gps' })]);
        db.applyManualBatch({
          id: 'd1', root: 'R1', kind: 'date', createdAt: '2026-11-01T10:00:00',
          items: [{ path: 'R1/a.jpg', before: null, after: val({ takenAt: '2024-03-05T12:00:00', takenOffset: '+09:00' }) }],
        });
        const f = fileByPath(db, 'R1', 'R1/a.jpg');
        out.push(sub(
          '20b 날짜 넣기: 찍은 시각, 찍은 날(앞 10글자), 출처 manual. 위치는 그대로',
          !!f && f.takenAt === '2024-03-05T12:00:00' && f.takenOffset === '+09:00' && f.takenDay === '2024-03-05' && f.takenAtSource === 'manual'
            && f.lat === 10 && f.lng === 20 && f.locationSource === 'gps',
          f ? JSON.stringify([f.takenAt, f.takenDay, f.takenAtSource, f.lat, f.locationSource]) : '파일 없음',
        ));
      });

      // 20c 위도 0, 경도 0도 값으로 저장
      await withDb(env, 'manual-zero', (db) => {
        db.upsertFiles([row()]);
        db.applyManualBatch({
          id: 'z1', root: 'R1', kind: 'location', createdAt: '2026-11-01T10:00:00',
          items: [{ path: 'R1/a.jpg', before: null, after: val({ lat: 0, lng: 0 }) }],
        });
        const f = fileByPath(db, 'R1', 'R1/a.jpg');
        const m = db.getManual('R1/a.jpg');
        out.push(sub(
          '20c 위도 0, 경도 0도 값으로 저장 (없는 값으로 보지 않음)',
          f.lat === 0 && f.lng === 0 && f.locationSource === 'manual' && !!m && m.lat === 0 && m.lng === 0,
          JSON.stringify([f.lat, f.lng, f.locationSource, m]),
        ));
      });

      // 20d 같은 파일을 다시 읽어도 직접 넣은 값이 남고, orig는 새 파일 값이 됨
      await withDb(env, 'manual-reread', (db) => {
        db.upsertFiles([row()]);
        db.applyManualBatch({
          id: 'r1', root: 'R1', kind: 'both', createdAt: '2026-11-01T10:00:00',
          items: [{ path: 'R1/a.jpg', before: null, after: val({ takenAt: '2024-03-05T12:00:00', takenOffset: '+09:00', lat: 37.5, lng: 127 }) }],
        });
        const id = fileByPath(db, 'R1', 'R1/a.jpg').id;
        db.setThumbState(id, 'ready');
        // 파일이 바뀌어 다시 읽음: 찍은 시각이 바뀌고 위치도 새로 생김
        db.upsertFiles([row({ size: 999, takenAt: '2026-10-30T09:00:00', takenDay: '2026-10-30', lat: 10, lng: 20, locationSource: 'gps' })]);
        const f = db.getFile(id);
        out.push(sub(
          '20d 다시 읽어도 직접 넣은 날짜와 위치가 남음 (다른 칸은 새 파일 값)',
          f.takenAt === '2024-03-05T12:00:00' && f.takenDay === '2024-03-05' && f.takenAtSource === 'manual'
            && f.lat === 37.5 && f.lng === 127 && f.locationSource === 'manual' && f.size === 999 && f.thumbState === 'none',
          JSON.stringify([f.takenAt, f.takenAtSource, f.lat, f.locationSource, f.size, f.thumbState]),
        ));
        // 되돌리면 새 파일 값(다시 읽은 값)으로 돌아가요
        db.setThumbState(id, 'ready');
        db.undoBatch('r1', '2026-11-01T11:00:00');
        const g = db.getFile(id);
        out.push(sub(
          '20d 되돌리면 다시 읽은 새 파일 값으로 돌아감',
          g.takenAt === '2026-10-30T09:00:00' && g.takenDay === '2026-10-30' && g.takenAtSource === 'exif'
            && g.lat === 10 && g.lng === 20 && g.locationSource === 'gps',
          JSON.stringify([g.takenAt, g.takenAtSource, g.lat, g.lng, g.locationSource]),
        ));
      });

      // 20e 파일이 사라져도 manual_values는 남음
      await withDb(env, 'manual-missing', (db) => {
        db.upsertFiles([row()]);
        db.applyManualBatch({
          id: 'm1', root: 'R1', kind: 'location', createdAt: '2026-11-01T10:00:00',
          items: [{ path: 'R1/a.jpg', before: null, after: val({ lat: 37.5, lng: 127 }) }],
        });
        db.setMissing(['R1/a.jpg'], 1);
        const m = db.getManual('R1/a.jpg');
        db.setMissing(['R1/a.jpg'], 0);
        const f = fileByPath(db, 'R1', 'R1/a.jpg');
        out.push(sub(
          '20e 파일이 사라져도 직접 넣은 값은 남고, 다시 나타나면 그대로 보임',
          !!m && m.lat === 37.5 && f.lat === 37.5 && f.locationSource === 'manual',
          JSON.stringify([m, f && f.lat]),
        ));
      });

      // 20f 되돌리기: 파일 값으로 돌아가고 출처도 원래대로. thumb_state는 그대로
      await withDb(env, 'manual-undo', (db) => {
        db.upsertFiles([row({ lat: 10, lng: 20, locationSource: 'gps' })]);
        const id = fileByPath(db, 'R1', 'R1/a.jpg').id;
        db.applyManualBatch({
          id: 'u1', root: 'R1', kind: 'location', createdAt: '2026-11-01T10:00:00',
          items: [{ path: 'R1/a.jpg', before: null, after: val({ lat: 37.5, lng: 127 }) }],
        });
        db.setThumbState(id, 'ready');
        db.undoBatch('u1', '2026-11-01T11:00:00');
        const f = db.getFile(id);
        out.push(sub(
          '20f 되돌리면 파일 값과 출처로 돌아가고 썸네일 상태는 그대로',
          f.lat === 10 && f.lng === 20 && f.locationSource === 'gps' && f.takenAtSource === 'exif' && f.thumbState === 'ready'
            && db.getManual('R1/a.jpg') === null && db.batchStatus('u1') === 'undone' && db.lastBatch('R1') === null,
          JSON.stringify([f.lat, f.locationSource, f.thumbState, db.getManual('R1/a.jpg'), db.batchStatus('u1'), db.lastBatch('R1')]),
        ));
      });

      // 20g 두 묶음이 겹친 파일: 뒤 묶음을 되돌리면 앞 묶음 값, 다시 되돌리면 파일 값
      await withDb(env, 'manual-overlap', (db) => {
        db.upsertFiles([row({ lat: 10, lng: 20, locationSource: 'gps' })]);
        const p = 'R1/a.jpg';
        db.applyManualBatch({ id: 'g1', root: 'R1', kind: 'location', createdAt: '2026-11-01T10:00:00', items: [{ path: p, before: db.getManual(p), after: val({ lat: 1, lng: 2 }) }] });
        db.applyManualBatch({ id: 'g2', root: 'R1', kind: 'both', createdAt: '2026-11-01T10:01:00', items: [{ path: p, before: db.getManual(p), after: val({ takenAt: '2020-01-01T00:00:00', takenOffset: '+09:00', lat: 3, lng: 4 }) }] });
        const a = fileByPath(db, 'R1', p);
        db.undoBatch('g2', '2026-11-01T11:00:00');
        const b = fileByPath(db, 'R1', p);
        const bm = db.getManual(p);
        db.undoBatch('g1', '2026-11-01T11:01:00');
        const c = fileByPath(db, 'R1', p);
        out.push(sub(
          '20g 겹친 두 묶음: 뒤 묶음 3,4 → 앞 묶음 1,2 (날짜는 파일 값) → 파일 값',
          a.lat === 3 && a.takenAt === '2020-01-01T00:00:00'
            && b.lat === 1 && b.lng === 2 && b.locationSource === 'manual' && b.takenAt === '2026-10-25T14:00:30' && b.takenAtSource === 'exif' && !!bm && bm.takenAt === null
            && c.lat === 10 && c.lng === 20 && c.locationSource === 'gps' && db.getManual(p) === null,
          JSON.stringify([a.lat, b.lat, b.takenAtSource, c.lat, c.locationSource]),
        ));
      });

      // 20h 마지막이 아닌 묶음을 undoBatch하면 오류. lastBatch는 root별로 따로
      await withDb(env, 'manual-last', (db) => {
        db.upsertFiles([row(), row({ root: 'R2', path: 'R2/a.jpg' })]);
        const A = (id, root, createdAt) => db.applyManualBatch({
          id, root, kind: 'location', createdAt,
          items: [{ path: `${root}/a.jpg`, before: db.getManual(`${root}/a.jpg`), after: val({ lat: 1, lng: 2 }) }],
        });
        A('h1', 'R1', '2026-11-01T10:00:00');
        A('h2', 'R1', '2026-11-01T10:01:00');
        A('h3', 'R2', '2026-11-01T10:02:00');
        let err = null;
        try { db.undoBatch('h1', '2026-11-01T11:00:00'); } catch (e) { err = e; }
        const afterFail = db.batchStatus('h1');
        out.push(sub('20h 마지막이 아닌 묶음을 되돌리면 오류 (상태는 그대로)', !!err && afterFail === 'applied', err ? err.message : '오류 안 남'));
        let err2 = null;
        try { db.undoBatch('없는묶음', '2026-11-01T11:00:00'); } catch (e) { err2 = e; }
        out.push(sub('20h 없는 묶음을 되돌려도 오류', !!err2));
        out.push(sub('20h lastBatch는 root별로 따로', db.lastBatch('R1').id === 'h2' && db.lastBatch('R2').id === 'h3', JSON.stringify([db.lastBatch('R1'), db.lastBatch('R2')])));
        // 다른 root의 더 새로운 묶음이 있어도 R1의 마지막은 되돌릴 수 있고, 그 뒤엔 h1이 마지막
        db.undoBatch('h2', '2026-11-01T11:00:00');
        out.push(sub('20h 되돌린 묶음은 건너뛰고 그 앞 묶음이 마지막이 됨', db.lastBatch('R1').id === 'h1' && db.lastBatch('R2').id === 'h3'));
        let err3 = null;
        try { db.undoBatch('h2', '2026-11-01T11:01:00'); } catch (e) { err3 = e; }
        out.push(sub('20h 이미 되돌린 묶음을 또 되돌리면 오류', !!err3));
      });

      // 20i files 줄이 없을 때 넣은 값: orig_known 0. 나중에 upsertFiles하면 파일 값 저장 뒤 직접 넣은 값 적용
      await withDb(env, 'manual-nofile', (db, file) => {
        db.applyManualBatch({
          id: 'n1', root: 'R1', kind: 'location', createdAt: '2026-11-01T10:00:00',
          items: [{ path: 'R1/a.jpg', before: null, after: val({ lat: 37.5, lng: 127 }) }],
        });
        const known0 = peek(file, 'SELECT orig_known FROM manual_values WHERE path = ?', 'R1/a.jpg')[0].orig_known;
        const none = fileByPath(db, 'R1', 'R1/a.jpg');
        db.upsertFiles([row({ lat: 10, lng: 20, locationSource: 'gps' })]);
        const known1 = peek(file, 'SELECT orig_known, orig_lat FROM manual_values WHERE path = ?', 'R1/a.jpg')[0];
        const f = fileByPath(db, 'R1', 'R1/a.jpg');
        db.undoBatch('n1', '2026-11-01T11:00:00');
        const g = fileByPath(db, 'R1', 'R1/a.jpg');
        out.push(sub(
          '20i 파일 줄이 없을 때 넣으면 orig_known 0, 읽은 뒤 1이 되고 직접 넣은 값이 이김, 되돌리면 파일 값',
          known0 === 0 && none === null && known1.orig_known === 1 && known1.orig_lat === 10
            && f.lat === 37.5 && f.locationSource === 'manual' && g.lat === 10 && g.locationSource === 'gps',
          JSON.stringify([known0, known1, f && f.lat, g && g.lat]),
        ));
      });

      // 20j 저장 중 오류가 나면 전부 되돌려짐
      await withDb(env, 'manual-rollback', (db) => {
        db.upsertFiles([row(), row({ path: 'R1/b.jpg', name: 'b.jpg' })]);
        db.applyManualBatch({
          id: 'j1', root: 'R1', kind: 'location', createdAt: '2026-11-01T10:00:00',
          items: [{ path: 'R1/a.jpg', before: null, after: val({ lat: 1, lng: 2 }) }],
        });
        // 같은 id로 또 넣으면 오류, 값은 첫 번째 그대로
        let err = null;
        try {
          db.applyManualBatch({
            id: 'j1', root: 'R1', kind: 'location', createdAt: '2026-11-01T10:05:00',
            items: [{ path: 'R1/a.jpg', before: null, after: val({ lat: 9, lng: 9 }) }, { path: 'R1/b.jpg', before: null, after: val({ lat: 9, lng: 9 }) }],
          });
        } catch (e) { err = e; }
        const a = fileByPath(db, 'R1', 'R1/a.jpg');
        out.push(sub(
          '20j 같은 id로 두 번 넣으면 오류, 값은 첫 번째 그대로',
          !!err && a.lat === 1 && db.getManual('R1/a.jpg').lat === 1 && db.getManual('R1/b.jpg') === null && db.lastBatch('R1').count === 1,
          err ? err.message : '오류 안 남',
        ));
        // 한 묶음 안에서 같은 파일이 두 번 나오면 중간에 오류 → 앞에서 쓴 것까지 전부 되돌려짐
        let err2 = null;
        try {
          db.applyManualBatch({
            id: 'j2', root: 'R1', kind: 'location', createdAt: '2026-11-01T10:06:00',
            items: [{ path: 'R1/b.jpg', before: null, after: val({ lat: 5, lng: 5 }) }, { path: 'R1/b.jpg', before: null, after: val({ lat: 6, lng: 6 }) }],
          });
        } catch (e) { err2 = e; }
        const b = fileByPath(db, 'R1', 'R1/b.jpg');
        out.push(sub(
          '20j 묶음 중간에 오류가 나면 앞에서 쓴 값까지 전부 되돌려짐',
          !!err2 && b.lat === null && b.locationSource === null && db.getManual('R1/b.jpg') === null && db.batchStatus('j2') === 'none',
          err2 ? `${b.lat} ${db.batchStatus('j2')}` : '오류 안 남',
        ));
      });

      // getFilesByIds: 값 한 줄씩, 없는 id는 건너뜀, 태그 없음
      await withDb(env, 'manual-byids', (db) => {
        db.upsertFiles([row({ tags: [{ name: '여행', source: 'album' }] }), row({ path: 'R1/b.jpg', name: 'b.jpg' })]);
        const a = fileByPath(db, 'R1', 'R1/a.jpg');
        const b = fileByPath(db, 'R1', 'R1/b.jpg');
        const got = db.getFilesByIds([b.id, 999999, a.id]);
        out.push(sub(
          '20 getFilesByIds: 없는 id는 건너뛰고, 값 한 줄씩(태그 없음)',
          got.length === 2 && got[0].id === b.id && got[1].id === a.id && got[1].path === 'R1/a.jpg' && got[1].takenAtSource === 'exif' && got[1].tags === undefined
            && db.getFilesByIds([]).length === 0,
          JSON.stringify(got.map((g) => g.id)),
        ));
      });

      return out;
    },
  },
  {
    no: 21,
    name: '정보 없음 목록',
    async run(env) {
      const out = [];
      const { fillFakeLibrary } = require('./check-gallery');
      const F = (info, extra = {}) => ({ tab: 'all', sort: 'newest', query: '', tag: null, info, ...extra });
      const SHOT = [{ name: '스크린샷', source: 'mediaType' }];
      const NODATE = { takenAt: null, takenOffset: null, takenDay: null, takenAtSource: null };
      const P = (n) => `R1/${n}.jpg`;
      const base = (n, over = {}) => row({ path: P(n), name: `${n}.jpg`, ...over });

      // 목록에 나온 파일 이름 (날짜 순서 그대로) 과 id
      const listed = (db, filter) => {
        const names = [];
        const ids = [];
        let sum = 0;
        for (const d of db.listDays('R1', filter)) {
          sum += d.count;
          for (const f of db.listFiles('R1', d.day, filter)) {
            names.push(f.name);
            ids.push(f.id);
          }
        }
        return { names: names.sort(), ids, sum };
      };
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

      // 샘플: 위치 있음(a), 위치 없음(b), 스크린샷 위치 없음(c), 날짜 없음+위치 있음(d), 사라진 파일(e),
      //       직접 위치를 넣은 파일(f), 날짜도 위치도 없음(h), 스크린샷이면서 날짜 없음(i)
      const fill = (db) => {
        db.upsertFiles([
          base('a', { lat: 37.5, lng: 127, locationSource: 'gps' }),
          base('b', { tags: [{ name: '여행', source: 'album' }] }),
          base('c', { tags: SHOT }),
          base('d', { ...NODATE, lat: 10, lng: 20, locationSource: 'gps' }),
          base('e'),
          base('f'),
          base('h', { ...NODATE, tags: [{ name: '가족', source: 'album' }] }),
          base('i', { ...NODATE, tags: SHOT }),
        ]);
        db.setMissing([P('e')], 1);
        db.applyManualBatch({
          id: 'x1', root: 'R1', kind: 'location', createdAt: '2026-11-01T10:00:00',
          items: [{ path: P('f'), before: null, after: val({ lat: 1, lng: 2 }) }],
        });
      };

      await withDb(env, 'info-list', (db) => {
        fill(db);

        // 21a 위치 없음: 스크린샷, 사라진 파일, 위치가 있는 파일(직접 넣은 것 포함)을 뺌
        const loc = listed(db, F('noLocation'));
        out.push(sub('21a noLocation은 스크린샷과 사라진 파일을 빼고 b, h만', same(loc.names, ['b.jpg', 'h.jpg']), JSON.stringify(loc.names)));

        // 21b 날짜 없음: 날짜 없는 파일만 (스크린샷 포함)
        const dt = listed(db, F('noDate'));
        out.push(sub('21b noDate는 날짜 없는 파일만 (스크린샷 포함)', same(dt.names, ['d.jpg', 'h.jpg', 'i.jpg']), JSON.stringify(dt.names)));

        // 21c 직접 넣은 것: 날짜나 위치의 출처가 manual
        const mn = listed(db, F('manual'));
        out.push(sub('21c manual은 직접 넣은 파일만', same(mn.names, ['f.jpg']), JSON.stringify(mn.names)));

        // 21d 합계: 날짜 없음 또는 위치 없음(스크린샷 제외). 둘 다 없는 h는 한 번만
        const s = db.summary('R1');
        out.push(sub(
          '21d summary: noLocation 2, noInfo 4 (h는 한 번만), manualCount 1, noDate 3',
          s.noLocation === 2 && s.noInfo === 4 && s.manualCount === 1 && s.noDate === 3,
          JSON.stringify([s.noLocation, s.noInfo, s.manualCount, s.noDate]),
        ));
        out.push(sub(
          '21d summary 개수가 같은 이름의 목록 길이와 같음',
          s.noLocation === loc.sum && s.noDate === dt.sum && s.manualCount === mn.sum,
          JSON.stringify([loc.sum, dt.sum, mn.sum]),
        ));

        // 21e 위치를 넣으면 빠지고, 되돌리면 돌아옴
        db.applyManualBatch({
          id: 'x2', root: 'R1', kind: 'location', createdAt: '2026-11-01T10:01:00',
          items: [{ path: P('b'), before: null, after: val({ lat: 5, lng: 6 }) }],
        });
        const after = listed(db, F('noLocation')).names;
        const sAfter = db.summary('R1');
        const manualAfter = listed(db, F('manual')).names;
        db.undoBatch('x2', '2026-11-01T10:02:00');
        const back = listed(db, F('noLocation')).names;
        const sBack = db.summary('R1');
        out.push(sub(
          '21e 위치를 넣으면 noLocation에서 빠지고 manual에 들어가며, 되돌리면 돌아옴',
          same(after, ['h.jpg']) && sAfter.noLocation === 1 && sAfter.manualCount === 2 && same(manualAfter, ['b.jpg', 'f.jpg'])
            && same(back, ['b.jpg', 'h.jpg']) && sBack.noLocation === 2 && sBack.manualCount === 1,
          JSON.stringify([after, manualAfter, back]),
        ));

        // 21f info와 검색어, 태그를 함께 쓸 수 있음
        const withTag = listed(db, F('noLocation', { tag: '여행' })).names;
        const withQuery = listed(db, F('noLocation', { query: 'h.jpg' })).names;
        const none = listed(db, F('noLocation', { query: 'b.jpg', tag: '가족' })).names;
        const dateQuery = listed(db, F('noDate', { query: 'i.jpg' })).names;
        const shotTab = listed(db, F('noLocation', { tab: 'screenshot' })).names;
        out.push(sub(
          '21f info와 태그, 검색어, 탭을 함께 씀 (스크린샷 탭에서 noLocation은 비어 있음)',
          same(withTag, ['b.jpg']) && same(withQuery, ['h.jpg']) && same(none, []) && same(dateQuery, ['i.jpg']) && same(shotTab, []),
          JSON.stringify([withTag, withQuery, none, dateQuery, shotTab]),
        ));

        // 21g listIds 개수 = listDays 합계, 순서는 listDays와 listFiles를 이은 순서와 같음 (정렬 두 방향)
        let okG = true;
        const detailG = [];
        for (const info of [undefined, 'noLocation', 'noDate', 'manual']) {
          for (const sort of ['newest', 'oldest']) {
            const filter = F(info, { sort });
            const ids = db.listIds('R1', filter);
            const walked = [];
            let sum = 0;
            for (const d of db.listDays('R1', filter)) {
              sum += d.count;
              for (const f of db.listFiles('R1', d.day, filter)) walked.push(f.id);
            }
            const ok = ids.length === sum && same(ids, walked);
            okG = okG && ok;
            detailG.push(`${info}/${sort}:${ids.length}/${sum}${ok ? '' : ' 다름'}`);
          }
        }
        out.push(sub('21g listIds 개수는 listDays 합계와 같고 순서도 같음', okG, detailG.join(' ')));
        out.push(sub('21g info 값이 이상하면 조건을 더하지 않음', db.listIds('R1', F('엉뚱한값; DROP TABLE files')).length === db.listIds('R1', F(undefined)).length));
      });

      // 21h 가짜 6만 건에서 새 필터의 목록 시간 (목표 0.2초, 1초를 넘으면 실패)
      await withDb(env, 'info-fast', (db) => {
        fillFakeLibrary(db, 'FAKE', 60000);
        const ms = (fn) => {
          const t0 = process.hrtime.bigint();
          const r = fn();
          return { ms: Number(process.hrtime.bigint() - t0) / 1e6, r };
        };
        const times = {};
        let slow = [];
        for (const info of ['noLocation', 'noDate', 'manual']) {
          const filter = F(info);
          const days = ms(() => db.listDays('FAKE', filter));
          const firstDay = days.r.length ? days.r[0].day : null;
          const files = ms(() => db.listFiles('FAKE', firstDay, filter));
          const ids = ms(() => db.listIds('FAKE', filter));
          times[info] = { days: days.ms, files: files.ms, ids: ids.ms, n: days.r.reduce((a, d) => a + d.count, 0) };
          for (const [k, v] of [['listDays', days.ms], ['listFiles', files.ms], ['listIds', ids.ms]]) {
            if (v > 1000) slow.push(`${info} ${k} ${v.toFixed(0)}ms`);
          }
        }
        const sm = ms(() => db.summary('FAKE'));
        if (sm.ms > 1000) slow.push(`summary ${sm.ms.toFixed(0)}ms`);
        const t = times.noLocation;
        const fmt = (x) => x.toFixed(0);
        out.push(sub(
          '21h 가짜 6만 건: 정보 없음 목록이 1초 안에 나옴 (목표 0.2초)',
          slow.length === 0 && t.n > 0,
          `noLocation ${t.n}장 listDays ${fmt(t.days)}ms listFiles ${fmt(t.files)}ms listIds ${fmt(t.ids)}ms / `
            + `noDate listDays ${fmt(times.noDate.days)}ms / manual listDays ${fmt(times.manual.days)}ms / summary ${fmt(sm.ms)}ms`
            + (slow.length ? ` / 느림: ${slow.join(', ')}` : ''),
        ));
      });

      return out;
    },
  },
  {
    no: 22,
    name: '미리보기 계산',
    async run() {
      const out = [];
      const { normalizeRequest, planEdit, toPreview, MAX_TARGETS } = require('../lib/manual-edit');
      const YEAR = 2026;
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      // getFilesByIds 줄 모양의 시험용 줄 (id와 missing을 더함)
      const R = (id, over = {}) => ({ ...row({ path: `R1/${id}.jpg`, name: `${id}.jpg` }), id, missing: 0, ...over });
      const noManual = () => null;
      // 함수가 던진 오류 글자 (안 던지면 null)
      const errOf = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
      const copy = (S, pick) => normalizeRequest({ source: 'copy', sourceId: S.id, date: false, time: false, location: false, ...pick }, { sourceRow: S, year: YEAR });
      const takenAts = (plan) => plan.items.map((i) => i.after.takenAt);

      // 22a 날짜+시간: 기준 14:00:30부터 +1초. 순서는 찍은 시각, 이름, id (날짜 없는 파일은 맨 뒤)
      {
        const S = R(100, { takenAt: '2026-10-25T14:00:30', takenOffset: '+09:00' });
        const rows = [
          R(5, { name: 'z.jpg', takenAt: '2026-03-01T00:00:00' }),
          R(1, { name: 'a.jpg', takenAt: null, takenOffset: null, takenDay: null, takenAtSource: null }),
          R(2, { name: 'b.jpg', takenAt: '2026-03-01T00:00:00' }),
        ];
        const plan = planEdit(rows, copy(S, { date: true, time: true }), noManual, 'R1');
        out.push(sub(
          '22a 날짜+시간: b(2) → z(5) → 날짜 없는 a(1) 순서로 14:00:30, :31, :32',
          same(plan.items.map((i) => i.id), [2, 5, 1]) && same(takenAts(plan), ['2026-10-25T14:00:30', '2026-10-25T14:00:31', '2026-10-25T14:00:32'])
            && plan.items.every((i) => i.afterManual.takenOffset === '+09:00' && i.afterManual.lat === null) && plan.kind === 'date',
          JSON.stringify(plan.items.map((i) => [i.id, i.after.takenAt])),
        ));
        // 찍은 시각과 이름이 같으면 id 순서
        const tie = planEdit([R(9, { name: 'x.jpg' }), R(8, { name: 'x.jpg' })], copy(S, { date: true, time: true }), noManual, 'R1');
        out.push(sub('22a 찍은 시각과 이름이 같으면 id 순서', same(tie.items.map((i) => i.id), [8, 9]), JSON.stringify(tie.items.map((i) => i.id))));
      }

      // 22b 23:59:59부터 넘어가면 다음 날 00:00:00 (찍은 날도 바뀜). 해가 넘어가도 맞음
      {
        const S = R(100, { takenAt: '2026-10-25T23:59:59', takenOffset: '+09:00' });
        const plan = planEdit([R(1, { takenAt: null }), R(2, { takenAt: null }), R(3, { takenAt: null })], copy(S, { date: true, time: true }), noManual, 'R1');
        out.push(sub(
          '22b 23:59:59 다음은 다음 날 00:00:00, 00:00:01 (찍은 날 앞 10글자도 바뀜)',
          same(takenAts(plan), ['2026-10-25T23:59:59', '2026-10-26T00:00:00', '2026-10-26T00:00:01']) && plan.items[1].after.takenAt.slice(0, 10) === '2026-10-26',
          JSON.stringify(takenAts(plan)),
        ));
        const S2 = R(100, { takenAt: '2025-12-31T23:59:59', takenOffset: '+09:00' });
        const plan2 = planEdit([R(1), R(2)], copy(S2, { date: true, time: true }), noManual, 'R1');
        out.push(sub('22b 12월 31일 밤에서 다음 해 1월 1일로 넘어감', same(takenAts(plan2), ['2025-12-31T23:59:59', '2026-01-01T00:00:00']), JSON.stringify(takenAts(plan2))));
      }

      // 22c 날짜만: 각 파일의 시각과 시간대를 유지. 시각이 없으면 12:00:00과 기준 시간대
      {
        const S = R(100, { takenAt: '2026-10-25T14:00:30', takenOffset: '+09:00' });
        const rows = [
          R(1, { takenAt: '2024-03-05T08:15:00', takenOffset: '-05:00' }),
          R(2, { takenAt: null, takenOffset: null, takenDay: null, takenAtSource: null }),
        ];
        const plan = planEdit(rows, copy(S, { date: true }), noManual, 'R1');
        const [a, b] = plan.items;
        out.push(sub(
          '22c 날짜만: 시각과 시간대 유지, 시각이 없으면 12:00:00과 기준 시간대',
          a.after.takenAt === '2026-10-25T08:15:00' && a.afterManual.takenOffset === '-05:00'
            && b.after.takenAt === '2026-10-25T12:00:00' && b.afterManual.takenOffset === '+09:00',
          JSON.stringify([a.after.takenAt, a.afterManual.takenOffset, b.after.takenAt, b.afterManual.takenOffset]),
        ));
      }

      // 22d 직접 넣기: 시간대 +09:00, 시간 기본 12:00:00, +1초 규칙 같음
      {
        const r1 = normalizeRequest({ source: 'direct', date: '2024-03-05' }, { sourceRow: null, year: YEAR });
        const p1 = planEdit([R(1), R(2)], r1, noManual, 'R1');
        out.push(sub(
          '22d 직접 넣기: 시간을 안 주면 12:00:00부터, 시간대 +09:00',
          same(takenAts(p1), ['2024-03-05T12:00:00', '2024-03-05T12:00:01']) && p1.items.every((i) => i.afterManual.takenOffset === '+09:00') && r1.sourceId === null && r1.kind === 'date',
          JSON.stringify(takenAts(p1)),
        ));
        const r2 = normalizeRequest({ source: 'direct', date: '2024-03-05', time: '23:59:59' }, { sourceRow: null, year: YEAR });
        const p2 = planEdit([R(1), R(2)], r2, noManual, 'R1');
        out.push(sub('22d 직접 넣기 + 시간: 23:59:59 다음은 다음 날', same(takenAts(p2), ['2024-03-05T23:59:59', '2024-03-06T00:00:00']), JSON.stringify(takenAts(p2))));
      }

      // 22e 위치: 위도 0, 경도 0도 복사. 기준에 위치가 없으면 오류
      {
        const S = R(100, { lat: 0, lng: 0, locationSource: 'gps' });
        const plan = planEdit([R(1)], copy(S, { location: true }), noManual, 'R1');
        const it = plan.items[0];
        out.push(sub(
          '22e 위도 0, 경도 0도 값으로 복사 (없는 값으로 보지 않음)',
          it.status === 'changed' && it.after.lat === 0 && it.after.lng === 0 && it.afterManual.lat === 0 && it.afterManual.lng === 0 && plan.kind === 'location',
          JSON.stringify([it.status, it.after, it.afterManual]),
        ));
        const e1 = errOf(() => copy(R(101, { lat: null, lng: null }), { location: true }));
        const e2 = errOf(() => copy(R(102, { lat: 10, lng: null }), { location: true }));
        out.push(sub('22e 기준에 위치가 없는데 위치를 고르면 오류', !!e1 && !!e2, JSON.stringify([e1, e2])));
      }

      // 22f 고를 수 없는 조합은 오류
      {
        const noDate = R(100, { takenAt: null, takenOffset: null, takenDay: null, takenAtSource: null, lat: 1, lng: 2 });
        const full = R(101, { lat: 1, lng: 2 });
        const e1 = errOf(() => copy(noDate, { date: true }));
        const e2 = errOf(() => copy(full, { time: true }));
        const e3 = errOf(() => copy(full, {}));
        const e4 = errOf(() => copy(noDate, { location: true }));
        out.push(sub(
          '22f 기준에 날짜가 없는데 날짜를 고르면, 날짜 없이 시간만 고르면, 아무것도 안 고르면 오류. 위치만이면 날짜 없어도 됨',
          !!e1 && !!e2 && !!e3 && e4 === null,
          JSON.stringify([e1, e2, e3, e4]),
        ));
      }

      // 22g 기준 사진 자신, missing, 다른 root 줄은 빠지고 excluded에 셈
      {
        const S = R(100, { lat: 1, lng: 2, locationSource: 'gps' });
        const rows = [S, R(1), R(2, { missing: 1 }), R(3, { root: 'R2', path: 'R2/3.jpg' }), R(4)];
        const plan = planEdit(rows, copy(S, { location: true }), noManual, 'R1');
        out.push(sub(
          '22g 기준 사진 자신, 사라진 파일, 다른 root 줄은 빠지고 excluded 3',
          same(plan.items.map((i) => i.id), [1, 4]) && plan.counts.excluded === 3 && plan.counts.changed === 2,
          JSON.stringify([plan.items.map((i) => i.id), plan.counts]),
        ));
      }

      // 22h 값이 같으면 same. 다른 값이 있던 파일은 overwrite와 hadValue. 위치만 넣을 때 날짜값은 비교하지 않음
      {
        const S = R(100, { lat: 37.5, lng: 127, locationSource: 'gps' });
        const prev = val({ lat: 37.5, lng: 127 });
        const rows = [
          R(1, { lat: 37.5, lng: 127, locationSource: 'gps', takenAt: '2000-01-01T00:00:00' }),
          R(2, { lat: 10, lng: 20, locationSource: 'gps' }),
          R(3),
        ];
        const plan = planEdit(rows, copy(S, { location: true }), (p) => (p === 'R1/1.jpg' ? prev : null), 'R1');
        const [a, b, c] = plan.items;
        out.push(sub(
          '22h 같은 위치는 same (날짜가 달라도 비교 안 함), 다른 위치가 있던 파일은 overwrite, 위치 없던 파일은 changed',
          a.status === 'same' && !a.hadValue && b.status === 'changed' && b.hadValue && c.status === 'changed' && !c.hadValue
            && same(plan.counts, { changed: 2, same: 1, overwrite: 1, excluded: 0 }),
          JSON.stringify(plan.counts),
        ));
        out.push(sub(
          '22h same 줄은 afterManual이 beforeManual과 같음, before와 after는 지금 보이는 값',
          same(a.afterManual, prev) && a.beforeManual === prev && b.beforeManual === null && same(b.before, { takenAt: '2026-10-25T14:00:30', lat: 10, lng: 20 }) && same(b.after, { takenAt: '2026-10-25T14:00:30', lat: 37.5, lng: 127 }),
          JSON.stringify([a.afterManual, b.before, b.after]),
        ));
        // 날짜가 이미 있는 파일에 날짜를 넣으면 overwrite
        const S2 = R(101, { takenAt: '2026-10-25T14:00:30', takenOffset: '+09:00' });
        const dplan = planEdit([R(1, { takenAt: '2020-01-01T00:00:00' }), R(2, { takenAt: null, takenOffset: null, takenDay: null, takenAtSource: null })], copy(S2, { date: true, time: true }), noManual, 'R1');
        out.push(sub('22h 날짜가 있던 파일에 날짜를 넣으면 overwrite, 없던 파일은 아님', same(dplan.counts, { changed: 2, same: 0, overwrite: 1, excluded: 0 }), JSON.stringify(dplan.counts)));
        // 같은 시각이어도 시간대가 다르면 changed
        const S3 = R(102, { takenAt: '2026-10-25T14:00:30', takenOffset: '+09:00' });
        const zplan = planEdit([R(1, { takenAt: '2026-10-25T14:00:30', takenOffset: null })], copy(S3, { date: true, time: true }), noManual, 'R1');
        out.push(sub('22h 날짜+시간이 모두 같으면 same, 시간대만 달라도 changed', zplan.items[0].status === 'changed'
          && planEdit([R(1, { takenAt: '2026-10-25T14:00:30', takenOffset: '+09:00' })], copy(S3, { date: true, time: true }), noManual, 'R1').items[0].status === 'same'));
      }

      // 22i afterManual은 이전 직접 넣은 값과 합침: 날짜를 넣은 파일에 위치를 넣으면 둘 다 있음
      {
        const S = R(100, { lat: 37.5, lng: 127, locationSource: 'gps' });
        const prev = val({ takenAt: '2024-03-05T12:00:00', takenOffset: '+09:00' });
        const plan = planEdit([R(1, { takenAt: '2024-03-05T12:00:00', takenAtSource: 'manual' })], copy(S, { location: true }), () => prev, 'R1');
        const it = plan.items[0];
        out.push(sub(
          '22i 날짜를 직접 넣은 파일에 위치를 넣으면 afterManual에 날짜와 위치가 둘 다 있음 (beforeManual은 그대로)',
          same(it.afterManual, { takenAt: '2024-03-05T12:00:00', takenOffset: '+09:00', lat: 37.5, lng: 127 }) && same(it.beforeManual, val({ takenAt: '2024-03-05T12:00:00', takenOffset: '+09:00' })),
          JSON.stringify([it.beforeManual, it.afterManual]),
        ));
      }

      // 22j 전부 same이면 changed 0
      {
        const S = R(100, { lat: 37.5, lng: 127, locationSource: 'gps' });
        const plan = planEdit([R(1, { lat: 37.5, lng: 127 }), R(2, { lat: 37.5, lng: 127 })], copy(S, { location: true }), noManual, 'R1');
        out.push(sub('22j 전부 같은 값이면 changed 0, same 2', same(plan.counts, { changed: 0, same: 2, overwrite: 0, excluded: 0 }), JSON.stringify(plan.counts)));
        const big = Array.from({ length: MAX_TARGETS + 1 }, (_, i) => R(i + 1));
        out.push(sub('22j 한 번에 최대 20,000장 (20,001장이면 오류)', MAX_TARGETS === 20000 && !!errOf(() => planEdit(big, copy(S, { location: true }), noManual, 'R1')) && errOf(() => planEdit(big.slice(0, MAX_TARGETS), copy(S, { location: true }), noManual, 'R1')) === null));
      }

      // 22k 잘못된 값 거절
      {
        const direct = (date, time) => errOf(() => normalizeRequest({ source: 'direct', date, time }, { sourceRow: null, year: YEAR }));
        const bad = [
          ['2026-02-30', direct('2026-02-30')], ['2023-02-29', direct('2023-02-29')], ['1899-12-31', direct('1899-12-31')],
          ['내년 2027-01-01', direct('2027-01-01')], ["'2026-1-1'", direct('2026-1-1')], ['시각 25:00:00', direct('2026-01-01', '25:00:00')],
          ['시각 12:60:00', direct('2026-01-01', '12:60:00')], ['시각 12:00', direct('2026-01-01', '12:00')], ['날짜 없음', direct(undefined)], ['날짜 숫자', direct(20260101)],
        ];
        const badLat = errOf(() => copy(R(100, { lat: 91, lng: 0 }), { location: true }));
        const badLng = errOf(() => copy(R(100, { lat: 0, lng: 181 }), { location: true }));
        const notObj = errOf(() => normalizeRequest(null, { sourceRow: null, year: YEAR }));
        const badSource = errOf(() => normalizeRequest({ source: 'x' }, { sourceRow: null, year: YEAR }));
        const noSourceRow = errOf(() => normalizeRequest({ source: 'copy', sourceId: 5, date: true }, { sourceRow: null, year: YEAR }));
        const missed = bad.filter(([, e]) => !e).map(([n]) => n);
        out.push(sub('22k 날짜와 시각 모양 거절: 없는 날, 1900년 앞, 내년, 한 자리 월, 25시, 60분 등', missed.length === 0, `거절 못한 것: ${missed.join(', ')}`));
        out.push(sub('22k 위도 91, 경도 181, 이상한 요청, 기준 사진 없음 거절', !!badLat && !!badLng && !!notObj && !!badSource && !!noSourceRow, JSON.stringify([badLat, badLng, notObj, badSource, noSourceRow])));
        const okEdge = ['1900-01-01', '2026-12-31', '2024-02-29'].map((d) => direct(d));
        out.push(sub('22k 경계 값(1900-01-01, 올해 12-31, 윤일)은 받음', okEdge.every((e) => e === null), JSON.stringify(okEdge)));
      }

      // 22l toPreview: 경로와 manual 값이 없고, 101장이면 100줄과 more 1
      {
        const S = R(1000, { lat: 37.5, lng: 127, locationSource: 'gps' });
        const rows = Array.from({ length: 101 }, (_, i) => R(i + 1));
        const plan = planEdit(rows, copy(S, { location: true }), noManual, 'R1');
        const pv = toPreview(plan);
        const json = JSON.stringify(pv);
        out.push(sub(
          '22l toPreview: 100줄과 more 1, 경로와 manual 값은 없음, 개수와 종류는 그대로',
          pv.items.length === 100 && pv.more === 1 && !json.includes('"path"') && !json.includes('Manual') && !json.includes('R1/') && pv.kind === 'location' && pv.counts.changed === 101
            && pv.items[0].id === 1 && pv.items[0].name === '1.jpg' && pv.items[0].status === 'changed',
          json.slice(0, 200),
        ));
        const small = toPreview(planEdit(rows.slice(0, 3), copy(S, { location: true }), noManual, 'R1'));
        out.push(sub('22l 100장 이하면 more 0', small.items.length === 3 && small.more === 0));
      }

      return out;
    },
  },
  {
    no: 23,
    name: '기록 파일과 복구',
    async run(env) {
      const out = [];
      const { createJournal, recover } = require('../lib/manual-journal');
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const dir = path.join(env.tmp, 'journal');
      fs.mkdirSync(dir, { recursive: true });
      let seq = 0;
      const jpath = () => path.join(dir, `manual-edits-${++seq}.jsonl`);
      const errOf = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
      const counts = (r) => ({ applied: r.applied, undone: r.undone, skipped: r.skipped }); // errors 는 23i 에서 따로 확인해요
      const P = (n) => `R1/${n}.jpg`;
      const apply = (batchId, items, over = {}) => ({ type: 'apply', batchId, at: '2026-11-01T10:00:00', root: 'R1', kind: 'location', items, ...over });
      const undo = (batchId, at = '2026-11-01T11:00:00') => ({ type: 'undo', batchId, at });
      const voidOf = (of, batchId) => ({ type: 'void', of, batchId });
      const item = (n, before, after) => ({ path: P(n), before, after });
      // 줄들을 새 기록 파일에 쓰고, 새 DB에 recover 한 뒤 fn(db, 결과, 기록 도구)을 실행해요
      const run = async (lines, fn) => {
        const j = createJournal(jpath());
        for (const l of lines) j.append(l);
        return withDb(env, 'recover', (db) => fn(db, recover(db, j), j));
      };
      // 직접 쓴 글자(깨진 줄 등)를 기록 파일로 두고 recover
      const runRaw = async (text, fn) => {
        const file = jpath();
        fs.writeFileSync(file, text, 'utf8');
        const j = createJournal(file);
        return withDb(env, 'recover', (db) => fn(db, recover(db, j), j));
      };
      // DB 적용만 일부러 실패시키는 껍데기 (id가 'bad'인 묶음)
      const failing = (db) => ({
        batchStatus: (id) => db.batchStatus(id),
        undoBatch: (id, at) => db.undoBatch(id, at),
        applyManualBatch(b) {
          if (b.id === 'bad') throw new Error('일부러 낸 오류');
          return db.applyManualBatch(b);
        },
      });
      const A1 = apply('b1', [item('a', null, val({ lat: 1, lng: 2 })), item('b', null, val({ lat: 3, lng: 4 }))]);
      const A2 = apply('b2', [item('a', val({ lat: 1, lng: 2 }), val({ takenAt: '2026-03-05T12:00:00', takenOffset: '+09:00', lat: 1, lng: 2 }))], { kind: 'date', at: '2026-11-01T10:30:00' });

      // 23a apply, undo 줄을 쓰고 새 DB에 recover → 값과 되돌림 상태가 같음, 다시 읽은 뒤에도 같음
      await run([A1, A2, undo('b2')], (db, r, j) => {
        db.upsertFiles([row({ path: P('a'), name: 'a.jpg' })]);
        const snap = () => [db.batchStatus('b1'), db.batchStatus('b2'), db.getManual(P('a')), db.getManual(P('b')), db.lastBatch('R1')];
        const first = snap();
        const again = recover(db, j);
        out.push(sub(
          '23a apply 두 개와 undo 한 줄: 새 DB에서 b1 적용됨, b2 되돌림, 값은 b2를 되돌린 뒤 상태',
          same(counts(r), { applied: 2, undone: 1, skipped: 0 }) && first[0] === 'applied' && first[1] === 'undone'
            && same(first[2], val({ lat: 1, lng: 2 })) && same(first[3], val({ lat: 3, lng: 4 })) && first[4].id === 'b1' && first[4].createdAt === '2026-11-01T10:00:00',
          JSON.stringify([r, first]),
        ));
        out.push(sub(
          '23a 다시 recover 해도 아무것도 안 바뀜 (다시 읽은 뒤에도 같음)',
          same(counts(again), { applied: 0, undone: 0, skipped: 0 }) && same(snap(), first),
          JSON.stringify(again),
        ));
      });

      // 23a 파일 줄에도 반영: 파일이 이미 DB에 있으면 보이는 값이 직접 넣은 값
      await run([A1], (db) => {
        // recover 뒤에 파일이 들어와도(처음 읽기) 직접 넣은 값이 이김
        db.upsertFiles([row({ path: P('a'), name: 'a.jpg', lat: 50, lng: 60, locationSource: 'gps' })]);
        const f = fileByPath(db, 'R1', P('a'));
        out.push(sub('23a 복구한 값은 나중에 파일을 읽어도 이김 (위치 1, 2)', !!f && f.lat === 1 && f.lng === 2, JSON.stringify(f && [f.lat, f.lng])));
      });

      // 23b 경로 'R1/한글 #1 %20 "따옴표".jpg' 그대로 복구
      {
        const weird = 'R1/한글 #1 %20 "따옴표" \\역슬래시.jpg';
        await run([apply('w1', [{ path: weird, before: null, after: val({ lat: 5, lng: 6 }) }])], (db, r) => {
          out.push(sub('23b 한글, #, %20, 따옴표, 역슬래시가 든 경로 그대로 복구', r.applied === 1 && same(db.getManual(weird), val({ lat: 5, lng: 6 })), JSON.stringify(r)));
        });
      }

      // 23c 이미 DB에 있는 묶음은 건너뜀 (recover를 두 번 해도 같음)
      await run([A1], (db, r, j) => {
        const r2 = recover(db, j);
        // 먼저 DB에 있던 묶음은 건너뜀 (기록의 다른 값으로 덮어 쓰지 않음)
        db.applyManualBatch({ id: 'pre', root: 'R1', kind: 'location', createdAt: '2026-11-01T09:00:00', items: [item('z', null, val({ lat: 9, lng: 9 }))] });
        j.append(apply('pre', [item('z', null, val({ lat: 7, lng: 7 }))]));
        const r3 = recover(db, j);
        out.push(sub(
          '23c recover를 두 번 해도 같음, 이미 DB에 있는 묶음은 건너뜀 (값을 덮어 쓰지 않음)',
          same(counts(r), { applied: 1, undone: 0, skipped: 0 }) && same(counts(r2), { applied: 0, undone: 0, skipped: 0 }) && same(counts(r3), { applied: 0, undone: 0, skipped: 0 })
            && same(db.getManual(P('z')), val({ lat: 9, lng: 9 })),
          JSON.stringify([r, r2, r3]),
        ));
      });

      // 23d apply 줄만 있고 DB에 없음(저장 전에 꺼짐) → 적용됨
      await run([A1], (db, r) => {
        out.push(sub('23d apply 줄만 있고 DB에 없으면 적용됨', r.applied === 1 && db.batchStatus('b1') === 'applied' && same(db.getManual(P('a')), val({ lat: 1, lng: 2 }))));
      });

      // 23e void of apply: 그 묶음을 적용하지 않음. void of undo: 묶음은 적용하고 되돌림은 취소
      await run([A1, voidOf('apply', 'b1'), A2], (db, r) => {
        out.push(sub(
          '23e void of apply: 그 묶음은 적용하지 않음, 다른 묶음은 적용',
          r.applied === 1 && db.batchStatus('b1') === 'none' && db.batchStatus('b2') === 'applied' && db.getManual(P('b')) === null,
          JSON.stringify(r),
        ));
      });
      await run([A1, undo('b1'), voidOf('undo', 'b1')], (db, r) => {
        out.push(sub(
          '23e void of undo: 묶음은 적용하고 되돌림은 취소 (값이 남음)',
          same(counts(r), { applied: 1, undone: 0, skipped: 0 }) && db.batchStatus('b1') === 'applied' && same(db.getManual(P('a')), val({ lat: 1, lng: 2 })),
          JSON.stringify(r),
        ));
      });
      await run([voidOf('apply', 'nope'), A1, undo('b1'), A2, voidOf('apply', 'b2')], (db, r) => {
        out.push(sub(
          '23e 앞 줄이 없는 void는 무시하고, 나머지는 순서대로 (b1 적용 후 되돌림, b2는 적용 안 함)',
          same(counts(r), { applied: 1, undone: 1, skipped: 0 }) && db.batchStatus('b1') === 'undone' && db.batchStatus('b2') === 'none' && db.getManual(P('a')) === null,
          JSON.stringify(r),
        ));
      });

      // 23f 끝 줄이 잘린 파일과 깨진 가운데 줄: 건너뛰고 skipped에 셈, 나머지는 복구
      {
        const l1 = JSON.stringify(A1);
        const l2 = JSON.stringify(A2);
        const cut = l2.slice(0, Math.floor(l2.length / 2));
        await runRaw(`${l1}\n{깨진 줄\n\n${JSON.stringify({ type: 'apply', batchId: 'x' })}\n${cut}`, (db, r) => {
          out.push(sub(
            '23f 깨진 가운데 줄, 모양이 틀린 줄, 끝이 잘린 줄은 건너뛰고 skipped 3 (빈 줄은 안 셈), 나머지는 복구',
            same(counts(r), { applied: 1, undone: 0, skipped: 3 }) && db.batchStatus('b1') === 'applied' && db.batchStatus('b2') === 'none',
            JSON.stringify(r),
          ));
        });
        await runRaw(`${l1}\r\n${JSON.stringify(undo('b1'))}\r\n`, (db, r) => {
          out.push(sub('23f \\r\\n 줄바꿈도 읽음', same(counts(r), { applied: 1, undone: 1, skipped: 0 }), JSON.stringify(r)));
        });
        // 끝 줄이 잘린 파일에 append 하면 새 줄이 깨진 줄에 붙지 않음
        const file = jpath();
        fs.writeFileSync(file, `${l1}\n${cut}`, 'utf8');
        const j = createJournal(file);
        j.append(undo('b1'));
        const rd = j.read();
        out.push(sub(
          '23f 잘린 끝 줄 뒤에 append 해도 새 줄은 온전히 읽힘 (깨진 줄 1개만 skipped)',
          rd.lines.length === 2 && rd.skipped === 1 && rd.lines[1].type === 'undo',
          JSON.stringify([rd.lines.length, rd.skipped]),
        ));
      }

      // 23g 파일이 없으면 빈 결과. 쓸 수 없는 경로에 append하면 오류
      {
        const nofile = createJournal(path.join(dir, 'nothing-here.jsonl'));
        const empty = nofile.read();
        await withDb(env, 'recover', (db) => {
          const r = recover(db, nofile);
          out.push(sub('23g 파일이 없으면 read는 빈 결과, recover는 0, 0, 0', same(empty, { lines: [], skipped: 0 }) && same(counts(r), { applied: 0, undone: 0, skipped: 0 }), JSON.stringify([empty, r])));
        });
        // 부모가 폴더가 아니라 보통 파일인 경로: 어느 PC에서나 쓸 수 없음
        const blocker = path.join(dir, 'blocker');
        fs.writeFileSync(blocker, 'x');
        const bad = createJournal(path.join(blocker, 'manual-edits.jsonl'));
        const e = errOf(() => bad.append(undo('b1')));
        out.push(sub('23g 쓸 수 없는 경로(부모가 보통 파일)에 append하면 오류', !!e, String(e)));
        out.push(sub('23g 그런 경로를 read하면 빈 결과', same(bad.read(), { lines: [], skipped: 0 })));
        // 폴더가 없으면 만들고 한 줄씩 더함
        const deep = createJournal(path.join(dir, 'sub', 'deeper', 'm.jsonl'));
        deep.append(undo('b1'));
        deep.append(undo('b2'));
        out.push(sub('23g append는 폴더가 없으면 만들고 한 줄씩 더함', deep.read().lines.length === 2));
      }

      // 23h 어떤 묶음을 DB에 적용하다 오류가 나도 skipped로 세고 계속함. 시작을 막지 않음
      {
        const j = createJournal(jpath());
        j.append(A1);
        j.append(apply('bad', [item('c', null, val({ lat: 8, lng: 8 }))]));
        j.append(A2);
        await withDb(env, 'recover', (db) => {
          let r;
          const e = errOf(() => { r = recover(failing(db), j); });
          out.push(sub(
            '23h 적용 중 오류가 난 묶음은 skipped 1, 앞뒤 묶음은 적용, 오류는 밖으로 안 나옴',
            e === null && same(counts(r), { applied: 2, undone: 0, skipped: 1 }) && db.batchStatus('bad') === 'none' && db.batchStatus('b2') === 'applied',
            JSON.stringify([e, r]),
          ));
        });
        // 마지막 묶음이 아닌 것의 undo는 DB가 거절 → skipped
        await run([A1, A2, undo('b1')], (db, r) => {
          out.push(sub(
            '23h 마지막 묶음이 아닌 것의 undo는 DB가 거절해 skipped 1, 나머지는 그대로',
            same(counts(r), { applied: 2, undone: 0, skipped: 1 }) && db.batchStatus('b1') === 'applied' && db.batchStatus('b2') === 'applied',
            JSON.stringify(r),
          ));
        });
        // 기록 파일을 읽다 오류가 나도 시작은 계속
        await withDb(env, 'recover', (db) => {
          const r = recover(db, { read() { throw new Error('읽기 실패'); } });
          out.push(sub('23h 기록 파일을 읽다 오류가 나도 recover는 던지지 않고 skipped 1', same(counts(r), { applied: 0, undone: 0, skipped: 1 }), JSON.stringify(r)));
        });
      }

      // 23i 실패한 이유를 errors 로 돌려줘요: [{ batchId, type, message }], 읽을 수 없는 줄과 파일 열기 실패도 포함, 개수 제한
      {
        const j = createJournal(jpath());
        j.append(A1);
        j.append(apply('bad', [item('c', null, val({ lat: 8, lng: 8 }))]));
        j.append(A2);
        j.append(undo('b1')); // 마지막 묶음이 아니라 DB가 거절
        await withDb(env, 'recover', (db) => {
          const r = recover(failing(db), j);
          const bad = r.errors.find((x) => x.batchId === 'bad');
          const b1 = r.errors.find((x) => x.batchId === 'b1');
          out.push(sub(
            '23i 적용 실패와 되돌리기 거절의 이유가 errors에 묶음 번호, 종류, 글자로 담김',
            Array.isArray(r.errors) && r.errors.length === 2 && !!bad && bad.type === 'apply' && bad.message === '일부러 낸 오류'
              && !!b1 && b1.type === 'undo' && typeof b1.message === 'string' && b1.message.length > 0 && r.skipped === 2,
            JSON.stringify(r.errors),
          ));
        });
        await runRaw(`${JSON.stringify(A1)}\n{깨진 줄\n`, (db, r) => {
          out.push(sub(
            '23i 읽을 수 없는 줄도 errors에 한 항목으로 담기고 나머지는 복구',
            r.applied === 1 && r.skipped === 1 && r.errors.length === 1 && r.errors[0].type === 'line' && r.errors[0].message.includes('1'),
            JSON.stringify(r),
          ));
        });
        await withDb(env, 'recover', (db) => {
          const r = recover(db, { read() { throw new Error('읽기 실패'); } });
          out.push(sub('23i 기록 파일을 열 수 없을 때도 errors에 이유가 담김', r.errors.length === 1 && r.errors[0].type === 'file' && r.errors[0].message === '읽기 실패', JSON.stringify(r)));
        });
        await run([A1, A2, undo('b2')], (db, r) => {
          out.push(sub('23i 문제가 없으면 errors는 빈 배열', Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors)));
        });
        // 실패가 아주 많아도 errors는 20개까지 (skipped는 전부 셈)
        const many = createJournal(jpath());
        for (let i = 0; i < 30; i++) many.append(apply('bad', [item('c', null, val({ lat: 8, lng: 8 }))], { at: `2026-11-01T10:00:${String(i).padStart(2, '0')}` }));
        await withDb(env, 'recover', (db) => {
          const r = recover(failing(db), many);
          out.push(sub('23i errors는 20개까지만 담고 skipped는 전부 셈', r.errors.length === 20 && r.skipped === 30, JSON.stringify([r.errors.length, r.skipped])));
        });
      }

      // 23j 예전에 복구가 실패한 묶음이 다음 켤 때 다시 시도될 때: 뒤 묶음이 같은 사진을 이미 바꿨으면 덮지 않고 버림 (void)
      {
        const j = createJournal(jpath());
        const old1 = apply('bad', [item('a', null, val({ lat: 8, lng: 8 }))]); // a: 뒤의 b2와 겹침
        const old2 = apply('ok-later', [item('c', null, val({ lat: 7, lng: 7 }))], { at: '2026-11-01T09:00:00' }); // c: 겹치는 뒤 묶음 없음
        j.append(A1);
        j.append(old1);
        j.append(old2);
        await withDb(env, 'recover', (db) => {
          // 첫 번째 켜기: 'bad' 묶음은 DB 오류로 실패, old2('ok-later')는 이번엔 실패시키지 않으려고 이름을 'bad'와 다르게 둠
          const r1 = recover(failing(db), j);
          // 사용자가 그 뒤 a를 다시 바꿈 (b2) → 화면과 같은 순서로 기록 파일과 DB에 들어감
          j.append(A2);
          db.applyManualBatch({ id: 'b2', root: 'R1', kind: 'date', createdAt: A2.at, items: A2.items });
          const afterB2 = db.getManual(P('a'));
          // 두 번째 켜기: 이번엔 DB 오류 없음
          const r2 = recover(db, j);
          const r3 = recover(db, j); // 세 번째 켜기: 이미 버렸으니 다시 시도하지 않음
          const voided = j.read().lines.filter((l) => l.type === 'void' && l.batchId === 'bad').length;
          out.push(sub(
            '23j 실패했던 옛 묶음은 뒤 묶음이 같은 사진을 바꿨으면 넣지 않음 (a는 b2 값 그대로), void 줄 1개, 다음 켜기에는 다시 시도 안 함',
            r1.skipped === 1 && r2.superseded === 1 && r2.applied === 0 && db.batchStatus('bad') === 'none'
              && same(db.getManual(P('a')), afterB2) && voided === 1 && r3.superseded === 0 && r3.errors.length === 0
              && r2.errors.some((x) => x.batchId === 'bad' && x.type === 'apply'),
            JSON.stringify([r1, r2, r3, voided]),
          ));
          out.push(sub('23j 겹치지 않는 묶음은 그대로 들어감 (c)', db.batchStatus('ok-later') === 'applied' && same(db.getManual(P('c')), val({ lat: 7, lng: 7 })), JSON.stringify(db.getManual(P('c')))));
        });
        // 새 DB에서 처음부터 복구하면(모두 없음) 기록 순서대로 넣음: 겹쳐도 버리지 않음
        await run([A1, apply('first', [item('a', null, val({ lat: 8, lng: 8 }))]), A2], (db, r) => {
          out.push(sub('23j 새 DB에서는 겹쳐도 순서대로 모두 넣음 (버린 묶음 0)', r.applied === 3 && r.superseded === 0, JSON.stringify(r)));
        });
      }

      // 23k 검증 지적: 실패했던 옛 묶음의 사진 일부만 뒤 묶음과 겹치면, 겹친 사진만 빼고 넣음 (d 값을 잃지 않음)
      //   늦게 복구한 옛 묶음은 "마지막 묶음"(되돌리기 대상)이 되지 않음 (만든 시각 순)
      {
        const j = createJournal(jpath());
        j.append(apply('bad', [item('a', null, val({ lat: 8, lng: 8 })), item('d', null, val({ lat: 6, lng: 6 }))], { at: '2026-11-01T10:00:00' }));
        const NW = apply('nw', [item('a', null, val({ lat: 9, lng: 9 }))], { at: '2026-11-01T11:00:00' });
        await withDb(env, 'recover', (db) => {
          const r1 = recover(failing(db), j); // 첫 번째 켜기: 'bad'는 DB 오류로 실패
          j.append(NW); // 사용자가 그 뒤 a를 다시 바꿈
          db.applyManualBatch({ id: 'nw', root: 'R1', kind: 'location', createdAt: NW.at, items: NW.items });
          const r2 = recover(db, j); // 두 번째 켜기
          const r3 = recover(db, j); // 세 번째 켜기: 이미 넣었으니 다시 안 넣음
          const voided = j.read().lines.filter((l) => l.type === 'void').length;
          out.push(sub(
            '23k 겹친 사진(a)만 빼고 넣음: a는 뒤 묶음 값, d는 옛 묶음 값, void 줄 없음, 다음 켜기엔 다시 안 넣음',
            r1.skipped === 1 && r2.partial === 1 && r2.applied === 1 && r2.superseded === 0 && db.batchStatus('bad') === 'applied'
              && same(db.getManual(P('a')), val({ lat: 9, lng: 9 })) && same(db.getManual(P('d')), val({ lat: 6, lng: 6 }))
              && voided === 0 && r3.applied === 0 && r3.partial === 0 && r2.errors.some((x) => x.batchId === 'bad' && x.message.includes('1장')),
            JSON.stringify([r1, r2, r3, db.getManual(P('a')), db.getManual(P('d'))]),
          ));
          out.push(sub('23k 늦게 복구한 옛 묶음이 아니라 사용자의 마지막 묶음이 되돌리기 대상', db.lastBatch('R1').id === 'nw', JSON.stringify(db.lastBatch('R1'))));
        });
      }

      return out;
    },
  },
  {
    no: 24,
    name: '넣기와 되돌리기 연결',
    async run(env) {
      const out = [];
      const crypto = require('crypto');
      const dbMod = require('../lib/db');
      const jMod = require('../lib/manual-journal');
      const { openDb } = dbMod; // 진짜 openDb (아래에서 gallery-main용으로만 잠깐 감싸요)
      const { createLogger } = require('../lib/logger');
      const { MAX_TARGETS } = require('../lib/manual-edit');
      const { fillFakeLibrary } = require('./check-gallery');

      // 일부러 실패시키는 스위치: DB 저장, 되돌리기, void 줄 쓰기, 시작할 때 복구
      const hooks = { failApply: false, failUndo: false, failVoid: false, failRecover: false, failLog: false, failSend: false, failItems: false, leak: '' };
      const opened = [];
      const origOpen = dbMod.openDb;
      const origCreateJournal = jMod.createJournal;
      const origRecover = jMod.recover;
      // gallery-main을 불러오는 동안만 DB 열기, 기록 파일, 복구를 감싸고 바로 되돌려요 (18d와 같은 방식)
      dbMod.openDb = (file, o) => {
        const r = origOpen(file, o);
        const real = r.db;
        const db = {
          ...real,
          applyManualBatch(b) {
            if (hooks.failApply) throw new Error(`일부러 낸 저장 오류 ${hooks.leak}`);
            return real.applyManualBatch(b);
          },
          undoBatch(id, at) {
            if (hooks.failUndo) throw new Error(`일부러 낸 되돌리기 오류 ${hooks.leak}`);
            return real.undoBatch(id, at);
          },
          batchItems(id) {
            if (hooks.failItems) throw new Error('일부러 낸 항목 읽기 오류');
            return real.batchItems(id);
          },
        };
        opened.push(db);
        return { ...r, db };
      };
      jMod.createJournal = (file) => {
        const j = origCreateJournal(file);
        return {
          ...j,
          append(line) {
            if (hooks.failVoid && line.type === 'void') throw new Error(`일부러 낸 void 쓰기 오류 ${hooks.leak}`);
            return j.append(line);
          },
        };
      };
      jMod.recover = (db, j) => {
        if (hooks.failRecover) throw new Error('일부러 낸 복구 오류');
        return origRecover(db, j);
      };
      const gmPath = require.resolve('../gallery-main');
      delete require.cache[gmPath];
      let gm;
      try {
        gm = require('../gallery-main');
      } finally {
        dbMod.openDb = origOpen;
        jMod.createJournal = origCreateJournal;
        jMod.recover = origRecover;
        delete require.cache[gmPath];
      }

      const base = path.join(env.tmp, 'edit-wire');
      fs.mkdirSync(base, { recursive: true });
      let seq = 0;
      const fakes = [];
      const errOf = (p) => p.then(() => null, (e) => e.message);
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const NOT_READY = '가져오기가 끝난 뒤에 할 수 있어요';
      const jfile = (P) => path.join(P.ud, 'manual-edits.jsonl');
      const jlines = (P) => origCreateJournal(jfile(P)).read().lines;
      const logNames = (P, prefix) => (fs.existsSync(P.logDir) ? fs.readdirSync(P.logDir).filter((n) => n.startsWith(`${prefix}_`)) : []);
      const logText = (P, prefix) => logNames(P, prefix).map((n) => fs.readFileSync(path.join(P.logDir, n), 'utf8')).join('\n');
      // 폴더 안 모든 파일의 내용 지문, 크기, 수정 시각 (전후 비교용)
      const fingerprint = (dir) => {
        const m = {};
        for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
          if (!e.isFile()) continue;
          const p = path.join(e.parentPath || e.path, e.name);
          const s = fs.statSync(p);
          m[path.relative(dir, p)] = `${crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')}@${s.size}@${s.mtimeMs}`;
        }
        return JSON.stringify(m);
      };
      const rowOf = (root, name, i) => row({
        root, path: path.join(root, name), name,
        takenAt: `2026-10-0${(i % 9) + 1}T10:00:00`, takenDay: `2026-10-0${(i % 9) + 1}`,
        ...(name === 'src.jpg' ? { lat: 37.5, lng: 127, locationSource: 'gps' } : {}),
      });
      // 사진 폴더(작은 파일), userData, 로그 폴더를 만들고 DB에 줄을 넣어 둬요. makeFiles=false면 폴더를 만들지 않아요(연결 끊김)
      const prep = (label, names, { makeFiles = true } = {}) => {
        const dir = path.join(base, `${label}-${++seq}`);
        const P = { dir, root: path.resolve(dir, 'photos-root-xyz'), ud: path.join(dir, 'ud'), logDir: path.join(dir, 'logs') };
        fs.mkdirSync(P.ud, { recursive: true });
        if (makeFiles) {
          fs.mkdirSync(P.root, { recursive: true });
          for (const n of names) fs.writeFileSync(path.join(P.root, n), `사진 ${n}`);
        }
        const o = openDb(path.join(P.ud, 'library.db'));
        o.db.upsertFiles(names.map((n, i) => rowOf(P.root, n, i)));
        o.db.close();
        return P;
      };
      // setupGallery를 가짜 ipcMain으로 띄워요. 호출은 모두 비동기로 (동기 오류도 거절로)
      const makeFake = (P) => {
        const f = { handlers: new Map(), sent: [], flags: { running: false } };
        const win = {
          isDestroyed: () => false,
          webContents: {
            send: (ch) => {
              if (hooks.failSend) throw new Error('일부러 낸 알림 오류');
              f.sent.push(ch);
            },
          },
        };
        const realLogger = createLogger(P.logDir);
        const logger = {
          dir: realLogger.dir,
          newLog: (...a) => {
            if (hooks.failLog) throw new Error('일부러 낸 로그 오류');
            return realLogger.newLog(...a);
          },
        };
        f.g = gm.setupGallery({
          ipcMain: { handle: (ch, fn) => f.handlers.set(ch, fn) },
          protocol: { handle() {} },
          getWin: () => win,
          getSettings: () => ({ backupRoot: P.root }),
          getTools: () => ({}),
          getEt: () => null,
          isRunning: () => f.flags.running,
          isPlanning: () => false,
          logger,
          userDir: P.ud,
          loadScreen: async () => {},
          getJobPending: () => false,
        });
        f.db = opened[opened.length - 1];
        f.call = async (ch, ...a) => f.handlers.get(ch)(null, ...a);
        f.P = P;
        fakes.push(f);
        return f;
      };
      const idOf = (f, name) => fileByPath(f.db, f.P.root, path.join(f.P.root, name)).id;
      const fileOf = (f, name) => f.call('gallery:get-file', idOf(f, name));
      // 화면이 되돌리기 버튼에 적힌 묶음 번호를 같이 보내요 (지금 마지막 묶음의 번호)
      const lastBatchId = async (f) => ((await f.call('gallery:get-state')).lastBatch || {}).id;
      const scene = async (label, fn) => {
        try {
          await fn();
        } catch (e) {
          out.push(sub(`${label} 실행 중 오류`, false, String(e.stack).split('\n').slice(0, 3).join(' | ')));
        }
      };
      // 화면에 줄 오류 글에 userData 폴더, 사진 폴더, 기록 파일 이름, 겹마침표가 없는지
      const noPath = (P, m) => !m.includes(P.ud) && !m.includes(P.root) && !m.includes('manual-edits') && !m.includes('photos-root-xyz') && !m.includes('..');
      const NAMES = ['src.jpg', 'a.jpg', 'b.jpg', 'c.jpg'];
      const TARGETS = ['a.jpg', 'b.jpg', 'c.jpg'];
      const COPY_LOC = (sourceId) => ({ source: 'copy', sourceId, date: false, time: false, location: true });

      try {
        // 24a, 24b, 24c, 24f, 24j 미리보기, 넣기, 되돌리기 한 바퀴
        await scene('24a', async () => {
          const P = prep('flow', NAMES);
          const f = makeFake(P);
          const fp0 = fingerprint(P.root);
          const ids = TARGETS.map((n) => idOf(f, n));
          const src = idOf(f, 'src.jpg');
          const edit = COPY_LOC(src);
          const st0 = await f.call('gallery:get-state');
          const copy = await f.call('gallery:get-copy-source', src);
          const listed = await f.call('gallery:list-ids', { info: 'noLocation' });

          const pv = await f.call('gallery:preview-edit', ids, edit);
          out.push(sub(
            '24a 미리보기만으로는 DB, 기록 파일, 알림, 로그가 그대로',
            pv.kind === 'location' && pv.counts.changed === 3 && pv.items.length === 3
              && !fs.existsSync(jfile(P)) && f.sent.length === 0 && logNames(P, 'manual-edit').length === 0 && (await f.call('gallery:get-state')).manualCount === 0,
            JSON.stringify(pv.counts),
          ));

          // 24c 미리보기를 본 뒤 기준 사진 값이 바뀌었다: 저장은 새 값
          f.db.upsertFiles([{ ...rowOf(P.root, 'src.jpg', 0), lat: 11, lng: 21 }]);
          const ap = await f.call('gallery:apply-edit', ids, edit);
          const after = [];
          for (const n of TARGETS) after.push(await fileOf(f, n));
          out.push(sub(
            '24c 미리보기 뒤 기준 사진 값이 바뀌면 넣을 때 새 값(11, 21)으로 저장',
            ap.count === 3 && ap.kind === 'location' && typeof ap.batchId === 'string' && after.every((x) => x.lat === 11 && x.lng === 21 && x.locationSource === 'manual'),
            JSON.stringify([ap, after.map((x) => [x.lat, x.lng])]),
          ));

          const lines = jlines(P);
          const st1 = await f.call('gallery:get-state');
          const log = logText(P, 'manual-edit');
          out.push(sub(
            '24a 넣기 뒤: 기록 파일 한 줄(apply, 3장), 값 저장, library-changed 알림 1번, 로그에 묶음 번호와 전후 값',
            lines.length === 1 && lines[0].type === 'apply' && lines[0].batchId === ap.batchId && lines[0].items.length === 3 && lines[0].items[0].before === null && lines[0].items[0].after.lat === 11
              && f.sent.filter((c) => c === 'gallery:library-changed').length === 1
              && log.includes(ap.batchId) && log.includes('→') && log.includes(P.root),
            JSON.stringify([lines.length, f.sent, log.slice(0, 120)]),
          ));
          out.push(sub(
            '24a getState에 noLocation, noInfo, manualCount, lastBatch가 더해짐',
            st0.noLocation === 3 && st0.noInfo === 3 && st0.manualCount === 0 && st0.lastBatch === null
              && st1.noLocation === 0 && st1.noInfo === 0 && st1.manualCount === 3 && st1.lastBatch && st1.lastBatch.kind === 'location' && st1.lastBatch.count === 3,
            JSON.stringify([st0, st1].map((s) => [s.noLocation, s.noInfo, s.manualCount, s.lastBatch])),
          ));
          out.push(sub(
            '24a getCopySource는 id, name, takenAt, lat, lng만, listIds는 filter.info를 따름',
            same(Object.keys(copy).sort(), ['id', 'lat', 'lng', 'name', 'takenAt']) && copy.name === 'src.jpg' && copy.lat === 37.5
              && listed.length === 3 && ids.every((i) => listed.includes(i)),
            JSON.stringify([copy, listed]),
          ));

          // 되돌리기
          const un = await f.call('gallery:undo-last', await lastBatchId(f));
          const reverted = [];
          for (const n of TARGETS) reverted.push(await fileOf(f, n));
          const lines2 = jlines(P);
          const st2 = await f.call('gallery:get-state');
          const un2 = await f.call('gallery:undo-last', 'none');
          out.push(sub(
            '24a 되돌리기: 파일에서 읽은 값으로 돌아가고 기록 파일에 undo 줄, 알림 한 번 더, 묶음이 없으면 null',
            same(un, { kind: 'location', count: 3 }) && reverted.every((x) => x.lat === null && x.locationSource === null)
              && lines2.length === 2 && lines2[1].type === 'undo' && lines2[1].batchId === ap.batchId
              && f.sent.filter((c) => c === 'gallery:library-changed').length === 2 && st2.manualCount === 0 && st2.lastBatch === null && un2 === null,
            JSON.stringify([un, un2, lines2.length, f.sent]),
          ));
          // 되돌리기 로그: 묶음 번호와 파일별 전후 값 (되돌리기 전 11,21 → 되돌린 뒤 없음)
          const undoLog = logNames(P, 'manual-edit').map((n) => fs.readFileSync(path.join(P.logDir, n), 'utf8')).filter((t) => t.startsWith('직접 넣은 값 되돌리기')).join(' | ');
          out.push(sub(
            '24a 되돌리기 로그에 묶음 번호와 파일별 경로, 되돌리기 전 → 후 값(위치 11,21 → 없음 3줄)이 있음',
            undoLog.includes(ap.batchId) && TARGETS.every((n) => undoLog.includes(path.join(P.root, n))) && undoLog.split('11,21 → 없음').length - 1 === 3,
            undoLog.slice(0, 300),
          ));

          // 24f 바꿀 것이 0장이면 count 0, 기록 파일, 묶음, 알림 그대로
          const ap2 = await f.call('gallery:apply-edit', ids, edit);
          const lastId = (await f.call('gallery:get-state')).lastBatch.id;
          const sentBefore = f.sent.length;
          const nBefore = jlines(P).length;
          const zero = await f.call('gallery:apply-edit', ids, edit);
          const zeroPv = await f.call('gallery:preview-edit', ids, edit);
          out.push(sub(
            '24f 이미 같은 값이면 { batchId: null, count: 0 }. 기록 파일 줄, 마지막 묶음, 알림이 그대로',
            ap2.count === 3 && zero.batchId === null && zero.count === 0 && zero.kind === 'location' && zeroPv.counts.changed === 0 && zeroPv.counts.same === 3
              && jlines(P).length === nBefore && (await f.call('gallery:get-state')).lastBatch.id === lastId && f.sent.length === sentBefore,
            JSON.stringify([zero, zeroPv.counts, jlines(P).length, nBefore]),
          ));

          // 24j 응답 어디에도 파일 경로(root)가 없음
          const lb = (await f.call('gallery:get-state')).lastBatch;
          const responses = { pv, ap, un, zero, copy, listed, lb };
          const json = JSON.stringify(responses);
          out.push(sub(
            '24j 미리보기, 넣기, 되돌리기, 복사 값, 목록 응답에 파일 경로(root 글자)와 "path"가 없음',
            !json.includes('photos-root-xyz') && !json.includes('"path"') && !json.includes(P.root),
            json.slice(0, 160),
          ));

          // 24b 넣기와 되돌리기 전후로 사진 폴더 파일이 같음
          out.push(sub('24b 넣기와 되돌리기를 거친 뒤 사진 폴더 파일의 지문, 크기, 수정 시각이 같음', fingerprint(P.root) === fp0));
        });

        // 24d 가져오기 중에는 모두 거절
        await scene('24d', async () => {
          const P = prep('busy', NAMES);
          const f = makeFake(P);
          const ids = TARGETS.map((n) => idOf(f, n));
          const edit = COPY_LOC(idOf(f, 'src.jpg'));
          await f.call('gallery:apply-edit', ids, edit); // 되돌릴 묶음 하나 만들어 둠
          const nBefore = jlines(P).length;
          f.flags.running = true;
          const m = [
            await errOf(f.call('gallery:preview-edit', ids, edit)),
            await errOf(f.call('gallery:apply-edit', ids, edit)),
            await errOf(f.call('gallery:undo-last', 'x')),
          ];
          f.flags.running = false;
          const st = await f.call('gallery:get-state');
          out.push(sub(
            '24d 가져오기 중에는 미리보기, 넣기, 되돌리기 모두 거절 (값, 기록 파일 그대로)',
            m.every((x) => x === NOT_READY) && st.manualCount === 3 && st.lastBatch.count === 3 && jlines(P).length === nBefore,
            JSON.stringify(m),
          ));
        });

        // 24e 이상한 id와 edit 거절, 없는 id와 다른 root의 id는 빠짐
        await scene('24e', async () => {
          const P = prep('weird', NAMES);
          const f = makeFake(P);
          f.db.upsertFiles([row({ root: 'R-other', path: 'R-other/o.jpg', name: 'o.jpg' })]);
          const o = fileByPath(f.db, 'R-other', 'R-other/o.jpg').id;
          const src = idOf(f, 'src.jpg');
          const t1 = idOf(f, 'a.jpg');
          const edit = COPY_LOC(src);

          const badIds = [['a'], [0], [1.5], [-1], [null], [NaN], [2 ** 53], 'notarray', null, undefined, 5, { length: 1, 0: 1 },
            Array.from({ length: MAX_TARGETS + 1 }, (_, i) => i + 1)];
          const missedIds = [];
          for (const ids of badIds) {
            for (const ch of ['gallery:preview-edit', 'gallery:apply-edit']) {
              if (await errOf(f.call(ch, ids, edit)) === null) missedIds.push(`${ch}:${JSON.stringify(ids).slice(0, 30)}`);
            }
          }
          out.push(sub('24e 이상한 id(글자, 0, 소수, 음수, null, 너무 큼, 배열 아님, 20,001개)는 미리보기, 넣기 모두 거절', missedIds.length === 0, missedIds.join(', ')));

          const badEdits = [null, undefined, 'x', 5, [], {}, { source: 'zzz' }, { source: 'copy' }, { source: 'copy', sourceId: 'a', location: true },
            { source: 'copy', sourceId: 999999, location: true }, { source: 'copy', sourceId: src }, { source: 'copy', sourceId: src, time: true, location: true },
            { source: 'direct', date: '2026-02-30' }, { source: 'direct', date: '2026-03-05', time: '25:00:00' }, { source: 'direct' }];
          const missedEdits = [];
          for (const e of badEdits) {
            for (const ch of ['gallery:preview-edit', 'gallery:apply-edit']) {
              if (await errOf(f.call(ch, [t1], e)) === null) missedEdits.push(`${ch}:${JSON.stringify(e)}`);
            }
          }
          const st = await f.call('gallery:get-state');
          out.push(sub('24e 이상한 edit(없음, 글자, 빈 객체, 모르는 방법, 기준 없음, 없는 날짜, 25시 등)는 거절하고 값이 안 바뀜', missedEdits.length === 0 && st.manualCount === 0 && !fs.existsSync(jfile(P)), missedEdits.join(', ')));

          // 20,000개를 넘으면 이유를 쉬운 말로 알려 줌 ("목록이 올바르지 않아요"가 아님)
          const over = Array.from({ length: MAX_TARGETS + 1 }, (_, i) => i + 1);
          const overMsgs = [await errOf(f.call('gallery:preview-edit', over, edit)), await errOf(f.call('gallery:apply-edit', over, edit))];
          out.push(sub(
            '24e 20,000장을 넘게 고르면 "한 번에 20,000장까지" 라고 알려 주고 "올바르지 않아요"라고 하지 않음',
            overMsgs.every((m) => typeof m === 'string' && m.includes('20,000장') && m.includes('한 번에') && !m.includes('올바르지')),
            JSON.stringify(overMsgs),
          ));

          // 경계 20,000개는 받음 (없는 id라 0장)
          const edge = await f.call('gallery:preview-edit', Array.from({ length: MAX_TARGETS }, (_, i) => 100000 + i), edit);
          out.push(sub('24e id 20,000개는 받음 (없는 id는 빠져서 0장)', edge.counts.changed === 0 && edge.items.length === 0));

          // 없는 id, 다른 root의 id, 기준 사진 자신은 빠짐
          const pv = await f.call('gallery:preview-edit', [t1, 999999, o, src], edit);
          const ap = await f.call('gallery:apply-edit', [t1, 999999, o, src], edit);
          const oAfter = await f.call('gallery:get-file', o);
          out.push(sub(
            '24e 없는 id는 빠지고, 다른 root의 id와 기준 사진 자신은 제외로 세고 저장하지 않음',
            pv.counts.changed === 1 && pv.counts.excluded === 2 && pv.items.length === 1 && ap.count === 1 && oAfter.lat === null && (await f.call('gallery:get-state')).manualCount === 1,
            JSON.stringify([pv.counts, ap]),
          ));
          // 복사 값 조회는 다른 root, 없는 파일에 null, 이상한 id는 거절
          const cs = [await f.call('gallery:get-copy-source', o), await f.call('gallery:get-copy-source', 999999)];
          const csBad = [await errOf(f.call('gallery:get-copy-source', 'a')), await errOf(f.call('gallery:get-copy-source', 0)), await errOf(f.call('gallery:get-copy-source', 1.5))];
          out.push(sub('24e getCopySource: 다른 root, 없는 id는 null, 이상한 id는 거절', cs.every((x) => x === null) && csBad.every((x) => x !== null), JSON.stringify([cs, csBad])));
        });

        // 24g 기록 파일에 못 쓰면 거절, DB 그대로
        await scene('24g', async () => {
          const P = prep('nojournal', NAMES);
          fs.mkdirSync(jfile(P), { recursive: true }); // 기록 파일 자리에 폴더 → 쓸 수 없음
          const f = makeFake(P);
          const ids = TARGETS.map((n) => idOf(f, n));
          const edit = COPY_LOC(idOf(f, 'src.jpg'));
          const msg = await errOf(f.call('gallery:apply-edit', ids, edit));
          const st = await f.call('gallery:get-state');
          const a = await fileOf(f, 'a.jpg');
          out.push(sub(
            '24g 기록 파일에 못 쓰면 넣기를 거절하고(이유를 알림) DB, 알림, 로그가 그대로',
            typeof msg === 'string' && msg.includes('기록') && noPath(P, msg) && msg.includes('EISDIR') && st.manualCount === 0 && st.lastBatch === null && a.lat === null && f.sent.length === 0 && logNames(P, 'manual-edit').length === 0,
            msg,
          ));
          // 되돌리기도 마찬가지: 기록 파일에 못 쓰면 되돌리지 않음
          f.db.applyManualBatch({ id: 'pre', root: P.root, kind: 'location', createdAt: '2026-11-01T10:00:00', items: [{ path: path.join(P.root, 'a.jpg'), before: null, after: val({ lat: 1, lng: 2 }) }] });
          const msg2 = await errOf(f.call('gallery:undo-last', 'pre'));
          const st2 = await f.call('gallery:get-state');
          out.push(sub('24g 되돌리기도 기록 파일에 못 쓰면 거절하고 DB 그대로', typeof msg2 === 'string' && msg2.includes('기록') && noPath(P, msg2) && msg2.includes('EISDIR') && st2.lastBatch && st2.lastBatch.count === 1 && (await fileOf(f, 'a.jpg')).lat === 1, msg2));
        });

        // 24h DB 저장이 실패하면 void 줄이 생기고, 다시 켜도 값이 들어가지 않음
        await scene('24h', async () => {
          const P = prep('dbfail', NAMES);
          let f = makeFake(P);
          const ids = TARGETS.map((n) => idOf(f, n));
          const edit = COPY_LOC(idOf(f, 'src.jpg'));
          hooks.failApply = true;
          hooks.leak = jfile(P); // 원래 오류 글에 경로가 섞여 있어도 화면에는 안 나가야 해요
          const msg = await errOf(f.call('gallery:apply-edit', ids, edit));
          hooks.failApply = false;
          hooks.leak = '';
          const lines = jlines(P);
          const st = await f.call('gallery:get-state');
          out.push(sub(
            '24h DB 저장이 실패하면 거절(이유를 알림), 기록 파일에 apply 뒤 void, DB, 알림, 로그가 그대로',
            typeof msg === 'string' && msg.includes('저장하지 못했어요') && noPath(P, msg) && !msg.includes('일부러 낸') && logText(P, 'gallery-error').includes('일부러 낸 저장 오류') && logText(P, 'gallery-error').includes('manual-edits') && lines.length === 2 && lines[0].type === 'apply' && lines[1].type === 'void' && lines[1].of === 'apply' && lines[1].batchId === lines[0].batchId
              && st.manualCount === 0 && f.sent.length === 0 && logNames(P, 'manual-edit').length === 0,
            JSON.stringify([msg, lines.map((l) => l.type)]),
          ));
          f.g.close();
          f = makeFake(P); // 다시 켜서 복구
          const st2 = await f.call('gallery:get-state');
          out.push(sub('24h 다시 켜서 복구해도 void 붙은 묶음은 값이 들어가지 않음', st2.manualCount === 0 && f.db.getManual(path.join(P.root, 'a.jpg')) === null && jlines(P).length === 2, JSON.stringify([st2.manualCount, jlines(P).length])));

          // void 줄도 못 쓰면: 오류 글에 "다시 적용될 수 있음"을 알리고 로그에 남김
          const P2 = prep('dbfail2', NAMES);
          const f2 = makeFake(P2);
          hooks.failApply = true;
          hooks.failVoid = true;
          hooks.leak = jfile(P2);
          const msg2 = await errOf(f2.call('gallery:apply-edit', TARGETS.map((n) => idOf(f2, n)), COPY_LOC(idOf(f2, 'src.jpg'))));
          hooks.failApply = false;
          hooks.failVoid = false;
          hooks.leak = '';
          out.push(sub(
            '24h void 줄도 못 쓰면 오류 글에 "다시 적용될 수 있어요"를 알리고 오류 로그에 남김',
            typeof msg2 === 'string' && msg2.includes('다시 적용될 수 있어요') && noPath(P2, msg2) && logText(P2, 'gallery-error').includes('void') && logText(P2, 'gallery-error').includes('manual-edits'),
            msg2,
          ));

          // 되돌리기 저장이 실패하면 undo 뒤 void(of undo), 값은 남고 다시 켜도 남음
          const P3 = prep('undofail', NAMES);
          let f3 = makeFake(P3);
          await f3.call('gallery:apply-edit', TARGETS.map((n) => idOf(f3, n)), COPY_LOC(idOf(f3, 'src.jpg')));
          hooks.failUndo = true;
          hooks.leak = jfile(P3);
          const msg3 = await errOf(f3.call('gallery:undo-last', await lastBatchId(f3)));
          hooks.failUndo = false;
          hooks.leak = '';
          const l3 = jlines(P3);
          const sentAfterFail = f3.sent.length;
          f3.g.close();
          f3 = makeFake(P3);
          const st3 = await f3.call('gallery:get-state');
          out.push(sub(
            '24h 되돌리기 저장이 실패하면 거절, 기록 파일에 undo 뒤 void(of undo), 값이 남고 다시 켜도 남음',
            typeof msg3 === 'string' && noPath(P3, msg3) && l3.map((l) => l.type).join() === 'apply,undo,void' && l3[2].of === 'undo' && sentAfterFail === 1
              && st3.manualCount === 3 && st3.lastBatch && st3.lastBatch.count === 3,
            JSON.stringify([msg3, l3.map((l) => l.type), st3.manualCount]),
          ));
        });

        // 24h 저장이 끝난 뒤 로그나 알림이 실패해도 작업은 성공 (void 를 적지 않음)
        await scene('24h2', async () => {
          const P = prep('afterfail', NAMES);
          let f = makeFake(P);
          const ids = TARGETS.map((n) => idOf(f, n));
          hooks.failLog = true;
          hooks.failSend = true;
          const ap = await f.call('gallery:apply-edit', ids, COPY_LOC(idOf(f, 'src.jpg'))).then((v) => v, (e) => ({ error: e.message }));
          const un = await f.call('gallery:undo-last', await lastBatchId(f)).then((v) => v, (e) => ({ error: e.message }));
          hooks.failLog = false;
          hooks.failSend = false;
          const types = jlines(P).map((l) => l.type).join();
          const ap2 = await f.call('gallery:apply-edit', ids, COPY_LOC(idOf(f, 'src.jpg')));
          f.g.close();
          f = makeFake(P);
          const st = await f.call('gallery:get-state');
          out.push(sub(
            '24h 저장이 끝난 뒤 로그나 알림이 실패해도 넣기, 되돌리기는 성공하고 void 줄이 생기지 않음 (다시 켜도 값이 그대로)',
            ap.count === 3 && un && un.count === 3 && types === 'apply,undo' && ap2.count === 3 && st.manualCount === 3 && jlines(P).map((l) => l.type).join() === 'apply,undo,apply',
            JSON.stringify([ap, un, types]),
          ));
        });

        // 24h 되돌리기 로그의 파일별 줄을 만들다 던져도 저장된 되돌리기는 성공
        await scene('24h3', async () => {
          const P = prep('itemsfail', NAMES);
          const f = makeFake(P);
          await f.call('gallery:apply-edit', TARGETS.map((n) => idOf(f, n)), COPY_LOC(idOf(f, 'src.jpg')));
          hooks.failItems = true;
          const un = await f.call('gallery:undo-last', await lastBatchId(f)).then((v) => v, (e) => ({ error: e.message }));
          hooks.failItems = false;
          const st = await f.call('gallery:get-state');
          out.push(sub(
            '24h 되돌리기 로그의 파일별 줄을 만들다 던져도 되돌리기는 성공하고(void 없음, 알림 보냄) 오류 로그에 남음',
            un.count === 3 && jlines(P).map((l) => l.type).join() === 'apply,undo' && st.manualCount === 0 && f.sent.length === 2 && logText(P, 'gallery-error').includes('일부러 낸 항목 읽기 오류'),
            JSON.stringify([un, f.sent.length]),
          ));
        });

        // 24i 켤 때 복구: library.db를 지우고 다시 켜면 값이 돌아옴. 복구가 실패해도 갤러리는 켜짐
        await scene('24i', async () => {
          const P = prep('recover', NAMES);
          let f = makeFake(P);
          const ids = TARGETS.map((n) => idOf(f, n));
          const edit = COPY_LOC(idOf(f, 'src.jpg'));
          await f.call('gallery:apply-edit', ids, edit);
          await f.call('gallery:apply-edit', [idOf(f, 'a.jpg')], { source: 'direct', date: '2024-03-05', time: '12:00:00' });
          await f.call('gallery:undo-last', await lastBatchId(f)); // 두 번째 묶음은 되돌림
          const undoLog = logNames(P, 'manual-edit').map((n) => fs.readFileSync(path.join(P.logDir, n), 'utf8')).filter((t) => t.startsWith('직접 넣은 값 되돌리기')).join(' | ');
          out.push(sub(
            '24i 앞선 직접 넣은 값이 있던 파일의 되돌리기 로그: 날짜 2024-03-05T12:00:00 → 없음, 위치는 37.5,127 → 37.5,127',
            undoLog.includes(path.join(P.root, 'a.jpg')) && undoLog.includes('2024-03-05T12:00:00 → 없음') && undoLog.includes('37.5,127 → 37.5,127'),
            undoLog.slice(0, 300),
          ));
          f.g.close();
          for (const ext of ['', '-wal', '-shm']) fs.rmSync(path.join(P.ud, `library.db${ext}`), { force: true });
          f = makeFake(P);
          const aPath = path.join(P.root, 'a.jpg');
          const st = await f.call('gallery:get-state');
          // 사진을 다시 읽는 것처럼 파일 줄을 넣으면 직접 넣은 값이 이김
          f.db.upsertFiles(NAMES.map((n, i) => rowOf(P.root, n, i)));
          const a = await fileOf(f, 'a.jpg');
          const startLog = fs.existsSync(P.logDir) ? fs.readdirSync(P.logDir).filter((n) => n.startsWith('gallery-start_')).map((n) => fs.readFileSync(path.join(P.logDir, n), 'utf8')).join('\n') : '';
          out.push(sub(
            '24i library.db를 지우고 다시 켜면 기록 파일에서 값이 돌아옴 (되돌린 묶음은 되돌린 대로)',
            st.manualCount === 0 /* 파일 줄이 아직 없음 */ && same(f.db.getManual(aPath), val({ lat: 37.5, lng: 127 })) && a.lat === 37.5 && a.locationSource === 'manual' && a.takenAtSource === 'exif',
            JSON.stringify([st.manualCount, f.db.getManual(aPath), a.lat, a.locationSource]),
          ));
          out.push(sub('24i 복구한 묶음 수를 시작 로그에 남김', startLog.includes('넣기 2개') && startLog.includes('되돌리기 1개'), startLog.slice(0, 200)));

          // 묶음 하나를 DB에 적용하다 실패하면 그 묶음 번호와 이유가 시작 로그에 남음 (갤러리는 켜짐)
          {
            const P3 = prep('recover-reason', NAMES);
            let g = makeFake(P3);
            await g.call('gallery:apply-edit', [idOf(g, 'a.jpg')], COPY_LOC(idOf(g, 'src.jpg')));
            const failedId = await lastBatchId(g);
            g.g.close();
            for (const ext of ['', '-wal', '-shm']) fs.rmSync(path.join(P3.ud, `library.db${ext}`), { force: true });
            hooks.failApply = true;
            hooks.leak = '';
            g = makeFake(P3);
            hooks.failApply = false;
            const stG = await g.call('gallery:get-state');
            const text = logText(P3, 'gallery-start');
            out.push(sub(
              '24i 복구에 실패한 묶음의 번호, 종류, 이유가 시작 로그에 남고 갤러리는 켜짐',
              !!stG && stG.manualCount === 0 && text.includes(failedId) && text.includes('apply') && text.includes('일부러 낸 저장 오류') && text.includes('건너뜀 1개'),
              text.replace(/s+/g, " ").slice(0, 300),
            ));
            g.g.close();
          }

          // 복구가 오류를 내도 갤러리는 켜지고 오류 로그만 남김
          const P2 = prep('recover-fail', NAMES);
          hooks.failRecover = true;
          let f2;
          let thrown = null;
          try {
            f2 = makeFake(P2);
          } catch (e) {
            thrown = e.message;
          }
          hooks.failRecover = false;
          const st2 = f2 ? await f2.call('gallery:get-state') : null;
          out.push(sub('24i 복구가 오류를 내도 갤러리는 켜지고(getState 동작) 오류 로그만 남음', thrown === null && !!st2 && st2.total === 4 && logText(P2, 'gallery-error').includes('일부러 낸 복구 오류'), thrown || JSON.stringify(st2 && st2.total)));
        });

        // 24l 기준 사진이 사라졌으면 미리보기, 넣기 거절
        await scene('24l', async () => {
          const P = prep('nosource', NAMES);
          const f = makeFake(P);
          f.db.upsertFiles([row({ root: 'R-other', path: 'R-other/o.jpg', name: 'o.jpg', lat: 1, lng: 2, locationSource: 'gps' })]);
          const ids = TARGETS.map((n) => idOf(f, n));
          const src = idOf(f, 'src.jpg');
          f.db.setMissing([path.join(P.root, 'src.jpg')], true);
          const msgs = [
            await errOf(f.call('gallery:preview-edit', ids, COPY_LOC(src))),
            await errOf(f.call('gallery:apply-edit', ids, COPY_LOC(src))),
            await errOf(f.call('gallery:preview-edit', ids, COPY_LOC(999999))), // 아예 없는 기준
            await errOf(f.call('gallery:preview-edit', ids, COPY_LOC(fileByPath(f.db, 'R-other', 'R-other/o.jpg').id))), // 다른 root의 기준
          ];
          const cs = await f.call('gallery:get-copy-source', src);
          out.push(sub(
            '24l 기준 사진이 사라졌거나 없거나 다른 root면 미리보기, 넣기를 거절 ("다시 복사해 주세요" 포함), 복사 값 조회는 null',
            msgs.every((m) => typeof m === 'string' && m.includes('다시 복사해 주세요')) && cs === null && (await f.call('gallery:get-state')).manualCount === 0,
            JSON.stringify(msgs),
          ));
        });

        // 24m 백업 폴더가 연결되지 않아도 넣기와 되돌리기가 동작함
        await scene('24m', async () => {
          const P = prep('offline', NAMES, { makeFiles: false });
          const f = makeFake(P);
          const st0 = await f.call('gallery:get-state');
          const ids = TARGETS.map((n) => idOf(f, n));
          const ap = await f.call('gallery:apply-edit', ids, COPY_LOC(idOf(f, 'src.jpg')));
          const a = await fileOf(f, 'a.jpg');
          const un = await f.call('gallery:undo-last', await lastBatchId(f));
          out.push(sub(
            '24m 백업 폴더가 연결되지 않아도(connected false) 넣기와 되돌리기가 동작함',
            st0.connected === false && ap.count === 3 && a.lat === 37.5 && same(un, { kind: 'location', count: 3 }) && (await fileOf(f, 'a.jpg')).lat === null,
            JSON.stringify([st0.connected, ap, un]),
          ));
        });

        // 준비 안 됨: 백업 폴더가 없거나 DB를 열 수 없으면 목록은 비어 있고 넣기는 읽을 수 있는 오류
        await scene('24n', async () => {
          const P = prep('noroot', NAMES);
          const f = makeFake({ ...P, root: '' });
          const m1 = [await errOf(f.call('gallery:preview-edit', [1], { source: 'direct', date: '2024-03-05' })), await errOf(f.call('gallery:apply-edit', [1], { source: 'direct', date: '2024-03-05' })), await errOf(f.call('gallery:undo-last', 'x'))];
          const ids = await f.call('gallery:list-ids', {});
          const cs = await f.call('gallery:get-copy-source', 1);
          const st = await f.call('gallery:get-state');
          // DB 자리에 폴더가 있어 열 수 없는 경우
          const dir = path.join(base, `nodb-${++seq}`);
          fs.mkdirSync(path.join(dir, 'ud', 'library.db'), { recursive: true });
          const f2 = makeFake({ dir, root: path.resolve(dir, 'photos-root-xyz'), ud: path.join(dir, 'ud'), logDir: path.join(dir, 'logs') });
          const m2 = [await errOf(f2.call('gallery:preview-edit', [1], { source: 'direct', date: '2024-03-05' })), await errOf(f2.call('gallery:undo-last', 'x'))];
          const ids2 = await f2.call('gallery:list-ids', {});
          out.push(sub(
            '24n 백업 폴더가 없거나 DB를 열 수 없으면 넣기, 미리보기, 되돌리기는 읽을 수 있는 한국어 오류, listIds는 빈 목록, getCopySource는 null',
            m1.every((x) => typeof x === 'string' && x.includes('백업 폴더')) && same(ids, []) && cs === null && st.root === '' && st.lastBatch === null
              && m2.every((x) => typeof x === 'string' && x.includes('library.db') && !x.includes(dir) && !x.includes(path.sep)) && same(ids2, []),
            JSON.stringify([m1, m2]),
          ));
        });

        // 24o 되돌리기는 화면이 보낸 묶음 번호가 지금 마지막 묶음일 때만 (두 번 눌러도 앞 묶음까지 되돌리지 않음)
        await scene('24o', async () => {
          const P = prep('undoid', NAMES);
          const f = makeFake(P);
          const ids = TARGETS.map((n) => idOf(f, n));
          const A = await f.call('gallery:apply-edit', ids, COPY_LOC(idOf(f, 'src.jpg')));
          const B = await f.call('gallery:apply-edit', [idOf(f, 'a.jpg')], { source: 'direct', date: '2024-03-05', time: '12:00:00' });
          const snap = async () => JSON.stringify([jlines(P).length, (await f.call('gallery:get-state')).lastBatch, (await f.call('gallery:get-state')).manualCount, await fileOf(f, 'a.jpg'), await fileOf(f, 'b.jpg')]);
          const s0 = await snap();
          // 마지막이 아닌 묶음의 번호, 모양이 틀린 번호: 거절하고 기록 파일, DB 모두 그대로
          const stale = await errOf(f.call('gallery:undo-last', A.batchId));
          const bad = [await errOf(f.call('gallery:undo-last')), await errOf(f.call('gallery:undo-last', '')), await errOf(f.call('gallery:undo-last', 123)), await errOf(f.call('gallery:undo-last', { id: B.batchId })), await errOf(f.call('gallery:undo-last', 'x'.repeat(101)))];
          const unchanged = (await snap()) === s0;
          out.push(sub(
            '24o 마지막이 아닌 묶음 번호는 "작업이 바뀌었어요"로, 번호가 없거나 모양이 틀리면 "올바르지 않아요"로 거절하고 기록 파일 줄, 마지막 묶음, 파일 값이 그대로',
            typeof stale === 'string' && stale.includes('바뀌었어요') && bad.every((m) => typeof m === 'string' && m.includes('올바르지 않아요')) && unchanged,
            JSON.stringify([stale, bad, unchanged]),
          ));
          // 맞는 번호는 되돌리고, 같은 번호로 한 번 더 누르면(두 번 클릭) 거절 - 앞 묶음 A는 그대로 남음
          const un = await f.call('gallery:undo-last', B.batchId);
          const again = await errOf(f.call('gallery:undo-last', B.batchId));
          const st = await f.call('gallery:get-state');
          const a = await fileOf(f, 'a.jpg');
          out.push(sub(
            '24o 맞는 번호는 되돌리고, 같은 번호로 다시 누르면 거절되어 앞 묶음(위치 3장)은 되돌려지지 않음',
            same(un, { kind: 'date', count: 1 }) && typeof again === 'string' && again.includes('바뀌었어요') && st.lastBatch && st.lastBatch.id === A.batchId && st.manualCount === 3 && a.locationSource === 'manual' && a.takenAtSource === 'exif',
            JSON.stringify([un, again, st.lastBatch && st.lastBatch.id === A.batchId, st.manualCount, a.locationSource, a.takenAtSource]),
          ));
          // 되돌릴 묶음이 하나도 없으면 번호가 있어도 null
          await f.call('gallery:undo-last', A.batchId);
          out.push(sub('24o 되돌릴 묶음이 없으면 null', (await f.call('gallery:undo-last', A.batchId)) === null));
        });

        // 24k 3,277장 넣기 시간 (10초 넘으면 실패)
        await scene('24k', async () => {
          const dir = path.join(base, `big-${++seq}`);
          const P = { dir, root: path.resolve(dir, 'photos-root-xyz'), ud: path.join(dir, 'ud'), logDir: path.join(dir, 'logs') };
          fs.mkdirSync(P.ud, { recursive: true });
          const o = openDb(path.join(P.ud, 'library.db'));
          o.db.upsertFiles([rowOf(P.root, 'src.jpg', 0)]); // 먼저 넣어서 id 1
          fillFakeLibrary(o.db, P.root, 3277);
          o.db.close();
          const f = makeFake(P);
          const all = f.db.listIds(P.root, { tab: 'all', sort: 'newest', query: '', tag: null }).filter((i) => i !== 1);
          const edit = COPY_LOC(1);
          const t0 = Date.now();
          const pv = await f.call('gallery:preview-edit', all, edit);
          const t1 = Date.now();
          const ap = await f.call('gallery:apply-edit', all, edit);
          const t2 = Date.now();
          const un = await f.call('gallery:undo-last', await lastBatchId(f));
          const t3 = Date.now();
          const lineCount = jlines(P).length;
          out.push(sub(
            '24k 3,277장 미리보기, 넣기, 되돌리기가 되고 넣기는 10초 안에 끝남 (시간은 detail)',
            all.length === 3277 && pv.counts.changed === 3277 && ap.count === 3277 && un.count === 3277 && t2 - t1 < 10000 && lineCount === 2,
            `미리보기 ${t1 - t0}ms, 넣기 ${t2 - t1}ms, 되돌리기 ${t3 - t2}ms, 장수 ${all.length}, 기록 줄 ${lineCount}`,
          ));
        });
      } finally {
        for (const f of fakes) {
          try { f.g.close(); } catch (e) { /* 이미 닫힘 */ }
        }
      }
      return out;
    },
  },
  {
    no: 25,
    name: '여러 장 선택 계산',
    async run(env) {
      const out = [];
      // src/selection.mjs 는 React가 없는 순수 계산이에요 (grid-layout.mjs 점검과 같이 file:// 주소로 불러와요)
      const { pathToFileURL } = require('url');
      let m;
      try {
        m = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'selection.mjs')).href);
      } catch (e) {
        return [sub('src/selection.mjs 불러오기', false, e.message)];
      }
      const { nextSelection, needsWholeList, EMPTY_SELECTION, selectionOf, selectionForMenu, filterScope, viewMatches } = m;
      const sorted = (sel) => [...sel.ids].sort((a, b) => a - b).join();
      const D = [10, 11, 12, 13, 14].map((id) => ({ id })); // 한 날의 파일 5장
      const none = EMPTY_SELECTION;

      // 25a 클릭: 한 장만, anchor와 focus는 그 파일. 이미 여러 장이어도 그 한 장만 남아요
      const a1 = nextSelection(none, { id: 11, dayFiles: D });
      const a2 = nextSelection(nextSelection(a1, { id: 13, ctrl: true, dayFiles: D }), { id: 12, dayFiles: D });
      out.push(sub('25a 클릭은 그 한 장만 고르고 anchor, focus도 그 파일', sorted(a1) === '11' && a1.anchor === 11 && a1.focus === 11 && sorted(a2) === '12' && a2.focus === 12, JSON.stringify([[...a1.ids], a1.anchor, a1.focus, [...a2.ids]])));

      // 25b Ctrl+클릭: 더하기, 같은 칸에 다시 하면 빼기. 받은 sel은 바꾸지 않아요
      const b1 = nextSelection(a1, { id: 13, ctrl: true, dayFiles: D });
      const b2 = nextSelection(b1, { id: 13, ctrl: true, dayFiles: D });
      out.push(sub('25b Ctrl+클릭은 더하고 다시 하면 뺌, 받은 선택은 그대로', sorted(b1) === '11,13' && b1.focus === 13 && b1.anchor === 13 && sorted(b2) === '11' && b2.anchor === 13 && sorted(a1) === '11' && sorted(none) === '', JSON.stringify([[...b1.ids], [...b2.ids], [...a1.ids]])));
      const b3 = nextSelection(a1, { id: 11, ctrl: true, dayFiles: D });
      out.push(sub('25b 마지막 한 장을 빼면 빈 선택, focus는 null', sorted(b3) === '' && b3.focus === null, JSON.stringify([[...b3.ids], b3.focus])));

      // 25c Shift+클릭: 같은 날 anchor부터 범위. anchor가 그 날에 없으면 그 칸 한 장
      const c1 = nextSelection(nextSelection(none, { id: 11, dayFiles: D }), { id: 13, shift: true, dayFiles: D });
      out.push(sub('25c Shift+클릭은 anchor부터 누른 칸까지, anchor는 그대로 focus는 누른 칸', sorted(c1) === '11,12,13' && c1.anchor === 11 && c1.focus === 13, JSON.stringify([[...c1.ids], c1.anchor, c1.focus])));
      const other = [{ id: 20 }, { id: 21 }, { id: 22 }]; // 다른 날
      const c2 = nextSelection(c1, { id: 21, shift: true, dayFiles: other });
      out.push(sub('25c anchor가 그 날 파일에 없으면(다른 날) 누른 칸 한 장으로', sorted(c2) === '21' && c2.anchor === 21 && c2.focus === 21, JSON.stringify([[...c2.ids], c2.anchor, c2.focus])));

      // 25d 앞뒤 어느 방향이든 범위가 같음, 한 칸에 Shift+클릭하면 그 한 장
      const d1 = nextSelection(nextSelection(none, { id: 13, dayFiles: D }), { id: 11, shift: true, dayFiles: D });
      const d2 = nextSelection(nextSelection(none, { id: 11, dayFiles: D }), { id: 13, shift: true, dayFiles: D });
      const d3 = nextSelection(nextSelection(none, { id: 12, dayFiles: D }), { id: 12, shift: true, dayFiles: D });
      out.push(sub('25d 거꾸로 눌러도 같은 범위, 같은 칸이면 한 장', sorted(d1) === sorted(d2) && sorted(d1) === '11,12,13' && d1.anchor === 13 && sorted(d3) === '12', JSON.stringify([[...d1.ids], [...d2.ids], [...d3.ids]])));
      // Shift+클릭을 이어서 하면 anchor는 그대로라 범위가 줄었다 늘었다 해요
      const d4 = nextSelection(c1, { id: 12, shift: true, dayFiles: D });
      out.push(sub('25d anchor는 그대로라 Shift+클릭을 이어서 하면 범위가 새로 정해짐', sorted(d4) === '11,12' && d4.anchor === 11, JSON.stringify([...d4.ids])));

      // 25e 고른 것이 없을 때 Shift+클릭은 한 장
      const e1 = nextSelection(none, { id: 12, shift: true, dayFiles: D });
      out.push(sub('25e 고른 것이 없을 때 Shift+클릭은 한 장', sorted(e1) === '12' && e1.anchor === 12 && e1.focus === 12, JSON.stringify([[...e1.ids], e1.anchor])));
      const e2 = nextSelection(none, { id: 12, shift: true });
      out.push(sub('25e dayFiles가 없어도 오류 없이 한 장', sorted(e2) === '12'));

      // 25f Ctrl+Shift+클릭: 범위를 기존 선택에 더함
      const f1 = nextSelection(nextSelection(nextSelection(none, { id: 10, dayFiles: D }), { id: 14, ctrl: true, dayFiles: D }), { id: 12, ctrl: true, shift: true, dayFiles: D });
      out.push(sub('25f Ctrl+Shift+클릭은 anchor부터 범위를 기존 선택에 더함', sorted(f1) === '10,12,13,14' && f1.anchor === 14, JSON.stringify([[...f1.ids], f1.anchor])));

      // 25g 통째로 고르기와 우클릭
      const g1 = selectionOf([3, 1, 2]);
      out.push(sub('25g 통째로 고르면 anchor, focus 없음, 빈 목록은 빈 선택', sorted(g1) === '1,2,3' && g1.anchor === null && g1.focus === null && sorted(selectionOf([])) === ''));
      const g2 = selectionForMenu(b1, 11);
      const g3 = selectionForMenu(b1, 12);
      out.push(sub('25g 우클릭: 선택 안에 있는 칸이면 그대로, 밖이면 그 칸만', g2 === b1 && sorted(g3) === '12' && g3.focus === 12 && g3.anchor === 12, JSON.stringify([[...g3.ids], g3.focus])));

      // 25h 화면에 보이는 목록(view)이 지금 필터의 것일 때만 고르기를 받아요 (바뀐 직후 옛 목록의 번호가 섞이지 않게)
      const F = (over = {}) => ({ tab: 'all', sort: 'newest', query: '', tag: null, ...over });
      const V = (filter) => ({ key: JSON.stringify(filter), filter, days: [], gen: 0 });
      out.push(sub('25h 필터가 같은 목록이면 받음, 정렬만 달라도 받음', viewMatches(V(F()), F()) === true && viewMatches(V(F()), F({ sort: 'oldest' })) === true && viewMatches(V(F({ info: 'noDate' })), F({ info: 'noDate' })) === true));
      out.push(sub(
        '25h 탭, 정보 없음 탭, 검색어, 태그가 다른 옛 목록과 목록이 없을 때는 거절',
        viewMatches(V(F()), F({ tab: 'photo' })) === false
          && viewMatches(V(F()), F({ info: 'noLocation' })) === false // 갤러리 -> 정보 없는 사진 화면
          && viewMatches(V(F({ info: 'noLocation' })), F()) === false // 정보 없는 사진 화면 -> 갤러리
          && viewMatches(V(F({ info: 'noLocation' })), F({ info: 'manual' })) === false
          && viewMatches(V(F()), F({ query: 'a' })) === false
          && viewMatches(V(F()), F({ tag: '여행' })) === false
          && viewMatches(null, F()) === false,
      ));
      out.push(sub('25h filterScope: 빈 값 info/tag는 없는 것과 같음', filterScope(F()) === filterScope(F({ info: undefined, tag: null })) && filterScope(F({ info: 'noDate' })) !== filterScope(F())));

      // 25i 날을 넘는 Shift 범위 (2026-11-21 사용자 지적 "쉬프트로 범위 선택이 안 됨"): anchor 가 그 날에 없으면 목록 전체 번호로 범위를 세요
      const W = [10, 11, 12, 13, 14, 20, 21, 22]; // 목록 전체 번호 (화면 순서: D 의 날 → other 의 날)
      out.push(sub('25i needsWholeList: Shift 이고 anchor 가 다른 날일 때만 목록 전체가 필요',
        needsWholeList(c1, { shift: true, dayFiles: other }) === true
          && needsWholeList(c1, { shift: true, dayFiles: D }) === false
          && needsWholeList(c1, { shift: false, dayFiles: other }) === false
          && needsWholeList(none, { shift: true, dayFiles: other }) === false
          && needsWholeList(selectionOf([10, 11]), { shift: true, dayFiles: other }) === false));
      const i1 = nextSelection(a1, { id: 21, shift: true, dayFiles: W });
      const i2 = nextSelection(nextSelection(none, { id: 21, dayFiles: other }), { id: 12, shift: true, dayFiles: W });
      const i3 = nextSelection(b1, { id: 20, ctrl: true, shift: true, dayFiles: W }); // b1 = 11, 13 고름 (anchor 13)
      out.push(sub('25i 목록 전체 번호로는 날을 넘어 anchor 부터 누른 칸까지 (거꾸로도), Ctrl+Shift 는 기존 선택에 더함',
        sorted(i1) === '11,12,13,14,20,21' && i1.anchor === 11 && i1.focus === 21 && sorted(i2) === '12,13,14,20,21' && sorted(i3) === '11,13,14,20',
        JSON.stringify([[...i1.ids], [...i2.ids], [...i3.ids]])));
      {
        const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
        const start = app.indexOf('const onCellClick = useCallback(');
        const body = start < 0 ? '' : app.slice(start, app.indexOf('}, []);', start));
        out.push(sub('25i App 칸 클릭: needsWholeList 면 api.listIds(지금 목록 필터)로 받아 범위, 받는 사이 필터가 바뀌면 버림',
          body.includes('needsWholeList(selectionRef.current') && body.includes('api.listIds(viewFilterRef.current)') && body.includes('scopeRef.current !== at')));
      }

      // 25j 진짜 앱: 다른 두 날의 사진에서 클릭 → Shift+클릭하면 두 날에 걸친 범위가 모두 골라짐, Ctrl+클릭은 더하기
      {
        const { launchCheck } = require('./launch-check');
        const { makeImage } = require('./check-similar');
        const root = path.join(env.tmp, 'launch-range-root');
        // 이름의 날짜로 찍은 날이 정해져요: 03.05 에 3장, 03.01 에 3장 (화면은 최근 날이 위)
        for (let i = 1; i <= 6; i++) await makeImage(path.join(root, `KakaoTalk_2026030${i <= 3 ? 1 : 5}_10000${i}.jpg`), { seed: i * 7 });
        const ud = path.join(env.tmp, 'launch-range-ud');
        fs.mkdirSync(ud, { recursive: true });
        fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ backupRoot: root }), 'utf8');
        const r = await launchCheck(path.join(__dirname, '..'), {
          env: { PVM_USER_DATA: ud },
          until: '백업 폴더 다시 읽기',
          untilMs: 30000,
          probe: `(${rangeProbe.toString()})()`,
        });
        const q = r.probed || {};
        out.push(sub('25j 진짜 앱: 03.05 첫 칸 클릭 → 03.01 두 번째 칸 Shift+클릭 = 5장, Ctrl+클릭으로 1장 더해 6장, 화면 오류 없음',
          q.days === '03.05,03.01' && q.afterClick === '100000' && q.afterShift === '111110' && q.afterCtrl === '111111' && !(r.errors || []).some((e) => !/Failed to load resource/.test(e)),
          `${JSON.stringify(q).slice(0, 300)} / 오류 ${(r.errors || []).length}개`));
      }
      return out;
    },
  },
  {
    no: 26,
    name: '버튼 문구',
    async run() {
      const out = [];
      // src/format.mjs 도 React가 없는 순수 글자 만들기예요 (file:// 주소로 불러와요)
      const { pathToFileURL } = require('url');
      let m;
      try {
        m = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'format.mjs')).href);
      } catch (e) {
        return [sub('src/format.mjs 불러오기', false, e.message)];
      }
      const { applyLabel, undoLabel, appliedText, undoneText, needsManyCheck, manyCheckText } = m;
      // 사용자 결정 (2026-11-04): 100장 이상에 한 번에 넣을 때는 체크를 한 번 더 받아요
      out.push(sub('26g 100장 이상이면 체크 한 번 더 ("1,234장에 한 번에 넣는 것이 맞아요"), 99장 이하는 없음',
        typeof needsManyCheck === 'function' && needsManyCheck(100) && !needsManyCheck(99) && !needsManyCheck(0)
          && manyCheckText(1234) === '1,234장에 한 번에 넣는 것이 맞아요' && manyCheckText(99) === ''));
      out.push(sub('26a applyLabel(1234, location) === "1,234장에 위치 넣기" (천 단위 쉼표)', typeof applyLabel === 'function' && applyLabel(1234, 'location') === '1,234장에 위치 넣기', typeof applyLabel === 'function' ? applyLabel(1234, 'location') : '함수 없음'));
      out.push(sub('26b applyLabel(3, both) === "3장에 날짜와 위치 넣기", date는 날짜', typeof applyLabel === 'function' && applyLabel(3, 'both') === '3장에 날짜와 위치 넣기' && applyLabel(1, 'date') === '1장에 날짜 넣기'));
      out.push(sub('26c 0장이거나 모르는 종류면 빈 글자 (화면은 버튼을 끄고 "바꿀 사진이 없어요"를 보임)', typeof applyLabel === 'function' && applyLabel(0, 'date') === '' && applyLabel(0, 'location') === '' && applyLabel(5, 'nope') === '' && applyLabel(undefined, 'date') === ''));
      out.push(sub('26d undoLabel(2, date) === "2장 날짜 되돌리기", 124장 위치, 0장은 빈 글자', typeof undoLabel === 'function' && undoLabel(2, 'date') === '2장 날짜 되돌리기' && undoLabel(124, 'location') === '124장 위치 되돌리기' && undoLabel(7, 'both') === '7장 날짜와 위치 되돌리기' && undoLabel(0, 'date') === ''));
      out.push(sub('26e appliedText: 넣은 직후 알림 줄 글 ("124장에 위치를 넣었어요")', typeof appliedText === 'function' && appliedText(124, 'location') === '124장에 위치를 넣었어요' && appliedText(3, 'date') === '3장에 날짜를 넣었어요' && appliedText(3, 'both') === '3장에 날짜와 위치를 넣었어요' && appliedText(0, 'date') === ''));
      out.push(sub(
        '26f undoneText: 되돌린 직후 알림 줄 글 ("4장 위치를 되돌렸어요"), 0장이나 모르는 종류는 빈 글자',
        typeof undoneText === 'function' && undoneText(4, 'location') === '4장 위치를 되돌렸어요' && undoneText(1234, 'date') === '1,234장 날짜를 되돌렸어요' && undoneText(2, 'both') === '2장 날짜와 위치를 되돌렸어요' && undoneText(0, 'date') === '' && undoneText(3, 'nope') === '',
        typeof undoneText === 'function' ? undoneText(4, 'location') : '함수 없음',
      ));
      return out;
    },
  },
  {
    no: 27,
    name: '정보 없는 사진 화면 열기',
    async run(env) {
      // 샘플 복사본을 백업 폴더로 정한 임시 userData로 앱을 띄우고, 왼쪽 메뉴 "정보 없는 사진"을 눌러 탭 글자와 화면 오류를 봐요
      //   (진짜 설정, 진짜 사진은 읽지 않아요. 눌러 보는 것은 메뉴 하나뿐이고 값은 넣지 않아요)
      const out = [];
      const APP = path.join(__dirname, '..');
      const { launchCheck } = require('./launch-check');
      const copyRoot = path.join(env.tmp, 'launch-missing-root');
      fs.cpSync(path.join(APP, 'test', 'samples', 'auto'), copyRoot, { recursive: true });
      const ud = path.join(env.tmp, 'launch-missing-ud');
      fs.mkdirSync(ud, { recursive: true });
      fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ backupRoot: copyRoot }), 'utf8');
      const r = await launchCheck(APP, {
        env: { PVM_USER_DATA: ud },
        until: '10.28', // 사진을 다 읽어 와서 갤러리에 날짜가 보일 때까지
        clickText: '정보 없는 사진',
        clickUntil: '내가 넣은 정보', // 눌러서 화면이 바뀌면 탭 글자가 보여요
        probe: "(document.querySelector('nav [aria-current=page] .menu-label') || {}).textContent || ''",
      });
      const tabs = ['위치 없음', '날짜 없음', '내가 넣은 정보'];
      out.push(sub('27a 메뉴를 눌렀고 눌린 메뉴가 "정보 없는 사진"으로 표시됨', r.clicked === true && r.probed === '정보 없는 사진', `눌림 ${r.clicked}, 표시된 메뉴 "${r.probed}"`));
      out.push(sub('27b 탭 글자 "위치 없음", "날짜 없음", "내가 넣은 정보"가 보임', tabs.every((t) => String(r.text).includes(t)), `화면 글자: ${String(r.text).slice(0, 200).replace(/s+/g, ' ')}`));
      out.push(sub('27c 화면 오류 없음, 정상 종료, 불러오지 못했다는 글 없음', r.errors.length === 0 && r.exitCode === 0 && !String(r.text).includes('불러오지 못했어요'), `${r.errors.join(' / ')} 종료 코드 ${r.exitCode}`));
      return out;
    },
  },
];

// 25j 진짜 앱 창 안에서 도는 확인 (launch-check 의 probe). 칸을 누르기만 하고 옮기기 · 지우기는 하지 않아요
async function rangeProbe() {
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const cells = () => [...document.querySelectorAll('button.cell')];
  for (let i = 0; i < 150 && cells().length < 6; i++) await sleep(200);
  const state = () => cells().map((b) => (b.getAttribute('aria-pressed') === 'true' ? 1 : 0)).join('');
  const click = async (i, opts = {}) => {
    cells()[i].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...opts }));
    await sleep(600); // 날을 넘는 범위는 목록 번호를 받아 오는 시간이 있어요
  };
  const days = [...document.querySelectorAll('.day-date')].map((d) => d.innerText).join(',');
  await click(0);
  const afterClick = state();
  await click(4, { shiftKey: true });
  const afterShift = state();
  await click(5, { ctrlKey: true });
  const afterCtrl = state();
  return { days, afterClick, afterShift, afterCtrl };
}

module.exports = { items };

// ---------- 이 파일만 바로 실행할 때 ----------
//   임시 폴더: os.tmpdir()/pvm-check-시각 (check.js 와 같은 이름 규칙). 모두 통과하면 지워요.
if (require.main === module) {
  (async () => {
    const { stamp } = require('../lib/logger');
    const tmp = path.join(os.tmpdir(), `pvm-check-missing-${stamp()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const env = { tmp };
    let failed = 0;
    for (const item of items) {
      let subs;
      try {
        subs = await item.run(env);
      } catch (e) {
        subs = [sub('실행 중 오류', false, e.stack)];
      }
      const bad = subs.filter((s) => s.status === 'fail');
      if (bad.length) failed++;
      console.log(`${bad.length ? '❌' : '✅'} ${item.no}. ${item.name}`);
      for (const s of subs) {
        if (s.status === 'ok') continue;
        console.log(`      ❌ ${s.label}${s.detail ? ' — ' + s.detail : ''}`);
      }
    }
    if (failed) {
      console.log(`\n결과: ❌ ${failed}개 항목 실패 (원인 확인용 폴더: ${tmp})`);
      process.exit(1);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n결과: ✅ 모두 통과');
  })().catch((e) => {
    console.error('❌ 점검 실행 오류: ' + e.stack);
    process.exit(1);
  });
}

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
];

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

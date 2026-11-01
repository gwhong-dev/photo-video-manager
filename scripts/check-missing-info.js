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

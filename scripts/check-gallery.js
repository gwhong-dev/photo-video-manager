// 파일 위치: scripts/check-gallery.js
// 역할: 갤러리 점검 항목 (14번부터). scripts/check.js 의 ITEMS 끝에 붙어서 같이 돌아요.
//
// ⚠️ 실제 사진과 실제 userData(library.db)는 쓰지 않아요.
//    모든 DB 파일은 점검 임시 폴더(env.tmp) 안에만 만들어요.
//
// 항목 모양은 check.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');

// ---------- 도우미 ----------
const sub = (label, ok, detail = '') => ({ label, status: ok ? 'ok' : 'fail', detail });

// 시험용 파일 한 줄 (필요한 값만 덮어써서 써요)
function row(over = {}) {
  return {
    root: 'R1',
    path: 'R1/a.jpg',
    name: 'a.jpg',
    mediaType: 'photo',
    size: 100,
    mtimeMs: 1000,
    takenAt: '2026-10-25T14:00:30',
    takenOffset: '+09:00',
    takenDay: '2026-10-25',
    takenAtSource: 'exif',
    lat: null,
    lng: null,
    locationSource: null,
    model: null,
    width: 4000,
    height: 3000,
    durationSec: null,
    readError: null,
    tags: [],
    ...over,
  };
}

// 이 점검 전용 임시 폴더 (env.tmp 아래) 안에 새 DB 파일 경로를 줘요
let dbSeq = 0;
function newDbPath(env, label) {
  const dir = path.join(env.tmp, 'gallery-db');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${label}-${++dbSeq}`, 'library.db');
}

// DB를 열어서 fn을 실행하고, 끝나면 꼭 닫아요 (윈도우는 열린 파일을 지울 수 없어요)
async function withDb(env, label, fn) {
  const { openDb } = require('../lib/db');
  const file = newDbPath(env, label);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const opened = openDb(file);
  try {
    return await fn(opened.db, file, opened);
  } finally {
    opened.db.close();
  }
}

const days = (list) => list.map((d) => `${d.day}:${d.count}`).join(',');
const ALL = { tab: 'all', sort: 'newest', query: '', tag: null };

// ---------- 점검 항목 ----------
const items = [
  {
    no: 14,
    name: '갤러리 DB',
    async run(env) {
      const out = [];

      // 14a 같은 path를 두 번 저장해도 한 줄. 바뀐 파일은 썸네일 대기, missing 해제, 태그 교체
      await withDb(env, 'upsert', (db) => {
        db.upsertFiles([row({ tags: [{ name: '여행', source: 'album' }] })]);
        db.upsertFiles([row({ size: 200, tags: [{ name: '가족', source: 'album' }] })]);
        const total = db.summary('R1').total;
        out.push(sub('upsert 두 번 해도 한 줄', total === 1, `${total}줄`));

        const id = db.listFiles('R1', '2026-10-25', ALL)[0].id;
        db.setThumbState(id, 'ready');
        db.setMissing(['R1/a.jpg'], 1);
        db.upsertFiles([row({ size: 300, tags: [{ name: '가족', source: 'album' }, { name: '사진', source: 'mediaType' }] })]);
        const f = db.getFile(id);
        const tagNames = f ? f.tags.map((t) => `${t.source}:${t.name}`).sort().join(',') : '';
        out.push(sub(
          '바뀐 파일은 썸네일 대기로, missing 해제, 태그 교체',
          !!f && f.thumbState === 'none' && f.missing === 0 && f.size === 300 && tagNames === 'album:가족,mediaType:사진',
          f ? `${f.thumbState}, missing ${f.missing}, 태그 ${tagNames}` : '파일 없음',
        ));
        out.push(sub('없는 id는 null', db.getFile(999999) === null));
      });

      // 14b 탭 필터: 사진 1 + 영상 1 + 스크린샷(사진+태그) 1. 탭은 겹치지 않아요 (스크린샷은 사진 탭에서 빠짐)
      await withDb(env, 'tabs', (db) => {
        db.upsertFiles([
          row({ path: 'R1/p.jpg', name: 'p.jpg' }),
          row({ path: 'R1/v.mp4', name: 'v.mp4', mediaType: 'video', durationSec: 3.5, tags: [{ name: '비디오', source: 'mediaType' }] }),
          row({ path: 'R1/s.png', name: 's.png', tags: [{ name: '스크린샷', source: 'mediaType' }] }),
        ]);
        const count = (tab) => db.listDays('R1', { ...ALL, tab }).reduce((n, d) => n + d.count, 0);
        const got = { all: count('all'), photo: count('photo'), video: count('video'), screenshot: count('screenshot') };
        out.push(sub('탭 필터 (전체 3, 사진 1, 영상 1, 스크린샷 1)', got.all === 3 && got.photo === 1 && got.video === 1 && got.screenshot === 1, JSON.stringify(got)));
        const v = db.listFiles('R1', '2026-10-25', { ...ALL, tab: 'video' });
        const ph = db.listFiles('R1', '2026-10-25', { ...ALL, tab: 'photo' }).map((f) => f.name).join(',');
        const sc = db.listFiles('R1', '2026-10-25', { ...ALL, tab: 'screenshot' }).map((f) => f.name).join(',');
        out.push(sub('스크린샷은 사진 탭에서 빠지고 스크린샷 탭에만 나옴', ph === 'p.jpg' && sc === 's.png', `사진 ${ph} / 스크린샷 ${sc}`));
        out.push(sub('영상 탭 파일 목록 값', v.length === 1 && v[0].name === 'v.mp4' && v[0].mediaType === 'video' && v[0].durationSec === 3.5 && v[0].thumbState === 'none', JSON.stringify(v)));
      });

      // 14c 날짜 없음은 정렬과 관계없이 맨 끝
      await withDb(env, 'nodate', (db) => {
        db.upsertFiles([
          row({ path: 'R1/old.jpg', name: 'old.jpg', takenDay: '2020-01-01', takenAt: '2020-01-01T00:00:00' }),
          row({ path: 'R1/new.jpg', name: 'new.jpg', takenDay: '2026-10-25' }),
          row({ path: 'R1/none.jpg', name: 'none.jpg', takenDay: null, takenAt: null, takenOffset: null, takenAtSource: null }),
        ]);
        const newest = db.listDays('R1', { ...ALL, sort: 'newest' });
        const oldest = db.listDays('R1', { ...ALL, sort: 'oldest' });
        const last = (l) => (l.length ? l[l.length - 1].day : 'empty');
        out.push(sub('날짜 없음은 맨 끝 (newest, oldest 둘 다)', last(newest) === null && last(oldest) === null, `${days(newest)} / ${days(oldest)}`));
        out.push(sub('날짜 순서 (newest는 최신부터, oldest는 오래된 것부터)', newest[0].day === '2026-10-25' && oldest[0].day === '2020-01-01', `${newest[0].day} / ${oldest[0].day}`));
        const noDay = db.listFiles('R1', null, ALL);
        out.push(sub('날짜 없음 날의 파일 목록', noDay.length === 1 && noDay[0].name === 'none.jpg', JSON.stringify(noDay.map((f) => f.name))));
        const s = db.summary('R1');
        out.push(sub('summary: 전체와 날짜 없음 개수', s.total === 3 && s.noDate === 1, JSON.stringify(s)));
      });

      // 14d missing=1은 모든 조회에서 빠지고, 되돌리면 다시 나옴
      await withDb(env, 'missing', (db) => {
        db.upsertFiles([
          row({ path: 'R1/a.jpg', name: 'a.jpg', tags: [{ name: '여행', source: 'album' }] }),
          row({ path: 'R1/b.jpg', name: 'b.jpg' }),
        ]);
        db.setMissing(['R1/a.jpg'], 1);
        const hidden = db.listDays('R1', ALL).reduce((n, d) => n + d.count, 0);
        const s1 = db.summary('R1');
        const files = db.listFiles('R1', '2026-10-25', ALL).map((f) => f.name).join(',');
        out.push(sub(
          'missing 제외 (listDays, listFiles, summary, 태그 개수)',
          hidden === 1 && s1.total === 1 && files === 'b.jpg' && s1.tagCount === 0,
          `날짜 ${hidden}, total ${s1.total}, 파일 ${files}, 태그 ${s1.tagCount}`,
        ));
        const known = db.knownFiles('R1');
        out.push(sub('knownFiles에는 missing 파일도 값과 함께 나옴', known.size === 2 && known.get('R1/a.jpg').missing === 1 && known.get('R1/b.jpg').size === 100, JSON.stringify([...known])));
        db.setMissing(['R1/a.jpg'], 0);
        const back = db.listDays('R1', ALL).reduce((n, d) => n + d.count, 0);
        out.push(sub('missing 되돌리면 다시 나옴', back === 2 && db.summary('R1').total === 2, `날짜 ${back}, total ${db.summary('R1').total}`));
      });

      // 14e 다른 root의 파일은 조회에 안 나옴
      await withDb(env, 'roots', (db) => {
        db.upsertFiles([
          row({ root: 'R1', path: 'R1/a.jpg', name: 'a.jpg' }),
          row({ root: 'R2', path: 'R2/x.jpg', name: 'x.jpg', takenDay: '2019-05-05' }),
          row({ root: 'R2', path: 'R2/y.jpg', name: 'y.jpg', takenDay: null, takenAt: null }),
        ]);
        const d1 = db.listDays('R1', ALL);
        const f1 = db.listFiles('R1', '2019-05-05', ALL);
        const k1 = db.knownFiles('R1');
        out.push(sub('다른 root 제외', days(d1) === '2026-10-25:1' && f1.length === 0 && db.summary('R1').total === 1 && db.summary('R1').noDate === 0 && k1.size === 1, `${days(d1)}, total ${db.summary('R1').total}`));
      });

      // 14f 태그 요약 (album만, 많은 순)과 태그 필터, 썸네일 대기열
      await withDb(env, 'tags', (db) => {
        const a = (name) => ({ name, source: 'album' });
        db.upsertFiles([
          row({ path: 'R1/1.jpg', name: '1.jpg', tags: [a('여행'), { name: '사진', source: 'mediaType' }] }),
          row({ path: 'R1/2.jpg', name: '2.jpg', tags: [a('여행'), a('가족')] }),
          row({ path: 'R1/3.jpg', name: '3.jpg', tags: [a('여행')] }),
          row({ path: 'R1/4.jpg', name: '4.jpg', tags: [a('가족')] }),
        ]);
        const s = db.summary('R1');
        out.push(sub('summary 태그: album만, 많은 순', s.tagCount === 2 && JSON.stringify(s.tags) === JSON.stringify([{ name: '여행', count: 3 }, { name: '가족', count: 2 }]), JSON.stringify(s.tags)));
        const t = db.listFiles('R1', '2026-10-25', { ...ALL, tag: '가족' }).map((f) => f.name).sort().join(',');
        const td = days(db.listDays('R1', { ...ALL, tag: '가족' }));
        out.push(sub('태그 필터', t === '2.jpg,4.jpg' && td === '2026-10-25:2', `${t} / ${td}`));

        // 썸네일 대기열: none 인 것만, missing 제외, 실패는 다시 대기로
        const jobs = db.nextThumbJobs('R1', 10);
        out.push(sub('썸네일 대기열은 전부 none', jobs.length === 4 && jobs.every((j) => j.thumbState === 'none' && j.path && j.mediaType), `${jobs.length}개`));
        db.setThumbState(jobs[0].id, 'ready');
        db.setThumbState(jobs[1].id, 'failed');
        db.setMissing([jobs[2].path], 1);
        const left = db.nextThumbJobs('R1', 10);
        out.push(sub('대기열에서 ready, failed, missing 제외, limit 적용', left.length === 1 && db.nextThumbJobs('R1', 0).length === 0, `${left.length}개`));
        db.resetFailedThumbs('R1');
        out.push(sub('실패한 썸네일은 다시 대기로', db.nextThumbJobs('R1', 10).length === 2));
      });

      // 14g 깨진 DB 파일: 이름을 바꿔 보관하고 새로 만듦
      {
        const { openDb } = require('../lib/db');
        const file = newDbPath(env, 'broken');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from('이건 DB가 아니에요 garbage bytes '.repeat(300)));
        const opened = openDb(file);
        try {
          const kept = fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('library.db.broken-'));
          opened.db.upsertFiles([row()]);
          out.push(sub('깨진 파일 복구', opened.recovered === true && kept.length === 1 && opened.db.summary('R1').total === 1, `recovered ${opened.recovered}, 보관 ${kept.join(', ') || '없음'}`));
          const keptBytes = kept.length ? fs.readFileSync(path.join(path.dirname(file), kept[0])).length : 0;
          out.push(sub('보관한 파일은 원래 내용 그대로', keptBytes > 0 && fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8').startsWith('이건 DB가'), `${keptBytes}바이트`));
        } finally {
          opened.db.close();
        }

        // 멀쩡한 파일은 복구 없이 다시 열려요 (저장한 값이 남아 있음)
        const again = openDb(file);
        try {
          out.push(sub('멀쩡한 DB는 다시 열어도 복구 안 함', again.recovered === false && again.db.summary('R1').total === 1, `recovered ${again.recovered}, total ${again.db.summary('R1').total}`));
        } finally {
          again.db.close();
        }
      }

      // 14h 깨진 게 아닌 오류(다른 연결이 쓰는 중 등)는 멀쩡한 DB의 이름을 바꾸지 않고 오류를 던짐
      {
        const { DatabaseSync } = require('node:sqlite');
        const { openDb, isCorruptionError } = require('../lib/db');
        const file = newDbPath(env, 'locked');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const first = openDb(file);
        first.db.upsertFiles([row()]);
        first.db.close();

        // 다른 연결이 DB를 통째로 잠가요 (journal을 DELETE 방식으로 바꾼 뒤 BEGIN EXCLUSIVE)
        const locker = new DatabaseSync(file);
        let threw = null;
        let leftAlone = false;
        try {
          locker.exec('PRAGMA journal_mode = DELETE');
          locker.exec('BEGIN EXCLUSIVE');
          try {
            openDb(file, { busyTimeoutMs: 100 }).db.close();
          } catch (e) {
            threw = e;
          }
          const names = fs.readdirSync(path.dirname(file));
          leftAlone = names.includes('library.db') && !names.some((n) => n.includes('.broken-'));
        } finally {
          try { locker.exec('ROLLBACK'); } catch (e) { /* 잠금이 없을 수도 */ }
          locker.close();
        }
        out.push(sub('잠긴 DB는 이름을 바꾸지 않고 오류를 던짐', !!threw && leftAlone, threw ? `${threw.errstr || threw.message} (errcode ${threw.errcode})` : '오류 없이 열림'));
        const after = openDb(file);
        try {
          out.push(sub('잠금이 풀리면 데이터 그대로 열림', after.recovered === false && after.db.summary('R1').total === 1, `recovered ${after.recovered}, total ${after.db.summary('R1').total}`));
        } finally {
          after.db.close();
        }

        // 오류 분류: 깨진 파일(NOTADB 26, CORRUPT 11, 세부 코드 포함)만 true, 잠김 5, 읽기 전용 8, 디스크 가득 13, 열기 불가 14, 권한 3은 false
        const cls = (code) => isCorruptionError(Object.assign(new Error('x'), { errcode: code }));
        const truthy = [26, 11, 26 | (1 << 8), 11 | (3 << 8)].every(cls);
        const falsy = [5, 6, 3, 8, 13, 14, 10, 1, 5 | (1 << 8), 13 | (2 << 8)].every((c) => !cls(c));
        out.push(sub('오류 분류: 깨짐만 이름 바꾸기 대상', truthy && falsy && !isCorruptionError(new Error('코드 없음')) && !isCorruptionError(null)));
      }

      return out;
    },
  },
];

module.exports = { items };

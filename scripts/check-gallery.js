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

// 가짜 도서관 채우기: 하루 20개쯤씩 파일 count개를 db에 넣어요 (속도 점검용, 작업 8도 같이 써요)
//   종류는 사진 90%, 영상 5%, 스크린샷 5%. 파일마다 앨범 태그 1~2개와 종류 태그 1개. 97번째마다 날짜 없음.
//   root는 이름일 뿐 실제 폴더는 만들지 않아요 (DB에 줄만 넣음)
const FAKE_ALBUMS = ['여행', '가족', '친구', '수원', '제주', '생일', '회사', '운동', '맛집', '강아지', '바다', '캠핑', '2026년도_44주차', 'Trip2025', '졸업식', '이사'];
function fillFakeLibrary(db, root, count) {
  const BATCH = 2000;
  const startMs = Date.UTC(2018, 0, 1);
  for (let from = 0; from < count; from += BATCH) {
    const rows = [];
    for (let i = from; i < Math.min(count, from + BATCH); i++) {
      const k = i % 20;
      const noDate = i % 97 === 96;
      const day = new Date(startMs + Math.floor(i / 20) * 86400000).toISOString().slice(0, 10);
      const kindTag = k === 0 ? '비디오' : k === 1 ? '스크린샷' : '사진';
      const tags = [{ name: kindTag, source: 'mediaType' }, { name: FAKE_ALBUMS[i % FAKE_ALBUMS.length], source: 'album' }];
      const second = FAKE_ALBUMS[(i * 7 + 3) % FAKE_ALBUMS.length];
      if (second !== tags[1].name) tags.push({ name: second, source: 'album' });
      const name = `IMG_${String(i).padStart(6, '0')}.${k === 0 ? 'mp4' : 'jpg'}`;
      rows.push(row({
        root,
        path: `${root}/${noDate ? 'nodate' : day}/${name}`,
        name,
        mediaType: k === 0 ? 'video' : 'photo',
        mtimeMs: 1000 + i,
        takenAt: noDate ? null : `${day}T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`,
        takenOffset: noDate ? null : '+09:00',
        takenDay: noDate ? null : day,
        takenAtSource: noDate ? null : 'exif',
        durationSec: k === 0 ? 3.5 : null,
        tags,
      }));
    }
    db.upsertFiles(rows);
  }
}

// 걸린 시간(밀리초)과 결과
function timeIt(fn) {
  const t0 = process.hrtime.bigint();
  const result = fn();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, result };
}

// ---------- 폴더 읽기(16번) 도우미 ----------
const sha1Of = (p) => require('crypto').createHash('sha1').update(fs.readFileSync(p)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 폴더 안 모든 파일의 내용 지문 + 수정 시각 (읽기 전후 비교용)
function fingerprint(dir) {
  const m = {};
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = path.join(e.parentPath || e.path, e.name);
    m[path.relative(dir, p)] = `${sha1Of(p)}@${fs.statSync(p).mtimeMs}`;
  }
  return m;
}

// 샘플 처리 결과(env.full.backupRoot)를 점검 임시 폴더에 복사해서 읽기 대상으로 써요 (복사본만 건드림)
let libSeq = 0;
function copyLibrary(env) {
  const root = path.join(env.tmp, 'library-scan', `lib-${++libSeq}`, 'backup');
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.cpSync(env.full.backupRoot, root, { recursive: true, preserveTimestamps: true });
  return root;
}

// 폴더 읽기 객체 만들기 (logger가 없어도 돼요)
function makeLib(db, et, over = {}) {
  const { createLibrary } = require('../lib/library');
  return createLibrary({ db, getEt: () => et, logger: null, isBusy: () => false, ...over });
}

// exiftool 호출 횟수를 세는 감싸개 (run을 가로채요)
function countingEt(real) {
  const w = Object.create(real);
  w.calls = 0;
  w.run = (args) => { w.calls++; return real.run(args); };
  return w;
}

// 가짜 exiftool: 진짜로 읽은 뒤 after(files, tags, list, n)으로 결과를 바꿔요. n은 "주 읽기" 번호(1부터)
function fakeEt(real, after) {
  let n = 0;
  return {
    run: (a) => real.run(a),
    async read(files, tags) {
      const list = await real.read(files, tags);
      return tags.includes('Duration#') ? after(files, tags, list, ++n) : list;
    },
  };
}

async function waitUntil(cond, ms) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
}

const planner = () => require('../lib/planner');
const listMedia = (root) => planner().walk(root, true, [], () => {});
const isUnderDir = (p, dir) => planner().keyOf(p).startsWith(planner().keyOf(dir) + path.sep);
const sumTotal = (db, root) => db.summary(root).total;
const fileNamed = (db, root, day, name) => {
  const hit = db.listFiles(root, day, ALL).find((f) => f.name === name);
  return hit ? db.getFile(hit.id) : null;
};

const days = (list) => list.map((d) => `${d.day}:${d.count}`).join(',');
const ALL = { tab: 'all', sort: 'newest', query: '', tag: null };

// 가짜 손상 영상: check.js의 breakVideo와 같은 방식 (목차 moov 상자를 지우고 끝을 0으로 채움)
function breakMp4(from, to, zeros) {
  const buf = fs.readFileSync(from);
  const keep = [];
  for (let p = 0; p + 8 <= buf.length; ) {
    const size = buf.readUInt32BE(p);
    if (size < 8) break;
    if (buf.toString('latin1', p + 4, p + 8) !== 'moov') keep.push(buf.subarray(p, p + size));
    p += size;
  }
  fs.writeFileSync(to, Buffer.concat([...keep, Buffer.alloc(zeros)]));
}

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
        const { openDb, isCorruptionError, structureErrorOf } = require('../lib/db');
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
        // 칸 확인 단계의 오류: no such column(1)만 구조 오류, 잠김과 입출력 오류는 그대로 돌려줘서 이름을 바꾸지 않음
        const probe = (code) => {
          const err = Object.assign(new Error('probe'), { errcode: code });
          const got = structureErrorOf(err);
          return { same: got === err, broken: isCorruptionError(got) };
        };
        const notBroken = [5, 6, 10, 13, 14, 5 | (1 << 8), 10 | (2 << 8)].every((c) => probe(c).same && !probe(c).broken);
        const broken = [1, 1 | (2 << 8)].every((c) => !probe(c).same && probe(c).broken);
        out.push(sub('칸 확인 중 잠김, 입출력 오류는 구조 오류로 바꾸지 않음', notBroken && broken && structureErrorOf(new Error('코드 없음')).message === '코드 없음', JSON.stringify({ notBroken, broken })));
        out.push(sub('오류 분류: 깨짐만 이름 바꾸기 대상', truthy && falsy && !isCorruptionError(new Error('코드 없음')) && !isCorruptionError(null)));
      }

      return out;
    },
  },
  {
    no: 15,
    name: '갤러리 검색',
    async run(env) {
      const out = [];
      const { parseQuery } = require('../lib/search');
      const q = (text) => ({ ...ALL, query: text });
      const names = (db, text, tab = 'all') => db.listFiles('R1', '2026-10-25', { ...q(text), tab }).map((f) => f.name).sort().join(',');
      const total = (db, text, tab = 'all') => db.listDays('R1', { ...q(text), tab }).reduce((n, d) => n + d.count, 0);

      // 15a 검색어 해석 (날짜 모양 판단)
      {
        const dl = (text) => {
          const t = parseQuery(text);
          return t.length === 1 ? t[0].dateLike : `낱말 ${t.length}개`;
        };
        const want = {
          '2026년 10월': '2026-10-%',
          '10.28': '%-10-28',
          수원: null,
          2026: '2026-%',
          '2026-10': '2026-10-%',
          '2026.10': '2026-10-%',
          '2026.10.28': '2026-10-28',
          '2026-10-28': '2026-10-28',
          '2026.1.5': '2026-01-05',
          '2026년 10월 28일': '2026-10-28',
          '13.40': null,
        };
        const bad = Object.keys(want).filter((k) => dl(k) !== want[k]).map((k) => `${k} → ${dl(k)}`);
        out.push(sub('날짜 모양 해석표', bad.length === 0, bad.join(' / ') || '모두 맞음'));
        const two = parseQuery('2026년 10월 수원');
        out.push(sub('공백이 든 날짜는 한 낱말로 합쳐 두 낱말', two.length === 2 && two[0].dateLike === '2026-10-%' && two[1].dateLike === null, JSON.stringify(two)));
        const e = parseQuery('100%_a\\');
        out.push(sub('% _ \\ 는 이스케이프', e.length === 1 && e[0].like === '%100\\%\\_a\\\\%', e.length ? e[0].like : '없음'));
        out.push(sub('빈 검색어는 낱말 없음', parseQuery('').length === 0 && parseQuery('   ').length === 0 && parseQuery(null).length === 0 && parseQuery(undefined).length === 0));
      }

      await withDb(env, 'search', (db) => {
        const a = (name) => ({ name, source: 'album' });
        db.upsertFiles([
          row({ path: 'R1/sunset.jpg', name: 'sunset.jpg', tags: [a('여행'), a('친구')] }),
          row({ path: 'R1/IMG_0001.jpg', name: 'IMG_0001.jpg', tags: [a('친구')] }),
          row({ path: 'R1/IMG_0002.jpg', name: 'IMG_0002.jpg', tags: [a('여행')] }),
          row({ path: 'R1/100%.jpg', name: '100%.jpg' }),
          row({ path: 'R1/1000.jpg', name: '1000.jpg' }),
          row({ path: 'R1/a_b.jpg', name: 'a_b.jpg' }),
          row({ path: 'R1/axb.jpg', name: 'axb.jpg' }),
          row({ path: 'R1/s.png', name: 's.png', tags: [{ name: '스크린샷', source: 'mediaType' }] }),
        ]);

        // 15b 이름, 두 글자 태그, AND
        out.push(sub('파일 이름 찾기', names(db, 'sunset') === 'sunset.jpg' && names(db, 'SUNSET') === 'sunset.jpg', names(db, 'sunset')));
        out.push(sub('두 글자 태그 찾기 (친구)', names(db, '친구') === 'IMG_0001.jpg,sunset.jpg', names(db, '친구')));
        out.push(sub('낱말 두 개 AND', names(db, '친구 여행') === 'sunset.jpg' && names(db, '여행 친구') === 'sunset.jpg' && names(db, '친구 없는말') === '', names(db, '친구 여행')));
        out.push(sub('종류 태그(스크린샷)도 검색됨', names(db, '스크린샷') === 's.png' && names(db, '스크린샷', 'screenshot') === 's.png' && names(db, '스크린샷', 'photo') === '', names(db, '스크린샷')));

        // 15c % _ 글자 그대로, 따옴표 등은 값으로만 쓰임
        out.push(sub('% 글자 그대로 (100%는 100%.jpg만)', names(db, '100%') === '100%.jpg', names(db, '100%')));
        out.push(sub('_ 글자 그대로 (a_b는 a_b.jpg만)', names(db, 'a_b') === 'a_b.jpg', names(db, 'a_b')));
        let inj;
        try { inj = total(db, "' OR 1=1 --") + total(db, '"; DROP TABLE files; --'); } catch (e) { inj = e.message; }
        out.push(sub('따옴표와 SQL 모양 글자는 그냥 글자', inj === 0 && db.summary('R1').total === 8, String(inj)));

        // 15d 빈 검색어는 전부, 개수 일치, missing 제외
        out.push(sub('빈 검색어는 전부', total(db, '') === 8 && total(db, '   ') === 8 && total(db, undefined) === 8, String(total(db, ''))));
        out.push(sub('listDays와 listFiles 검색 결과 일치', total(db, '친구') === 2 && days(db.listDays('R1', q('친구'))) === '2026-10-25:2'));
        db.setMissing(['R1/sunset.jpg'], 1);
        out.push(sub('사라진 파일은 검색에서도 빠짐', names(db, '친구') === 'IMG_0001.jpg'));
      });

      // 15e 날짜 낱말
      await withDb(env, 'search-date', (db) => {
        db.upsertFiles([
          row({ path: 'R1/new1.jpg', name: 'new1.jpg', takenDay: '2026-10-28', takenAt: '2026-10-28T09:00:00' }),
          row({ path: 'R1/new2.jpg', name: 'new2.jpg', takenDay: '2026-03-05', takenAt: '2026-03-05T09:00:00' }),
          row({ path: 'R1/old.jpg', name: 'old.jpg', takenDay: '2019-10-28', takenAt: '2019-10-28T09:00:00' }),
          row({ path: 'R1/week.jpg', name: 'week.jpg', takenDay: '2019-11-02', takenAt: '2019-11-02T09:00:00', tags: [{ name: '2026년도_44주차', source: 'album' }] }),
          row({ path: 'R1/nodate.jpg', name: 'nodate.jpg', takenDay: null, takenAt: null }),
        ]);
        const found = (text) => db.listDays('R1', q(text)).flatMap((d) => db.listFiles('R1', d.day, q(text)).map((f) => f.name)).sort().join(',');
        out.push(sub('2026 → 2026년 사진 + 태그에 2026이 든 사진', found('2026') === 'new1.jpg,new2.jpg,week.jpg', found('2026')));
        out.push(sub('2026년도_44주차 태그 이름 그대로', found('2026년도_44주차') === 'week.jpg', found('2026년도_44주차')));
        out.push(sub('2026년 10월 / 2026-10 / 2026.10', ['2026년 10월', '2026-10', '2026.10'].every((t) => found(t) === 'new1.jpg'), found('2026년 10월')));
        out.push(sub('2026.10.28 / 2026-10-28 정확한 하루', ['2026.10.28', '2026-10-28', '2026년 10월 28일'].every((t) => found(t) === 'new1.jpg'), found('2026.10.28')));
        out.push(sub('10.28 은 해마다', found('10.28') === 'new1.jpg,old.jpg', found('10.28')));
        out.push(sub('날짜 낱말 + 다른 낱말 AND', found('2026 44주차') === 'week.jpg' && found('10.28 2019') === 'old.jpg', `${found('2026 44주차')} / ${found('10.28 2019')}`));
        out.push(sub('날짜 없는 사진은 날짜 낱말에 안 나옴', !found('2026').includes('nodate') && !found('10.28').includes('nodate')));
      });

      // 15f 가짜 6만 건 속도: 하나라도 1000ms를 넘으면 실패 (목표는 200ms)
      {
        const { openDb } = require('../lib/db');
        const LIMIT = 1000;
        const file = newDbPath(env, 'fake60k');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const opened = openDb(file);
        const t = {};
        try {
          const db = opened.db;
          fillFakeLibrary(db, 'FAKE', 60000);
          const n = db.summary('FAKE').total;
          const dayList = db.listDays('FAKE', ALL);
          const mid = dayList[Math.floor(dayList.length / 2)].day;
          t['listDays 전체'] = timeIt(() => db.listDays('FAKE', ALL)).ms;
          t['listFiles 하루'] = timeIt(() => db.listFiles('FAKE', mid, ALL)).ms;
          t['검색 listDays (여행)'] = timeIt(() => db.listDays('FAKE', q('여행'))).ms;
          t['검색 listDays (2026 여행)'] = timeIt(() => db.listDays('FAKE', q('2026 여행'))).ms;
          t['검색 listDays (없는낱말)'] = timeIt(() => db.listDays('FAKE', q('없는낱말'))).ms;
          t['검색 listFiles 하루'] = timeIt(() => db.listFiles('FAKE', mid, q('여행'))).ms;
          t['nextThumbJobs 50'] = timeIt(() => db.nextThumbJobs('FAKE', 50)).ms;
          const found = db.listDays('FAKE', q('여행')).reduce((s, d) => s + d.count, 0);
          out.push(sub('가짜 6만 건 채움과 검색 결과', n === 60000 && found > 0 && found < n, `${n}건, 여행 ${found}건`));
        } finally {
          opened.db.close();
        }
        // 다시 열기: openDb는 열 때마다 quick_check를 해요
        const reopen = timeIt(() => openDb(file));
        reopen.result.db.close();
        t['openDb 다시 열기'] = reopen.ms;
        const detail = Object.entries(t).map(([k, v]) => `${k} ${Math.round(v)}ms`).join(', ');
        const slow = Object.entries(t).filter(([, v]) => v > LIMIT).map(([k]) => k);
        out.push(sub('가짜 6만 건 속도 (1000ms 이하)', slow.length === 0, detail));
      }

      return out;
    },
  },
  {
    no: 16,
    name: '갤러리 폴더 읽기',
    async run(env) {
      const out = [];
      const { createLogger } = require('../lib/logger');
      const et = env.et;
      const stash = path.join(env.tmp, 'library-scan', 'stash'); // 일부러 옮겨 놓는 곳 (이름만 바꿔 옮기고 지우지 않아요)
      fs.mkdirSync(stash, { recursive: true });
      const DAY = '2026-10-28';
      const VIDEO = '2026-10-28_134113_IMG_0103.mp4';

      // 16a 기본: 파일 안 바뀜, 영상 날짜 출처, 날짜 없음, 다시 읽기, 파일 하나만 바뀜, 없어짐과 돌아옴, 로그
      await withDb(env, 'scan-basic', async (db) => {
        const root = copyLibrary(env);
        const n = listMedia(root).length;
        const before = fingerprint(root);
        const cet = countingEt(et);
        const progress = [];
        let changed = 0;
        const logDir = path.join(env.tmp, 'library-scan', 'logs');
        const lib = makeLib(db, cet, { logger: createLogger(logDir), onProgress: (p) => progress.push(p), onChanged: () => changed++ });

        const r1 = await lib.scan(root);
        out.push(sub('처음 읽기: 전부 저장', r1.status === 'done' && r1.read === n && r1.skipped === 0 && r1.missing === 0 && sumTotal(db, root) === n && n > 3, `${JSON.stringify(r1)} / 파일 ${n}개`));
        const last = progress[progress.length - 1] || {};
        out.push(sub('진행과 갱신 알림', last.phase === 'reading' && last.done === n && last.total === n && changed >= 1, `${JSON.stringify(last)} / 갱신 ${changed}번`));
        out.push(sub('파일 안 바뀜 (내용과 수정 시각)', JSON.stringify(fingerprint(root)) === JSON.stringify(before)));

        const v = fileNamed(db, root, DAY, VIDEO);
        out.push(sub('영상 날짜 출처는 촬영 정보', !!v && v.takenAtSource === 'exif' && v.takenDay === DAY && v.mediaType === 'video', v ? `${v.takenAtSource} ${v.takenAt} ${v.takenOffset} ${v.durationSec}초 ${v.width}x${v.height}` : '파일 없음'));
        const nd = db.listFiles(root, null, ALL).find((f) => f.name === 'noinfo.jpg');
        const ndFile = nd ? db.getFile(nd.id) : null;
        out.push(sub('날짜 없음', !!ndFile && ndFile.takenDay === null && ndFile.takenAtSource === null, ndFile ? `${ndFile.takenDay}` : '파일 없음'));

        const calls0 = cet.calls;
        const r2 = await lib.scan(root);
        out.push(sub('다시 읽기는 exiftool 호출 0번', cet.calls === calls0 && r2.read === 0 && r2.skipped === n && r2.status === 'done', `호출 ${cet.calls - calls0}번, ${JSON.stringify(r2)}`));

        const target = listMedia(root).map((f) => f.path).sort()[0];
        const when = new Date(Date.now() - 3 * 86400000);
        fs.utimesSync(target, when, when);
        const r3 = await lib.scan(root);
        const rec = db.knownFiles(root).get(target);
        out.push(sub('파일 하나 바꾸면 그것만', r3.read === 1 && r3.skipped === n - 1 && !!rec && rec.mtimeMs === fs.statSync(target).mtimeMs, JSON.stringify(r3)));

        const away = path.join(stash, 'away.bin');
        fs.renameSync(target, away);
        const r4 = await lib.scan(root);
        out.push(sub('없어지면 missing', r4.status === 'done' && r4.missing === 1 && sumTotal(db, root) === n - 1 && db.knownFiles(root).get(target).missing === 1, JSON.stringify(r4)));
        fs.renameSync(away, target);
        const r5 = await lib.scan(root);
        out.push(sub('돌아오면 복원 (다시 읽지 않음)', r5.read === 0 && r5.skipped === n && r5.missing === 0 && sumTotal(db, root) === n && db.knownFiles(root).get(target).missing === 0, JSON.stringify(r5)));

        // 사라진 사이에 바뀌어서 돌아온 파일: 다시 읽고 보이게 됨
        fs.renameSync(target, away);
        const r6 = await lib.scan(root);
        fs.renameSync(away, target);
        const later = new Date(Date.now() - 5 * 86400000);
        fs.utimesSync(target, later, later);
        const r7 = await lib.scan(root);
        const rec7 = db.knownFiles(root).get(target);
        out.push(sub('missing였다가 바뀌어 돌아온 파일은 다시 읽고 보임', r6.missing === 1 && r7.read === 1 && r7.skipped === n - 1 && r7.missing === 0 && sumTotal(db, root) === n && !!rec7 && rec7.missing === 0 && rec7.mtimeMs === fs.statSync(target).mtimeMs, JSON.stringify(r7)));

        const logs = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.startsWith('gallery-scan_')) : [];
        const text = logs.length ? fs.readFileSync(path.join(logDir, logs[0]), 'utf8') : '';
        out.push(sub('로그에 개수가 있음', logs.length >= 1 && text.includes(`찾음 ${n}개`) && text.includes(`읽음 ${n}개`), `로그 ${logs.length}개`));
      });

      // 16b 연결이 끊긴 경우: 폴더 없음, 빈 폴더, 찾은 뒤 폴더가 사라짐 → 아무것도 missing으로 만들지 않음
      await withDb(env, 'scan-disconnect', async (db) => {
        const root = copyLibrary(env);
        const n = listMedia(root).length;
        const lib = makeLib(db, et);
        await lib.scan(root);

        const gone = `${root}-gone`;
        fs.renameSync(root, gone);
        const r1 = await lib.scan(root);
        out.push(sub('폴더 없음: disconnected, 개수 그대로', r1.status === 'disconnected' && r1.missing === 0 && sumTotal(db, root) === n, JSON.stringify(r1)));

        fs.mkdirSync(root); // 같은 이름의 빈 폴더 (파일은 다른 곳에 있음)
        const r2 = await lib.scan(root);
        out.push(sub('빈 폴더: missing 표시 0개', r2.status === 'disconnected' && r2.missing === 0 && sumTotal(db, root) === n, JSON.stringify(r2)));

        // 찾은 뒤에 폴더가 사라지면 (파일 하나가 목록에서 빠진 것처럼 보여도) 표시하지 않음
        fs.renameSync(root, path.join(stash, 'empty-root'));
        fs.renameSync(gone, root);
        const hide = listMedia(root)[0].path;
        const racing = (rt, inc, ex, onCount, onDirError) => {
          const files = planner().walk(rt, inc, ex, onCount, onDirError).filter((f) => f.path !== hide);
          fs.renameSync(rt, `${rt}-racing`);
          return files;
        };
        const r3 = await makeLib(db, et, { walkFn: racing }).scan(root);
        fs.renameSync(`${root}-racing`, root);
        out.push(sub('찾은 뒤 폴더가 사라지면 표시 안 함', r3.status === 'disconnected' && r3.missing === 0 && sumTotal(db, root) === n, JSON.stringify(r3)));
      });

      // 16b2 읽는 도중 연결이 끊기면(exiftool이 빈 결과를 줌) 그 묶음은 저장하지 않음. 연결이 돌아오면 정상으로 읽힘
      await withDb(env, 'scan-lost', async (db) => {
        const root = copyLibrary(env);
        const n = listMedia(root).length;
        if (n < 7) { out.push(sub('묶음 시험용 파일 수 (7개 이상)', false, `${n}개`)); return; }
        const gone = `${root}-gone`;
        const cut = fakeEt(et, (files, tags, list, count) => {
          if (count !== 2) return list;
          fs.renameSync(root, gone); // 두 번째 묶음을 읽는 순간 연결이 끊김
          return [];
        });
        const r1 = await makeLib(db, cut, { chunkSize: 3 }).scan(root);
        const bad = [...db.knownFiles(root).values()].filter((k) => k.readError).length;
        out.push(sub('읽는 도중 연결 끊김: disconnected, 끊긴 묶음은 저장 안 함', r1.status === 'disconnected' && r1.read === 3 && sumTotal(db, root) === 3 && bad === 0 && r1.missing === 0, JSON.stringify(r1)));
        fs.renameSync(gone, root);
        const r2 = await makeLib(db, et, { chunkSize: 3 }).scan(root);
        const bad2 = [...db.knownFiles(root).values()].filter((k) => k.readError).length;
        out.push(sub('연결이 돌아온 뒤 정상으로 읽으면 나머지 전부, 읽기 실패 0개', r2.status === 'done' && r2.read === n - 3 && r2.skipped === 3 && sumTotal(db, root) === n && bad2 === 0, JSON.stringify(r2)));
      });

      // 16b3 영상은 두 번 읽어요(촬영 정보, Keys 날짜). 그 사이에 연결이 끊기면 모든 파일에 값이 있어도 저장하지 않음
      await withDb(env, 'scan-keys-drop', async (db) => {
        const root = copyLibrary(env);
        const n = listMedia(root).length;
        const gone = `${root}-gone`;
        const drop = {
          run: (a) => et.run(a),
          async read(files, tags) {
            const list = await et.read(files, tags);
            if (!tags.includes('Keys:CreationDate')) return list; // 주 읽기는 정상
            fs.renameSync(root, gone); // Keys 읽기를 하는 순간 연결이 끊기고 빈 결과가 옴
            return [];
          },
        };
        const r1 = await makeLib(db, drop).scan(root);
        const bad = [...db.knownFiles(root).values()].length;
        out.push(sub('Keys 읽기 사이 연결 끊김: disconnected, 그 묶음은 저장 안 함', r1.status === 'disconnected' && r1.read === 0 && bad === 0 && sumTotal(db, root) === 0 && r1.missing === 0, JSON.stringify(r1)));
        fs.renameSync(gone, root);
        const r2 = await makeLib(db, et).scan(root);
        const v = fileNamed(db, root, DAY, VIDEO);
        out.push(sub('연결이 돌아온 뒤 영상이 Keys 날짜로 읽힘', r2.status === 'done' && r2.read === n && !!v && v.takenAtSource === 'exif' && v.takenAt === '2026-10-28T13:41:13' && v.takenOffset === '+09:00' && v.readError === null, v ? `${v.takenAt} ${v.takenOffset}` : '영상 없음'));
      });

      // 16c 일부 폴더를 못 읽음: 그 폴더 안 파일은 missing으로 만들지 않음 (이름만 비슷한 폴더는 보호하지 않음)
      await withDb(env, 'scan-faileddirs', async (db) => {
        const root = copyLibrary(env);
        const n = listMedia(root).length;
        await makeLib(db, et).scan(root);
        const dir28 = path.join(root, '2026', '10', '28');
        const hidden = listMedia(root).filter((f) => isUnderDir(f.path, dir28)).length;
        const fake = (report) => (rt, inc, ex, onCount, onDirError) => {
          const files = planner().walk(rt, inc, ex, onCount, onDirError).filter((f) => !isUnderDir(f.path, dir28));
          onDirError(report);
          return files;
        };
        const r1 = await makeLib(db, et, { walkFn: fake(dir28) }).scan(root);
        out.push(sub('못 읽은 폴더 안 파일은 missing 아님', hidden > 0 && r1.missing === 0 && r1.failedDirs.length === 1 && sumTotal(db, root) === n, `숨긴 ${hidden}개, ${JSON.stringify(r1)}`));
        const r2 = await makeLib(db, et, { walkFn: fake(root) }).scan(root);
        out.push(sub('root 전체를 못 읽었으면 아무것도 표시 안 함', r2.missing === 0 && sumTotal(db, root) === n, JSON.stringify(r2)));
        const r3 = await makeLib(db, et, { walkFn: fake(path.join(root, '2026', '10', '2')) }).scan(root);
        out.push(sub('이름만 비슷한 폴더(10/2 와 10/28)는 보호하지 않음', r3.missing === hidden && sumTotal(db, root) === n - hidden, `기대 ${hidden}개, ${JSON.stringify(r3)}`));
        const r4 = await makeLib(db, et).scan(root);
        out.push(sub('정상으로 읽으면 되돌아옴', r4.missing === 0 && r4.read === 0 && sumTotal(db, root) === n, JSON.stringify(r4)));
      });

      // 16d 제외 폴더, 특수문자 이름
      await withDb(env, 'scan-names', async (db) => {
        const root = copyLibrary(env);
        const n = listMedia(root).length;
        const srcRel = path.join('2026', '10', '28', '2026-10-28_134058_IMG_0101.jpg');
        if (!fs.existsSync(path.join(root, srcRel))) { out.push(sub('특수문자 시험용 사진 준비', false, srcRel)); return; }
        fs.mkdirSync(path.join(root, '2025년도'));
        fs.copyFileSync(path.join(root, srcRel), path.join(root, '2025년도', 'a.jpg'));
        fs.copyFileSync(path.join(root, srcRel), path.join(root, '사진 #1 100%.jpg'));
        await makeLib(db, et).scan(root);
        const known = [...db.knownFiles(root).keys()];
        out.push(sub('후가공 폴더(2025년도) 제외', !known.some((p) => p.includes('2025년도')) && sumTotal(db, root) === n + 1, `${sumTotal(db, root)}개`));
        const sp = db.listDays(root, ALL).map((d) => fileNamed(db, root, d.day, '사진 #1 100%.jpg')).find((f) => f);
        out.push(sub('특수문자 이름의 날짜를 정상으로 읽음', !!sp && sp.takenDay === DAY && sp.takenAtSource === 'exif' && sp.readError === null, sp ? `${sp.takenDay} ${sp.takenAtSource}` : '못 찾음'));
      });

      // 16e 잘못된 날짜(0000:00:00)는 파일 이름 날짜로 (쓰기는 임시 복사본에만)
      await withDb(env, 'scan-baddate', async (db) => {
        const root = path.join(env.tmp, 'library-scan', 'baddate');
        fs.mkdirSync(root, { recursive: true });
        const file = path.join(root, '2026-01-02_030405_x.jpg');
        fs.copyFileSync(path.join(env.full.backupRoot, '_날짜없음', 'noinfo.jpg'), file);
        // exiftool은 0000:00:00 을 보통 방식(=)으로는 안 써 줘서 원래 값을 그대로 쓰는 #= 로 써요
        await et.write(['-overwrite_original', '-DateTimeOriginal#=0000:00:00 00:00:00', file]);
        const [back] = await et.read([file], ['DateTimeOriginal']);
        const r = await makeLib(db, et).scan(root);
        const f = fileNamed(db, root, '2026-01-02', '2026-01-02_030405_x.jpg');
        out.push(sub('잘못된 날짜는 파일 이름 날짜로', !!back && back.DateTimeOriginal === '0000:00:00 00:00:00' && !!f && f.takenAtSource === 'filename' && f.takenAt === '2026-01-02T03:04:05' && r.status === 'done', `쓴 값 ${back && back.DateTimeOriginal}, ${f ? f.takenAtSource + ' ' + f.takenAt : '못 찾음'}`));
      });

      // 16f 읽는 중 파일 사라짐, 읽기 실패 파일은 "다시 읽기"를 눌러야 다시 읽음
      await withDb(env, 'scan-vanish', async (db) => {
        const root = copyLibrary(env);
        const n = listMedia(root).length;
        const x = path.join(root, '_날짜없음', 'noinfo.jpg');
        const vanish = fakeEt(et, (files, tags, list) => {
          fs.renameSync(x, path.join(stash, 'vanished.bin')); // 읽는 도중 사라진 것처럼
          return list.filter((m) => planner().keyOf(m.SourceFile) !== planner().keyOf(x));
        });
        const r1 = await makeLib(db, vanish).scan(root);
        const rec = db.knownFiles(root).get(x);
        out.push(sub('읽는 중 사라진 파일: readError를 넣고 계속', r1.status === 'done' && r1.read === n && !!rec && !!rec.readError && sumTotal(db, root) === n, `${JSON.stringify(r1)} / ${rec && rec.readError}`));
        const r2 = await makeLib(db, et).scan(root);
        out.push(sub('다음 읽기에서 missing', r2.status === 'done' && r2.missing === 1 && sumTotal(db, root) === n - 1, JSON.stringify(r2)));
      });
      await withDb(env, 'scan-retry', async (db) => {
        const root = copyLibrary(env);
        const n = listMedia(root).length;
        const x = path.join(root, '_날짜없음', 'noinfo.jpg');
        const omit = fakeEt(et, (files, tags, list) => list.filter((m) => planner().keyOf(m.SourceFile) !== planner().keyOf(x)));
        await makeLib(db, omit).scan(root);
        const bad = db.knownFiles(root).get(x);
        const r1 = await makeLib(db, et).scan(root);
        out.push(sub('readError 파일은 보통 읽기에서 건너뜀', !!bad && !!bad.readError && r1.read === 0 && r1.skipped === n, JSON.stringify(r1)));
        const r2 = await makeLib(db, et).scan(root, { retryErrors: true });
        const fixed = db.knownFiles(root).get(x);
        out.push(sub('다시 읽기(retryErrors)에서는 다시 읽음', r2.read === 1 && r2.skipped === n - 1 && !!fixed && fixed.readError === null, JSON.stringify(r2)));
      });

      // 16g 읽는 중 오류: 그 회차에는 missing을 만들지 않고 첫 묶음은 남김. 정상으로 다시 읽으면 전부 저장
      await withDb(env, 'scan-error', async (db) => {
        const root = copyLibrary(env);
        const n = listMedia(root).length;
        if (n < 7) { out.push(sub('묶음 시험용 파일 수 (7개 이상)', false, `${n}개`)); return; }
        const ghost = path.join(root, 'ghost.jpg'); // DB에는 있는데 폴더에는 없는 파일 (오류가 나면 missing이 되면 안 돼요)
        db.upsertFiles([row({ root, path: ghost, name: 'ghost.jpg', mtimeMs: 1 })]);
        const boom = fakeEt(et, (files, tags, list, count) => {
          if (count === 2) throw new Error('가짜 오류');
          return list;
        });
        const r1 = await makeLib(db, boom, { chunkSize: 3 }).scan(root);
        out.push(sub('두 번째 묶음 오류: status error, 첫 묶음 유지, missing 0', r1.status === 'error' && r1.missing === 0 && r1.read === 3 && sumTotal(db, root) === 4 && db.knownFiles(root).get(ghost).missing === 0, JSON.stringify(r1)));
        const r2 = await makeLib(db, et, { chunkSize: 3 }).scan(root);
        out.push(sub('정상으로 다시 읽으면 전부 저장', r2.status === 'done' && r2.read === n - 3 && r2.skipped === 3 && r2.missing === 1 && sumTotal(db, root) === n, JSON.stringify(r2)));
      });

      // 16h 겹치지 않음, 가져오기 우선, exiftool 없음
      await withDb(env, 'scan-overlap-base', async (dbBase) => {
        await withDb(env, 'scan-overlap', async (db) => {
          const root = copyLibrary(env);
          const calls = { n: 0 };
          const counted = { run: (a) => et.run(a), read: (f, t) => { calls.n++; return et.read(f, t); } };
          await makeLib(dbBase, counted).scan(root); // 한 번 읽을 때 몇 번 부르는지
          const once = calls.n;
          calls.n = 0;
          const lib = makeLib(db, counted);
          const p1 = lib.scan(root);
          const p2 = lib.scan(root);
          const during = lib.isScanning();
          await p1;
          out.push(sub('scan 두 번 호출은 같은 Promise, 읽기 1회', p1 === p2 && during === true && lib.isScanning() === false && once > 0 && calls.n === once, `호출 ${calls.n}번 (한 번 읽을 때 ${once}번)`));
          const p3 = lib.scan(root);
          await p3;
          out.push(sub('끝난 뒤 다시 부르면 새로 시작', p3 !== p1));
        });
      });

      await withDb(env, 'scan-busy', async (db) => {
        const root = copyLibrary(env);
        const n = listMedia(root).length;
        if (n < 7) { out.push(sub('묶음 시험용 파일 수 (7개 이상)', false, `${n}개`)); return; }
        let busy = false;
        let changes = 0;
        const lib = makeLib(db, et, { chunkSize: 3, isBusy: () => busy, onChanged: () => { if (++changes === 1) busy = true; } });
        const p = lib.scan(root);
        await waitUntil(() => changes >= 1, 10000);
        await sleep(1500); // 가져오기 중이라고 알린 동안
        const during = sumTotal(db, root);
        busy = false;
        const r = await p;
        out.push(sub('가져오기 우선: 바쁜 동안 다음 묶음을 읽지 않고 끝나면 이어 감', during === 3 && r.status === 'done' && r.read === n && sumTotal(db, root) === n, `바쁜 동안 ${during}개, 끝난 뒤 ${sumTotal(db, root)}개`));
      });

      // 16h2 읽는 중에 들어온 요청: 다른 root, retryErrors, changed는 사라지지 않고 이어서 처리됨
      const touch = (p) => { const t = new Date(Date.now() - 7 * 86400000); fs.utimesSync(p, t, t); };
      await withDb(env, 'scan-other-root', async (db) => {
        const rootA = copyLibrary(env);
        const rootB = copyLibrary(env);
        const n = listMedia(rootB).length;
        if (n < 7) { out.push(sub('묶음 시험용 파일 수 (7개 이상)', false, `${n}개`)); return; }
        let busy = false;
        let changes = 0;
        const lib = makeLib(db, et, { chunkSize: 3, isBusy: () => busy, onChanged: () => { if (++changes === 1) busy = true; } });
        const pA = lib.scan(rootA);
        await waitUntil(() => changes >= 1, 10000);
        const pB = lib.scan(rootB); // A를 읽는 중에 B를 요청
        busy = false;
        const rA = await pA;
        const rB = await pB;
        out.push(sub('읽는 중 다른 root 요청: A는 superseded(missing 없음), B를 끝까지 읽음', pA !== pB && rA.status === 'superseded' && rA.missing === 0 && rA.read === 3 && rB.status === 'done' && rB.read === n && sumTotal(db, rootB) === n && sumTotal(db, rootA) === 3 && lib.isScanning() === false, `${JSON.stringify(rA)} / ${JSON.stringify(rB)}`));
      });

      await withDb(env, 'scan-retry-during', async (db) => {
        const root = copyLibrary(env);
        const n = listMedia(root).length;
        const files = listMedia(root).map((f) => f.path).sort();
        const x = files[files.length - 1];
        const omitX = fakeEt(et, (fl, tg, list) => list.filter((m) => planner().keyOf(m.SourceFile) !== planner().keyOf(x)));
        await makeLib(db, omitX).scan(root); // x는 읽기 실패로 남김
        touch(files[0]); // 읽을 파일 1개를 만들어 두고, 가져오기 중인 것처럼 멈춰 세움
        let busy = true;
        const lib = makeLib(db, et, { isBusy: () => busy });
        const p1 = lib.scan(root);
        await sleep(300);
        const same = lib.scan(root); // 똑같은 요청은 같은 Promise
        const p2 = lib.scan(root, { retryErrors: true });
        busy = false;
        const r1 = await p1;
        const r2 = await p2;
        const fixed = db.knownFiles(root).get(x);
        out.push(sub('같은 요청은 같은 Promise, 읽는 중 retryErrors는 이어서 처리', same === p1 && p2 !== p1 && r1.read === 1 && r2.read === 1 && !!fixed && fixed.readError === null && sumTotal(db, root) === n, `${JSON.stringify(r1)} / ${JSON.stringify(r2)}`));
      });

      await withDb(env, 'scan-changed-during', async (db) => {
        const root = copyLibrary(env);
        const n = listMedia(root).length;
        const files = listMedia(root).map((f) => f.path).sort();
        await makeLib(db, et).scan(root);
        touch(files[0]);
        let busy = true;
        const lib = makeLib(db, et, { isBusy: () => busy });
        const p1 = lib.scan(root);
        await sleep(300); // 찾기가 끝난 뒤
        fs.copyFileSync(files[0], path.join(root, '2026-10-30_010203_late.jpg')); // 찾은 뒤에 늘어난 파일
        const p2 = lib.scan(root, { changed: true });
        busy = false;
        const r1 = await p1;
        const r2 = await p2;
        out.push(sub('찾은 뒤 늘어난 파일은 scan(root, { changed: true })가 읽음', p2 !== p1 && r1.read === 1 && r2.read === 1 && sumTotal(db, root) === n + 1, `${JSON.stringify(r1)} / ${JSON.stringify(r2)}`));
      });

      await withDb(env, 'scan-noet', async (db) => {
        const root = copyLibrary(env);
        const n = listMedia(root).length;
        await makeLib(db, et).scan(root);
        const r = await makeLib(db, null).scan(root);
        out.push(sub('exiftool 없음: no-exiftool, 저장된 목록 유지', r.status === 'no-exiftool' && r.read === 0 && sumTotal(db, root) === n, JSON.stringify(r)));
      });

      // 16j walk와 walkAsync가 같은 파일을 찾음 (제외 폴더 포함). 못 읽은 폴더도 알려 줌
      {
        const root = copyLibrary(env);
        for (const d of ['2025년도', '_정리완료원본', '.숨김폴더', '$RECYCLE.BIN']) {
          fs.mkdirSync(path.join(root, d));
          fs.copyFileSync(path.join(root, '_날짜없음', 'noinfo.jpg'), path.join(root, d, 'x.jpg'));
        }
        fs.copyFileSync(path.join(root, '_날짜없음', 'noinfo.jpg'), path.join(root, '.hid.jpg'));
        fs.copyFileSync(path.join(root, '_날짜없음', 'noinfo.jpg'), path.join(root, 'a.__tmp__.jpg'));
        fs.writeFileSync(path.join(root, 'memo.txt'), 'x');
        const P = planner();
        const noop = () => {};
        const keys = (list) => list.map((f) => P.keyOf(f.path)).sort();
        const syncList = P.walk(root, true, [], noop, noop);
        const asyncList = await P.walkAsync(root, true, [], noop, noop);
        const excluded = !syncList.some((f) => /2025년도|_정리완료원본|\.숨김폴더|RECYCLE|\.hid|__tmp__|memo/.test(f.path));
        out.push(sub('walk와 walkAsync가 같은 파일 (후가공, _정리완료원본, 숨김 제외)', JSON.stringify(keys(syncList)) === JSON.stringify(keys(asyncList)) && syncList.length > 0 && excluded && JSON.stringify(syncList.map((f) => [f.size, f.mtimeMs, f.isVideo])) === JSON.stringify(asyncList.map((f) => [f.size, f.mtimeMs, f.isVideo])), `${syncList.length}개 / ${asyncList.length}개`));
        const topSync = keys(P.walk(root, false, [], noop, noop));
        const topAsync = keys(await P.walkAsync(root, false, [], noop, noop));
        out.push(sub('하위 폴더를 안 보는 경우(includeSub=false)도 같음', JSON.stringify(topSync) === JSON.stringify(topAsync) && topSync.length < syncList.length));

        // 못 읽은 폴더: fs의 readdir을 잠깐 바꿔서 한 폴더만 오류가 나게 해요 (끝나면 꼭 되돌림)
        const bad = path.join(root, '2026', '10', '27');
        const origSync = fs.readdirSync;
        const origAsync = fs.promises.readdir;
        const isBad = (d) => P.keyOf(String(d)) === P.keyOf(bad);
        const failErr = () => Object.assign(new Error('EACCES: 가짜 권한 오류'), { code: 'EACCES' });
        fs.readdirSync = (d, ...a) => { if (isBad(d)) throw failErr(); return origSync.call(fs, d, ...a); };
        fs.promises.readdir = async (d, ...a) => { if (isBad(d)) throw failErr(); return origAsync.call(fs.promises, d, ...a); };
        const sErr = [];
        const aErr = [];
        let sFiles;
        let aFiles;
        try {
          sFiles = P.walk(root, true, [], noop, (d) => sErr.push(d));
          aFiles = await P.walkAsync(root, true, [], noop, (d) => aErr.push(d));
        } finally {
          fs.readdirSync = origSync;
          fs.promises.readdir = origAsync;
        }
        out.push(sub('못 읽은 폴더는 둘 다 알려 주고 그 안 파일은 빠짐', sErr.length === 1 && aErr.length === 1 && P.keyOf(sErr[0]) === P.keyOf(bad) && P.keyOf(aErr[0]) === P.keyOf(bad) && JSON.stringify(keys(sFiles)) === JSON.stringify(keys(aFiles)) && sFiles.length < syncList.length, `${sErr.length}개 / ${aErr.length}개, ${sFiles.length}개 / ${aFiles.length}개`));
      }

      // 16i 샘플 원본(test/samples)을 건드리지 않았는지 다시 확인 (쓰기는 임시 복사본에만 했어요)
      {
        const samples = path.join(__dirname, '..', 'test', 'samples');
        const now = {};
        for (const e of fs.readdirSync(samples, { recursive: true, withFileTypes: true })) {
          if (!e.isFile()) continue;
          const p = path.join(e.parentPath || e.path, e.name);
          now[path.relative(samples, p).split(path.sep).join('/')] = sha1Of(p);
        }
        out.push(sub('test/samples 원본 그대로', JSON.stringify(now) === JSON.stringify(env.samplesBefore)));
      }

      return out;
    },
  },
  {
    no: 17,
    name: '갤러리 썸네일',
    async run(env) {
      const out = [];
      const sharp = require('sharp');
      const { createThumbs, thumbPath } = require('../lib/thumbs');
      const { handleMedia } = require('../lib/media-protocol');
      const { runCmd } = require('../lib/tools');
      const { createLogger } = require('../lib/logger');
      const tools = env.tools;
      const AUTO = path.join(__dirname, '..', 'test', 'samples', 'auto');
      const VIDEO_SRC = path.join(env.full.backupRoot, '2026', '10', '28', '2026-10-28_134113_IMG_0103.mp4');
      const DAY = '2026-10-25'; // row()의 기본 날짜
      const maxSide = async (p) => {
        const m = await sharp(p).metadata();
        return { format: m.format, w: m.width, h: m.height, max: Math.max(m.width, m.height) };
      };
      const state = (db, id) => db.getFile(id).thumbState;
      const listAll = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.relative(dir, path.join(e.parentPath || e.path, e.name)))
        .sort();

      // 17용 임시 폴더: src(사진 복사본) / thumbs(썸네일) / logs. 사진은 전부 복사본이에요
      const base = path.join(env.tmp, 'thumbs-check', 'main');
      const src = path.join(base, 'src');
      const thumbDir = path.join(base, 'thumbs');
      fs.mkdirSync(path.join(src, '한글 폴더'), { recursive: true });
      const put = (rel, from) => {
        const to = path.join(src, rel);
        fs.copyFileSync(from, to);
        return to;
      };
      const jpg = put('IMG_0101.jpg', path.join(AUTO, 'IMG_0101.jpg'));
      const hangul = put(path.join('한글 폴더', 'noinfo.jpg'), path.join(AUTO, 'noinfo.jpg'));
      const png = put('IMG_0102.png', path.join(AUTO, 'IMG_0102.PNG'));
      const special = put('사진 #1 100%.jpg', jpg);
      const rotated = put('회전.jpg', jpg);
      await env.et.write(['-overwrite_original', '-Orientation#=6', rotated]); // 복사본에만 씀
      const next = put('다음.jpg', jpg);
      const stale = put('낡은임시.jpg', jpg);
      const gone = put('사라질.jpg', jpg);
      const big = path.join(src, '큰사진.jpg');
      await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#8899aa' } }).jpeg().toFile(big);
      const hasVideo = fs.existsSync(VIDEO_SRC);
      const video = hasVideo ? put('영상.mp4', VIDEO_SRC) : null;
      const shortVideo = hasVideo ? put('짧은영상.mp4', VIDEO_SRC) : null;
      const broken = hasVideo ? path.join(src, '깨진영상.mp4') : null;
      if (hasVideo) breakMp4(VIDEO_SRC, broken, 4096);
      const empty = path.join(src, '빈파일.jpg');
      fs.writeFileSync(empty, '');
      const fake = path.join(src, '가짜.jpg');
      fs.writeFileSync(fake, '이건 사진이 아니에요');
      const bmp = path.join(src, '형식.bmp');
      let bmpOk = false;
      if (tools.magick.ok) bmpOk = (await runCmd(tools.magick.path, [jpg, bmp])).code === 0 && fs.existsSync(bmp);
      const all = [jpg, hangul, png, special, rotated, next, stale, gone, big, empty, fake];
      if (hasVideo) all.push(video, shortVideo, broken);
      if (bmpOk) all.push(bmp);

      // DB에 올릴 줄. gone은 DB에 올린 뒤 폴더에서 지워요 (DB에는 있는데 폴더에는 없는 파일)
      const rowOf = (file, root = src) => {
        const st = fs.statSync(file);
        const isVideo = /\.mp4$/.test(file);
        return row({
          root,
          path: file,
          name: path.basename(file),
          mediaType: isVideo ? 'video' : 'photo',
          size: st.size,
          mtimeMs: Math.floor(st.mtimeMs),
          durationSec: isVideo ? (file === shortVideo ? 0.5 : 3) : null,
        });
      };

      let before = [];
      await withDb(env, 'thumbs', async (db) => {
        db.upsertFiles(all.map((f) => rowOf(f)));
        fs.rmSync(gone);
        before = listAll(src);
        const idOf = (file) => fileNamed(db, src, DAY, path.basename(file)).id;
        const logDir = path.join(base, 'logs');
        const thumbs = createThumbs({ db, thumbDir, getTools: () => tools, isBusy: () => false, logger: createLogger(logDir) });

        // 17a 사진, 한글 폴더 경로, PNG, 특수문자 이름: webp가 생기고 긴 변이 320 이하
        const okFiles = [['사진', jpg], ['한글 폴더 경로', hangul], ['PNG', png], ['특수문자 이름 (사진 #1 100%.jpg)', special]];
        const made = await Promise.all(okFiles.map(([, f]) => thumbs.request(idOf(f))));
        for (let i = 0; i < okFiles.length; i++) {
          const p = made[i];
          let m = null;
          try { m = p ? await maxSide(p) : null; } catch (e) { m = null; }
          out.push(sub(okFiles[i][0], !!p && !!m && m.format === 'webp' && m.max <= 320 && m.max > 0 && state(db, idOf(okFiles[i][1])) === 'ready' && p.startsWith(thumbDir), p ? JSON.stringify(m) : '썸네일 없음'));
        }
        out.push(sub('썸네일 위치는 <앞 2글자>/<sha1>.webp', !!made[0] && made[0] === thumbPath(thumbDir, db.getFile(idOf(jpg))) && /^[0-9a-f]{2}$/.test(path.basename(path.dirname(made[0]))) && /^[0-9a-f]{40}\.webp$/.test(path.basename(made[0])), made[0] || ''));

        // 17b 회전 정보: Orientation=6 이면 세로가 더 김
        const rp = await thumbs.request(idOf(rotated));
        const rm = rp ? await maxSide(rp) : null;
        out.push(sub('회전 정보 반영 (Orientation=6 이면 세로가 더 김)', !!rm && rm.h > rm.w && rm.max <= 320, rm ? JSON.stringify(rm) : '썸네일 없음'));

        // 17c 영상: mp4 썸네일, 1초보다 짧은 영상, 손상 영상
        if (!hasVideo || !tools.ffmpeg.ok) {
          out.push({ label: '영상 썸네일', status: 'skip', detail: hasVideo ? 'ffmpeg 없음' : '샘플 영상 없음' });
        } else {
          const vp = await thumbs.request(idOf(video));
          const vm = vp ? await maxSide(vp) : null;
          out.push(sub('영상: mp4 썸네일 생성', !!vm && vm.format === 'webp' && vm.max <= 320 && state(db, idOf(video)) === 'ready', vm ? JSON.stringify(vm) : '썸네일 없음'));
          const sp = await thumbs.request(idOf(shortVideo));
          out.push(sub('1초보다 짧다고 적힌 영상은 첫 장면 (-ss 없이)', !!sp && state(db, idOf(shortVideo)) === 'ready', sp || '썸네일 없음'));
          const bp = await thumbs.request(idOf(broken));
          const np = await thumbs.request(idOf(next));
          out.push(sub('손상 영상: failed, 다음 파일은 정상', bp === null && state(db, idOf(broken)) === 'failed' && !!np && state(db, idOf(next)) === 'ready', `손상 ${state(db, idOf(broken))}, 다음 ${state(db, idOf(next))}`));
        }

        // 17d 0바이트, 사진이 아닌 파일: failed / 폴더에서 사라진 파일: 상태 그대로(none). request는 거절되지 않고 null
        let threw = false;
        const results = await Promise.all([empty, fake, gone].map((f) => thumbs.request(idOf(f)).catch(() => { threw = true; return 'error'; })));
        out.push(sub('0바이트 파일: failed', results[0] === null && state(db, idOf(empty)) === 'failed', `${results[0]}`));
        out.push(sub('사진이 아닌 파일: failed', results[1] === null && state(db, idOf(fake)) === 'failed'));
        out.push(sub('폴더에서 사라진 파일: null이고 상태는 none 그대로 (failed로 기록하지 않음), request는 거절되지 않음', results[2] === null && state(db, idOf(gone)) === 'none' && !threw, `${results[2]}, ${state(db, idOf(gone))}`));
        out.push(sub('없는 id는 null', (await thumbs.request(999999)) === null));

        // 17e 다른 형식(bmp): sharp 또는 ImageMagick으로 만들어짐
        if (bmpOk) {
          const bpth = await thumbs.request(idOf(bmp));
          const bm = bpth ? await maxSide(bpth) : null;
          out.push(sub('bmp 같은 형식도 만들어짐 (sharp 또는 ImageMagick)', !!bm && bm.format === 'webp' && bm.max <= 320, bm ? JSON.stringify(bm) : '썸네일 없음'));
        }

        // 17f 낡은 임시 파일은 썸네일이 아님. 이미 만든 썸네일은 다시 만들지 않고 ready로
        {
          const f = db.getFile(idOf(stale));
          const dest = thumbPath(thumbDir, f);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest + '.tmp-old', '깨진 임시 파일');
          const p = await thumbs.request(f.id);
          const m = p ? await maxSide(p) : null;
          out.push(sub('낡은 임시 파일이 있어도 진짜 썸네일을 만듦', p === dest && !!m && m.format === 'webp', m ? JSON.stringify(m) : '썸네일 없음'));
          const t1 = fs.statSync(dest).mtimeMs;
          db.setThumbState(f.id, 'none');
          const again = await thumbs.request(f.id);
          out.push(sub('이미 있는 썸네일은 다시 만들지 않고 ready로', again === dest && fs.statSync(dest).mtimeMs === t1 && state(db, f.id) === 'ready'));
        }

        // 17g 실패 다시 시도
        {
          const failedIds = [empty, fake].map(idOf);
          const failedBefore = failedIds.map((id) => state(db, id));
          thumbs.retryFailed(src);
          const states = failedIds.map((id) => state(db, id));
          const queued = db.nextThumbJobs(src, 100).map((j) => j.id);
          out.push(sub('실패 다시 시도: failed였던 파일이 none으로', failedBefore.every((x) => x === 'failed') && states.every((x) => x === 'none') && failedIds.every((id) => queued.includes(id)), states.join(',')));
        }

        // 17h 패널 미리보기: 사진은 긴 변 1200px, 저장하지 않음. 영상은 썸네일 파일 내용
        {
          const filesBefore = listAll(thumbDir);
          const pv = await thumbs.preview(idOf(big));
          const pm = pv ? await sharp(pv.buffer).metadata() : null;
          out.push(sub('사진 미리보기: webp, 긴 변 1200px', !!pv && pv.type === 'image/webp' && !!pm && pm.format === 'webp' && Math.max(pm.width, pm.height) === 1200, pm ? JSON.stringify([pm.width, pm.height]) : '없음'));
          out.push(sub('미리보기는 저장하지 않음 (썸네일 폴더 파일 그대로)', JSON.stringify(listAll(thumbDir)) === JSON.stringify(filesBefore)));
          if (hasVideo && tools.ffmpeg.ok) {
            const vp = await thumbs.preview(idOf(video));
            const tp = thumbPath(thumbDir, db.getFile(idOf(video)));
            out.push(sub('영상 미리보기는 썸네일 파일 내용', !!vp && vp.type === 'image/webp' && fs.existsSync(tp) && Buffer.compare(vp.buffer, fs.readFileSync(tp)) === 0));
            out.push(sub('손상 영상 미리보기는 null', (await thumbs.preview(idOf(broken))) === null));
          }
          out.push(sub('미리보기: 없는 id, 사라진 파일은 null', (await thumbs.preview(999999)) === null && (await thumbs.preview(idOf(gone))) === null));
        }

        // 17i pvm:// 판단
        {
          let dbCalls = 0;
          let thumbCalls = 0;
          const spyDb = { getFile: (id) => { dbCalls++; return db.getFile(id); } };
          const spyThumbs = {
            request: (id) => { thumbCalls++; return thumbs.request(id); },
            preview: (id) => { thumbCalls++; return thumbs.preview(id); },
          };
          const media = (u) => handleMedia(u, { db: spyDb, thumbs: spyThumbs });
          const jid = idOf(jpg);
          const t = await media('pvm://thumb/' + jid);
          const pr = await media('pvm://preview/' + jid);
          out.push(sub('pvm://thumb/<id> 는 200과 경로', t.status === 200 && typeof t.path === 'string' && t.path.startsWith(thumbDir) && fs.existsSync(t.path), JSON.stringify({ status: t.status, path: t.path })));
          out.push(sub('pvm://preview/<id> 는 200과 내용', pr.status === 200 && Buffer.isBuffer(pr.buffer) && pr.buffer.length > 0 && pr.type === 'image/webp', String(pr.status)));
          dbCalls = 0;
          thumbCalls = 0;
          const bad = [
            'pvm://thumb/abc', 'pvm://thumb/..%2F..%2Fa', 'pvm://other/1', 'pvm://thumb/1%20', 'pvm://thumb/0', 'pvm://thumb/01',
            'pvm://thumb/1/2', 'pvm://thumb/', 'pvm://thumb', 'pvm://thumb/-1', 'pvm://thumb/1.5', 'pvm://thumb/99999999999999999999',
            'http://thumb/1', 'file:///C:/a.jpg', '이건 주소가 아니에요', '', 'pvm://user@thumb/1', 'pvm://thumb:80/1', 'pvm://preview/%2e%2e',
          ];
          const got = [];
          for (const u of bad) got.push((await media(u)).status);
          out.push(sub('잘못된 주소는 404이고 DB, 파일을 건드리지 않음', got.every((x) => x === 404) && dbCalls === 0 && thumbCalls === 0, `${got.join(',')} / DB ${dbCalls}번, 만들기 ${thumbCalls}번`));
          const nf = await media('pvm://thumb/999999');
          out.push(sub('DB에 없는 id는 404 (썸네일 만들기 없음)', nf.status === 404 && thumbCalls === 0));
          if (hasVideo && tools.ffmpeg.ok) {
            const bt = await media('pvm://thumb/' + idOf(broken));
            const bp = await media('pvm://preview/' + idOf(broken));
            out.push(sub('만들기에 실패한 영상은 404', bt.status === 404 && bp.status === 404, `${bt.status}, ${bp.status}`));
          }
          const gt = await media('pvm://thumb/' + idOf(gone));
          out.push(sub('폴더에서 사라진 사진은 404', gt.status === 404));
        }

        await thumbs.stop();
        out.push(sub('stop 뒤 새 요청은 null', (await thumbs.request(idOf(jpg))) === null && (await thumbs.preview(idOf(big))) === null));
        const leftovers = listAll(thumbDir).filter((n) => !n.endsWith('.webp') && !n.endsWith('.tmp-old'));
        out.push(sub('썸네일 폴더에 임시 파일이 남지 않음 (일부러 만든 낡은 파일 제외)', leftovers.length === 0, leftovers.join(',')));
      });

      // 17j FFmpeg 없음: 사진은 만들고 영상은 failed. 도구 정보가 아예 없어도 사진은 만듦
      if (hasVideo) {
        await withDb(env, 'thumbs-noffmpeg', async (db) => {
          db.upsertFiles([rowOf(jpg), rowOf(video)]);
          const jid = fileNamed(db, src, DAY, 'IMG_0101.jpg').id;
          const vid = fileNamed(db, src, DAY, '영상.mp4').id;
          const noFfmpeg = { ...tools, ffmpeg: { ok: false, path: null } };
          const t = createThumbs({ db, thumbDir: path.join(base, 'thumbs-noffmpeg'), getTools: () => noFfmpeg, isBusy: () => false, logger: null });
          const a = await t.request(jid);
          const b = await t.request(vid);
          out.push(sub('FFmpeg 없음: 사진은 만들고 영상은 failed', !!a && b === null && state(db, vid) === 'failed'));
          const none = createThumbs({ db, thumbDir: path.join(base, 'thumbs-notools'), getTools: () => null, isBusy: () => false, logger: null });
          out.push(sub('도구 정보가 없어도 사진은 만들어짐', !!(await none.request(jid))));
        });
      }

      // 17k 시간 초과
      {
        const t0 = Date.now();
        const r = await runCmd('node', ['-e', 'setTimeout(()=>{},30000)'], { timeoutMs: 200 });
        const ms = Date.now() - t0;
        out.push(sub('시간 초과: timedOut이고 5초 안에 끝남', r.timedOut === true && r.code === null && ms < 5000, `${ms}ms`));
        const ok = await runCmd('node', ['-e', 'console.log("hi")']);
        out.push(sub('시간 제한 없는 기존 호출은 그대로', ok.code === 0 && ok.stdout.trim() === 'hi' && !ok.timedOut));
      }

      // 17l 대기열 (가짜 maker): 최근 요청 먼저, 동시 4개, 같은 id는 한 번만
      await withDb(env, 'thumbs-queue', async (db) => {
        const dir = path.join(base, 'queue');
        fs.mkdirSync(dir, { recursive: true });
        const files = [];
        for (let i = 1; i <= 10; i++) {
          const f = path.join(dir, 'q' + String(i).padStart(2, '0') + '.jpg');
          fs.writeFileSync(f, 'x');
          files.push(f);
        }
        db.upsertFiles(files.map((f) => rowOf(f, dir)));
        const ids = files.map((f) => fileNamed(db, dir, DAY, path.basename(f)).id);
        const started = [];
        const gates = new Map();
        const maker = ({ file, tmpPath }) => {
          started.push(file.name);
          return new Promise((resolve) => gates.set(file.name, () => { fs.writeFileSync(tmpPath, 'x'); resolve(); }));
        };
        const t = createThumbs({ db, thumbDir: path.join(base, 'thumbs-queue'), getTools: () => tools, isBusy: () => false, logger: null, maker });
        const ps = ids.map((id) => t.request(id));
        const dup = t.request(ids[9]);
        await waitUntil(() => started.length >= 4, 5000);
        await sleep(200);
        out.push(sub('보이는 요청은 동시에 4개까지', started.length === 4 && [...started].sort().join() === 'q01.jpg,q02.jpg,q03.jpg,q04.jpg', started.join()));
        gates.get('q01.jpg')();
        await waitUntil(() => started.length >= 5, 5000);
        const fifth = started[4];
        gates.get(fifth)();
        await waitUntil(() => started.length >= 6, 5000);
        out.push(sub('최근 요청 먼저 (q10, q09 순서로 시작)', fifth === 'q10.jpg' && started[5] === 'q09.jpg', started.join()));
        for (let i = 0; i < 200 && started.length < 10; i++) {
          for (const [n, g] of [...gates]) { g(); gates.delete(n); }
          await sleep(20);
        }
        for (const g of gates.values()) g();
        const res = await Promise.all(ps);
        out.push(sub('모든 요청이 끝나고 같은 id는 한 번만 만듦', res.every((p) => !!p) && started.length === 10 && new Set(started).size === 10 && (await dup) === res[9], `${started.length}번 시작`));
      });

      // 17m 가져오기 우선: 바쁜 동안 백그라운드는 시작하지 않고, 끝나면 동시 2개로 만듦
      await withDb(env, 'thumbs-bg', async (db) => {
        const dir = path.join(base, 'bg');
        fs.mkdirSync(dir, { recursive: true });
        const files = [];
        for (let i = 1; i <= 8; i++) {
          const f = path.join(dir, 'b' + i + '.jpg');
          fs.writeFileSync(f, 'x');
          files.push(f);
        }
        db.upsertFiles(files.map((f) => rowOf(f, dir)));
        let busy = true;
        let calls = 0;
        let cur = 0;
        let peak = 0;
        const maker = async ({ tmpPath }) => {
          calls++;
          cur++;
          peak = Math.max(peak, cur);
          await sleep(80);
          fs.writeFileSync(tmpPath, 'x');
          cur--;
        };
        const logDirBg = path.join(base, 'logs-bg');
        const t = createThumbs({ db, thumbDir: path.join(base, 'thumbs-bg'), getTools: () => tools, isBusy: () => busy, logger: createLogger(logDirBg), maker });
        t.startBackground(dir);
        await sleep(800);
        const during = calls;
        busy = false;
        const done = await waitUntil(() => db.nextThumbJobs(dir, 100).length === 0 && cur === 0, 15000);
        const all8 = db.listFiles(dir, DAY, ALL).every((f) => f.thumbState === 'ready');
        out.push(sub('가져오기 우선: 바쁜 동안 시작 안 하고, 끝나면 이어서 전부 만듦', during === 0 && done && all8 && calls === 8, `바쁜 동안 ${during}개, 끝난 뒤 ${calls}개`));
        out.push(sub('백그라운드는 동시에 2개까지', peak === 2, `최대 ${peak}개`));
        await t.stop();
        const logs = fs.existsSync(logDirBg) ? fs.readdirSync(logDirBg).filter((n) => n.startsWith('gallery-thumbs_')) : [];
        out.push(sub('gallery-thumbs 로그가 남음', logs.length >= 1, `${logs.length}개`));
      });

      // 17n stop: 만들던 것은 끝내고(임시 파일 안 남김), 대기 중 요청과 새 요청은 null
      await withDb(env, 'thumbs-stop', async (db) => {
        const dir = path.join(base, 'stopdir');
        fs.mkdirSync(dir, { recursive: true });
        const files = [];
        for (let i = 1; i <= 6; i++) {
          const f = path.join(dir, 's' + i + '.jpg');
          fs.writeFileSync(f, 'x');
          files.push(f);
        }
        db.upsertFiles(files.map((f) => rowOf(f, dir)));
        const maker = async ({ tmpPath }) => {
          await sleep(300);
          fs.writeFileSync(tmpPath, 'x');
        };
        const thumbDir2 = path.join(base, 'thumbs-stop');
        const t = createThumbs({ db, thumbDir: thumbDir2, getTools: () => tools, isBusy: () => false, logger: null, maker });
        const ids = db.listFiles(dir, DAY, ALL).map((f) => f.id);
        const ps = ids.map((id) => t.request(id));
        await sleep(100);
        await t.stop();
        const res = await Promise.all(ps);
        const finished = res.filter((p) => p).length;
        const after = await t.request(ids[0]);
        const leftovers = fs.existsSync(thumbDir2) ? listAll(thumbDir2).filter((n) => !n.endsWith('.webp')) : [];
        out.push(sub('stop: 만들던 4개는 끝내고 대기 중 2개는 null, 이후 요청도 null', finished === 4 && res.filter((p) => p === null).length === 2 && after === null, `${finished}개 완료`));
        out.push(sub('stop 뒤 임시 파일이 남지 않음', leftovers.length === 0, leftovers.join(',')));
      });

      // 17p 시간 초과로 끈 프로그램은 완전히 끝난 뒤에 돌아와요 (윈도우에서 임시 파일이 잡힌 채 남지 않게)
      {
        const hangDir = path.join(base, 'hang');
        fs.mkdirSync(hangDir, { recursive: true });
        const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
        // 자기 pid를 파일에 적고 멈춰 있는 프로그램을 짧은 제한으로 실행 → 돌아온 시점에 그 프로그램이 없어야 해요
        const pidFile = path.join(hangDir, 'pid.txt');
        const r = await runCmd(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30000)', pidFile], { timeoutMs: 1500 });
        const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
        out.push(sub('시간 초과 뒤 멈춘 프로그램은 실제로 없어짐', r.timedOut === true && pid > 0 && !alive(pid), `pid ${pid}, timedOut ${r.timedOut}`));

        // 진짜 FFmpeg의 복사본(고유한 이름)에 아주 짧은 제한을 줘서 시간 초과 경로를 지나가요
        if (!hasVideo || !tools.ffmpeg.ok || process.platform !== 'win32') {
          out.push({ label: '영상 시간 초과', status: 'skip', detail: '영상 또는 FFmpeg 없음, 윈도우 아님' });
        } else {
          let exe = tools.ffmpeg.path;
          if (!path.isAbsolute(exe)) {
            // PATH 폴더에서 직접 찾아요 (where 출력은 한글 경로가 깨져요)
            const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
            const hit = dirs.map((d) => path.join(d, exe.endsWith('.exe') ? exe : exe + '.exe')).find((p) => fs.existsSync(p));
            exe = hit || '';
          }
          const exeName = `pvm-hang-ffmpeg-${process.pid}.exe`;
          const copy = path.join(hangDir, exeName);
          let usable = false;
          try {
            if (exe) {
              fs.copyFileSync(exe, copy);
              usable = (await runCmd(copy, ['-version'], { timeoutMs: 20000 })).code === 0;
            }
          } catch (e) { usable = false; }
          if (!usable) {
            out.push({ label: '영상 시간 초과', status: 'skip', detail: 'FFmpeg 복사본을 실행할 수 없음' });
          } else {
            await withDb(env, 'thumbs-hang', async (db) => {
              db.upsertFiles([rowOf(video)]);
              const vid = fileNamed(db, src, DAY, '영상.mp4').id;
              const hangThumbs = path.join(base, 'thumbs-hang');
              const t = createThumbs({ db, thumbDir: hangThumbs, getTools: () => ({ ...tools, ffmpeg: { ok: true, path: copy } }), isBusy: () => false, logger: null, ffmpegTimeoutMs: 30 });
              const got = await t.request(vid);
              await t.stop();
              const left = fs.existsSync(hangThumbs) ? listAll(hangThumbs) : [];
              const running = await runCmd('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH']);
              out.push(sub('FFmpeg 시간 초과: failed, 썸네일 폴더에 남은 파일 없음, 프로그램도 없음', got === null && state(db, vid) === 'failed' && left.length === 0 && !running.stdout.includes(exeName), `${state(db, vid)}, 남은 파일 ${left.join(',') || '없음'}`));
            });
          }
        }
      }

      // 17q 꺼지다 남은 임시 파일은 처음 쓸 때 치우고, 진짜 썸네일은 건드리지 않음. 상대 경로 파일은 failed
      await withDb(env, 'thumbs-sweep', async (db) => {
        const dir = path.join(base, 'thumbs-sweep');
        const hex = 'ab' + 'c'.repeat(38);
        fs.mkdirSync(path.join(dir, 'ab'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'cd'), { recursive: true });
        const real = path.join(dir, 'ab', `${hex}.webp`);
        await sharp({ create: { width: 10, height: 10, channels: 3, background: '#223344' } }).webp().toFile(real);
        const realBytes = fs.readFileSync(real);
        const temps = [
          path.join(dir, 'ab', `${hex}.webp.tmp-1-1`),
          path.join(dir, 'ab', `${hex}.webp.tmp-1-1.frame.jpg`),
          path.join(dir, 'ab', `${hex}.webp.tmp-1-2.magick.jpg`),
          path.join(dir, 'preview-1-1.magick.jpg'),
        ];
        for (const t of temps) fs.writeFileSync(t, '남은 임시 파일');
        const keep = path.join(dir, 'cd', '메모.txt'); // 패턴에 안 맞는 파일은 그대로
        fs.writeFileSync(keep, '남겨 둬요');
        db.upsertFiles([row({ root: 'REL', path: 'rel/x.jpg', name: 'x.jpg', size: 5, mtimeMs: 1 })]);
        const rid = fileNamed(db, 'REL', DAY, 'x.jpg').id;
        const t = createThumbs({ db, thumbDir: dir, getTools: () => tools, isBusy: () => false, logger: null });
        const rel = await t.request(rid); // 첫 사용 → 임시 파일 정리
        await t.stop();
        out.push(sub('남은 임시 파일은 처음 쓸 때 지움', temps.every((p) => !fs.existsSync(p)), temps.filter((p) => fs.existsSync(p)).length + '개 남음'));
        out.push(sub('진짜 .webp와 패턴 밖 파일은 그대로', fs.existsSync(real) && Buffer.compare(fs.readFileSync(real), realBytes) === 0 && fs.existsSync(keep)));
        out.push(sub('상대 경로 파일은 failed', rel === null && state(db, rid) === 'failed'));

        // 미리보기도 같은 확인: 작업 폴더를 임시로 옮기면 상대 경로가 진짜 사진을 가리키게 되지만, 그래도 null이어야 해요
        db.upsertFiles([row({ root: 'REL', path: path.join('src', 'IMG_0101.jpg'), name: 'rel-preview.jpg', size: 100, mtimeMs: 2 })]);
        const pid2 = fileNamed(db, 'REL', DAY, 'rel-preview.jpg').id;
        const t2 = createThumbs({ db, thumbDir: dir, getTools: () => tools, isBusy: () => false, logger: null });
        const cwd0 = process.cwd();
        let reachable = false;
        let pv = 'x';
        try {
          process.chdir(base);
          reachable = fs.existsSync(path.join('src', 'IMG_0101.jpg')); // 이 상대 경로는 실제로 읽을 수 있는 상태
          pv = await t2.preview(pid2);
        } finally {
          process.chdir(cwd0);
          await t2.stop();
        }
        out.push(sub('상대 경로 파일의 미리보기는 null', reachable && pv === null, `읽을 수 있는 상태 ${reachable}, 결과 ${pv === null ? 'null' : '있음'}`));
      });

      // 17r 원본을 읽을 수 없으면(연결 끊김, 파일 없음) failed로 기록하지 않고 none으로 둠. 깨진 파일은 그대로 failed
      //     (a) 만드는 도중 원본이 사라짐 (b) 백업 폴더 이름이 바뀜 → 백그라운드가 멈추고 나머지는 none, 되돌린 뒤 새 회차가 끝까지 만듦
      //     (c) 없는 파일이 앞쪽에 많아도 뒤의 파일까지 만들고 끝남 (끝없이 돌지 않음)
      await withDb(env, 'thumbs-disconnect', async (db) => {
        // (a)
        const dirA = path.join(base, 'disc-a');
        fs.mkdirSync(dirA, { recursive: true });
        const fa = path.join(dirA, 'a.jpg');
        const fb = path.join(dirA, 'b.jpg');
        fs.writeFileSync(fa, 'x');
        fs.writeFileSync(fb, 'x');
        db.upsertFiles([rowOf(fa, dirA), rowOf(fb, dirA)]);
        const ida = fileNamed(db, dirA, DAY, 'a.jpg').id;
        const idb = fileNamed(db, dirA, DAY, 'b.jpg').id;
        const makerA = async ({ file, tmpPath }) => {
          if (file.name === 'a.jpg') {
            fs.rmSync(file.path); // 만드는 사이에 USB를 뺀 것처럼
            throw new Error('읽는 도중 연결이 끊김');
          }
          throw new Error('이 파일은 깨져 있음'); // 읽을 수 있는데 만들지 못함
        };
        const tA = createThumbs({ db, thumbDir: path.join(base, 'thumbs-disc-a'), getTools: () => tools, isBusy: () => false, logger: null, maker: makerA });
        const ra = await tA.request(ida);
        const rb = await tA.request(idb);
        await tA.stop();
        out.push(sub('만들다가 원본이 사라지면 null이고 none 그대로, 읽을 수 있는 깨진 파일은 failed', ra === null && state(db, ida) === 'none' && rb === null && state(db, idb) === 'failed', `사라짐 ${state(db, ida)}, 깨짐 ${state(db, idb)}`));

        // (b)
        const dirB = path.join(base, 'disc-b');
        const awayB = path.join(base, 'disc-b-away');
        fs.mkdirSync(dirB, { recursive: true });
        const filesB = [];
        for (let i = 1; i <= 50; i++) {
          const f = path.join(dirB, 'd' + String(i).padStart(2, '0') + '.jpg');
          fs.writeFileSync(f, 'x');
          filesB.push(f);
        }
        db.upsertFiles(filesB.map((f) => rowOf(f, dirB)));
        let madeB = 0;
        const makerB = async ({ tmpPath }) => {
          const mine = ++madeB; // 동시에 2개가 돌아서, 내 번호를 따로 기억해요
          await sleep(10);
          fs.writeFileSync(tmpPath, 'x');
          if (mine === 5) fs.renameSync(dirB, awayB); // 폴더 이름이 바뀜 = 연결이 끊긴 것과 같아요
        };
        const logDirB = path.join(base, 'logs-disc-b');
        const tB = createThumbs({ db, thumbDir: path.join(base, 'thumbs-disc-b'), getTools: () => tools, isBusy: () => false, logger: createLogger(logDirB), maker: makerB });
        const endedB = await Promise.race([tB.startBackground(dirB).then(() => true), sleep(15000).then(() => false)]);
        const statesB = db.listFiles(dirB, DAY, ALL).map((f) => f.thumbState);
        const readyB = statesB.filter((s) => s === 'ready').length;
        const noneB = statesB.filter((s) => s === 'none').length;
        out.push(sub('폴더가 사라지면 백그라운드가 멈추고, 남은 파일은 모두 none (failed 없음)', endedB && fs.existsSync(awayB) && readyB >= 5 && readyB < 50 && noneB === 50 - readyB && !statesB.includes('failed'), `끝남 ${endedB}, ready ${readyB}, none ${noneB}`));
        const bgLogs = fs.existsSync(logDirB) ? fs.readdirSync(logDirB).filter((n) => n.startsWith('gallery-thumbs_')) : [];
        const bgLogText = bgLogs.map((n) => fs.readFileSync(path.join(logDirB, n), 'utf8')).join('\n');
        out.push(sub('멈춘 까닭이 로그에 남음 (백업 폴더를 열 수 없음), 건너뜀 개수도 기록', bgLogText.includes('백업 폴더를 열 수 없어') && bgLogText.includes('백그라운드 끝'), bgLogText.split('\n').slice(-2).join(' / ')));
        const callsAfterStop = madeB;
        await sleep(200);
        out.push(sub('멈춘 뒤에는 더 만들지 않음', madeB === callsAfterStop));
        fs.renameSync(awayB, dirB); // 다시 연결
        const endedB2 = await Promise.race([tB.startBackground(dirB).then(() => true), sleep(15000).then(() => false)]);
        const statesB2 = db.listFiles(dirB, DAY, ALL).map((f) => f.thumbState);
        out.push(sub('되돌린 뒤 새 회차가 나머지를 끝까지 만듦', endedB2 && statesB2.every((s) => s === 'ready'), `끝남 ${endedB2}, ready ${statesB2.filter((s) => s === 'ready').length}/50`));
        await tB.stop();

        // (c) 앞쪽 25개는 DB에는 있는데 폴더에서 사라진 파일 (배치 20개보다 많음), 뒤쪽 5개는 정상
        const dirC = path.join(base, 'disc-c');
        fs.mkdirSync(dirC, { recursive: true });
        const filesC = [];
        for (let i = 1; i <= 30; i++) {
          const f = path.join(dirC, 'c' + String(i).padStart(2, '0') + '.jpg');
          fs.writeFileSync(f, 'x');
          filesC.push(f);
        }
        db.upsertFiles(filesC.map((f) => rowOf(f, dirC)));
        const idsC = db.nextThumbJobs(dirC, 100).map((j) => j.id); // 대기열 순서 그대로
        for (const j of db.nextThumbJobs(dirC, 25)) fs.rmSync(j.path);
        const makerC = async ({ tmpPath }) => { fs.writeFileSync(tmpPath, 'x'); };
        const tC = createThumbs({ db, thumbDir: path.join(base, 'thumbs-disc-c'), getTools: () => tools, isBusy: () => false, logger: null, maker: makerC });
        const endedC = await Promise.race([tC.startBackground(dirC).then(() => true), sleep(15000).then(() => false)]);
        await tC.stop();
        const statesC = idsC.map((id) => state(db, id));
        out.push(sub('없는 파일이 20개보다 많이 앞에 있어도 뒤의 파일까지 만들고 끝남, 없는 파일은 none', endedC && statesC.filter((s) => s === 'ready').length === 5 && statesC.filter((s) => s === 'none').length === 25, `끝남 ${endedC}, ${statesC.join(',').slice(0, 80)}`));
      });

      // 17o 사진 폴더에는 아무것도 생기지 않음 (썸네일은 thumbs 폴더에만)
      const afterList = listAll(src);
      out.push(sub('사진 폴더에 파일 안 생김 (전후 파일 목록 같음)', JSON.stringify(before) === JSON.stringify(afterList) && !path.resolve(thumbDir).startsWith(path.resolve(src) + path.sep), `${before.length}개, ${afterList.length}개`));

      return out;
    },
  },
  {
    no: 18,
    name: '갤러리 화면과 연결',
    async run(env) {
      const out = [];
      const APP = path.join(__dirname, '..');
      const { launchCheck } = require('./launch-check');

      // 18a 백업 폴더를 정하지 않은 임시 userData로 띄워요 (진짜 설정과 DB는 읽지 않음). 버튼은 누르지 않아요
      const userData = path.join(env.tmp, 'launch-gallery');
      fs.mkdirSync(userData, { recursive: true });
      const r = await launchCheck(APP, { env: { PVM_USER_DATA: userData } });
      out.push(sub('창이 뜨고 정상 종료', r.exitCode === 0 && r.title === '사진/영상 관리 프로그램', `제목 "${r.title}", 종료 코드 ${r.exitCode}`));
      out.push(sub('가져오기 화면 열기 버튼 글자', r.text.includes('가져오기 화면 열기'), `화면 글자: ${String(r.text).slice(0, 120).replace(/\s+/g, ' ')}`));
      out.push(sub('화면 오류 없음', r.errors.length === 0, r.errors.join(' / ')));
      out.push(sub('임시 userData에 library.db가 만들어짐', fs.existsSync(path.join(userData, 'library.db'))));

      // 18b 불러오다 오류가 나도 대화상자 없이 바로 실패로 끝나요 (점검 때 사용자 화면이 멈추지 않게).
      //     앱 파일을 임시 폴더에 복사하고 복사본 lib/paths.js 끝에만 throw를 붙여요 (저장소 파일은 그대로)
      {
        const copy = path.join(env.tmp, 'app-throw');
        fs.mkdirSync(copy, { recursive: true });
        for (const f of ['main.js', 'gallery-main.js', 'preload.js', 'index.html', 'package.json']) fs.copyFileSync(path.join(APP, f), path.join(copy, f));
        fs.cpSync(path.join(APP, 'lib'), path.join(copy, 'lib'), { recursive: true });
        fs.appendFileSync(path.join(copy, 'lib', 'paths.js'), "\nthrow new Error('점검용 가짜 오류');\n");
        const ud = path.join(env.tmp, 'launch-throw');
        fs.mkdirSync(ud, { recursive: true });
        const exe = path.join(APP, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
        const t0 = Date.now();
        const bad = await launchCheck(copy, { port: 9334, exe, env: { PVM_USER_DATA: ud } });
        const ms = Date.now() - t0;
        out.push(sub('불러오다 난 오류는 대화상자 없이 실패로 끝남 (10초 안)', bad.ok === false && bad.exitCode === 1 && ms < 10000 && bad.errors.some((e) => e.includes('점검용 가짜 오류')), `${ms}ms, 종료 코드 ${bad.exitCode}, ${bad.errors.join(' / ').slice(0, 120)}`));
        out.push(sub('저장소의 lib/paths.js는 그대로', !fs.readFileSync(path.join(APP, 'lib', 'paths.js'), 'utf8').includes('점검용 가짜 오류')));
      }

      // 18c exiftool을 닫은 뒤 run은 거절하고 다시 켜지 않아요 (도구를 새로 찾을 때 옛 객체가 exiftool.exe를 남기지 않게)
      {
        const { ExifTool } = require('../lib/exiftool');
        const x = new ExifTool(env.tools.exiftool.path);
        const first = await x.run(['-ver']).then((v) => v.stdout.trim(), () => '');
        x.close();
        const msg = await x.run(['-ver']).then(() => null, (e) => e.message);
        out.push(sub('닫기 전에는 run이 동작', first !== ''));
        out.push(sub('닫은 뒤 run은 거절되고 프로그램이 다시 켜지지 않음', msg !== null && x.proc === null && x.queue.length === 0, `메시지 ${msg}`));
      }

      // 18d setupGallery를 가짜 ipcMain, protocol로 확인해요 (Electron 없이). library.scan 호출을 엿보려고
      //     gallery-main을 불러오는 동안만 createLibrary를 감싸고 바로 되돌려요
      {
        const { createLogger } = require('../lib/logger');
        const libMod = require('../lib/library');
        const scanCalls = [];
        const orig = libMod.createLibrary;
        libMod.createLibrary = (opts) => {
          const lib = orig(opts);
          return { ...lib, scan: (root, o) => { scanCalls.push({ root, o }); return lib.scan(root, o); } };
        };
        const gmPath = require.resolve('../gallery-main');
        delete require.cache[gmPath];
        let gm;
        try {
          gm = require('../gallery-main');
        } finally {
          libMod.createLibrary = orig;
          delete require.cache[gmPath];
        }

        const base = path.join(env.tmp, 'gallery-fake');
        const logger = createLogger(path.join(base, 'logs'));
        const makeFake = (userDir, settings) => {
          const f = { handlers: new Map(), loaded: [], flags: { running: false, planning: false }, pvm: null };
          f.g = gm.setupGallery({
            ipcMain: { handle: (ch, fn) => f.handlers.set(ch, fn) },
            protocol: { handle: (scheme, fn) => { f.pvm = fn; } },
            getWin: () => null,
            getSettings: () => settings,
            getTools: () => ({}),
            getEt: () => null,
            isRunning: () => f.flags.running,
            isPlanning: () => f.flags.planning,
            logger,
            userDir,
            loadScreen: async (name) => { f.loaded.push(name); },
            getJobPending: () => false,
          });
          f.call = (ch, ...args) => f.handlers.get(ch)(null, ...args);
          return f;
        };
        const errOf = (p) => p.then(() => null, (e) => e.message);

        const root = path.join(base, 'root');
        fs.mkdirSync(root, { recursive: true });
        const f = makeFake(path.join(base, 'ud1'), { backupRoot: root });

        // 화면 전환: 실행 중, 미리보기 중에는 거절. 아니면 허용
        f.flags.running = true;
        const m1 = await errOf(f.call('gallery:open-screen', 'import'));
        f.flags.running = false;
        f.flags.planning = true;
        const m2 = await errOf(f.call('gallery:open-screen', 'import'));
        out.push(sub('화면 전환: 실행 중에는 거절', m1 === '작업이 끝난 뒤에 화면을 바꿀 수 있어요' && f.loaded.length === 0, `메시지 ${m1}`));
        out.push(sub('화면 전환: 미리보기 중에는 거절', typeof m2 === 'string' && m2.includes('미리보기') && f.loaded.length === 0, `메시지 ${m2}`));
        f.flags.planning = false;
        const ok = await f.call('gallery:open-screen', 'gallery');
        const m3 = await errOf(f.call('gallery:open-screen', '엉뚱한 화면'));
        out.push(sub('화면 전환: 아무것도 안 하는 중이면 허용, 모르는 화면 이름은 거절', ok === true && f.loaded.join() === 'gallery' && m3 !== null));

        // 읽기 시작 시점
        f.g.onBatchDone();
        await sleep(150);
        out.push(sub('가져오기 묶음이 끝나면 scan(root, { changed: true })', scanCalls.some((c) => c.root === root && c.o && c.o.changed === true), JSON.stringify(scanCalls)));
        const root2 = path.join(base, 'root2');
        fs.mkdirSync(root2, { recursive: true });
        const settings2 = { backupRoot: root2 };
        const f2 = makeFake(path.join(base, 'ud2'), settings2);
        f2.g.onRootChanged();
        await sleep(150);
        out.push(sub('백업 폴더가 바뀌면 새 폴더를 scan', scanCalls.some((c) => c.root === root2)));

        // 상태와 pvm://
        const st = await f.call('gallery:get-state');
        out.push(sub('getState 모양 (root, connected, total, scan, tools, jobPending)', st.root === root && st.connected === true && st.total === 0 && st.scan && typeof st.scan.scanning === 'boolean' && st.tools && st.tools.exiftool === false && st.jobPending === false && st.dbError === undefined && st.recovered === undefined));
        const r404 = [];
        for (const url of ['pvm://thumb/99999', 'pvm://preview/99999', 'pvm://thumb/abc', 'pvm://thumb/..%2F..%2Fx', 'pvm://other/1', 'file:///C:/Windows/win.ini']) r404.push((await f.pvm({ url })).status);
        out.push(sub('pvm:// 모르는 id, 글자, 경로 모양, 다른 호스트는 404', r404.every((s) => s === 404), r404.join(',')));

        // 깨진 DB는 새로 만들고 한 번만 알림, 열 수 없는 DB(폴더가 가로막음)는 갤러리만 끄고 계속
        fs.mkdirSync(path.join(base, 'ud3'), { recursive: true });
        fs.writeFileSync(path.join(base, 'ud3', 'library.db'), '이건 DB가 아니에요'.repeat(500));
        const f3 = makeFake(path.join(base, 'ud3'), { backupRoot: root });
        const s3a = await f3.call('gallery:get-state');
        const s3b = await f3.call('gallery:get-state');
        out.push(sub('깨진 DB: 새로 만들고 recovered는 첫 getState에서만', s3a.recovered === true && s3b.recovered === undefined && !s3a.dbError));
        fs.mkdirSync(path.join(base, 'ud4', 'library.db'), { recursive: true }); // 파일 자리에 폴더 → DB를 열 수 없음
        const f4 = makeFake(path.join(base, 'ud4'), { backupRoot: root });
        const s4 = await f4.call('gallery:get-state');
        const days4 = await f4.call('gallery:list-days', {});
        const re4 = await f4.call('gallery:rescan');
        const nav4 = await f4.call('gallery:open-screen', 'import');
        out.push(sub('DB를 못 열어도 시작: dbError 알림, 목록은 비어 있고 화면 전환은 됨', typeof s4.dbError === 'string' && s4.dbError !== '' && Array.isArray(days4) && days4.length === 0 && re4.status === 'no-db' && nav4 === true, JSON.stringify({ dbError: s4.dbError, re4 })));
        out.push(sub('열 수 없는 DB 폴더를 이름 바꿔 치우지 않음', fs.statSync(path.join(base, 'ud4', 'library.db')).isDirectory()));

        // 백업 폴더 경로는 끝의 구분자가 달라도 같은 폴더 (대소문자는 그대로 둠)
        const f5 = makeFake(path.join(base, 'ud5'), { backupRoot: root + path.sep });
        const f6 = makeFake(path.join(base, 'ud6'), { backupRoot: '  ' + root.split(path.sep).join('/') + '/ ' });
        const s5 = await f5.call('gallery:get-state');
        const s6 = await f6.call('gallery:get-state');
        const f7 = makeFake(path.join(base, 'ud7'), { backupRoot: '' });
        const s7 = await f7.call('gallery:get-state');
        out.push(sub('백업 폴더 경로 다듬기: 끝의 역슬래시나 / 가 있어도 같은 값, 비어 있으면 빈 값', s5.root === path.resolve(root) && s6.root === path.resolve(root) && s5.root === st.root && s7.root === '', `${s5.root} | ${s6.root} | "${s7.root}"`));

        // 도구를 새로 찾아 바뀌면 changed 로 한 번 다시 읽음
        scanCalls.length = 0;
        f.g.onToolsChanged();
        await sleep(150);
        out.push(sub('도구를 새로 찾으면 scan(root, { changed: true })', scanCalls.some((c) => c.root === root && c.o && c.o.changed === true), JSON.stringify(scanCalls)));

        for (const x of [f, f2, f3, f4, f5, f6, f7]) x.g.close();
      }

      // 18e 샘플 결과 복사본을 백업 폴더로 정한 임시 userData로 띄워요 (진짜 설정과 사진은 읽지 않음).
      //     사진을 읽어 오는 동안 기다렸다가 날짜(10.28)와 검색창 문구가 보이는지, 화면 오류가 없는지 봐요. 버튼은 누르지 않아요
      {
        const copyRoot = path.join(env.tmp, 'launch-gallery-root');
        fs.cpSync(env.full.backupRoot, copyRoot, { recursive: true });
        const ud = path.join(env.tmp, 'launch-gallery-full');
        fs.mkdirSync(ud, { recursive: true });
        fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ backupRoot: copyRoot }), 'utf8');
        const r2 = await launchCheck(APP, {
          port: 9335,
          env: { PVM_USER_DATA: ud },
          until: '10.28',
          probe: "(document.querySelector('input[type=search]') || {}).placeholder || ''",
        });
        out.push(sub('샘플 복사본을 읽은 갤러리에 날짜 10.28이 보임', r2.text.includes('10.28'), `화면 글자: ${String(r2.text).slice(0, 160).replace(/\s+/g, ' ')}`));
        out.push(sub('검색창 문구 "파일 이름, 태그, 날짜 검색"', r2.probed === '파일 이름, 태그, 날짜 검색', `문구 "${r2.probed}"`));
        out.push(sub('갤러리 화면 오류 없음, 정상 종료', r2.errors.length === 0 && r2.exitCode === 0 && !r2.text.includes('불러오지 못했어요'), `${r2.errors.join(' / ')} 종료 코드 ${r2.exitCode}`));
      }

      // 18f main.js의 도구 다시 찾기 막기: 가짜 electron으로 진짜 main.js를 불러와요 (창과 대화상자는 가짜, 파일은 임시 폴더만).
      //     미리보기 중(planning), 실행·정리 중(running)에는 check-tools, pick-tool이 한국어 오류로 거절되고 대화상자도 안 열려야 해요
      {
        const Module = require('module');
        const mainPath = path.join(APP, 'main.js');
        const ud = path.join(env.tmp, 'main-fake-ud');
        const srcDir = path.join(env.tmp, 'main-fake-src');
        const destDir = path.join(env.tmp, 'main-fake-dest');
        for (const d of [ud, srcDir, destDir]) fs.mkdirSync(d, { recursive: true });
        fs.copyFileSync(path.join(APP, 'test', 'samples', 'auto', 'IMG_0101.jpg'), path.join(srcDir, 'IMG_0101.jpg'));
        fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ backupRoot: destDir }), 'utf8');

        const handlers = new Map();
        const appEvents = new Map();
        let dialogCalls = 0;
        const spellCalls = [];
        let readyRun = null;
        const win = {
          webContents: { once() {}, send() {} },
          on() {},
          loadFile: async () => {},
          isDestroyed: () => false,
        };
        const fakeElectron = {
          app: {
            setPath() {},
            getPath: () => ud,
            getVersion: () => '0.0.0-check', // 지도 서버에 보내는 앱 이름표용 (main.js 가 갤러리를 켤 때 읽어요)
            requestSingleInstanceLock: () => true,
            on: (ev, fn) => appEvents.set(ev, fn),
            quit() {},
            whenReady: () => ({ then: (cb) => { readyRun = Promise.resolve().then(cb); return readyRun; } }),
          },
          BrowserWindow: function FakeWindow() { return win; },
          ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
          dialog: { showOpenDialog: async () => { dialogCalls++; return { canceled: true, filePaths: [] }; }, showMessageBoxSync: () => 1, showMessageBox: async () => ({}) },
          shell: { trashItem: async () => {}, openPath: async () => '' },
          protocol: { registerSchemesAsPrivileged() {}, handle() {} },
          // 맞춤법 검사 끄기 호출을 기록해요 (main.js의 whenReady 첫머리)
          session: { defaultSession: { setSpellCheckerEnabled: (v) => spellCalls.push(['enabled', v]), setSpellCheckerLanguages: (v) => spellCalls.push(['languages', v]) } },
        };
        const origLoad = Module._load;
        const listenersBefore = process.listeners('uncaughtException');
        const envBefore = process.env.PVM_USER_DATA;
        Module._load = function (request, ...rest) {
          return request === 'electron' ? fakeElectron : origLoad.call(this, request, ...rest);
        };
        process.env.PVM_USER_DATA = ud;
        let loadError = '';
        try {
          delete require.cache[mainPath];
          require(mainPath);
          await readyRun; // 도구 찾기, 갤러리 연결까지
        } catch (e) {
          loadError = e && e.message ? e.message : String(e);
        } finally {
          Module._load = origLoad;
          if (envBefore === undefined) delete process.env.PVM_USER_DATA;
          else process.env.PVM_USER_DATA = envBefore;
          for (const l of process.listeners('uncaughtException')) if (!listenersBefore.includes(l)) process.removeListener('uncaughtException', l); // main.js가 점검용으로 붙인 종료 처리는 이 점검에 필요 없어요
        }
        out.push(sub('켜질 때 맞춤법 검사를 끄고 사전 언어 목록을 비움 (구글 서버 사전 내려받기 방지)', JSON.stringify(spellCalls) === JSON.stringify([['enabled', false], ['languages', []]]), JSON.stringify(spellCalls)));
        out.push(sub('가짜 electron으로 main.js를 불러와 핸들러가 등록됨', loadError === '' && handlers.has('check-tools') && handlers.has('pick-tool') && handlers.has('make-plan') && handlers.has('trash-info'), loadError || [...handlers.keys()].join(',').slice(0, 80)));

        if (loadError === '') {
          const call = (ch, ...args) => handlers.get(ch)({}, ...args);
          const errOf = (pr) => pr.then(() => null, (e) => (e && e.message ? e.message : String(e)));
          const korean = (m) => typeof m === 'string' && /[가-힣]/.test(m) && m.includes('끝난 뒤');

          // 아무 일도 안 할 때는 다시 찾기가 됨
          const t0 = await call('check-tools');
          out.push(sub('쉬는 중에는 check-tools가 도구 정보를 돌려줌', !!t0 && !!t0.exiftool && t0.exiftool.ok === true));

          // 미리보기 중 (make-plan은 planning = true 를 먼저 켜고 기다려요)
          const planning = call('make-plan', { source: srcDir, backupRoot: destDir, includeSub: true });
          const dialogBefore = dialogCalls;
          const [mPlan1, mPlan2] = await Promise.all([errOf(call('check-tools')), errOf(call('pick-tool', 'exiftool'))]); // 미리보기가 끝나기 전에 둘 다 보내요
          const planResult = await errOf(planning);
          out.push(sub('미리보기 중 check-tools는 한국어 오류로 거절', korean(mPlan1), `메시지 ${mPlan1}`));
          out.push(sub('미리보기 중 pick-tool은 거절되고 파일 선택창도 안 열림', korean(mPlan2) && dialogCalls === dialogBefore, `메시지 ${mPlan2}, 선택창 ${dialogCalls - dialogBefore}번`));
          out.push(sub('미리보기는 막힘 없이 끝남', planResult === null, `${planResult}`));

          // 실행·정리 중 (trash-info 는 running = true 를 먼저 켜요. 작업이 없어도 켜졌다 꺼져요)
          //   trash-info 가 끝나기 전에 두 부탁을 모두 보내야 해서, 기다리지 않고 한꺼번에 보내요
          const dialogBefore2 = dialogCalls;
          const cleaning = call('trash-info');
          const pending = [errOf(call('check-tools')), errOf(call('pick-tool', 'ffmpeg'))];
          const [mRun1, mRun2] = await Promise.all(pending);
          await errOf(cleaning);
          out.push(sub('실행 중 check-tools는 한국어 오류로 거절', korean(mRun1), `메시지 ${mRun1}`));
          out.push(sub('실행 중 pick-tool은 거절되고 파일 선택창도 안 열림', korean(mRun2) && dialogCalls === dialogBefore2, `메시지 ${mRun2}`));

          // 끝난 뒤에는 다시 됨
          const t1 = await errOf(call('check-tools'));
          out.push(sub('작업이 끝나면 다시 찾기가 다시 됨', t1 === null, `${t1}`));
          const t2 = await errOf(call('pick-tool', 'exiftool'));
          out.push(sub('작업이 끝나면 pick-tool도 다시 됨 (선택창을 취소하면 그대로)', t2 === null && dialogCalls === dialogBefore2 + 1, `${t2}`));
        }
        // 종료 처리 (갤러리 DB, exiftool 끄기)
        try {
          if (appEvents.has('will-quit')) appEvents.get('will-quit')();
        } catch (e) { /* 끄는 중 오류는 무시 */ }
        delete require.cache[mainPath];
      }

      return out;
    },
  },
  {
    no: 19,
    name: '갤러리 격자 계산',
    async run() {
      const out = [];
      // src/grid-layout.mjs 는 React가 없는 순수 계산이에요. 한글 경로에서도 불러지게 file:// 주소로 불러와요
      const { pathToFileURL } = require('url');
      let g;
      try {
        g = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'grid-layout.mjs')).href);
      } catch (e) {
        return [sub('src/grid-layout.mjs 불러오기', false, e.message)];
      }
      const { buildRows, formatDayLabel } = g;

      // 14장, 5칸 → 3줄. 첫 줄만 isFirstOfDay
      const a = buildRows([{ day: '2026-10-28', count: 14 }], 5);
      out.push(sub('14장 5칸은 3줄 (5, 5, 4장)', a.length === 3 && a.map((r) => r.count).join() === '5,5,4' && a.map((r) => r.startIndex).join() === '0,5,10', JSON.stringify(a.map((r) => [r.dayRowIndex, r.startIndex, r.count]))));
      out.push(sub('첫 줄만 isFirstOfDay', a.map((r) => r.isFirstOfDay).join() === 'true,false,false' && a.map((r) => r.dayRowIndex).join() === '0,1,2'));
      out.push(sub('줄마다 그 날 전체 장수(dayCount)가 있음', a.every((r) => r.dayCount === 14 && r.day === '2026-10-28')));

      // 정확히 나누어질 때
      out.push(sub('10장 5칸은 정확히 2줄', buildRows([{ day: '2026-10-28', count: 10 }], 5).length === 2));
      out.push(sub('1장은 1줄, 0장은 줄 없음', buildRows([{ day: '2026-10-28', count: 1 }], 5).length === 1 && buildRows([{ day: '2026-10-28', count: 0 }], 5).length === 0));

      // 연도 표시: 목록 첫 묶음과 해가 바뀌는 첫 묶음만
      const b = buildRows([{ day: '2026-01-02', count: 2 }, { day: '2025-12-31', count: 2 }, { day: '2025-12-30', count: 2 }], 5);
      out.push(sub('목록 첫 묶음과 해가 바뀌는 묶음에 showYear, 같은 해 다음 날은 아님', b.map((r) => r.showYear).join() === 'true,true,false', b.map((r) => r.showYear).join()));
      // 연도는 묶음의 첫 줄에서만 참이에요 (둘째 줄부터는 거짓)
      const b2 = buildRows([{ day: '2026-01-02', count: 12 }], 5);
      out.push(sub('showYear는 묶음 첫 줄에서만 참', b2.map((r) => r.showYear).join() === 'true,false,false'));

      // 날짜 없는 묶음은 끝에 그대로
      const c = buildRows([{ day: '2026-10-28', count: 3 }, { day: null, count: 7 }], 5);
      out.push(sub('null 묶음이 끝에 그대로 있음', c.length === 3 && c[c.length - 1].day === null && c[c.length - 1].count === 2 && c[c.length - 2].day === null && c[c.length - 2].isFirstOfDay === true, JSON.stringify(c.map((r) => [r.day, r.count]))));

      // 이름표
      out.push(sub('formatDayLabel: 10.28, 수요일, 2026 (시간대 없이 계산)', JSON.stringify(formatDayLabel('2026-10-28')) === JSON.stringify({ date: '10.28', weekday: '수요일', year: '2026' }), JSON.stringify(formatDayLabel('2026-10-28'))));
      out.push(sub('formatDayLabel: 요일이 맞음 (2026-11-01은 일요일, 2026-11-07은 토요일)', formatDayLabel('2026-11-01').weekday === '일요일' && formatDayLabel('2026-11-07').weekday === '토요일'));
      out.push(sub('formatDayLabel(null)은 날짜 없음', formatDayLabel(null).date === '날짜 없음' && formatDayLabel(null).weekday === undefined));
      out.push(sub('formatDayLabel: 한 자리 월·일은 0을 붙임', formatDayLabel('2026-01-02').date === '01.02'));

      // 이상한 입력도 오류 없이 빈 배열
      let threw = '';
      let empties = [];
      try {
        empties = [buildRows([], 5), buildRows([{ day: '2026-10-28', count: 3 }], 0), buildRows([{ day: '2026-10-28', count: 3 }], -2), buildRows(null, 5), buildRows([{ day: '2026-10-28', count: 3 }], NaN)];
      } catch (e) {
        threw = e.message;
      }
      out.push(sub('칸 수 0 이하, 빈 목록, null은 오류 없이 빈 배열', threw === '' && empties.length === 5 && empties.every((x) => Array.isArray(x) && x.length === 0), threw));

      // 줄 높이: 그 날의 마지막 줄에만 날 사이 여백이 더해져요
      out.push(sub('rowHeight: 마지막 줄에만 날 사이 여백', g.rowHeight(a[0], 100, 4, 28) === 104 && g.rowHeight(a[2], 100, 4, 28) === 132, `${g.rowHeight(a[0], 100, 4, 28)}, ${g.rowHeight(a[2], 100, 4, 28)}`));

      // 화면에 쓰는 글자 만들기 (src/format.mjs)
      let f;
      try {
        f = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'format.mjs')).href);
      } catch (e) {
        return out.concat(sub('src/format.mjs 불러오기', false, e.message));
      }
      out.push(sub('영상 길이: 12.3초 0:12, 3725초 1:02:05, 모르면 빈 글자', f.formatDuration(12.3) === '0:12' && f.formatDuration(3725) === '1:02:05' && f.formatDuration(null) === '' && f.formatDuration(-1) === ''));
      out.push(sub('용량: 512 B, 3 KB, 16.3 MB, 1.5 GB', f.formatBytes(512) === '512 B' && f.formatBytes(3072) === '3 KB' && f.formatBytes(16.3 * 1024 * 1024) === '16.3 MB' && f.formatBytes(1.5 * 1024 ** 3) === '1.5 GB'));
      out.push(sub('찍은 시각: 오후 1:41:13, 오전 12시 0분, 오후 12시, 날짜만', f.formatTakenAt('2026-10-28T13:41:13') === '2026년 10월 28일 오후 1:41:13' && f.formatTakenAt('2026-10-28T00:05:00') === '2026년 10월 28일 오전 12:05:00' && f.formatTakenAt('2026-10-28T12:00:00') === '2026년 10월 28일 오후 12:00:00' && f.formatTakenAt('2026-10-28') === '2026년 10월 28일' && f.formatTakenAt(null) === ''));
      out.push(sub('좌표: 소수점 다섯 자리, 하나라도 없으면 빈 글자', f.formatCoords(37.2636, 127.0286) === '37.26360, 127.02860' && f.formatCoords(null, 127) === ''));
      return out;
    },
  },
];

// 다른 점검 파일(check-missing-info.js)도 같은 도우미를 쓸 수 있게 내보내요
module.exports = { items, fillFakeLibrary, row, sub, withDb, newDbPath, ALL };

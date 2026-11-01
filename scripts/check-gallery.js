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
];

module.exports = { items, fillFakeLibrary };

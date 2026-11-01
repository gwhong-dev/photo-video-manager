// 파일 위치: scripts/check-location-suggest.js
// 역할: "위치 제안" 점검 항목 (28번부터). scripts/check.js 의 ITEMS 끝에 붙어서 같이 돌아요.
//   빠르게 이 파일만 돌려 볼 때: node scripts/check-location-suggest.js
//   (os.tmpdir()의 pvm-check- 임시 폴더에서 돌리고, 모두 통과하면 그 폴더를 지워요)
//
// ⚠️ 실제 사진과 실제 userData(library.db)는 쓰지 않아요.
//    모든 DB 파일은 점검 임시 폴더(env.tmp) 안에만 만들어요.
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { row, sub, withDb, fillFakeLibrary } = require('./check-gallery');

// 계산에 넘길 파일 한 줄 (필요한 값만 덮어써서 써요)
let nextId = 1;
const file = (over = {}) => {
  const id = over.id || nextId++;
  return {
    id,
    path: `R1/${id}.jpg`,
    name: `${id}.jpg`,
    mediaType: 'photo',
    takenAt: '2026-10-25T14:00:00',
    takenDay: '2026-10-25',
    lat: null,
    lng: null,
    locationSource: null,
    ...over,
  };
};
// 위치 있는 근거 사진 한 줄
const located = (over = {}) => file({ lat: 37.5, lng: 127, locationSource: 'exif', ...over });
const NONE = new Set();

// ---------- 점검 항목 ----------
const items = [
  {
    no: 28,
    name: '위치 제안 계산',
    async run(env) {
      const out = [];
      const { buildSuggestions } = require('../lib/location-suggest');
      const targetIds = (r) => r.groups.flatMap((g) => g.targets.map((t) => t.id));

      // 28a 60분 정각은 제안하고 60분 1초는 제안하지 않아요
      {
        const onTime = file({ takenAt: '2026-10-25T15:00:00' });
        const late = file({ takenAt: '2026-10-25T15:00:01' });
        const r = buildSuggestions([located({ takenAt: '2026-10-25T14:00:00' }), onTime, late], NONE);
        const ids = targetIds(r);
        out.push(sub('28a 60분 정각은 제안, 60분 1초는 제안 안 함', ids.length === 1 && ids[0] === onTime.id, JSON.stringify(ids)));
      }

      // 28b 자정 근처의 다른 날 사진은 근거가 되지 않아요
      {
        const r = buildSuggestions([
          located({ takenAt: '2026-10-26T00:10:00', takenDay: '2026-10-26' }),
          file({ takenAt: '2026-10-25T23:50:00', takenDay: '2026-10-25' }),
        ], NONE);
        out.push(sub('28b 20분 차이여도 다른 날이면 제안 안 함', r.groups.length === 0));
      }

      // 28c 직접 넣은 위치는 근거가 되지 않아요 (오차가 쌓이지 않게)
      {
        const r = buildSuggestions([located({ locationSource: 'manual' }), file()], NONE);
        out.push(sub('28c 위치 출처 manual은 근거가 안 됨', r.groups.length === 0));
      }

      // 28d 건너뛴 사진
      {
        const t = file();
        const r = buildSuggestions([located(), t], new Set([t.path]));
        out.push(sub('28d 건너뛴 대상은 제안 안 함, 건너뛴 장수 1', r.groups.length === 0 && r.skippedCount === 1 && r.photoCount === 0, JSON.stringify({ skipped: r.skippedCount })));
      }

      // 28e 시간 차이가 같을 때: 이른 사진, 그래도 같으면 id가 작은 사진
      {
        const later = located({ id: 901, takenAt: '2026-10-25T14:10:00' });
        const earlier = located({ id: 902, takenAt: '2026-10-25T13:50:00' });
        const r1 = buildSuggestions([later, earlier, file({ takenAt: '2026-10-25T14:00:00' })], NONE);
        const same2 = located({ id: 904 });
        const same1 = located({ id: 903 });
        const r2 = buildSuggestions([same2, same1, file({ takenAt: '2026-10-25T14:00:00' })], NONE);
        out.push(sub(
          '28e 같은 시간 차이면 이른 사진, 같은 시각이면 id 작은 사진',
          r1.groups[0].source.id === 902 && r2.groups[0].source.id === 903,
          `${r1.groups[0].source.id}, ${r2.groups[0].source.id}`,
        ));
      }

      // 28f 시각이 없거나 날짜뿐인 사진은 오류 없이 빠져요
      {
        const r = buildSuggestions([
          located({ takenAt: null, takenDay: null }),
          located({ takenAt: '2026-10-25' }),
          file({ takenAt: null, takenDay: null }),
          file({ takenAt: '2026-10-25' }),
        ], NONE);
        const withGood = buildSuggestions([located({ takenAt: '2026-10-25' }), file()], NONE);
        out.push(sub('28f 시각 없는 사진은 근거와 대상에서 빠짐', r.groups.length === 0 && r.photoCount === 0 && withGood.groups.length === 0));
      }

      // 28g 위도 0, 경도 0도 값이에요
      {
        const r = buildSuggestions([located({ lat: 0, lng: 0 }), file()], NONE);
        out.push(sub('28g 위도 0 경도 0인 사진도 근거가 됨', r.groups.length === 1));
      }

      // 28h 1km 안은 한 묶음, 밖은 다른 묶음 (위도 0.0045도 = 약 0.5km, 0.027도 = 약 3km)
      {
        const a = located({ id: 911, takenAt: '2026-10-25T10:00:00', lat: 37.5 });
        const near = located({ id: 912, takenAt: '2026-10-25T12:00:00', lat: 37.5045 });
        const far = located({ id: 913, takenAt: '2026-10-25T14:00:00', lat: 37.527 });
        const r = buildSuggestions([
          a, near, far,
          file({ takenAt: '2026-10-25T10:01:00' }),
          file({ takenAt: '2026-10-25T12:01:00' }),
          file({ takenAt: '2026-10-25T14:01:00' }),
        ], NONE);
        const big = r.groups.find((g) => g.targets.length === 2);
        const small = r.groups.find((g) => g.targets.length === 1);
        out.push(sub(
          '28h 0.5km는 한 묶음, 3km는 다른 묶음, 기준은 첫 근거 사진',
          r.groups.length === 2 && big && big.source.id === 911 && small && small.source.id === 913,
          JSON.stringify(r.groups.map((g) => [g.source.id, g.targets.length])),
        ));
      }

      // 28i 묶음 순서: 장수 많은 순, 같으면 최근 날짜, 그다음 기준 id
      {
        const day = (d, id, n) => {
          const list = [located({ id, takenAt: `${d}T10:00:00`, takenDay: d })];
          for (let i = 0; i < n; i++) list.push(file({ takenAt: `${d}T10:0${i + 1}:00`, takenDay: d }));
          return list;
        };
        const r = buildSuggestions([
          ...day('2026-01-01', 921, 1),
          ...day('2026-01-02', 922, 3),
          ...day('2026-01-03', 923, 1),
          // 같은 날 3km 떨어진 곳에 있는 두 묶음은 기준 id 순서예요
          located({ id: 925, takenAt: '2026-01-04T10:00:00', takenDay: '2026-01-04', lat: 37.527 }),
          file({ takenAt: '2026-01-04T10:01:00', takenDay: '2026-01-04' }),
          located({ id: 924, takenAt: '2026-01-04T15:00:00', takenDay: '2026-01-04' }),
          file({ takenAt: '2026-01-04T15:01:00', takenDay: '2026-01-04' }),
        ], NONE);
        const order = r.groups.map((g) => g.source.id).join(',');
        out.push(sub('28i 장수 많은 순, 최근 날짜 순, 기준 id 순', order === '922,924,925,923,921', order));
      }

      // 28j 시간 차이 값과 합계
      {
        const r = buildSuggestions([
          located({ takenAt: '2026-10-25T14:00:00' }),
          file({ takenAt: '2026-10-25T14:12:00' }),
          file({ takenAt: '2026-10-25T14:30:00' }),
        ], NONE);
        const gaps = r.groups[0].targets.map((t) => t.gapMinutes).join(',');
        out.push(sub('28j 시간 차이 분 단위, 합계 장수', gaps === '12,30' && r.photoCount === 2 && r.skippedCount === 0, gaps));
      }

      // 28k DB 조회: 다른 폴더, 사라진 파일, 스크린샷은 나오지 않아요
      await withDb(env, 'suggest-rows', (db) => {
        db.upsertFiles([
          row({ path: 'R1/keep.jpg', name: 'keep.jpg', lat: 37.5, lng: 127, locationSource: 'exif' }),
          row({ path: 'R2/other.jpg', name: 'other.jpg', root: 'R2' }),
          row({ path: 'R1/gone.jpg', name: 'gone.jpg' }),
          row({ path: 'R1/shot.png', name: 'shot.png', tags: [{ name: '스크린샷', source: 'mediaType' }] }),
        ]);
        db.setMissing(['R1/gone.jpg'], true);
        const rows = db.listSuggestionRows('R1');
        const k = rows[0] || {};
        out.push(sub(
          '28k 다른 폴더, 사라진 파일, 스크린샷은 조회에 없음',
          rows.length === 1 && k.path === 'R1/keep.jpg' && k.takenDay === '2026-10-25' && k.lat === 37.5 && k.locationSource === 'exif' && k.mediaType === 'photo',
          rows.map((x) => x.name).join(','),
        ));
      });

      // 28m 시각을 모르는 사진은 쓰지 않아요: 파일 이름에 날짜만 있어 00:00:00이 된 사진, 직접 넣은 시각
      {
        const fakeMidnight = { takenAt: '2026-10-25T00:00:00', takenAtSource: 'filename' };
        const r1 = buildSuggestions([located({ takenAt: '2026-10-25T00:10:00' }), file(fakeMidnight)], NONE);
        const r2 = buildSuggestions([located(fakeMidnight), file({ takenAt: '2026-10-25T00:10:00' })], NONE);
        const r3 = buildSuggestions([located({ takenAt: '2026-10-25T12:10:00' }), file({ takenAt: '2026-10-25T12:00:00', takenAtSource: 'manual' })], NONE);
        const r4 = buildSuggestions([located({ takenAt: '2026-10-25T12:00:00', takenAtSource: 'manual' }), file({ takenAt: '2026-10-25T12:10:00' })], NONE);
        const realName = buildSuggestions([located({ takenAt: '2026-10-25T21:00:00' }), file({ takenAt: '2026-10-25T21:09:41', takenAtSource: 'filename' })], NONE);
        const realMidnight = buildSuggestions([located({ takenAt: '2026-10-25T00:10:00' }), file({ takenAt: '2026-10-25T00:00:00', takenAtSource: 'exif' })], NONE);
        out.push(sub(
          '28m 이름의 날짜뿐인 00:00:00과 직접 넣은 시각은 빠지고, 이름의 실제 시각과 파일의 00:00:00은 쓰임',
          r1.groups.length === 0 && r2.groups.length === 0 && r3.groups.length === 0 && r4.groups.length === 0 && realName.groups.length === 1 && realMidnight.groups.length === 1,
          JSON.stringify([r1, r2, r3, r4, realName, realMidnight].map((r) => r.groups.length)),
        ));
      }
      await withDb(env, 'suggest-source', (db) => {
        db.upsertFiles([row({ path: 'R1/s.jpg', name: 's.jpg', takenAtSource: 'filename' })]);
        const k = db.listSuggestionRows('R1')[0] || {};
        out.push(sub('28n 조회에 시각 출처가 있음', k.takenAtSource === 'filename', String(k.takenAtSource)));
      });

      // 28l 가짜 6만 건에서 계산 시간 (목표 0.5초, 2초를 넘으면 실패)
      await withDb(env, 'suggest-speed', (db) => {
        fillFakeLibrary(db, 'R1', 60000);
        const started = Date.now();
        const rows = db.listSuggestionRows('R1');
        buildSuggestions(rows, NONE);
        const ms = Date.now() - started;
        out.push(sub(`28l 가짜 6만 건 계산 ${ms}ms (목표 500ms)`, ms <= 2000 && rows.length > 50000, `${rows.length}줄`));
      });

      return out;
    },
  },
  {
    no: 29,
    name: '건너뛴 사진 목록',
    async run(env) {
      const out = [];
      const { createSkips } = require('../lib/suggest-skips');
      const dir = path.join(env.tmp, 'suggest-skips');
      fs.mkdirSync(dir, { recursive: true });
      const silent = () => {};

      // 29a 다시 열어도 남아요 (한글, 공백, 특수문자 경로)
      {
        const f = path.join(dir, 'a.json');
        const odd = 'D:\\사진 폴더\\a#1%20\'b".jpg';
        const saved = createSkips(f, { onError: silent }).add([odd]);
        const again = createSkips(f, { onError: silent }).paths();
        out.push(sub('29a 특수문자 경로가 다시 열어도 그대로', saved === true && again.has(odd) && again.size === 1));
      }

      // 29b 겹쳐 더해도 하나, 비우면 다시 열어도 비어 있어요
      {
        const f = path.join(dir, 'b.json');
        const s = createSkips(f, { onError: silent });
        s.add(['x', 'y']);
        s.add(['y']);
        const size = createSkips(f, { onError: silent }).paths().size;
        const cleared = s.clear();
        const after = createSkips(f, { onError: silent }).paths().size;
        out.push(sub('29b 겹쳐도 하나로 셈, 비우면 비어 있음', size === 2 && cleared === true && after === 0 && s.paths().size === 0, `${size}, ${after}`));
      }

      // 29c 깨진 파일: 이름을 바꿔 보관하고 빈 목록으로 시작해요
      {
        const sub1 = path.join(dir, 'broken');
        fs.mkdirSync(sub1);
        const f = path.join(sub1, 'suggest-skips.json');
        fs.writeFileSync(f, '{ 깨진 내용');
        let errors = 0;
        const s = createSkips(f, { onError: () => { errors++; } });
        const size = s.paths().size;
        const kept = fs.readdirSync(sub1).filter((n) => n.startsWith('suggest-skips.json.broken-'));
        out.push(sub('29c 깨진 파일은 보관하고 빈 목록, 오류 알림', size === 0 && kept.length === 1 && errors === 1, kept.join(',')));
      }

      // 29d 쓰기 실패: 던지지 않고 false, 메모리에는 남아요
      {
        const blocker = path.join(dir, 'blocker');
        fs.writeFileSync(blocker, '폴더 자리에 파일');
        let errors = 0;
        const s = createSkips(path.join(blocker, 'skips.json'), { onError: () => { errors++; } });
        const saved = s.add(['x']);
        out.push(sub('29d 쓰기 실패면 false, 메모리에는 있음', saved === false && s.paths().has('x') && errors === 1));
      }

      // 29e 파일 모양과 임시 파일
      {
        const sub2 = path.join(dir, 'shape');
        fs.mkdirSync(sub2);
        const f = path.join(sub2, 'suggest-skips.json');
        createSkips(f, { onError: silent }).add(['x']);
        const data = JSON.parse(fs.readFileSync(f, 'utf8'));
        const names = fs.readdirSync(sub2);
        out.push(sub('29e 파일 모양 { paths }, 임시 파일이 안 남음', Array.isArray(data.paths) && data.paths[0] === 'x' && names.length === 1, names.join(',')));
      }

      return out;
    },
  },
  {
    no: 30,
    name: '위치 제안 연결',
    async run(env) {
      const out = [];
      const crypto = require('crypto');
      const dbMod = require('../lib/db');
      const { createJournal, recover } = require('../lib/manual-journal');
      const { createLogger } = require('../lib/logger');
      const { openDb } = dbMod;

      // gallery-main을 불러오는 동안만 openDb를 감싸서, 점검이 같은 DB를 들여다볼 수 있게 해요 (24번과 같은 방식)
      const opened = [];
      const gmPath = require.resolve('../gallery-main');
      delete require.cache[gmPath];
      dbMod.openDb = (f, o) => {
        const r = openDb(f, o);
        opened.push(r.db);
        return r;
      };
      let gm;
      try {
        gm = require('../gallery-main');
      } finally {
        dbMod.openDb = openDb;
        delete require.cache[gmPath];
      }

      const base = path.join(env.tmp, 'suggest-wire');
      fs.mkdirSync(base, { recursive: true });
      let seq = 0;
      const fakes = [];
      const errOf = (p) => p.then(() => null, (e) => e.message);
      const DAY = '2026-10-25';
      const at = (hhmm) => `${DAY}T${hhmm}:00`;
      const SUGGEST = (sourceId) => ({ source: 'copy', sourceId, date: false, time: false, location: true, via: 'suggest' });
      const fingerprint = (dir) => {
        const m = {};
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!e.isFile()) continue;
          const p = path.join(dir, e.name);
          const s = fs.statSync(p);
          m[e.name] = `${crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')}@${s.size}@${s.mtimeMs}`;
        }
        return JSON.stringify(m);
      };

      // 사진 폴더와 userData를 만들고 DB에 줄을 넣어 둬요. spec: { 이름: 덮어쓸 값 }
      const prep = (label, spec) => {
        const dir = path.join(base, `${label}-${++seq}`);
        const P = { root: path.resolve(dir, 'photos-root-xyz'), ud: path.join(dir, 'ud'), logDir: path.join(dir, 'logs') };
        fs.mkdirSync(P.ud, { recursive: true });
        fs.mkdirSync(P.root, { recursive: true });
        const o = openDb(path.join(P.ud, 'library.db'));
        o.db.upsertFiles(Object.entries(spec).map(([name, over]) => {
          fs.writeFileSync(path.join(P.root, name), `사진 ${name}`);
          return row({ root: P.root, path: path.join(P.root, name), name, takenAt: at('14:00'), takenDay: DAY, ...over });
        }));
        o.db.close();
        return P;
      };
      // setupGallery를 가짜 ipcMain으로 띄워요
      const makeFake = (P) => {
        const f = { handlers: new Map(), flags: { running: false }, P };
        const win = { isDestroyed: () => false, webContents: { send() {} } };
        f.g = gm.setupGallery({
          ipcMain: { handle: (ch, fn) => f.handlers.set(ch, fn) },
          protocol: { handle() {} },
          getWin: () => win,
          getSettings: () => ({ backupRoot: P.root }),
          getTools: () => ({}),
          getEt: () => null,
          isRunning: () => f.flags.running,
          isPlanning: () => false,
          logger: createLogger(P.logDir),
          userDir: P.ud,
          loadScreen: async () => {},
          getJobPending: () => false,
        });
        f.db = opened[opened.length - 1];
        f.call = async (ch, ...a) => f.handlers.get(ch)(null, ...a);
        f.close = () => {
          if (f.closed) return;
          f.closed = true;
          f.g.close();
        };
        fakes.push(f);
        return f;
      };
      const idOf = (f, name) => f.db.listSuggestionRows(f.P.root).find((x) => x.name === name).id;
      const list = (f) => f.call('gallery:list-suggestions');
      const lastId = async (f) => (await f.call('gallery:get-state')).lastBatch.id;
      const jlines = (P) => createJournal(path.join(P.ud, 'manual-edits.jsonl')).read().lines;
      const scene = async (label, fn) => {
        try {
          await fn();
        } catch (e) {
          out.push(sub(`${label} 실행 중 오류`, false, String(e.stack).split('\n').slice(0, 3).join(' | ')));
        }
      };
      const SRC = { lat: 37.5, lng: 127, locationSource: 'gps', takenAt: at('14:00') };
      const BASIC = { 'src.jpg': SRC, 'a.jpg': { takenAt: at('14:10') }, 'b.jpg': { takenAt: at('14:20') } };

      try {
        await scene('30a', async () => {
          const f = makeFake(prep('flow', BASIC));
          const fp0 = fingerprint(f.P.root);
          const before = await list(f);
          const text = JSON.stringify(before);
          out.push(sub(
            '30a 목록은 1묶음 2장이고 응답에 파일 경로가 없음',
            before.groups.length === 1 && before.photoCount === 2 && before.skippedCount === 0 && before.groups[0].source.id === idOf(f, 'src.jpg')
              && !text.includes('photos-root-xyz') && !text.includes('"path"'),
            text.slice(0, 200),
          ));

          // 30b 넣은 값은 다음 제안의 근거가 되지 않아요: a만 넣어도 b의 기준은 그대로 src
          const a = idOf(f, 'a.jpg');
          const r = await f.call('gallery:apply-edit', [a], SUGGEST(idOf(f, 'src.jpg')));
          const mid = await list(f);
          const fa = await f.call('gallery:get-file', a);
          out.push(sub(
            '30b 넣기 뒤 대상이 빠지고, 넣은 값은 근거가 되지 않음',
            r.count === 1 && r.dropped === 0 && mid.photoCount === 1 && mid.groups[0].source.id === idOf(f, 'src.jpg')
              && fa.lat === 37.5 && fa.locationSource === 'manual',
            JSON.stringify([r, mid.photoCount]),
          ));

          // 30g 같은 묶음을 두 번 넣어도 두 번째는 0장이고 기록을 남기지 않아요
          const linesBefore = jlines(f.P).length;
          const twice = await f.call('gallery:apply-edit', [a], SUGGEST(idOf(f, 'src.jpg')));
          out.push(sub('30g 두 번째 넣기는 0장, 기록 파일이 늘지 않음', twice.count === 0 && twice.batchId === null && twice.dropped === 1 && jlines(f.P).length === linesBefore, JSON.stringify(twice)));

          // 30h 기록 파일의 방법과 근거 사진 (제안)
          const line = jlines(f.P)[0];
          out.push(sub('30h 제안의 기록 줄에 via와 sourcePath', line.via === 'suggest' && line.sourcePath === path.join(f.P.root, 'src.jpg'), JSON.stringify([line.via, line.sourcePath])));

          // 30j 로그 머리글
          const logs = fs.readdirSync(f.P.logDir).filter((n) => n.startsWith('manual-edit_'));
          const log = logs.map((n) => fs.readFileSync(path.join(f.P.logDir, n), 'utf8')).join('\n');
          out.push(sub('30j 로그에 방법과 근거 사진 경로', log.includes('방법 suggest') && log.includes(`근거 ${path.join(f.P.root, 'src.jpg')}`), log.slice(0, 160)));

          // 30c 되돌리면 다시 제안에 나와요
          await f.call('gallery:undo-last', await lastId(f));
          const back = await list(f);
          out.push(sub('30c 되돌리면 다시 제안에 나옴', back.photoCount === 2, String(back.photoCount)));

          // 30k 사진 파일은 그대로
          out.push(sub('30k 사진 파일의 지문, 크기, 수정 시각이 그대로', fingerprint(f.P.root) === fp0));
        });

        await scene('30c2', async () => {
          const f = makeFake(prep('undo-skip', BASIC));
          const a = idOf(f, 'a.jpg');
          const b = idOf(f, 'b.jpg');
          await f.call('gallery:apply-edit', [a], SUGGEST(idOf(f, 'src.jpg')));
          await f.call('gallery:skip-suggestions', [b]);
          await f.call('gallery:undo-last', await lastId(f));
          const r = await list(f);
          out.push(sub('30c 되돌려도 건너뛴 사진은 건너뛴 채로', r.photoCount === 1 && r.skippedCount === 1 && r.groups[0].targets[0].id === a, JSON.stringify([r.photoCount, r.skippedCount])));
        });

        await scene('30d', async () => {
          const P = prep('skip', BASIC);
          const other = prep('skip-other', { 'x.jpg': { takenAt: at('14:10') } });
          const f = makeFake(P);
          const a = idOf(f, 'a.jpg');
          const b = idOf(f, 'b.jpg');
          const saved = await f.call('gallery:skip-suggestions', [a]);
          f.close();
          const f2 = makeFake(P);
          const r1 = await list(f2);
          // 다른 폴더의 줄은 경로를 더하지 않아요 (이 DB에 다른 root 줄을 넣어서 시험)
          f2.db.upsertFiles([row({ root: other.root, path: path.join(other.root, 'x.jpg'), name: 'x.jpg', takenAt: at('14:10'), takenDay: DAY })]);
          const otherId = f2.db.listSuggestionRows(other.root)[0].id;
          await f2.call('gallery:skip-suggestions', [otherId]);
          const file = JSON.parse(fs.readFileSync(path.join(P.ud, 'suggest-skips.json'), 'utf8'));
          const cleared = await f2.call('gallery:clear-suggestion-skips');
          const r2 = await list(f2);
          out.push(sub(
            '30d 건너뛰기가 다시 켜도 남고, 다시 보기로 비워지고, 다른 폴더 사진은 안 더해짐',
            saved.saved === true && r1.photoCount === 1 && r1.skippedCount === 1 && r1.groups[0].targets[0].id === b
              && file.paths.length === 1 && file.paths[0] === path.join(P.root, 'a.jpg')
              && cleared.saved === true && r2.photoCount === 2 && r2.skippedCount === 0,
            JSON.stringify([saved, r1.photoCount, file.paths.length, r2.photoCount]),
          ));
        });

        await scene('30e', async () => {
          const f = makeFake(prep('reject', {
            ...BASIC,
            'other-day.jpg': { takenAt: '2026-10-26T14:10:00', takenDay: '2026-10-26' },
            'gone.jpg': { lat: 37.5, lng: 127, locationSource: 'gps' },
          }));
          const src = idOf(f, 'src.jpg');
          const a = idOf(f, 'a.jpg');
          const otherDay = await errOf(f.call('gallery:apply-edit', [idOf(f, 'other-day.jpg')], SUGGEST(src)));
          const unknown = await errOf(f.call('gallery:apply-edit', [a], { ...SUGGEST(src), via: 'robot' }));
          const withDate = await errOf(f.call('gallery:apply-edit', [a], { ...SUGGEST(src), date: true }));
          const goneId = idOf(f, 'gone.jpg');
          f.db.setMissing([path.join(f.P.root, 'gone.jpg')], true);
          const gone = await errOf(f.call('gallery:apply-edit', [a], SUGGEST(goneId)));
          // 기준이 직접 넣은 값이 되면 거절해요
          await f.call('gallery:apply-edit', [a], { source: 'copy', sourceId: src, date: false, time: false, location: true });
          const manual = await errOf(f.call('gallery:apply-edit', [idOf(f, 'b.jpg')], SUGGEST(a)));
          out.push(sub(
            '30e 다른 날, 모르는 via, 날짜를 함께 넣기, 사라진 기준, manual 기준은 거절',
            !!otherDay && !!unknown && !!withDate && !!gone && !!manual && !String(gone).includes('photos-root-xyz'),
            JSON.stringify([otherDay, unknown, withDate, gone, manual]),
          ));
        });

        await scene('30f', async () => {
          const f = makeFake(prep('dropped', BASIC));
          const a = idOf(f, 'a.jpg');
          const b = idOf(f, 'b.jpg');
          // 넣기 전에 다시 읽기로 a에 위치가 생겼어요
          f.db.upsertFiles([row({ root: f.P.root, path: path.join(f.P.root, 'a.jpg'), name: 'a.jpg', takenAt: at('14:10'), takenDay: DAY, lat: 10, lng: 20, locationSource: 'gps' })]);
          const r = await f.call('gallery:apply-edit', [a, b], SUGGEST(idOf(f, 'src.jpg')));
          const fa = await f.call('gallery:get-file', a);
          const fb = await f.call('gallery:get-file', b);
          out.push(sub('30f 그 사이 위치가 생긴 사진은 그대로, dropped 1', r.count === 1 && r.dropped === 1 && fa.lat === 10 && fa.locationSource === 'gps' && fb.lat === 37.5, JSON.stringify(r)));
        });

        await scene('30h2', async () => {
          const f = makeFake(prep('via', BASIC));
          const src = idOf(f, 'src.jpg');
          await f.call('gallery:apply-edit', [idOf(f, 'a.jpg')], { source: 'copy', sourceId: src, date: false, time: false, location: true });
          await f.call('gallery:apply-edit', [idOf(f, 'b.jpg')], { source: 'direct', date: '2026-01-02', time: '10:00:00' });
          const [copy, direct] = jlines(f.P);
          out.push(sub(
            '30h 붙여넣기는 via copy와 sourcePath, 직접 넣기는 via direct와 sourcePath null',
            copy.via === 'copy' && copy.sourcePath === path.join(f.P.root, 'src.jpg') && direct.via === 'direct' && direct.sourcePath === null,
            JSON.stringify([copy.via, direct.via, direct.sourcePath]),
          ));
        });

        await scene('30i', async () => {
          // 옛 줄(via 없음)과 새 줄(via 있음)이 섞인 기록 파일을 새 DB로 복구해도 값이 같아요
          const P = prep('recover', BASIC);
          const f = makeFake(P);
          await f.call('gallery:apply-edit', [idOf(f, 'a.jpg')], SUGGEST(idOf(f, 'src.jpg')));
          f.close();
          const jf = path.join(P.ud, 'manual-edits.jsonl');
          const line = JSON.parse(fs.readFileSync(jf, 'utf8').trim());
          const old = { ...line, batchId: 'old-line', items: [{ path: path.join(P.root, 'b.jpg'), before: null, after: { takenAt: null, takenOffset: null, lat: 1, lng: 2 } }] };
          delete old.via;
          delete old.sourcePath;
          fs.appendFileSync(jf, `${JSON.stringify(old)}\n`);
          fs.mkdirSync(path.join(P.ud, 'fresh'), { recursive: true });
          const fresh = openDb(path.join(P.ud, 'fresh', 'library.db'));
          const r = recover(fresh.db, createJournal(jf));
          fresh.db.upsertFiles(['a.jpg', 'b.jpg'].map((name) => row({ root: P.root, path: path.join(P.root, name), name, takenDay: DAY })));
          const rows = fresh.db.listSuggestionRows(P.root);
          fresh.db.close();
          const va = rows.find((x) => x.name === 'a.jpg');
          const vb = rows.find((x) => x.name === 'b.jpg');
          out.push(sub(
            '30i 새 칸이 없는 옛 줄과 새 줄이 섞여도 복구됨',
            r.applied === 2 && va.lat === 37.5 && va.locationSource === 'manual' && vb.lat === 1 && vb.locationSource === 'manual',
            JSON.stringify([r.applied, va.lat, vb.lat]),
          ));
        });

        await scene('30j2', async () => {
          const f = makeFake(prep('busy', BASIC));
          f.flags.running = true;
          const e = await errOf(list(f));
          out.push(sub('30j 가져오기 중에는 목록을 거절', e === '가져오기가 끝난 뒤에 할 수 있어요', String(e)));
        });
      } finally {
        for (const f of fakes) {
          try {
            f.close();
          } catch (e) { /* 이미 닫혔으면 그대로 */ }
        }
      }
      return out;
    },
  },
  {
    no: 31,
    name: '위치 제안 보기 계산과 문구',
    async run() {
      const out = [];
      // src의 .mjs 파일도 React가 없는 순수 계산이에요 (file:// 주소로 불러와요)
      const { pathToFileURL } = require('url');
      const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'src', name)).href);
      const { groupKey, isRepeatClick, settleView } = await load('suggest-view.mjs');
      const { gapText, suggestApplyLabel } = await load('format.mjs');

      const group = (day, sourceId, ids) => ({ day, source: { id: sourceId }, targets: ids.map((id) => ({ id })) });
      const g1 = group('2026-01-01', 1, [11, 12, 13]);
      const g2 = group('2026-01-02', 2, [21, 22]);
      const key1 = groupKey(g1);

      const kept = settleView([g2, g1], { key: key1, unchecked: new Set([11, 99]) });
      out.push(sub(
        '31a 보던 묶음이 남으면 그대로, 체크 유지, 사라진 번호는 정리',
        kept.key === key1 && kept.unchecked.size === 1 && kept.unchecked.has(11),
        JSON.stringify([kept.key, [...kept.unchecked]]),
      ));
      const moved = settleView([g2], { key: key1, unchecked: new Set([11]) });
      out.push(sub('31b 보던 묶음이 사라지면 첫 묶음, 체크는 새로', moved.key === groupKey(g2) && moved.unchecked.size === 0));
      out.push(sub('31c 처음 열 때는 첫 묶음', settleView([g1, g2], null).key === key1));
      out.push(sub('31d 묶음이 없으면 null', settleView([], { key: key1, unchecked: new Set() }) === null));
      // 빠른 두 번 누름의 뒤쪽은 받지 않아요 (보지 않은 다음 묶음에 값이 들어가지 않게). 키보드로 누르면 detail이 0이에요
      out.push(sub(
        '31g 두 번째 누름은 무시, 첫 누름과 키보드 누름은 받음',
        typeof isRepeatClick === 'function' && isRepeatClick({ detail: 2 }) && isRepeatClick({ detail: 3 }) && !isRepeatClick({ detail: 1 }) && !isRepeatClick({ detail: 0 }),
      ));

      out.push(sub(
        '31e 시간 차이 글',
        gapText(0) === '1분 안' && gapText(12) === '12분 차이' && gapText(60) === '1시간 차이' && gapText(65) === '1시간 5분 차이',
        [gapText(0), gapText(12), gapText(60), gapText(65)].join(' / '),
      ));
      out.push(sub('31f 넣기 버튼 글 (천 단위 쉼표), 0장은 빈 글자', suggestApplyLabel(1234) === '1,234장에 이 위치 넣기' && suggestApplyLabel(4) === '4장에 이 위치 넣기' && suggestApplyLabel(0) === ''));
      return out;
    },
  },
  {
    no: 32,
    name: '위치 제안 화면 열기',
    async run(env) {
      // 샘플 복사본을 백업 폴더로 정한 임시 userData로 앱을 띄우고, "정보 없는 사진"과 "위치 제안"을 눌러 글자와 화면 오류를 봐요
      //   (진짜 설정, 진짜 사진은 읽지 않아요. 값은 넣지 않아요)
      const out = [];
      const APP = path.join(__dirname, '..');
      const { launchCheck } = require('./launch-check');
      const { detectTools, runOrThrow } = require('../lib/tools');
      const copyRoot = path.join(env.tmp, 'launch-suggest-root');
      fs.cpSync(path.join(APP, 'test', 'samples', 'auto'), copyRoot, { recursive: true });
      // 샘플에는 위치 있는 사진이 없어서, 복사본 한 장에만 위치를 적어 같은 날 사진들의 근거로 만들어요
      const tools = await detectTools({}, APP);
      await runOrThrow(tools.exiftool.path, ['-overwrite_original', '-GPSLatitude=37.5', '-GPSLatitudeRef=N', '-GPSLongitude=127', '-GPSLongitudeRef=E', path.join(copyRoot, 'IMG_0104.jpg')], 'exiftool');
      const ud = path.join(env.tmp, 'launch-suggest-ud');
      fs.mkdirSync(ud, { recursive: true });
      fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ backupRoot: copyRoot }), 'utf8');
      const r = await launchCheck(APP, {
        port: 9337,
        env: { PVM_USER_DATA: ud },
        until: '10.28',
        clickText: '정보 없는 사진',
        clickUntil: '내가 넣은 정보',
        thenClickText: '위치 제안',
        thenClickUntil: '이 묶음 건너뛰기',
      });
      const text = String(r.text);
      out.push(sub('32a 묶음 글자가 보임', r.clicked === true && text.includes('남은 묶음') && text.includes('장에 이 위치 넣기') && text.includes('이 묶음 건너뛰기'), `화면 글자: ${text.slice(0, 300).replace(/\s+/g, ' ')}`));
      out.push(sub('32b 검색과 목록 전체 선택이 숨겨짐', !text.includes('목록 전체 선택')));
      out.push(sub('32c 화면 오류 없음, 정상 종료', r.errors.length === 0 && r.exitCode === 0, `${r.errors.join(' / ')} 종료 코드 ${r.exitCode}`));
      return out;
    },
  },
];

module.exports = { items };

// 이 파일만 바로 돌릴 때: 임시 폴더를 만들고, 다 통과하면 지워요
if (require.main === module) {
  (async () => {
    const { stamp } = require('../lib/logger');
    const tmp = path.join(os.tmpdir(), `pvm-check-suggest-${stamp()}`);
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

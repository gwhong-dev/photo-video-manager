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

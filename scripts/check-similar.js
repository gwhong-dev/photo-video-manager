// 파일 위치: scripts/check-similar.js
// 역할: 비슷한 사진 묶기 점검 (항목 36번부터, scripts/check.js 가 불러요)
//   샘플 그림은 점검 때 sharp로 임시 폴더에 만들어요. 실제 사진과 휴지통은 건드리지 않아요
//   이 파일만 바로 돌리기: node scripts/check-similar.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { row, sub, withDb, newDbPath } = require('./check-gallery');

// 점검용 그림: 가로 줄무늬 + 기울기 (모양이 분명해야 지문이 의미가 있어요)
async function makeImage(file, { w = 400, h = 300, seed = 1, tint = null, flat = null } = {}) {
  const sharp = require('sharp');
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      let v;
      if (flat !== null) v = flat;
      else v = Math.round(127 + 100 * Math.sin((x * seed) / 37 + (y * (seed % 3 + 1)) / 23) * Math.cos((y * seed) / 51));
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v;
    }
  }
  let img = sharp(px, { raw: { width: w, height: h, channels: 3 } });
  if (tint) img = img.tint(tint).modulate({ brightness: 1.15 }); // 필터를 씌운 것처럼
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await img.jpeg({ quality: 85 }).toFile(file);
  return file;
}

const items = [
  {
    no: 36,
    name: '비슷한 사진 지문과 묶기',
    async run(env) {
      const out = [];
      const S = require('../lib/similar');
      const base = path.join(env.tmp, 'similar');
      fs.mkdirSync(base, { recursive: true });

      // 36a 지문 계산: 왼쪽이 더 밝으면 1. 오른쪽으로 갈수록 밝으면 전부 0, 어두워지면 전부 1
      {
        const up = Buffer.alloc(72);
        const down = Buffer.alloc(72);
        for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) { up[y * 9 + x] = x * 20; down[y * 9 + x] = 200 - x * 20; }
        const a = S.dhashOf(up);
        const b = S.dhashOf(down);
        out.push(sub('36a 지문: 밝아지면 0000…, 어두워지면 ffff…, 거리 64와 0', a === '0000000000000000' && b === 'ffffffffffffffff' && S.distance(a, b) === 64 && S.distance(a, a) === 0, `${a} ${b}`));
        out.push(sub('36a 지문 거리: 한 칸 차이는 1', S.distance('0000000000000000', '0000000000000001') === 1 && S.distance('8000000000000000', '0000000000000000') === 1));
        let threw = false;
        try { S.dhashOf(Buffer.alloc(10)); } catch (e) { threw = true; }
        out.push(sub('36a 크기가 틀린 그림은 오류', threw));
      }

      // 36b 진짜 그림으로: 같은 사진의 필터·크기 바꾼 것은 가깝고, 다른 그림은 멀어요
      const imgA = await makeImage(path.join(base, 'a.jpg'), { seed: 3 });
      const imgA2 = await makeImage(path.join(base, 'a-filter.jpg'), { seed: 3, tint: { r: 255, g: 200, b: 150 } });
      const imgA3 = path.join(base, 'a-small.jpg'); // 같은 사진을 작게 줄인 것
      await require('sharp')(imgA).resize(200, 150).jpeg({ quality: 70 }).toFile(imgA3);
      const imgB = await makeImage(path.join(base, 'b.jpg'), { seed: 11 });
      const gray = async (f) => S.dhashOf(await require('sharp')(f).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer());
      const [hA, hA2, hA3, hB] = await Promise.all([imgA, imgA2, imgA3, imgB].map(gray));
      out.push(sub(
        '36b 필터를 씌운 사진과 작게 줄인 사진은 거리 6 이하, 다른 그림은 6 넘음',
        S.distance(hA, hA2) <= S.SHAPE_MAX_DIST && S.distance(hA, hA3) <= S.SHAPE_MAX_DIST && S.distance(hA, hB) > S.SHAPE_MAX_DIST,
        `필터 ${S.distance(hA, hA2)}, 작게 ${S.distance(hA, hA3)}, 다른 그림 ${S.distance(hA, hB)}`,
      ));

      // 36c 묶기 규칙
      {
        const H1 = '0f0f0f0f33333333'; // 보통 지문 (1이 32개)
        const near = '0f0f0f0f33333330'; // H1과 거리 2
        const far = 'f0f0f0f0cccccccc'; // H1과 거리 64
        const mid = '0f0f0f0fcccc3333'; // H1과 거리 16 (시간으로는 묶임, 모양으로는 안 묶임)
        const r = (id, takenAt, dhash, over = {}) => ({ id, name: `${id}.jpg`, takenAt, width: 100, height: 100, size: 1000, model: null, dhash, ...over });
        const groupsOf = (rows) => S.buildGroups(rows).map((g) => g.ids.join(','));
        out.push(sub('36c 3초 안 연속 촬영은 묶고 4초는 안 묶음',
          JSON.stringify(groupsOf([r(1, '2026-10-28T13:40:58', mid), r(2, '2026-10-28T13:41:00', H1), r(3, '2026-10-28T13:41:04', far)])) === JSON.stringify(['1,2']),
          JSON.stringify(groupsOf([r(1, '2026-10-28T13:40:58', mid), r(2, '2026-10-28T13:41:00', H1), r(3, '2026-10-28T13:41:04', far)]))));
        out.push(sub('36c 3초 안이어도 지문이 아주 다르면(24 넘음) 안 묶음, 지문이 없으면 시간만으로 묶음',
          groupsOf([r(1, '2026-10-28T13:40:58', H1), r(2, '2026-10-28T13:40:59', far)]).length === 0
            && JSON.stringify(groupsOf([r(1, '2026-10-28T13:40:58', null), r(2, '2026-10-28T13:40:59', far)])) === JSON.stringify(['1,2'])));
        out.push(sub('36c 날짜가 달라도(또는 없어도) 모양이 거의 같으면 묶음',
          JSON.stringify(groupsOf([r(1, '2020-01-01T00:00:00', H1), r(2, null, near), r(3, '2026-10-28T13:41:00', far)])) === JSON.stringify(['1,2'])));
        out.push(sub('36c 거의 한 색인 지문(1이 2개 이하)끼리는 모양으로 묶지 않음',
          groupsOf([r(1, '2020-01-01T00:00:00', '0000000000000000'), r(2, '2021-01-01T00:00:00', '0000000000000001')]).length === 0));
        out.push(sub('36c 이어지면 한 묶음 (1-2는 시간, 2-3은 모양)',
          JSON.stringify(groupsOf([r(1, '2026-10-28T13:40:58', null), r(2, '2026-10-28T13:40:59', H1), r(3, '2019-05-05T10:00:00', near)])) === JSON.stringify(['3,1,2'])));
        // 남길 사진: 가로×세로 → 파일 크기 → 먼저 찍은 것
        const keepOf = (rows) => S.buildGroups(rows)[0].keepId;
        out.push(sub('36c 남길 사진: 가장 큰 사진, 같으면 파일 크기가 큰 것, 같으면 먼저 찍은 것',
          keepOf([r(1, '2026-10-28T13:40:58', H1, { width: 100, height: 100 }), r(2, '2026-10-28T13:40:59', near, { width: 400, height: 300 })]) === 2
            && keepOf([r(1, '2026-10-28T13:40:58', H1, { size: 5 }), r(2, '2026-10-28T13:40:59', near, { size: 9 })]) === 2
            && keepOf([r(5, '2026-10-28T13:40:59', H1), r(4, '2026-10-28T13:40:58', near)]) === 4
            && keepOf([r(1, '2026-10-28T13:40:58', H1, { width: null, height: null, size: 99 }), r(2, '2026-10-28T13:40:59', near, { size: 1 })]) === 2));
        // 순서: 최근 묶음부터, 날짜 없는 묶음은 맨 뒤. 묶음 안은 찍은 순서
        const order = S.buildGroups([
          r(1, null, '00ff00ff00ff00ff'), r(2, null, '00ff00ff00ff00fe'),
          r(3, '2020-01-01T00:00:00', null), r(4, '2020-01-01T00:00:02', null),
          r(5, '2026-01-01T00:00:01', null), r(6, '2026-01-01T00:00:00', null),
        ]).map((g) => g.ids.join(','));
        out.push(sub('36c 순서: 최근 묶음부터, 날짜 없는 묶음은 맨 뒤, 묶음 안은 찍은 순서', JSON.stringify(order) === JSON.stringify(['6,5', '3,4', '1,2']), JSON.stringify(order)));
        out.push(sub('36c 한 장짜리와 잘못된 지문은 묶음이 아님', S.buildGroups([r(1, '2026-01-01T00:00:00', 'zz'), r(2, '2027-01-01T00:00:00', 'zz')]).length === 0));
      }

      // 36d 속도: 6만 장(연속 촬영 일부 섞음)도 몇 초 안에 묶음
      {
        // 고르게 퍼진 난수 (mulberry32)
        let seed = 7;
        const rnd = () => {
          seed = (seed + 0x6d2b79f5) >>> 0;
          let z = seed;
          z = Math.imul(z ^ (z >>> 15), z | 1);
          z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
          return (z ^ (z >>> 14)) >>> 0;
        };
        const hex8 = () => rnd().toString(16).padStart(8, '0');
        const rows = [];
        let t = Date.UTC(2020, 0, 1) / 1000;
        for (let i = 1; i <= 60000; i++) {
          t += (rnd() % 10 === 0) ? 1 : 600 + (rnd() % 5000);
          const d = new Date(t * 1000).toISOString().slice(0, 19);
          rows.push({ id: i, name: `${i}.jpg`, takenAt: d, width: 4032, height: 3024, size: 3000000, model: null, dhash: hex8() + hex8() });
        }
        const t0 = Date.now();
        const g = S.buildGroups(rows);
        const ms = Date.now() - t0;
        out.push(sub('36d 6만 장 묶기 10초 안', ms < 10000 && g.length > 0, `${ms}ms, 묶음 ${g.length}개`));
        // 밋밋한 그림이 많아 지문 앞부분이 똑같은 경우(쏠린 값)도 시간 안에 끝나고, 거리 6 이하 짝은 놓치지 않음
        const skew = rows.map((x, k) => ({ ...x, dhash: '0000' + x.dhash.slice(4, 12) + (k % 2 ? 'ffff' : '0f0f') }));
        skew.push({ id: 70001, name: 'p.jpg', takenAt: '2001-01-01T00:00:00', width: 1, height: 1, size: 1, model: null, dhash: '00001234abcd5a5a' });
        skew.push({ id: 70002, name: 'q.jpg', takenAt: '2011-01-01T00:00:00', width: 1, height: 1, size: 1, model: null, dhash: '00001234abcd5a5b' });
        const t1 = Date.now();
        const gs = S.buildGroups(skew);
        const ms2 = Date.now() - t1;
        out.push(sub('36d 지문 앞부분이 쏠려 있어도 10초 안, 거리 1 짝은 묶임', ms2 < 10000 && gs.some((x) => x.ids.includes(70001) && x.ids.includes(70002)), `${ms2}ms`));
      }

      // 36e DB: 지문 표, 할 일, 진행, 묶기용 줄
      await withDb(env, 'similar-db', async (db, file) => {
        db.upsertFiles([
          row({ root: 'R1', path: 'R1/a.jpg', name: 'a.jpg', width: 400, height: 300 }),
          row({ root: 'R1', path: 'R1/b.jpg', name: 'b.jpg' }),
          row({ root: 'R1', path: 'R1/v.mp4', name: 'v.mp4', mediaType: 'video' }),
          row({ root: 'R1', path: 'R1/gone.jpg', name: 'gone.jpg' }),
          row({ root: 'R2', path: 'R2/x.jpg', name: 'x.jpg' }),
        ]);
        db.setMissing(['R1/gone.jpg'], 1);
        const jobs1 = db.hashJobs('R1', 10).map((f) => f.name);
        const p0 = db.hashProgress('R1');
        const a = db.hashJobs('R1', 10).find((f) => f.name === 'a.jpg');
        const b = db.hashJobs('R1', 10).find((f) => f.name === 'b.jpg');
        db.setHash(a.path, a.size, a.mtimeMs, '0f0f0f0f33333333');
        db.setHash(b.path, b.size, b.mtimeMs, null); // 만들 수 없음
        const jobs2 = db.hashJobs('R1', 10).map((f) => f.name);
        const p1 = db.hashProgress('R1');
        const rows1 = db.similarRows('R1');
        out.push(sub(
          '36e 할 일은 이 폴더의 보이는 사진만 (영상, 사라진 것, 다른 폴더 빼고), 지문을 넣거나 실패로 적으면 빠짐',
          JSON.stringify(jobs1) === JSON.stringify(['a.jpg', 'b.jpg']) && jobs2.length === 0 && p0.total === 2 && p0.done === 0 && p1.done === 2,
          JSON.stringify([jobs1, jobs2, p0, p1]),
        ));
        out.push(sub(
          '36e 묶기용 줄: 지문, 크기, 찍은 시각 (실패는 null)',
          rows1.length === 2 && rows1[0].dhash === '0f0f0f0f33333333' && rows1[0].width === 400 && rows1[1].dhash === null && typeof rows1[0].takenAt === 'string',
          JSON.stringify(rows1),
        ));
        // 파일이 바뀌면(수정 시각) 지문이 안 맞아서 다시 할 일로
        db.upsertFiles([row({ root: 'R1', path: 'R1/a.jpg', name: 'a.jpg', mtimeMs: 999999 })]);
        const jobs3 = db.hashJobs('R1', 10).map((f) => f.name);
        out.push(sub('36e 파일이 바뀌면 지문을 다시 만들 일로 돌아감', JSON.stringify(jobs3) === JSON.stringify(['a.jpg']) && db.similarRows('R1')[0].dhash === null, JSON.stringify(jobs3)));
        // 옛 DB(지문 표 없음)를 열면 표가 생기고 구조 버전은 그대로 2
        const { DatabaseSync } = require('node:sqlite');
        const oldFile = newDbPath(env, 'similar-olddb');
        fs.mkdirSync(path.dirname(oldFile), { recursive: true });
        const { openDb } = require('../lib/db');
        openDb(oldFile).db.close();
        const raw = new DatabaseSync(oldFile);
        raw.exec('DROP TABLE photo_hashes');
        raw.close();
        const again = openDb(oldFile);
        again.db.close();
        const raw2 = new DatabaseSync(oldFile);
        const hasTable = raw2.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'photo_hashes'").all().length === 1;
        const version = raw2.prepare('PRAGMA user_version').get().user_version;
        raw2.close();
        out.push(sub('36e 지문 표가 없는 옛 DB를 열면 표가 생기고, 새로 만들지 않고, 구조 버전은 2 그대로', hasTable && !again.recovered && version === 2, JSON.stringify({ hasTable, recovered: again.recovered, version })));
        void file;
      });

      // 36f 지문 만들기 (썸네일에서): 만든 것, 썸네일 실패는 null로 적음, 원본을 못 읽은 것은 다음에 다시
      await withDb(env, 'similar-hasher', async (db) => {
        db.upsertFiles([
          // 찍은 날을 서로 멀리 둬서 시간으로는 안 묶이게 해요 (모양으로만 묶이는지 보려고)
          row({ root: 'R1', path: path.join(base, 'a.jpg'), name: 'a.jpg', takenDay: '2026-01-01', takenAt: '2026-01-01T10:00:00' }),
          row({ root: 'R1', path: path.join(base, 'a-filter.jpg'), name: 'a-filter.jpg', takenDay: '2026-03-01', takenAt: '2026-03-01T10:00:00' }),
          row({ root: 'R1', path: path.join(base, 'broken.jpg'), name: 'broken.jpg', takenDay: '2026-05-01', takenAt: '2026-05-01T10:00:00' }),
          row({ root: 'R1', path: path.join(base, 'unplugged.jpg'), name: 'unplugged.jpg', takenDay: '2026-07-01', takenAt: '2026-07-01T10:00:00' }),
        ]);
        const idOf = (name) => db.similarRows('R1').find((r) => r.name === name).id;
        const thumbs = {
          async request(id) {
            const f = db.getFile(id);
            if (f.name === 'broken.jpg') { db.setThumbState(id, 'failed'); return null; }
            if (f.name === 'unplugged.jpg') return null; // 원본을 읽을 수 없음 → none 그대로
            db.setThumbState(id, 'ready');
            return f.path; // 점검에서는 원본 그림을 썸네일 대신 써요
          },
        };
        const hasher = S.createHasher({ db, thumbs });
        const progress = [];
        const p1 = hasher.run('R1', (p) => progress.push(p));
        const p2 = hasher.run('R1');
        const same = p1 === p2;
        const r = await p1;
        const rows = db.similarRows('R1');
        const byName = Object.fromEntries(rows.map((x) => [x.name, x.dhash]));
        out.push(sub(
          '36f 썸네일에서 지문을 만들고, 썸네일 실패는 null, 원본을 못 읽은 것은 비워 둠 (다음에 다시)',
          r.made === 2 && r.failed === 1 && r.skipped === 1 && /^[0-9a-f]{16}$/.test(byName['a.jpg']) && byName['broken.jpg'] === null
            && db.hashJobs('R1', 10).map((f) => f.name).join() === 'unplugged.jpg',
          JSON.stringify([r, byName]),
        ));
        out.push(sub('36f 같은 때 두 번 부르면 하나만 돌고, 진행 알림이 옴', same && progress.length > 0 && progress[progress.length - 1].total === 4, JSON.stringify(progress)));
        const g = S.buildGroups(rows);
        out.push(sub('36f 만든 지문으로 필터만 다른 두 장이 한 묶음', g.length === 1 && g[0].ids.length === 2 && g[0].ids.includes(idOf('a.jpg')) && g[0].ids.includes(idOf('a-filter.jpg')), JSON.stringify(g)));
        await hasher.stop();
        const after = await hasher.run('R1');
        out.push(sub('36f 멈춘 뒤에는 아무것도 안 함', after.made === 0 && after.failed === 0));
      });

      return out;
    },
  },
];

module.exports = { items, makeImage };

// 이 파일만 바로 돌릴 때: 임시 폴더를 만들고, 다 통과하면 지워요
if (require.main === module) {
  (async () => {
    const { stamp } = require('../lib/logger');
    const tmp = path.join(os.tmpdir(), `pvm-check-similar-${stamp()}`);
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

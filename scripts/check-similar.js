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
      // ①② 규칙만 볼 때는 ③ 이어 찍기(60초)를 꺼요 (B0). ③은 36j 에서 따로 봐요
      const B0 = (rows, o = {}) => S.buildGroups(rows, { burstSec: 0, ...o });
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
        const groupsOf = (rows) => B0(rows).map((g) => g.ids.join(','));
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
        const keepOf = (rows) => B0(rows)[0].keepId;
        out.push(sub('36c 남길 사진: 가장 큰 사진, 같으면 파일 크기가 큰 것, 같으면 먼저 찍은 것',
          keepOf([r(1, '2026-10-28T13:40:58', H1, { width: 100, height: 100 }), r(2, '2026-10-28T13:40:59', near, { width: 400, height: 300 })]) === 2
            && keepOf([r(1, '2026-10-28T13:40:58', H1, { size: 5 }), r(2, '2026-10-28T13:40:59', near, { size: 9 })]) === 2
            && keepOf([r(5, '2026-10-28T13:40:59', H1), r(4, '2026-10-28T13:40:58', near)]) === 4
            && keepOf([r(1, '2026-10-28T13:40:58', H1, { width: null, height: null, size: 99 }), r(2, '2026-10-28T13:40:59', near, { size: 1 })]) === 2));
        // 순서: 최근 묶음부터, 날짜 없는 묶음은 맨 뒤. 묶음 안은 찍은 순서
        const order = B0([
          r(1, null, '00ff00ff00ff00ff'), r(2, null, '00ff00ff00ff00fe'),
          r(3, '2020-01-01T00:00:00', H1), r(4, '2020-01-01T00:00:02', mid),
          r(5, '2026-01-01T00:00:01', '3333333355555555'), r(6, '2026-01-01T00:00:00', '3333333355555555'),
        ]).map((g) => g.ids.join(','));
        out.push(sub('36c 순서: 최근 묶음부터, 날짜 없는 묶음은 맨 뒤, 묶음 안은 찍은 순서', JSON.stringify(order) === JSON.stringify(['6,5', '3,4', '1,2']), JSON.stringify(order)));
        out.push(sub('36c 한 장짜리와 잘못된 지문은 묶음이 아님', B0([r(1, '2026-01-01T00:00:00', 'zz'), r(2, '2027-01-01T00:00:00', 'zz')]).length === 0));
      }

      // 36i 사용자 결정 (2026-11-04): 남길 사진과 직접 비교해서 끝없이 이어지지 않음, 지문 없는 사진은 가장 가까운 한 장에만 붙고 처음엔 남김
      {
        // 1초마다 한 칸씩 바뀌는 연속 촬영 40장: 바로 앞 사진과는 늘 거리 1이지만, 첫 장과는 점점 멀어져요
        const bits = (k) => {
          // 앞 k칸을 뒤집은 지문 (1이 32개 근처를 유지하려고 0f0f... 바탕에서 뒤집어요)
          let hi = 0x0f0f0f0f;
          let lo = 0x33333333;
          for (let b = 0; b < k; b++) {
            if (b < 32) hi ^= (1 << (31 - b)) >>> 0;
            else lo ^= (1 << (63 - b)) >>> 0;
          }
          return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
        };
        const at = (sec) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString().slice(0, 19);
        const drift = [];
        for (let k = 0; k < 40; k++) drift.push({ id: k + 1, name: `${k + 1}.jpg`, takenAt: at(k), width: 10, height: 10, size: 1, dhash: bits(k) });
        const dg = B0(drift);
        const biggest = Math.max(...dg.map((g) => g.ids.length));
        out.push(sub('36i 장면이 조금씩 바뀌는 40초 연속 촬영은 한 묶음으로 끝없이 이어지지 않음 (남길 사진과 거리 24 넘으면 새 묶음)',
          dg.length >= 2 && biggest <= 25 && dg.every((g) => g.ids.every((id) => S.distance(drift[id - 1].dhash, drift[g.keepId - 1].dhash) <= 24)),
          `묶음 ${dg.length}개, 가장 큰 묶음 ${biggest}장`));
        // 지문 없는 사진: 3초 안의 서로 다른 두 장면 사이에 끼어도 두 장면을 잇지 않고, 가까운 한 쪽에만 붙음
        const A = '0f0f0f0f33333333';
        const C = 'f0f0f0f0cccccccc';
        const rr = (id, sec, h) => ({ id, name: `${id}.jpg`, takenAt: at(sec), width: 10, height: 10, size: 1, dhash: h });
        const bridge = B0([rr(1, 0, A), rr(2, 1, A), rr(3, 2, null), rr(4, 4, C), rr(5, 5, C)]);
        const bridgeIds = JSON.stringify(bridge.map((g) => g.ids).sort());
        out.push(sub('36i 지문 없는 사진은 두 장면을 잇지 않고 가장 가까운 지문 있는 사진 한 장에만 붙음',
          bridgeIds === JSON.stringify([[1, 2, 3], [4, 5]]), bridgeIds));
        const lone = B0([rr(1, 0, null), rr(2, 1, null), rr(3, 2, null)]);
        out.push(sub('36i 지문 없는 사진끼리는 묶지 않음', lone.length === 0, JSON.stringify(lone)));
        // 처음엔 남김: 지문 없는 사진은 softIds, 남길 사진은 지문 있는 사진 중에서 (지문 없는 사진이 더 커도)
        const soft = B0([rr(1, 0, A), { ...rr(2, 1, null), width: 4000, height: 3000 }]);
        out.push(sub('36i 지문 없이 시간만으로 묶인 사진은 softIds (처음엔 남김), 남길 사진은 지문 있는 사진',
          soft.length === 1 && soft[0].keepId === 1 && JSON.stringify(soft[0].softIds) === '[2]', JSON.stringify(soft)));
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
        // 지문만 있고 흐림 점수가 없으면 아직 할 일 (흐림 점수만 만들면 돼요)
        const half = db.hashJobs('R1', 10).map((f) => `${f.name}:${f.needHash ? 'h' : ''}${f.needBlur ? 'b' : ''}`);
        const pHalf = db.hashProgress('R1');
        db.setBlur(a.path, a.size, a.mtimeMs, 0.31);
        db.setBlur(b.path, b.size, b.mtimeMs, null); // 만들 수 없음
        const jobs2 = db.hashJobs('R1', 10).map((f) => f.name);
        const p1 = db.hashProgress('R1');
        const rows1 = db.similarRows('R1');
        out.push(sub(
          '36e 할 일은 이 폴더의 보이는 사진만 (영상, 사라진 것, 다른 폴더 빼고), 지문을 넣거나 실패로 적으면 빠짐',
          JSON.stringify(jobs1) === JSON.stringify(['a.jpg', 'b.jpg']) && jobs2.length === 0 && p0.total === 2 && p0.done === 0 && p1.done === 2,
          JSON.stringify([jobs1, jobs2, p0, p1]),
        ));
        out.push(sub('36e 지문만 있으면 흐림 점수만 할 일로 남고 진행은 0 (둘 다 있어야 끝)',
          JSON.stringify(half) === JSON.stringify(['a.jpg:b', 'b.jpg:b']) && pHalf.done === 0, JSON.stringify([half, pHalf])));
        out.push(sub(
          '36e 묶기용 줄: 지문, 흐림 점수, 크기, 찍은 시각 (실패는 null)',
          rows1.length === 2 && rows1[0].dhash === '0f0f0f0f33333333' && rows1[0].blur === 0.31 && rows1[0].width === 400 && rows1[1].dhash === null && rows1[1].blur === null && typeof rows1[0].takenAt === 'string',
          JSON.stringify(rows1),
        ));
        // 파일이 바뀌면(수정 시각) 지문이 안 맞아서 다시 할 일로
        db.upsertFiles([row({ root: 'R1', path: 'R1/a.jpg', name: 'a.jpg', mtimeMs: 999999 })]);
        const jobs3 = db.hashJobs('R1', 10).map((f) => f.name);
        const job3 = db.hashJobs('R1', 10)[0];
        out.push(sub('36e 파일이 바뀌면 지문 · 흐림 점수를 다시 만들 일로 돌아감', JSON.stringify(jobs3) === JSON.stringify(['a.jpg']) && job3.needHash && job3.needBlur && db.similarRows('R1')[0].dhash === null && db.similarRows('R1')[0].blur === null, JSON.stringify(jobs3)));
        // 뒤에서 미리 계산(readyOnly)은 썸네일이 있는 사진만
        db.setThumbState(job3.id, 'ready');
        db.upsertFiles([row({ root: 'R1', path: 'R1/c.jpg', name: 'c.jpg' })]);
        const ready = db.hashJobs('R1', 10, 0, { readyOnly: true }).map((f) => f.name);
        const all = db.hashJobs('R1', 10).map((f) => f.name);
        out.push(sub('36e 뒤에서 미리 계산할 때는 썸네일이 있는 사진만 (없는 것은 화면을 열 때)', JSON.stringify(ready) === '["a.jpg"]' && JSON.stringify(all) === '["a.jpg","c.jpg"]', JSON.stringify([ready, all])));
        // 실패한 썸네일 다시 만들기를 하면 흐림 점수 "없음"도 지워져요
        db.resetFailedThumbs('R1');
        const bAgain = db.hashJobs('R1', 10).find((f) => f.name === 'b.jpg');
        out.push(sub('36e 썸네일 다시 만들기를 하면 지문 · 흐림 점수 없음 기록이 지워져 다시 할 일로', !!bAgain && bAgain.needHash && bAgain.needBlur, JSON.stringify(bAgain && { h: bAgain.needHash, b: bAgain.needBlur })));
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
        const blurByName = Object.fromEntries(rows.map((x) => [x.name, x.blur]));
        out.push(sub(
          '36f 썸네일에서 지문을 만들고, 썸네일 실패는 null, 원본을 못 읽은 것은 비워 둠 (다음에 다시)',
          r.made === 2 && r.failed === 1 && r.skipped === 1 && /^[0-9a-f]{16}$/.test(byName['a.jpg']) && byName['broken.jpg'] === null
            && db.hashJobs('R1', 10).map((f) => f.name).join() === 'unplugged.jpg',
          JSON.stringify([r, byName]),
        ));
        out.push(sub('36f 지문과 같이 흐림 점수도 만듦 (0~1), 썸네일 실패는 null',
          typeof blurByName['a.jpg'] === 'number' && blurByName['a.jpg'] >= 0 && blurByName['a.jpg'] <= 1 && blurByName['broken.jpg'] === null && blurByName['unplugged.jpg'] === null,
          JSON.stringify(blurByName)));
        out.push(sub('36f 같은 때 두 번 부르면 하나만 돌고, 진행 알림이 옴', same && progress.length > 0 && progress[progress.length - 1].total === 4, JSON.stringify(progress)));
        const g = S.buildGroups(rows);
        out.push(sub('36f 만든 지문으로 필터만 다른 두 장이 한 묶음', g.length === 1 && g[0].ids.length === 2 && g[0].ids.includes(idOf('a.jpg')) && g[0].ids.includes(idOf('a-filter.jpg')), JSON.stringify(g)));
        await hasher.stop();
        const after = await hasher.run('R1');
        out.push(sub('36f 멈춘 뒤에는 아무것도 안 함', after.made === 0 && after.failed === 0));
        // 검증 지적: 썸네일 다시 만들기를 해도 "지문 없음"이 영구로 남았음
        db.resetFailedThumbs('R1');
        out.push(sub('36f 실패한 썸네일 다시 만들기를 하면 지문 없음 기록도 지워져 다시 할 일로',
          db.hashJobs('R1', 10).map((f) => f.name).sort().join() === 'broken.jpg,unplugged.jpg'));
      });

      // 36g 검증 지적: 할 일 조회가 사진 수의 제곱으로 느려졌음 → 번호 순서로 앞으로만, 그림 읽기 실패는 없음으로 적지 않음
      await withDb(env, 'similar-hasher-scale', async (db) => {
        const N = 3000;
        const many = [];
        for (let i = 1; i <= N; i++) many.push(row({ root: 'R1', path: `R1/${i}.jpg`, name: `${i}.jpg` }));
        db.upsertFiles(many);
        const realJobs = db.hashJobs.bind(db);
        let fetched = 0;
        db.hashJobs = (root, limit, afterId, o) => {
          const r = realJobs(root, limit, afterId, o);
          fetched += r.length;
          return r;
        };
        const thumbs = {
          async request(id) {
            return id % 10 === 0 ? null : `t${id}`; // 열 장에 한 장은 원본을 못 읽음 (다음 회차에 다시)
          },
        };
        const grayOf = async (t) => {
          if (t === 't7') throw new Error('잠김'); // 썸네일이 잠깐 잠김
          return Buffer.alloc(72, Number(t.slice(1)) % 251);
        };
        const t0 = Date.now();
        const blurGrayOf = async (t) => ({ data: Buffer.alloc(256, Number(t.slice(1)) % 251), width: 16, height: 16 });
        const r = await S.createHasher({ db, thumbs, grayOf, blurGrayOf }).run('R1');
        const ms = Date.now() - t0;
        db.hashJobs = realJobs;
        const left = db.hashJobs('R1', N).map((f) => f.id);
        out.push(sub('36g 3천 장: 할 일 조회는 사진 수만큼만 읽음, 못 얻은 것과 그림 읽기 실패는 비워 둠 (다음에 다시)',
          fetched === N && r.made === N - 300 - 1 && r.skipped === 301 && r.failed === 0 && left.length === 301 && left.includes(7),
          `${ms}ms, 읽은 줄 ${fetched}, ${JSON.stringify(r)}`));
        out.push(sub('36g 이 번호 다음부터 할 일 (afterId)', db.hashJobs('R1', 2, 7).map((f) => f.id).join() === '10,20'));
      });

      // 36h 검증 지적: 연속 촬영 사이에 낀 다른 한 장이 묶음을 끊지 않음 (3초 안 앞 사진들과 비교), 모양 거리 설정이 6보다 크면 오류
      {
        const A = '0f0f0f0f33333333';
        const A2 = '0f0f0f0f3333ffff'; // A와 거리 8 (시간으로는 묶임, 모양으로는 아님)
        const C = 'f0f0f0f0cccccccc'; // A와 거리 64
        const r = (id, sec, h) => ({ id, name: `${id}.jpg`, takenAt: `2026-01-01T00:00:0${sec}`, width: 10, height: 10, size: 1, dhash: h });
        const ids = (rows) => JSON.stringify(B0(rows).map((g) => g.ids));
        const inter = ids([r(1, 0, A), r(2, 1, C), r(3, 2, A2)]);
        const far = ids([r(1, 0, A), r(2, 2, C), r(3, 4, A2)]); // 1과 3은 4초 차이 → 안 묶임
        out.push(sub('36h 사이에 다른 사진이 껴도 3초 안의 비슷한 두 장은 묶이고, 3초 넘으면 안 묶임', inter === '[[1,3]]' && far === '[]', `${inter} ${far}`));
        const same = [];
        for (let i = 1; i <= 5000; i++) same.push(r(i, 0, i % 2 ? A : C));
        const t0 = Date.now();
        const gs = B0(same);
        const ms = Date.now() - t0;
        out.push(sub('36h 같은 시각 5천 장도 빠르게 (앞 50장까지만 비교)', gs.length === 2 && ms < 3000, `${ms}ms, 묶음 ${gs.length}`));
        let threw = false;
        try { B0([], { shapeMaxDist: 7 }); } catch (e) { threw = true; }
        out.push(sub('36h 모양 거리 설정이 6보다 크면 오류 (조용히 꺼지지 않음)', threw));
      }

      // 36j 이어 찍기 (2026-11-16 사용자 결정): 같은 날 · 같은 기기 · 앞 사진과 60초 안이면 한 묶음, 처음엔 모두 남김
      {
        // 지문끼리 서로 멀어서 ①②로는 안 묶이는 사진들 (실제 안경 사진 5장처럼 dHash 로는 못 가림)
        const far = ['0f0f0f0f33333333', 'f0f0f0f0cccccccc', '00ff00ff0f0f0f0f', 'ff00ff00f0f0f0f0', '3c3c3c3cc3c3c3c3', 'c3c3c3c33c3c3c3c', '55aa55aa55aa55aa'];
        const r = (id, takenAt, over = {}) => ({ id, name: `${id}.jpg`, takenAt, takenAtSource: 'exif', width: 100, height: 100, size: 1000, model: 'iPhone 15 Pro', dhash: far[id % far.length], blur: 0.3, light: 0.5, ...over });
        // 실제 예 (G: 2026-10-23): 17:08, 19:05 한 장씩 + 22:24:57 부터 2 · 4 · 11 · 15초 간격 5장
        const day = [r(1, '2026-10-23T17:08:20'), r(2, '2026-10-23T19:05:36'), r(3, '2026-10-23T22:24:57'), r(4, '2026-10-23T22:24:59'), r(5, '2026-10-23T22:25:03'), r(6, '2026-10-23T22:25:14'), r(7, '2026-10-23T22:25:29')];
        const g = S.buildGroups(day);
        out.push(sub('36j 안경 사진 5장(2 · 4 · 11 · 15초 간격)은 한 묶음, 17:08 · 19:05 사진은 안 들어옴',
          g.length === 1 && g[0].ids.join() === '3,4,5,6,7', JSON.stringify(g)));
        out.push(sub('36j 이어 찍기로만 묶인 묶음은 timeOnly, 추천 1장만 남김 (정보가 다 있으면 softIds 없음, 2026-11-16 결정 변경)',
          g.length === 1 && g[0].timeOnly === true && g[0].softIds.length === 0 && g[0].keepId === 3 && !!g[0].keepReason, JSON.stringify(g)));
        const unknown = S.buildGroups(day.map((x) => (x.id === 6 ? { ...x, blur: null } : x)));
        out.push(sub('36j 흐림 점수가 아직 없는 사진은 처음엔 남김(softIds)', unknown.length === 1 && unknown[0].softIds.join() === '6', JSON.stringify(unknown)));
        out.push(sub('36j 60초 넘게 떨어지면 안 묶음, 사슬로는 이어짐 (0 · 50 · 100초)',
          S.buildGroups([r(1, '2026-01-01T10:00:00'), r(2, '2026-01-01T10:01:01')]).length === 0
            && S.buildGroups([r(1, '2026-01-01T10:00:00'), r(2, '2026-01-01T10:00:50'), r(3, '2026-01-01T10:01:40')]).map((x) => x.ids.join()).join('|') === '1,2,3'));
        const dev = S.buildGroups([r(1, '2026-01-01T10:00:00'), r(2, '2026-01-01T10:00:05', { model: 'Galaxy S24' }), r(3, '2026-01-01T10:00:20'), r(4, '2026-01-01T10:00:30', { model: 'Galaxy S24' })]);
        out.push(sub('36j 기기가 다르면 잇지 않음, 다른 기기 사진이 사이에 껴도 같은 기기끼리는 이어짐',
          JSON.stringify(dev.map((x) => x.ids).sort()) === '[[1,3],[2,4]]', JSON.stringify(dev.map((x) => x.ids))));
        out.push(sub('36j 날이 바뀌면 잇지 않음 (23:59:50 → 다음 날 00:00:10)',
          S.buildGroups([r(1, '2026-01-01T23:59:50'), r(2, '2026-01-02T00:00:10')]).length === 0));
        out.push(sub('36j burstSec 0 이면 이어 찍기를 쓰지 않음', S.buildGroups(day, { burstSec: 0 }).length === 0));
        // 검증 지적: 파일 이름 · 직접 넣은 날짜는 같은 시각이 많아 하루가 통째로 이어질 수 있음 → 촬영 정보(exif) 시각만 이어요
        const named = [1, 2, 3].map((k) => r(k, '2026-01-01T00:00:00', { takenAtSource: 'filename', model: null }));
        const manual = [4, 5].map((k) => r(k, '2026-01-01T10:00:00', { takenAtSource: 'manual' }));
        out.push(sub('36j 찍은 시각이 파일 이름 · 직접 넣은 값이면 이어 찍기로 잇지 않음',
          S.buildGroups([...named, ...manual]).length === 0, JSON.stringify(S.buildGroups([...named, ...manual]))));
        // ①로 묶인 두 장(3초 안 · 지문 가까움) + 30초 뒤 다른 장면 한 장 → 하나로 합치되, ① 묶음의 처음 표시는 그대로
        const A = '0f0f0f0f33333333';
        const An = '0f0f0f0f33333330';
        const mix = S.buildGroups([r(1, '2026-01-01T10:00:00', { dhash: A, width: 400, height: 300 }), r(2, '2026-01-01T10:00:02', { dhash: An }), r(3, '2026-01-01T10:00:32', { dhash: 'f0f0f0f0cccccccc' })]);
        out.push(sub('36j ① 묶음에 이어 찍은 사진이 붙으면 한 묶음, 추천 1장(가장 큰 사진)만 남김',
          mix.length === 1 && mix[0].ids.join() === '1,2,3' && mix[0].keepId === 1 && mix[0].softIds.length === 0 && mix[0].timeOnly === false && mix[0].keepReason === '가장 큰 사진', JSON.stringify(mix)));
        // ① 묶음 두 개가 이어 찍기로 이어지면 한 묶음, 두 묶음의 남길 사진은 둘 다 처음엔 남김
        const B = 'f0f0f0f0cccccccc';
        const Bn = 'f0f0f0f0cccccccd';
        const two = S.buildGroups([r(1, '2026-01-01T10:00:00', { dhash: A, width: 400, height: 300 }), r(2, '2026-01-01T10:00:01', { dhash: An }), r(3, '2026-01-01T10:00:40', { dhash: B, width: 300, height: 200 }), r(4, '2026-01-01T10:00:41', { dhash: Bn })]);
        const keepsFirst = two.length === 1 ? two[0].ids.filter((id) => id === two[0].keepId || two[0].softIds.includes(id)) : [];
        out.push(sub('36j ① 묶음 두 개가 이어지면 한 묶음, 추천 1장(1)만 남김',
          two.length === 1 && two[0].keepId === 1 && keepsFirst.join() === '1', JSON.stringify(two)));

        // 36n 추천 1장 고르기 (2026-11-16 사용자 결정): 흐리지 않음 → 노출 → 정보 → 크기 → 선명함 → 파일 크기 → 먼저 찍음
        const q = (id, over) => r(id, `2026-02-02T10:00:0${id}`, over);
        // 실제 안경 5장의 값 (흐림 · 크기는 G: 실측, 앞 3장 선명 · 뒤 2장 흐림)
        const glasses = [
          q(1, { blur: 0.337, light: 0.6, width: 3024, height: 4032, size: 1936755 }),
          q(2, { blur: 0.315, light: 0.6, width: 3024, height: 4032, size: 2041156 }),
          q(3, { blur: 0.346, light: 0.6, width: 3024, height: 4032, size: 1760173 }),
          q(4, { blur: 0.64, light: 0.55, width: 3024, height: 4032, size: 1435666 }),
          q(5, { blur: 0.685, light: 0.6, width: 3024, height: 4032, size: 1234299 }),
        ];
        const gb = S.pickBest(glasses);
        out.push(sub('36n 안경 5장: 흐린 2장을 빼고 선명도 차이가 작은 3장 중 파일이 가장 큰 IMG_82411(2번)',
          gb.keep.id === 2 && gb.reason === '흐린 사진 2장을 빼고 파일이 가장 큰 사진', JSON.stringify({ id: gb.keep.id, reason: gb.reason })));
        const dark = S.pickBest([q(1, { light: 0.05, size: 9999 }), q(2, { light: 0.5 }), q(3, { light: 0.52 })]);
        out.push(sub('36n 묶음 가운데 밝기에서 크게 벗어난(너무 어두운) 사진은 뒤로', dark.keep.id === 2 && dark.reason.startsWith('너무 어둡거나 밝은 사진 1장을 빼고'), JSON.stringify({ id: dark.keep.id, reason: dark.reason })));
        const night = S.pickBest([q(1, { light: 0.06 }), q(2, { light: 0.07, size: 2000 })]);
        out.push(sub('36n 모두 어두운 밤 사진이면 노출로 빼지 않음 (파일 크기로)', night.keep.id === 2 && night.reason === '파일이 가장 큰 사진', JSON.stringify({ id: night.keep.id, reason: night.reason })));
        const copies = S.pickBest([q(1, { width: 1536, height: 2048, blur: 0.28, size: 900000 }), q(2, { width: 3024, height: 4032, blur: 0.33, size: 2500000 })]);
        out.push(sub('36n 줄인 사본보다 원본(가로×세로가 큰 것)을 추천 (썸네일 선명도 작은 차이보다 먼저)', copies.keep.id === 2 && copies.reason === '가장 큰 사진', JSON.stringify({ id: copies.keep.id, reason: copies.reason })));
        const sharper = S.pickBest([q(1, { blur: 0.42, size: 5000 }), q(2, { blur: 0.30 })]);
        out.push(sub('36n 같은 크기면 흐림 점수가 0.03 넘게 낮은 쪽이 추천 ("가장 선명한 사진")', sharper.keep.id === 2 && sharper.reason === '가장 선명한 사진', JSON.stringify({ id: sharper.keep.id, reason: sharper.reason })));
        const info = S.pickBest([q(1, { blur: null, width: 4000, height: 3000 }), q(2, {})]);
        out.push(sub('36n 흐림 점수가 없는 사진보다 정보가 다 있는 사진을 추천', info.keep.id === 2, JSON.stringify({ id: info.keep.id, reason: info.reason })));
        const allBlur = S.pickBest([q(1, { blur: 0.7 }), q(2, { blur: 0.6, size: 2000 })]);
        out.push(sub('36n 모두 흐리면 흐림으로 빼지 않고 다음 기준으로', allBlur.keep.id === 2 && !allBlur.reason.includes('빼고'), JSON.stringify({ id: allBlur.keep.id, reason: allBlur.reason })));
        // 6만 장 중 절반이 이어 찍기여도 빠르게
        const many = [];
        let t = Date.UTC(2020, 0, 1) / 1000;
        for (let i = 1; i <= 60000; i++) {
          t += i % 2 ? 20 : 3000;
          many.push(r(i, new Date(t * 1000).toISOString().slice(0, 19), { dhash: null }));
        }
        const t0 = Date.now();
        const mg = S.buildGroups(many);
        const ms = Date.now() - t0;
        // 자정을 넘는 짝은 날이 달라 안 묶여요 → 3만 개보다 조금 적어요
        out.push(sub('36j 6만 장(이어 찍기 약 3만 묶음) 묶기 10초 안', ms < 10000 && mg.length > 29900 && mg.length <= 30000 && mg.every((x) => x.timeOnly), `${ms}ms, 묶음 ${mg.length}개`));
      }

      // 36k 흐림 점수 (Crete 방식): 선명한 그림 < 0.5 ≤ 흐리게 한 그림, 한 색 그림은 1, 너무 작으면 null
      {
        const sharp = require('sharp');
        // 8px 네모 조각 그림 (가장자리가 또렷해요). 썸네일과 같은 320×240 흑백
        const w = 320;
        const h = 240;
        const px = Buffer.alloc(w * h);
        let seed = 5;
        const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 16; };
        const blk = [];
        for (let i = 0; i < 40 * 30; i++) blk.push(rnd() % 256);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = blk[Math.floor(y / 8) * 40 + Math.floor(x / 8)];
        const gray = async (blur) => {
          let img = sharp(px, { raw: { width: w, height: h, channels: 1 } });
          if (blur) img = img.blur(blur);
          const { data, info } = await img.toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
          return { data, width: info.width, height: info.height };
        };
        const sc = S.blurOf(await gray(0));
        const sb = S.blurOf(await gray(2));
        const flat = S.blurOf({ data: Buffer.alloc(100 * 100, 128), width: 100, height: 100 });
        out.push(sub('36k 선명한 그림은 0.5 아래, 흐리게 한 같은 그림은 0.5 이상 ("흐림")',
          sc < S.BLUR_LIMIT && sb >= S.BLUR_LIMIT && !S.isBlurry(sc) && S.isBlurry(sb), `선명 ${sc}, 흐림 ${sb}`));
        out.push(sub('36k 한 색 그림은 1, 너무 작거나 모자란 그림은 null, 점수 없음은 흐림 아님',
          flat === 1 && S.blurOf({ data: Buffer.alloc(16), width: 4, height: 4 }) === null && S.blurOf({ data: Buffer.alloc(10), width: 100, height: 100 }) === null && !S.isBlurry(null)));
        const big = await gray(0);

        const t0 = Date.now();
        for (let i = 0; i < 20; i++) S.blurOf(big);
        const each = (Date.now() - t0) / 20;
        out.push(sub('36k 썸네일 한 장 흐림 계산 50ms 안 (6만 장이면 한 시간 안)', each < 50, `${each.toFixed(1)}ms`));
      }

      // 36m 검증 지적: 흐림용 그림만 못 읽어도 지문은 저장 (흐림 점수만 다음에 다시)
      await withDb(env, 'similar-hasher-half', async (db) => {
        db.upsertFiles([row({ root: 'R1', path: 'R1/1.jpg', name: '1.jpg' })]);
        const thumbs = { async request() { return 't1'; } };
        const grayOf = async () => Buffer.alloc(72, 9);
        const blurGrayOf = async () => { throw new Error('잠김'); };
        const r = await S.createHasher({ db, thumbs, grayOf, blurGrayOf }).run('R1');
        const job = db.hashJobs('R1', 10)[0];
        out.push(sub('36m 흐림용 그림만 못 읽으면 지문은 저장하고, 흐림 점수만 다시 할 일로',
          r.skipped === 1 && !!job && !job.needHash && job.needBlur && db.similarRows('R1')[0].dhash !== null, JSON.stringify({ r, job: job && { h: job.needHash, b: job.needBlur } })));
      });

      // 36l 가져오기 중(isBusy)에는 쉬었다가, 끝나면 이어서 만듦

      await withDb(env, 'similar-hasher-busy', async (db) => {
        db.upsertFiles([row({ root: 'R1', path: 'R1/1.jpg', name: '1.jpg' }), row({ root: 'R1', path: 'R1/2.jpg', name: '2.jpg' })]);
        let checks = 0;
        let requested = 0;
        const thumbs = { async request(id) { requested++; return `t${id}`; } };
        const grayOf = async () => Buffer.alloc(72, 9);
        const blurGrayOf = async () => ({ data: Buffer.alloc(256, 9), width: 16, height: 16 });
        const busyUntil = Date.now() + 1200;
        const isBusy = () => { checks++; return Date.now() < busyUntil; };
        const t0 = Date.now();
        const r = await S.createHasher({ db, thumbs, grayOf, blurGrayOf }).run('R1', null, { isBusy });
        const waited = Date.now() - t0;
        out.push(sub('36l 가져오기 중에는 썸네일도 안 읽고 쉬다가, 끝나면 두 장 다 만듦',
          waited >= 1000 && checks >= 3 && r.made === 2 && requested === 2 && db.hashProgress('R1').done === 2, JSON.stringify({ waited, checks, r })));
      });

      return out;
    },
  },
  {
    no: 37,
    name: '비슷한 사진 표시 계산과 버리기',
    async run(env) {
      const out = [];
      const { pathToFileURL } = require('url');
      const V = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'similar-view.mjs')).href);
      const D = require('../lib/similar-discard');
      const base = path.join(env.tmp, 'similar-discard');
      fs.mkdirSync(base, { recursive: true });

      // 37a 표시: 처음엔 keepId만 남김, 바꾸기, 마지막 남김은 못 버림, 모두 남기기, 버릴 번호, 사라진 사진의 기록 지우기
      {
        const g = { ids: [1, 2, 3], keepId: 2 };
        const g2 = { ids: [7, 8], keepId: 8 };
        let o = new Map();
        const first = [1, 2, 3].map((id) => V.markOf(g, id, o)).join();
        const t1 = V.toggleMark(g, 1, o); // 1 버림 → 남김
        o = t1.overrides;
        const t2 = V.toggleMark(g, 2, o); // 2 남김 → 버림 (1이 남아 있어 됨)
        o = t2.overrides;
        const t3 = V.toggleMark(g, 1, o); // 1이 마지막 남김 → 거절
        out.push(sub('37a 처음엔 가장 큰 사진만 남김, 바꿀 수 있고, 마지막 남김은 버림으로 못 바꿈',
          first === 'discard,keep,discard' && !t1.refused && !t2.refused && t3.refused && V.markOf(g, 1, t3.overrides) === 'keep',
          JSON.stringify([first, [...o]])));
        const all = V.keepAll(g, new Map());
        out.push(sub('37a 이 묶음은 모두 남기기', [1, 2, 3].every((id) => V.markOf(g, id, all) === 'keep')));
        const pinned = V.pinMarks([g, g2], new Map());
        out.push(sub('37a 버릴 번호: 보인 묶음의 고정된 버림만, 전부 버림인 묶음은 뺌',
          JSON.stringify(V.discardIds([g, g2], pinned)) === JSON.stringify([1, 3, 7])
            && JSON.stringify(V.discardIds([g2], new Map([[7, 'discard'], [8, 'discard']]))) === '[]'
            && V.pinMarks([g, g2], pinned) === pinned,
          JSON.stringify([...pinned])));
        // 검증 지적: 화면에 30개만 보이는데 안 본 묶음의 사진도 버림에 들어갔음
        out.push(sub('37a 아직 화면에 안 보인 묶음의 사진은 버리지 않음',
          JSON.stringify(V.discardIds([g, g2], V.pinMarks([g], new Map()))) === JSON.stringify([1, 3])
            && V.discardIds([g, g2], new Map()).length === 0));
        // 검증 지적: 목록을 다시 받아 가장 큰 사진(keepId)이 바뀌면 본 "남김"이 "버림"으로 바뀌었음
        {
          const seen = V.pinMarks([g], new Map()); // 2 남김, 1·3 버림
          const regrouped = { ids: [1, 2, 3, 4], keepId: 4 }; // 더 큰 4가 들어옴
          const again = V.pinMarks([regrouped], seen);
          out.push(sub('37a 다시 받은 목록에서도 본 표시는 그대로, 본 묶음에 새로 들어온 사진은 남김',
            [1, 2, 3, 4].map((id) => V.markOf(regrouped, id, again)).join() === 'discard,keep,discard,keep'
              && JSON.stringify(V.discardIds([regrouped], again)) === JSON.stringify([1, 3]),
            JSON.stringify([...again])));
        }
        const pruned = V.pruneOverrides([g], new Map([[1, 'keep'], [99, 'keep']]));
        out.push(sub('37a 다시 받은 목록에 없는 사진의 기록은 지움', pruned.size === 1 && pruned.get(1) === 'keep'));
        // 사용자 결정 (2026-11-04): 지문 없이 시간만으로 들어온 사진(softIds)과 전에 "모두 남기기"한 사진(keptIds)은 처음부터 남김
        const gs = { ids: [1, 2, 3, 4], keepId: 1, softIds: [2], keptIds: [3] };
        const pinnedS = V.pinMarks([gs], new Map());
        out.push(sub('37a 지문 없는 사진과 모두 남기기로 기억한 사진은 처음부터 남김, 나머지만 버림',
          [1, 2, 3, 4].map((id) => V.markOf(gs, id, new Map())).join() === 'keep,keep,keep,discard'
            && JSON.stringify(V.discardIds([gs], pinnedS)) === '[4]',
          JSON.stringify([...pinnedS])));
      }

      // 37i 묶음별로 먼저 옮기기 (2026-11-16 사용자 요청): 이 묶음의 고정된 버림만, 전부 버림이면 빈 목록
      {
        const g = { ids: [1, 2, 3], keepId: 1, softIds: [], keptIds: [] };
        const pinned = V.pinMarks([g], new Map());
        const other = { ids: [8, 9], keepId: 8, softIds: [], keptIds: [] };
        const both = V.pinMarks([other], pinned);
        const all = new Map([[1, 'discard'], [2, 'discard'], [3, 'discard']]);
        out.push(sub('37i 이 묶음만: 이 묶음의 버림 번호만 (다른 묶음 빼고), 모두 버림이면 빈 목록, 버튼 문구',
          JSON.stringify(V.groupDiscardIds(g, both)) === '[2,3]' && JSON.stringify(V.groupDiscardIds(g, all)) === '[]'
            && V.groupReviewLabel(2) === '이 묶음에서 버릴 2장 옮기기' && V.groupReviewLabel(0) === '',
          JSON.stringify(V.groupDiscardIds(g, both))));
        const t = { ids: [4, 5, 6], keepId: 5, keepReason: '흐린 사진 1장을 빼고 가장 선명한 사진', softIds: [], keptIds: [], timeOnly: true };
        out.push(sub('37i 이어 찍기 묶음: 추천 1장만 남김, 나머지 2장은 버림 후보, 안내 · 추천 까닭 문구',
          V.markOf(t, 5, new Map()) === 'keep' && V.markOf(t, 4, new Map()) === 'discard' && JSON.stringify(V.groupDiscardIds(t, V.pinMarks([t], new Map()))) === '[4,6]'
            && V.groupNote(t) === '1분 안에 이어 찍은 사진' && V.groupNote(g) === ''
            && V.recommendText(t) === '추천 1장: 흐린 사진 1장을 빼고 가장 선명한 사진. 나머지를 버릴지, 다른 사진을 남길지, 여러 장 남길지 골라 주세요.' && V.recommendText(g) === '',
          V.recommendText(t)));

        out.push(sub('37i 가져오기 중이면 "가져오기가 끝나면 이어서" 안내',
          V.progressText({ total: 10, done: 3, waiting: true }) === '사진 지문 3 / 10장. 가져오기가 끝나면 이어서 만들어요.', V.progressText({ total: 10, done: 3, waiting: true })));
      }

      // 37b 문구: 버튼은 결과를 말해요
      out.push(sub('37b 버튼 문구',
        V.reviewLabel(3) === '버릴 사진 3장 확인하기' && V.reviewLabel(0) === '버릴 사진이 없어요'
          && V.discardLabel({ count: 3, trash: 3, move: 0 }) === '3장 휴지통으로 옮기기'
          && V.discardLabel({ count: 2, trash: 0, move: 2 }) === '2장 정리완료원본 폴더로 옮기기'
          && V.discardLabel({ count: 1200, trash: 200, move: 1000 }) === '1,200장 옮기기',
        V.discardLabel({ count: 1200, trash: 200, move: 1000 })));
      out.push(sub('37b 확인 창과 결과 문구',
        V.previewLines({ count: 3, groups: 2, trash: 1, move: 2 }).length === 3
          && V.resultText({ trashed: 2, moved: 1, fail: 1, logName: 'x.log' }) === '휴지통으로 2장, _정리완료원본 폴더로 1장 옮겼어요. 1장은 옮기지 못했어요 (로그 x.log).'
          && V.progressText({ total: 10, done: 3 }).startsWith('사진 지문 만드는 중 3 / 10장') && V.progressText({ total: 10, done: 10 }) === '',
        V.resultText({ trashed: 2, moved: 1, fail: 1, logName: 'x.log' })));
      out.push(sub('37b 라이브 포토 짝 영상: 확인 창과 결과 문구에 개수',
        V.previewLines({ count: 2, groups: 1, trash: 2, move: 0, pairs: 1 }).includes('라이브 포토의 짝 영상 1개도 사진과 같은 곳으로 옮겨요')
          && V.resultText({ trashed: 2, pairs: 1, pairFail: 1, logName: 'x.log' }).includes('짝 영상 1개도 같이 옮겼어요')
          && V.resultText({ trashed: 2, pairs: 1, pairFail: 1, logName: 'x.log' }).includes('짝 영상 1개는 옮기지 못했어요'),
        V.resultText({ trashed: 2, pairs: 1, pairFail: 1, logName: 'x.log' })));
      out.push(sub('37b 휴지통 용량 경고는 확인 창에 "주의:"로',
        V.previewLines({ count: 1, groups: 1, trash: 1, move: 0, warnings: ['C:\ 드라이브: 넘어요'] }).at(-1) === '주의: C:\ 드라이브: 넘어요'));

      // 37c 버리기 확인(checkDiscard): 지금 DB로 묶음을 다시 만들어서 확인
      await withDb(env, 'similar-check', async (db) => {
        const H = '0f0f0f0f33333333';
        const N = '0f0f0f0f33333330';
        const F = 'f0f0f0f0cccccccc';
        db.upsertFiles([
          row({ root: 'R1', path: 'R1/a.jpg', name: 'a.jpg', takenDay: '2026-01-01', takenAt: '2026-01-01T10:00:00' }),
          row({ root: 'R1', path: 'R1/b.jpg', name: 'b.jpg', takenDay: '2026-02-01', takenAt: '2026-02-01T10:00:00' }),
          row({ root: 'R1', path: 'R1/c.jpg', name: 'c.jpg', takenDay: '2026-03-01', takenAt: '2026-03-01T10:00:00' }),
          row({ root: 'R2', path: 'R2/z.jpg', name: 'z.jpg' }),
        ]);
        for (const f of db.hashJobs('R1', 10)) db.setHash(f.path, f.size, f.mtimeMs, f.name === 'c.jpg' ? F : (f.name === 'a.jpg' ? H : N));
        const id = (n) => db.similarRows('R1').find((r) => r.name === n).id;
        const err = (ids) => { try { D.checkDiscard(db, 'R1', ids); return null; } catch (e) { return e.message; } };
        const ok = D.checkDiscard(db, 'R1', [id('b.jpg')]);
        out.push(sub('37c 묶음의 한 장은 버릴 수 있음 (경로, 크기, 수정 시각, 그 묶음에서 남는 사진을 돌려줌)',
          ok.files.length === 1 && ok.files[0].path === 'R1/b.jpg' && ok.files[0].mtimeMs === 1000 && ok.groups === 1
            && JSON.stringify(ok.files[0].keepers) === JSON.stringify([{ path: 'R1/a.jpg', size: 100, mtimeMs: 1000 }]),
          JSON.stringify(ok)));
        out.push(sub('37c 묶음을 전부 버리려 하면 거절', err([id('a.jpg'), id('b.jpg')]) === '묶음마다 적어도 한 장은 남겨 주세요'));
        out.push(sub('37c 묶음에 없는 사진, 같은 번호 두 번, 빈 목록, 이상한 번호는 거절',
          !!err([id('c.jpg')]) && !!err([id('b.jpg'), id('b.jpg')]) && !!err([]) && !!err(['x']) && !!err(null)));
        // 37j 검증 지적: 이어 찍기로만 묶인 묶음도 버리기 확인이 같은 묶음으로 봐요 (한 장은 남겨야 함)
        db.upsertFiles([
          row({ root: 'R3', path: 'R3/p1.jpg', name: 'p1.jpg', takenDay: '2026-05-05', takenAt: '2026-05-05T10:00:00', model: 'iPhone' }),
          row({ root: 'R3', path: 'R3/p2.jpg', name: 'p2.jpg', takenDay: '2026-05-05', takenAt: '2026-05-05T10:00:20', model: 'iPhone' }),
          row({ root: 'R3', path: 'R3/p3.jpg', name: 'p3.jpg', takenDay: '2026-05-05', takenAt: '2026-05-05T10:00:50', model: 'iPhone' }),
        ]);
        const far3 = { 'p1.jpg': '0f0f0f0f33333333', 'p2.jpg': 'f0f0f0f0cccccccc', 'p3.jpg': '00ff00ff0f0f0f0f' };
        for (const f of db.hashJobs('R3', 10)) db.setHash(f.path, f.size, f.mtimeMs, far3[f.name]);
        const id3 = (n) => db.similarRows('R3').find((r) => r.name === n).id;
        const err3 = (ids) => { try { D.checkDiscard(db, 'R3', ids); return null; } catch (e) { return e.message; } };
        const ok3 = D.checkDiscard(db, 'R3', [id3('p1.jpg'), id3('p2.jpg')]);
        out.push(sub('37j 이어 찍기 묶음: 두 장은 버릴 수 있고 남는 사진이 keepers, 세 장 모두는 거절',
          ok3.files.length === 2 && ok3.groups === 1 && ok3.files[0].keepers.map((k) => k.path).join() === 'R3/p3.jpg'
            && err3([id3('p1.jpg'), id3('p2.jpg'), id3('p3.jpg')]) === '묶음마다 적어도 한 장은 남겨 주세요',
          JSON.stringify(ok3.files.map((f) => f.keepers))));
        // 라이브 포토 짝 영상: 같은 폴더, 같은 이름의 MP4

        const liveRow = (p, over = {}) => row({ root: 'R1', path: p, name: path.basename(p), mediaType: 'video', takenDay: '2026-02-01', takenAt: '2026-02-01T10:00:01', durationSec: 2.5, ...over });
        db.upsertFiles([liveRow('R1/b.mp4'), liveRow('R1/b.jpg.mp4')]);
        const withPair = D.checkDiscard(db, 'R1', [id('b.jpg')]);
        out.push(sub('37c 버리는 사진의 같은 이름 짧은 MP4를 짝 영상으로 같이 (이름이 b.jpg.mp4인 것은 아님)',
          withPair.files[0].pair && withPair.files[0].pair.path === 'R1/b.mp4', JSON.stringify(withPair.files[0].pair)));
        // 검증 지적: 같은 이름의 긴 일반 영상(다른 폰)이나 시각이 먼 영상은 짝이 아님
        db.upsertFiles([liveRow('R1/b.mp4', { durationSec: 300 })]);
        const longVideo = D.checkDiscard(db, 'R1', [id('b.jpg')]).files[0].pair;
        db.upsertFiles([liveRow('R1/b.mp4', { takenAt: '2026-02-01T11:00:00' })]);
        const farVideo = D.checkDiscard(db, 'R1', [id('b.jpg')]).files[0].pair;
        db.upsertFiles([liveRow('R1/b.mp4', { durationSec: null })]);
        const noLen = D.checkDiscard(db, 'R1', [id('b.jpg')]).files[0].pair;
        out.push(sub('37c 같은 이름이어도 5초 넘는 영상, 찍은 시각이 3초 넘게 다른 영상, 길이를 모르는 영상은 짝 영상이 아님',
          longVideo === null && farVideo === null && noLen === null, JSON.stringify([longVideo, farVideo, noLen])));
        const fakeDb = (list) => ({ sameStem: () => list });
        const T = '2026-01-01T00:00:00';
        const me = { id: 1, path: 'R1/x.jpg', takenAt: T };
        const vid = { id: 2, path: 'R1/x.MOV', mediaType: 'video', size: 5, mtimeMs: 1, takenAt: T, durationSec: 3 };
        const heic = { id: 3, path: 'R1/x.heic', mediaType: 'photo', takenAt: T };
        out.push(sub('37c 짝 영상: 같은 이름 사진이 남아 있으면 안 옮김, 둘 다 버리면 번호 작은 사진에만, 영상이 둘이면 안 옮김',
          D.pairOf(fakeDb([me, vid]), 'R1', me, new Set([1])).path === 'R1/x.MOV'
            && D.pairOf(fakeDb([me, vid, heic]), 'R1', me, new Set([1])) === null
            && D.pairOf(fakeDb([me, vid, heic]), 'R1', me, new Set([1, 3])).path === 'R1/x.MOV'
            && JSON.stringify(D.pairOf(fakeDb([me, vid, heic]), 'R1', me, new Set([1, 3])).siblings) === '["R1/x.heic"]'
            && D.pairOf(fakeDb([me, vid, heic]), 'R1', heic, new Set([1, 3])) === null
            && D.pairOf(fakeDb([me, vid, { ...vid, id: 4, path: 'R1/x.mp4' }]), 'R1', me, new Set([1])) === null));
        db.setMissing(['R1/a.jpg'], 1); // 남길 사진이 사라지면 b도 묶음이 아니라 거절
        out.push(sub('37c 그 사이 남길 사진이 사라졌으면 거절 (목록이 바뀜)', !!err([id('b.jpg')])));
      });

      // 37d 옮기기(discardFiles): 하드디스크는 휴지통, USB는 _정리완료원본, "바로 제거"면 이동, 휴지통 실패면 이동, 실패는 남김
      {
        const root = path.join(base, 'root');
        const put = (rel) => {
          const p = path.join(root, rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, rel);
          return p;
        };
        const files = [
          put(path.join('hdd', '1.jpg')),
          put(path.join('usb', '2026', '2.jpg')),
          put(path.join('nuke', '3.jpg')),
          put(path.join('hdd', 'trashfail.jpg')),
          put(path.join('hdd', 'trashgone.jpg')),
        ];
        // 이미 같은 이름이 _정리완료원본에 있으면 _1
        put(path.join('_정리완료원본', 'usb', '2026', '2.jpg'));
        const outside = path.join(base, 'outside.jpg');
        fs.writeFileSync(outside, 'x');
        const bin = [];
        const trash = async (p) => {
          if (p.endsWith('trashfail.jpg')) throw new Error('휴지통 실패');
          if (p.endsWith('trashgone.jpg')) { fs.rmSync(p); throw new Error('알 수 없음'); }
          bin.push(p);
          fs.rmSync(p); // 점검에서는 휴지통 대신 지워요 (임시 폴더의 복사본)
        };
        const driveKindOf = async (p) => (p.includes(`${path.sep}usb${path.sep}`) ? 'removable' : 'fixed');
        const recycleOf = async (p) => (p.includes(`${path.sep}nuke${path.sep}`) ? { nuke: true } : null);
        const { createLogger } = require('../lib/logger');
        const logDir = path.join(base, 'logs');
        const list = [...files, outside].map((p, i) => ({ id: i + 1, path: p, name: path.basename(p), size: 10 }));
        const info = await D.discardInfo(list, { driveKindOf, recycleOf });
        out.push(sub('37d 미리보기: 휴지통 4장(하드디스크), 이동 2장(USB, 바로 제거)', info.count === 6 && info.trash === 4 && info.move === 2 && info.bytes === 60, JSON.stringify(info)));
        const progress = [];
        const r = await D.discardFiles({ root, files: list, trash, driveKindOf, recycleOf, logger: createLogger(logDir), onProgress: (p) => progress.push(p) });
        const moved = (rel) => fs.existsSync(path.join(root, '_정리완료원본', rel));
        out.push(sub(
          '37d 하드디스크는 휴지통, USB와 바로 제거는 _정리완료원본(이름 겹치면 _1), 휴지통 실패는 이동',
          r.trashed === 1 && bin.length === 1 && bin[0] === files[0]
            && moved(path.join('usb', '2026', '2_1.jpg')) && moved(path.join('nuke', '3.jpg')) && moved(path.join('hdd', 'trashfail.jpg'))
            && r.moved === 3,
          JSON.stringify(r),
        ));
        out.push(sub(
          '37d 휴지통이 실패했는데 파일이 없어졌으면 실패, 백업 폴더 밖 사진은 안 옮김, 옮긴 것만 done',
          r.fail === 2 && fs.existsSync(outside) && r.done.length === 4 && !r.done.includes(outside) && !r.done.includes(files[4]),
          JSON.stringify(r.done.map((p) => path.basename(p))),
        ));
        const logText = fs.readFileSync(r.logPath, 'utf8');
        const lines = logText.split(/\r?\n/);
        const planIdx = lines.findIndex((l) => l.includes('예정(휴지통)') && l.includes('1.jpg'));
        const doneIdx = lines.findIndex((l) => /\t휴지통\t/.test(l) && l.includes('1.jpg'));
        out.push(sub('37d 로그: 예정 줄이 결과 줄보다 먼저, 끝 줄에 합계', planIdx >= 0 && doneIdx > planIdx && logText.includes('# 끝 / 휴지통 1, 이동 3, 실패 2') && progress.length > 0, logText.slice(-200)));
        out.push(sub('37d 원래 _정리완료원본에 있던 파일은 그대로', fs.readFileSync(path.join(root, '_정리완료원본', 'usb', '2026', '2.jpg'), 'utf8') === path.join('_정리완료원본', 'usb', '2026', '2.jpg')));

        // 37e 검증 지적: 목록을 읽은 뒤 바뀐 파일은 안 옮김, 결과 줄을 못 적어도 옮긴 목록은 돌려줌, 예정 줄을 못 적으면 안 옮김
        const fresh = put(path.join('hdd', 'fresh.jpg'));
        const changed = put(path.join('hdd', 'changed.jpg'));
        const stOf = (p) => fs.statSync(p);
        const cList = [fresh, changed].map((p, i) => ({ id: i + 1, path: p, name: path.basename(p), size: stOf(p).size, mtimeMs: stOf(p).mtimeMs }));
        fs.writeFileSync(changed, 'changed after list'); // 목록을 읽은 뒤 다른 내용으로 저장됨
        const failLogger = (when) => ({
          newLog: (prefix, header) => {
            const lg = createLogger(logDir).newLog(prefix, header);
            return { path: lg.path, write: (line) => { if (when(line)) throw new Error('디스크 가득 참'); lg.write(line); } };
          },
        });
        const fixed = async () => 'fixed';
        const r2 = await D.discardFiles({ root, files: cList, trash, driveKindOf: fixed, recycleOf: async () => null, logger: failLogger((l) => /\t휴지통\t/.test(l)) });
        out.push(sub('37e 바뀐 파일은 실패로 남기고 안 옮김, 결과 줄을 못 적어도 옮긴 사진은 done에 있음',
          r2.trashed === 1 && r2.fail === 1 && fs.existsSync(changed) && !fs.existsSync(fresh)
            && r2.done.length === 1 && r2.done[0] === fresh && r2.logFail === 1,
          JSON.stringify(r2)));
        const planFail = put(path.join('hdd', 'planfail.jpg'));
        const r3 = await D.discardFiles({ root, files: [{ id: 9, path: planFail, name: 'planfail.jpg', size: 1 }], trash, driveKindOf: fixed, recycleOf: async () => null, logger: failLogger((l) => l.includes('예정(')) });
        out.push(sub('37e 예정 줄을 못 적으면 그 사진은 옮기지 않음', r3.fail === 1 && r3.done.length === 0 && fs.existsSync(planFail), JSON.stringify(r3)));
        out.push(sub('37e 결과 문구에 못 적은 로그 줄 수', V.resultText({ trashed: 1, logFail: 2 }).includes('로그에 2줄을 적지 못했어요')));

        // 37f 검증 지적: 그 묶음에서 남길 사진이 그 사이 없어지거나 바뀌었으면 버릴 사진을 옮기지 않음
        const disk = (p) => ({ path: p, size: stOf(p).size, mtimeMs: stOf(p).mtimeMs });
        const noFsPair = () => { throw new Error('점검'); };
        const keepOk = disk(put(path.join('hdd', 'keep-ok.jpg')));
        const keepGone = disk(put(path.join('hdd', 'keep-gone.jpg')));
        const keepEdit = disk(put(path.join('hdd', 'keep-edit.jpg')));
        const kList = ['k-ok.jpg', 'k-gone.jpg', 'k-edit.jpg'].map((n, i) => ({ id: 20 + i, name: n, ...disk(put(path.join('hdd', n))), keepers: [[keepOk], [keepGone], [keepEdit]][i] }));
        fs.rmSync(keepGone.path); // 남길 사진을 탐색기에서 지움
        fs.appendFileSync(keepEdit.path, ' edited'); // 남길 사진을 그 사이 고침
        const r4 = await D.discardFiles({ root, files: kList, trash, driveKindOf: fixed, recycleOf: async () => null, logger: createLogger(logDir) });
        out.push(sub('37f 남길 사진이 그대로인 묶음만 옮기고, 남길 사진이 없어지거나 바뀐 묶음은 그대로',
          r4.trashed === 1 && r4.fail === 2 && r4.done.length === 1 && r4.done[0] === kList[0].path && fs.existsSync(kList[1].path) && fs.existsSync(kList[2].path)
            && fs.readFileSync(r4.logPath, 'utf8').includes('남길 사진이 백업 폴더에 없거나 바뀌어서'),
          JSON.stringify(r4)));
        // 37g 라이브 포토 짝 영상: 사진을 옮긴 뒤 같은 곳으로, 짝 영상이 바뀌었으면 짝 영상만 실패, 사진을 못 옮기면 짝 영상도 그대로
        const pPhoto = disk(put(path.join('usb', 'live.jpg')));
        const pVideo = disk(put(path.join('usb', 'live.mp4')));
        const qPhoto = disk(put(path.join('hdd', 'live2.jpg')));
        const qVideo = disk(put(path.join('hdd', 'live2.mp4')));
        const sPhoto = disk(put(path.join('hdd', 'live3.jpg')));
        const sVideo = disk(put(path.join('hdd', 'live3.mp4')));
        fs.appendFileSync(qVideo.path, ' edited'); // 짝 영상을 그 사이 고침
        fs.appendFileSync(sPhoto.path, ' edited'); // 사진을 그 사이 고침 → 사진도 짝 영상도 안 옮김
        const pList = [
          { id: 30, name: 'live.jpg', ...pPhoto, pair: pVideo },
          { id: 31, name: 'live2.jpg', ...qPhoto, pair: qVideo },
          { id: 32, name: 'live3.jpg', ...sPhoto, pair: sVideo },
        ];
        // 검증 지적: 같은 이름 사진 중 한 장이 실패하면 짝 영상도 그대로 (짝 영상은 맨 끝에, 같은 이름 사진이 모두 옮겨졌을 때만)
        const tPhoto = disk(put(path.join('hdd', 'live4.jpg')));
        const tHeic = disk(put(path.join('hdd', 'live4.heic')));
        const tVideo = disk(put(path.join('hdd', 'live4.mp4')));
        fs.appendFileSync(tHeic.path, ' edited'); // 같은 이름 사진이 그 사이 바뀜 → 실패
        pList.push({ id: 33, name: 'live4.jpg', ...tPhoto, pair: { ...tVideo, siblings: [tHeic.path] } }, { id: 34, name: 'live4.heic', ...tHeic, mtimeMs: tHeic.mtimeMs - 1 });
        const pInfo = await D.discardInfo(pList, { driveKindOf, recycleOf: async () => null, statfs: noFsPair });
        const r5 = await D.discardFiles({ root, files: pList, trash, driveKindOf, recycleOf: async () => null, logger: createLogger(logDir) });
        out.push(sub('37g 짝 영상은 사진과 같은 곳으로 (USB는 _정리완료원본), 바뀐 짝 영상은 그대로 두고 따로 셈, 사진이나 같은 이름 사진을 못 옮기면 짝 영상도 그대로',
          pInfo.pairs === 4 && pInfo.count === 5 && r5.pairs === 1 && r5.pairFail === 2 && r5.fail === 2
            && fs.existsSync(tVideo.path) && fs.existsSync(tHeic.path) && !fs.existsSync(tPhoto.path)
            && moved(path.join('usb', 'live.mp4')) && moved(path.join('usb', 'live.jpg'))
            && fs.existsSync(qVideo.path) && !fs.existsSync(qPhoto.path) && fs.existsSync(sPhoto.path) && fs.existsSync(sVideo.path)
            && r5.done.includes(pVideo.path) && !r5.done.includes(qVideo.path),
          JSON.stringify(r5)));
        // 휴지통 용량 경고 (설정 크기, 모르면 드라이브의 5%)
        const noFs = () => { throw new Error('점검'); };
        const wList = [{ path: kList[1].path, size: 100 }, { path: kList[2].path, size: 100 }];
        const okInfo = await D.discardInfo(wList, { driveKindOf: fixed, recycleOf: async () => null, statfs: noFs });
        const small = await D.discardInfo(wList, { driveKindOf: fixed, recycleOf: async () => ({ maxBytes: 150 }), statfs: noFs });
        const tiny = await D.discardInfo(wList, { driveKindOf: fixed, recycleOf: async () => null, statfs: () => ({ blocks: 10, bsize: 100 }) });
        out.push(sub('37f 휴지통 용량을 넘으면 경고 (설정 크기, 모르면 드라이브의 5%), 넘지 않으면 경고 없음',
          okInfo.warnings.length === 0 && small.warnings.length === 1 && small.warnings[0].includes('휴지통 설정 크기')
            && tiny.warnings.length === 1 && tiny.warnings[0].includes('약 5%'),
          JSON.stringify([okInfo.warnings, small.warnings, tiny.warnings])));
        // 37h 휴지통에 이미 든 크기도 더함, 못 읽으면 이번분만 + 안내 (원본 정리 12y와 같은 기준, 2026-11-10 사용자 요청)
        const setting = async () => ({ maxBytes: 300 });
        const full = await D.discardInfo(wList, { driveKindOf: fixed, recycleOf: setting, binUsedOf: async () => 150, statfs: noFs });
        const roomy = await D.discardInfo(wList, { driveKindOf: fixed, recycleOf: setting, binUsedOf: async () => 50, statfs: noFs });
        const unread = await D.discardInfo(wList, { driveKindOf: fixed, recycleOf: setting, binUsedOf: async () => null, statfs: noFs });
        const judged = Object.assign(async () => 'fixed', { binUsedOf: async () => 250 });
        const viaJudge = await D.discardInfo(wList, { driveKindOf: judged, recycleOf: setting, statfs: noFs });
        out.push(sub('37h 휴지통에 이미 든 크기도 더해 경고, 못 읽으면 이번분만 + 안내, 판단기의 binUsedOf를 씀',
          full.warnings.length === 1 && full.warnings[0].includes('휴지통 설정 크기') && roomy.warnings.length === 0
            && unread.warnings.length === 1 && unread.warnings[0].includes('읽지 못했어요')
            && viaJudge.warnings.length === 1 && viaJudge.warnings[0].includes('휴지통 설정 크기'),
          JSON.stringify([full.warnings, roomy.warnings, unread.warnings, viaJudge.warnings])));
      }
      return out;
    },
  },
  {
    no: 38,
    name: '비슷한 사진 화면 열기 (진짜 앱)',
    async run(env) {
      // 점검용 그림 두 장(같은 그림, 필터만 다름)을 백업 폴더로 정한 임시 userData로 앱을 띄우고,
      //   "비슷한 사진" → "버릴 사진 1장 확인하기"까지만 눌러요. 옮기기는 누르지 않아요 (진짜 휴지통을 건드리지 않음)
      const out = [];
      const APP = path.join(__dirname, '..');
      const { launchCheck } = require('./launch-check');
      const copyRoot = path.join(env.tmp, 'launch-similar-root');
      const big = path.join(copyRoot, 'same-big.jpg');
      const small = path.join(copyRoot, 'same-small.jpg');
      await makeImage(big, { seed: 5, w: 800, h: 600 });
      await require('sharp')(big).resize(400, 300).modulate({ brightness: 1.1 }).jpeg({ quality: 70 }).toFile(small);
      await makeImage(path.join(copyRoot, 'other.jpg'), { seed: 13 });
      const ud = path.join(env.tmp, 'launch-similar-ud');
      fs.mkdirSync(ud, { recursive: true });
      fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ backupRoot: copyRoot }), 'utf8');
      const r = await launchCheck(APP, {
        env: { PVM_USER_DATA: ud },
        until: '백업 폴더 다시 읽기', // 갤러리 상태를 받은 뒤 (메뉴가 켜진 뒤)
        untilMs: 30000,
        clickText: '비슷한 사진',
        clickUntil: '확인하기',
        thenClickText: '버릴 사진 1장 확인하기',
        thenClickUntil: '그만두기',
      });
      const text = String(r.text);
      out.push(sub('38a 묶음이 보이고 남김과 버림 표시, 아래 버튼', r.clicked === true && text.includes('묶음 1개') && text.includes('남김') && text.includes('버림') && text.includes('이 묶음은 모두 남기기') && text.includes('이 묶음에서 버릴 1장 옮기기'), `화면 글자:
 ${text.slice(0, 400).replace(/\s+/g, ' ')}`));
      out.push(sub('38b 확인 창: 1장을 옮긴다는 글과 결과를 말하는 버튼', text.includes('묶음 1개에서 1장을 옮겨요') && /1장 (휴지통으로|정리완료원본 폴더로) 옮기기/.test(text) && text.includes('그만두기'), `화면 글자: ${text.slice(-300).replace(/\s+/g, ' ')}`));
      out.push(sub('38c 사진 파일은 그대로 (확인 창까지만)', fs.existsSync(big) && fs.existsSync(small)));
      out.push(sub('38d 화면 오류 없음, 정상 종료', r.errors.length === 0 && r.exitCode === 0, `${r.errors.join(' / ')} 종료 코드 ${r.exitCode}`));

      // 38e 사용자 결정 (2026-11-04): "이 묶음은 모두 남기기"를 다음 실행에도 기억 → 그 묶음은 숨기고 다시 보기 버튼
      const r2 = await launchCheck(APP, {
        env: { PVM_USER_DATA: ud },
        until: '백업 폴더 다시 읽기',
        untilMs: 30000,
        clickText: '비슷한 사진',
        clickUntil: '확인하기',
        thenClickText: '이 묶음은 모두 남기기',
        thenClickUntil: '버릴 사진이 없어요',
      });
      let keeps = null;
      try {
        keeps = JSON.parse(fs.readFileSync(path.join(ud, 'similar-keeps.json'), 'utf8')).paths;
      } catch (e) { /* 아래에서 실패로 보여요 */ }
      out.push(sub('38e 모두 남기기를 누르면 두 장의 경로를 similar-keeps.json에 적음',
        r2.errors.length === 0 && Array.isArray(keeps) && keeps.length === 2 && keeps.includes(big) && keeps.includes(small),
        `${JSON.stringify(keeps)} ${r2.errors.join(' / ')}`));
      const r3 = await launchCheck(APP, {
        env: { PVM_USER_DATA: ud },
        until: '백업 폴더 다시 읽기',
        untilMs: 30000,
        clickText: '비슷한 사진',
        clickUntil: '다시 보기',
      });
      const text3 = String(r3.text);
      out.push(sub('38e 다시 켜면 그 묶음은 숨기고 "모두 남기기로 한 묶음 1개 다시 보기" 버튼, 사진 파일은 그대로',
        r3.errors.length === 0 && text3.includes('모두 남기기로 한 묶음 1개 다시 보기') && fs.existsSync(big) && fs.existsSync(small),
        `화면 글자: ${text3.slice(-300).replace(/\s+/g, ' ')}`));
      return out;
    },
  },
  {
    no: 56,
    name: '비슷한 사진 PC 안 AI 비교 (모델 받기 · 특징값 · 묶기)',
    async run(env) {
      // 진짜 모델(89MB)은 받지 않아요. 받기는 가짜 인터넷, 모델 실행은 가짜 세션으로 봐요
      //   PVM_AI_MODEL 에 진짜 모델 파일 경로를 주면 56h 에서 진짜로도 돌려 봐요 (이 PC 확인용, CI 는 건너뜀)
      const out = [];
      const { pathToFileURL } = require('url');
      const A = require('../lib/similar-ai');
      const S = require('../lib/similar');
      const V = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'similar-view.mjs')).href);
      const crypto = require('crypto');
      const base = path.join(env.tmp, 'similar-ai');
      fs.mkdirSync(base, { recursive: true });

      // 56a 특징값 줄이기 · 유사도
      {
        const v = new Float32Array(512).map((_, i) => Math.sin(i));
        const w = v.map((x) => -x);
        const a = A.toInt8(v);
        out.push(sub('56a 특징값은 512바이트, 같은 것은 1, 반대는 -1, 길이가 다르면 null',
          a.length === 512 && Math.abs(A.cosine(a, A.toInt8(v)) - 1) < 1e-9 && A.cosine(a, A.toInt8(w)) < -0.999 && A.cosine(a, Buffer.alloc(10)) === null && A.cosine(null, a) === null));
      }

      // 56b 묶기: 두 사진 모두 특징값이 있으면 유사도 0.78 미만에서 이어 찍기를 끊어요
      {
        const unit = (seed) => {
          const v = new Float32Array(512);
          for (let i = 0; i < 512; i++) v[i] = Math.sin(i * 0.37 + seed * 1.7) + 0.3 * Math.cos(i * seed);
          return v;
        };
        const mix = (a, b, t) => a.map((x, i) => x * (1 - t) + b[i] * t);
        const sceneA = unit(1);
        const sceneB = unit(9);
        const far = ['0f0f0f0f33333333', 'f0f0f0f0cccccccc', '00ff00ff0f0f0f0f', 'ff00ff00f0f0f0f0', '3c3c3c3cc3c3c3c3', 'c3c3c3c33c3c3c3c'];
        const r = (id, sec, vec, over = {}) => ({ id, name: `${id}.jpg`, takenAt: `2026-01-01T10:00:${String(sec).padStart(2, '0')}`, takenAtSource: 'exif', width: 10, height: 10, size: 1, model: 'iPhone', dhash: far[id % far.length], vec: vec ? A.toInt8(vec) : null, embedModel: vec ? A.MODEL.id : null, ...over });
        const simAB = A.cosine(A.toInt8(sceneA), A.toInt8(sceneB));
        const rows = [r(1, 0, sceneA), r(2, 5, mix(sceneA, sceneB, 0.1)), r(3, 10, sceneB), r(4, 15, mix(sceneB, sceneA, 0.1))];
        const g = S.buildGroups(rows);
        out.push(sub('56b 장면이 바뀐 곳(유사도 0.78 미만)에서 이어 찍기 사슬이 끊겨 두 묶음, 둘 다 AI 확인 · 처음엔 모두 남김',
          simAB < S.AI_LINK && JSON.stringify(g.map((x) => x.ids).sort()) === '[[1,2],[3,4]]' && g.every((x) => x.timeOnly && x.aiChecked && x.softIds.length === 2),
          `장면 유사도 ${simAB.toFixed(2)}, ${JSON.stringify(g.map((x) => [x.ids, x.aiChecked]))}`));
        const noVec = S.buildGroups([r(1, 0, null), r(2, 5, sceneB), r(3, 10, sceneA)]);
        out.push(sub('56b 한쪽이라도 특징값이 없으면 시간만으로 이어요 (AI 확인 아님)',
          noVec.length === 1 && noVec[0].ids.join() === '1,2' && noVec[0].aiChecked === false, JSON.stringify(noVec)));
        const other = S.buildGroups([r(1, 0, sceneA), r(2, 5, sceneB, { embedModel: 'old-model' })]);
        out.push(sub('56b 모델이 다른 특징값끼리는 비교하지 않고 시간만으로', other.length === 1 && other[0].aiChecked === false, JSON.stringify(other)));
        out.push(sub('56b 묶음 안내: AI 로 확인한 이어 찍기 묶음',
          V.groupNote({ timeOnly: true, aiChecked: true }) === 'AI 로 같은 장면을 확인한 이어 찍은 사진이라 처음엔 모두 남김' && V.groupNote({ timeOnly: true }) === '이어 찍은 사진이라 처음엔 모두 남김'));
      }

      // 56c 모델 받기: 정해진 주소 하나, 크기 · SHA-256 이 맞을 때만 저장 (가짜 인터넷, 작은 가짜 모델)
      {
        const saved = { bytes: A.MODEL.bytes, sha256: A.MODEL.sha256 };
        const content = Buffer.from('가짜 모델 파일 내용 '.repeat(5000));
        A.MODEL.bytes = content.length;
        A.MODEL.sha256 = crypto.createHash('sha256').update(content).digest('hex');
        const calls = [];
        const body = (buf) => new ReadableStream({ start(c) { for (let i = 0; i < buf.length; i += 7000) c.enqueue(new Uint8Array(buf.subarray(i, i + 7000))); c.close(); } });
        const fetchOk = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, body: body(content) }; };
        const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
        try {
          const b1 = path.join(base, 'dl-bad');
          const bad = Buffer.from(content);
          bad[10] ^= 1; // 한 글자만 다름
          const e1 = await errOf(() => A.downloadModel({ fetchImpl: async () => ({ ok: true, status: 200, body: body(bad) }), base: b1 }));
          const left1 = fs.existsSync(path.join(b1, 'models')) ? fs.readdirSync(path.join(b1, 'models')) : [];
          out.push(sub('56c 내용이 다르면(SHA-256) 저장하지 않고 임시 파일도 지움', !!e1 && e1.includes('원래 모델과 달라요') && left1.length === 0 && !A.modelReady(b1), `${e1} ${JSON.stringify(left1)}`));
          const e2 = await errOf(() => A.downloadModel({ fetchImpl: async () => ({ ok: false, status: 404, body: null }), base: b1 }));
          const e3 = await errOf(() => A.downloadModel({ fetchImpl: async () => { throw new Error('ENOTFOUND'); }, base: b1 }));
          const e4 = await errOf(() => A.downloadModel({ fetchImpl: undefined, base: b1 }));
          out.push(sub('56c 서버 오류 · 인터넷 끊김 · 인터넷 없음은 사람이 읽을 글로 실패',
            String(e2).includes('HTTP 404') && String(e3).includes('인터넷 연결을 확인') && String(e4).includes('인터넷 연결을 쓸 수 없어요'), `${e2} / ${e3} / ${e4}`));
          const b2 = path.join(base, 'dl-ok');
          const progress = [];
          const p = await A.downloadModel({ fetchImpl: fetchOk, base: b2, onProgress: (got, total) => progress.push([got, total]) });
          out.push(sub('56c 맞으면 설정 폴더 models 에 저장, 진행 알림, 임시 파일 없음',
            p === A.modelPath(b2) && A.modelReady(b2) && fs.readdirSync(path.join(b2, 'models')).length === 1 && progress.length > 0 && progress.at(-1)[0] === content.length,
            JSON.stringify({ p, files: fs.readdirSync(path.join(b2, 'models')), last: progress.at(-1) })));
          out.push(sub('56c 나가는 요청은 정해진 주소 하나 (huggingface.co), 보내는 내용(body · 머리글) 없음',
            calls.length === 1 && calls[0].url === A.MODEL.url && /^https:\/\/huggingface\.co\//.test(calls[0].url) && !calls[0].init.body && !calls[0].init.headers && !calls[0].init.method,
            JSON.stringify(calls.map((c) => [c.url, Object.keys(c.init)]))));
        } finally {
          A.MODEL.bytes = saved.bytes;
          A.MODEL.sha256 = saved.sha256;
        }
        out.push(sub('56c 진짜 모델 정보: 89,117,001 바이트, MIT 표기, 받는 곳은 huggingface.co Xenova/clip-vit-base-patch32',
          A.MODEL.bytes === 89117001 && /^[0-9a-f]{64}$/.test(A.MODEL.sha256) && A.MODEL.url.startsWith('https://huggingface.co/Xenova/clip-vit-base-patch32/') && A.MODEL.label.includes('MIT')));
      }

      // 56d DB: 특징값 표, 할 일, 진행, 묶기용 줄 (모델이 바뀌면 다시)
      await withDb(env, 'similar-ai-db', async (db) => {
        db.upsertFiles([
          row({ root: 'R1', path: 'R1/a.jpg', name: 'a.jpg' }),
          row({ root: 'R1', path: 'R1/b.jpg', name: 'b.jpg' }),
          row({ root: 'R1', path: 'R1/v.mp4', name: 'v.mp4', mediaType: 'video' }),
        ]);
        const jobs0 = db.embedJobs('R1', 10, 0, 'm1').map((f) => f.name);
        const [a, b] = db.embedJobs('R1', 10, 0, 'm1');
        db.setEmbed(a.path, a.size, a.mtimeMs, 'm1', A.toInt8(new Float32Array(512).fill(1)));
        db.setEmbed(b.path, b.size, b.mtimeMs, 'm1', null);
        const jobs1 = db.embedJobs('R1', 10, 0, 'm1').map((f) => f.name);
        const p1 = db.embedProgress('R1', 'm1');
        const rows = db.similarRows('R1');
        const jobsNew = db.embedJobs('R1', 10, 0, 'm2').map((f) => f.name);
        out.push(sub('56d 할 일은 사진만, 저장하면(실패 포함) 빠지고 진행에 셈, 모델이 바뀌면 다시 할 일',
          JSON.stringify(jobs0) === '["a.jpg","b.jpg"]' && jobs1.length === 0 && p1.total === 2 && p1.done === 2 && JSON.stringify(jobsNew) === '["a.jpg","b.jpg"]',
          JSON.stringify([jobs0, jobs1, p1, jobsNew])));
        out.push(sub('56d 묶기용 줄에 특징값(512바이트)과 모델 이름, 실패는 null',
          Buffer.isBuffer(rows[0].vec) && rows[0].vec.length === 512 && rows[0].embedModel === 'm1' && rows[1].vec === null && rows[1].embedModel === null, JSON.stringify(rows.map((x) => [x.name, x.vec && x.vec.length, x.embedModel]))));
        db.resetFailedThumbs('R1');
        out.push(sub('56d 썸네일 다시 만들기를 하면 특징값 실패 기록도 지워져 다시 할 일로', db.embedJobs('R1', 10, 0, 'm1').map((f) => f.name).join() === 'b.jpg'));
      });

      // 56e 특징값 만들기 (가짜 세션): 모델이 없으면 아무것도 안 함, 썸네일 실패는 null, 가져오기 중엔 쉼, 끝나면 세션을 닫음
      await withDb(env, 'similar-ai-embed', async (db) => {
        db.upsertFiles([1, 2, 3, 4].map((i) => row({ root: 'R1', path: `R1/${i}.jpg`, name: `${i}.jpg` })));
        const saved = A.MODEL.bytes;
        const b3 = path.join(base, 'embed');
        let loads = 0;
        let releases = 0;
        let runs = 0;
        const loadSession = async (file, threads) => {
          loads++;
          return { async run() { runs++; const v = new Float32Array(512); v[runs % 512] = 1; return v; }, async release() { releases++; }, file, threads };
        };
        const thumbs = {
          async request(id) {
            const f = db.getFile(id);
            if (f.name === '3.jpg') { db.setThumbState(id, 'failed'); return null; }
            if (f.name === '4.jpg') return null; // 원본을 못 읽음 → 다음에 다시
            return `t${id}`;
          },
        };
        const inputOf = async () => new Float32Array(3 * 224 * 224);
        try {
          const none = await A.createEmbedder({ db, thumbs, base: b3, loadSession, inputOf }).run('R1');
          out.push(sub('56e 모델 파일이 없으면 모델도 안 열고 아무것도 안 함', none.made === 0 && loads === 0, JSON.stringify(none)));
          A.MODEL.bytes = 10;
          fs.mkdirSync(path.join(b3, 'models'), { recursive: true });
          fs.writeFileSync(A.modelPath(b3), Buffer.alloc(10));
          const busyUntil = Date.now() + 1100;
          const em = A.createEmbedder({ db, thumbs, base: b3, loadSession, inputOf });
          const t0 = Date.now();
          const r = await em.run('R1', null, { isBusy: () => Date.now() < busyUntil });
          const waited = Date.now() - t0;
          const left = db.embedJobs('R1', 10, 0, A.MODEL.id).map((f) => f.name);
          out.push(sub('56e 만든 2장 · 썸네일 실패 1장(null) · 원본 못 읽음 1장(다음에 다시), 가져오기 중엔 쉼, 끝나면 세션 닫음',
            r.made === 2 && r.failed === 1 && r.skipped === 1 && JSON.stringify(left) === '["4.jpg"]' && waited >= 1000 && loads === 1 && releases === 1,
            JSON.stringify({ r, left, waited, loads, releases })));
          await em.stop();
          const after = await em.run('R1');
          out.push(sub('56e 멈춘 뒤에는 아무것도 안 함', after.made === 0 && loads === 1));
        } finally {
          A.MODEL.bytes = saved;
        }
      });

      // 56f 화면 문구: 받기 전 · 받는 중 · 특징값 만드는 중 · 끝
      {
        const none = V.aiLine({ model: 'none', bytes: 89117001, got: 0, total: 0, done: 0 });
        const dl = V.aiLine({ model: 'downloading', bytes: 89117001, got: 45000000 });
        const mk = V.aiLine({ model: 'ready', bytes: 89117001, total: 100, done: 40, embedding: true });
        const wait = V.aiLine({ model: 'ready', bytes: 89117001, total: 100, done: 40, embedding: true, waiting: true });
        const done = V.aiLine({ model: 'ready', bytes: 89117001, total: 100, done: 100 });
        const fail = V.aiLine({ model: 'none', bytes: 89117001, error: 'AI 모델을 받지 못했어요 (받는 중에 끊겼어요). 다시 눌러 주세요.' });
        const lines = V.aiConfirmLines({ bytes: 89117001 });
        out.push(sub('56f 받기 전 버튼 "AI 모델 89MB 받기", 받는 중 45 / 89MB, 만드는 중 40 / 100장, 가져오기 중 안내, 끝나면 숨김, 실패 글',
          none.button === 'AI 모델 89MB 받기' && dl.text === 'AI 모델 받는 중 45 / 89MB' && !dl.button && mk.text.startsWith('AI 특징값 만드는 중 40 / 100장')
            && wait.text.includes('가져오기가 끝나면') && done.text === '' && fail.text.startsWith('AI 모델을 받지 못했어요') && fail.button === 'AI 모델 89MB 받기',
          JSON.stringify([none, dl, mk, wait, done, fail])));
        out.push(sub('56f 확인 창: 받는 곳(huggingface.co) · 크기 · 보내지 않는 것 · 걸리는 시간, 버튼 "89MB 받기"',
          lines.length === 4 && lines[0].includes('huggingface.co') && lines[0].includes('89MB') && lines[2].includes('보내지 않아요') && V.aiConfirmLabel({ bytes: 89117001 }) === '89MB 받기',
          JSON.stringify(lines)));
      }

      // 56g onnxruntime-node 가 이 PC(Windows)에서 불러와져요 (exe 에 같이 들어가는 실행 도구)
      {
        let ok = false;
        let why = '';
        try {
          const ort = require('onnxruntime-node');
          ok = typeof ort.InferenceSession.create === 'function' && typeof ort.Tensor === 'function';
        } catch (e) {
          why = e.message;
        }
        out.push(sub('56g onnxruntime-node 불러오기', ok, why));
      }

      // 56h (선택) 진짜 모델로: 같은 그림 필터 사본은 0.9 이상, 다른 그림은 그보다 낮음
      const real = process.env.PVM_AI_MODEL;
      if (real && fs.existsSync(real)) {
        const ort = require('onnxruntime-node');
        const sess = await ort.InferenceSession.create(real, { intraOpNumThreads: 2 });
        const emb = async (f) => {
          const x = new ort.Tensor('float32', await A.sharpInput(f), [1, 3, 224, 224]);
          return A.toInt8((await sess.run({ pixel_values: x })).image_embeds.data);
        };
        // 알아보기 쉬운 그림: 흰 바탕 빨간 원 · 그 사본(작게, 조금 밝게) · 파란 줄무늬
        const sharp = require('sharp');
        const svg = (inner) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#fff"/>${inner}</svg>`);
        const i1 = path.join(base, 'r1.jpg');
        const i2 = path.join(base, 'r1f.jpg');
        const i3 = path.join(base, 'r2.jpg');
        await sharp(svg('<circle cx="200" cy="150" r="100" fill="#d22"/>')).jpeg().toFile(i1);
        await sharp(i1).resize(200, 150).modulate({ brightness: 1.1 }).jpeg({ quality: 60 }).toFile(i2); // 작게 줄이고 조금 밝게 한 사본
        await sharp(svg([0, 1, 2, 3, 4].map((k) => `<rect x="0" y="${k * 60}" width="400" height="30" fill="#24c"/>`).join(''))).jpeg().toFile(i3);

        const [e1, e2, e3] = [await emb(i1), await emb(i2), await emb(i3)];
        const same = A.cosine(e1, e2);
        const diff = A.cosine(e1, e3);
        out.push(sub('56h 진짜 모델: 같은 그림을 줄이고 밝게 한 사본은 0.9 이상, 다른 그림은 0.9 아래', same >= 0.9 && diff < 0.9,`같은 ${same.toFixed(3)}, 다른 ${diff.toFixed(3)}`));
        await sess.release();
      }
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

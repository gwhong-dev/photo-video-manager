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
        out.push(sub('37c 묶음의 한 장은 버릴 수 있음 (경로와 크기를 돌려줌)', ok.files.length === 1 && ok.files[0].path === 'R1/b.jpg' && ok.groups === 1, JSON.stringify(ok)));
        out.push(sub('37c 묶음을 전부 버리려 하면 거절', err([id('a.jpg'), id('b.jpg')]) === '묶음마다 적어도 한 장은 남겨 주세요'));
        out.push(sub('37c 묶음에 없는 사진, 같은 번호 두 번, 빈 목록, 이상한 번호는 거절',
          !!err([id('c.jpg')]) && !!err([id('b.jpg'), id('b.jpg')]) && !!err([]) && !!err(['x']) && !!err(null)));
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
        port: 9339,
        env: { PVM_USER_DATA: ud },
        until: '백업 폴더 다시 읽기', // 갤러리 상태를 받은 뒤 (메뉴가 켜진 뒤)
        untilMs: 30000,
        clickText: '비슷한 사진',
        clickUntil: '확인하기',
        thenClickText: '버릴 사진 1장 확인하기',
        thenClickUntil: '그만두기',
      });
      const text = String(r.text);
      out.push(sub('38a 묶음이 보이고 남김과 버림 표시, 아래 버튼', r.clicked === true && text.includes('묶음 1개') && text.includes('남김') && text.includes('버림') && text.includes('이 묶음은 모두 남기기'), `화면 글자: ${text.slice(0, 400).replace(/\s+/g, ' ')}`));
      out.push(sub('38b 확인 창: 1장을 옮긴다는 글과 결과를 말하는 버튼', text.includes('묶음 1개에서 1장을 옮겨요') && /1장 (휴지통으로|정리완료원본 폴더로) 옮기기/.test(text) && text.includes('그만두기'), `화면 글자: ${text.slice(-300).replace(/\s+/g, ' ')}`));
      out.push(sub('38c 사진 파일은 그대로 (확인 창까지만)', fs.existsSync(big) && fs.existsSync(small)));
      out.push(sub('38d 화면 오류 없음, 정상 종료', r.errors.length === 0 && r.exitCode === 0, `${r.errors.join(' / ')} 종료 코드 ${r.exitCode}`));
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

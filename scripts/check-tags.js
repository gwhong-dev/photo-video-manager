// 파일 위치: scripts/check-tags.js
// 역할: "내가 붙이는 태그" 점검 항목 (40번). scripts/check.js 의 ITEMS 끝에 붙어서 같이 돌아요.
//   빠르게 이 파일만 돌려 볼 때: node scripts/check-tags.js
//
// ⚠️ 실제 사진과 실제 userData는 쓰지 않아요 (점검 임시 폴더 env.tmp 안에만 만들어요). 사진 파일은 바뀌지 않는지도 봐요
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { row, sub } = require('./check-gallery');

const errOf = (p) => Promise.resolve().then(p).then(() => null, (e) => e.message);
const throwsText = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.message;
  }
};

const items = [
  {
    no: 40,
    name: '내가 붙이는 태그 (규칙, DB, 기록 파일, 되돌리기)',
    async run(env) {
      const out = [];
      const { cleanTagName, normalizeTagEdit, planTagEdit, toTagPreview } = require('../lib/manual-tags');

      // 40a 이름 다듬기와 검사
      {
        const ok = [cleanTagName('  여행  '), cleanTagName('제주  여행'), cleanTagName('가'.repeat(40))];
        const bad = [cleanTagName, () => cleanTagName(''), () => cleanTagName('   '), () => cleanTagName('가'.repeat(41)), () => cleanTagName('a\u0007b'), () => cleanTagName('사진'), () => cleanTagName(3)]
          .slice(1).map(throwsText);
        const op = throwsText(() => normalizeTagEdit({ op: 'rename', name: '여행' }));
        out.push(sub('40a 태그 이름: 앞뒤 공백 빼고 가운데 공백 하나, 1~40자, 제어 글자와 종류 태그(사진 등)와 글자 아닌 값은 거절',
          ok[0] === '여행' && ok[1] === '제주 여행' && ok[2].length === 40 && bad.every((t) => typeof t === 'string') && bad[4].includes('종류 태그') && !!op,
          JSON.stringify([ok.slice(0, 2), bad, op])));
      }

      // 40b 미리보기 계산: 이미 붙은 사진은 그대로, 사라진 사진과 다른 폴더는 제외
      {
        const rows = [
          { id: 1, name: 'a.jpg', path: 'R/a.jpg', root: 'R', missing: 0 },
          { id: 2, name: 'b.jpg', path: 'R/b.jpg', root: 'R', missing: 0 },
          { id: 3, name: 'c.jpg', path: 'R/c.jpg', root: 'R', missing: 1 },
          { id: 4, name: 'd.jpg', path: 'X/d.jpg', root: 'X', missing: 0 },
        ];
        const have = { 'R/a.jpg': ['여행'], 'R/b.jpg': ['가족'] };
        const add = planTagEdit(rows, { kind: 'tagAdd', name: '여행' }, (p) => have[p] || [], 'R');
        const rem = planTagEdit(rows, { kind: 'tagRemove', name: '여행' }, (p) => have[p] || [], 'R');
        const pv = toTagPreview(add);
        out.push(sub('40b 붙이기: 이미 있으면 그대로, 사라진 사진과 다른 폴더는 제외. 떼기: 있는 사진만. 미리보기에 경로 없음',
          add.counts.changed === 1 && add.counts.same === 1 && add.counts.excluded === 2 && JSON.stringify(add.items[1].after) === '["가족","여행"]'
          && rem.counts.changed === 1 && JSON.stringify(rem.items[0].after) === '[]' && !JSON.stringify(pv).includes('R/') && pv.items[0].id === 2,
          JSON.stringify([add.counts, rem.counts, pv.items])));
      }

      // 40n 띄어쓰기 글자만 다른 앨범 태그 (실사용 테스트에서 "Prague 1"이 두 번 나옴): 읽을 때 맞추고, 전에 저장한 줄은 켤 때 합침
      const { openDb } = require('../lib/db');
      {
        const { buildRow } = require('../lib/library');
        const NB = ' ';
        const meta = { Subject: [`Prague${NB}1`, 'Prague 1', ` Phu${NB}${NB}Quoc `, '사진'] };
        const r = buildRow('R', { path: 'R/a.jpg', size: 1, mtimeMs: 1, isVideo: false }, meta);
        const names = r.tags.map((t) => t.name);

        const dbFile = path.join(env.tmp, 'tags-spaces', 'library.db');
        fs.mkdirSync(path.dirname(dbFile), { recursive: true });
        const { db } = openDb(dbFile);
        const mk = (name, tags) => row({ root: 'R', path: `R/${name}`, name, tags });
        // 옛 빌드처럼 칸 글자가 다른 이름을 그대로 저장한 상태 (b는 두 이름 다, d는 앨범 `Prague{U+00A0}1` + 내가 붙인 `Prague 1`)
        db.upsertFiles([
          mk('a.jpg', [{ name: `Prague${NB}1`, source: 'album' }]),
          mk('b.jpg', [{ name: 'Prague 1', source: 'album' }, { name: `Prague${NB}1`, source: 'album' }]),
          mk('c.jpg', [{ name: 'Prague 1', source: 'album' }, { name: `Phu${NB}Quoc`, source: 'album' }]),
          mk('d.jpg', [{ name: `Prague${NB}1`, source: 'album' }]),
        ]);
        db.applyManualBatch({ id: 'N1', root: 'R', kind: 'tagAdd', createdAt: '2026-01-01T00:00:00.000Z', items: [{ path: 'R/d.jpg', before: [], after: ['Prague 1'] }] });
        const merged = db.mergeSpacedTags();
        const again = db.mergeSpacedTags();
        const { DatabaseSync } = require('node:sqlite');
        const readTags = () => {
          const raw = new DatabaseSync(dbFile, { readOnly: true });
          const tagNames = raw.prepare('SELECT name FROM tags ORDER BY name').all().map((t) => t.name);
          const counts = raw.prepare('SELECT t.name AS name, COUNT(*) AS n FROM file_tags ft JOIN tags t ON t.id = ft.tag_id GROUP BY t.name ORDER BY t.name').all();
          const dRows = raw.prepare("SELECT t.name AS name, ft.source AS source FROM file_tags ft JOIN tags t ON t.id = ft.tag_id JOIN files f ON f.id = ft.file_id WHERE f.path = 'R/d.jpg'").all()
            .map((x) => `${x.name}:${x.source}`);
          raw.close();
          return { tagNames, counts, dRows };
        };
        const afterMerge = readTags();
        // 내가 붙인 태그를 떼도 앨범 태그는 남아야 해요
        db.applyManualBatch({ id: 'N2', root: 'R', kind: 'tagRemove', createdAt: '2026-01-01T00:00:01.000Z', items: [{ path: 'R/d.jpg', before: ['Prague 1'], after: [] }] });
        const afterRemove = readTags();
        db.close();
        const cnt = (n) => (afterMerge.counts.find((c) => c.name === n) || { n: 0 }).n;
        out.push(sub('40n 앨범 태그 띄어쓰기: 읽을 때 U+00A0과 겹친 칸을 보통 칸 하나로(같은 사진 안 중복은 하나), 전에 저장한 줄은 켤 때 합침(두 번째는 0개), 내 태그와 겹치면 앨범 태그로 남고 내 태그를 떼도 그대로',
          JSON.stringify(names) === '["Prague 1","Phu Quoc","사진"]' && merged === 2 && again === 0
          && !afterMerge.tagNames.some((n) => n.includes(NB)) && cnt('Prague 1') === 4 && cnt('Phu Quoc') === 1
          && JSON.stringify(afterMerge.dRows) === '["Prague 1:album"]' && JSON.stringify(afterRemove.dRows) === '["Prague 1:album"]',
          JSON.stringify([names, merged, again, afterMerge, afterRemove.dRows])));
      }

      // 40c~ 가짜 setupGallery 로 저장, 다시 읽기, 되돌리기, 기록 파일 복구
      const { createLogger } = require('../lib/logger');
      const { createJournal } = require('../lib/manual-journal');
      const gmPath = require.resolve('../gallery-main');
      delete require.cache[gmPath];
      const gm = require('../gallery-main');
      delete require.cache[gmPath];

      const dir = path.join(env.tmp, 'tags-wire');
      const P = { root: path.resolve(dir, 'photos'), ud: path.join(dir, 'ud'), logDir: path.join(dir, 'logs') };
      fs.mkdirSync(P.root, { recursive: true });
      fs.mkdirSync(P.ud, { recursive: true });
      const names = ['a.jpg', 'b.jpg', 'c.jpg'];
      const fileRows = () => names.map((name) => row({
        root: P.root, path: path.join(P.root, name), name,
        tags: name === 'c.jpg' ? [{ name: '여행', source: 'album' }, { name: '사진', source: 'mediaType' }] : [{ name: '사진', source: 'mediaType' }],
      }));
      for (const n of names) fs.writeFileSync(path.join(P.root, n), `사진 ${n}`);
      const photoBytes = () => names.map((n) => fs.readFileSync(path.join(P.root, n), 'utf8')).join('|');
      const before = photoBytes();
      {
        const o = openDb(path.join(P.ud, 'library.db'));
        o.db.upsertFiles(fileRows());
        o.db.close();
      }

      const fakes = [];
      const makeFake = () => {
        const handlers = new Map();
        const g = gm.setupGallery({
          ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
          protocol: { handle() {} },
          getWin: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
          getSettings: () => ({ backupRoot: P.root }),
          getTools: () => ({}),
          getEt: () => null,
          isRunning: () => false,
          isPlanning: () => false,
          logger: createLogger(P.logDir),
          userDir: P.ud,
          loadScreen: async () => {},
          getJobPending: () => false,
        });
        fakes.push(g);
        return (ch, ...a) => handlers.get(ch)(null, ...a);
      };
      const withDb = (fn) => {
        const o = openDb(path.join(P.ud, 'library.db'));
        try {
          return fn(o.db);
        } finally {
          o.db.close();
        }
      };
      const idOf = (db, name) => db.listSuggestionRows(P.root).find((x) => x.name === name).id;
      const logsOf = (prefix) => (fs.existsSync(P.logDir) ? fs.readdirSync(P.logDir) : []).filter((n) => n.startsWith(prefix))
        .map((n) => fs.readFileSync(path.join(P.logDir, n), 'utf8')).join('\n');
      const scene = async (label, fn) => {
        try {
          await fn();
        } catch (e) {
          out.push(sub(`${label} 실행 중 오류`, false, String(e.stack).split('\n').slice(0, 3).join(' | ')));
        }
      };

      try {
        const ids = withDb((db) => ({ a: idOf(db, 'a.jpg'), b: idOf(db, 'b.jpg'), c: idOf(db, 'c.jpg') }));
        let call = makeFake();

        await scene('40c', async () => {
          // 40c 미리보기는 저장하지 않고, 붙이기는 기록 파일 → DB → 로그 순서로 저장
          const pv = await call('gallery:tag-preview', [ids.a, ids.b], { op: 'add', name: ' 여행 ' });
          const savedBefore = withDb((db) => db.getManualTags(path.join(P.root, 'a.jpg')).length);
          const r = await call('gallery:tag-apply', [ids.a, ids.b], { op: 'add', name: ' 여행 ' });
          const j = createJournal(path.join(P.ud, 'manual-edits.jsonl')).read().lines;
          const last = j[j.length - 1];
          const log = logsOf('manual-edit');
          out.push(sub('40c 미리보기는 저장 안 함, 붙이기는 기록 파일(tagAdd, 이름 목록)과 로그(태그 붙이기)에 남음',
            pv.counts.changed === 2 && pv.name === '여행' && savedBefore === 0 && r.count === 2 && r.kind === 'tagAdd'
            && last.kind === 'tagAdd' && last.items.length === 2 && JSON.stringify(last.items[0].after) === '["여행"]' && JSON.stringify(last.items[0].before) === '[]'
            && log.includes('태그 붙이기') && log.includes('태그 없음 → 여행'),
            JSON.stringify([pv.counts, r, last && last.kind])));

          // 40d 패널, 사이드바, 태그 필터에 나옴. 앨범 태그와 내가 붙인 태그는 따로, 같은 이름은 합쳐서 셈
          const file = await call('gallery:get-file', ids.a);
          const state = await call('gallery:get-state');
          const list = await call('gallery:tag-list');
          const onlyTag = await call('gallery:list-ids', { tag: '여행' });
          out.push(sub('40d 패널에 manual 태그, 태그 목록에 내가 붙인 2장과 앨범 1장, 태그 필터는 둘 다 찾음 (3장), 태그 수는 이름 하나',
            file.tags.some((t) => t.name === '여행' && t.source === 'manual') && JSON.stringify(list.manual) === '[{"name":"여행","count":2}]'
            && JSON.stringify(list.album) === '[{"name":"여행","count":1}]' && onlyTag.length === 3 && state.tagCount === 1 && JSON.stringify(state.manualTags) === JSON.stringify(list.manual)
            && state.lastBatch && state.lastBatch.kind === 'tagAdd',
            JSON.stringify([file.tags, list, onlyTag.length, state.tagCount])));
        });

        await scene('40e', async () => {
          // 40e 폴더를 다시 읽어도(upsertFiles가 file_tags를 통째로 바꿔도) 내가 붙인 태그가 남음
          withDb((db) => db.upsertFiles(fileRows()));
          const file = await call('gallery:get-file', ids.b);
          out.push(sub('40e 다시 읽어도 내가 붙인 태그가 남음', file.tags.some((t) => t.name === '여행' && t.source === 'manual'), JSON.stringify(file.tags)));

          // 40f 떼기 창 목록은 고른 사진의 내가 붙인 태그만 (앨범 태그는 없음), 떼기와 되돌리기
          const choices = await call('gallery:selection-tags', [ids.a, ids.c]);
          const r = await call('gallery:tag-apply', [ids.a, ids.c], { op: 'remove', name: '여행' });
          const cFile = await call('gallery:get-file', ids.c);
          const aAfter = withDb((db) => db.getManualTags(path.join(P.root, 'a.jpg')));
          const st = await call('gallery:get-state');
          const undo = await call('gallery:undo-last', st.lastBatch.id);
          const aBack = withDb((db) => db.getManualTags(path.join(P.root, 'a.jpg')));
          const undoLog = logsOf('manual-edit');
          out.push(sub('40f 떼기 목록은 내가 붙인 태그만, 떼기는 1장(앨범 태그는 그대로), 되돌리면 다시 붙음 + 되돌리기 로그',
            JSON.stringify(choices) === '[{"name":"여행","count":1}]' && r.count === 1 && r.kind === 'tagRemove' && aAfter.length === 0
            && cFile.tags.some((t) => t.name === '여행' && t.source === 'album') && undo.kind === 'tagRemove' && undo.count === 1
            && JSON.stringify(aBack) === '["여행"]' && undoLog.includes('태그 되돌리기'),
            JSON.stringify([choices, r, aAfter, undo, aBack])));

          // 40g 날짜 넣기 뒤의 태그 묶음이 마지막 묶음 (되돌리기 순서 하나. 섞인 되돌리기는 40m)
          const v = await call('gallery:apply-edit', [ids.a], { source: 'direct', date: '2020-01-02', time: '12:00:00' });
          const t = await call('gallery:tag-apply', [ids.a], { op: 'add', name: '가족' });
          const st2 = await call('gallery:get-state');
          out.push(sub('40g 날짜 넣기 뒤의 태그 묶음이 마지막 묶음 (되돌리기 순서 하나)', v.count === 1 && t.count === 1 && st2.lastBatch.id === t.batchId, JSON.stringify(st2.lastBatch)));
        });

        await scene('40h', async () => {
          // 40h DB가 새로 만들어져도 기록 파일에서 태그와 날짜가 모두 되살아남 (실제 순서: 빈 DB로 켜서 복구 → 그다음 폴더 읽기)
          for (const g of fakes.splice(0)) g.close();
          const dbFile = path.join(P.ud, 'library.db');
          for (const ext of ['', '-wal', '-shm']) {
            if (fs.existsSync(dbFile + ext)) fs.rmSync(dbFile + ext); // 점검 임시 폴더 안의 복사본 DB
          }
          call = makeFake(); // 파일 줄이 없는 DB에서 복구
          withDb((db) => db.upsertFiles(fileRows())); // 그다음 읽기 → file_tags 에 manual 로 들어가야 해요
          const a = withDb((db) => ({ tags: db.getManualTags(path.join(P.root, 'a.jpg')), b: db.getManualTags(path.join(P.root, 'b.jpg')), manual: db.getManual(path.join(P.root, 'a.jpg')) }));
          const aFile = await call('gallery:get-file', withDb((db) => idOf(db, 'a.jpg')));
          const startLog = logsOf('gallery-start');
          out.push(sub('40h DB를 새로 만들어도 복구 뒤 읽기에서 태그(a: 가족, 여행 / b: 여행)가 목록 표까지 되살아나고 날짜도 그대로, 건너뛴 줄 없음',
            JSON.stringify(a.tags) === '["가족","여행"]' && JSON.stringify(a.b) === '["여행"]' && a.manual && a.manual.takenAt === '2020-01-02T12:00:00'
            && aFile.tags.filter((t) => t.source === 'manual').map((t) => t.name).join(',') === '가족,여행' && !startLog.includes('건너뜀:'),
            JSON.stringify([a, aFile.tags, startLog.slice(-200)])));

          // 40h2 복구 때 앞의 실패한 태그 묶음은 뒤 날짜 묶음과 같은 사진이어도 넣어요 (태그와 날짜는 서로 겹침으로 안 셈)
          const { recover } = require('../lib/manual-journal');
          const jp = path.join(env.tmp, 'tags-family.jsonl');
          const j = createJournal(jp);
          const p = path.join(P.root, 'b.jpg');
          j.append({ type: 'apply', batchId: 'T1', at: '2026-01-01T00:00:00.000Z', root: P.root, kind: 'tagAdd', items: [{ path: p, before: ['여행'], after: ['여행', '옛태그'] }] });
          j.append({ type: 'apply', batchId: 'V1', at: '2026-01-02T00:00:00.000Z', root: P.root, kind: 'date', items: [{ path: p, before: null, after: { takenAt: '2018-01-01T00:00:00', takenOffset: '+09:00', lat: null, lng: null } }] });
          const fam = withDb((db) => {
            db.applyManualBatch({ id: 'V1', root: P.root, kind: 'date', createdAt: '2026-01-02T00:00:00.000Z', items: [{ path: p, before: null, after: { takenAt: '2018-01-01T00:00:00', takenOffset: '+09:00', lat: null, lng: null } }] });
            const r = recover(db, j);
            return { r, tags: db.getManualTags(p) };
          });
          out.push(sub('40h2 앞의 태그 묶음은 뒤 날짜 묶음과 같은 사진이어도 복구됨 (버리지 않음)',
            fam.r.applied === 1 && fam.r.superseded === 0 && fam.tags.includes('옛태그'), JSON.stringify(fam)));
        });

        await scene('40k', async () => {
          // 40k 앨범 태그와 같은 이름: c.jpg 에는 앨범 '여행'이 있어요. 붙이면 내가 붙인 장수에 들어가고 패널에 표시, 떼도 앨범 태그는 남음
          const idsK = withDb((db) => ({ c: idOf(db, 'c.jpg') }));
          const st0 = await call('gallery:get-state');
          const before0 = (st0.manualTags.find((t) => t.name === '여행') || { count: 0 }).count;
          const r = await call('gallery:tag-apply', [idsK.c], { op: 'add', name: '여행' });
          const st1 = await call('gallery:get-state');
          const after1 = (st1.manualTags.find((t) => t.name === '여행') || { count: 0 }).count;
          const file = await call('gallery:get-file', idsK.c);
          const rm = await call('gallery:tag-apply', [idsK.c], { op: 'remove', name: '여행' });
          const still = await call('gallery:list-ids', { tag: '여행' });
          out.push(sub('40k 앨범 태그와 같은 이름도 내가 붙인 장수에 들어가고 패널에 표시(mine), 떼도 앨범 태그로 그 필터에 남음',
            r.count === 1 && after1 === before0 + 1 && file.tags.some((t) => t.name === '여행' && t.mine === true) && rm.count === 1 && still.includes(idsK.c),
            JSON.stringify([before0, after1, file.tags, still])));

          // 40l 옛 빌드처럼 file_tags 의 manual 줄만 지워진 상태 → 다시 켜면 되돌아옴
          const aPath = path.join(P.root, 'a.jpg');
          withDb((db) => db.upsertFiles(fileRows())); // 새 빌드는 다시 넣어요. 옛 빌드 흉내는 아래에서 SQL 로
          const { DatabaseSync } = require('node:sqlite');
          const rawDb = new DatabaseSync(path.join(P.ud, 'library.db'));
          rawDb.exec("DELETE FROM file_tags WHERE source = 'manual'");
          rawDb.close();
          for (const g of fakes.splice(0)) g.close();
          call = makeFake();
          const aFile = await call('gallery:get-file', withDb((db) => idOf(db, 'a.jpg')));
          const startLog = logsOf('gallery-start');
          out.push(sub('40l 옛 빌드가 지운 manual 태그 줄을 켤 때 다시 넣음 (시작 로그에 개수)',
            aFile.tags.filter((t) => t.source === 'manual').map((t) => t.name).sort().join(',') === withDb((db) => db.getManualTags(aPath)).join(',')
            && aFile.tags.some((t) => t.source === 'manual') && startLog.includes('내가 붙인 태그'),
            JSON.stringify([aFile.tags, startLog.slice(-120)])));

          // 40m 날짜 묶음과 태그 묶음이 섞여 있어도 되돌리기는 마지막부터, 서로 값을 안 건드림
          const bId = withDb((db) => idOf(db, 'b.jpg'));
          const bPath = path.join(P.root, 'b.jpg');
          const tagsBefore = withDb((db) => db.getManualTags(bPath));
          const manualBefore = withDb((db) => db.getManual(bPath));
          const v = await call('gallery:apply-edit', [bId], { source: 'direct', date: '2019-05-05', time: '10:00:00' });
          const t = await call('gallery:tag-apply', [bId], { op: 'add', name: '공연' });
          const u1 = await call('gallery:undo-last', t.batchId);
          const mid = withDb((db) => ({ tags: db.getManualTags(bPath), manual: db.getManual(bPath) }));
          const u2 = await call('gallery:undo-last', v.batchId);
          const end = withDb((db) => ({ tags: db.getManualTags(bPath), manual: db.getManual(bPath) }));
          out.push(sub('40m 섞인 되돌리기: 태그를 먼저 되돌려도 날짜는 그대로, 날짜를 되돌려도 태그는 그대로',
            u1.kind === 'tagAdd' && JSON.stringify(mid.tags) === JSON.stringify(tagsBefore) && mid.manual && mid.manual.takenAt === '2019-05-05T10:00:00'
            && u2.kind === 'date' && JSON.stringify(end.tags) === JSON.stringify(tagsBefore) && JSON.stringify(end.manual) === JSON.stringify(manualBefore),
            JSON.stringify([u1, mid, u2, end])));
        });

        await scene('40i', async () => {
          // 40i 거절: 종류 태그 이름, 이상한 번호, 모르는 작업. 바꿀 것이 없으면 아무것도 안 씀. 사진 파일은 그대로
          const ids2 = withDb((db) => ({ a: idOf(db, 'a.jpg') }));
          const reserved = await errOf(() => call('gallery:tag-apply', [ids2.a], { op: 'add', name: '스크린샷' }));
          const badIds = await errOf(() => call('gallery:tag-apply', ['x'], { op: 'add', name: '여행' }));
          const badOp = await errOf(() => call('gallery:tag-preview', [ids2.a], { op: 'rename', name: '여행' }));
          const lines = createJournal(path.join(P.ud, 'manual-edits.jsonl')).read().lines.length;
          const none = await call('gallery:tag-apply', [ids2.a], { op: 'add', name: '여행' });
          const linesAfter = createJournal(path.join(P.ud, 'manual-edits.jsonl')).read().lines.length;
          out.push(sub('40i 종류 태그 이름, 이상한 번호, 모르는 작업은 거절. 이미 붙어 있으면 count 0이고 기록 파일 안 늘어남. 사진 파일 그대로',
            !!reserved && reserved.includes('종류 태그') && !!badIds && !!badOp && none.count === 0 && none.batchId === null && lines === linesAfter && photoBytes() === before,
            JSON.stringify([reserved, badIds, badOp, none])));
        });
      } finally {
        for (const g of fakes) {
          try {
            g.close();
          } catch (e) { /* 이미 닫힘 */ }
        }
      }

      // 40j 화면 글과 연결 (빌드 전 원본 글자로 확인)
      {
        const { tagApplyLabel, undoLabel, appliedText, undoneText } = await import('../src/format.mjs');
        const texts = [tagApplyLabel(12, 'tagAdd', '여행'), tagApplyLabel(5, 'tagRemove', '여행'), tagApplyLabel(0, 'tagAdd', '여행'),
          undoLabel(12, 'tagAdd'), appliedText(12, 'tagAdd'), appliedText(5, 'tagRemove'), undoneText(12, 'tagRemove'), undoLabel(3, 'location')];
        const want = ["12장에 '여행' 태그 붙이기", "5장에서 '여행' 태그 떼기", '', '12장 태그 붙이기 되돌리기', '12장에 태그를 붙였어요', '5장에서 태그를 뗐어요', '12장 태그 떼기를 되돌렸어요', '3장 위치 되돌리기'];
        const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'components', f), 'utf8');
        const wired = src('Sidebar.jsx').includes("onClick={() => onScreen('tags')}") && src('ContextMenu.jsx').includes('장에 태그 붙이기')
          && src('ContextMenu.jsx').includes('장에서 태그 떼기') && src('DetailPanel.jsx').includes('장에 태그 붙이기');
        out.push(sub('40j 버튼과 알림 글 ("12장에 \'여행\' 태그 붙이기" 등), 태그 메뉴가 켜져 있고 우클릭 메뉴와 패널에 버튼',
          JSON.stringify(texts) === JSON.stringify(want) && wired, JSON.stringify(texts)));
      }
      return out;
    },
  },
  {
    no: 41,
    name: '태그 붙이기, 태그 화면, 떼기 (진짜 앱)',
    async run(env) {
      // 점검용 그림 두 장을 백업 폴더로 정한 임시 userData로 앱을 띄워요. 태그는 임시 userData의 DB와 기록 파일에만 들어가요
      const out = [];
      const APP = path.join(__dirname, '..');
      const { launchCheck } = require('./launch-check');
      const { makeImage } = require('./check-similar');
      const root = path.join(env.tmp, 'launch-tags-root');
      await makeImage(path.join(root, 'one.jpg'), { seed: 3 });
      await makeImage(path.join(root, 'two.jpg'), { seed: 21 });
      const bytes = () => ['one.jpg', 'two.jpg'].map((n) => fs.readFileSync(path.join(root, n)).toString('base64')).join('|');
      const before = bytes();
      const ud = path.join(env.tmp, 'launch-tags-ud');
      fs.mkdirSync(ud, { recursive: true });
      fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ backupRoot: root }), 'utf8');
      const r = await launchCheck(APP, {
        env: { PVM_USER_DATA: ud },
        until: '백업 폴더 다시 읽기',
        untilMs: 30000,
        probe: `(${tagProbe.toString()})()`,
      });
      const q = r.probed || {};
      const seen = JSON.stringify(q).slice(0, 600);
      out.push(sub('41a 우클릭 메뉴와 패널에 태그 버튼', q.menuAdd === '1장에 태그 붙이기' && q.menuRemove === '1장에서 태그 떼기' && q.panelAdd === '1장에 태그 붙이기', seen));
      out.push(sub('41b 태그 창: 이름을 적기 전에는 버튼이 꺼져 있고, 적으면 "1장에 \'여행\' 태그 붙이기"', q.startButton === '태그 이름을 적어 주세요' && q.startDisabled === true && q.readyButton === "1장에 '여행' 태그 붙이기", seen));
      out.push(sub('41c 붙인 뒤 알림과 되돌리기 버튼, 패널에 태그', q.applied === '1장에 태그를 붙였어요' && q.undoButton === '1장 태그 붙이기 되돌리기' && q.chip === '여행', seen));
      out.push(sub('41d 태그 메뉴: 내가 붙인 태그 목록, 누르면 갤러리에 그 태그 사진만', q.tagsScreen === true && q.tagRow === '여행1' && q.filteredCells === 1, seen));
      out.push(sub('41e 떼기 창: 고른 사진의 태그를 골라 "1장에서 \'여행\' 태그 떼기", 떼면 알림', q.removeButton === "1장에서 '여행' 태그 떼기" && q.removed === '1장에서 태그를 뗐어요', seen));
      out.push(sub('41f 기록 파일에 붙이기와 떼기 두 줄, 사진 파일은 그대로', (() => {
        const p = path.join(ud, 'manual-edits.jsonl');
        const lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
        return lines.length === 2 && lines[0].kind === 'tagAdd' && lines[1].kind === 'tagRemove' && bytes() === before;
      })()));
      out.push(sub('41g 화면 오류 없음, 정상 종료', r.errors.length === 0 && r.exitCode === 0 && !q.stop, `${r.errors.join(' / ')} 종료 코드 ${r.exitCode} ${q.stop || ''}`));
      return out;
    },
  },
];

// 항목 41이 앱 화면 안에서 돌리는 함수예요. 글자로 바뀌어 넘어가니까 바깥 변수를 쓰면 안 돼요
async function tagProbe() {
  const wait = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await new Promise((res) => setTimeout(res, 100));
    }
  };
  const byText = (sel, text) => [...document.querySelectorAll(sel)].find((b) => (b.innerText || '').includes(text));
  const q = {};
  const cell = await wait(() => document.querySelector('button.cell'), 30000);
  if (!cell) return { stop: '사진 칸이 없어요' };
  cell.click();
  const panelAdd = await wait(() => byText('.panel-actions button', '태그 붙이기'));
  q.panelAdd = panelAdd ? panelAdd.innerText : '';
  cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
  const menuAdd = await wait(() => byText('.context-menu button', '태그 붙이기'));
  if (!menuAdd) return { ...q, stop: '메뉴 항목이 없어요' };
  q.menuAdd = menuAdd.innerText;
  q.menuRemove = (byText('.context-menu button', '태그 떼기') || {}).innerText;
  menuAdd.click();

  const dialog = await wait(() => document.querySelector('.tag-dialog'));
  if (!dialog) return { ...q, stop: '태그 창이 없어요' };
  const foot = () => dialog.querySelector('.dialog-foot button.primary');
  q.startButton = foot().innerText;
  q.startDisabled = foot().disabled;
  const input = dialog.querySelector('input.tag-input');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '여행');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(() => !foot().disabled);
  q.readyButton = foot().innerText;
  foot().click();
  const applied = await wait(() => byText('.banner', '태그를 붙였어요'));
  q.applied = applied ? applied.querySelector('strong').innerText : '';
  q.undoButton = applied ? (applied.querySelector('button') || {}).innerText : '';
  const chip = await wait(() => document.querySelector('.panel .chip.mine'));
  if (!chip) {
    document.querySelector('button.cell').click();
  }
  const chip2 = chip || (await wait(() => document.querySelector('.panel .chip.mine')));
  q.chip = chip2 ? chip2.innerText : '';

  // 태그 화면 → 태그를 누르면 갤러리에 그 태그 사진만
  byText('.menu button.menu-row', '태그').click();
  const view = await wait(() => document.querySelector('.tags-view .tag-row'));
  q.tagsScreen = !!document.querySelector('.tags-view');
  q.tagRow = view ? view.innerText.replace(/\s+/g, '') : '';
  if (!view) return { ...q, stop: '태그 화면 목록이 없어요' };
  view.click();
  await wait(() => !document.querySelector('.tags-view') && document.querySelector('button.cell'));
  await new Promise((res) => setTimeout(res, 500));
  q.filteredCells = document.querySelectorAll('button.cell').length;

  // 떼기
  document.querySelector('button.cell').click();
  const panelRemove = await wait(() => byText('.panel-actions button', '태그 떼기'));
  if (!panelRemove) return { ...q, stop: '떼기 버튼이 없어요' };
  panelRemove.click();
  const rd = await wait(() => document.querySelector('.tag-dialog'));
  const choice = await wait(() => rd.querySelector('button.tag-choice'));
  if (!choice) return { ...q, stop: '뗄 태그 목록이 없어요' };
  choice.click();
  const rfoot = () => rd.querySelector('.dialog-foot button.primary');
  await wait(() => !rfoot().disabled);
  q.removeButton = rfoot().innerText;
  rfoot().click();
  const removed = await wait(() => byText('.banner', '태그를 뗐어요'));
  q.removed = removed ? removed.querySelector('strong').innerText : '';
  return q;
}

module.exports = { items };

// 이 파일만 돌릴 때
if (require.main === module) {
  (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvm-check-'));
    let failed = false;
    for (const it of items) {
      const rows = await it.run({ tmp });
      for (const r of rows) {
        if (r.status !== 'ok') failed = true;
        console.log(`${r.status === 'ok' ? '✅' : '❌'} ${r.label}${r.status === 'ok' ? '' : ` — ${r.detail}`}`);
      }
    }
    if (!failed) fs.rmSync(tmp, { recursive: true, force: true });
    process.exitCode = failed ? 1 : 0;
  })();
}

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
          const last = j.filter((l) => l.type === 'apply').pop(); // 새 이름이라 뒤에 태그 목록 줄(tagDefs)이 하나 더 있어요
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
            file.tags.some((t) => t.name === '여행' && t.source === 'manual') && JSON.stringify(list.manual) === '[{"name":"여행","count":2,"hotkey":null}]'
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
      out.push(sub('41c 붙인 뒤 알림(태그 이름까지)과 되돌리기 버튼, 패널에 태그', q.applied === "1장에 '여행' 붙였어요" && q.undoButton === '1장 태그 붙이기 되돌리기' && q.chip === '여행', seen));
      out.push(sub('41d 태그 메뉴: 내가 만든 태그 목록, 누르면 갤러리에 그 태그 사진만', q.tagsScreen === true && q.tagRow === '여행1' && q.filteredCells === 1, seen));
      out.push(sub('41e 떼기 창: 고른 사진의 태그를 골라 "1장에서 \'여행\' 태그 떼기", 떼면 알림', q.removeButton === "1장에서 '여행' 태그 떼기" && q.removed === "1장에서 '여행' 뗐어요", seen));
      const seen2 = JSON.stringify(q).slice(600, 1500);
      out.push(sub('41h 왼쪽 메뉴 "새 태그" → 이름을 적기 전에는 꺼짐, "\'가족\' 태그 만들기" → 0장으로 목록에 남음',
        q.createStart === '태그 이름을 적어 주세요' && q.createButton === "'가족' 태그 만들기" && q.sideNew === '가족0', seen2));
      out.push(sub('41i 태그 화면에서 숫자 1 정하기 → 왼쪽 메뉴에 1 표시, 우클릭 메뉴에 "1장에 \'가족\' 붙이기"', q.sideKey === '1' && q.quickMenu === "1장에 '가족' 붙이기", seen2));
      out.push(sub('41j 갤러리에서 T = 붙이기 창, 검색 칸에서 1 은 무시, 1 = "1장에 \'가족\' 붙였어요" + 되돌리기',
        q.tKey === true && q.typingIgnored === true && q.quick === "1장에 '가족' 붙였어요" && q.quickUndo === '1장 태그 붙이기 되돌리기', seen2));
      out.push(sub('41k 이름 바꾸기 "1장의 태그 이름 바꾸기" → 알림, 지우기 "1장에서 \'친구\' 태그 지우기" → 되돌리면 태그와 숫자가 돌아옴',
        q.renameButton === '1장의 태그 이름 바꾸기' && q.renamed === "1장의 태그를 '친구' 이름으로 바꿨어요" && q.deleteButton === "1장에서 '친구' 태그 지우기"
        && q.deleted === "1장에서 '친구' 태그를 지웠어요" && q.deleteUndo === '1장 태그 지우기 되돌리기' && q.undone === true && q.backKey === '친구1', seen2));
      out.push(sub('41f 기록 파일: 붙이기 · 떼기 · 숫자로 붙이기 · 이름 바꾸기 · 지우기 묶음, 되돌리기, 태그 목록 줄. 사진 파일은 그대로', (() => {
        const p = path.join(ud, 'manual-edits.jsonl');
        const lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
        const kinds = lines.filter((l) => l.type === 'apply').map((l) => l.kind).join(',');
        return kinds === 'tagAdd,tagRemove,tagAdd,tagRename,tagDelete' && lines.filter((l) => l.type === 'undo').length === 1
          && lines.some((l) => l.type === 'tagDefs') && bytes() === before;
      })(), (() => {
        const p = path.join(ud, 'manual-edits.jsonl');
        return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => { const o = JSON.parse(l); return o.kind || o.type; }).join(',') : '기록 파일 없음';
      })()));
      out.push(sub('41g 화면 오류 없음, 정상 종료', r.errors.length === 0 && r.exitCode === 0 && !q.stop, `${r.errors.join(' / ')} 종료 코드 ${r.exitCode} ${q.stop || ''}`));
      return out;
    },
  },
  {
    no: 57,
    name: '태그 만들기 · 이름 바꾸기 · 지우기 · 단축키 (규칙, DB, 기록 파일, 되돌리기)',
    async run(env) {
      const out = [];
      const { cleanHotkey, normalizeRename, planTagRename } = require('../lib/manual-tags');

      // 57a 규칙: 숫자 1~9, 이름 바꾸기 검사, 합칠 때 같은 이름은 한 번만
      {
        const keys = [cleanHotkey(null), cleanHotkey(''), cleanHotkey(1), cleanHotkey('9')];
        const badKeys = [0, 10, 1.5, 'a', -1].map((k) => throwsText(() => cleanHotkey(k)));
        const same = throwsText(() => normalizeRename('여행', ' 여행 '));
        const reserved = throwsText(() => normalizeRename('여행', '사진'));
        const ok = normalizeRename('여행', '  제주  여행 ');
        const tagged = [{ path: 'a', tags: ['여행'] }, { path: 'b', tags: ['가족', '여행'] }, { path: 'c', tags: ['가족'] }];
        const mv = planTagRename(tagged, '여행', '가족');
        const del = planTagRename(tagged, '여행', null);
        out.push(sub('57a 숫자는 없음 또는 1~9만, 같은 이름 · 종류 태그 이름으로 바꾸기는 거절, 합치면 같은 이름은 한 번, 지우기는 그 이름만 뺌',
          JSON.stringify(keys) === '[null,null,1,9]' && badKeys.every((t) => typeof t === 'string') && !!same && !!reserved && ok.to === '제주 여행'
          && JSON.stringify(mv.items.map((i) => i.after)) === '[["가족"],["가족"]]' && mv.items.length === 2
          && JSON.stringify(del.items.map((i) => i.after)) === '[[],["가족"]]',
          JSON.stringify([keys, badKeys, same, reserved, ok, mv.items, del.items])));
      }

      // 57b 단축키 판단: T 와 숫자(위 줄 · 숫자판), 한글 입력 상태(code 로), 글 쓰는 칸 · 열린 창 · Ctrl/Alt/Shift · 누르고 있기는 무시, Delete 는 안 건드림
      {
        const K = await import('../src/tag-keys.mjs');
        const el = (tagName, extra = {}) => ({ tagName, ...extra });
        const a = (e, t = el('BUTTON'), open = false) => JSON.stringify(K.tagKeyAction(e, t, open));
        const res = [
          a({ code: 'KeyT', key: 't' }), a({ code: 'KeyT', key: 'ㅅ' }), a({ key: 'T' }), a({ code: 'Digit1', key: '1' }), a({ code: 'Numpad9', key: '9' }),
          a({ code: 'Digit0', key: '0' }), a({ code: 'Digit1', key: '1' }, el('INPUT')), a({ code: 'KeyT', key: 't' }, el('textarea')),
          a({ code: 'Digit2', key: '2' }, el('SELECT')), a({ code: 'Digit2', key: '2' }, el('DIV', { isContentEditable: true })),
          a({ code: 'Digit2', key: '2' }, el('DIV'), true), a({ code: 'Digit2', key: '2', ctrlKey: true }), a({ code: 'KeyT', key: 'T', shiftKey: true }),
          a({ code: 'Digit3', key: '3', repeat: true }), a({ code: 'Delete', key: 'Delete' }), a({ code: 'Digit3', key: '3', altKey: true }),
        ];
        const want = ['{"type":"open"}', '{"type":"open"}', '{"type":"open"}', '{"type":"apply","key":1}', '{"type":"apply","key":9}',
          'null', 'null', 'null', 'null', 'null', 'null', 'null', 'null', 'null', 'null', 'null'];
        const tags = [{ name: '여행', hotkey: 2 }, { name: '가족', hotkey: null }, { name: '공연', hotkey: 1 }];
        out.push(sub('57b 단축키: T(한글 상태 포함) = 창, 1~9(숫자판 포함) = 붙이기, 입력 칸 · 고르기 칸 · 열린 창 · Ctrl/Alt/Shift · 누르고 있기 · 0 · Delete 는 무시',
          JSON.stringify(res) === JSON.stringify(want) && K.tagOfKey(tags, 2) === '여행' && K.tagOfKey(tags, 5) === null
          && K.quickTags(tags).map((t) => t.name).join(',') === '공연,여행' && K.quickTagLabel(3, '여행') === "3장에 '여행' 붙이기",
          JSON.stringify(res)));
      }

      // 57c~ 가짜 setupGallery 로 저장, 다시 읽기, 되돌리기, DB 새로 만들기
      const { openDb } = require('../lib/db');
      const { createLogger } = require('../lib/logger');
      const { createJournal } = require('../lib/manual-journal');
      const gmPath = require.resolve('../gallery-main');
      delete require.cache[gmPath];
      const gm = require('../gallery-main');
      delete require.cache[gmPath];
      const dir = path.join(env.tmp, 'tags-manage');
      const P = { root: path.resolve(dir, 'photos'), ud: path.join(dir, 'ud'), logDir: path.join(dir, 'logs') };
      fs.mkdirSync(P.root, { recursive: true });
      fs.mkdirSync(P.ud, { recursive: true });
      const names = ['a.jpg', 'b.mp4', 'c.jpg'];
      const fileRows = () => names.map((name) => row({
        root: P.root, path: path.join(P.root, name), name, mediaType: name.endsWith('.mp4') ? 'video' : 'photo',
        tags: name === 'c.jpg' ? [{ name: '바다', source: 'album' }] : [],
      }));
      for (const n of names) fs.writeFileSync(path.join(P.root, n), `파일 ${n}`);
      const bytes = () => names.map((n) => fs.readFileSync(path.join(P.root, n), 'utf8')).join('|');
      const before = bytes();
      const withDb = (fn) => {
        const o = openDb(path.join(P.ud, 'library.db'));
        try {
          return fn(o.db);
        } finally {
          o.db.close();
        }
      };
      withDb((db) => db.upsertFiles(fileRows()));
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
      const idOf = (db, name) => db.listSuggestionRows(P.root).find((x) => x.name === name).id;
      const mineOf = (name) => withDb((db) => db.getManualTags(path.join(P.root, name)));
      const listMine = async (call) => JSON.stringify((await call('gallery:tag-list')).manual);
      const journalLines = () => createJournal(path.join(P.ud, 'manual-edits.jsonl')).read();
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
        const ids = withDb((db) => ({ a: idOf(db, 'a.jpg'), b: idOf(db, 'b.mp4'), c: idOf(db, 'c.jpg') }));
        let call = makeFake();

        await scene('57c', async () => {
          // 57c 빈 태그 만들기: 0장으로 목록에 남음, 같은 이름 · 종류 태그 이름은 거절, 기록 파일에 태그 목록 줄과 로그
          const r = await call('gallery:tag-create', '  가족 ');
          const dup = await errOf(() => call('gallery:tag-create', '가족'));
          const reserved = await errOf(() => call('gallery:tag-create', '비디오'));
          const st = await call('gallery:get-state');
          const j = journalLines().lines;
          out.push(sub('57c 새 태그 "가족" 은 0장으로 목록 · 사이드바에 남고 태그 수에 셈. 같은 이름 · 종류 태그는 거절. 기록 파일에 태그 목록 줄, 로그에 태그 만들기',
            r.name === '가족' && (await listMine(call)) === '[{"name":"가족","count":0,"hotkey":null}]' && st.tagCount === 2
            && JSON.stringify(st.manualTags) === '[{"name":"가족","count":0,"hotkey":null}]' && !!dup && dup.includes('이미') && !!reserved
            && j.length === 1 && j[0].type === 'tagDefs' && JSON.stringify(j[0].defs) === '[{"name":"가족","hotkey":null}]' && logsOf('manual-edit').includes('태그 만들기'),
            JSON.stringify([r, dup, reserved, st.manualTags, j])));

          // 57d 폴더를 다시 읽어도, 프로그램을 다시 켜도 빈 태그가 남음
          withDb((db) => db.upsertFiles(fileRows()));
          for (const g of fakes.splice(0)) g.close();
          call = makeFake();
          out.push(sub('57d 폴더를 다시 읽고 프로그램을 다시 켜도 빈 태그가 그대로', (await listMine(call)) === '[{"name":"가족","count":0,"hotkey":null}]', await listMine(call)));
        });

        await scene('57e', async () => {
          // 57e 단축키 숫자: 정하기, 다른 태그로 옮기면 앞 태그는 숫자가 빠짐, 0 · 10 · 앨범 태그는 거절
          await call('gallery:tag-apply', [ids.a, ids.b], { op: 'add', name: '여행' }); // 사진과 영상에 '여행'
          const k1 = await call('gallery:tag-hotkey', '가족', 1);
          const k2 = await call('gallery:tag-hotkey', '여행', 1);
          const k3 = await call('gallery:tag-hotkey', '가족', 2);
          const bad = await errOf(() => call('gallery:tag-hotkey', '가족', 10));
          const album = await errOf(() => call('gallery:tag-hotkey', '바다', 3));
          const list = JSON.parse(await listMine(call));
          out.push(sub('57e 숫자 1을 "여행"으로 옮기면 "가족"은 숫자가 빠짐, 10 과 앨범 태그(읽기 전용)는 거절',
            k1.moved === null && k2.moved === '가족' && k3.hotkey === 2 && !!bad && !!album && album.includes('읽기 전용')
            && list.find((t) => t.name === '여행').hotkey === 1 && list.find((t) => t.name === '가족').hotkey === 2 && list.find((t) => t.name === '여행').count === 2,
            JSON.stringify([k1, k2, k3, bad, album, list])));
        });

        await scene('57f', async () => {
          // 57f 이름 바꾸기: 사진 · 영상 모두 새 이름, 숫자도 옮겨감, 되돌리면 옛 이름과 숫자로
          const pv = await call('gallery:tag-rename-preview', '여행', '휴가');
          const r = await call('gallery:tag-rename', '여행', ' 휴가 ', false);
          const aFile = await call('gallery:get-file', ids.a);
          const bFile = await call('gallery:get-file', ids.b);
          const list = JSON.parse(await listMine(call));
          const last = journalLines().lines.filter((l) => l.type === 'apply').pop();
          const st = await call('gallery:get-state');
          const u = await call('gallery:undo-last', st.lastBatch.id);
          const back = JSON.parse(await listMine(call));
          out.push(sub('57f 이름 바꾸기: 사진과 영상 모두 "휴가", 숫자 1도 옮겨감, 기록 파일에 tagRename(정의 전후), 되돌리면 "여행"과 숫자 1로 돌아오고 "휴가"는 사라짐',
            pv.merge === false && pv.count === 2 && r.count === 2 && r.kind === 'tagRename' && r.name === '휴가'
            && aFile.tags.some((t) => t.name === '휴가' && t.source === 'manual') && bFile.tags.some((t) => t.name === '휴가') && !aFile.tags.some((t) => t.name === '여행')
            && list.find((t) => t.name === '휴가').hotkey === 1 && !list.some((t) => t.name === '여행')
            && last.kind === 'tagRename' && Array.isArray(last.defs) && last.defs.length === 2
            && u.kind === 'tagRename' && back.find((t) => t.name === '여행').hotkey === 1 && back.find((t) => t.name === '여행').count === 2 && !back.some((t) => t.name === '휴가')
            && JSON.stringify(mineOf('a.jpg')) === '["여행"]',
            JSON.stringify([pv, r, list, back])));
        });

        await scene('57g', async () => {
          // 57g 합치기: 같은 이름이 있으면 묻지 않고는 거절, 합치면 겹친 사진은 이름 하나, 합친 쪽 숫자는 남음
          await call('gallery:tag-apply', [ids.a], { op: 'add', name: '가족' }); // a: 가족, 여행 / b: 여행
          const refuse = await errOf(() => call('gallery:tag-rename', '여행', '가족', false));
          const pv = await call('gallery:tag-rename-preview', '여행', '가족');
          const r = await call('gallery:tag-rename', '여행', '가족', true);
          const list = JSON.parse(await listMine(call));
          out.push(sub('57g 합치기: 확인 없이는 거절, 미리보기는 merge, 합치면 a 는 "가족" 하나 · b 는 "가족", "여행"은 목록에서 빠지고 "가족"의 숫자 2는 그대로',
            !!refuse && refuse.includes('합칠지') && pv.merge === true && pv.toCount === 1 && r.count === 2
            && JSON.stringify(mineOf('a.jpg')) === '["가족"]' && JSON.stringify(mineOf('b.mp4')) === '["가족"]'
            && !list.some((t) => t.name === '여행') && list.find((t) => t.name === '가족').hotkey === 2 && list.find((t) => t.name === '가족').count === 2,
            JSON.stringify([refuse, pv, r, list])));
        });

        await scene('57h', async () => {
          // 57h 지우기: 태그만 떼고 파일은 그대로, 앨범 태그는 지울 수 없음, 되돌리면 태그와 숫자가 돌아옴. 사진이 없는 태그는 묶음 없이 지움
          const album = await errOf(() => call('gallery:tag-delete', '바다'));
          const r = await call('gallery:tag-delete', '가족');
          const gone = { a: mineOf('a.jpg'), b: mineOf('b.mp4'), list: JSON.parse(await listMine(call)) };
          const filter = await call('gallery:list-ids', { tag: '가족' });
          const st = await call('gallery:get-state');
          const u = await call('gallery:undo-last', st.lastBatch.id);
          const back = JSON.parse(await listMine(call));
          await call('gallery:tag-create', '빈태그');
          const lastBefore = (await call('gallery:get-state')).lastBatch;
          const linesBefore = journalLines().lines.filter((l) => l.type === 'apply').length;
          const e0 = await call('gallery:tag-delete', '빈태그');
          const linesAfter = journalLines().lines.filter((l) => l.type === 'apply').length;
          const st2 = await call('gallery:get-state');
          out.push(sub('57h 지우기: 2장(사진 · 영상)에서 떼고 목록 · 필터에서 빠짐, 앨범 태그는 거절, 되돌리면 "가족" 2장과 숫자 2가 돌아옴. 빈 태그 지우기는 되돌리기 줄을 차지하지 않음',
            !!album && album.includes('읽기 전용') && r.count === 2 && r.kind === 'tagDelete' && gone.a.length === 0 && gone.b.length === 0
            && !gone.list.some((t) => t.name === '가족') && filter.length === 0 && u.kind === 'tagDelete'
            && back.find((t) => t.name === '가족').count === 2 && back.find((t) => t.name === '가족').hotkey === 2
            && e0.batchId === null && e0.count === 0 && linesBefore === linesAfter && !!lastBefore && st2.lastBatch && st2.lastBatch.id === lastBefore.id && !JSON.parse(await listMine(call)).some((t) => t.name === '빈태그'),
            JSON.stringify([album, r, gone, u, back, e0, st2.lastBatch])));
        });

        await scene('57i', async () => {
          // 57i 새 이름으로 붙인 뒤 되돌리면 그 빈 태그도 같이 사라짐 (오타로 만든 태그가 남지 않게). 있던 태그는 붙인 사진을 다 떼도 남음
          const r = await call('gallery:tag-apply', [ids.c], { op: 'add', name: '오타태그' });
          const mid = JSON.parse(await listMine(call)).some((t) => t.name === '오타태그');
          await call('gallery:undo-last', r.batchId);
          const after = JSON.parse(await listMine(call)).some((t) => t.name === '오타태그');
          const rm = await call('gallery:tag-apply', [ids.a, ids.b], { op: 'remove', name: '가족' });
          const kept = JSON.parse(await listMine(call)).find((t) => t.name === '가족');
          out.push(sub('57i 새 이름으로 붙였다 되돌리면 그 태그도 사라짐, 있던 "가족"은 사진을 다 떼도 0장 · 숫자 2로 남음',
            mid && !after && rm.count === 2 && kept && kept.count === 0 && kept.hotkey === 2, JSON.stringify([mid, after, rm, kept])));
          await call('gallery:undo-last', rm.batchId); // 다시 붙여 둠 (57j 복구 확인용)
        });

        await scene('57g2', async () => {
          // 57g2 숫자 있는 태그를 숫자 없는 태그로 합쳤다가 되돌리면 숫자가 원래 태그로 돌아옴 (#122 검증 ❌)
          await call('gallery:tag-apply', [ids.b], { op: 'add', name: '빨강' });
          await call('gallery:tag-apply', [ids.b], { op: 'add', name: '파랑' });
          await call('gallery:tag-hotkey', '빨강', 7);
          const m = await call('gallery:tag-rename', '빨강', '파랑', true);
          const mid = JSON.parse(await listMine(call)).find((t) => t.name === '파랑');
          await call('gallery:undo-last', m.batchId);
          const back = JSON.parse(await listMine(call));
          const red = back.find((t) => t.name === '빨강');
          const blue = back.find((t) => t.name === '파랑');
          out.push(sub('57g2 숫자 7 인 "빨강"을 숫자 없는 "파랑"에 합치면 파랑이 7, 되돌리면 빨강 7 · 파랑 없음',
            mid && mid.hotkey === 7 && red && red.hotkey === 7 && blue && blue.hotkey === null,
            JSON.stringify([mid, red, blue])));
        });

        await scene('57j', async () => {
          // 묶음으로 생긴 태그를 0장으로 만든 뒤 지우거나(엑스) 이름을 바꾼(와이 → 제트) 경우도 DB 를 새로 만들 때 되살아나지 않아야 해요 (#122 검증 ❌)
          for (const n of ['엑스', '와이']) {
            await call('gallery:tag-apply', [ids.b], { op: 'add', name: n });
            await call('gallery:tag-apply', [ids.b], { op: 'remove', name: n });
          }
          await call('gallery:tag-delete', '엑스');
          await call('gallery:tag-rename', '와이', '제트', false);
          await call('gallery:tag-hotkey', '제트', 6);
          // 57j DB를 새로 만들어도 기록 파일에서 태그 · 이름 바꾸기 · 합치기 · 지우기 · 되돌리기와 빈 태그 · 숫자가 되살아남. 지운 빈 태그는 안 살아남
          await call('gallery:tag-create', '나중에');
          await call('gallery:tag-hotkey', '나중에', 5);
          const want = { list: await listMine(call), a: mineOf('a.jpg'), b: mineOf('b.mp4') };
          for (const g of fakes.splice(0)) g.close();
          const dbFile = path.join(P.ud, 'library.db');
          for (const ext of ['', '-wal', '-shm']) {
            if (fs.existsSync(dbFile + ext)) fs.rmSync(dbFile + ext); // 점검 임시 폴더 안의 DB
          }
          call = makeFake(); // 빈 DB 에서 기록 파일로 복구
          withDb((db) => db.upsertFiles(fileRows())); // 그다음 폴더 읽기
          const got = { list: await listMine(call), a: mineOf('a.jpg'), b: mineOf('b.mp4') };
          const startLog = logsOf('gallery-start');
          const read = journalLines();
          out.push(sub('57j DB를 새로 만들어도 기록 파일로 태그 목록(빈 태그 "나중에" 숫자 5, "가족" 2장 숫자 2)이 그대로, 지운 빈 태그 · 0장으로 지우거나 이름을 바꾼 태그는 안 살아남, 건너뛴 줄 없음',
            got.list === want.list && JSON.stringify(got.a) === JSON.stringify(want.a) && JSON.stringify(got.b) === JSON.stringify(want.b)
            && got.list.includes('"name":"나중에","count":0,"hotkey":5') && !got.list.includes('빈태그') && !got.list.includes('오타태그')
            && !got.list.includes('엑스') && !got.list.includes('와이') && got.list.includes('"name":"제트","count":0,"hotkey":6')
            && read.skipped === 0 && !startLog.includes('건너뜀:'),
            JSON.stringify([want, got, read.skipped, startLog.slice(-300)])));
        });

        await scene('57k', async () => {
          // 57k 옛 DB: 이 기능 전에 붙인 태그(정의 없음)는 켤 때 목록에 채워져 바꿀 수 있음. 사진 파일은 처음 그대로
          const { DatabaseSync } = require('node:sqlite');
          for (const g of fakes.splice(0)) g.close();
          const raw = new DatabaseSync(path.join(P.ud, 'library.db'));
          raw.exec("INSERT INTO manual_tags (path, root, name) VALUES ('" + path.join(P.root, 'c.jpg').replace(/'/g, "''") + "', '" + P.root.replace(/'/g, "''") + "', '옛태그')");
          raw.exec("DELETE FROM tag_names WHERE name = '옛태그'");
          raw.close();
          call = makeFake();
          const list = JSON.parse(await listMine(call));
          const r = await call('gallery:tag-rename', '옛태그', '새태그', false);
          out.push(sub('57k 옛 DB 의 정의 없는 태그도 켤 때 목록에 채워지고(시작 로그) 이름을 바꿀 수 있음, 사진 · 영상 파일은 처음 그대로',
            list.some((t) => t.name === '옛태그' && t.count === 1) && r.count === 1 && JSON.stringify(mineOf('c.jpg')) === '["새태그"]'
            && logsOf('gallery-start').includes('태그 목록에 채웠어요') && bytes() === before,
            JSON.stringify([list, r])));
        });
      } finally {
        for (const g of fakes) {
          try {
            g.close();
          } catch (e) { /* 이미 닫힘 */ }
        }
      }

      // 57l 화면 글과 연결 (빌드 전 원본 글자로 확인)
      {
        const F = await import('../src/format.mjs');
        const texts = [F.appliedText(3, 'tagAdd', '여행'), F.appliedText(2, 'tagDelete', '여행'), F.appliedText(2, 'tagRename', '휴가'),
          F.undoLabel(2, 'tagDelete'), F.undoneText(2, 'tagRename'), F.appliedText(3, 'tagAdd')];
        const want = ["3장에 '여행' 붙였어요", "2장에서 '여행' 태그를 지웠어요", "2장의 태그를 '휴가' 이름으로 바꿨어요", '2장 태그 지우기 되돌리기', '2장 태그 이름 바꾸기를 되돌렸어요', '3장에 태그를 붙였어요'];
        const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
        const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
        const wired = src('components/Sidebar.jsx').includes('onNewTag') && src('components/TagsView.jsx').includes('이름 바꾸기')
          && src('components/TagsView.jsx').includes('<select') && src('components/ContextMenu.jsx').includes('quickTagLabel')
          && src('App.jsx').includes('tagKeyAction(') && src('App.jsx').includes('<TagManageDialog') && src('components/DetailPanel.jsx').includes('data-key="T"')
          && ['gallery:tag-create', 'gallery:tag-hotkey', 'gallery:tag-rename-preview', 'gallery:tag-rename', 'gallery:tag-delete'].every((c) => pre.includes(`'${c}'`));
        out.push(sub('57l 알림 글 ("3장에 \'여행\' 붙였어요" 등)과 화면 연결 (새 태그 버튼, 숫자 고르기, 우클릭 바로 붙이기, 단축키, preload 다섯 통로)',
          JSON.stringify(texts) === JSON.stringify(want) && wired, JSON.stringify(texts)));
      }
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
  const applied = await wait(() => byText('.banner', '붙였어요'));
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
  const removed = await wait(() => byText('.banner', '뗐어요'));
  q.removed = removed ? removed.querySelector('strong').innerText : '';

  // ---------- 2026-11-18: 새 태그 만들기, 숫자 정하기, 단축키(T, 숫자), 이름 바꾸기, 지우기 · 되돌리기 ----------
  const setVal = (el, v) => {
    const sel = el.tagName === 'SELECT';
    Object.getOwnPropertyDescriptor(sel ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event(sel ? 'change' : 'input', { bubbles: true }));
  };
  const press = (code, key) => document.dispatchEvent(new KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true }));
  const bannerText = (text) => {
    const b = byText('.banner', text);
    return b ? b.querySelector('strong').innerText : '';
  };
  const flat = (el) => (el ? el.innerText.replace(/\s+/g, '') : '');
  const sideRow = (name) => [...document.querySelectorAll('.side .tag-row')].find((b) => b.querySelector('.menu-label').innerText === name);
  const manageRow = (name) => [...document.querySelectorAll('.tag-manage-row')].find((r) => r.querySelector('.menu-label').innerText === name);

  // 새 태그 (왼쪽 메뉴)
  const newBtn = await wait(() => document.querySelector('.side .side-new'));
  if (!newBtn) return { ...q, stop: '새 태그 버튼이 없어요' };
  newBtn.click();
  const md = await wait(() => document.querySelector('.tag-manage'));
  if (!md) return { ...q, stop: '새 태그 창이 없어요' };
  const mfoot = () => document.querySelector('.tag-manage .dialog-foot button.primary');
  q.createStart = mfoot().innerText;
  setVal(md.querySelector('input.tag-input'), '가족');
  await wait(() => mfoot().innerText.includes('가족'));
  q.createButton = mfoot().innerText;
  mfoot().click();
  q.sideNew = flat(await wait(() => sideRow('가족')));

  // 태그 화면에서 숫자 1
  byText('.menu button.menu-row', '태그').click();
  const row = await wait(() => manageRow('가족'));
  if (!row) return { ...q, stop: '태그 화면에 가족 줄이 없어요' };
  setVal(row.querySelector('select'), '1');
  const key = await wait(() => { const r = sideRow('가족'); return r && r.querySelector('.tag-key'); });
  q.sideKey = key ? key.innerText : '';

  // 갤러리: 사진 하나 고르고 T, 검색 칸에서 1, 그다음 1
  byText('.menu button.menu-row', '갤러리').click();
  const cell2 = await wait(() => document.querySelector('button.cell'));
  if (!cell2) return { ...q, stop: '갤러리 칸이 없어요' };
  cell2.click();
  await wait(() => document.querySelector('button.cell.selected'));
  cell2.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
  const qm = await wait(() => document.querySelector('.context-menu button.quick-tag'));
  q.quickMenu = qm ? qm.innerText : '';
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(() => !document.querySelector('.context-menu'));
  cell2.focus();
  press('KeyT', 't');
  const td = await wait(() => document.querySelector('.tag-dialog:not(.tag-manage)'), 5000);
  q.tKey = !!td;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(() => !document.querySelector('.tag-dialog'));
  const search = document.querySelector('.search input');
  if (search) {
    search.focus();
    press('Digit1', '1');
    await new Promise((res) => setTimeout(res, 800));
    q.typingIgnored = !bannerText("'가족' 붙였어요");
    search.blur();
  }
  press('Digit1', '1');
  await wait(() => bannerText("'가족' 붙였어요"));
  q.quick = bannerText("'가족' 붙였어요");
  const qb = byText('.banner', "'가족' 붙였어요");
  q.quickUndo = qb ? (qb.querySelector('button') || {}).innerText : '';

  // 이름 바꾸기 → 지우기 → 되돌리기 (태그 화면)
  byText('.menu button.menu-row', '태그').click();
  const row2 = await wait(() => manageRow('가족'));
  if (!row2) return { ...q, stop: '태그 화면에 가족 줄이 없어요 (두 번째)' };
  [...row2.querySelectorAll('.link-button')].find((b) => b.innerText === '이름 바꾸기').click();
  const rd2 = await wait(() => document.querySelector('.tag-manage'));
  if (!rd2) return { ...q, stop: '이름 바꾸기 창이 없어요' };
  setVal(rd2.querySelector('input.tag-input'), '친구');
  q.renameButton = mfoot().innerText;
  mfoot().click();
  await wait(() => bannerText("'친구' 이름으로"));
  q.renamed = bannerText("'친구' 이름으로");
  const row3 = await wait(() => manageRow('친구'));
  if (!row3) return { ...q, stop: '바꾼 이름 줄이 없어요' };
  [...row3.querySelectorAll('.link-button')].find((b) => b.innerText === '지우기').click();
  await wait(() => document.querySelector('.tag-manage'));
  q.deleteButton = mfoot().innerText;
  mfoot().click();
  await wait(() => bannerText("'친구' 태그를 지웠어요"));
  q.deleted = bannerText("'친구' 태그를 지웠어요");
  const db2 = byText('.banner', "'친구' 태그를 지웠어요");
  const undoBtn = db2 && db2.querySelector('button');
  q.deleteUndo = undoBtn ? undoBtn.innerText : '';
  if (undoBtn) {
    await wait(() => !undoBtn.disabled);
    undoBtn.click();
    q.undone = !!(await wait(() => bannerText('태그 지우기를 되돌렸어요')));
    const back = await wait(() => { const r = sideRow('친구'); return r && r.querySelector('.tag-key') ? r : null; });
    q.backKey = back ? `${back.querySelector('.menu-label').innerText}${back.querySelector('.tag-key').innerText}` : '';
  }
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

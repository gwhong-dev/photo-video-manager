// 파일 위치: scripts/check-import-screening.js
// 역할: 가져오기 전 비슷한 사진 거르기 + 가져올 때 태그 한 번에 점검 (60). scripts/check.js 의 ITEMS 끝에 붙어요
//   설계: docs/superpowers/specs/2026-11-18-import-screening-design.md (5절 점검)
//   ⚠️ 진짜 휴지통 · 진짜 사진은 쓰지 않아요. 임시 폴더의 가짜 파일로만 옮겨 봐요 (휴지통 대신 임시 "가짜 휴지통" 폴더로 옮김)
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const { sub, row } = require('./check-gallery');

const errOf = (fn) => Promise.resolve().then(fn).then(() => null, (e) => e.message);
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const items = [
  {
    no: 60,
    name: '가져오기 전 거르기 + 가져올 때 태그',
    async run(env) {
      const out = [];
      const S = require('../lib/import-screening');
      const base = path.join(env.tmp, 'import-screening');
      fs.mkdirSync(base, { recursive: true });

      // 60a 태그 이름: 기본값 = 가져올 폴더 이름, 규칙에 안 맞으면 '' / 실행 때 이름 다듬기 · 거절
      {
        const long = 'ㄱ'.repeat(41);
        const ok = S.defaultTagName(path.join(base, '에버랜드에서 찍은  삼성라이온즈')) === '에버랜드에서 찍은 삼성라이온즈'
          && S.defaultTagName(path.join(base, long)) === '' && S.defaultTagName(path.join(base, '사진')) === '' && S.defaultTagName('') === ''
          && S.importTagOf(null) === null && S.importTagOf('') === null && S.importTagOf(undefined) === null && S.importTagOf('  무제 ') === '무제';
        const bad = await errOf(() => S.importTagOf('비디오'));
        const bad2 = await errOf(() => S.importTagOf(long));
        out.push(sub('60a 기본 태그 이름 = 가져올 폴더 이름(띄어쓰기 맞춤), 41자 · 종류 태그 이름이면 빈칸. 실행 때 태그는 다듬고, 규칙에 안 맞으면 거절',
          ok && !!bad && !!bad2, JSON.stringify([S.defaultTagName(path.join(base, '에버랜드에서 찍은  삼성라이온즈')), bad, bad2])));
      }

      // 60b 진행 중인 작업과 같은 폴더(같음 · 안쪽 · 바깥쪽)면 거를 수 없음
      {
        const a = path.join(base, 'jobsrc');
        const inner = path.join(a, 'inner');
        const other = path.join(base, 'other');
        for (const d of [inner, other]) fs.mkdirSync(d, { recursive: true });
        out.push(sub('60b 진행 중인 작업의 가져올 폴더와 같거나 안쪽 · 바깥쪽이면 거르기 거부, 다른 폴더 · 작업 없음은 허용',
          S.screenConflict(a, a) && S.screenConflict(a, inner) && S.screenConflict(inner, a) && !S.screenConflict(a, other) && !S.screenConflict(null, a),
          ''));
      }

      // 60c 태그 대상: 이번 회차 done 결과 + dup 남는 파일, 첫 회차면 미리보기 때부터 중복이던 것도. 확인 필요 · 실패 · 대기 · 백업 밖은 빼요
      {
        const B = path.join(base, 'lib');
        const job = {
          backupRoot: B,
          items: [
            { i: 0, status: 'done', finalPath: path.join(B, '2026', 'a.jpg') },
            { i: 1, status: 'dup', finalPath: path.join(B, '2026', 'b.jpg') }, // 실행 직전 확인에서 중복 (이미 있던 파일)
            { i: 2, status: 'fail' },
            { i: 3, status: 'todo' },
            { i: 4, status: 'done', finalPath: path.join(base, 'outside', 'x.jpg') }, // 백업 밖
            { i: 5, status: 'dup', dupOf: path.join(B, '2025', 'old.jpg') }, // 미리보기 때부터 중복 (이미 있던 파일)
            { i: 6, status: 'dup', dupOf: path.join(B, '2025', 'similar.jpg'), check: true }, // 비슷한 다른 버전 (확인 필요)
            { i: 7, status: 'dup', dupOfItem: 0 }, // 같은 회차 원본끼리 같음 → 0 의 결과 파일 (겹치니 한 번만)
            { i: 8, status: 'skip' },
          ],
        };
        const batch = job.items.slice(0, 5);
        const first = S.tagTargets(job, batch, { withPlanDups: true }).map((p) => path.relative(B, p));
        const later = S.tagTargets(job, batch, { withPlanDups: false }).map((p) => path.relative(B, p));
        const fresh = { backupRoot: B, items: [{ i: 0, status: 'todo' }, { i: 1, status: 'dup', dupOf: 'x' }] };
        out.push(sub('60c 태그 대상: 첫 회차는 완료 결과 + 중복의 남는 파일 + 미리보기 때부터 중복, 다음 회차는 그 회차 것만. 확인 필요 · 실패 · 대기 · 이미 정리됨 · 백업 밖은 빼고 겹치면 한 번',
          JSON.stringify(first) === JSON.stringify([path.join('2026', 'a.jpg'), path.join('2026', 'b.jpg'), path.join('2025', 'old.jpg')])
            && JSON.stringify(later) === JSON.stringify([path.join('2026', 'a.jpg'), path.join('2026', 'b.jpg')])
            && S.isFirstRun(fresh) && !S.isFirstRun(job),
          JSON.stringify({ first, later })));
      }

      // 60d~ 가짜 setupGallery: 거르기 모드, 막기, 휴지통으로 거르기, 태그 붙이기
      const { openDb } = require('../lib/db');
      const { createLogger } = require('../lib/logger');
      const gmPath = require.resolve('../gallery-main');
      delete require.cache[gmPath];
      const gm = require('../gallery-main');
      delete require.cache[gmPath];
      const P = {
        lib: path.resolve(base, 'backup'),
        src: path.resolve(base, '무제'),
        ud: path.join(base, 'ud'),
        logDir: path.join(base, 'logs'),
        bin: path.join(base, 'fake-bin'),
      };
      for (const d of [P.lib, P.src, P.ud, P.bin]) fs.mkdirSync(d, { recursive: true });
      // 실제 파일 + DB 줄 (크기 · 수정 시각을 파일과 맞춰야 옮기기 전 확인을 통과해요)
      const put = (root, name, text, over = {}) => {
        const p = path.join(root, name);
        fs.writeFileSync(p, text);
        const st = fs.statSync(p);
        return row({ root, path: p, name, size: st.size, mtimeMs: st.mtimeMs, ...over });
      };
      const libRows = [put(P.lib, 'L1.jpg', 'lib one'), put(P.lib, 'L2.jpg', 'lib two'), put(P.lib, 'L3.jpg', 'lib three')];
      const srcRows = [
        put(P.src, 'S1.jpg', 'src one'),
        put(P.src, 'S2.jpg', 'src two', { takenAt: '2026-11-17T18:00:00', takenDay: '2026-11-17' }),
        put(P.src, 'S2.mov', 'src two video', { mediaType: 'video', takenAt: '2026-11-17T18:00:01', takenDay: '2026-11-17', durationSec: 2 }), // 라이브 포토 짝
        put(P.src, 'S3.jpg', 'src three'),
      ];
      const withDb = (fn) => {
        const o = openDb(path.join(P.ud, 'library.db'));
        try {
          return fn(o.db);
        } finally {
          o.db.close();
        }
      };
      withDb((db) => db.upsertFiles([...libRows, ...srcRows]));
      const settings = { backupRoot: P.lib, source: P.src };
      const settingsBefore = JSON.stringify(settings);
      const handlers = new Map();
      const bin = [];
      const g = gm.setupGallery({
        ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
        protocol: { handle() {} },
        getWin: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
        getSettings: () => settings,
        getTools: () => ({}),
        getEt: () => null,
        isRunning: () => false,
        isPlanning: () => false,
        logger: createLogger(P.logDir),
        userDir: P.ud,
        loadScreen: async () => {},
        getJobPending: () => false,
        // 점검에서는 진짜 휴지통 대신 임시 "가짜 휴지통" 폴더로 옮겨요
        trash: async (p) => {
          const to = path.join(P.bin, `${bin.length}-${path.basename(p)}`);
          fs.renameSync(p, to);
          bin.push(p);
        },
        makeDriveKindOf: () => Object.assign(async () => 'fixed', { recycleOf: async () => null }),
      });
      const call = (ch, ...a) => handlers.get(ch)(null, ...a);
      const idOf = (root, name) => withDb((db) => db.listIds(root, { tab: 'all', sort: 'newest', query: '', tag: null }).map((id) => db.getFile(id)).find((f) => f.name === name).id);
      const logsOf = (prefix) => (fs.existsSync(P.logDir) ? fs.readdirSync(P.logDir) : []).filter((n) => n.startsWith(prefix));
      const scene = async (label, fn) => {
        try {
          await fn();
        } catch (e) {
          out.push(sub(`${label} 실행 중 오류`, false, String(e.stack).split('\n').slice(0, 3).join(' | ')));
        }
      };

      try {
        const ids = {
          L1: idOf(P.lib, 'L1.jpg'), L2: idOf(P.lib, 'L2.jpg'), L3: idOf(P.lib, 'L3.jpg'),
          S1: idOf(P.src, 'S1.jpg'), S2: idOf(P.src, 'S2.jpg'), S2v: idOf(P.src, 'S2.mov'), S3: idOf(P.src, 'S3.jpg'),
        };
        // 거르기 전에 라이브러리 쪽 "모두 남기기" 기억 하나 (거르기의 "다시 보기"가 이것을 지우면 안 돼요)
        await call('gallery:similar-keep-all', [ids.L1]);

        await scene('60d', async () => {
          // 60d 거르기를 시작하면 갤러리가 가져올 폴더를 보고(이름만), 끝내면 백업 폴더로. 설정 파일 값은 그대로
          const before = await call('gallery:get-state');
          const started = g.startScreening(P.src);
          const during = await call('gallery:get-state');
          const listed = (await call('gallery:list-ids', {})).sort((a, b) => a - b);
          const note0 = g.takeScreenNotice();
          const ended = g.endScreening();
          const after = await call('gallery:get-state');
          const again = g.endScreening(); // 두 번 끝내도 아무 일 없음
          const note1 = g.takeScreenNotice();
          const note2 = g.takeScreenNotice();
          out.push(sub('60d 거르기 시작: 갤러리 root = 가져올 폴더, 화면에는 폴더 이름만 · 그 폴더 사진만 / 끝내면 백업 폴더로, 결과는 한 번만, 설정의 백업 폴더 그대로',
            before.root === P.lib && before.screening === null && started.name === '무제'
              && during.root === P.src && during.screening && during.screening.name === '무제' && !JSON.stringify(during.screening).includes(base)
              && JSON.stringify(listed) === JSON.stringify([ids.S1, ids.S2, ids.S2v, ids.S3].sort((a, b) => a - b)) && during.total === 4 && note0 === null
              && ended && ended.removed === 0 && after.root === P.lib && after.screening === null && again === null
              && note1 && note1.name === '무제' && note2 === null && JSON.stringify(settings) === settingsBefore,
            JSON.stringify({ before: before.root, during: during.root, screening: during.screening, listed, after: after.root, note1 })));
        });

        await scene('60e', async () => {
          // 60e 거르기 중에는 날짜 · 위치 · 태그 · 날짜없음 채우기 · 위치 제안 · 되돌리기 · 지도 · 정리 기록을 막고, 비슷한 사진 · 바로 지우기는 돼요
          g.startScreening(P.src);
          const blocked = {
            previewEdit: await errOf(() => call('gallery:preview-edit', [ids.S1], { source: 'direct', date: true, value: { date: '2026-01-01' } })),
            applyEdit: await errOf(() => call('gallery:apply-edit', [ids.S1], { source: 'direct', date: true, value: { date: '2026-01-01' } })),
            tagApply: await errOf(() => call('gallery:tag-apply', [ids.S1], { op: 'add', name: '여행' })),
            tagCreate: await errOf(() => call('gallery:tag-create', '여행')),
            tagList: await errOf(() => call('gallery:tag-list')),
            fill: await errOf(() => call('gallery:fill-preview')),
            suggest: await errOf(() => call('gallery:list-suggestions')),
            undo: await errOf(() => call('gallery:undo-last', 'x')),
            map: await errOf(() => call('gallery:map-points')),
            clean: await errOf(() => call('gallery:clean-history')),
          };
          const allBlocked = Object.values(blocked).every((m) => m && m.includes('거르기'));
          const preview = await call('gallery:trash-preview', [ids.S1]);
          const libPreview = await errOf(() => call('gallery:trash-preview', [ids.L1])); // 라이브러리 사진은 거르기 중에 못 골라요
          out.push(sub('60e 거르기 중: 날짜 · 위치 넣기, 태그, 날짜없음 채우기, 위치 제안, 되돌리기, 지도, 정리 기록은 거절 / 휴지통 미리보기는 거르기 폴더 사진만',
            allBlocked && preview.count === 1 && !!libPreview,
            JSON.stringify({ blocked, preview: preview.count, libPreview })));
        });

        await scene('60f', async () => {
          // 60f 거르기 중 휴지통으로: 가져올 폴더 사진만 옮김(라이브 포토 짝 영상도 같이), 라이브러리 파일은 그대로, 로그 이름 screen-discard, 끝낼 때 장수
          const r = await call('gallery:trash-selected', [ids.S1, ids.S2]);
          const lib = await errOf(() => call('gallery:trash-selected', [ids.L2]));
          const libFiles = libRows.every((x) => fs.existsSync(x.path));
          const srcLeft = fs.readdirSync(P.src).sort();
          // "모두 남기기": 거르기 폴더 사진을 남기고, "다시 보기"로 비워도 라이브러리 쪽 기억은 그대로
          await call('gallery:similar-keep-all', [ids.S3]);
          const keepsMid = JSON.stringify(JSON.parse(fs.readFileSync(path.join(P.ud, 'similar-keeps.json'), 'utf8')));
          await call('gallery:similar-clear-keeps');
          const keepsText = fs.readFileSync(path.join(P.ud, 'similar-keeps.json'), 'utf8');
          const st = await call('gallery:get-state');
          const ended = g.endScreening();
          out.push(sub('60f 거르기 중 휴지통으로: 가져올 폴더 사진 2장 + 라이브 포토 짝 영상, 라이브러리 사진은 거절되고 파일 그대로, 로그는 screen-discard, 끝낼 때 2장으로 셈',
            r.trashed === 2 && r.pairs === 1 && r.fail === 0 && bin.length === 3 && !!lib && libFiles
              && JSON.stringify(srcLeft) === JSON.stringify(['S3.jpg']) && st.total === 1
              && logsOf('screen-discard').length === 1 && logsOf('similar-discard').length === 0 && logsOf('gallery-trash').length === 0
              && ended && ended.removed === 2,
            JSON.stringify({ r: { trashed: r.trashed, pairs: r.pairs, fail: r.fail }, lib, srcLeft, total: st.total, logs: fs.readdirSync(P.logDir), ended })));
          out.push(sub('60f 거르기에서 "다시 보기"는 거르기 폴더에서 남긴 기억만 비움 (라이브러리 사진의 "모두 남기기" 기억은 그대로)',
            keepsMid.includes('S3.jpg') && keepsMid.includes('L1.jpg') && keepsText.includes('L1.jpg') && !keepsText.includes('S3.jpg'),
            keepsText.slice(0, 300)));
        });

        await scene('60g', async () => {
          // 60g 가져올 때 태그: 백업 폴더 안 · DB 에 있는 사진에만, 이미 붙은 사진은 그대로, 대소문자 다른 경로도 같은 사진, 되돌리면 모두 떨어지고 새 태그 정의도 사라짐
          await call('gallery:tag-apply', [ids.L2], { op: 'add', name: '에버랜드' }); // L2 는 이미 붙어 있음
          const undoFirst = await call('gallery:get-state');
          const paths = [
            path.join(P.lib, 'L1.jpg').toUpperCase(), // 대소문자만 다른 경로
            path.join(P.lib, 'L2.jpg'),
            path.join(P.lib, 'L1.jpg'), // 겹침
            path.join(P.lib, 'nope.jpg'), // DB 에 없음
            path.join(P.src, 'S3.jpg'), // 백업 폴더 밖
          ];
          const t = g.tagImported(' 에버랜드 ', paths);
          const tagsOf = () => withDb((db) => ({ L1: db.getManualTags(path.join(P.lib, 'L1.jpg')), L2: db.getManualTags(path.join(P.lib, 'L2.jpg')), L3: db.getManualTags(path.join(P.lib, 'L3.jpg')), S3: db.getManualTags(path.join(P.src, 'S3.jpg')) }));
          const tagged = tagsOf();
          const st = await call('gallery:get-state');
          const sameAgain = g.tagImported('에버랜드', paths); // 다시 붙여도 바뀌는 것 없음 (묶음 안 만듦)
          const bad = await errOf(() => g.tagImported('사진', paths));
          // 새 태그 이름: 되돌리면 태그와 태그 정의가 함께 사라져요
          const t2 = g.tagImported('삼성라이온즈', [path.join(P.lib, 'L1.jpg'), path.join(P.lib, 'L3.jpg')]);
          const mid = await call('gallery:tag-list');
          const st2 = await call('gallery:get-state');
          await call('gallery:undo-last', st2.lastBatch.id);
          const afterUndo = tagsOf();
          const list = await call('gallery:tag-list');
          out.push(sub('60g 가져올 때 태그: 백업 폴더 안 · DB 에 있는 사진에만(대소문자 무시, 겹치면 한 번), 이미 붙은 사진은 그대로, 한 묶음(tagAdd)으로 되돌리기 줄에. 같은 태그를 다시 붙이면 묶음 없음, 종류 태그 이름은 거절',
            undoFirst.lastBatch && t.count === 1 && t.matched === 2 && t.unknown === 1 && t.name === '에버랜드' && !!t.batchId
              && JSON.stringify(tagged.L1) === '["에버랜드"]' && JSON.stringify(tagged.L2) === '["에버랜드"]' && tagged.L3.length === 0 && tagged.S3.length === 0
              && st.lastBatch && st.lastBatch.id === t.batchId && st.lastBatch.kind === 'tagAdd' && st.lastBatch.count === 1
              && sameAgain.count === 0 && sameAgain.batchId === null && !!bad,
            JSON.stringify({ t, tagged, last: st.lastBatch, sameAgain, bad })));
          out.push(sub('60g 새 태그 이름으로 붙이면 태그 정의도 생기고, 되돌리기 한 번에 그 사진들에서 모두 떨어지고 정의도 사라짐',
            t2.count === 2 && mid.manual.some((x) => x.name === '삼성라이온즈' && x.count === 2)
              && JSON.stringify(afterUndo.L1) === '["에버랜드"]' && afterUndo.L3.length === 0 && !list.manual.some((x) => x.name === '삼성라이온즈'),
            JSON.stringify({ t2, mid: mid.manual, afterUndo, list: list.manual })));
        });

        await scene('60h', async () => {
          // 60h 거르기 중이었어도 회차 끝 다시 읽기는 백업 폴더를 읽어요 (설계 5-1). 회차 끝 다시 읽기는 결과를 돌려줘요 (태그가 기다려요)
          g.startScreening(P.src);
          const r = await g.onBatchDone();
          const scanLogs = logsOf('gallery-scan').map((n) => fs.readFileSync(path.join(P.logDir, n), 'utf8'));
          const lastScan = scanLogs[scanLogs.length - 1] || '';
          g.endScreening();
          out.push(sub('60h 회차 끝 다시 읽기는 거르기 중이어도 백업 폴더를 읽고, 읽기 결과를 돌려줘요',
            r && typeof r.status === 'string' && lastScan.includes(P.lib) && !lastScan.includes(P.src),
            JSON.stringify({ r, lastScan: lastScan.split('\n').slice(0, 2) })));
        });
      } finally {
        g.close();
      }

      // 60i 연결 확인 (코드 글): 가져오기를 시작하는 곳마다 거르기를 끔 · 거르기 폴더 읽기에서는 옛 썸네일 정리 안 함 · 화면 연결
      {
        const main = read('main.js');
        const gal = read('gallery-main.js');
        const pre = read('preload.js');
        const html = read('index.html');
        const app = read('src/App.jsx');
        const handlerHas = (ch, text) => {
          const i = main.indexOf(`ipcMain.handle('${ch}'`);
          const j = main.indexOf('ipcMain.handle(', i + 10);
          return i >= 0 && main.slice(i, j < 0 ? undefined : j).includes(text);
        };
        const offAt = ['make-plan', 'start-job', 'run-batch', 'retry-failed', 'trash-info', 'trash-originals'].filter((ch) => !handlerHas(ch, 'endScreeningIfOn()'));
        const ok = !offAt.length
          && /!pruned && !isScreenRoot\(root\)/.test(gal)
          && handlerHas('screen-start', 'validateFolders(source, settings.backupRoot)') && handlerHas('screen-start', 'screenConflict(job.source, source)')
          && handlerHas('start-job', 'importTagOf(') && handlerHas('run-batch', 'applyImportTag(job.tag')
          && /screenStart: \(\) => ipcRenderer\.invoke\('screen-start'\)/.test(pre) && /onImportTag/.test(pre)
          && html.includes('id="screenBtn"') && html.includes('비슷한 사진 먼저 거르기') && html.includes('id="tagRow"') && html.includes('가져온 사진에 태그 붙이기')
          && html.includes('api.startJob({ tag })') && app.includes('거르기 끝내고 가져오기로') && app.includes('가져오기 전 거르기: ');
        out.push(sub('60i 미리보기 · 실행 · 다시 시도 · 원본 정리 시작 때 거르기를 끔, 거르기 폴더 읽기에서 옛 썸네일 정리 안 함, 거르기 시작은 폴더 검사 + 진행 중인 작업 확인, 화면 버튼 · 태그 칸 · 거르기 띠 연결',
          ok, offAt.length ? `거르기를 안 끄는 곳: ${offAt.join(', ')}` : ''));
      }
      return out;
    },
  },
];

module.exports = { items };

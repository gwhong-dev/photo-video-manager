// 파일 위치: scripts/check-same-video.js
// 역할: 비슷한 사진 화면의 "같은 영상" 묶음 점검 (70). scripts/check.js 의 ITEMS 끝에 붙어요
//   2026-11-24 사용자 요청: #141 전에 가져온 영상이 백업 폴더에 2개씩(IMG_0001.MP4 · IMG_0001_1.MP4) 저장된 것을 정리
//   임시 폴더의 복사본 · 가짜 휴지통으로만 해요 (샘플 · 진짜 휴지통은 안 건드려요)
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const { row, sub, withDb } = require('./check-gallery');
const skip = (label, detail) => ({ label, status: 'skip', detail });

const SAMPLES = path.join(__dirname, '..', 'test', 'samples', 'auto');
const MB = 1024 * 1024;

// 화면 목록 한 줄 (db.videoRows 모양)
function v(id, name, size, over = {}) {
  return {
    id, name, path: `R1/2026-11-20/${name}`, size, mtimeMs: 1000, width: 1920, height: 1080, takenAt: '2026-11-20T10:00:00',
    vhash: 'h1', vhashDone: true, ...over,
  };
}

// 묶음을 이름으로 보기 쉽게: [['남길 것', '버릴 것' ...]]
const namesOf = (groups, rows) => groups.map((g) => g.ids.map((id) => rows.find((r) => r.id === id).name));
const throws = (fn, re) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(e.message);
  }
};

const items = [
  {
    no: 70,
    name: '같은 영상 묶음 (두 번 저장된 영상을 찾아 꼬리 붙은 쪽만 옮기기)',
    async run(env) {
      const out = [];
      const S = require('../lib/same-video');
      const D = require('../lib/similar-discard');

      // 70a 묶는 조건: 같은 폴더 · 확장자 · 가로 × 세로 · 크기 5% 안 · 지문 같음. 남길 것은 꼬리 없는 이름
      {
        const rows = [
          v(1, 'IMG_0001_1.MP4', 101 * MB), // 꼬리 붙은 것이 번호가 작아도
          v(2, 'IMG_0001.MP4', 100 * MB), //   꼬리 없는 이름을 남겨요
          v(3, 'IMG_0001.MOV', 100 * MB), // 확장자가 다름 (MOV 를 MP4 로 바꾼 것도 지문이 같아서 빼요)
          v(4, 'IMG_0001.MP4', 100 * MB, { path: 'R1/2026-11-21/IMG_0001.MP4' }), // 다른 날짜 폴더
          v(5, 'IMG_0002.MP4', 100 * MB, { vhash: 'h2' }),
          v(6, 'IMG_0002_1.MP4', 120 * MB, { vhash: 'h2' }), // 크기 20% 차이
          v(7, 'IMG_0003.MP4', 50 * MB, { vhash: 'h3', width: 1280, height: 720 }),
          v(8, 'IMG_0003_1.MP4', 50 * MB, { vhash: 'h3' }), // 가로 × 세로가 다름
          v(9, 'IMG_0005.MP4', 30 * MB, { vhash: 'h5' }),
          v(10, 'IMG_0005_1.MP4', 30 * MB, { vhash: 'h5x' }), // 지문이 다름
          v(11, 'IMG_0006.MP4', 0, { vhash: 'h6' }),
          v(12, 'IMG_0006_1.MP4', 0, { vhash: 'h6' }), // 크기를 모름
          v(13, 'IMG_0007.MP4', 10 * MB, { vhash: null }),
          v(14, 'IMG_0007_1.MP4', 10 * MB, { vhash: null }), // 지문을 만들지 못함
          v(15, 'IMG_0008(1).MP4', 70 * MB, { vhash: 'h8' }),
          v(16, 'IMG_0008.MP4', 70 * MB, { vhash: 'h8' }),
          v(17, 'IMG_0008_1.MP4', 70.5 * MB, { vhash: 'h8' }), // 셋 다 같으면 하나만 남겨요
          v(18, 'C.MP4', 200 * MB, { vhash: 'hc' }),
          v(19, 'C_1.MP4', 208 * MB, { vhash: 'hc' }),
          v(20, 'C_2.MP4', 216.3 * MB, { vhash: 'hc' }), // 이어진 사슬이지만 남길 영상과 7.5% 차이 → 빼요
        ];
        const groups = S.buildVideoGroups(rows);
        const names = namesOf(groups, rows);
        const want = [['IMG_0001.MP4', 'IMG_0001_1.MP4'], ['IMG_0008.MP4', 'IMG_0008_1.MP4', 'IMG_0008(1).MP4'], ['C.MP4', 'C_1.MP4']];
        const same = (a, b) => JSON.stringify([...a].map((x) => x.join('|')).sort()) === JSON.stringify([...b].map((x) => x.join('|')).sort());
        out.push(sub('70a 같은 폴더 · 확장자 · 가로 × 세로 · 크기 5% 안 · 지문이 같은 것만 묶고, 꼬리 없는 이름을 남김 (MOV · 다른 폴더 · 크기 차이 · 지문 다름 · 크기 모름 · 지문 없음은 빼요)',
          same(names, want) && groups.every((g) => g.keepId === g.ids[0]),
          JSON.stringify(names)));

        // 지문을 아직 안 만든 후보만 계산해요 (실패해서 null 로 적힌 것은 다시 하지 않음)
        const pend = S.pendingRows([
          v(1, 'A.MP4', 10 * MB, { vhash: null, vhashDone: false }),
          v(2, 'A_1.MP4', 10 * MB, { vhash: null, vhashDone: false }),
          v(3, 'B.MP4', 10 * MB, { vhash: null, vhashDone: true }),
          v(4, 'B_1.MP4', 10 * MB, { vhash: null, vhashDone: false }),
          v(5, 'Z.MP4', 99 * MB, { vhash: null, vhashDone: false }), // 짝이 될 후보가 없음 → 계산 안 해요
        ]).map((r) => r.id).sort();
        out.push(sub('70a 지문은 후보끼리만, 아직 안 만든 것만 계산 (실패로 적힌 것 · 짝 없는 영상은 안 함)',
          JSON.stringify(pend) === JSON.stringify([1, 2, 4]), JSON.stringify(pend)));

        // 버릴 영상에만 있는 정보가 있으면 빼요 (검증 지적, #148): 직접 넣은 값 · 태그 / 촬영 시각 · 위치 · 태그가 다름
        const lost = [
          v(1, 'D.MP4', 10 * MB, { vhash: 'hd' }),
          v(2, 'D_1.MP4', 10 * MB, { vhash: 'hd', ownKey: 'v' }), // 남길 영상에 없는 직접 넣은 값 · 태그
          v(3, 'E.MP4', 10 * MB, { vhash: 'he' }),
          v(4, 'E_1.MP4', 10 * MB, { vhash: 'he', takenAt: '2026-11-20T11:00:00' }), // 촬영 시각 다름
          v(5, 'F.MP4', 10 * MB, { vhash: 'hf', tagKey: '가족' }),
          v(6, 'F_1.MP4', 10 * MB, { vhash: 'hf', tagKey: '가족\n수원' }), // 태그 다름
          v(7, 'G.MP4', 10 * MB, { vhash: 'hg', lat: 37.2, lng: 127.0 }),
          v(8, 'G_1.MP4', 10 * MB, { vhash: 'hg', lat: null, lng: null }), // 위치 다름
          v(9, 'H.MP4', 10 * MB, { vhash: 'hh', ownKey: 'k', tagKey: '가족', lat: 37.2, lng: 127.0 }), // 남길 영상은 직접 넣은 값이 있어도 돼요
          v(10, 'H_1.MP4', 10 * MB, { vhash: 'hh', ownKey: 'k2', tagKey: '가족', lat: 37.2, lng: 127.0 }), // 직접 넣은 값이 남길 영상과 다름
          v(11, 'H_2.MP4', 10 * MB, { vhash: 'hh', tagKey: '가족', lat: 37.2, lng: 127.0 }), // 같은 정보 → 버려도 돼요
          v(12, 'H_3.MP4', 10 * MB, { vhash: 'hh', ownKey: 'k', tagKey: '가족', lat: 37.2, lng: 127.0 }), // 직접 넣은 값도 같음 → 버려도 돼요
        ];
        const lostNames = namesOf(S.buildVideoGroups(lost), lost);
        out.push(sub('70a 버릴 영상의 직접 넣은 값 · 태그, 촬영 시각 · 위치 · 태그가 남길 영상과 다르면 묶지 않음 (같으면 묶음)',
          JSON.stringify(lostNames) === JSON.stringify([['H.MP4', 'H_2.MP4', 'H_3.MP4']]), JSON.stringify(lostNames)));
      }

      // 70b 옮기기 전 확인(checkSameVideo): 지금 DB 로 묶음을 다시 만들고, 남길 영상 · 묶음 밖 · 바뀐 영상은 거절
      await withDb(env, 'same-video-db', async (db) => {
        const vid = (name, over = {}) => row({ root: 'R1', path: `R1/2026-11-20/${name}`, name, mediaType: 'video', size: 40 * MB, mtimeMs: 5000, width: 1920, height: 1080, ...over });
        db.upsertFiles([vid('IMG_0001.MP4'), vid('IMG_0001_1.MP4'), vid('IMG_0009.MP4'), vid('IMG_0009_1.MP4'), vid('pic.jpg', { mediaType: 'photo' })]);
        const all = db.videoRows('R1');
        const idOf = (name) => (all.find((r) => r.name === name) || {}).id;
        const before = S.pendingRows(all).length;
        for (const r of all) db.setVideoHash(r.path, r.size, r.mtimeMs, r.name.startsWith('IMG_0001') ? 'aaa' : (r.name.endsWith('_1.MP4') ? 'x1' : 'x2'));
        const rows = db.videoRows('R1');
        const groups = S.buildVideoGroups(rows);
        out.push(sub('70b DB: 영상만 읽고(사진 빼고), 지문을 적은 뒤에는 계산할 것 0개, 지문이 같은 한 묶음만',
          all.length === 4 && before === 4 && S.pendingRows(rows).length === 0 && groups.length === 1 && groups[0].keepId === idOf('IMG_0001.MP4'),
          `영상 ${all.length} / 계산 전 ${before} / 묶음 ${JSON.stringify(namesOf(groups, rows))}`));

        const dupId = idOf('IMG_0001_1.MP4');
        const ok = S.checkSameVideo(db, 'R1', [dupId]);
        out.push(sub('70b 꼬리 붙은 영상은 남길 영상 정보(경로 · 크기 · 수정 시각)와 지문을 같이 넘김',
          ok.files.length === 1 && ok.groups === 1 && ok.files[0].vhash === 'aaa' && ok.files[0].keepers.length === 1
            && ok.files[0].keepers[0].path === 'R1/2026-11-20/IMG_0001.MP4' && ok.files[0].keepers[0].mtimeMs === 5000 && ok.files[0].pair === null,
          JSON.stringify(ok)));
        const refused = [
          ['남길 영상', () => S.checkSameVideo(db, 'R1', [idOf('IMG_0001.MP4')]), /남길 영상은/],
          ['묶음 밖', () => S.checkSameVideo(db, 'R1', [idOf('IMG_0009_1.MP4')]), /목록이 바뀌었어요/],
          ['두 번', () => S.checkSameVideo(db, 'R1', [dupId, dupId]), /두 번/],
          ['빈 목록', () => S.checkSameVideo(db, 'R1', []), /골라 주세요/],
          ['번호 아님', () => S.checkSameVideo(db, 'R1', ['1']), /올바르지 않아요/],
          ['다른 폴더', () => S.checkSameVideo(db, 'R2', [dupId]), /목록이 바뀌었어요/],
        ].filter(([, fn, re]) => !throws(fn, re)).map(([n]) => n);
        out.push(sub('70b 남길 영상 · 묶음 밖 · 같은 번호 두 번 · 빈 목록 · 번호 아님 · 다른 백업 폴더는 거절', refused.length === 0, refused.length ? `안 막힘: ${refused.join(', ')}` : ''));

        // 버릴 영상에 직접 태그를 붙이면 DB 에서 own · tagKey 로 읽혀서 묶음에서 빠지고, 옮기기도 거절
        db.applyManualBatch({ id: 'SV1', root: 'R1', kind: 'tagAdd', createdAt: '2026-11-24T00:00:00.000Z', items: [{ path: 'R1/2026-11-20/IMG_0001_1.MP4', before: [], after: ['가족'] }] });
        const tagged = db.videoRows('R1').find((r) => r.id === dupId) || {};
        out.push(sub('70b 버릴 영상에 직접 붙인 태그가 있으면 묶음에서 빠지고 옮기기도 거절',
          tagged.own === true && tagged.tagKey.split('\n').includes('가족') && S.buildVideoGroups(db.videoRows('R1')).length === 0
            && throws(() => S.checkSameVideo(db, 'R1', [dupId]), /목록이 바뀌었어요/),
          JSON.stringify({ own: tagged.own, tagKey: tagged.tagKey })));
        // 남길 영상에도 같은 태그를 붙이면 (파일 안의 태그를 폴더 읽기로 가져온 경우처럼) 잃는 것이 없어서 다시 묶여요 (앱 확인에서 잡음, #148)
        db.applyManualBatch({ id: 'SV1b', root: 'R1', kind: 'tagAdd', createdAt: '2026-11-24T00:00:00.500Z', items: [{ path: 'R1/2026-11-20/IMG_0001.MP4', before: [], after: ['가족'] }] });
        const both = S.buildVideoGroups(db.videoRows('R1'));
        out.push(sub('70b 두 영상의 직접 붙인 태그가 같으면 묶고 옮기기도 받아요',
          both.length === 1 && both[0].keepId === idOf('IMG_0001.MP4') && S.checkSameVideo(db, 'R1', [dupId]).files.length === 1,
          JSON.stringify(namesOf(both, db.videoRows('R1')))));
        db.applyManualBatch({ id: 'SV2', root: 'R1', kind: 'tagAdd', createdAt: '2026-11-24T00:00:01.000Z', items: [{ path: 'R1/2026-11-20/IMG_0001_1.MP4', before: ['가족'], after: [] }, { path: 'R1/2026-11-20/IMG_0001.MP4', before: ['가족'], after: [] }] });

        // 파일이 바뀌면(수정 시각 다름) 옛 지문은 안 쓰고 다시 계산할 후보 → 묶음에서 빠지고 옮기기도 거절
        db.upsertFiles([vid('IMG_0001.MP4', { mtimeMs: 6000 })]);
        const after = db.videoRows('R1');
        const stale = S.pendingRows(after).map((r) => r.name);
        out.push(sub('70b 남길 영상이 바뀌면 옛 지문은 버리고 다시 계산, 그 사이 옮기기는 거절',
          stale.length === 1 && stale[0] === 'IMG_0001.MP4' && S.buildVideoGroups(after).length === 0 && throws(() => S.checkSameVideo(db, 'R1', [dupId]), /목록이 바뀌었어요/),
          JSON.stringify(stale)));
      });

      // 70c 옮기기(discardFiles + makeVerify): 옮기기 직전에 두 영상의 지문을 다시 보고, 다르면 옮기지 않음
      {
        const base = path.join(env.tmp, 'same-video');
        const root = path.join(base, 'root');
        const put = (rel, text) => {
          const p = path.join(root, '2026-11-20', rel);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, text);
          const st = fs.statSync(p);
          return { path: p, size: st.size, mtimeMs: st.mtimeMs };
        };
        // 점검용 지문 = 파일 내용 (없으면 null)
        const hashOf = async (p) => {
          try {
            return fs.readFileSync(p, 'utf8');
          } catch (e) {
            return null;
          }
        };
        const fileOf = (id, f, vhash, keeper) => ({ id, path: f.path, name: path.basename(f.path), size: f.size, mtimeMs: f.mtimeMs, vhash, keepers: [keeper], pair: null });
        const kA = put('A.MP4', 'same');
        const dA = put('A_1.MP4', 'same');
        const kB = put('B.MP4', 'keeper changed');
        const dB = put('B_1.MP4', 'bbbb');
        const kC = put('C.MP4', 'cccc');
        const dC = put('C_1.MP4', 'other');
        const files = [fileOf(1, dA, 'same', kA), fileOf(2, dB, 'bbbb', kB), fileOf(3, dC, 'cccc', kC)];
        const bin = [];
        const trash = async (p) => {
          bin.push(p);
          fs.rmSync(p); // 점검에서는 휴지통 대신 지워요 (임시 폴더의 복사본)
        };
        const { createLogger } = require('../lib/logger');
        const logDir = path.join(base, 'logs');
        const r = await D.discardFiles({
          root, files, trash, driveKindOf: async () => 'fixed', recycleOf: async () => null, logger: createLogger(logDir),
          logKind: 'same-video', logTitle: '같은 영상 정리', verify: S.makeVerify(hashOf),
        });
        const left = [kA, kB, dB, kC, dC].every((f) => fs.existsSync(f.path));
        out.push(sub('70c 지문이 그대로인 영상만 휴지통으로, 남길 영상 내용이 다르거나 옮길 영상 내용이 다르면 둘 다 그대로',
          r.trashed === 1 && r.fail === 2 && bin.length === 1 && bin[0] === dA.path && !fs.existsSync(dA.path) && left,
          JSON.stringify({ trashed: r.trashed, moved: r.moved, fail: r.fail, bin: bin.map((p) => path.basename(p)) })));

        // 로그: 이름이 same-video_ 로 시작, 정리 기록 화면이 "같은 영상 정리"로 읽어요
        const { parseLog, readCleanHistory } = require('../lib/clean-history');
        const name = path.basename(r.logPath || '');
        const text = fs.readFileSync(r.logPath, 'utf8');
        const s = parseLog(name, text);
        const hist = await readCleanHistory(logDir);
        out.push(sub('70c 로그 same-video_…, 정리 기록에 "같은 영상 정리" 휴지통 1 · 실패 2 (까닭 적힘)',
          /^same-video_/.test(name) && s.kind === 'same-video' && s.label === '같은 영상 정리' && s.trash === 1 && s.fail === 2 && s.finished
            && /남길 영상의 내용이 달라서/.test(text) && /영상 내용이 목록과 달라서/.test(text) && hist.sessions.length === 1 && hist.sessions[0].kind === 'same-video',
          `${name} ${JSON.stringify({ kind: s.kind, trash: s.trash, fail: s.fail })}`));

        // 지문을 계산할 수 없으면(FFmpeg 없음 · 못 읽음) 옮기지 않아요
        const kD = put('D.MP4', 'dddd');
        const dD = put('D_1.MP4', 'dddd');
        const r2 = await D.discardFiles({
          root, files: [fileOf(4, dD, 'dddd', kD)], trash, driveKindOf: async () => 'fixed', recycleOf: async () => null, logger: createLogger(logDir),
          logKind: 'same-video', logTitle: '같은 영상 정리', verify: S.makeVerify(async () => null),
        });
        out.push(sub('70c 지문을 다시 계산할 수 없으면 옮기지 않음', r2.trashed === 0 && r2.moved === 0 && r2.fail === 1 && fs.existsSync(dD.path), JSON.stringify({ trashed: r2.trashed, fail: r2.fail })));
      }

      // 70d 화면 글: 버릴 번호 · 버튼 · 결과
      {
        const { pathToFileURL } = require('url');
        const V = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'similar-view.mjs')).href);
        const g = [{ ids: [1, 2, 3], keepId: 1 }, { ids: [7, 8], keepId: 7 }];
        const ids = V.videoDiscardIds(g);
        const label = V.videoDiscardLabel({ count: 3, trash: 3, move: 0 });
        const res = V.videoResultText({ trashed: 2, moved: 0, fail: 1, logName: 'same-video_x.txt' });
        out.push(sub('70d 남길 영상은 버릴 목록에서 빼고, 버튼 · 결과 글은 개수와 옮기는 곳을 말함',
          JSON.stringify(ids) === JSON.stringify([2, 3, 8]) && label === '같은 영상 3개 휴지통으로 옮기기'
            && res.includes('휴지통으로 2개') && res.includes('1개는 옮기지 않았어요') && V.videoSummary(g) === '두 번 저장된 같은 영상 묶음 2개, 옮길 영상 3개'
            && V.videoProgressText({ done: 1, total: 4, hashing: true }).includes('1 / 4') && V.videoProgressText({ done: 4, total: 4, hashing: false }) === '',
          `${JSON.stringify(ids)} / ${label} / ${res}`));
      }

      // 70e 실제 FFmpeg: 같은 영상 복사본 두 개는 지문이 같아서 묶이고, 옮기기 직전 확인도 통과 (지문 = lib/tools.js sameVideoHash)
      const ffmpeg = env.tools.ffmpeg.ok ? env.tools.ffmpeg.path : null;
      if (!ffmpeg) {
        out.push(skip('70e 실제 FFmpeg 지문', 'ffmpeg 없음'));
        return out;
      }
      {
        const { sameVideoHash, runCmd } = require('../lib/tools');
        const dir = path.join(env.tmp, 'same-video-real', '2026-11-20');
        fs.mkdirSync(dir, { recursive: true });
        const keep = path.join(dir, 'IMG_0103.MOV');
        const dup = path.join(dir, 'IMG_0103_1.MOV');
        fs.copyFileSync(path.join(SAMPLES, 'IMG_0103.MOV'), keep);
        fs.copyFileSync(keep, dup);
        const hashOf = (p) => sameVideoHash(ffmpeg, p);
        const [h1, h2] = [await hashOf(keep), await hashOf(dup)];
        const size = fs.statSync(keep).size;
        const rows = [
          { id: 2, name: 'IMG_0103_1.MOV', path: dup, size, mtimeMs: 1, width: 640, height: 480, vhash: h2, vhashDone: true },
          { id: 1, name: 'IMG_0103.MOV', path: keep, size, mtimeMs: 1, width: 640, height: 480, vhash: h1, vhashDone: true },
        ];
        const groups = S.buildVideoGroups(rows);
        let verified = '';
        try {
          await S.makeVerify(hashOf)({ path: dup, vhash: h2, keepers: [{ path: keep }] });
          verified = 'ok';
        } catch (e) {
          verified = e.message;
        }
        out.push(sub('70e 실제 FFmpeg: 복사본 두 개는 지문이 같아 한 묶음(꼬리 없는 이름을 남김), 옮기기 직전 확인 통과',
          !!h1 && h1 === h2 && groups.length === 1 && groups[0].keepId === 1 && verified === 'ok',
          `${String(h1).slice(0, 8)} / ${String(h2).slice(0, 8)} / 묶음 ${groups.length} / 확인 ${verified}`));

        // 다른 영상 · 소리만 다른 영상은 지문이 달라요 (FFmpeg 로 임시로 만듦)
        const other = path.join(dir, 'other.MOV');
        const withAudio = path.join(dir, 'audio.MOV');
        await runCmd(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-c:v', 'mpeg4', other]);
        await runCmd(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-i', keep, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', withAudio]);
        const [hOther, hAudio] = [await hashOf(other), await hashOf(withAudio)];
        out.push(sub('70e 실제 FFmpeg: 다른 영상 · 화면은 같고 소리만 있는 영상은 지문이 다름',
          !!hOther && !!hAudio && hOther !== h1 && hAudio !== h1, `${String(hOther).slice(0, 8)} / ${String(hAudio).slice(0, 8)}`));

        // 돌린 복사본(영상 돌리기는 회전 값만 바꾼 _1 을 만들어요)은 화면 데이터가 같아도 지문이 달라서 묶이지 않음
        const et = env.tools.exiftool && env.tools.exiftool.ok ? env.tools.exiftool.path : null;
        if (!et) {
          out.push(skip('70e 돌린 복사본은 같은 영상이 아님', 'exiftool 없음'));
        } else {
          const turned = path.join(dir, 'IMG_0103_2.MOV');
          await runCmd(et, ['-q', '-Rotation=90', '-o', turned, keep]);
          const hTurned = await hashOf(turned);
          const tRows = [
            { id: 1, name: 'IMG_0103.MOV', path: keep, size, mtimeMs: 1, width: 640, height: 480, vhash: h1, vhashDone: true },
            { id: 3, name: 'IMG_0103_2.MOV', path: turned, size: fs.statSync(turned).size, mtimeMs: 1, width: 640, height: 480, vhash: hTurned, vhashDone: true },
          ];
          out.push(sub('70e 돌린 복사본(회전 값만 바뀜)은 지문이 달라서 묶지 않음 (검증 지적, #148)',
            !!hTurned && hTurned !== h1 && /:r0$/.test(String(h1)) && /:r(90|270)$/.test(String(hTurned)) && S.buildVideoGroups(tRows).length === 0,
            `${String(h1).slice(-4)} / ${String(hTurned).slice(-4)}`));
        }
      }
      return out;
    },
  },
];

module.exports = { items };

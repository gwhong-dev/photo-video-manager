// 파일 위치: scripts/check-tag-write.js
// 역할: 69번 점검 — 태그를 사진 · 영상 파일에 읽고 쓰기 (31 ②, docs/decisions/2026-11-23-태그-파일에-쓰기.md)
//   ① 쓰기 인자 · 읽은 정보 → 태그 목록 (XMP · IPTC · 탐색기 태그 합치기, 종류 태그 따로)
//   ② 샘플 복사본(JPG · PNG · MOV)에 쓰고 다시 읽기, 같으면 건드리지 않기, 바뀐 파일은 쓰지 않기, 쓸 수 없는 형식
//   ③ DB: 파일 태그 받아들이기(세 갈래 합치기) · 쓰지 않은 태그 목록 · 쓴 뒤 기록
//   ④ 원본 정리: 쓴 뒤 완료 항목의 지문 · 서명 새로 적기
//   ⑤ 화면 글자 (띠 · 쓰기 창)
//
// ⚠️ 실제 사진은 쓰지 않아요. test/samples/auto 의 샘플을 점검 임시 폴더(env.tmp)에 복사해서 써요

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { sub } = require('./check-gallery');
const FT = require('../lib/file-tags');

const SAMPLES = path.join(__dirname, '..', 'test', 'samples', 'auto');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const items = [
  {
    no: 69,
    name: '태그를 파일에 쓰기 (31 ②)',
    async run(env) {
      const out = [];
      const et = env.et;
      const dir = path.join(env.tmp, 'tag-write');
      fs.mkdirSync(dir, { recursive: true });
      const copy = (name, as = name) => {
        const p = path.join(dir, as);
        fs.copyFileSync(path.join(SAMPLES, name), p);
        return p;
      };

      // ---------- ① 인자 · 읽기 ----------
      const jpgArgs = FT.writeArgs('jpg', ['가족', '여행']);
      out.push(sub('JPG 는 XMP · IPTC(UTF-8) · 탐색기 태그에 같이 써요',
        jpgArgs.includes('-XMP-dc:Subject=가족') && jpgArgs.includes('-IPTC:Keywords=여행') && jpgArgs.includes('-XPKeywords=가족;여행')
          && jpgArgs.includes('-IPTC:CodedCharacterSet=UTF8') && jpgArgs.includes('-P'), jpgArgs.join(' ')));
      const vidArgs = FT.writeArgs('video', ['가족']);
      out.push(sub('영상은 XMP + 탐색기 영상 태그(Microsoft:Category), IPTC 는 안 써요',
        vidArgs.includes('-Microsoft:Category=가족') && !vidArgs.some((a) => a.startsWith('-IPTC')), vidArgs.join(' ')));
      out.push(sub('빈 목록이면 칸을 비우기만 해요 (원래 파일을 바로 고치는 인자 없음)', same(FT.writeArgs('xmp', []), ['-P', '-XMP-dc:Subject='])));
      const longName = '아주긴태그이름'.repeat(4); // 28자 = 84바이트
      const longArgs = FT.writeArgs('jpg', ['가족', longName]);
      out.push(sub('IPTC 64바이트보다 긴 태그는 IPTC 에만 안 써요 (XMP · 탐색기 태그에는 써요)',
        !FT.fitsIptc(longName) && !longArgs.includes(`-IPTC:Keywords=${longName}`) && longArgs.includes(`-XMP-dc:Subject=${longName}`) && longArgs.includes('-IPTC:Keywords=가족'),
        longArgs.join(' ')));
      const m1 = FT.tagsFromMeta({ Subject: ['사진', '가족'], Keywords: '여행', XPKeywords: 'x;y', Category: ['캠핑'] });
      out.push(sub('여러 칸을 합치고 종류 태그는 따로 (XMP 가 있으면 탐색기 태그는 나누지 않아요)',
        same(m1, { tags: ['가족', '여행', '캠핑'], media: ['사진'] }), JSON.stringify(m1)));
      const m2 = FT.tagsFromMeta({ XPKeywords: '가족;바다' });
      out.push(sub('탐색기 태그만 있으면 ; 로 나눠 읽어요', same(m2.tags, ['가족', '바다']), JSON.stringify(m2)));
      out.push(sub('쓸 수 있는 형식', FT.canWrite('a.JPG') && FT.canWrite('a.mov') && FT.canWrite('a.heic') && !FT.canWrite('a.bmp') && !FT.canWrite('a.avi')));

      // ---------- ② 샘플 복사본에 쓰기 ----------
      const stat = (p) => { const s = fs.statSync(p); return { size: s.size, mtimeMs: s.mtimeMs }; };
      for (const [name, list] of [['IMG_0101.jpg', ['가족', '제주 여행']], ['IMG_0102.PNG', ['바다']], ['IMG_0103.MOV', ['캠핑', '가족']]]) {
        const p = copy(name);
        const s0 = stat(p);
        let probed = 0;
        const r = await FT.writeFileTags(et, p, list, s0, { probe: async () => { probed++; return { ok: true }; } });
        const back = await FT.readFileTags(et, p);
        const s1 = stat(p);
        const isVideo = /\.mov$/i.test(name);
        out.push(sub(`${name}: 쓰고 다시 읽으면 같은 태그, 수정 시각 그대로${isVideo ? ', 영상 재생 확인' : ''}`,
          r.ok && !r.same && r.verified === true && same(back.tags, [...list].sort()) && Math.abs(s1.mtimeMs - s0.mtimeMs) < 1000 && (!isVideo || probed === 1)
            && !fs.existsSync(`${p}_exiftool_tmp`),
          `${r.ok ? '' : r.why} 읽음 ${back.tags.join(',')} 시각차 ${Math.round(s1.mtimeMs - s0.mtimeMs)}ms 지문확인 ${r.verified}`));
        if (!isVideo) {
          const r2 = await FT.writeFileTags(et, p, list, s1);
          out.push(sub(`${name}: 이미 같으면 파일을 건드리지 않아요`, r2.ok && r2.same && same(stat(p), s1)));
        }
        if (name === 'IMG_0101.jpg') {
          // 다른 프로그램에서 보이는 칸에도 들어갔는지 (IPTC · 탐색기 태그)
          const { stdout } = await et.run(['-j', '-IPTC:Keywords', '-XPKeywords', p]);
          const m = JSON.parse(stdout)[0] || {};
          out.push(sub('JPG: IPTC · 탐색기 태그에도 한글 그대로',
            same([].concat(m.Keywords || []).map(String).sort(), [...list].sort()) && String(m.XPKeywords || '').split(';').sort().join(';') === [...list].sort().join(';'),
            JSON.stringify(m)));
          // 빈 목록 쓰기 = 태그 지우기 (되돌리기 · 떼기)
          const r3 = await FT.writeFileTags(et, p, [], stat(p));
          out.push(sub('JPG: 빈 목록을 쓰면 파일 태그가 비어요', r3.ok && (await FT.readFileTags(et, p)).tags.length === 0, r3.why || ''));
        }
        if (isVideo) {
          const sBefore = stat(p);
          const bytesBefore = fs.readFileSync(p);
          const r4 = await FT.writeFileTags(et, p, ['가족'], sBefore, { probe: async () => ({ ok: false, reason: '시험' }) });
          // 확인에 실패하면 원래 파일은 한 바이트도 안 바뀌고, 확인 못 한 사본도 남지 않아요
          out.push(sub('영상: 쓴 뒤 재생이 안 되면 실패로 알리고 원래 파일 · 태그는 그대로, 임시 사본도 안 남아요',
            !r4.ok && r4.lasting === false && /재생/.test(r4.why) && same(stat(p), sBefore) && fs.readFileSync(p).equals(bytesBefore)
              && same((await FT.readFileTags(et, p)).tags, [...list].sort()) && !fs.existsSync(`${p}_exiftool_tmp`),
            r4.why || ''));
        }
      }

      // 종류 태그(PhotoSync 가 붙인 것)는 남겨요 + 쓰기 직전 파일에서 바뀐 태그 합치기(plan)
      {
        const p = copy('IMG_0104.jpg', 'media.jpg');
        await et.write(['-overwrite_original', '-XMP-dc:Subject=사진', '-XMP-dc:Subject=다른앱', p]);
        const r = await FT.writeFileTags(et, p, null, stat(p), { plan: (now) => [...new Set([...now, '내태그'])].sort() });
        const { stdout } = await et.run(['-j', '-XMP-dc:Subject', p]);
        const subj = [].concat((JSON.parse(stdout)[0] || {}).Subject || []).map(String).sort();
        out.push(sub('종류 태그 "사진" 은 그대로, 다른 앱 태그는 합쳐서 써요', r.ok && same(subj, ['내태그', '다른앱', '사진']), JSON.stringify(subj)));
      }
      // 미리보기 뒤 파일이 바뀌면 쓰지 않아요
      {
        const p = copy('IMG_0104.jpg', 'changed.jpg');
        const s0 = stat(p);
        const r = await FT.writeFileTags(et, p, ['가족'], { size: s0.size + 1, mtimeMs: s0.mtimeMs });
        out.push(sub('폴더를 읽은 뒤 바뀐 파일은 쓰지 않아요', !r.ok && r.lasting === false && same(stat(p), s0), r.why || ''));
      }
      // 쓸 수 없는 형식 (확장자 .bmp)
      {
        const p = copy('IMG_0104.jpg', 'pic.bmp');
        const s0 = stat(p);
        const r = await FT.writeFileTags(et, p, ['가족'], s0);
        out.push(sub('쓸 수 없는 형식은 건드리지 않고 "다시 해도 같음" 으로 알려요', !r.ok && r.lasting === true && same(stat(p), s0), r.why || ''));
      }
      // 지난번에 남은 exiftool 임시 파일: 원래 파일이 옆에 있는 것만 찾아요
      {
        const p = copy('IMG_0104.jpg', 'left.jpg');
        fs.writeFileSync(`${p}_exiftool_tmp`, 'x');
        const lone = path.join(dir, 'lone.jpg');
        fs.writeFileSync(`${lone}_exiftool_tmp`, 'x');
        const found = FT.leftoverTemps([p, lone]);
        out.push(sub('남은 임시 파일은 원래 파일이 있는 것만 골라요', same(found, [`${p}_exiftool_tmp`]), found.map((f) => path.basename(f)).join(',')));
        const s0 = stat(p);
        const r = await FT.writeFileTags(et, p, ['가족'], s0);
        out.push(sub('남은 임시 파일이 있으면 쓰지 않고 그 파일도 건드리지 않아요',
          !r.ok && r.lasting === false && same(stat(p), s0) && fs.readFileSync(`${p}_exiftool_tmp`, 'utf8') === 'x', r.why || ''));
      }
      // 긴 한글 태그 (IPTC 64바이트 넘음): 실제 파일에 써도 다시 읽은 태그가 같아요 (잘린 이름이 생기지 않음)
      {
        const p = copy('IMG_0104.jpg', 'long.jpg');
        const list = ['가족', '아주긴태그이름'.repeat(4)].sort();
        const r = await FT.writeFileTags(et, p, list, stat(p));
        const back = await FT.readFileTags(et, p);
        out.push(sub('JPG: 긴 한글 태그도 쓰고 다시 읽으면 같아요', r.ok && same(back.tags, list), `${r.why || ''} 읽음 ${back.tags.join(',')}`));
      }
      // 내용 지문을 못 만드는 형식(GIF): 쓰기는 하되 "지문 확인됨" 이 아니라서 가져오기 기록을 새로 고치지 않아요
      {
        const p = path.join(dir, 'dot.gif');
        fs.writeFileSync(p, Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
        const r = await FT.writeFileTags(et, p, ['가족'], stat(p));
        out.push(sub('GIF: 태그는 쓰지만 지문 확인은 안 된 것으로 알려요 (verified=false)',
          r.ok && r.verified === false && same((await FT.readFileTags(et, p)).tags, ['가족']), r.why || JSON.stringify({ ok: r.ok, verified: r.verified })));
      }

      // ---------- ③ DB ----------
      const { openDb } = require('../lib/db');
      const dbFile = path.join(dir, 'db', 'library.db');
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      const opened = openDb(dbFile);
      const db = opened.db;
      try {
        const row = (p, tags, over = {}) => ({
          root: 'R', path: p, name: path.basename(p), mediaType: 'photo', size: 100, mtimeMs: 1000,
          takenAt: '2026-10-25T14:00:30', takenOffset: '+09:00', takenDay: '2026-10-25', takenAtSource: 'exif',
          lat: null, lng: null, locationSource: null, model: null, width: 10, height: 10, durationSec: null, readError: null,
          tags: tags.map((name) => ({ name, source: FT.MEDIA_TYPE_TAGS.includes(name) ? 'mediaType' : 'album' })), ...over,
        });
        db.upsertFiles([row('R/a.jpg', ['사진', '가족']), row('R/b.jpg', []), row('R/c.bmp', ['여행'])]);
        out.push(sub('처음 읽으면 파일 태그가 태그 목록이 되고, 쓸 것은 없어요',
          same(db.getManualTags('R/a.jpg'), ['가족']) && !db.tagsPending('R/a.jpg') && db.tagWritePending('R').length === 0,
          `${db.getManualTags('R/a.jpg')} / 쓸 것 ${db.tagWritePending('R').length}`));
        // 앱에서 태그 더하기 → 쓸 것 1장
        db.applyManualBatch({ id: 'b1', root: 'R', kind: 'tagAdd', createdAt: '2026-11-24T00:00:00Z', items: [{ path: 'R/a.jpg', before: ['가족'], after: ['가족', '바다'] }] });
        const pend = db.tagWritePending('R');
        out.push(sub('앱에서 바꾼 태그는 "쓰지 않은 태그" 가 돼요',
          db.tagsPending('R/a.jpg') && pend.length === 1 && same(pend[0].list, ['가족', '바다']) && same(pend[0].base, ['가족']), JSON.stringify(pend)));
        // 쓰기 전에 다른 프로그램이 파일에서 "가족" 을 빼고 "캠핑" 을 더함 → 세 갈래 합치기
        const merged = db.adoptFileTagsNow('R/a.jpg', 'R', ['캠핑']);
        out.push(sub('세 갈래 합치기: 파일에서 뺀 것은 빼고, 더한 것은 더하고, 앱에서 더한 것은 남겨요', same(merged, ['바다', '캠핑']), merged.join(',')));
        // 쓴 뒤 기록 → 쓸 것 0, 크기 · 수정 시각 새 값
        db.markTagsWritten('R/a.jpg', merged, { size: 150, mtimeMs: 1000 });
        db.upsertFiles([row('R/a.jpg', ['사진', ...merged], { size: 150 })]);
        out.push(sub('쓴 뒤에는 쓸 것이 없고, 다시 읽어도 목록이 그대로예요',
          db.tagWritePending('R').length === 0 && same(db.getManualTags('R/a.jpg'), merged), db.getManualTags('R/a.jpg').join(',')));
        // 다른 PC 에서 파일 태그를 바꿈 → 다시 읽으면 바뀐 만큼 반영 (쓸 것 없음)
        db.upsertFiles([row('R/a.jpg', ['바다', '친구'], { size: 160 })]);
        out.push(sub('다른 곳에서 파일 태그를 바꾸면 읽을 때 목록도 따라가요',
          same(db.getManualTags('R/a.jpg'), ['바다', '친구']) && !db.tagsPending('R/a.jpg'), db.getManualTags('R/a.jpg').join(',')));
        // 되돌리기 기록에도 파일 변화가 들어가요 (되돌려도 다른 곳에서 더한 "친구" 가 사라지지 않게)
        db.undoBatch('b1', '2026-11-24T00:01:00Z');
        out.push(sub('태그를 되돌려도 다른 곳에서 더한 태그는 남아요',
          db.getManualTags('R/a.jpg').includes('친구') && !db.getManualTags('R/a.jpg').includes('바다'), db.getManualTags('R/a.jpg').join(',')));
        // 읽기 실패한 파일은 목록을 건드리지 않아요
        db.upsertFiles([row('R/c.bmp', [], { readError: '못 읽음' })]);
        out.push(sub('읽기에 실패하면 태그 목록을 그대로 둬요', same(db.getManualTags('R/c.bmp'), ['여행'])));
      } finally {
        db.close();
      }

      // 옛 DB(앨범 태그 줄이 따로 있던 것)를 열면 태그 목록으로 옮겨요
      {
        const { DatabaseSync } = require('node:sqlite');
        const f2 = path.join(dir, 'db-old', 'library.db');
        fs.mkdirSync(path.dirname(f2), { recursive: true });
        const o = openDb(f2);
        o.db.upsertFiles([{ root: 'R', path: 'R/x.jpg', name: 'x.jpg', mediaType: 'photo', size: 1, mtimeMs: 1, takenAt: null, takenOffset: null, takenDay: null, takenAtSource: null, lat: null, lng: null, locationSource: null, model: null, width: 1, height: 1, durationSec: null, readError: null, tags: [] }]);
        o.db.close();
        // 옛 빌드처럼: 앨범 태그 줄만 있고 태그 목록 · 파일 기록은 없음
        const raw = new DatabaseSync(f2);
        raw.exec("INSERT OR IGNORE INTO tags (name) VALUES ('옛앨범')");
        raw.exec("INSERT INTO file_tags (file_id, tag_id, source) SELECT f.id, t.id, 'album' FROM files f, tags t WHERE f.path = 'R/x.jpg' AND t.name = '옛앨범'");
        raw.exec('DELETE FROM tag_sync');
        raw.close();
        const o2 = openDb(f2);
        try {
          const n = o2.db.adoptOldFileTags();
          out.push(sub('옛 앨범 태그는 태그 목록으로 옮기고 "파일에 이미 있음" 으로 적어요',
            n === 1 && same(o2.db.getManualTags('R/x.jpg'), ['옛앨범']) && !o2.db.tagsPending('R/x.jpg') && o2.db.adoptOldFileTags() === 0,
            `${n}장, ${o2.db.getManualTags('R/x.jpg')}`));
        } finally {
          o2.db.close();
        }
      }

      // ---------- ④ 원본 정리 기록 ----------
      {
        const cleaner = require('../lib/cleaner');
        const p = path.join(dir, 'IMG_0101.jpg');
        const job = { items: [
          { status: 'done', finalPath: p, resultHash: 'h0', resultSig: 'S0' },
          { status: 'done', finalPath: p, resultHash: 'h0', resultSig: 'OLD' }, // 이미 못 믿던 항목
          { status: 'done', finalPath: path.join(dir, 'other.jpg'), resultHash: 'h0', resultSig: 'S0' },
        ] };
        const idx = await cleaner.trustedItemsOf(job, p, async () => 'S0');
        const store = { mark: (j, i, patch) => Object.assign(j.items[i], patch) };
        const n = await cleaner.refreshTrusted(job, store, idx, p, { hashOf: async () => 'h1', sigOf: async () => 'S1' });
        out.push(sub('쓰기 전에 믿던 항목만 지문 · 서명을 새로 적어요',
          same(idx, [0]) && n === 1 && job.items[0].resultHash === 'h1' && job.items[0].resultSig === 'S1' && job.items[1].resultSig === 'OLD',
          `${idx} → ${n}`));
      }

      // ---------- ⑤ 화면 글자 ----------
      {
        const view = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'tag-write-view.mjs')).href);
        const info = { total: 5, writable: 3, unwritable: 2, unwritableExts: ['BMP'], bytes: 3e6, maxBytes: 2e6, videoBytes: 0, free: 1e9, enough: true };
        const b = view.bannerText(info);
        const lines = view.infoLines(info);
        out.push(sub('띠: 쓸 장수와 결과를 말하는 버튼', !!b && b.button === '3장 파일에 태그 쓰기' && view.bannerText({ writable: 0, unwritable: 2 }) === null, b && b.button));
        out.push(sub('쓰기 창: 쓸 수 없는 형식은 ⚠️ 줄로', lines.some((l) => l.warn && /BMP/.test(l.text) && /2장/.test(l.text)), lines.map((l) => l.text).join(' / ')));
        out.push(sub('빈 공간이 모자라면 버튼이 막혀요', view.writeButtonText({ ...info, enough: false }, false) === '빈 공간이 모자라요'));
        const rt = view.resultText({ written: 2, same: 1, failed: [{ name: 'a', why: 'x' }], unwritable: 0 });
        out.push(sub('끝난 뒤 알림: 쓴 장수 · 같은 것 · 이어서 쓰기 안내', /2장에 태그를 썼어요/.test(rt) && /이어서/.test(rt), rt));
      }

      return out;
    },
  },
];

module.exports = { items };

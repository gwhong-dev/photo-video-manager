// 파일 위치: scripts/check-content-hash.js
// 역할: 내용 지문 비교 점검 (67). scripts/check.js 의 ITEMS 끝에 붙어요
//   2026-11-23 태그를 파일에 쓰기 구현 1단계 (docs/decisions/2026-11-23-태그-파일에-쓰기.md)
//   백업 파일에 태그를 써서 바이트가 바뀌어도 ① 원본 정리에서 원본이 남지 않고 ② 같은 사진을 다시 가져올 때 _1 이 생기지 않는지
//   임시 폴더에 복사한 샘플로만 해요 (샘플 · 진짜 휴지통은 안 건드려요)
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const { sub } = require('./check-gallery');
const CH = require('../lib/content-hash');

const SAMPLES = path.join(__dirname, '..', 'test', 'samples', 'auto');

// 백업 파일에 태그 쓰기 흉내 (갤러리 · 탐색기가 하는 것처럼 XMP 에 키워드를 더해요)
const tagFile = (et, p, word = '가족') => et.write(['-overwrite_original', `-XMP-dc:Subject+=${word}`, p]);

const items = [
  {
    no: 67,
    name: '내용 지문 비교 (백업 파일에 태그를 써도 같은 사진으로 보기)',
    async run(env) {
      const out = [];
      const et = env.et;
      const dir = path.join(env.tmp, 'content-hash');
      fs.mkdirSync(dir, { recursive: true });
      const copy = (name, to) => {
        const p = path.join(dir, to);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.copyFileSync(path.join(SAMPLES, name), p);
        return p;
      };

      // 67a sameContent: 태그만 쓴 복사본(JPG · PNG · MOV)은 같음, 촬영 날짜를 바꾼 것 · 다른 사진 · 없는 파일은 다름
      const pairs = [];
      for (const name of ['IMG_0101.jpg', 'IMG_0102.PNG', 'IMG_0103.MOV']) {
        const src = copy(name, path.join('a', name));
        const tagged = copy(name, path.join('a', 'tagged-' + name));
        await tagFile(et, tagged);
        pairs.push([name, fs.statSync(src).size !== fs.statSync(tagged).size, (await CH.sameContent(et, src, tagged)).same]);
      }
      const srcA = path.join(dir, 'a', 'IMG_0101.jpg');
      const dated = copy('IMG_0101.jpg', path.join('a', 'dated.jpg'));
      await et.write(['-overwrite_original', '-DateTimeOriginal=2001:02:03 04:05:06', dated]);
      const other = copy('IMG_0104.jpg', path.join('a', 'other.jpg'));
      const rDated = await CH.sameContent(et, srcA, dated);
      const rOther = await CH.sameContent(et, srcA, other);
      const rGone = await CH.sameContent(et, srcA, path.join(dir, 'a', 'gone.jpg'));
      out.push(sub('67a 태그만 쓴 복사본은 크기가 달라도 같은 내용(JPG · PNG · MOV), 날짜를 바꾼 것 · 다른 사진은 다름(기록), 없는 파일은 다름(기록 안 함)',
        pairs.every(([, sizeDiff, same]) => sizeDiff && same)
          && !rDated.same && rDated.lasting && /정보\(.*DateTimeOriginal\)/.test(rDated.why)
          && !rOther.same && rOther.lasting
          && !rGone.same && !rGone.lasting,
        `${JSON.stringify(pairs)} / 날짜: ${rDated.why} / 다른 사진: ${rOther.why} / 없음: ${rGone.why}`));

      // 67b 원본 정리: 일반 중복의 백업 파일에 태그를 쓰면 → 내용 지문으로 같아 정리 대상 (sameContent 없으면 남김, 기록 안 함)
      //     날짜가 바뀐 백업이면 남기고 까닭 기록 (배너 후보에서 빠짐)
      {
        const cleaner = require('../lib/cleaner');
        const fakeStore = { mark: (j, i, patch) => Object.assign(j.items[i], patch) };
        const same = (a, b) => CH.sameContent(et, a, b);
        const src = copy('IMG_0101.jpg', path.join('b', 'src.jpg'));
        const keep = copy('IMG_0101.jpg', path.join('b', 'keep.jpg'));
        await tagFile(et, keep);
        const dupJob = () => ({ items: [{ i: 0, src, status: 'dup', dupOf: keep }] });
        const j1 = dupJob();
        const cand = cleaner.cleanCandidates(j1).length;
        const withCh = await cleaner.cleanTargets(j1, { store: fakeStore, sameContent: same });
        const j2 = dupJob();
        const without = await cleaner.cleanTargets(j2, { store: fakeStore });
        const keepDated = copy('IMG_0101.jpg', path.join('b', 'keep-dated.jpg'));
        await et.write(['-overwrite_original', '-DateTimeOriginal=2001:02:03 04:05:06', keepDated]);
        const j3 = { items: [{ i: 0, src, status: 'dup', dupOf: keepDated }] };
        const dated = await cleaner.cleanTargets(j3, { store: fakeStore, sameContent: same });
        out.push(sub('67b 일반 중복: 백업에 태그를 써서 크기가 달라도 후보이고, 내용 지문이 같으면 정리 대상. 비교 함수가 없으면 남김(기록 없음), 날짜가 바뀐 백업은 남기고 까닭 기록',
          cand === 1 && withCh.length === 1 && !j1.items[0].cleanSkip
            && without.length === 0 && !j2.items[0].cleanSkip
            && dated.length === 0 && /정보\(.*DateTimeOriginal\)/.test(j3.items[0].cleanSkip || '') && cleaner.cleanCandidates(j3).length === 0,
          `후보 ${cand} / 비교 ${withCh.length} / 없이 ${without.length} (${j2.items[0].cleanSkip || '기록 없음'}) / 날짜 ${dated.length} (${j3.items[0].cleanSkip || '기록 없음'})`));

        // 67c 완료 항목: 저장한 뒤 백업 파일에 태그를 쓰면 → 내용 지문으로 같아 정리 대상. 변환한 항목은 지금처럼 남김
        const dsrc = copy('IMG_0102.PNG', path.join('c', 'src.PNG'));
        const dkeep = copy('IMG_0102.PNG', path.join('c', 'keep.PNG'));
        const resultHash = await cleaner.hashFile(dkeep);
        await tagFile(et, dkeep);
        const doneJob = (over = {}) => ({ items: [{ i: 0, src: dsrc, status: 'done', finalPath: dkeep, resultHash, ...over }] });
        const j4 = doneJob();
        const done = await cleaner.cleanTargets(j4, { store: fakeStore, sameContent: same });
        const j5 = doneJob({ converted: true });
        const conv = await cleaner.cleanTargets(j5, { store: fakeStore, sameContent: same });
        const j6 = doneJob();
        const noCh = await cleaner.cleanTargets(j6, { store: fakeStore });
        out.push(sub('67c 완료 항목: 저장 뒤 백업에 태그를 써도 내용 지문이 같으면 정리 대상. 변환한 항목 · 비교 함수가 없으면 남김 (작업 기록엔 안 남김)',
          done.length === 1 && conv.length === 0 && noCh.length === 0 && !j5.items[0].cleanSkip && !j4.items[0].cleanSkip,
          `완료 ${done.length} / 변환 ${conv.length} / 없이 ${noCh.length}`));
      }

      // 67d 미리보기: 가져온 사진의 백업 파일에 태그를 쓴 뒤 같은 사진을 다시 가져오면 _1 이 아니라 "이미 있음"
      //     백업 파일의 날짜를 바꿨거나 다른 사진이면 그대로 _1 로 둘 다 보존
      {
        const { makePlan } = require('../lib/planner');
        const source = path.join(dir, 'd', 'src');
        const backupRoot = path.join(dir, 'd', 'backup');
        copy('IMG_0101.jpg', path.join('d', 'src', 'IMG_0101.jpg'));
        fs.mkdirSync(backupRoot, { recursive: true });
        const plan0 = await makePlan({ source, backupRoot, includeSub: true }, et);
        const it0 = plan0.items[0];
        const dest = it0 && it0.dest;
        const planWith = async (fill) => {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          await fill(dest);
          const r = (await makePlan({ source, backupRoot, includeSub: true }, et)).items[0];
          fs.rmSync(dest, { force: true });
          return r;
        };
        const tagged = await planWith(async (d) => {
          fs.copyFileSync(path.join(source, 'IMG_0101.jpg'), d);
          await tagFile(et, d);
        });
        const datedBk = await planWith(async (d) => {
          fs.copyFileSync(path.join(source, 'IMG_0101.jpg'), d);
          await et.write(['-overwrite_original', '-DateTimeOriginal=2001:02:03 04:05:06', d]);
        });
        const otherBk = await planWith(async (d) => fs.copyFileSync(path.join(SAMPLES, 'IMG_0104.jpg'), d));
        const show = (r) => (r ? `${r.status} ${r.name} ${r.note || ''}` : '없음');
        out.push(sub('67d 미리보기: 태그를 쓴 백업이 있으면 "이미 있음(태그 · 정보만 다름)" 중복, 날짜가 바뀐 백업 · 다른 사진이면 _1 로 둘 다 보존',
          !!dest && it0.status === 'todo'
            && tagged.status === 'dup' && keyOfSafe(tagged.dupOf) === keyOfSafe(dest) && /태그 · 정보만 다름/.test(tagged.note || '') && !tagged.check
            && datedBk.status === 'todo' && /_1\./.test(datedBk.name)
            && otherBk.status === 'todo' && /_1\./.test(otherBk.name),
          `처음: ${show(it0)} / 태그: ${show(tagged)} / 날짜: ${show(datedBk)} / 다른 사진: ${show(otherBk)}`));

        // 67e 실행 직전 다시 확인: 미리보기 뒤에 같은 자리에 태그 쓴 같은 사진이 생기면 "이미 있음"으로 하나 더 만들지 않음
        const { processItem } = require('../lib/processor');
        const it = { ...it0 };
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(source, 'IMG_0101.jpg'), dest);
        await tagFile(et, dest);
        let r;
        try {
          r = await processItem(it, env.ctx);
        } catch (e) {
          r = { status: 'error', note: e.message };
        }
        const extra = fs.readdirSync(path.dirname(dest)).filter((n) => /_1\./.test(n));
        out.push(sub('67e 실행 직전 확인: 같은 자리에 태그 쓴 같은 사진이 있으면 중복으로 보고 _1 을 만들지 않음',
          r.status === 'dup' && keyOfSafe(r.finalPath) === keyOfSafe(dest) && extra.length === 0,
          `${r.status} ${r.note || ''} / _1: ${extra.join(',') || '없음'}`));
      }
      return out;
    },
  },
];

// 경로 비교 (Windows 는 대소문자 무시)
function keyOfSafe(p) {
  if (!p) return '';
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

module.exports = { items };

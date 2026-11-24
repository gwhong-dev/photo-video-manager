// 파일 위치: scripts/check-video-hash.js
// 역할: 영상 화면 데이터 지문으로 중복 찾기 점검 (68). scripts/check.js 의 ITEMS 끝에 붙어요
//   2026-11-24 실사용: 이미 백업한 영상을 이름만 다르게(IMG_0103(1).MOV · 다른 폴더) 다시 가져오면 MP4 가 2개씩 저장됐어요
//   보통 아이폰 영상에는 애플 ID 가 없어서, 변환할 영상은 백업 MP4 와 내용 비교를 한 번도 안 했어요
//   임시 폴더에 복사한 샘플로만 해요 (샘플 · 진짜 휴지통은 안 건드려요)
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const { sub } = require('./check-gallery');
const skip = (label, detail) => ({ label, status: 'skip', detail });
const { videoStreamHash, runCmd } = require('../lib/tools');

const SAMPLES = path.join(__dirname, '..', 'test', 'samples', 'auto');

const items = [
  {
    no: 68,
    name: '영상 화면 데이터 지문으로 중복 찾기 (이름이 다른 같은 영상을 또 저장하지 않기)',
    async run(env) {
      const ffmpeg = env.tools.ffmpeg.ok ? env.tools.ffmpeg.path : null;
      if (!ffmpeg) return [skip('68 영상 지문', 'ffmpeg 없음')];
      const out = [];
      const { makePlan } = require('../lib/planner');
      const { processItem } = require('../lib/processor');
      const cleaner = require('../lib/cleaner');
      const dir = path.join(env.tmp, 'video-hash');
      const source = path.join(dir, 'src');
      const source2 = path.join(dir, 'src2');
      const backupRoot = path.join(dir, 'backup');
      for (const d of [source, source2, backupRoot]) fs.mkdirSync(d, { recursive: true });
      fs.copyFileSync(path.join(SAMPLES, 'IMG_0103.MOV'), path.join(source, 'IMG_0103.MOV'));
      const videoHashOf = (p) => videoStreamHash(ffmpeg, p);

      // 처음 가져오기: MOV → MP4 로 백업
      const plan1 = await makePlan({ source, backupRoot, includeSub: true }, env.et, () => {}, { videoHashOf });
      const it1 = plan1.items.find((x) => x.kind === 'mov2mp4');
      let r1 = null;
      if (it1) {
        try {
          r1 = await processItem({ ...it1 }, env.ctx);
        } catch (e) {
          r1 = { status: 'error', note: e.message };
        }
      }
      const mp4 = r1 && r1.finalPath;
      if (!mp4 || !fs.existsSync(mp4)) return [sub('68 처음 가져오기(MOV → MP4)', false, `${it1 ? it1.status : '변환 항목 없음'} ${(r1 && r1.note) || ''}`)];

      // 68a 지문: 원본 MOV 와 변환한 MP4 는 같고, 다른 영상 · 없는 파일 · ffmpeg 없음은 다름(null)
      const mov = path.join(source, 'IMG_0103.MOV');
      const other = path.join(dir, 'other.mp4');
      await runCmd(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10', '-pix_fmt', 'yuv420p', other]);
      const [hMov, hMp4, hOther, hGone, hNoTool] = [
        await videoHashOf(mov), await videoHashOf(mp4), await videoHashOf(other),
        await videoHashOf(path.join(dir, 'gone.MOV')), await videoStreamHash(null, mov),
      ];
      out.push(sub('68a 원본 MOV 와 변환한 MP4 의 화면 데이터 지문이 같고, 다른 영상은 다름. 없는 파일 · ffmpeg 없음은 null',
        !!hMov && hMov === hMp4 && !!hOther && hOther !== hMov && hGone === null && hNoTool === null,
        `MOV ${String(hMov).slice(0, 8)} / MP4 ${String(hMp4).slice(0, 8)} / 다른 영상 ${String(hOther).slice(0, 8)} / 없음 ${hGone} / 도구 없음 ${hNoTool}`));

      // 68b 미리보기: 같은 영상을 이름 · 폴더만 바꿔 다시 가져오면 "이미 있음"(영상 내용이 같은 …)
      //     지문 함수가 없거나 · 못 읽거나 · 지문이 다르면 예전처럼 저장할 항목(todo)
      const again = path.join(source2, 'IMG_0103(1).MOV');
      fs.copyFileSync(mov, again);
      const planOf = async (deps) => (await makePlan({ source: source2, backupRoot, includeSub: true }, env.et, () => {}, deps)).items[0];
      const dup = await planOf({ videoHashOf });
      const noFn = await planOf({});
      const noRead = await planOf({ videoHashOf: async () => null });
      const diff = await planOf({ videoHashOf: async (p) => (p === again ? 'a' : 'b') });
      const key = (p) => (p ? path.resolve(p).toLowerCase() : '');
      const show = (r) => (r ? `${r.status} ${r.name} ${r.note || ''}` : '없음');
      out.push(sub('68b 이름 · 폴더만 다른 같은 영상은 "이미 있음(영상 내용이 같은 …)", 지문 함수 없음 · 못 읽음 · 지문 다름이면 저장할 항목',
        !!dup && dup.status === 'dup' && dup.sameVideo === true && key(dup.dupOf) === key(mp4) && /영상 내용이 같은/.test(dup.note || '')
          && noFn.status === 'todo' && noRead.status === 'todo' && diff.status === 'todo' && !diff.sameVideo,
        `지문: ${show(dup)} / 함수 없음: ${show(noFn)} / 못 읽음: ${show(noRead)} / 다름: ${show(diff)}`));

      // 68c 원본 정리: 지문으로 찾은 중복은 후보이고, 정리 직전 지문이 같으면 정리 대상
      //     비교 함수가 없으면 남김(기록 없음), 백업 영상이 바뀌어 지문이 다르면 남기고 까닭 기록
      const fakeStore = { mark: (j, i, patch) => Object.assign(j.items[i], patch) };
      const ffprobe = env.tools.ffprobe.path; // 남길 영상이 재생되는지 확인하는 데 써요 (없으면 "확인 못 함 → 남김")
      const sameVideo = async (src, keep) => {
        const [a, b] = [await videoHashOf(src), await videoHashOf(keep)];
        if (!a || !b) return { same: false, why: '영상 내용 지문을 읽지 못해 남김', lasting: false };
        return a === b ? { same: true, why: '' } : { same: false, why: '백업 영상과 화면 데이터가 달라 남김', lasting: true };
      };
      const dupJob = (keep) => ({ items: [{ i: 0, src: again, status: 'dup', converted: true, sameVideo: true, dupOf: keep }] });
      const j1 = dupJob(mp4);
      const cand = cleaner.cleanCandidates(j1).length;
      const ok1 = await cleaner.cleanTargets(j1, { store: fakeStore, ffprobe, sameVideo });
      const j2 = dupJob(mp4);
      const ok2 = await cleaner.cleanTargets(j2, { store: fakeStore, ffprobe });
      const changed = path.join(dir, 'changed.mp4');
      fs.copyFileSync(other, changed);
      const j3 = dupJob(changed);
      const ok3 = await cleaner.cleanTargets(j3, { store: fakeStore, ffprobe, sameVideo });
      const j4 = { items: [{ i: 0, src: again, status: 'dup', converted: true, dupOf: mp4 }] }; // 지문 표시가 없는 변환 중복은 예전처럼 후보 아님
      out.push(sub('68c 원본 정리: 지문 중복은 후보이고 지문이 같으면 정리 대상. 비교 함수 없음은 남김(기록 없음), 지문이 다르면 남기고 까닭 기록',
        cand === 1 && ok1.length === 1 && !j1.items[0].cleanSkip
          && ok2.length === 0 && !j2.items[0].cleanSkip
          && ok3.length === 0 && /화면 데이터가 달라/.test(j3.items[0].cleanSkip || '')
          && cleaner.cleanCandidates(j4).length === 0,
        `후보 ${cand} / 같음 ${ok1.length} / 함수 없음 ${ok2.length} / 다름 ${ok3.length} (${j3.items[0].cleanSkip || '기록 없음'}) / 표시 없음 후보 ${cleaner.cleanCandidates(j4).length}`));
      return out;
    },
  },
];

module.exports = { items };

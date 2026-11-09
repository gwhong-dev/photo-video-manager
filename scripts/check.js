// 파일 위치: scripts/check.js
// 역할: 자동 점검 (npm run check) — docs/점검-푸시-절차.md 의 19개 항목
//
// ⚠️ 샘플(test/samples)은 절대 직접 쓰지 않아요.
//    임시 폴더(%TEMP%\pvm-check-시각)에 복사한 뒤 그 복사본으로만 실행해요.
//    휴지통·드라이브 종류·남은 공간은 "가짜 함수"로 바꿔 끼워서 시험해요 → 진짜 휴지통은 안 건드림.
//
// 결과: ✅ 통과 / ❌ 실패 / ⏭ 건너뜀 (❌가 하나라도 있으면 종료 코드 1)

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { detectTools, runCmd, probeVideo } = require('../lib/tools');
const { ExifTool } = require('../lib/exiftool');
const { makePlan, statusLabelOf, isIssue } = require('../lib/planner');
const { JobStore, jobStats } = require('../lib/job');
const { createLogger, stamp } = require('../lib/logger');
const runner = require('../lib/runner');
const { launchCheck } = require('./launch-check');

const APP = path.join(__dirname, '..');
const SAMPLES = path.join(APP, 'test', 'samples');
const AUTO = path.join(SAMPLES, 'auto');
const MANUAL = path.join(SAMPLES, 'manual');

// 자동 샘플의 기대 결과 (백업 폴더 기준)
const EXPECT = {
  'IMG_0101.jpg': '2026/10/28/2026-10-28_134058_IMG_0101.jpg', // dup/IMG_0101.jpg 와 둘 중 하나가 이 자리
  'other/IMG_0101.jpg': '2026/10/28/2026-10-28_134058_IMG_0101_1.jpg',
  '여행 사진/2026-10-28_13-41-05_여행.jpg': '2026/10/28/2026-10-28_134105_여행.jpg',
  'KakaoTalk_20261028_210941.jpg': '2026/10/28/2026-10-28_210941_KakaoTalk_20261028_210941.jpg',
  'IMG_0102.PNG': '2026/10/27/2026-10-27_091500_IMG_0102.png',
  'IMG_0103.MOV': '2026/10/28/2026-10-28_134113_IMG_0103.mp4',
  'noinfo.jpg': '_날짜없음/noinfo.jpg',
};

// ---------- 도우미 ----------
const slash = (p) => p.split(path.sep).join('/');
const sub = (label, ok, detail = '') => ({ label, status: ok ? 'ok' : 'fail', detail });
const skip = (label, detail) => ({ label, status: 'skip', detail });

function sha1(p) {
  return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
}
function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath || e.path, e.name));
}
function hashAll(dir) {
  const m = {};
  for (const f of listFiles(dir)) m[slash(path.relative(dir, f))] = sha1(f);
  return m;
}
function hasManual() {
  return listFiles(MANUAL).length > 0;
}

// 샘플을 임시 폴더로 복사 (auto는 source 바로 아래, manual은 source\manual)
function copySamples(root, { manual = true } = {}) {
  const source = path.join(root, 'source');
  fs.cpSync(AUTO, source, { recursive: true, preserveTimestamps: true });
  if (manual && hasManual()) fs.cpSync(MANUAL, path.join(source, 'manual'), { recursive: true, preserveTimestamps: true });
  return source;
}

// 미리보기 → 작업 저장 → 실행 (진짜 프로그램과 같은 순서)
async function pipeline(root, env, { batchSize = 100000, manual = true, run = true, statfs } = {}) {
  const source = copySamples(root, { manual });
  const backupRoot = path.join(root, 'backup');
  fs.mkdirSync(backupRoot, { recursive: true });
  const logger = createLogger(path.join(root, 'logs'));
  const plan = await makePlan({ source, backupRoot, includeSub: true }, env.et);
  const store = new JobStore(path.join(root, 'jobs'));
  const job = store.create(plan);
  runner.writePlanLog(job, logger);
  const result = run ? await runner.runBatch({ job, store, batchSize, ctx: env.ctx, logger, statfs }) : null;
  return { root, source, backupRoot, logger, store, job, result };
}

// 가짜 손상 영상 만들기: 목차(moov)를 지우고 끝을 0으로 채워요 (실제 IMG_2522.mp4와 같은 모양)
//   MP4·MOV는 [길이 4바이트 + 이름 4바이트 + 내용] 상자가 이어진 모양이에요
function breakVideo(from, to, zeros) {
  const buf = fs.readFileSync(from);
  const keep = [];
  for (let p = 0; p + 8 <= buf.length; ) {
    const size = buf.readUInt32BE(p);
    if (size < 8) break;
    if (buf.toString('latin1', p + 4, p + 8) !== 'moov') keep.push(buf.subarray(p, p + size));
    p += size;
  }
  fs.writeFileSync(to, Buffer.concat([...keep, Buffer.alloc(zeros)]));
}

// 원본 상대 경로 → 그 파일의 item
function itemOf(p, rel) {
  return p.job.items.find((it) => slash(path.relative(p.source, it.src)) === rel);
}
// item의 결과 파일 (백업 폴더 기준 상대 경로)
function resultOf(p, it) {
  return it && it.finalPath ? slash(path.relative(p.backupRoot, it.finalPath)) : null;
}
function expectPath(p, rel) {
  const it = itemOf(p, rel);
  const got = resultOf(p, it);
  return sub(rel, got === EXPECT[rel], got === EXPECT[rel] ? got : `기대 ${EXPECT[rel]} / 실제 ${got || (it ? it.status + ' ' + (it.note || '') : '없음')}`);
}

// ---------- 점검 항목 ----------
const ITEMS = [
  {
    no: 1,
    name: '앱 실행',
    async run(env) {
      // 가져오기 화면으로 띄워서 도구 표시를 확인해요. 임시 userData를 써서 진짜 설정을 읽지 않아요
      const userData = path.join(env.tmp, 'launch-import');
      fs.mkdirSync(userData, { recursive: true });
      const r = await launchCheck(APP, { env: { PVM_USER_DATA: userData, PVM_START_SCREEN: 'import' } });
      return [
        sub('창이 뜨고 정상 종료', r.exitCode === 0 && r.title === '사진/영상 관리 프로그램', `제목 "${r.title}", 종료 코드 ${r.exitCode}`),
        sub('화면 오류 없음', r.errors.length === 0, r.errors.join(' / ')),
        sub('도구 ✅ 3개', ['✅ exiftool', '✅ ImageMagick', '✅ FFmpeg'].every((t) => r.text.includes(t))),
      ];
    },
  },
  {
    no: 2,
    name: '외부 도구',
    async run(env) {
      const t = env.tools;
      const out = ['exiftool', 'magick', 'ffmpeg', 'ffprobe'].map((n) => sub(n, t[n].ok, t[n].version || '찾지 못함'));
      if (t.magick.ok) {
        const r = await runCmd(t.magick.path, ['-list', 'format']);
        out.push(sub('HEIC 읽기', /^\s*HEIC\s+HEIC\s+r/m.test(r.stdout)));
      }
      return out;
    },
  },
  {
    no: 3,
    name: '샘플 정리',
    async run(env) {
      const p = env.full;
      const fails = p.job.items.filter((it) => it.status === 'fail');
      const after = hashAll(SAMPLES);
      const same = JSON.stringify(after) === JSON.stringify(env.samplesBefore);
      return [
        sub(`전체 ${p.job.items.length}개 처리, 실패 0개`, fails.length === 0, fails.map((it) => `${path.basename(it.src)}: ${it.note}`).join(' / ')),
        sub('test/samples 원본 그대로', same),
      ];
    },
  },
  {
    no: 4,
    name: '폴더 구조',
    async run(env) {
      const p = env.full;
      const bad = p.job.items
        .map((it) => resultOf(p, it))
        .filter((r) => r && !/^(\d{4}\/\d{2}\/\d{2}|_날짜없음)\/[^/]+$/.test(r));
      const out = [sub('모든 결과가 YYYY/MM/DD 또는 _날짜없음 바로 아래', bad.length === 0, bad.join(' / '))];
      for (const rel of ['여행 사진/2026-10-28_13-41-05_여행.jpg', 'IMG_0102.PNG', 'KakaoTalk_20261028_210941.jpg']) {
        const got = resultOf(p, itemOf(p, rel));
        out.push(sub(rel, got && path.posix.dirname(got) === path.posix.dirname(EXPECT[rel]), got || '결과 없음'));
      }
      return out;
    },
  },
  {
    no: 5,
    name: '파일 이름',
    async run(env) {
      const p = env.full;
      const pair = ['IMG_0101.jpg', 'dup/IMG_0101.jpg'].map((r) => resultOf(p, itemOf(p, r)));
      return [
        sub('IMG_0101 (둘 중 하나)', pair.includes(EXPECT['IMG_0101.jpg']), pair.join(' / ')),
        expectPath(p, '여행 사진/2026-10-28_13-41-05_여행.jpg'),
        expectPath(p, 'KakaoTalk_20261028_210941.jpg'),
        expectPath(p, 'IMG_0102.PNG'),
      ];
    },
  },
  {
    no: 6,
    name: '영상 날짜',
    async run(env) {
      return [expectPath(env.full, 'IMG_0103.MOV')];
    },
  },
  {
    no: 7,
    name: '변환',
    async run(env) {
      const p = env.full;
      const out = [];
      // MOV → MP4
      const mov = itemOf(p, 'IMG_0103.MOV');
      if (!mov || !mov.finalPath) {
        out.push(sub('MOV → MP4', false, '결과 없음'));
      } else {
        const codec = async (f) => (await runCmd(env.tools.ffprobe.path, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', f])).stdout.trim();
        const [c1, c2] = [await codec(mov.src), await codec(mov.finalPath)];
        out.push(sub('MP4 영상 다시 압축 안 함', c1 && c1 === c2, `${c1} → ${c2}`));
        const [m] = await env.et.read([mov.finalPath], ['XMP-dc:Subject', 'Keys:CreationDate']);
        const subj = [].concat(m.Subject || []).join(', ');
        out.push(sub('MP4에 XMP 태그(dc:subject)', subj === '비디오, 수원시', subj || '없음'));
        out.push(sub('MP4에 Keys:CreationDate', !!m.CreationDate, m.CreationDate || '없음'));
      }
      // HEIC → JPG (수동 샘플)
      const heics = p.job.items.filter((it) => it.kind === 'heic2jpg');
      if (!heics.length) {
        out.push(skip('HEIC → JPG', '수동 샘플 없음'));
      } else {
        for (const it of heics) {
          const name = path.basename(it.src);
          if (!it.finalPath || !fs.existsSync(it.finalPath)) {
            out.push(sub(`HEIC → JPG: ${name}`, false, `결과 없음 (${it.status} ${it.note || ''})`));
            continue;
          }
          const [src] = await env.et.read([it.src], ['DateTimeOriginal']);
          const [dst] = await env.et.read([it.finalPath], ['Orientation#', 'DateTimeOriginal']);
          out.push(sub(`HEIC → JPG: ${name}`, dst.Orientation === 1 && dst.DateTimeOriginal === src.DateTimeOriginal, `방향 ${dst.Orientation}, 날짜 ${dst.DateTimeOriginal}`));
        }
      }
      // 라이브 포토 (같은 이름의 HEIC + MOV)
      const base = (it) => path.join(path.dirname(it.src), path.basename(it.src, path.extname(it.src))).toLowerCase();
      const pairs = heics.filter((h) => p.job.items.some((v) => v.kind === 'mov2mp4' && base(v) === base(h)));
      if (!pairs.length) {
        out.push(skip('라이브 포토 (HEIC + MOV)', '수동 샘플 없음'));
      } else {
        for (const h of pairs) {
          const v = p.job.items.find((x) => x.kind === 'mov2mp4' && base(x) === base(h));
          const ok = [h, v].every((x) => x.finalPath && fs.existsSync(x.finalPath));
          out.push(sub(`라이브 포토: ${path.basename(base(h))}`, ok, [h, v].map((x) => resultOf(p, x) || `${x.status} ${x.note || ''}`).join(' + ')));
        }
      }
      return out;
    },
  },
  {
    no: 8,
    name: '중복',
    async run(env) {
      const p = env.full;
      const st = ['IMG_0101.jpg', 'dup/IMG_0101.jpg'].map((r) => (itemOf(p, r) || {}).status).sort();
      // 이름만 다른 같은 파일 (Windows 복사본 "(1)") → 하나만 저장
      const st2 = ['IMG_0104.jpg', 'IMG_0104(1).jpg'].map((r) => (itemOf(p, r) || {}).status).sort();
      // 백업에 이미 있는 파일과 내용이 같은데 이름이 다름 → 중복
      const src2 = path.join(env.tmp, 'dup-existing', 'source');
      fs.mkdirSync(src2, { recursive: true });
      fs.copyFileSync(path.join(AUTO, 'IMG_0101.jpg'), path.join(src2, '사본_IMG_0101.jpg'));
      const plan2 = await makePlan({ source: src2, backupRoot: p.backupRoot, includeSub: true }, env.et);
      const it2 = plan2.items[0];
      const out = [
        sub('같은 파일 2개 → 완료 1 + 중복 1', st.join(',') === 'done,dup', st.join(',')),
        sub('이름만 다른 같은 파일 IMG_0104 / IMG_0104(1) → 완료 1 + 중복 1', st2.join(',') === 'done,dup', st2.join(',')),
        sub('백업에 이미 있는 같은 내용(다른 이름) → 중복', it2.status === 'dup' && !!it2.dupOf && fs.existsSync(it2.dupOf), `${it2.status} ${it2.note || ''}`),
        expectPath(p, 'other/IMG_0101.jpg'),
      ];

      // 8a 사용자 결정 (2026-11-04, M4): 이전 작업에서 변환을 끝낸 원본(경로, 크기, 수정 시각이 같음)은 다시 미리보기해도 _1을 만들지 않고 "이미 정리됨"
      {
        const { priorKey } = require('../lib/planner');
        const root8 = path.join(env.tmp, 'prior-results');
        const src8 = path.join(root8, 'source');
        const bk8 = path.join(root8, 'backup');
        fs.mkdirSync(src8, { recursive: true });
        const heic = path.join(src8, '2026-01-02_030405_NOID.heic'); // 애플 ID 없는 변환 파일 (내용은 가짜)
        fs.writeFileSync(heic, 'fake heic');
        const stH = fs.statSync(heic);
        const result = path.join(bk8, '2026', '01', '02', '2026-01-02_030405_NOID.jpg');
        fs.mkdirSync(path.dirname(result), { recursive: true });
        fs.writeFileSync(result, 'converted before');
        // 보관 작업 1개 (수정 시각 있음) + 옛 작업 1개 (수정 시각 없음 → 쓰지 않음)
        const store8 = new JobStore(path.join(root8, 'jobs'));
        const old = store8.create({ items: [{ i: 0, src: heic, size: stH.size, converted: true, status: 'todo' }] });
        store8.mark(old, 0, { status: 'done', finalPath: path.join(bk8, 'old.jpg') });
        store8.close('replaced');
        const j8 = store8.create({ items: [{ i: 0, src: heic, size: stH.size, srcMtimeMs: stH.mtimeMs, converted: true, status: 'todo' }] });
        store8.mark(j8, 0, { status: 'done', finalPath: result });
        store8.close('replaced');
        const prior = store8.priorResults(priorKey);
        out.push(sub('8a 보관 작업에서 변환을 끝낸 원본 기록을 읽음 (수정 시각이 없는 옛 기록은 안 씀)',
          prior.size === 1 && prior.get(priorKey(heic, stH.size, stH.mtimeMs)) === result, JSON.stringify([...prior])));
        const again = (await makePlan({ source: src8, backupRoot: bk8, includeSub: true }, env.et, () => {}, { priorResults: prior })).items[0];
        const without = (await makePlan({ source: src8, backupRoot: bk8, includeSub: true }, env.et)).items[0];
        out.push(sub('8a 다시 미리보기: 이전 결과가 있으면 "이미 정리됨"(정리 대상 아님), 기록이 없으면 예전처럼 _1',
          again.status === 'skip' && !again.check && again.note.includes('이전 작업에서 이미 변환함') && without.status === 'todo' && /_1\.jpg$/.test(without.name),
          `${again.status} ${again.note} / ${without.status} ${without.name}`));
        fs.utimesSync(heic, new Date(), new Date(Date.now() - 3600 * 1000)); // 원본이 그 사이 바뀜 (수정 시각 다름)
        const changed = (await makePlan({ source: src8, backupRoot: bk8, includeSub: true }, env.et, () => {}, { priorResults: prior })).items[0];
        fs.rmSync(result);
        fs.utimesSync(heic, stH.atime, stH.mtime);
        const gone = (await makePlan({ source: src8, backupRoot: bk8, includeSub: true }, env.et, () => {}, { priorResults: prior })).items[0];
        out.push(sub('8a 원본 수정 시각이 다르거나 이전 결과 파일이 없으면 건너뛰지 않음 (새로 변환)',
          changed.status === 'todo' && gone.status === 'todo', `${changed.status} / ${gone.status}`));
        const cached = store8.priorResults(priorKey);
        out.push(sub('8a 보관 작업이 그대로면 다시 읽지 않고 지난 결과를 씀', cached === store8.priorResults(priorKey) && cached.size === 1));
      }

      // 8b 사용자 결정 (2026-11-04, 열린 질문 5): 변환된 중복은 애플 ID, 촬영 날짜, 가로×세로가 모두 같을 때만 원본 정리 대상
      {
        const cleaner = require('../lib/cleaner');
        const { keyOf } = require('../lib/planner');
        const root8 = path.join(env.tmp, 'converted-dup');
        fs.mkdirSync(root8, { recursive: true });
        const src = path.join(root8, 'IMG_1.HEIC');
        const keep = path.join(root8, 'kept.jpg');
        fs.writeFileSync(src, 'heic bytes');
        fs.writeFileSync(keep, 'jpg bytes, different size');
        const base = { ContentIdentifier: 'ABC', DateTimeOriginal: '2026:01:02 03:04:05', ImageWidth: 4032, ImageHeight: 3024, SubSecTimeOriginal: '123', ModifyDate: '2026:01:02 03:04:05' };
        const reader = (a, b) => async () => new Map([[keyOf(src), { ...base, ...a }], [keyOf(keep), { ...base, ...b }]]);
        const ok = (a = {}, b = {}) => cleaner.convertedDupOk({ src }, keep, reader(a, b));
        out.push(sub('8b 애플 ID, 촬영 날짜, 가로×세로가 같으면 같은 촬영 (세로로 돌린 것도). 하나라도 다르거나 모르면, ImageUniqueID만 같으면, 0.001초나 수정 시각이 다르면 아님',
          (await ok()) && (await ok({}, { ImageWidth: 3024, ImageHeight: 4032 }))
            && !(await ok({}, { ContentIdentifier: 'XYZ' })) && !(await ok({}, { ContentIdentifier: undefined }))
            && !(await ok({}, { DateTimeOriginal: '2026:01:02 03:04:06' })) && !(await ok({}, { ImageWidth: 4000 }))
            && !(await ok({}, { ImageWidth: undefined }))
            && !(await ok({ ContentIdentifier: undefined, ImageUniqueID: 'SAME' }, { ContentIdentifier: undefined, ImageUniqueID: 'SAME' }))
            && !(await ok({}, { SubSecTimeOriginal: '456' })) && !(await ok({}, { ModifyDate: '2026:05:05 00:00:00' }))
            && !(await cleaner.convertedDupOk({ src }, keep, async () => { throw new Error('exiftool 없음'); }))));
        const item = (over) => ({ i: 0, src, status: 'dup', converted: true, dupOf: keep, ...over });
        const jobOf = (it) => ({ items: [it] });
        const quick = [item({}), item({ sameShot: true }), item({ sameShot: true, check: true })].map((it) => cleaner.cleanCandidates(jobOf(it)).length);
        const strictNo = await cleaner.cleanTargets(jobOf(item({ sameShot: true })), {});
        const strictYes = await cleaner.cleanTargets(jobOf(item({ sameShot: true })), { readMeta: reader({}, {}) });
        const strictDiff = await cleaner.cleanTargets(jobOf(item({ sameShot: true })), { readMeta: reader({}, { DateTimeOriginal: '2020:01:01 00:00:00' }) });
        out.push(sub('8b 정리 대상: 애플 ID로 같은 촬영이 된 변환 중복만 후보, 정리 직전에 정보를 다시 읽어 맞을 때만 (못 읽으면 남김)',
          quick.join(',') === '0,1,0' && strictNo.length === 0 && strictYes.length === 1 && strictDiff.length === 0,
          `${quick.join(',')} / ${strictNo.length} ${strictYes.length} ${strictDiff.length}`));
      }
      return out;
    },
  },
  {
    no: 9,
    name: '날짜 없음',
    async run(env) {
      return [expectPath(env.full, 'noinfo.jpg')];
    },
  },
  {
    no: 10,
    name: '이어하기',
    async run(env) {
      const root = path.join(env.tmp, 'resume');
      const p = await pipeline(root, env, { batchSize: 3, manual: false });
      const first = p.result.handled;
      // 프로그램을 껐다 켠 것처럼: 저장된 작업을 디스크에서 다시 불러오기
      const store2 = new JobStore(path.join(root, 'jobs'));
      const job2 = store2.load();
      const leftBefore = job2.items.filter((it) => it.status === 'todo').length;
      await runner.runBatch({ job: job2, store: store2, batchSize: 100000, ctx: env.ctx, logger: p.logger });
      const leftAfter = job2.items.filter((it) => it.status === 'todo').length;
      // run 로그에서 파일마다 몇 번 처리됐는지 세기
      const counts = {};
      for (const f of listFiles(path.join(root, 'logs')).filter((f) => path.basename(f).startsWith('run_'))) {
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
          const cols = line.split('\t');
          if (['완료', '중복', '실패'].includes(cols[1])) counts[cols[2]] = (counts[cols[2]] || 0) + 1;
        }
      }
      const twice = Object.entries(counts).filter(([, n]) => n > 1).map(([f]) => path.basename(f));
      const total = p.job.stats.todo; // 미리보기 때 정한 처리 예정 개수 (중복으로 정해진 건 빠짐)
      return [
        sub('1회차 3개만 처리', first === 3, `${first}개`),
        sub('다시 불러온 뒤 남은 것만 처리', leftBefore === total - 3 && leftAfter === 0, `남은 것 ${leftBefore} → ${leftAfter}`),
        sub('같은 파일을 두 번 처리 안 함', twice.length === 0 && Object.keys(counts).length === total, twice.join(' / ') || `${Object.keys(counts).length}개 한 번씩`),
      ];
    },
  },
  {
    no: 11,
    name: '로그',
    async run(env) {
      const names = listFiles(path.join(env.full.root, 'logs')).map((f) => path.basename(f));
      return [
        sub('plan 로그', names.some((n) => /^plan_.*\.txt$/.test(n)), names.join(', ')),
        sub('run 로그', names.some((n) => /^run_.*\.txt$/.test(n))),
      ];
    },
  },
  {
    no: 12,
    name: '안전',
    async run(env) {
      let cleaner = null;
      try {
        cleaner = require('../lib/cleaner');
      } catch (e) {
        // 아직 없음
      }
      const out = [];
      const root = path.join(env.tmp, 'safety');
      const missing = (fn) => sub(fn, false, '아직 없음');

      // 원본 정리 시험용 작은 작업 만들기 (가짜 원본 + 결과 파일)
      const makeCase = (name) => {
        const dir = path.join(root, name);
        const source = path.join(dir, 'source');
        const backup = path.join(dir, 'backup');
        fs.mkdirSync(path.join(source, 'sub'), { recursive: true });
        fs.mkdirSync(backup, { recursive: true });
        const w = (p, s) => (fs.writeFileSync(p, s), p);
        const items = [
          { i: 0, src: w(path.join(source, 'sub', 'a.jpg'), 'A'), status: 'done', finalPath: w(path.join(backup, 'a.jpg'), 'A') },
          { i: 1, src: w(path.join(source, 'b.jpg'), 'B'), status: 'dup', dupOf: w(path.join(backup, 'b.jpg'), 'B') }, // 같은 내용 → 대상
          { i: 2, src: w(path.join(source, 'c.jpg'), 'C'), status: 'dup', check: true, dupOf: w(path.join(backup, 'c.jpg'), 'C') }, // 확인 필요 → 제외
          { i: 3, src: w(path.join(source, 'd.heic'), 'D-heic'), status: 'dup', dupOf: w(path.join(backup, 'd.jpg'), 'D-jpg') }, // 변환 중복 → 제외
          { i: 4, src: w(path.join(source, 'e.jpg'), 'E'), status: 'dup', dupOf: path.join(backup, 'e.jpg') }, // 남길 파일 없음 → 제외
        ];
        const job = { source, backupRoot: backup, items };
        const store = { mark: (j, i, patch) => Object.assign(j.items[i], patch) }; // 가짜 저장소
        return { dir, source, backup, job, store, logger: createLogger(path.join(dir, 'logs')) };
      };

      // 12a 휴지통 없는 드라이브 → 이동 (같은 이름이 이미 있으면 _1)
      if (!cleaner || !cleaner.cleanOriginals) {
        out.push(missing('12a 휴지통 없는 드라이브 → _정리완료원본으로 이동'));
      } else {
        const c = makeCase('12a');
        const already = path.join(c.source, '_정리완료원본', 'sub', 'a.jpg');
        fs.mkdirSync(path.dirname(already), { recursive: true });
        fs.writeFileSync(already, 'OLD');
        const trashed = [];
        const targets = [c.job.items[0], c.job.items[1]];
        const r = await cleaner.cleanOriginals({ job: c.job, store: c.store, targets, logger: c.logger, trash: async (p) => trashed.push(p), driveKindOf: async () => 'removable' });
        const moved = [path.join(c.source, '_정리완료원본', 'sub', 'a_1.jpg'), path.join(c.source, '_정리완료원본', 'b.jpg')];
        const ok =
          trashed.length === 0 &&
          moved.every((m) => fs.existsSync(m)) &&
          !fs.existsSync(targets[0].src) &&
          fs.readFileSync(already, 'utf8') === 'OLD' &&
          r.moved === 2;
        out.push(sub('12a 휴지통 없는 드라이브 → _정리완료원본으로 이동', ok, `휴지통 ${trashed.length}번, 이동 ${r.moved}개`));
        const logs = listFiles(path.join(c.dir, 'logs')).map((f) => path.basename(f));
        out.push(sub('12a 정리 로그 이름 clean_', logs.some((n) => /^clean_.*\.txt$/.test(n)), logs.join(', ')));

        // 12e 다시 미리보기 → _정리완료원본 안의 파일은 안 읽음
        const plan = await makePlan({ source: c.source, backupRoot: c.backup, includeSub: true }, env.et);
        const inside = plan.items.filter((it) => slash(it.src).includes('/_정리완료원본/'));
        out.push(sub('12e 다시 가져오기 때 _정리완료원본 건너뜀', inside.length === 0, `${inside.length}개 읽음`));
      }

      // 12b 휴지통 있는 드라이브(고정 디스크) → 휴지통 함수 호출
      if (!cleaner || !cleaner.cleanOriginals) {
        out.push(missing('12b 고정 디스크 → 휴지통'));
      } else {
        const c = makeCase('12b');
        const trashed = [];
        const targets = [c.job.items[0], c.job.items[1]];
        const r = await cleaner.cleanOriginals({ job: c.job, store: c.store, targets, logger: c.logger, trash: async (p) => trashed.push(p), driveKindOf: async () => 'fixed' });
        out.push(sub('12b 고정 디스크 → 휴지통', trashed.length === 2 && r.trashed === 2 && r.moved === 0, `휴지통 ${trashed.length}번`));
      }

      // 12c 정리 대상: 같은 해시 파일이 있는 중복만
      if (!cleaner || !cleaner.cleanTargets) {
        out.push(missing('12c 중복은 같은 해시 파일이 있을 때만 정리 대상'));
      } else {
        const c = makeCase('12c');
        const t = (await cleaner.cleanTargets(c.job)).map((it) => it.i).sort();
        out.push(sub('12c 중복은 같은 해시 파일이 있을 때만 정리 대상', t.join(',') === '0,1', `대상 ${t.join(',') || '없음'} (기대 0,1)`));
      }

      // 12d 남은 공간 부족 → 실행 안 함 / 80% 넘으면 경고
      if (!runner.checkSpace) {
        out.push(missing('12d 공간 부족이면 실행 중단'));
      } else {
        const tiny = () => ({ bsize: 1, blocks: 1e12, bavail: 10, bfree: 10 });
        const p = await pipeline(path.join(root, '12d'), env, { manual: false, run: false });
        const r = await runner.runBatch({ job: p.job, store: p.store, batchSize: 100000, ctx: env.ctx, logger: p.logger, statfs: tiny });
        const untouched = p.job.items.every((it) => it.status !== 'done');
        out.push(sub('12d 공간 부족이면 실행 중단', r.handled === 0 && !!r.stopped && untouched, `처리 ${r.handled}개, ${r.stopped || '멈추지 않음'}`));
        const busy = () => ({ bsize: 1, blocks: 1e12, bavail: 1e11, bfree: 1e11 }); // 90% 사용 중
        const s = runner.checkSpace(p.job.items, p.backupRoot, busy);
        out.push(sub('12d 사용률 80% 넘으면 경고', s.ok && !!s.warning, s.warning || '경고 없음'));
      }

      // 12g 가져올 폴더 고르기 규칙 (H2): 같은 폴더, 백업 안쪽, 백업을 포함하는 상위, 후가공 폴더, 다른 경로(연결)로 본 백업 → 거부
      let paths = null;
      try {
        paths = require('../lib/paths');
      } catch (e) {
        // 아직 없음
      }
      if (!paths || !paths.validateFolders) {
        out.push(missing('12g 가져올 폴더 고르기 규칙'));
      } else {
        const x = path.join(root, '12g');
        const backup = path.join(x, 'backup');
        const mk = (...p) => (fs.mkdirSync(path.join(x, ...p), { recursive: true }), path.join(x, ...p));
        mk('backup', '2026');
        mk('source');
        mk('백업', '2025년도', 'sub');
        const alias = path.join(x, 'alias');
        fs.symlinkSync(path.join(backup, '2026'), alias, 'junction'); // 백업\2026을 다른 이름으로 보는 연결
        const cases = [
          ['평범한 옆 폴더 → 허용', path.join(x, 'source'), true],
          ['백업 폴더 자신', backup, false],
          ['백업 폴더 안쪽', path.join(backup, '2026'), false],
          ['백업을 포함하는 상위 폴더', x, false],
          ['후가공 폴더 2025년도', path.join(x, '백업', '2025년도'), false],
          ['후가공 폴더의 하위', path.join(x, '백업', '2025년도', 'sub'), false],
          ['연결(junction)로 본 백업 안쪽', alias, false],
        ];
        const wrong = cases.filter(([, src, expectOk]) => {
          const r = paths.validateFolders(src, backup);
          return r.ok !== expectOk || (!r.ok && !r.reason);
        });
        out.push(sub('12g 가져올 폴더 고르기 규칙', wrong.length === 0, wrong.map(([n]) => n).join(' / ') || `${cases.length}가지 모두 맞음`));
        // 고르는 순간 확인: 저장된 백업 폴더가 없어도(USB 뺌) 가져올 폴더 선택은 막지 않음 (미리보기 때 다시 확인)
        const pick = paths.validatePick ? paths.validatePick(path.join(x, 'source'), path.join(x, '없는-백업')) : { ok: false };
        out.push(sub('12g 백업 폴더가 없어도 가져올 폴더는 고를 수 있음', pick.ok === true, pick.reason || ''));
      }

      // 12h 같은 파일을 다른 경로로 볼 때 (H1): 자기 자신을 "중복"으로 보지 않고, 정리 대상에도 안 넣음
      {
        const p = env.full;
        const alias = path.join(root, '12h-alias');
        fs.mkdirSync(root, { recursive: true });
        fs.symlinkSync(p.backupRoot, alias, 'junction'); // 백업 폴더를 다른 이름으로 보는 연결
        const plan = await makePlan({ source: alias, backupRoot: p.backupRoot, includeSub: true }, env.et);
        const selfDup = plan.items.filter((it) => it.status !== 'skip');
        out.push(sub('12h 다른 경로로 본 같은 파일 → 이미 정리됨(skip)', selfDup.length === 0, selfDup.map((it) => `${path.basename(it.src)}: ${it.status} ${it.note || ''}`).slice(0, 3).join(' / ') || `${plan.items.length}개 모두 skip`));

        // 정리 단계에서도 한 번 더 막기: 남길 파일이 원본과 같은 파일(다른 경로)이면 대상 아님
        if (!cleaner || !cleaner.cleanTargets) {
          out.push(missing('12h 남길 파일 = 원본(다른 경로) → 정리 대상 아님'));
        } else {
          const done = p.job.items.find((it) => it.status === 'done' && it.finalPath);
          const viaAlias = path.join(alias, path.relative(p.backupRoot, done.finalPath));
          const fake = { source: alias, backupRoot: p.backupRoot, items: [{ i: 0, src: viaAlias, status: 'dup', dupOf: done.finalPath, size: 1 }] };
          const t = await cleaner.cleanTargets(fake);
          out.push(sub('12h 남길 파일 = 원본(다른 경로) → 정리 대상 아님', t.length === 0, `대상 ${t.length}개`));
        }
      }

      // 12i 휴지통 함수가 실패하면 → 영구 삭제하지 않고 이동 (M1)
      if (!cleaner || !cleaner.cleanOriginals) {
        out.push(missing('12i 휴지통 실패 → 이동'));
      } else {
        const c = makeCase('12i');
        const targets = [c.job.items[0], c.job.items[1]];
        const r = await cleaner.cleanOriginals({
          job: c.job, store: c.store, targets, logger: c.logger,
          trash: async () => { throw new Error('가짜 휴지통 실패'); },
          driveKindOf: async () => 'fixed',
        });
        const movedOk = targets.every((it) => !fs.existsSync(it.src) && it.movedTo && fs.existsSync(it.movedTo));
        out.push(sub('12i 휴지통 실패 → _정리완료원본으로 이동', r.moved === 2 && r.trashed === 0 && movedOk, `휴지통 ${r.trashed}, 이동 ${r.moved}, 실패 ${r.fail}`));

        // 휴지통이 "실패"라고 했는데 원본이 이미 사라졌다면 → 어디로 갔는지 모르니 이동하지 않고 실패로 남김
        const c2 = makeCase('12i-gone');
        const gone = c2.job.items[0];
        const elsewhere = path.join(c2.dir, 'somewhere-else.jpg');
        const r2 = await cleaner.cleanOriginals({
          job: c2.job, store: c2.store, targets: [gone], logger: c2.logger,
          trash: async (p) => { fs.renameSync(p, elsewhere); throw new Error('가짜: 옮겨 놓고 실패라고 함'); },
          driveKindOf: async () => 'fixed',
        });
        const nothingMoved = !fs.existsSync(path.join(c2.source, '_정리완료원본'));
        out.push(sub('12i 휴지통 실패 + 원본 사라짐 → 이동 안 하고 실패로 기록', r2.fail === 1 && r2.moved === 0 && nothingMoved && !gone.movedTo, `실패 ${r2.fail}, 이동 ${r2.moved}`));
      }

      // 12j 드라이브 종류 판단 (M1): 폴더에 연결된 USB도 USB로, 정리할 때마다 새로 확인
      const platform = require('../lib/platform');
      if (!platform.resolveKind || !platform.createDriveKindOf) {
        out.push(missing('12j 드라이브 종류 판단 (폴더 연결 USB, 매번 새로)'));
      } else {
        const tables = {
          volumes: [{ Name: 'C:\\', DriveType: 3 }, { Name: 'C:\\mnt\\usb\\', DriveType: 2 }],
          disks: [{ DeviceID: 'C:', DriveType: 3 }, { DeviceID: 'Z:', DriveType: 4 }],
        };
        const cases = [
          ['C:\\photos\\a.jpg', 'fixed'],
          ['C:\\mnt\\usb\\a.jpg', 'removable'],
          ['Z:\\a.jpg', 'network'],
          ['\\\\nas\\share\\a.jpg', 'network'],
          ['Q:\\a.jpg', 'unknown'],
        ];
        const wrong = cases.filter(([p, k]) => platform.resolveKind(p, tables) !== k).map(([p, k]) => `${p}→${platform.resolveKind(p, tables)} (기대 ${k})`);
        out.push(sub('12j 폴더에 연결된 USB, 네트워크, 모르는 드라이브 판단', wrong.length === 0, wrong.join(' / ')));
        // 판단기를 새로 만들면 드라이브 정보를 새로 읽음 (예전 판단을 계속 쓰지 않음)
        let calls = 0;
        const fetcher = (kind) => async () => (calls++, { volumes: [{ Name: 'E:\\', DriveType: kind }], disks: [] });
        const k1 = await platform.createDriveKindOf({ fetchTables: fetcher(3) })('E:\\a.jpg');
        const k2 = await platform.createDriveKindOf({ fetchTables: fetcher(2) })('E:\\a.jpg');
        out.push(sub('12j 정리할 때마다 드라이브 종류를 새로 확인', k1 === 'fixed' && k2 === 'removable' && calls === 2, `${k1} → ${k2}, 읽은 횟수 ${calls}`));
        // 진짜 PowerShell로 이 PC의 임시 폴더 드라이브를 판단 (명령이 고장 나면 'unknown'이 나와서 ❌)
        if (process.platform !== 'win32') {
          out.push(skip('12j 진짜 PowerShell 드라이브 판단', 'Windows 아님'));
        } else {
          const real = await platform.createDriveKindOf()(os.tmpdir());
          out.push(sub('12j 진짜 PowerShell 드라이브 판단 (임시 폴더)', real !== 'unknown', `${os.tmpdir().slice(0, 3)} → ${real}`));
        }
      }

      // 12k 결과 파일 확인 (M2): 비어 있거나 기록해 둔 지문과 다르면 정리 안 함
      if (!cleaner || !cleaner.cleanTargets) {
        out.push(missing('12k 결과 파일이 비었거나 바뀌면 정리 안 함'));
      } else {
        const c = makeCase('12k');
        const good = c.job.items[0];
        good.resultHash = await cleaner.hashFile(good.finalPath);
        const empty = { i: 5, src: path.join(c.source, 'f.jpg'), status: 'done', finalPath: path.join(c.backup, 'f.jpg') };
        fs.writeFileSync(empty.src, 'F');
        fs.writeFileSync(empty.finalPath, ''); // 0바이트 결과
        const changed = { i: 6, src: path.join(c.source, 'g.jpg'), status: 'done', finalPath: path.join(c.backup, 'g.jpg'), resultHash: 'deadbeef' };
        fs.writeFileSync(changed.src, 'G');
        fs.writeFileSync(changed.finalPath, 'G-바뀜'); // 기록한 지문과 다름
        c.job.items.push(empty, changed);
        const t = (await cleaner.cleanTargets(c.job)).map((it) => it.i).sort();
        out.push(sub('12k 결과 파일이 비었거나 바뀌면 정리 안 함', t.join(',') === '0,1', `대상 ${t.join(',')} (기대 0,1)`));
      }

      // 12l 이름이 겹치면 숫자를 바꾸지 않고 항상 _1, _2 (M3)
      const processor = require('../lib/processor');
      if (!processor.nextFree) {
        out.push(missing('12l 이름 겹침 → _1, _2'));
      } else {
        const d = path.join(root, '12l');
        fs.mkdirSync(d, { recursive: true });
        for (const n of ['2026-10-28_134105.mp4', 'IMG_0101.jpg', 'IMG_0101_1.jpg']) fs.writeFileSync(path.join(d, n), 'x');
        const got = ['2026-10-28_134105.mp4', 'IMG_0101.jpg'].map((n) => path.basename(processor.nextFree(path.join(d, n))));
        const want = ['2026-10-28_134105_1.mp4', 'IMG_0101_2.jpg'];
        out.push(sub('12l 이름 겹침 → _1, _2 (시각·번호는 그대로)', got.join(',') === want.join(','), `${got.join(', ')} (기대 ${want.join(', ')})`));
      }

      // 12m 이름 바꾸기 직후, 기록 직전에 꺼졌다가 이어하기 (M4) → 같은 파일을 또 만들지 않음
      {
        const p = await pipeline(path.join(root, '12m'), env, { manual: false, run: false });
        const it = p.job.items.find((x) => x.kind === 'mov2mp4');
        // 1회차: 처리하다가 "완료" 기록 직전에 꺼진 것처럼 (예정 기록만 남음)
        const r1 = await processor.processItem(it, { ...env.ctx, onBeforeRename: (info) => p.store.mark(p.job, it.i, { pending: info }) });
        // 다시 켜기: 디스크에서 작업 불러오기 → 이어서 실행
        const store2 = new JobStore(path.join(p.root, 'jobs'));
        const job2 = store2.load();
        await runner.runBatch({ job: job2, store: store2, batchSize: 100000, ctx: env.ctx, logger: p.logger });
        const it2 = job2.items[it.i];
        const dir = path.dirname(r1.finalPath);
        const mp4s = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.mp4'));
        out.push(sub('12m 기록 직전에 꺼진 뒤 이어하기 → 중복 파일 안 만듦', it2.status === 'done' && it2.finalPath === r1.finalPath && mp4s.length === 1, `상태 ${it2.status}, mp4 ${mp4s.length}개 (${mp4s.join(', ')})`));
      }
      {
        // "옮길 예정"만 적고 이름 바꾸기 전에 꺼짐 (결과 파일 없음) → 평소처럼 다시 만들어야 함
        const p = await pipeline(path.join(root, '12m-norename'), env, { manual: false, run: false });
        const it = p.job.items.find((x) => x.kind === 'mov2mp4');
        it.pending = { dest: it.dest, resultHash: 'abc' };
        const r = await processor.processItem(it, env.ctx);
        out.push(sub('12m 예정만 기록, 이름 바꾸기 전에 꺼짐 → 다시 만듦', r.status === 'done' && r.finalPath === it.dest && fs.existsSync(it.dest), `${r.status} ${path.basename(r.finalPath || '')}`));
      }
      {
        // 예정 기록의 지문과 그 자리에 있는 파일이 다름 (남의 파일) → "완료"로 착각하지 않고, 그 파일은 건드리지 않음
        const p = await pipeline(path.join(root, '12m-mismatch'), env, { manual: false, run: false });
        const it = p.job.items.find((x) => x.kind === 'mov2mp4');
        fs.mkdirSync(path.dirname(it.dest), { recursive: true });
        fs.writeFileSync(it.dest, 'FOREIGN');
        it.pending = { dest: it.dest, resultHash: 'deadbeef' };
        const r = await processor.processItem(it, env.ctx);
        const untouched = fs.readFileSync(it.dest, 'utf8') === 'FOREIGN';
        out.push(sub('12m 예정 기록과 지문이 다름 → 완료로 보지 않고 남의 파일 그대로', r.finalPath !== it.dest && untouched, `결과 ${path.basename(r.finalPath || '')}, 남의 파일 그대로: ${untouched}`));
      }

      // 12n 같은 파일인지 알 수 없을 때 (새 Medium) → "이미 정리됨"이 아니라 "⚠ 확인 필요", 주의할 것 목록에 나옴
      {
        const planner = require('../lib/planner');
        const p = env.full;
        // 이미 정리된 백업 폴더에 같은 이름의 "다른" 사진을 가져오는 상황 + 같은 파일인지 모른다고 답하는 가짜 함수
        const src = path.join(root, '12n', 'source');
        fs.mkdirSync(src, { recursive: true });
        fs.copyFileSync(path.join(AUTO, 'other', 'IMG_0101.jpg'), path.join(src, '2026-10-28_134058_IMG_0101.jpg'));
        const plan = await planner.makePlan({ source: src, backupRoot: p.backupRoot, includeSub: true }, env.et, () => {}, { sameFile: () => null });
        const it = plan.items[0];
        const label = planner.statusLabelOf ? planner.statusLabelOf(it) : '(statusLabelOf 없음)';
        const issue = planner.isIssue ? planner.isIssue(it) : false;
        out.push(sub('12n 같은 파일인지 모름 → ⚠ 확인 필요 (주의할 것 목록)', it.status === 'skip' && it.check === true && label.includes('확인 필요') && issue && plan.stats.unsure === 1, `${it.status}, "${label}", 주의 목록 ${issue}, 요약 ${plan.stats.unsure}`));
        // 정리 대상에도 절대 안 들어감
        if (cleaner && cleaner.cleanCandidates) {
          out.push(sub('12n 확인 필요 파일은 정리 대상 아님', cleaner.cleanCandidates({ items: [it] }).length === 0));
        }
      }

      // 12o 원본 확인(지문 계산) 진행 상황을 하나씩 알려줌 → 화면에 "원본 확인 중… (n/전체)"
      if (!cleaner || !cleaner.cleanTargets) {
        out.push(missing('12o 원본 확인 진행 표시'));
      } else {
        const c = makeCase('12o');
        const calls = [];
        await cleaner.cleanTargets(c.job, { onProgress: (x) => calls.push(x) });
        const total = cleaner.cleanCandidates(c.job).length;
        const last = calls[calls.length - 1] || {};
        out.push(sub('12o 원본 확인 진행 표시 (파일마다 n/전체)', calls.length === total && last.done === total && last.total === total, `알림 ${calls.length}번, 마지막 ${last.done}/${last.total} (후보 ${total})`));
      }

      // 12p 배너 개수 = 확인 창 개수: 크기가 달라서 정리되지 않을 중복은 빠른 확인에서도 빠짐 (실사용 재테스트 발견)
      if (!cleaner || !cleaner.cleanCandidates) {
        out.push(missing('12p 배너 개수와 확인 창 개수가 같음'));
      } else {
        const c = makeCase('12p');
        const quick = cleaner.cleanCandidates(c.job).map((it) => it.i).sort().join(',');
        const strict = (await cleaner.cleanTargets(c.job)).map((it) => it.i).sort().join(',');
        out.push(sub('12p 배너 개수와 확인 창 개수가 같음', quick === strict, `배너 ${quick} / 확인 창 ${strict}`));
      }

      // 12q 휴지통 경고는 실제 설정으로 계산, 설정을 모를 때만 드라이브의 5% (실사용 재테스트 발견)
      if (!cleaner || !cleaner.cleanInfo) {
        out.push(missing('12q 휴지통 경고를 실제 설정으로 계산'));
      } else {
        const c = makeCase('12q');
        const targets = [{ ...c.job.items[0], size: 100 }];
        const big = () => ({ blocks: 1e6, bsize: 1 }); // 5% = 50,000
        const small = () => ({ blocks: 1000, bsize: 1 }); // 5% = 50
        const warn = async (recycleOf, statfs) => (await cleaner.cleanInfo(c.job, targets, { driveKindOf: async () => 'fixed', recycleOf, statfs })).warnings;
        const bigger = await warn(async () => ({ maxBytes: 300, nuke: false }), small);
        out.push(sub('12q 설정이 5%보다 크면 설정 안에 들 때 경고 없음', bigger.length === 0, bigger.join(' / ')));
        const smaller = await warn(async () => ({ maxBytes: 50, nuke: false }), big);
        out.push(sub('12q 설정이 5%보다 작으면 설정을 넘을 때 경고', smaller.length === 1 && smaller[0].includes('설정'), smaller.join(' / ') || '경고 없음'));
        const unknown = await warn(async () => null, small);
        out.push(sub('12q 설정을 모르면 5%로 계산', unknown.length === 1 && unknown[0].includes('약 5%'), unknown.join(' / ') || '경고 없음'));
      }

      // 12r 휴지통이 "바로 제거"로 설정된 드라이브 → 휴지통에 보내지 않고 이동 (영구 삭제 방지)
      if (!cleaner || !cleaner.cleanOriginals) {
        out.push(missing('12r 바로 제거 설정 → 이동'));
      } else {
        const c = makeCase('12r');
        const trashed = [];
        const nukeOf = async () => ({ maxBytes: 300, nuke: true });
        const targets = [c.job.items[0], c.job.items[1]];
        const info = await cleaner.cleanInfo(c.job, targets, { driveKindOf: async () => 'fixed', recycleOf: nukeOf, statfs: () => ({ blocks: 1e6, bsize: 1 }) });
        out.push(sub('12r 바로 제거 설정 → 확인 창에 이동으로 표시', info.drives[0].method === 'move' && info.warnings.some((w) => w.includes('바로 제거')), `${info.drives[0].method} / ${info.warnings.join(' / ')}`));
        const r = await cleaner.cleanOriginals({ job: c.job, store: c.store, targets, logger: c.logger, trash: async (p) => trashed.push(p), driveKindOf: async () => 'fixed', recycleOf: nukeOf });
        const movedOk = targets.every((it) => !fs.existsSync(it.src) && it.movedTo && fs.existsSync(it.movedTo));
        out.push(sub('12r 바로 제거 설정 → 휴지통 안 쓰고 이동', trashed.length === 0 && r.moved === 2 && movedOk, `휴지통 ${trashed.length}번, 이동 ${r.moved}개`));
      }

      // 12s 드라이브별 휴지통 설정 찾기 (볼륨 번호로 레지스트리 값과 연결)
      if (!platform.resolveRecycle) {
        out.push(missing('12s 드라이브별 휴지통 설정 찾기'));
      } else {
        const tables = {
          volumes: [{ Name: 'C:\\', DriveType: 3, DeviceID: '\\\\?\\Volume{AAAA-1}\\' }, { Name: 'E:\\', DriveType: 3, DeviceID: '\\\\?\\Volume{bbbb-2}\\' }, { Name: 'F:\\', DriveType: 3, DeviceID: '\\\\?\\Volume{cccc-3}\\' }],
          recycle: [{ id: '{aaaa-1}', max: 30000, nuke: 0 }, { id: '{BBBB-2}', max: 100, nuke: 1 }],
        };
        const c = platform.resolveRecycle('C:\\photos\\a.jpg', tables);
        const e = platform.resolveRecycle('E:\\a.jpg', tables);
        const f = platform.resolveRecycle('F:\\a.jpg', tables);
        const ok = c && c.maxBytes === 30000 * 1024 * 1024 && c.nuke === false && e && e.nuke === true && f === null && platform.resolveRecycle('C:\\a.jpg', null) === null;
        out.push(sub('12s 드라이브별 휴지통 설정 찾기', !!ok, JSON.stringify({ c, e, f })));
        if (process.platform !== 'win32') {
          out.push(skip('12s 진짜 휴지통 설정 읽기', 'Windows 아님'));
        } else {
          const real = await platform.createDriveKindOf().recycleOf(os.tmpdir());
          out.push(sub('12s 진짜 휴지통 설정 읽기 (임시 폴더)', real === null || typeof real.maxBytes === 'number' || real.maxBytes === null, JSON.stringify(real)));
        }
      }

      // 12t 원본 정리 로그는 옮기기 "전에" 먼저 적음 (L3) → 옮기는 도중에 꺼져도 어느 파일인지 남음
      {
        const c = makeCase('12t');
        const target = c.job.items[0];
        let seen = null; // 휴지통 함수가 불린 순간, 로그에 "예정" 줄이 이미 있는지
        const r = await cleaner.cleanOriginals({
          job: c.job, store: c.store, targets: [target], logger: c.logger,
          trash: async () => {
            const logs = listFiles(path.join(c.dir, 'logs')).filter((f) => path.basename(f).startsWith('clean_'));
            seen = logs.length === 1 && fs.readFileSync(logs[0], 'utf8').split('\n').some((l) => l.split('\t')[1] === '예정(휴지통)' && l.split('\t')[2] === target.src);
            throw new Error('옮기는 도중에 꺼진 것처럼');
          },
          driveKindOf: async () => 'fixed',
        });
        const text = fs.readFileSync(r.logPath, 'utf8');
        const idx = (word) => text.split('\n').findIndex((l) => l.split('\t')[1] === word);
        out.push(sub('12t 정리 로그는 옮기기 전에 "예정" 줄을 먼저 적음', seen === true && idx('예정(휴지통)') !== -1 && idx('예정(휴지통)') < idx('휴지통 실패 → 이동'), `휴지통 호출 때 예정 줄 ${seen ? '있음' : '없음'}`));
      }

      // 12u exiftool이 쓰다 남긴 임시 파일(*_exiftool_tmp)이 있어도 다시 처리됨 (L4)
      {
        const p = await pipeline(path.join(root, '12u'), env, { manual: false, run: false });
        const it = p.job.items.find((x) => x.kind === 'copy' && x.date);
        const ext = path.extname(it.dest);
        const etTmp = path.join(path.dirname(it.dest), path.basename(it.dest, ext) + '.__tmp__' + ext + '_exiftool_tmp');
        fs.mkdirSync(path.dirname(etTmp), { recursive: true });
        fs.writeFileSync(etTmp, 'LEFTOVER');
        // 먼저 재현: 남은 임시 파일은 진짜 태그 쓰기(파일을 다시 쓰는 것)를 막음 (-FileModifyDate는 파일을 다시 쓰지 않아 안 막힘)
        const victim = etTmp.slice(0, -'_exiftool_tmp'.length);
        fs.copyFileSync(it.src, victim);
        let blocked = '';
        try {
          await env.et.write(['-overwrite_original', '-Comment=pvm-check', victim]);
        } catch (e) {
          blocked = e.message;
        }
        fs.unlinkSync(victim);
        out.push(sub('12u 남은 exiftool 임시 파일은 진짜 태그 쓰기를 막음 (재현)', /already exists|Temporary file/i.test(blocked), blocked || '막히지 않음'));
        let r = null;
        let err = '';
        try {
          r = await processor.processItem(it, env.ctx);
        } catch (e) {
          err = e.message;
        }
        out.push(sub('12u exiftool 임시 파일이 남아 있어도 처리됨', !!r && r.status === 'done' && fs.existsSync(r.finalPath) && !fs.existsSync(etTmp), err || `${r.status}, 임시 파일 남음: ${fs.existsSync(etTmp)}`));
      }

      // 12v 작업 보관이 반쯤 실패해도(계획은 옮겨지고 진행 기록만 남음) 다음 작업 때 진행 기록을 지우지 않고 done\ 에 보관 (L5)
      {
        const dir = path.join(root, '12v', 'jobs');
        const store = new JobStore(dir);
        const job = store.create({ items: [{ i: 0, status: 'todo' }] });
        store.mark(job, 0, { status: 'done', finalPath: 'x' });
        const text = fs.readFileSync(store.progPath, 'utf8');
        fs.unlinkSync(store.planPath); // 계획은 보관됐는데 진행 기록 보관에 실패한 것처럼
        store.create({ items: [] });
        const kept = listFiles(path.join(dir, 'done')).filter((f) => /_orphan\.progress\.log$/.test(f));
        const same = kept.length === 1 && fs.readFileSync(kept[0], 'utf8') === text;
        out.push(sub('12v 남은 진행 기록은 지우지 않고 done\\에 보관', same && !fs.existsSync(store.progPath), `보관 ${kept.length}개, 내용 같음: ${same}`));
        // 보통 보관: 계획과 진행 기록이 같은 이름으로 done\ 에 감, 같은 1초 안에 두 번 보관해도 덮어쓰지 않음
        const store2 = new JobStore(path.join(root, '12v-close', 'jobs'));
        const j2 = store2.create({ items: [{ i: 0, status: 'todo' }] });
        store2.mark(j2, 0, { status: 'done' });
        store2.close('done');
        store2.create({ items: [{ i: 0, status: 'todo' }] });
        store2.mark(j2, 0, { status: 'fail' });
        store2.close('done');
        const names = listFiles(path.join(root, '12v-close', 'jobs', 'done')).map((f) => path.basename(f)).sort();
        const stems = (end) => names.filter((n) => n.endsWith(end)).map((n) => n.slice(0, -end.length)).sort();
        const pairs = stems('.json').length === 2 && stems('.json').join(',') === stems('.progress.log').join(','); // 계획과 진행 기록이 같은 이름 짝
        out.push(sub('12v 보관 두 번 → 계획 2개, 진행 기록 2개가 같은 이름 짝 (덮어쓰지 않음)', pairs && !store2.exists() && !fs.existsSync(store2.progPath), names.join(', ')));
        // 앞 보관에 진행 기록이 없었고 같은 1초 안에 또 보관해도 짝이 맞음 (검증 지적)
        const store3 = new JobStore(path.join(root, '12v-pair', 'jobs'));
        store3.create({ items: [] });
        store3.close('done'); // 진행 기록 없음
        const j3 = store3.create({ items: [{ i: 0, status: 'todo' }] });
        store3.mark(j3, 0, { status: 'done' });
        store3.close('done');
        const names3 = listFiles(path.join(root, '12v-pair', 'jobs', 'done')).map((f) => path.basename(f));
        const log3 = names3.find((n) => n.endsWith('.progress.log')) || '';
        const pairOk = names3.length === 3 && names3.includes(log3.replace(/\.progress\.log$/, '.json'));
        out.push(sub('12v 앞 보관에 진행 기록이 없어도 다음 보관의 계획·진행 기록 이름이 짝', pairOk, names3.join(', ')));
      }

      // 12w 빠른 확인(cleanCandidates)이 원본마다 디스크를 두 번만 읽음 + 결과는 그대로 + 많은 중복 시간 (#49 검증 ⚠️ 큰 목록 속도)
      if (!cleaner || !cleaner.cleanCandidates) {
        out.push(missing('12w 빠른 확인 속도'));
      } else {
        const d = path.join(root, '12w');
        const put = (name, text) => {
          const p = path.join(d, name);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, text);
          return p;
        };
        // 여러 경우: 결과 그대로인지 (기대: 정리 대상은 done, dup, conv 세 개)
        const keepA = put('backup/a.jpg', 'aaaa');
        const link = path.join(d, 'src/link.jpg');
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.linkSync(keepA, link); // 같은 파일을 다른 경로로 (하드링크)
        const items = [
          { i: 'done', src: put('src/done.jpg', 'x'), status: 'done', finalPath: put('backup/done.jpg', 'x') },
          { i: 'dup', src: put('src/dup.jpg', 'aaaa'), status: 'dup', dupOf: keepA },
          { i: 'size', src: put('src/size.jpg', 'aaa'), status: 'dup', dupOf: keepA }, // 크기 다름 → 빠짐
          { i: 'conv', src: put('src/conv.heic', 'h'), status: 'dup', converted: true, sameShot: true, dupOf: keepA },
          { i: 'link', src: link, status: 'dup', dupOf: keepA }, // 같은 파일 → 빠짐
          { i: 'nosrc', src: path.join(d, 'src/없음.jpg'), status: 'dup', dupOf: keepA }, // 원본 없음 → 빠짐
          { i: 'nokeep', src: put('src/nokeep.jpg', 'aaaa'), status: 'dup', dupOf: path.join(d, 'backup/없음.jpg') }, // 남길 파일 없음 → 빠짐
          { i: 'check', src: put('src/check.jpg', 'aaaa'), status: 'dup', check: true, dupOf: keepA }, // 확인 필요 → 빠짐
        ];
        // 디스크 읽기 횟수 세기 (fs 함수를 잠깐 감싸요)
        const names = ['statSync', 'lstatSync', 'existsSync', 'realpathSync'];
        const orig = Object.fromEntries(names.map((n) => [n, fs[n]]));
        let reads = 0;
        let got;
        try {
          for (const n of names) fs[n] = (...a) => { reads++; return orig[n].apply(fs, a); };
          // realpathSync.native 도 그대로 쓸 수 있게 감싸요 (빠지면 lib/paths.js 의 realPath 가 조용히 다른 길로 가요, #53 검증)
          fs.realpathSync.native = (...a) => { reads++; return orig.realpathSync.native.apply(fs, a); };
          got = cleaner.cleanCandidates({ items }).map((it) => it.i).join(',');
        } finally {
          for (const n of names) fs[n] = orig[n];
        }
        out.push(sub('12w 빠른 확인 결과 그대로 (크기 다름 · 같은 파일 · 없는 파일 · 확인 필요는 빠짐)', got === 'done,dup,conv', `대상 ${got} (기대 done,dup,conv)`));
        out.push(sub('12w 빠른 확인은 원본마다 디스크를 두 번 이하로 읽음', reads <= items.length * 2, `${items.length}개에 ${reads}번`));
        // 시간: 중복 6,000개 (작은 파일 12,000개) → 6만 개로 환산
        const N = 6000;
        const many = [];
        for (let k = 0; k < N; k++) {
          const src = path.join(d, 'many-src', `IMG_${k}.JPG`);
          const keep = path.join(d, 'many-keep', `2026-01-01_${k}.jpg`);
          if (k === 0) {
            fs.mkdirSync(path.dirname(src), { recursive: true });
            fs.mkdirSync(path.dirname(keep), { recursive: true });
          }
          fs.writeFileSync(src, 'x');
          fs.writeFileSync(keep, 'x');
          many.push({ src, status: 'dup', dupOf: keep });
        }
        const t0 = Date.now();
        const n = cleaner.cleanCandidates({ items: many }).length;
        const ms = Date.now() - t0;
        const per60k = (ms * 10) / 1000;
        console.log(`   ⏱ 12w 중복 6,000개 빠른 확인 ${ms}ms → 6만 개 약 ${per60k.toFixed(1)}초`); // 통과해도 시간은 보이게
        out.push(sub('12w 중복 6,000개 빠른 확인 (6만 개 환산 10초 이하)', n === N && per60k <= 10, `${ms}ms → 6만 개 약 ${per60k.toFixed(1)}초, 대상 ${n}개`));
      }

      // 12x 확인 창에서 계산한 지문을 정리 때 다시 씀. 크기 · 수정 시각이 바뀐 파일만 다시 계산 (2026-11-09 사용자 결정)
      if (!cleaner || !cleaner.createHashCache) {
        out.push(missing('12x 지문을 한 번만 계산'));
      } else {
        const c = makeCase('12x');
        c.job.items[0].resultHash = await cleaner.hashFile(c.job.items[0].finalPath); // 저장할 때 기록한 지문
        let calls = 0;
        const hashOf = cleaner.createHashCache(async (p) => (calls++, cleaner.hashFile(p)));
        const first = (await cleaner.cleanTargets(c.job, { hashOf })).map((it) => it.i).join(',');
        const afterFirst = calls;
        const second = (await cleaner.cleanTargets(c.job, { hashOf })).map((it) => it.i).join(',');
        out.push(sub('12x 바뀌지 않은 파일은 정리 때 지문을 다시 계산하지 않음', first === '0,1' && second === '0,1' && afterFirst > 0 && calls === afterFirst, `확인 창 ${first} (계산 ${afterFirst}번) / 정리 ${second} (추가 계산 ${calls - afterFirst}번)`));
        // 확인 창 뒤에 결과 파일이 바뀜 (크기는 같고 수정 시각만 다름) → 다시 계산해서 정리 대상에서 빠짐
        const kept = c.job.items[0].finalPath;
        fs.writeFileSync(kept, 'Z');
        const t = new Date(Date.now() + 5000);
        fs.utimesSync(kept, t, t);
        const before = calls;
        const third = (await cleaner.cleanTargets(c.job, { hashOf })).map((it) => it.i).join(',');
        out.push(sub('12x 확인 창 뒤에 바뀐 결과 파일은 다시 계산해서 정리 안 함', third === '1' && calls === before + 1, `정리 ${third || '없음'} (기대 1), 다시 계산 ${calls - before}번`));
        // 정리 직전 확인은 그대로: 결과 파일이 없어지면 지문이 기억돼 있어도 빠짐
        fs.unlinkSync(c.job.items[1].dupOf);
        const fourth = (await cleaner.cleanTargets(c.job, { hashOf })).map((it) => it.i).join(',');
        out.push(sub('12x 남길 파일이 없어지면 기억한 지문이 있어도 정리 안 함', fourth === '', `정리 ${fourth || '없음'}`));
      }

      // 12f 드라이브 종류를 모름 → 이동 (휴지통 안 씀)
      if (!cleaner || !cleaner.cleanOriginals) {
        out.push(missing('12f 드라이브 종류 모름 → 이동'));
      } else {
        const c = makeCase('12f');
        const trashed = [];
        const r = await cleaner.cleanOriginals({ job: c.job, store: c.store, targets: [c.job.items[0]], logger: c.logger, trash: async (p) => trashed.push(p), driveKindOf: async () => 'unknown' });
        out.push(sub('12f 드라이브 종류 모름 → 이동', trashed.length === 0 && r.moved === 1, `휴지통 ${trashed.length}번, 이동 ${r.moved}개`));
      }
      return out;
    },
  },
  {
    no: 13,
    name: '재생 불가 영상',
    async run(env) {
      if (!env.tools.ffprobe.ok) return [skip('재생 불가 영상', 'ffprobe 없음')];
      const cleaner = require('../lib/cleaner');
      const root = path.join(env.tmp, 'broken');
      const ffprobe = env.tools.ffprobe.path;
      const out = [];

      // 13a~e 실제 실행: 손상 MP4·MOV는 복사하지 않고, 멀쩡한 영상과 사진은 평소대로
      const source = path.join(root, 'source');
      const backupRoot = path.join(root, 'backup');
      fs.mkdirSync(source, { recursive: true });
      fs.mkdirSync(backupRoot, { recursive: true });
      const good = path.join(AUTO, 'IMG_0103.MOV');
      const mp4 = path.join(source, '손상.mp4');
      const mov = path.join(source, '손상.MOV');
      const copy = path.join(source, '손상(1).mp4');
      breakVideo(good, mp4, 4096);
      breakVideo(good, mov, 8192); // 크기가 달라야 "같은 파일"로 묶이지 않아요
      fs.copyFileSync(mp4, copy);
      fs.copyFileSync(good, path.join(source, '정상.MOV'));
      fs.copyFileSync(path.join(AUTO, 'IMG_0101.jpg'), path.join(source, '사진.jpg'));
      const before = hashAll(source);

      const logger = createLogger(path.join(root, 'logs'));
      const store = new JobStore(path.join(root, 'jobs'));
      const job = store.create(await makePlan({ source, backupRoot, includeSub: true }, env.et));
      const r = await runner.runBatch({ job, store, batchSize: 100000, ctx: env.ctx, logger });
      const item = (name) => job.items.find((it) => path.basename(it.src) === name);
      const brokenItems = [item('손상.mp4'), item('손상.MOV')];

      const allBroken = brokenItems.every((it) => it.status === 'broken' && !it.finalPath);
      out.push(sub('13a 손상 MP4·MOV → 재생 불가, 복사 안 함', allBroken, brokenItems.map((it) => `${it.status} ${it.note}`).join(' / ')));
      const inBackup = listFiles(backupRoot).filter((f) => path.basename(f).includes('손상'));
      out.push(sub('13a 백업에 손상 파일 없음', inBackup.length === 0, inBackup.join(' / ')));
      out.push(sub('13a 메모에 이유 적힘', brokenItems.every((it) => /moov|Invalid/.test(it.note)), brokenItems[0].note));
      out.push(sub('13b 원본 그대로', JSON.stringify(hashAll(source)) === JSON.stringify(before)));
      out.push(sub('13c 정상 영상과 사진은 완료', item('정상.MOV').status === 'done' && item('사진.jpg').status === 'done', `${item('정상.MOV').status}, ${item('사진.jpg').status}`));

      const st = jobStats(job);
      out.push(sub('13d 눈에 띄는 표시 (상태 이름, 주의 목록, 개수)', statusLabelOf(brokenItems[0]) === '⚠ 재생 불가' && isIssue(brokenItems[0]) && st.broken === 2 && r.broken === 2, `${statusLabelOf(brokenItems[0])}, 작업 ${st.broken}개, 회차 ${r.broken}개`));
      const runLog = fs.readFileSync(r.logPath, 'utf8');
      out.push(sub('13d 로그에 재생불가 기록', runLog.split('\n').filter((l) => l.split('\t')[1] === '재생불가').length === 2 && runLog.includes('재생불가 2'), path.basename(r.logPath)));

      const leftOut = (list) => ['손상.mp4', '손상.MOV', '손상(1).mp4'].every((n) => !list.includes(item(n)));
      const candidates = cleaner.cleanCandidates(job);
      const targets = await cleaner.cleanTargets(job, { ffprobe });
      out.push(sub('13e 원본 정리 대상에서 빠짐 (같은 파일 복사본 포함)', leftOut(candidates) && leftOut(targets), targets.map((it) => path.basename(it.src)).join(', ')));
      out.push(sub('13e 정상 영상과 사진은 정리 대상', ['정상.MOV', '사진.jpg'].every((n) => targets.includes(item(n))), targets.map((it) => path.basename(it.src)).join(', ')));

      // 13f 이 기능이 생기기 전에 복사된 손상 파일: 백업에 이미 있어도 정리 직전 확인에서 걸러요
      const old = path.join(root, 'old');
      fs.mkdirSync(old, { recursive: true });
      const oldFile = (n) => path.join(old, n);
      breakVideo(good, oldFile('a-원본.mp4'), 4096);
      breakVideo(good, oldFile('a-백업.mp4'), 4096);
      breakVideo(good, oldFile('b-원본.mp4'), 8192);
      breakVideo(good, oldFile('b-백업.mp4'), 8192);
      const oldJob = {
        source: old,
        backupRoot: old,
        items: [
          { i: 0, src: oldFile('a-원본.mp4'), status: 'done', finalPath: oldFile('a-백업.mp4') },
          { i: 1, src: oldFile('b-원본.mp4'), status: 'dup', dupOf: oldFile('b-백업.mp4') },
        ],
      };
      const fakeStore = { mark: (j, i, patch) => Object.assign(j.items[i], patch) };
      const oldLogger = createLogger(path.join(old, 'logs'));
      const oldBefore = cleaner.cleanCandidates(oldJob).length;
      const oldTargets = await cleaner.cleanTargets(oldJob, { ffprobe, store: fakeStore, logger: oldLogger });
      const oldLogs = listFiles(path.join(old, 'logs')).map((f) => path.basename(f));
      out.push(sub('13f 백업에 이미 있는 손상 파일 → 정리 대상에서 빠짐', oldBefore === 2 && oldTargets.length === 0, `후보 ${oldBefore}개, 대상 ${oldTargets.length}개`));
      out.push(sub('13f 재생 불가로 표시되고 배너 개수도 맞음', oldJob.items.every((it) => it.status === 'broken') && cleaner.cleanCandidates(oldJob).length === 0, oldJob.items.map((it) => it.status).join(',')));
      out.push(sub('13f 정리 확인 로그', oldLogs.some((n) => /^clean-check_.*\.txt$/.test(n)), oldLogs.join(', ')));

      // 13g ffprobe가 없으면: 가져오기는 계속하되, 확인 못 한 영상의 원본은 정리하지 않아요
      const noProbe = path.join(root, 'no-probe');
      const npSource = path.join(noProbe, 'source');
      const npBackup = path.join(noProbe, 'backup');
      fs.mkdirSync(npSource, { recursive: true });
      fs.mkdirSync(npBackup, { recursive: true });
      breakVideo(good, path.join(npSource, '확인못함.mp4'), 4096);
      const npStore = new JobStore(path.join(noProbe, 'jobs'));
      const npJob = npStore.create(await makePlan({ source: npSource, backupRoot: npBackup, includeSub: true }, env.et));
      await runner.runBatch({ job: npJob, store: npStore, batchSize: 100000, ctx: { ...env.ctx, ffprobe: null }, logger: createLogger(path.join(noProbe, 'logs')) });
      const np = npJob.items[0];
      out.push(sub('13g ffprobe 없음 → 복사하고 메모 남김', np.status === 'done' && !!np.finalPath && np.note.includes('확인하지 못'), `${np.status} ${np.note}`));
      const npTargets = await cleaner.cleanTargets(npJob, { store: npStore });
      out.push(sub('13g ffprobe 없음 → 원본은 정리 안 함, 손상 표시도 안 함', npTargets.length === 0 && np.status === 'done', `대상 ${npTargets.length}개, ${np.status}`));

      // 13h 검사 함수: 판정 3가지 (true 정상 / false 손상 / null 모름)
      const v1 = await probeVideo(ffprobe, good);
      const v2 = await probeVideo(ffprobe, mp4);
      const v3 = await probeVideo(path.join(root, '없는-프로그램.exe'), good);
      const audioOnly = path.join(root, '글자.mp4');
      fs.writeFileSync(audioOnly, 'not a video'.repeat(100));
      const v4 = await probeVideo(ffprobe, audioOnly);
      out.push(sub('13h 검사 함수 판정', v1.ok === true && v2.ok === false && v3.ok === null && v4.ok === false, JSON.stringify([v1.ok, v2.ok, v3.ok, v4.ok])));
      return out;
    },
  },
  // 14번부터는 갤러리 점검 (scripts/check-gallery.js)
  ...require('./check-gallery').items,
  // 20번부터는 정보 없는 사진 점검 (scripts/check-missing-info.js)
  ...require('./check-missing-info').items,
  // 28번부터는 위치 제안 점검 (scripts/check-location-suggest.js)
  ...require('./check-location-suggest').items,
  // 33번부터는 지도에서 위치 고르기 점검 (scripts/check-map-pick.js)
  ...require('./check-map-pick').items,
  // 36번부터는 비슷한 사진 점검 (scripts/check-similar.js)
  ...require('./check-similar').items,
  // 39번은 장소 이름 점검 (scripts/check-places.js)
  ...require('./check-places').items,
  // 40번은 내가 붙이는 태그 점검 (scripts/check-tags.js)
  ...require('./check-tags').items,
  // 42 · 43번은 지도 화면 점검 (scripts/check-map-view.js)
  ...require('./check-map-view').items,
  // 45 · 46번은 정리 화면 점검 (scripts/check-clean-view.js)
  ...require('./check-clean-view').items,
];

// ---------- 점검 임시 폴더 정리 ----------
// 규칙 (docs/점검-푸시-절차.md): 점검이 만든 %TEMP%\pvm-check-... 폴더는 복사본이라 영구 삭제해도 돼요.
//   통과 → 이번 폴더 포함 전부 지움
//   실패 → 원인을 볼 수 있게 이번 폴더 1개만 남기고 나머지 지움
const TEMP_PREFIX = 'pvm-check-';
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// 지워도 되는 폴더인지 코드로 확인 (%TEMP% 바로 안 + 이름이 pvm-check- + 링크 아닌 진짜 폴더)
function isCheckTempDir(dir) {
  const full = path.resolve(dir);
  if (!sameDir(path.dirname(full), os.tmpdir())) return false;
  if (!path.basename(full).startsWith(TEMP_PREFIX)) return false;
  try {
    const st = fs.lstatSync(full);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch (e) {
    return false;
  }
}

function cleanupTempDirs(current, failed) {
  const removed = [];
  for (const name of fs.readdirSync(os.tmpdir())) {
    const dir = path.join(os.tmpdir(), name);
    if (!isCheckTempDir(dir)) continue;
    if (failed && sameDir(dir, current)) continue; // 실패한 이번 폴더는 남김
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch (e) {
      console.log(`  ⚠️ 임시 폴더를 못 지웠어요: ${dir} (${e.message})`);
    }
  }
  return removed;
}

// ---------- 수동 샘플 처리 결과 표 (참고용) ----------
function manualReport(p) {
  const rows = p.job.items.filter((it) => slash(path.relative(p.source, it.src)).startsWith('manual/'));
  if (!rows.length) return '';
  const lines = ['', '📷 수동 샘플 처리 결과', '| 원본 | 작업 | 상태 | 결과 | 메모 |', '|---|---|---|---|---|'];
  for (const it of rows) {
    lines.push(`| ${path.basename(it.src)} | ${it.label} | ${it.status} | ${resultOf(p, it) || '-'} | ${it.note || ''} |`);
  }
  return lines.join('\n');
}

// ---------- 실행 ----------
(async () => {
  const ICON = { ok: '✅', fail: '❌', skip: '⏭' };
  const tmp = path.join(os.tmpdir(), `pvm-check-${stamp()}`);
  fs.mkdirSync(tmp, { recursive: true });
  console.log(`🧪 점검 시작 (임시 폴더: ${tmp})`);

  const tools = await detectTools({}, APP);
  if (!tools.exiftool.ok) {
    console.log('❌ exiftool을 찾지 못해서 점검을 할 수 없어요 (새 터미널에서 다시 실행해 보세요)');
    process.exit(1);
  }
  const et = new ExifTool(tools.exiftool.path);
  const env = {
    tmp,
    tools,
    et,
    ctx: { et, magick: tools.magick.path, ffmpeg: tools.ffmpeg.path, ffprobe: tools.ffprobe.path },
    samplesBefore: hashAll(SAMPLES),
  };

  let failed = 1; // 중간에 오류로 멈추면 실패로 보고 폴더를 남겨요
  try {
    failed = 0;
    env.full = await pipeline(path.join(tmp, 'full'), env);
    for (const item of ITEMS) {
      let subs;
      try {
        subs = await item.run(env);
      } catch (e) {
        subs = [sub('실행 중 오류', false, e.message)];
      }
      const status = subs.some((s) => s.status === 'fail') ? 'fail' : subs.every((s) => s.status === 'skip') ? 'skip' : 'ok';
      if (status === 'fail') failed++;
      console.log(`${ICON[status]} ${String(item.no).padStart(2)}. ${item.name}`);
      for (const s of subs) {
        if (s.status === 'ok' && status === 'ok') continue; // 통과한 항목은 간단히
        const why = s.status === 'skip' ? `건너뜀 (${s.detail})` : s.detail;
        console.log(`      ${ICON[s.status]} ${s.label}${why ? ' — ' + why : ''}`);
      }
    }
    console.log(manualReport(env.full));
  } catch (e) {
    failed = failed || 1;
    console.log('❌ 점검 실행 오류: ' + e.stack);
  } finally {
    et.close();
  }

  const removed = cleanupTempDirs(tmp, failed > 0);
  console.log(`\n결과: ${failed ? `❌ ${failed}개 항목 실패` : '✅ 모두 통과'}`);
  console.log(failed ? `  원인 확인용으로 남긴 폴더: ${tmp}` : '  이번 임시 폴더는 지웠어요');
  if (removed.length) console.log(`  지운 점검 임시 폴더 ${removed.length}개: ${removed.join(', ')}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('❌ 점검 실행 오류: ' + e.stack);
  process.exit(1);
});

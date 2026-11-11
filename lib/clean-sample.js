// 파일 위치: lib/clean-sample.js
// 역할: 원본 정리 확인 창의 "🔍 샘플 확인" (명세 docs/기능명세-가져오기-변환-v1.1.md "원본 정리")
//   정리할 원본 대신 백업 폴더에 남을 결과 파일 중 무작위 10개를 종류별로 골고루 뽑아요
//   화면에는 이름 · 종류 · 백업 폴더 안의 위치만 보내고, 파일을 열 때는 번호(key)로만 부탁해요
//   파일을 옮기거나 지우지 않아요 (읽기만)

const path = require('path');
const { isVideoPath, NO_DATE_DIR } = require('./planner');
const { keepPathOf } = require('./cleaner');

// 종류 (보여 주는 순서)
const KINDS = ['사진', '바꾼 사진', '영상', '바꾼 영상', '날짜 없음'];
const SAMPLE_SIZE = 10;

// 결과 파일의 종류
//   날짜 없음: 백업폴더\_날짜없음 안에 저장된 것
//   바꾼 사진 · 바꾼 영상: HEIC → JPG, MOV → MP4 로 바꿔 저장한 것 (중복이어도 남길 파일은 바꾼 결과예요)
function sampleKindOf(job, it, keep) {
  const rel = job && job.backupRoot ? path.relative(job.backupRoot, keep) : '';
  if (rel.split(/[\\/]/)[0] === NO_DATE_DIR) return '날짜 없음';
  const video = isVideoPath(keep);
  if (it.converted) return video ? '바꾼 영상' : '바꾼 사진';
  return video ? '영상' : '사진';
}

// 백업 폴더 안의 위치 (예: 2026\10\28). 백업 폴더 밖이면 바로 위 폴더 이름만
function folderOf(job, keep) {
  const dir = path.dirname(keep);
  if (job && job.backupRoot) {
    const rel = path.relative(job.backupRoot, dir);
    if (!rel) return '백업 폴더 바로 안';
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return path.basename(dir);
}

// 정리 대상(cleanTargets 결과)에서 뽑을 후보 목록 만들기
//   [{ path: 결과 파일 경로, name, kind, folder }] (path는 main 에만 두고 화면에는 보내지 않아요)
function samplePool(job, targets) {
  const pool = [];
  const seen = new Set(); // 중복 여러 개가 같은 결과 파일을 가리킬 수 있어요 → 한 번만
  for (const it of targets || []) {
    const keep = keepPathOf(job, it);
    if (!keep) continue;
    const id = keep.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    pool.push({ path: keep, name: path.basename(keep), kind: sampleKindOf(job, it, keep), folder: folderOf(job, keep) });
  }
  return pool;
}

// 무작위로 섞기 (rand는 점검 때 바꿔 끼울 수 있게)
function shuffle(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 종류별로 골고루 n개 뽑기
//   종류마다 섞은 뒤, 종류를 돌아가며 하나씩 꺼내요 (사진 1000장 · 영상 3개면 영상 3개는 다 들어가요)
//   돌려주는 값: [{ key: 후보 번호, name, kind, folder }] (종류 순서대로)
function pickSample(pool, { n = SAMPLE_SIZE, rand = Math.random } = {}) {
  const groups = KINDS.map((kind) => shuffle(
    (pool || []).map((p, key) => ({ ...p, key })).filter((p) => p.kind === kind),
    rand,
  ));
  const picked = [];
  for (let round = 0; picked.length < n; round++) {
    let took = false;
    for (const g of groups) {
      if (picked.length >= n) break;
      if (round < g.length) {
        picked.push(g[round]);
        took = true;
      }
    }
    if (!took) break; // 후보를 다 꺼냄
  }
  picked.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  return picked.map(({ key, name, kind, folder }) => ({ key, name, kind, folder }));
}

// 화면이 보낸 번호로 열 파일 경로 찾기 (번호가 이상하면 null)
function samplePath(pool, key) {
  if (!Array.isArray(pool) || !Number.isInteger(key) || key < 0 || key >= pool.length) return null;
  return pool[key].path;
}

// 화면에 보낼 샘플: 뽑은 목록과 후보 전체 수
//   후보가 10개를 넘을 때만 "다른 10개 뽑기"가 뜻이 있어요 (딱 10개면 다시 뽑아도 같은 10개라서요)
function sampleView(pool, opts) {
  return { items: pickSample(pool, opts), total: Array.isArray(pool) ? pool.length : 0 };
}

// 누른 샘플을 크게 열기
//   exists · openPath 는 main 이 넘겨줘요 (fs.existsSync, shell.openPath). 점검 때는 가짜를 넘겨요
//   이번 후보 안의 번호만 열고, 문제가 있으면 쉬운 문장으로 알려요
async function openSample(pool, key, { exists, openPath }) {
  const p = samplePath(pool, key);
  if (!p) throw new Error('샘플을 다시 뽑아 주세요');
  if (!exists(p)) throw new Error('결과 파일을 찾지 못했어요');
  const err = await openPath(p);
  if (err) throw new Error('파일을 열지 못했어요');
  return true;
}

module.exports = { KINDS, SAMPLE_SIZE, sampleKindOf, samplePool, pickSample, samplePath, sampleView, openSample };

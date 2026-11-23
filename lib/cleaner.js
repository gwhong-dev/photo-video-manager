// 파일 위치: lib/cleaner.js
// 역할: 원본 정리 — 어떤 원본을 정리해도 되는지 고르기
//
// 정리해도 되는 원본 (결과 파일이 백업 폴더에 확실히 있을 때만)
//   - 완료(done): 결과 파일이 있음
//   - 중복(dup): "확인 필요"가 아니고, 남길 파일이 있고, 그 파일과 지문(해시)까지 같을 때만
//       바이트 지문이 다르면 내용 지문(태그 · 정보를 뺀 그림 · 영상 지문)과 중요한 정보로 한 번 더 (백업에 태그를 쓴 경우, 2026-11-23)
//   - 변환할 파일(HEIC·MOV)의 중복: 지문이 같을 수 없어서, 미리보기에서 애플 ID로 같은 촬영이 된 것(sameShot),
//       또는 내용이 똑같은 쌍둥이 원본이 같은 촬영으로 이어진 백업 파일로 이어진 것만 (shotKeepsOf, 2026-11-15)
//       정리 직전에 원본과 남길 파일의 정보를 다시 읽어 애플 ID, 촬영 날짜, 가로×세로가 모두 같을 때 정리 (2026-11-04 사용자 결정)
//       (MP4 결과에도 애플 ID(Keys)를 옮겨요. 영상은 수정 시각 2초 차이까지 같은 촬영으로 봐요. 정보를 못 읽으면 남겨 둬요)
//   - 실패 / 재생 불가 / 대기 / 이미 정리됨 → 남겨 둠
//   - 남을 파일이 영상이면 정리 직전에 재생되는지도 확인 (이 확인이 생기기 전에 백업된 손상 영상을 걸러요)
//
// 정리 방법 (⚠️ 영구 삭제는 절대 안 해요)
//   - 하드디스크(휴지통 있음) → 휴지통
//   - USB·SD카드·네트워크·종류 모름(휴지통 없음) → 가져올 폴더\_정리완료원본 으로 이동 (폴더 구조 유지)
//   - 휴지통이 "바로 제거"로 설정된 하드디스크 → 휴지통에 보내면 영구 삭제될 수 있어서 똑같이 이동

const fs = require('fs');
const path = require('path');
const { keyOf, isVideoPath, MOVED_DIR } = require('./planner');
const { probeVideo } = require('./tools');
const { createDriveKindOf, canUseRecycleBin, DRIVE_LABEL } = require('./platform');
const { sameFile, hashFile, realPath, fileSig } = require('./paths');

// 파일이 실제로 있는 드라이브 (C:\사진 이 D: 로 연결된 폴더면 D:\)
//   휴지통 크기와 휴지통 설정을 같은 드라이브 기준으로 읽으려고 진짜 경로로 봐요 (#72 · #74 검증 ⚠️)
const realRootOf = (p) => path.parse(realPath(p)).root;
const { now } = require('./logger');
const D = require('./dates');

// 영상 수정 시각은 이만큼(초)까지 어긋나도 같다고 봐요
const VIDEO_MODIFY_SLACK = 2;

// exiftool 날짜 글자 두 개가 몇 초 떨어졌는지 ("2026:01:04 23:19:48+09:00" 같은 모양)
//   시간대(+09:00 · Z)는 둘 다 있거나 둘 다 없을 때만 비교해요. 모양이 다르거나 못 읽으면 Infinity (= 다르다고 봄, 안전하게 남겨 둠)
function secondsApart(x, y) {
  const parse = (s) => {
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(String(s).trim());
    if (!m) return null;
    const [, Y, Mo, Dd, h, mi, se, frac, tz] = m;
    if (Number(Y) < 1900) return null; // 0000:00:00 같은 빈 값
    if (+Mo < 1 || +Mo > 12 || +Dd < 1 || +h > 23 || +mi > 59 || +se > 59) return null; // 99:99:99 같은 잘못된 값
    // 소수 초도 넣어서 계산해요 (버리면 48.0초와 50.999초가 "2초 차이"가 돼요, #112 검증 ⚠️)
    let t = Date.UTC(+Y, +Mo - 1, +Dd, +h, +mi, +se) / 1000 + (frac ? Number(frac) : 0);
    if (new Date(Math.floor(t) * 1000).getUTCDate() !== +Dd) return null; // 2월 30일 같은 없는 날짜 (다음 달로 넘어가요)
    if (tz && tz !== 'Z') t -= (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 3600 + Number(tz.slice(4, 6)) * 60);
    return { t, tz: tz != null };
  };
  const a = parse(x);
  const b = parse(y);
  if (!a || !b || a.tz !== b.tz) return Infinity;
  return Math.abs(a.t - b.t);
}

// 변환된 중복이 남길 파일과 같은 촬영인지: 애플 ID, 촬영 날짜, 가로×세로 (가로세로가 바뀐 것은 같다고 봐요: 세로 사진은 변환할 때 방향을 맞춰요)
//   애플 ID는 PhotoIdentifier, ContentIdentifier만 (ImageUniqueID는 여러 회사 카메라가 같은 값을 넣기도 해서 정리 판단에는 안 써요)
//   0.001초(SubSecTimeOriginal)와 수정 시각(ModifyDate)도 원본에 있으면 같아야 해요 (같은 이름으로 다시 내보낸 편집본을 거르려고)
//   단, 영상의 수정 시각은 2초 차이까지 같다고 봐요 (MP4 변환에서 어긋남, 개선 10)
//   readMeta(경로 목록) → Map<keyOf(경로), 정보>. 하나라도 모르거나 다르면 false
async function convertedDupOk(it, keep, readMeta) {
  return (await convertedDupWhy(it, keep, readMeta)) === null;
}

// convertedDupOk 와 같은 판단인데, 아니면 까닭을 돌려줘요 (같은 촬영이면 null)
//   { why: 화면 · 로그에 보일 까닭, lasting: true 면 다시 확인해도 같은 결과 (작업 기록에 남겨 배너에서 빼요, 개선 12)
//     false 면 정보를 못 읽은 것처럼 다음에 달라질 수 있는 것 (남기지 않음) }
async function convertedDupWhy(it, keep, readMeta) {
  let meta;
  try {
    meta = await readMeta([it.src, keep]);
  } catch (e) {
    return { why: '촬영 정보를 읽지 못해 남김', lasting: false };
  }
  const a = meta.get(keyOf(it.src));
  const b = meta.get(keyOf(keep));
  if (!a || !b) return { why: '촬영 정보를 읽지 못해 남김', lasting: false };
  const idOf = (m) => m.PhotoIdentifier || m.ContentIdentifier || null;
  // 미리보기 때 애플 ID 가 같았던 항목이라, 지금 한쪽 ID 가 없으면 읽기 문제 (형식 오류 파일은 exiftool 이 빈 정보만 줘요, #116 검증 ⚠️)
  if (!idOf(a) || !idOf(b)) return { why: '촬영 정보를 읽지 못해 남김', lasting: false };
  if (idOf(a) !== idOf(b)) return { why: '애플 ID 가 달라 남김', lasting: true };
  for (const tag of ['SubSecTimeOriginal', 'ModifyDate']) {
    if (a[tag] == null || String(a[tag]) === String(b[tag])) continue;
    // 영상은 MP4 로 바꿀 때 수정 시각이 1~2초 어긋나요 → 2초까지는 같은 것으로 봐요 (개선 10)
    //   실제 기록 표본 30개 중 15개가 1~2초 차이로 정리에서 빠졌어요. 며칠 · 몇 시간 차이(다시 내보낸 편집본)는 그대로 걸러요
    if (tag === 'ModifyDate' && isVideoPath(it.src) && isVideoPath(keep) && secondsApart(a[tag], b[tag]) <= VIDEO_MODIFY_SLACK) continue;
    return { why: tag === 'ModifyDate' ? '백업 파일과 수정 시각이 달라 남김 (다른 때 내려받았거나 편집본일 수 있음)' : '0.001초가 달라 남김 (연속 촬영의 다른 사진일 수 있음)', lasting: true };
  }
  const da = D.dateFromMeta(a);
  const db = D.dateFromMeta(b);
  if (!da || !db) return { why: '촬영 날짜를 몰라 남김', lasting: true };
  if (D.toExif(da.parts) !== D.toExif(db.parts)) return { why: '촬영 날짜가 달라 남김', lasting: true };
  const dims = (m) => [Number(m.ImageWidth), Number(m.ImageHeight)];
  const [aw, ah] = dims(a);
  const [bw, bh] = dims(b);
  if (![aw, ah, bw, bh].every((n) => Number.isFinite(n) && n > 0)) return { why: '가로 · 세로를 몰라 남김', lasting: true };
  if ((aw === bw && ah === bh) || (aw === bh && ah === bw)) return null;
  const bigger = bw * bh > aw * ah ? '백업이 더 큼' : '원본이 더 큼';
  return { why: `백업 파일과 가로 · 세로가 달라 남김 (${aw}x${ah} / 백업 ${bw}x${bh}, ${bigger}, 잘라낸 편집본일 수 있음)`, lasting: true };
}

// 원본 대신 남아 있을 결과 파일
function keepPathOf(job, it) {
  if (it.finalPath) return it.finalPath;
  if (it.dupOf) return it.dupOf;
  if (it.dupOfItem != null) {
    const keep = job.items[it.dupOfItem];
    if (keep && keep.status === 'done' && keep.finalPath) return keep.finalPath;
  }
  return null;
}

// 파일 정보 한 번 읽기 (없거나 못 읽으면 null)
function statOrNull(p) {
  try {
    return fs.statSync(p, { bigint: true }); // bigint: Windows 파일 ID가 커서 보통 숫자로는 잘려요
  } catch (e) {
    return null;
  }
}

// 빠른 확인 (지문 계산 없이) — 배너에 "정리할 수 있는 원본 N개" 보여줄 때
//   중복은 크기를 보지 않아요 (2026-11-23): 백업 파일에 태그를 쓰면 크기가 바뀌어도 같은 사진이에요
//     내용이 정말 다르면 정리 직전 확인에서 까닭을 기록하고(cleanSkip) 다음부터 여기서 빠져요
//   원본마다 디스크는 두 번만 읽어요 (원본 1번, 남길 파일 1번). 있는지 · 같은 파일인지 · 크기를 그 정보로 봐요
//   (전에는 6번: 중복 6만 개면 36만 번이라 미리보기 직후 멈출 수 있었음, #49 검증)
function cleanCandidates(job) {
  if (!job) return [];
  const shot = shotKeepsOf(job);
  return job.items.filter((it) => {
    if (!mayClean(it)) return false;
    const src = statOrNull(it.src);
    if (!src) return false; // 원본이 없음
    const keep = keepPathOf(job, it);
    if (!keep || keyOf(keep) === keyOf(it.src)) return false;
    return keptOk(it, keep, src, statOrNull(keep), shot);
  });
}

// "같은 촬영"(애플 ID)으로 이어진 백업 파일들 (변환 중복이 남길 파일)
//   예전 미리보기는 내용이 똑같은 쌍둥이 원본을 그 백업 파일로 이어 주면서 "같은 촬영" 표시를 빠뜨렸어요
//   → 쌍둥이가 같은 촬영으로 이어진 백업 파일이면 이것도 후보로 봐요 (정리 직전에 애플 ID · 날짜 · 가로세로를 다시 봐요)
function shotKeepsOf(job) {
  return new Set(job.items.filter((x) => x.status === 'dup' && x.converted && x.sameShot && x.dupOf && !x.check).map((x) => keyOf(x.dupOf)));
}

// 파일을 읽기 전에 거를 수 있는 것
function mayClean(it) {
  if (it.trashed || it.movedTo) return false; // 이미 정리함
  if (it.status !== 'done' && it.status !== 'dup') return false;
  if (it.status === 'dup' && it.check) return false; // 확인 필요 → 사람이 봐야 해요
  // 정리 확인에서 규칙에 걸려 남기기로 한 원본 (까닭은 cleanSkip, 개선 12)
  //   다시 확인해도 같은 결과라 배너 "지울 수 있는 원본" 에서 빼요 (2026-11-15 실사용: 256개가 매번 세지고 매번 0개로 끝남)
  //   확인 창의 중복 비교에서 사용자가 "남기기"한 원본도 같은 방식 (까닭 "사용자가 남김", lib/dup-compare.js)
  if (it.cleanSkip) return false;
  return true;
}

// 원본 · 남길 파일 정보로 판단 (src, kept: 파일 정보, 없으면 null)
//   shot: shotKeepsOf(job) — 같은 촬영으로 이어진 백업 파일들 (없으면 sameShot 표시만 봐요)
function keptOk(it, keep, src, kept, shot = null) {
  // 남길 파일이 원본과 "확실히 다른 파일"일 때만 (경로가 달라도 같은 파일일 수 있어요 → lib/paths.js)
  if (!kept || sameFile(keep, it.src, kept, src) !== false) return false;
  if (it.status !== 'dup') return true;
  // 변환된 중복은 크기가 다를 수밖에 없어요 → 애플 ID로 같은 촬영이 된 것만 (정리 직전에 날짜와 가로×세로까지 다시 봐요)
  //   쌍둥이 원본을 따라 같은 촬영 백업 파일로 이어진 것도 포함 (shot)
  if (it.converted) return !!it.dupOf && (!!it.sameShot || !!(shot && shot.has(keyOf(it.dupOf))));
  // 크기가 달라도 후보로 둬요: 백업 파일에 태그를 쓰면 크기가 바뀌어요 (2026-11-23)
  //   정리 직전 확인이 내용 지문으로 다시 보고, 내용이 다르면 "규칙에 걸려 남김"으로 기록해 다음부터 배너에서 빠져요
  return true;
}

// cleanCandidates 와 같은 판단을, 프로그램이 멈추지 않게 기다리지 않는 방식으로 해요 (앱은 이것만 써요)
//   2026-11-15 실사용: 완료 · 중복 1만 9천 개에서 파일 정보 3만 7천 번을 기다리며 읽느라 창이 4분 "응답 없음"
//   여러 개를 동시에 읽고(concurrency), 그동안에도 창은 움직여요
//   shouldStop(): true 가 되면 그만 읽고 null 을 돌려줘요 (더 새로운 계산이 시작됐을 때)
//   돌려주는 순서는 작업 목록 순서 그대로예요
async function cleanCandidatesAsync(job, { concurrency = 16, shouldStop = () => false } = {}) {
  if (!job) return [];
  const pending = job.items.filter(mayClean);
  const shot = shotKeepsOf(job);
  const ok = new Array(pending.length).fill(false);
  let next = 0;
  let stopped = false;
  const statAsync = (p) => fs.promises.stat(p, { bigint: true }).catch(() => null);
  const worker = async () => {
    while (next < pending.length && !stopped) {
      if (shouldStop()) {
        stopped = true;
        return;
      }
      const n = next++;
      const it = pending[n];
      const src = await statAsync(it.src);
      if (!src) continue; // 원본이 없음
      const keep = keepPathOf(job, it);
      if (!keep || keyOf(keep) === keyOf(it.src)) continue;
      ok[n] = keptOk(it, keep, src, await statAsync(keep), shot);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency | 0) }, worker));
  if (stopped) return null;
  return pending.filter((_, n) => ok[n]);
}

// 지문 다시 쓰기 (확인 창에서 계산한 지문을 실제 정리 때 다시 써요, 2026-11-09 사용자 결정)
//   파일의 크기 · 수정 시각 · 변경 시각(ctime) · 파일 번호(ino)가 계산할 때와 하나라도 다르면 다시 계산해요
//   변경 시각은 프로그램이 수정 시각을 예전 값으로 되돌려도 바뀌어요 (같은 크기로 덮어쓴 파일을 거르려고, #70 검증 ⚠️)
//   → 확인 창을 띄운 뒤 파일이 바뀌었으면 정리 직전 확인에서 그대로 걸러져요 (안전 확인은 빠지지 않음)
//   정리 한 번(확인 창 → 정리)에만 쓰고 버려요. 앱이 켜진 동안 계속 기억하지 않아요
//   돌려주는 함수에 .stats = { computed: 계산한 수, reused: 다시 쓴 수 } (점검용)
function createHashCache(hashOf = hashFile) {
  const memo = new Map(); // 경로 → { sig, hash }
  const sigOf = (p) => {
    const s = fs.statSync(p, { bigint: true });
    return `${s.size}|${s.mtimeNs}|${s.ctimeNs}|${s.dev}|${s.ino}`;
  };
  const cached = async (p) => {
    const before = sigOf(p); // 못 읽으면 오류 → 부르는 쪽에서 "남겨 둠"
    const m = memo.get(p);
    if (m && m.sig === before) {
      cached.stats.reused++;
      return m.hash;
    }
    const hash = await hashOf(p);
    cached.stats.computed++;
    // 계산하는 도중에 바뀌었으면 기억하지 않아요 (다음에 다시 계산)
    if (sigOf(p) === before) memo.set(p, { sig: before, hash });
    else memo.delete(p);
    return hash;
  };
  cached.stats = { computed: 0, reused: 0 };
  return cached;
}

// 지문 계산 개수를 "지금부터" 세기 (원본 정리 로그 끝 줄에 남기려고, 2026-11-11 사용자 결정)
//   확인 창에서 이미 계산한 개수는 빼고, 실제 정리 직전 확인에서 다시 계산한 수 · 다시 쓴 수만 세요
//   돌려주는 함수를 부르면 { computed, reused }. createHashCache로 만든 함수가 아니면 null (로그에 안 적음)
function countHashesFrom(hashOf) {
  const s = hashOf && hashOf.stats;
  if (!s) return () => null;
  const start = { computed: s.computed, reused: s.reused };
  return () => ({ computed: s.computed - start.computed, reused: s.reused - start.reused });
}

// 결과 파일이 멀쩡한지: 0바이트가 아니고, 열어서 읽을 수 있고, (기록해 둔 지문이 있으면) 지문이 같은지
async function resultOk(p, expectedHash, hashOf) {
  try {
    if (fs.statSync(p).size === 0) return false;
    const fd = fs.openSync(p, 'r');
    try {
      fs.readSync(fd, Buffer.alloc(1), 0, 1, 0); // 실제로 읽히는지
    } finally {
      fs.closeSync(fd);
    }
    if (expectedHash) return (await hashOf(p)) === expectedHash;
    return true;
  } catch (e) {
    return false;
  }
}

// 정리 직전의 엄격한 확인
//   완료: 결과 파일이 멀쩡해야 (0바이트 아님, 읽힘, 저장할 때 기록한 지문과 같음)
//   중복: 남길 파일과 지문까지 같아야
//   hashOf: 지문 계산 함수 (점검 때 바꿔 끼울 수 있게)
//   onProgress({ done, total }): 파일 하나 확인할 때마다 (큰 영상이 많으면 1분 넘게 걸려서 화면에 보여줘요)
//   ffprobe: 영상 확인 도구 경로. 없으면 재생되는지 모르니 영상 원본은 남겨 둬요
//   store, logger: 손상을 찾으면 "재생 불가"로 기록하고 로그를 남겨요 (배너 개수도 다음부터 맞아요)
//   readMeta: 변환된 중복 확인용 정보 읽기 (없으면 변환된 중복은 남겨 둬요)
//   sameContent(원본, 남길 파일) → { same, why, lasting }: 바이트 지문이 다를 때 내용 지문으로 한 번 더 비교 (lib/content-hash.js)
//     백업 파일에 태그를 쓰면 바이트 지문이 바뀌어서, 이게 없으면 그 원본은 남아요 (없으면 지금까지처럼 바이트만 봐요)
//
// 확인 수준 (2026-11-15 사용자 결정, docs/decisions/2026-11-15-clean-check-level.md)
//   완료 항목 중 "쓸 때 기록한 서명(크기 · 시각 · 파일 번호)이 지금도 그대로"인 결과 파일은 그 뒤로 아무도 건드리지 않은 것
//     → 저장할 때 계산한 지문을 믿고 다시 읽지 않아요 (6만 개 750GB 다시 읽기에 4~5시간 걸렸어요)
//   대신 그중 표본(1%, 최소 30 · 최대 500개)은 끝까지 읽어 지문을 맞춰요. 하나라도 다르면 → 전부 지문으로 확인
//   변경 시각(ctime)을 기록하지 않는 디스크(exFAT 등, 같은 드라이브의 파일이 모두 같은 값)는 서명이 약해서
//     표본을 5%(최소 30 · 최대 3,000개)로 늘려요 (2026-11-15 사용자 결정, #114 검증 ⚠️)
//   deep: true 면 지금까지처럼 전부 지문으로 (기록을 믿지 않음)
//   서명 · 재생 확인 기록이 없는 옛 작업 기록도 지금까지처럼 전부 지문으로 확인해요
//   pickSample(목록, 개수): 표본 고르기 (점검 때 바꿔 끼울 수 있게, 기본은 무작위)
//   onStats({ total, trusted, sampled, sampleFail, deep, weak }): 확인 요약 (로그 · 화면 안내용), weak = 변경 시각 없는 디스크의 파일 수
//   sigOf(경로): 서명 읽기 (점검 때 exFAT 를 흉내 내려고 바꿔 끼울 수 있게, 기본은 fileSig)
//   sigs: Map 을 주면 통과한 항목마다 i → { src, keep, keepPath } 서명을 채워요 → 정리 직전 확인(recheckTargets)이 써요
const SAMPLE_RATE = 0.01;
const SAMPLE_MIN = 30;
const SAMPLE_MAX = 500;
const WEAK_RATE = 0.05; // 변경 시각이 없는 디스크
const WEAK_MAX = 3000;
function sampleSize(n, weak = false) {
  const rate = weak ? WEAK_RATE : SAMPLE_RATE;
  const max = weak ? WEAK_MAX : SAMPLE_MAX;
  return Math.min(n, Math.max(SAMPLE_MIN, Math.min(max, Math.ceil(n * rate))));
}
// 서명 글자에서 변경 시각 · 드라이브 번호 꺼내기 (lib/paths.js sigOfStat 순서: 크기|수정|변경|드라이브|파일 번호)
const sigPart = (sig, k) => String(sig).split('|')[k];
function randomPick(list, n) {
  const a = list.slice();
  for (let k = 0; k < n && k < a.length; k++) {
    const j = k + Math.floor(Math.random() * (a.length - k));
    [a[k], a[j]] = [a[j], a[k]];
  }
  return a.slice(0, n);
}

// 쓸 때 기록을 믿을 수 있는 완료 항목인지 (지금 서명을 돌려줘요. 못 믿으면 null)
//   지문 · 서명 기록이 있고, 지금 서명이 기록과 같고, 영상이면 만든 직후 재생 확인을 통과했어야 해요
async function trustedSig(it, keep, sigOf = fileSig) {
  if (it.status !== 'done' || !it.resultHash || !it.resultSig) return null;
  if (isVideoPath(keep) && !it.resultPlayable) return null;
  const cur = await sigOf(keep);
  return cur && cur === it.resultSig ? cur : null;
}

// 여러 개를 동시에 (파일 정보 읽기용)
async function eachLimit(list, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const n = next++;
      await fn(list[n], n);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker));
}

async function cleanTargets(job, { hashOf = hashFile, onProgress = () => {}, ffprobe = null, store = null, logger = null, readMeta = null, sameContent = null, deep = false, pickSample = randomPick, onStats = () => {}, sigs = null, sigOf = fileSig } = {}) {
  const list = await cleanCandidatesAsync(job); // 파일이 많으면 몇 분 걸려요. 그동안 창이 멈추지 않게
  let log = null;
  const logLine = (line) => {
    if (!logger) return;
    if (!log) log = logger.newLog('clean-check', `# 정리 직전 확인 / ${now()}\n# 시간\t상태\t원본\t남을 파일\t메모`);
    log.write(line);
  };

  // 규칙에 걸려 남기는 원본: 까닭을 로그에 쓰고, 다시 확인해도 같은 결과면 작업 기록에 남겨요 (개선 12)
  //   → 배너 "지울 수 있는 원본" 에서 빠지고, 목록 메모에 까닭이 보여요
  let skipped = 0;
  const skipFor = (it, keep, r) => {
    logLine(`${now()}\t남김\t${it.src}\t${keep}\t${r.why}`);
    if (r.lasting && store) {
      store.mark(job, it.i, { cleanSkip: r.why });
      skipped++;
    }
  };

  // 하나 끝까지 확인 (지금까지의 엄격한 확인 그대로). 통과하면 확인 전 서명을 돌려줘요, 아니면 null
  //   확인하는 동안 파일이 바뀌었으면(서명이 달라짐) 통과로 보지 않아요
  //   sampled: 표본 검사 → 만든 직후 재생 확인을 통과한 영상은 지문만 맞춰요 (지문이 같으면 그때 확인한 그 내용 그대로라서)
  const fullCheck = async (it, sampled = false) => {
    const keep = keepPathOf(job, it);
    const before = { src: await sigOf(it.src), keep: await sigOf(keep) };
    if (!before.src || !before.keep) return null;
    const probed = sampled && it.status === 'done' && it.resultPlayable;
    const v = isVideoPath(keep) && !probed ? await probeVideo(ffprobe, keep) : { ok: true };
    let ok = false;
    if (v.ok === false) {
      if (store) store.mark(job, it.i, { status: 'broken', note: `백업에 남을 파일이 재생되지 않아서 원본을 남겨 둠 (${v.reason})` });
      logLine(`${now()}\t재생불가\t${it.src}\t${keep}\t${v.reason}`);
    } else if (v.ok === null) {
      // 모름 → 남겨 둠 (손상이라고 단정하지는 않아요)
    } else if (it.status === 'done') {
      ok = await resultOk(keep, it.resultHash, hashOf);
      // 저장한 뒤 백업 파일이 바뀌었으면(태그를 씀 등) 원본과 내용 지문으로 한 번 더 비교해요 (2026-11-23, lib/content-hash.js)
      //   변환한 파일은 내용이 원본과 달라 비교할 수 없어요 → 지금처럼 남김 (태그 쓰기 기록으로 푸는 건 2단계)
      //   표본 검사에서는 하지 않아요: 쓸 때 기록을 믿어도 되는지 보는 검사라서, 다르면 그대로 "다름"이어야 해요
      //   까닭은 로그에만 남겨요 (작업 기록에 남기지 않음: 완료 항목은 지금까지도 다시 확인해 왔어요)
      if (!ok && !sampled && !it.converted && sameContent && it.resultHash && (await resultOk(keep, null, hashOf))) {
        const r = await sameContent(it.src, keep);
        ok = r.same;
        if (!ok) skipFor(it, keep, { why: `백업 파일이 저장 때와 달라짐 — ${r.why}`, lasting: false });
      }
    } else if (it.converted) {
      if (readMeta && (await resultOk(keep, null, hashOf))) {
        const r = await convertedDupWhy(it, keep, readMeta);
        ok = r === null;
        if (r) skipFor(it, keep, r);
      }
    } else {
      try {
        // 남길 파일을 못 읽으면(resultOk 실패, 잠김 등) 기록하지 않고 다음에 다시 확인해요. 지문까지 읽고 다를 때만 기록 (#116 검증 ⚠️)
        if (await resultOk(keep, null, hashOf)) {
          // 크기가 다르면 바이트 지문도 달라요
          const sameSize = fs.statSync(keep).size === fs.statSync(it.src).size;
          ok = sameSize && (await hashOf(it.src)) === (await hashOf(keep));
          if (!ok) {
            // 바이트가 다르면 내용 지문으로 한 번 더: 백업 파일에 태그를 쓰면 크기 · 지문이 바뀌어요 (2026-11-23, lib/content-hash.js)
            //   sameContent 가 없으면(점검 등) 지금까지와 같아요: 크기가 다르면 다음에 다시 확인, 크기가 같은데 지문이 다르면 기록
            const r = sameContent
              ? await sameContent(it.src, keep)
              : sameSize
                ? { same: false, why: '백업 파일과 내용(지문)이 달라 남김', lasting: true }
                : { same: false, why: '백업 파일과 크기가 달라 남김', lasting: false };
            ok = r.same;
            if (!ok) skipFor(it, keep, r);
          }
        }
      } catch (e) {
        ok = false; // 못 읽으면 안전하게 남겨 둠 (다음에 다시 확인)
      }
    }
    if (!ok) return null;
    const after = { src: await sigOf(it.src), keep: await sigOf(keep) };
    return after.src === before.src && after.keep === before.keep ? { ...before, keepPath: keep } : null;
  };

  // 1) 기록을 믿을 수 있는 완료 항목 고르기 (파일 정보만 읽어요, 내용은 안 읽음)
  const trusted = new Map(); // it → { src, keep, keepPath }
  if (!deep) {
    await eachLimit(list, 16, async (it) => {
      const keep = keepPathOf(job, it);
      const k = await trustedSig(it, keep, sigOf);
      const s = k && (await sigOf(it.src));
      if (k && s) trusted.set(it, { src: s, keep: k, keepPath: keep });
    });
  }

  // 2) 표본 지문 검사: 믿는 것 중 일부를 끝까지 읽어 맞춰 봐요
  const decided = new Map(); // it → 서명(통과) 또는 null(남김)
  let checked = 0;
  const tick = () => onProgress({ done: ++checked, total: list.length });
  const trustedList = list.filter((it) => trusted.has(it));
  // 드라이브마다: 변경 시각이 모두 한 값이면(파일 2개 이상) 그 디스크는 변경 시각을 기록하지 않는 것 → 표본을 늘려요
  const byDev = new Map(); // 드라이브 번호 → 그 드라이브의 믿는 항목들
  for (const it of trustedList) {
    const dev = sigPart(trusted.get(it).keep, 3);
    if (!byDev.has(dev)) byDev.set(dev, []);
    byDev.get(dev).push(it);
  }
  const sample = [];
  let weak = 0;
  for (const group of byDev.values()) {
    const ctimes = new Set(group.map((it) => sigPart(trusted.get(it).keep, 2)));
    const isWeak = group.length >= 2 && ctimes.size === 1;
    if (isWeak) weak += group.length;
    sample.push(...pickSample(group, sampleSize(group.length, isWeak)));
  }
  let sampleFail = 0;
  for (const it of sample) {
    const r = await fullCheck(it, true);
    decided.set(it, r);
    if (!r) {
      sampleFail++;
      logLine(`${now()}\t표본불일치\t${it.src}\t${keepPathOf(job, it)}\t쓸 때 기록과 파일 정보는 같은데 지문 · 재생 확인이 다름 → 전부 지문으로 확인`);
    }
    tick();
  }
  if (sampleFail) trusted.clear(); // 기록을 믿을 수 없음 → 아래에서 전부 끝까지 확인

  // 3) 나머지: 믿을 수 있으면 기록대로, 아니면 끝까지 확인
  const out = [];
  for (const it of list) {
    let r;
    if (decided.has(it)) r = decided.get(it);
    else {
      r = trusted.has(it) ? trusted.get(it) : await fullCheck(it);
      tick();
    }
    if (!r) continue;
    out.push(it);
    if (sigs) sigs.set(it.i, r);
  }

  const stats = { total: list.length, trusted: trustedList.length, sampled: sample.length, sampleFail, deep: !!deep || sampleFail > 0, weak, skipped };
  logLine(`# 요약 / 확인 ${stats.total}개, 쓸 때 기록과 같은 결과 파일 ${stats.trusted}개 (표본 ${stats.sampled}개 지문 확인, 다름 ${stats.sampleFail}개)${weak ? ` / 변경 시각을 기록하지 않는 디스크(exFAT 등)의 파일 ${weak}개는 표본을 5%로 늘림` : ''}${stats.deep ? ' / 전부 지문으로 확인함' : ''}${skipped ? ` / 규칙에 걸려 남긴 원본 ${skipped}개 (까닭은 위 "남김" 줄, 배너에서 뺌)` : ''} / 정리 대상 ${out.length}개`);
  onStats(stats);
  return out;
}

// 정리 직전 확인 (확인 창 → "휴지통으로 옮기기" 사이)
//   확인 창에서 통과한 원본 · 남길 파일의 서명이 그대로인지만 봐요 (2026-11-15 결정)
//   전에는 같은 지문 · 재생 확인을 한 번 더 해서 수십 분 ~ 1시간 걸렸어요. 서명이 바뀐 파일은 정리하지 않고 남겨요
//   sigs: cleanTargets 가 채운 Map (i → { src, keep, keepPath }). 돌려주는 순서는 작업 목록 순서
async function recheckTargets(job, sigs, { concurrency = 16, onProgress = () => {}, sigOf = fileSig } = {}) {
  if (!job || !sigs) return [];
  const entries = [...sigs.entries()].sort((a, b) => a[0] - b[0]);
  const ok = new Array(entries.length).fill(false);
  let done = 0;
  await eachLimit(entries, concurrency, async ([i, s], n) => {
    const it = job.items[i];
    if (it && mayClean(it) && keepPathOf(job, it) === s.keepPath) {
      ok[n] = (await sigOf(it.src)) === s.src && (await sigOf(s.keepPath)) === s.keep;
    }
    onProgress({ done: ++done, total: entries.length });
  });
  return entries.filter((_, n) => ok[n]).map(([i]) => job.items[i]);
}

// 휴지통 설정을 알 수 없을 때 (점검의 가짜 드라이브 판단 등)
const noRecycleInfo = async () => null;
// 휴지통에 든 크기를 확인할 수 없을 때 (Windows가 아님, 점검의 가짜 드라이브 판단 등) → 안내 없이 이번 작업분만
const noBinUsed = async () => undefined;

// 정리하기 전에 보여줄 정보: 개수, 용량, 드라이브별 방법, 경고
//   driveKindOf / recycleOf / binUsedOf / statfs: 점검 때 가짜 함수로 바꿔 끼울 수 있게
//   드라이브 종류는 부를 때마다 새로 확인해요 (USB를 바꿔 꽂았을 수 있어서)
//   binUsedOf(드라이브): 휴지통에 이미 든 크기. 숫자면 그걸 더하고, null(못 읽음)이면 이번 작업분만 세고 안내 한 줄
async function cleanInfo(job, targets, { driveKindOf = createDriveKindOf(), recycleOf = driveKindOf.recycleOf || noRecycleInfo, binUsedOf = driveKindOf.binUsedOf || noBinUsed, statfs = fs.statfsSync } = {}) {
  const groups = new Map(); // 드라이브 + 종류 + 방법별 (C: 안의 폴더에 연결된 USB는 따로 묶임)
  for (const it of targets) {
    const root = realRootOf(it.src);
    const kind = await driveKindOf(it.src);
    const recycle = await recycleOf(it.src);
    const nuke = !!(recycle && recycle.nuke);
    const method = canUseRecycleBin(kind) && !nuke ? 'trash' : 'move';
    const key = `${root}|${kind}|${method}`;
    if (!groups.has(key)) {
      groups.set(key, { root, kind, label: DRIVE_LABEL[kind], method, nuke: canUseRecycleBin(kind) && nuke, maxBytes: recycle ? recycle.maxBytes : null, count: 0, bytes: 0 });
    }
    const d = groups.get(key);
    d.count++;
    d.bytes += it.size || 0;
  }

  const drives = [...groups.values()];
  const warnings = [];
  for (const d of drives) {
    if (d.nuke) warnings.push(`${d.root} 드라이브: 휴지통이 "바로 제거"로 설정돼 있어요 → 영구 삭제되지 않게 휴지통 대신 _정리완료원본으로 옮겨요`);
    if (d.method !== 'trash') continue;
    // 이 작업에서 먼저 휴지통에 보낸 원본 (휴지통 크기를 못 읽을 때만 대신 더해요)
    const already = ((job && job.items) || [])
      .filter((it) => it.trashed && realRootOf(it.src) === d.root)
      .reduce((a, it) => a + (it.size || 0), 0);
    const r = await binWarnings(d.root, d.bytes, d.maxBytes, { binUsedOf, fallbackBytes: already, statfs, failReasonOf: driveKindOf.binFailReason });
    d.binUsed = r.used;
    d.overflow = r.overflow; // 휴지통에 다 담기지 않음 → 사용자가 _정리완료원본 / 휴지통 을 골라요
    d.capBytes = r.capBytes;
    warnings.push(...r.warnings);
  }
  return { count: targets.length, bytes: drives.reduce((a, d) => a + d.bytes, 0), drives, warnings };
}

// 휴지통 용량 경고 (원본 정리와 비슷한 사진 버리기가 같이 써요)
//   이번에 보낼 크기 + 휴지통에 이미 든 크기(다른 작업 · 다른 프로그램에서 버린 것까지)로 판단해요
//   binUsedOf(드라이브): 숫자 = 든 크기, null · 오류 = 못 읽음, undefined = 확인할 휴지통 없음(Windows 아님 · 점검)
//   못 읽으면 fallbackBytes(이 작업에서 이미 보낸 것)만 더하고 안내 한 줄
//   휴지통 크기를 읽으면 이 작업에서 먼저 보낸 것도 그 안에 들어 있어요 → fallbackBytes는 더하지 않음 (두 번 세지 않게)
//   돌려주는 값: { used: 읽은 크기 또는 null, warnings: [글] }
//   failReasonOf(드라이브): 못 읽은 까닭 ('timeout'이면 안내 글에 "시간이 너무 오래 걸렸어요"를 덧붙여요)
async function binWarnings(driveRoot, bytes, maxBytes, { binUsedOf = noBinUsed, fallbackBytes = 0, statfs = fs.statfsSync, failReasonOf = null } = {}) {
  let used = null;
  try {
    used = await binUsedOf(driveRoot);
  } catch (e) {
    used = null; // 읽다 실패 = 못 읽음
  }
  const known = typeof used === 'number' && Number.isFinite(used) && used >= 0;
  const warnings = [];
  const w = binOverflowText(driveRoot, bytes + (known ? used : fallbackBytes), maxBytes, statfs);
  if (w) warnings.push(w);
  if (used !== undefined && !known) {
    const slow = (failReasonOf && failReasonOf(driveRoot)) === 'timeout' ? ' (휴지통에 파일이 많아 시간이 너무 오래 걸렸어요)' : '';
    warnings.push(`${driveRoot} 드라이브: 휴지통에 이미 든 크기를 읽지 못했어요${slow} → 용량 경고는 이 작업에서 휴지통으로 보내는 것만 세어 계산했어요`);
  }
  // overflow: 휴지통에 다 담기지 않음 → 화면에서 "_정리완료원본 / 휴지통" 을 고르게 해요 (2026-11-15 사용자 결정)
  //   capBytes: 휴지통에 남을 수 있는 크기 (설정 크기, 모르면 드라이브의 5% 짐작, 그것도 모르면 null)
  return { used: known ? used : null, warnings, overflow: !!w, capBytes: binCapBytes(driveRoot, maxBytes, statfs) };
}

// 휴지통이 모자란 드라이브 모음 (cleanInfo 결과에서). cleanOriginals 의 moveRoots 로 넘겨요
//   드라이브 이름은 대문자로 맞춰요 (진짜 경로를 못 읽으면 i:\ 와 I:\ 가 달라질 수 있어서, #115 검증 ⚠️)
const rootKey = (r) => String(r).toUpperCase();
function overflowRootsOf(info) {
  return new Set(((info && info.drives) || []).filter((d) => d.method === 'trash' && d.overflow).map((d) => rootKey(d.root)));
}

// 휴지통 설정 크기 (모르면 드라이브의 5% 짐작, 그것도 못 읽으면 null)
function binCapBytes(driveRoot, maxBytes, statfs = fs.statfsSync) {
  if (maxBytes != null) return maxBytes;
  try {
    const st = statfs(driveRoot);
    return st.blocks * st.bsize * 0.05;
  } catch (e) {
    return null;
  }
}

// 휴지통 용량보다 크면, 넘치는 건 Windows가 먼저 버린 것부터 비워요 → 경고 한 줄 (넘지 않으면 null)
//   maxBytes: 휴지통 설정 크기. 모르면 null → 보통 크기(드라이브의 5% 정도)로 짐작
//   원본 정리와 비슷한 사진 버리기가 같이 써요
function binOverflowText(driveRoot, bytes, maxBytes, statfs = fs.statfsSync) {
  if (maxBytes != null) {
    if (bytes <= maxBytes) return null;
    const gb = (maxBytes / 1024 ** 3).toFixed(1);
    return `${driveRoot} 드라이브: 휴지통 설정 크기(${gb}GB)를 넘어요 → 휴지통에 먼저 들어 있던 파일부터 자동으로 비워질 수 있어요`;
  }
  try {
    const s = statfs(driveRoot);
    if (bytes > s.blocks * s.bsize * 0.05) {
      return `${driveRoot} 드라이브: 휴지통 용량(드라이브의 약 5%)을 넘을 수 있어요 → 휴지통에 먼저 들어 있던 파일부터 자동으로 비워질 수 있어요`;
    }
  } catch (e) {
    // 확인 못 하면 넘어감
  }
  return null;
}

// 같은 이름이 이미 있으면 _1, _2 ... (절대 덮어쓰지 않음)
function freePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let n = 1; ; n++) {
    const cand = `${stem}_${n}${ext}`;
    if (!fs.existsSync(cand)) return cand;
  }
}

// 휴지통 없는 드라이브: 가져올 폴더\_정리완료원본\<원래 상대 경로> 로 옮기기
//   같은 드라이브 안에서 이름만 바꾸는 것(rename)이라 공간을 쓰지 않아요.
//   다른 드라이브로는 옮기지 않아요 (복사 후 지우기 = 위험해서 실패로 남김)
function moveToCleanedDir(job, src) {
  return moveIntoCleaned(job.source, src, '가져올 폴더 밖의 파일이라 옮기지 않았어요');
}

// baseDir\_정리완료원본\<baseDir 기준 상대 경로> 로 옮기기 (원본 정리, 비슷한 사진 버리기가 같이 써요)
//   baseDir 밖의 파일이나 이미 _정리완료원본 안의 파일은 옮기지 않아요. 같은 이름이 있으면 _1, _2 (덮어쓰지 않음)
function moveIntoCleaned(baseDir, src, outsideText = '폴더 밖의 파일이라 옮기지 않았어요') {
  const rel = path.relative(baseDir, src);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(outsideText);
  if (rel.split(path.sep)[0] === MOVED_DIR) throw new Error('이미 정리한 원본 폴더 안의 파일이에요');
  const dest = freePath(path.join(baseDir, MOVED_DIR, rel));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return dest;
}

// 원본 정리 실행
//   trash: 휴지통으로 보내는 함수 (앱에서는 Electron의 shell.trashItem, 점검 때는 가짜)
//   드라이브 종류는 정리할 때마다 새로 확인해요
//   휴지통이 실패하거나 "바로 제거"로 설정돼 있으면 → 영구 삭제하지 않고 _정리완료원본으로 이동
//   hashStats: 정리 직전 확인의 지문 개수 { computed, reused } (countHashesFrom). 있으면 끝 줄 뒤에 붙여요
//   moveRoots: 휴지통이 모자라서 사용자가 "_정리완료원본으로 옮기기"를 고른 드라이브 (realRootOf 값 Set). 그 드라이브는 휴지통을 쓰지 않아요
//   userKept: 확인 창의 중복 비교에서 사용자가 "남기기"한 원본들 (lib/dup-compare.js markUserKept 결과). 옮기지 않고 로그에만 남겨요
//     줄이 "#" 으로 시작해서 정리 화면(lib/clean-history.js)은 정리한 파일로 세지 않아요
async function cleanOriginals({ job, store, targets, logger, trash, driveKindOf = createDriveKindOf(), recycleOf = driveKindOf.recycleOf || noRecycleInfo, onProgress = () => {}, hashStats = null, moveRoots = null, userKept = [] }) {
  const log = logger.newLog('clean', `# 원본 정리 / ${now()} / ${targets.length}개\n# 시간\t방법\t원본\t옮긴 곳 또는 남아 있는 결과 파일\n# "예정" 줄 다음에 결과 줄이 없으면 그 파일을 옮기는 도중에 꺼진 것`);
  for (const it of userKept || []) log.write(`# ${now()}\t사용자가 남김\t${it.src}\t${keepPathOf(job, it)}`);
  let trashed = 0;
  let moved = 0;
  let fail = 0;
  const moveKeys = moveRoots ? new Set([...moveRoots].map(rootKey)) : null; // 드라이브 이름 대소문자를 맞춰서 비교
  for (let k = 0; k < targets.length; k++) {
    const it = targets[k];
    try {
      const kind = await driveKindOf(it.src);
      const recycle = await recycleOf(it.src);
      const chosenMove = !!(moveKeys && moveKeys.has(rootKey(realRootOf(it.src)))); // 휴지통이 모자라 옮기기를 고름
      const useBin = canUseRecycleBin(kind) && !(recycle && recycle.nuke) && !chosenMove;
      // 옮기기 "전에" 먼저 적어요 → 옮기는 도중에 꺼져도 어떤 파일을 건드리고 있었는지 로그에 남아요 (L3)
      log.write(`${now()}\t예정(${useBin ? '휴지통' : '이동'})\t${it.src}\t${keepPathOf(job, it)}`);
      let trashErr = null;
      if (useBin) {
        try {
          await trash(it.src);
        } catch (err) {
          trashErr = err;
        }
      }
      if (useBin && !trashErr) {
        store.mark(job, it.i, { trashed: true });
        trashed++;
        log.write(`${now()}\t휴지통\t${it.src}\t${keepPathOf(job, it)}`);
      } else {
        // 휴지통이 실패했는데 원본이 이미 없어졌다면 → 어디로 갔는지 모르니 이동하지 않고 실패로 기록
        if (trashErr && !fs.existsSync(it.src)) throw new Error(`휴지통 결과를 알 수 없어요 (${trashErr.message})`);
        if (trashErr) log.write(`${now()}\t휴지통 실패 → 이동\t${it.src}\t${trashErr.message}`);
        const dest = moveToCleanedDir(job, it.src);
        store.mark(job, it.i, { movedTo: dest });
        moved++;
        const why = chosenMove ? ', 휴지통이 모자라 고른 대로' : canUseRecycleBin(kind) && !useBin ? ', 바로 제거 설정' : '';
        log.write(`${now()}\t이동(${DRIVE_LABEL[kind]}${why})\t${it.src}\t${dest}`);
      }
    } catch (err) {
      fail++;
      log.write(`${now()}\t실패\t${it.src}\t${err.message}`);
    }
    if (k % 20 === 0 || k === targets.length - 1) onProgress({ done: k + 1, total: targets.length });
  }
  // 끝 줄은 "# 끝"으로 시작해야 정리 화면(lib/clean-history.js)이 끝까지 적힌 기록으로 읽어요
  const hashText = hashStats ? ` / 지문 다시 계산 ${hashStats.computed}개, 재사용 ${hashStats.reused}개` : '';
  const keptN = (userKept || []).length;
  const keptText = keptN ? ` / 사용자가 남김 ${keptN}` : '';
  log.write(`# 끝 / 휴지통 ${trashed}, 이동 ${moved}, 실패 ${fail}${keptText}${hashText}`);
  return { trashed, moved, fail, kept: keptN, logPath: log.path };
}

module.exports = { hashFile, createHashCache, countHashesFrom, keepPathOf, cleanCandidates, cleanCandidatesAsync, cleanTargets, recheckTargets, overflowRootsOf, sampleSize, convertedDupOk, convertedDupWhy, secondsApart, cleanInfo, cleanOriginals, moveIntoCleaned, binOverflowText, binWarnings, noBinUsed, realRootOf };

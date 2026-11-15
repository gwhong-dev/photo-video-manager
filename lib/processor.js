// 파일 위치: lib/processor.js
// 역할: 파일 1개 처리 — 변환 → 날짜 → 이름 → 백업 폴더에 저장
//
// ⚠️ 원본은 그대로 둬요! (복사본/변환본을 새로 만듦)
//    원본 삭제는 작업이 끝난 뒤 "삭제할까요?" 물어보고 휴지통으로.
//
// 안전 장치: 작업 중에는 "이름.__tmp__.jpg" 로 만들고,
//            다 끝나면 진짜 이름으로 바꿔요.
//            → 중간에 꺼져도 반쯤 만들어진 파일이 진짜처럼 남지 않아요.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { runCmd, runOrThrow, probeVideo } = require('./tools');
const { sameShot, biggerShot, sameBytes, isVideoPath, COMPARE_TAGS } = require('./planner');
const { hashFile, fileSig } = require('./paths');

const JPG_QUALITY = 92;

// "만든 날짜"는 윈도우/맥에서만 바꿀 수 있어요
const CAN_SET_CREATE = process.platform === 'win32' || process.platform === 'darwin';

async function rmQuiet(p) {
  try {
    await fsp.unlink(p);
  } catch (e) {
    // 없으면 무시
  }
}

// 비어 있는 이름 찾기: 이름.jpg → 이름_1.jpg → 이름_2.jpg ...
//   이름 끝의 숫자(시각 134105, 사진 번호 0101)는 절대 바꾸지 않고, 항상 뒤에 _번호를 붙여요
//   taken: 이 이름을 쓸 수 없는지 (기본: 이미 파일이 있음. 동시에 처리할 때는 다른 파일이 잡아 둔 이름도)
function nextFree(p, taken = (c) => fs.existsSync(c)) {
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const stem = path.basename(p, ext);
  for (let n = 1; ; n++) {
    const cand = path.join(dir, `${stem}_${n}${ext}`);
    if (!taken(cand)) return cand;
  }
}

// 파일 날짜 = 찍은 날짜 (exiftool 인자). 날짜를 모르면 빈 목록
function dateArgs(it) {
  if (!it.date) return [];
  const args = [`-FileModifyDate=${it.date}`];
  if (CAN_SET_CREATE) args.push(`-FileCreateDate=${it.date}`);
  return args;
}

// 임시 파일 이름에서 ImageMagick 이 나눠 만든 조각 이름들 (이름.__tmp__-0.jpg, -1, -2 ...)
//   이 임시 파일에서 나온 이름만 골라요 (같은 폴더의 다른 파일 · 결과 파일은 이름이 달라서 안 걸려요)
function tmpFramesOf(tmp) {
  const dir = path.dirname(tmp);
  const ext = path.extname(tmp);
  const stem = path.basename(tmp, ext); // "이름.__tmp__"
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  const low = (s) => s.toLowerCase();
  return names
    .filter((n) => low(n).startsWith(low(stem) + '-') && low(path.extname(n)) === low(ext) && /^\d+$/.test(n.slice(stem.length + 1, n.length - ext.length)))
    .map((n) => path.join(dir, n));
}
async function rmTmpFrames(tmp) {
  for (const p of tmpFramesOf(tmp)) await rmQuiet(p);
}

// HEIC → JPG
async function convertPhoto(it, tmp, ctx) {
  // 1) 사진 변환 (-auto-orient: 세로 사진 방향 맞추기)
  //    [0] = 첫 번째(본) 사진만. 최신 아이폰 HEIC 에는 깊이 · HDR 보조 사진이 같이 들어 있어서,
  //    [0] 이 없으면 ImageMagick 이 JPG 를 이름-0, -1, -2 로 나눠 만들어 다음 단계가 파일을 못 찾아요 (2026-11-14 실사용)
  await runOrThrow(ctx.magick, [`${it.src}[0]`, '-auto-orient', '-quality', String(JPG_QUALITY), tmp], 'ImageMagick');
  // 2) 원본 촬영 정보(날짜, 장소, 기기, 애플 ID 등) 복사 + 파일 날짜를 한 번에 (exiftool을 두 번 부르지 않게)
  //    회전 정보는 1(정방향) → 변환할 때 이미 돌려놨어요 (안 하면 두 번 돌아감)
  await ctx.et.write(['-overwrite_original', '-tagsFromFile', it.src, '-all:all', '-Orientation#=1', ...dateArgs(it), tmp]);
  return { dated: !!it.date };
}

// MOV → MP4 (다시 압축 안 함 → 빠르고 화질 그대로)
//   probe: 재생 확인 때 읽은 형식 { video, audio } (있으면 ffprobe를 다시 켜지 않아요)
async function convertVideo(it, tmp, ctx, probe) {
  // 영상/소리 형식 확인 (예: 영상 hevc, 소리 aac 또는 pcm)
  let video = (probe && probe.video) || '';
  let audio = (probe && probe.audio) || '';
  if (!probe && ctx.ffprobe) {
    try {
      const r = await runCmd(ctx.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', it.src]);
      for (const line of r.stdout.split(/\r?\n/)) {
        const [name, type] = line.trim().split(',');
        if (type === 'video' && !video) video = name;
        if (type === 'audio' && !audio) audio = name;
      }
    } catch (e) {
      // 확인 못 하면 기본값으로 진행
    }
  }

  // 소리: MP4에서 잘 재생되는 형식만 그대로, 나머지(라이브 포토의 pcm 등)는 AAC로
  const audioOk = ['aac', 'mp3', 'ac3', 'eac3', 'alac'].includes(audio);

  // 소리는 첫 번째 트랙만 (0:a:0). 최신 아이폰 영상은 공간 음향 트랙(apple_apac)이 하나 더 있는데
  //   MP4 에 담을 수 없어서, 소리 트랙을 전부 넣으면 "Invalid argument" 로 실패해요 (2026-11-14 실사용)
  const head = ['-y', '-loglevel', 'error', '-i', it.src, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy'];
  if (video === 'hevc') head.push('-tag:v', 'hvc1'); // 윈도우/맥 재생 호환
  const tail = ['-map_metadata', '0', '-movflags', 'use_metadata_tags', tmp];
  const aac = ['-c:a', 'aac', '-b:a', '192k'];

  try {
    await runOrThrow(ctx.ffmpeg, [...head, ...(audioOk ? ['-c:a', 'copy'] : aac), ...tail], 'FFmpeg');
  } catch (e) {
    if (!audioOk) throw e;
    // 그래도 실패하면 소리만 AAC로 바꿔서 한 번 더
    await rmQuiet(tmp);
    await runOrThrow(ctx.ffmpeg, [...head, ...aac, ...tail], 'FFmpeg');
  }

  // FFmpeg는 XMP 태그(앨범 이름 등)를 옮기지 않아요 → exiftool로 원본에서 복사 + 파일 날짜를 한 번에
  //   XMP-dc(태그·제목·설명)만 복사해요. XMP 속 다른 날짜까지 옮기면 나중에 헷갈릴 수 있어서.
  // 소리 트랙이 2개 이상이었으면 첫 번째만 옮겼다고 작업 메모에 남겨요 (말없이 빠지지 않게)
  const note = probe && probe.audioCount > 1 ? `소리 트랙 ${probe.audioCount}개 중 첫 번째만 옮김` : '';
  if (it.subject && it.subject.length) {
    await ctx.et.write(['-overwrite_original', '-tagsFromFile', it.src, '-XMP-dc:all', ...dateArgs(it), tmp]);
    return { dated: !!it.date, note };
  }
  return { dated: false, note };
}

// ---------- 파일 1개 처리 ----------
// 결과: { status: 'done' | 'dup' | 'broken', finalPath, resultHash, note }
//   broken: 재생할 수 없는 영상 → 복사하지 않고 원본을 그대로 둬요
//   ctx.onBeforeRename({ dest, resultHash }): 진짜 이름으로 바꾸기 "직전"에 불러요
//     → 작업 기록에 "여기로 옮길 예정"을 먼저 적어 두면, 바꾼 직후 꺼져도 이어할 때 알아볼 수 있어요
//   동시에 여러 파일을 처리할 때(runner의 동시 처리) ctx가 이름 잡기를 도와줘요
//     ctx.claim(경로) → 이 파일이 그 이름을 쓰겠다고 잡기 (다른 파일이 이미 잡았으면 false)
//     ctx.release(경로 목록) → 끝난 뒤 잡은 이름 풀기
//     ctx.dirShared(폴더) → 지금 다른 파일도 그 폴더에 쓰는 중인지 (실패 뒤 빈 폴더 정리를 건너뛰려고)
//   한 번에 하나씩 처리할 때는 셋 다 없어도 예전과 똑같이 동작해요
async function processItem(it, ctx) {
  const mine = [];
  try {
    return await processOne(it, ctx, mine);
  } finally {
    if (ctx.release && mine.length) ctx.release(mine);
  }
}

async function processOne(it, ctx, mine) {
  const dir = path.dirname(it.dest);
  const claim = (c) => {
    if (!ctx.claim) return true;
    if (!ctx.claim(c)) return false;
    mine.push(c);
    return true;
  };
  // 이 이름을 쓸 수 없는지: 이미 파일이 있거나, 동시에 처리 중인 다른 파일이 잡아 둔 이름
  const taken = (c) => fs.existsSync(c) || !claim(c);

  // 이어하기: 지난번에 "옮길 예정"만 적고 꺼졌다면 → 그 파일이 이미 저장돼 있는지 지문으로 확인
  const p = it.pending;
  if (p && p.dest && p.resultHash && fs.existsSync(p.dest)) {
    try {
      // 서명은 지문 계산 앞뒤로 읽어 같을 때만 기록 (계산하는 사이에 바뀌면 "새 서명 + 옛 지문"이 되지 않게, #114 검증 ⚠️)
      const s0 = await fileSig(p.dest);
      if ((await hashFile(p.dest)) === p.resultHash) {
        // 영상 재생 확인은 안 했으니 원본 정리 때 다시 해요
        const sig = s0 && s0 === (await fileSig(p.dest)) ? s0 : null;
        return { status: 'done', finalPath: p.dest, resultHash: p.resultHash, resultSig: sig, resultPlayable: false, note: '이어하기: 지난번에 이미 저장돼 있었음' };
      }
    } catch (e) {
      // 못 읽으면 아래에서 평소처럼 다시 처리
    }
  }

  // 영상은 복사하기 전에 재생될 수 있는지 먼저 확인 (전송 때 망가진 파일을 "완료"로 처리하지 않게)
  //   이때 읽은 영상 · 소리 형식은 MOV→MP4 변환에 그대로 써요 (ffprobe 한 번만)
  let unchecked = '';
  let probe = null;
  if (isVideoPath(it.src)) {
    const v = await probeVideo(ctx.ffprobe, it.src);
    if (v.ok === false) return { status: 'broken', note: `재생할 수 없어서 복사하지 않고 원본을 남겨 둠 (${v.reason})` };
    if (v.ok === null) unchecked = `재생되는지 확인하지 못함 (${v.reason})`;
    else probe = v;
  }

  await fsp.mkdir(dir, { recursive: true }); // 년/월/일 폴더 없으면 만들기

  let dest = it.dest;

  // 실행 직전에 한 번 더 확인 (이전에 강제 종료됐다가 이어하는 경우 등)
  if (fs.existsSync(dest)) {
    const other = (await ctx.et.read([dest], COMPARE_TAGS))[0] || {};
    // 같은 촬영이라도 원본이 더 크면(백업에는 공유 앨범 축소본만 있음) 중복이 아니에요 → 번호 붙여 가져와요 (개선 11)
    const same = (!it.converted && (await sameBytes(it.src, dest))) || (sameShot(it.meta, other) && !biggerShot(it.meta, other));
    if (same) return { status: 'dup', finalPath: dest, note: '이미 있음 (실행 직전 확인)' };
    dest = nextFree(dest, taken);
  } else if (!claim(dest)) {
    dest = nextFree(dest, taken); // 동시에 처리 중인 다른 파일이 이 이름을 먼저 잡았어요
  }

  const ext = path.extname(dest);
  const tmp = path.join(dir, path.basename(dest, ext) + '.__tmp__' + ext);
  // exiftool은 정보를 쓸 때 "이름_exiftool_tmp"를 만들었다가 바꿔요 → 쓰는 중에 꺼지면 그 파일이 남아
  //   다음부터 "Temporary file already exists"로 계속 실패해요. 우리 임시 파일에 붙는 것이라 지워도 안전해요 (L4)
  const etTmp = tmp + '_exiftool_tmp';
  await rmQuiet(tmp);
  await rmQuiet(etTmp);
  if (it.kind === 'heic2jpg') await rmTmpFrames(tmp); // 조각은 ImageMagick 만 만들어요 (다른 종류는 폴더를 읽지 않게)
  let resultHash = null;
  let resultSig = null; // 다 쓴 결과 파일의 서명 (크기 · 시각 · 파일 번호)
  let resultPlayable = false; // 영상: 만든 직후 재생 확인을 통과했는지
  let convNote = '';

  try {
    // 1) 변환 또는 복사 (변환하면서 파일 날짜까지 쓴 경우 dated)
    let dated = false;
    if (it.kind === 'heic2jpg') ({ dated } = await convertPhoto(it, tmp, ctx));
    else if (it.kind === 'mov2mp4') ({ dated, note: convNote } = await convertVideo(it, tmp, ctx, probe));
    else {
      await fsp.copyFile(it.src, tmp);
      // 원본이 읽기 전용(압축 푼 iCloud 파일 등)이면 복사본도 읽기 전용이 돼서 날짜 쓰기가 실패해요
      //   → 우리가 만든 임시 복사본만 쓰기 가능으로 (원본 속성은 건드리지 않음)
      await fsp.chmod(tmp, 0o666);
    }

    // 2) 파일 날짜 = 찍은 날짜
    if (it.date) {
      if (!dated) await ctx.et.write(['-overwrite_original', ...dateArgs(it), tmp]);
    } else {
      // 날짜없음 → 원본의 수정 날짜 그대로 유지 (참고용)
      const st = await fsp.stat(it.src);
      await fsp.utimes(tmp, st.atime, st.mtime);
    }

    // 3) 결과 확인 + 디스크에 확실히 기록(갑자기 전원이 꺼져도 내용이 남게) + 지문 기록
    const st = await fsp.stat(tmp);
    if (st.size === 0) throw new Error('결과 파일이 비어 있어요');
    const fh = await fsp.open(tmp, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    resultHash = await hashFile(tmp);

    // 3-1) 만든 영상이 재생되는지 지금 확인해요 (방금 쓴 파일이라 빨라요)
    //   전에는 원본 정리 때 영상 2만여 개를 하나씩 다시 확인해서 몇 시간 걸렸어요 (2026-11-15 결정)
    //   재생되지 않으면 실패로 → 원본은 그대로, "실패한 파일 다시 시도"로 다시 만들 수 있어요
    if (isVideoPath(dest)) {
      const rv = await probeVideo(ctx.ffprobe, tmp);
      if (rv.ok === false) throw new Error(`만든 영상이 재생되지 않아요 (${rv.reason})`);
      resultPlayable = rv.ok === true; // 모르면(도구 없음 등) false → 원본 정리 때 다시 확인
    }

    // 4) 진짜 이름으로 바꾸기 (바꾸기 전에 "여기로 옮길 예정"을 먼저 기록)
    if (fs.existsSync(dest)) dest = nextFree(dest, taken);
    if (ctx.onBeforeRename) await ctx.onBeforeRename({ dest, resultHash });
    await fsp.rename(tmp, dest);
    // 5) 다 쓴 결과 파일의 서명 기록 → 원본 정리 때 서명이 그대로면 지문을 다시 읽지 않아요 (lib/cleaner.js)
    resultSig = await fileSig(dest);
  } catch (e) {
    await rmQuiet(tmp); // 반쯤 만든 파일 정리
    await rmQuiet(etTmp); // exiftool이 쓰다 만 임시 파일도
    if (it.kind === 'heic2jpg') await rmTmpFrames(tmp); // ImageMagick 이 나눠 만든 이름.__tmp__-0.jpg 같은 것도
    // 방금 만든 빈 폴더면 정리 (안에 파일 있으면 안 지워짐). 다른 파일이 지금 같은 폴더에 쓰는 중이면 건너뛰어요
    if (!(ctx.dirShared && ctx.dirShared(dir))) await fsp.rmdir(dir).catch(() => {});
    throw e;
  }

  const note = [dest !== it.dest ? '실행 직전 이름 겹침 → _번호 붙임' : '', unchecked, convNote].filter(Boolean).join(' / ');
  return { status: 'done', finalPath: dest, resultHash, resultSig, resultPlayable, note };
}

module.exports = { processItem, nextFree, tmpFramesOf };

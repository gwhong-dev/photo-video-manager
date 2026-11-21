// 파일 위치: lib/motion-photo.js
// 역할: "모션 포토"(JPG 파일 끝에 짧은 영상이 붙은 사진)에서 영상 부분이 어디서 시작하는지 찾기 (2026-11-21 사용자 요청: 라이브 포토 재생)
//   실사용 사진(2026-11-17, 아이폰에서 내보낸 JPG)은 영상 파일이 따로 없고 JPG 끝에 H.264 영상(약 3초)이 붙어 있었어요
//   사진 안 정보(XMP)에 "끝에서 몇 바이트가 영상인지"가 적혀 있어요. 두 가지 적는 법을 읽어요
//     - MicroVideoOffset="N"            (구글 모션 포토 1판, GCamera)
//     - Item:Semantic="MotionPhoto" 의 Item:Length="N"  (모션 포토 2판, Container 목록)
//   찾은 자리가 실제 영상(MP4/MOV 머리 'ftyp')으로 시작할 때만 영상으로 봐요. 아니면 없음
//   사진 파일은 읽기만 해요 (고치지 않아요). Electron은 쓰지 않아요 (lib/ 규칙)
//
// 모양: motionVideoOf(filePath) → Promise<{ start, length } | null>  (start = 파일 안 영상 시작 위치)
//       readMotionVideo(filePath) → Promise<Buffer | null>

const fs = require('fs');

const HEAD_BYTES = 256 * 1024; // XMP 는 파일 앞쪽에 있어요
const MAX_VIDEO_BYTES = 64 * 1024 * 1024; // 붙은 영상이 이보다 크면 이상한 값으로 봐요

// XMP 글자에서 "끝에서 몇 바이트"를 찾아요 → 숫자 | null
function tailLengthOf(text) {
  // 1판: GCamera:MicroVideoOffset="4609659" (속성) 또는 <GCamera:MicroVideoOffset>4609659</...> (요소)
  const v1 = /MicroVideoOffset(?:="|>)(\d+)/.exec(text);
  if (v1) return Number(v1[1]);
  // 2판: Container:Directory 안의 <Container:Item Item:Semantic="MotionPhoto" Item:Length="N" .../>
  const items = text.match(/<(?:Container:Item|rdf:li)[^>]*Item:Semantic="MotionPhoto"[^>]*>/g) || [];
  for (const it of items) {
    const m = /Item:Length="(\d+)"/.exec(it);
    if (m) return Number(m[1]);
  }
  return null;
}

async function motionVideoOf(filePath) {
  let fh;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const st = await fh.stat();
    const headLen = Math.min(HEAD_BYTES, st.size);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    const text = head.toString('latin1');
    if (!/MicroVideo|MotionPhoto/.test(text)) return null; // 모션 포토 표시가 없는 사진은 여기서 끝 (빨라요)
    const length = tailLengthOf(text);
    if (!length || length <= 8 || length > MAX_VIDEO_BYTES || length >= st.size) return null;
    const start = st.size - length;
    const box = Buffer.alloc(8);
    await fh.read(box, 0, 8, start);
    if (box.toString('latin1', 4, 8) !== 'ftyp') return null; // 영상 머리가 아니면 믿지 않아요
    return { start, length };
  } catch (e) {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function readMotionVideo(filePath) {
  const at = await motionVideoOf(filePath);
  if (!at) return null;
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(at.length);
    await fh.read(buf, 0, at.length, at.start);
    return buf;
  } finally {
    await fh.close().catch(() => {});
  }
}

module.exports = { motionVideoOf, readMotionVideo, tailLengthOf };

// 파일 위치: lib/media-edit.js
// 역할: 사진 · 영상을 바꾸는 명령 (2026-11-23 사용자 요청, 나중에 할 일 23)
//   지금은 돌리기만. 자르기 · 나누기는 영상 재생이 생긴 뒤 다음 PR 에서 여기에 더해요
//   - 원본은 건드리지 않고 늘 새 파일(out)을 만들어요. 원본을 바꿀지(옛 원본은 휴지통) · 복사본으로 둘지는 부르는 쪽(gallery-main.js)이 정해요
//   - 화질을 잃지 않게 "방향 정보"만 바꿔요
//       JPG          = EXIF Orientation (사진 픽셀은 그대로, 보는 프로그램이 돌려서 보여 줘요)
//       MOV · MP4    = 영상 회전 정보(Rotation). 다시 압축하지 않아요
//       PNG          = 방향 정보를 무시하는 프로그램이 많아서 픽셀을 돌려요 (PNG 는 압축해도 손실이 없어요)
//   - HEIC 등 다른 형식은 아직 못 돌려요 (HEIC 는 방향을 두 군데에 적어서 한쪽만 바꾸면 프로그램마다 다르게 보여요)

const fs = require('fs');
const path = require('path');

// 확장자 → 돌리는 방법
const ROTATE_KIND = { '.jpg': 'exif', '.jpeg': 'exif', '.png': 'pixels', '.mov': 'video', '.mp4': 'video', '.m4v': 'video' };
const rotateKind = (p) => ROTATE_KIND[path.extname(String(p)).toLowerCase()] || null;
const TURNS = [90, 180, 270]; // 시계 방향으로 돌릴 각도

// EXIF Orientation 값 → [좌우 뒤집기 0/1, 시계 방향 회전 각도] (보는 프로그램이 저장된 그림을 이렇게 바꿔서 보여 줘요)
//   1 정방향, 6 시계 90, 3 180, 8 시계 270, 2 좌우 뒤집기, 7 뒤집고 90, 4 뒤집고 180(=위아래 뒤집기), 5 뒤집고 270
const ORIENT = { 1: [0, 0], 6: [0, 90], 3: [0, 180], 8: [0, 270], 2: [1, 0], 7: [1, 90], 4: [1, 180], 5: [1, 270] };

// 지금 Orientation 에서 시계 방향으로 turn 만큼 더 돌린 Orientation (뒤집기는 그대로 두고 각도만 더해요)
function turnOrientation(cur, turn) {
  const [flip, rot] = ORIENT[cur] || ORIENT[1];
  const next = (rot + turn) % 360;
  return Number(Object.keys(ORIENT).find((k) => ORIENT[k][0] === flip && ORIENT[k][1] === next));
}

// 영상 회전 정보(시계 방향 각도)에 turn 을 더한 값 (0 · 90 · 180 · 270)
function turnRotation(cur, turn) {
  const c = ((Math.round(Number(cur) / 90) * 90) % 360 + 360) % 360 || 0;
  return (c + turn) % 360;
}

// sharp 는 처음 쓸 때 불러와요 (lib/thumbs.js 와 같게 파일 열기 캐시는 꺼요: 임시 파일을 바로 지울 수 있게)
let sharpLib = null;
function sharp() {
  if (!sharpLib) {
    sharpLib = require('sharp');
    sharpLib.cache(false);
  }
  return sharpLib;
}

const rmQuiet = (p) => {
  try {
    fs.rmSync(p, { force: true });
  } catch (e) { /* 못 지워도 계속 */ }
};

// exiftool 로 새 파일을 만들 때: "1 image files created" 가 없으면 실패로 봐요 (write 는 created 실패를 못 잡아요)
async function etCreate(et, args) {
  const out = await et.write(args);
  if (!/\b1 image files? created/.test(String(out))) throw new Error('exiftool: 새 파일을 만들지 못했어요');
}

// 돌린 새 파일 만들기. src 는 그대로, out(아직 없는 이름)에 새 파일을 만들어요
//   et: lib/exiftool.js (read · write), turn: 90 · 180 · 270 (시계 방향)
//   실패하면 out 을 지우고 에러를 던져요 (원본은 늘 그대로)
//   → { kind, before, after } (바꾸기 전 · 뒤 방향 값, 로그용)
async function rotateFile({ et, src, turn, out }) {
  if (!TURNS.includes(turn)) throw new Error('돌릴 각도가 올바르지 않아요');
  const kind = rotateKind(src);
  if (!kind) throw new Error('이 형식은 돌릴 수 없어요 (JPG · PNG · MOV · MP4 만)');
  if (!et) throw new Error('exiftool 을 찾지 못했어요');
  if (fs.existsSync(out)) throw new Error('임시 파일 이름이 이미 있어요');
  try {
    if (kind === 'exif') {
      const [m] = await et.read([src], ['Orientation#']);
      const before = Number(m && m.Orientation) || 1;
      const after = turnOrientation(before, turn);
      await etCreate(et, [`-Orientation#=${after}`, '-o', out, src]);
      return { kind, before, after };
    }
    if (kind === 'video') {
      const [m] = await et.read([src], ['Rotation#']);
      const before = Number(m && m.Rotation) || 0;
      const after = turnRotation(before, turn);
      await etCreate(et, [`-Rotation=${after}`, '-o', out, src]);
      return { kind, before, after };
    }
    // PNG: 픽셀을 돌리고(손실 없음) 원본의 정보(날짜 · 위치 등)를 다시 넣어요
    await sharp()(src).rotate(turn).png().toFile(out);
    await et.write(['-overwrite_original', '-tagsFromFile', src, '-all:all', '--Orientation', out]);
    return { kind, before: 0, after: turn };
  } catch (e) {
    rmQuiet(out);
    throw e;
  }
}

module.exports = { rotateFile, rotateKind, turnOrientation, turnRotation, TURNS, ROTATE_KIND };

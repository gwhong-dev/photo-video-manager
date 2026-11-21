// 파일 위치: lib/media-protocol.js
// 역할: pvm:// 요청을 보고 무엇을 돌려줄지 판단 (docs/superpowers/specs/2026-11-01-gallery-design.md 7절 "이미지 전달")
//   - 화면은 파일 경로를 몰라요. pvm://thumb/<id>, pvm://preview/<id>, pvm://original/<id>, pvm://live/<id> 로만 요청해요
//   - 호스트는 이 넷뿐이고 id는 양의 정수(DB에 있는 것)일 때만 응답해요. 그 밖에는 모두 404예요
//   - original: 비교 창에서 확대해 볼 원본 사진 (2026-11-21 사용자 요청). 화면이 바로 그릴 수 있는 형식(JPG · PNG · WebP · GIF · BMP · AVIF)만
//     원본 파일 그대로, 그 밖(HEIC · TIFF 등)은 preview 와 같은 1200px 그림으로 대신해요
//   - live: 라이브 포토의 움직이는 부분 (2026-11-21 사용자 요청). 같은 이름의 짝 영상(lib/live-pair.js 규칙)이 있으면 그 영상,
//     없으면 JPG 끝에 붙은 영상(모션 포토, lib/motion-photo.js). 둘 다 없으면 404 → 화면은 재생 버튼을 안 보여요
//   - 모양이 틀린 주소는 DB도 파일도 건드리지 않고 바로 404예요
//   - Electron은 쓰지 않아요 (lib/ 규칙). protocol.handle 연결은 gallery-main.js 에서 해요
//
// 모양: handleMedia(urlText, { db, thumbs }) → Promise<{ status, path?, buffer?, type? }>
//   thumb   → { status: 200, path: 썸네일 파일 경로, type: 'image/webp' }
//   preview → { status: 200, buffer, type, fallback? } (fallback: true = 원본을 못 읽어 작은 썸네일로 대신함. 경로는 주지 않아요)
//   original → { status: 200, path, type } | preview 와 같은 모양 (화면이 못 그리는 형식)
//   live    → { status: 200, path, type } (짝 영상) | { status: 200, buffer, type: 'video/mp4' } (모션 포토) | { status: 204 } (보통 사진)

const path = require('path');
const { isLivePair } = require('./live-pair');
const { readMotionVideo } = require('./motion-photo');

const HOSTS = ['thumb', 'preview', 'original', 'live'];
// 화면(Chromium)이 원본 그대로 그릴 수 있는 사진 형식 → 보내는 종류
const DRAWABLE = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif' };
const VIDEO_TYPE = { '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

const ID_PATTERN = /^[1-9][0-9]{0,11}$/; // 맨 앞 0 없는 양의 정수 (12자리까지)
const NOT_FOUND = { status: 404 };
const NO_LIVE = { status: 204 }; // live: 사진은 맞는데 움직이는 부분이 없음

// 라이브 포토의 짝 영상: 같은 폴더 같은 이름의 짧은 영상 한 개 (lib/live-pair.js, 버리기와 같은 규칙)
function pairVideoOf(db, file) {
  if (typeof db.sameStem !== 'function') return null;
  const stem = file.path.slice(0, file.path.length - path.extname(file.path).length);
  const videos = db.sameStem(file.root, stem).filter((x) => x.id !== file.id && x.mediaType === 'video' && !x.missing && isLivePair(file, x));
  return videos.length === 1 ? videos[0] : null;
}

async function handleMedia(urlText, { db, thumbs, readMotion = readMotionVideo }) {
  // Electron이 주소를 다듬어 줄 수 있어서 글자 그대로 비교하지 않고 URL로 풀어요
  let u;
  try {
    u = new URL(String(urlText));
  } catch (e) {
    return NOT_FOUND;
  }
  if (u.protocol !== 'pvm:') return NOT_FOUND;
  if (!HOSTS.includes(u.hostname)) return NOT_FOUND;
  if (u.username || u.password || u.port) return NOT_FOUND;
  // 경로는 정확히 /<id> 한 개 (%2F, %20, .. 같은 글자가 든 주소는 여기서 걸러져요)
  if (!u.pathname.startsWith('/') || !ID_PATTERN.test(u.pathname.slice(1))) return NOT_FOUND;
  const id = Number(u.pathname.slice(1));

  try {
    const file = db.getFile(id);
    if (!file || file.missing) return NOT_FOUND;

    if (u.hostname === 'thumb') {
      if (file.thumbState === 'failed') return NOT_FOUND; // 실패한 것은 "다시 읽기"나 파일이 바뀔 때까지 다시 만들지 않아요
      const p = await thumbs.request(id);
      return p ? { status: 200, path: p, type: 'image/webp' } : NOT_FOUND;
    }

    if (u.hostname === 'live') {
      if (file.mediaType !== 'photo' || !path.isAbsolute(file.path)) return NOT_FOUND;
      const v = pairVideoOf(db, file);
      if (v && path.isAbsolute(v.path)) return { status: 200, path: v.path, type: VIDEO_TYPE[path.extname(v.path).toLowerCase()] || 'video/mp4' };
      const buf = await readMotion(file.path);
      // 움직이는 부분이 없는 보통 사진은 204(내용 없음): 404 로 주면 사진을 볼 때마다 화면 오류 로그가 쌓여요 (점검 41g)
      return buf ? { status: 200, buffer: buf, type: 'video/mp4' } : NO_LIVE;
    }

    if (u.hostname === 'original' && file.mediaType === 'photo' && path.isAbsolute(file.path)) {
      const type = DRAWABLE[path.extname(file.path).toLowerCase()];
      if (type) return { status: 200, path: file.path, type };
      // 화면이 못 그리는 형식은 아래 preview 로 대신해요
    }

    if (file.mediaType === 'video' && file.thumbState === 'failed') return NOT_FOUND; // 영상 미리보기는 썸네일을 써요
    const r = await thumbs.preview(id);
    if (!r || !r.buffer) return NOT_FOUND;
    return r.fallback ? { status: 200, buffer: r.buffer, type: r.type, fallback: true } : { status: 200, buffer: r.buffer, type: r.type };
  } catch (e) {
    return NOT_FOUND;
  }
}

module.exports = { handleMedia };

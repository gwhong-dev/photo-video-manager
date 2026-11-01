// 파일 위치: lib/media-protocol.js
// 역할: pvm:// 요청을 보고 무엇을 돌려줄지 판단 (docs/superpowers/specs/2026-11-01-gallery-design.md 7절 "이미지 전달")
//   - 화면은 파일 경로를 몰라요. pvm://thumb/<id>, pvm://preview/<id> 로만 요청해요
//   - 호스트는 thumb, preview 둘뿐이고 id는 양의 정수(DB에 있는 것)일 때만 응답해요. 그 밖에는 모두 404예요
//   - 모양이 틀린 주소는 DB도 파일도 건드리지 않고 바로 404예요
//   - Electron은 쓰지 않아요 (lib/ 규칙). protocol.handle 연결은 gallery-main.js 에서 해요
//
// 모양: handleMedia(urlText, { db, thumbs }) → Promise<{ status, path?, buffer?, type? }>
//   thumb   → { status: 200, path: 썸네일 파일 경로, type: 'image/webp' }
//   preview → { status: 200, buffer, type }

const ID_PATTERN = /^[1-9][0-9]{0,11}$/; // 맨 앞 0 없는 양의 정수 (12자리까지)
const NOT_FOUND = { status: 404 };

async function handleMedia(urlText, { db, thumbs }) {
  // Electron이 주소를 다듬어 줄 수 있어서 글자 그대로 비교하지 않고 URL로 풀어요
  let u;
  try {
    u = new URL(String(urlText));
  } catch (e) {
    return NOT_FOUND;
  }
  if (u.protocol !== 'pvm:') return NOT_FOUND;
  if (u.hostname !== 'thumb' && u.hostname !== 'preview') return NOT_FOUND;
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

    if (file.mediaType === 'video' && file.thumbState === 'failed') return NOT_FOUND; // 영상 미리보기는 썸네일을 써요
    const r = await thumbs.preview(id);
    return r && r.buffer ? { status: 200, buffer: r.buffer, type: r.type } : NOT_FOUND;
  } catch (e) {
    return NOT_FOUND;
  }
}

module.exports = { handleMedia };

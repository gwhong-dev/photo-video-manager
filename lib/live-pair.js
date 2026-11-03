// 파일 위치: lib/live-pair.js
// 역할: 라이브 포토 짝(사진 + 짧은 영상)인지 판단하는 규칙 한 곳
//   같은 폴더, 같은 이름(확장자만 다름)이고 아래를 모두 채워야 짝이에요
//   - 영상 확장자가 .mp4 또는 .mov (가져오기가 MOV를 MP4로 바꿔요. 옛 파일은 MOV일 수 있어요)
//   - 영상 길이를 알고 5초 이하 (아이폰 라이브 포토는 약 3초. 같은 이름의 긴 일반 영상은 짝이 아니에요)
//   - 사진과 영상의 찍은 시각을 둘 다 알고 3초 안
//   하나라도 모르면 짝이 아니라고 봐요 (모르는 영상을 같이 옮기지 않게)
//   Electron은 쓰지 않아요 (lib/ 규칙)

const path = require('path');
const { secondsOf } = require('./similar');

const LIVE_EXT = ['.mp4', '.mov'];
const LIVE_MAX_SEC = 5;
const LIVE_GAP_SEC = 3;

// photo, video: { path, takenAt } + video.durationSec
function isLivePair(photo, video) {
  if (!photo || !video || !LIVE_EXT.includes(path.extname(video.path).toLowerCase())) return false;
  const dur = Number(video.durationSec);
  if (video.durationSec == null || !Number.isFinite(dur) || dur <= 0 || dur > LIVE_MAX_SEC) return false;
  const a = secondsOf(photo.takenAt);
  const b = secondsOf(video.takenAt);
  return a !== null && b !== null && Math.abs(a - b) <= LIVE_GAP_SEC;
}

module.exports = { isLivePair, LIVE_EXT, LIVE_MAX_SEC, LIVE_GAP_SEC };

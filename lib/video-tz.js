// 파일 위치: lib/video-tz.js
// 역할: 시간대 없이 세계 표준시(UTC)로만 시각을 적은 영상(안드로이드 · 디지털카메라)의 현지 시각 맞추기
//   exiftool(-api QuickTimeUTC)은 영상의 QuickTime CreateDate 를 "이 PC 시간대"로 바꿔 줘요
//   → 해외에서 찍은 영상은 한국 시간으로 바뀌어 날짜 폴더가 하루 밀릴 수 있어요 (미국 저녁 8시 → 한국 다음 날 낮 12시)
//
// 맞추는 순서 (앞에서 답이 나오면 그걸 써요, 2026-11-27 사용자 결정 docs/decisions/2026-11-27-video-timezone.md)
//   ① 영상에 시간대가 든 촬영 시각 (아이폰 Keys:CreationDate) → 이미 현지 시각이라 고칠 것 없음
//   ② 영상 GPS → 시간대 지도 (자리만, 다음 PR 에서 부품을 고른 뒤)
//   ③ 같은 폴더에서 12시간 안에 찍은 사진의 시간대(OffsetTimeOriginal)를 빌림 (가장 가까운 사진)
//   ④ 없으면 지금처럼 이 PC 시간대 (짐작으로 틀린 값을 넣지 않음)

const path = require('path');
const D = require('./dates');

const WINDOW_MS = 12 * 3600 * 1000; // 영상과 사진이 이 시간 안에 찍혔을 때만 빌려요

// 이 날짜가 "UTC 를 이 PC 시간대로 바꾼" 영상 시각인지 (영상 + QuickTime CreateDate 에서 읽음)
function needsZone(found, isVideo) {
  return !!(isVideo && found && found.from === '촬영정보' && found.tag === 'CreateDate');
}

// 폴더별 "시간대를 아는 사진" 목록을 모아 두었다가 영상 시각을 맞춰 주는 도우미
function createPhotoZones() {
  const byDir = new Map(); // 폴더(소문자) → [{ ms: 세계 표준시, off: 분, text: "-07:00" }]
  const dirKey = (p) => path.dirname(p).toLowerCase();

  // 사진 하나 등록: 찍은 시각(현지) + OffsetTimeOriginal 이 있어야 세계 표준시를 알 수 있어요
  function addPhoto(filePath, meta) {
    const off = D.offsetMinutes(meta && meta.OffsetTimeOriginal);
    if (off === null) return;
    const found = D.dateFromMeta(meta);
    if (!found || found.tag !== 'DateTimeOriginal') return; // 사진의 찍은 시각만 (영상 태그 · 다른 태그는 섞지 않음)
    const p = found.parts;
    const ms = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - off * 60000;
    const k = dirKey(filePath);
    if (!byDir.has(k)) byDir.set(k, []);
    byDir.get(k).push({ ms, off, text: String(meta.OffsetTimeOriginal).trim() });
  }

  // 영상 날짜 → 맞춘 날짜 (못 맞추면 받은 그대로). 맞추면 zone(시간대 글자) · zoneFrom('사진') 이 붙어요
  function adjust(filePath, found) {
    const ms = D.instantOfExif(found.raw);
    if (ms === null) return found;
    let best = null;
    for (const ph of byDir.get(dirKey(filePath)) || []) {
      const gap = Math.abs(ph.ms - ms);
      if (gap <= WINDOW_MS && (!best || gap < best.gap)) best = { ...ph, gap };
    }
    if (!best) return found;
    const parts = D.partsAtOffset(ms, best.off);
    return parts ? { ...found, parts, zone: best.text, zoneFrom: '사진' } : found;
  }

  return { addPhoto, adjust };
}

module.exports = { needsZone, createPhotoZones, WINDOW_MS };

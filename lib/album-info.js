// 파일 위치: lib/album-info.js
// 역할: iCloud 공유 앨범 폴더의 AlbumInfo.json 에서 사진별 날짜 읽기
//   공유 앨범 사진은 촬영 정보가 지워져 있지만, 앨범 폴더의 AlbumInfo.json 에는
//   사진 이름별 dateCreated 가 남아 있어요. 읽기만 하고 아무것도 바꾸지 않아요.
//   파일 이름은 "같은 앨범 폴더 안"에서만 겹치지 않으므로, 폴더 단위로 찾아요.

const fs = require('fs');
const path = require('path');
const D = require('./dates');

const MAX_BYTES = 20 * 1024 * 1024; // 이보다 큰 파일은 읽지 않음 (이상한 파일 방어)

// 폴더 → Map(소문자 파일 이름 → 날짜) | null (AlbumInfo.json 없음 · 못 읽음)
function createAlbumDates() {
  const cache = new Map();

  function load(dir) {
    const file = path.join(dir, 'AlbumInfo.json');
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_BYTES) return null;
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!json || !Array.isArray(json.photos)) return null;
      const map = new Map();
      for (const p of json.photos) {
        if (!p || typeof p.name !== 'string') continue;
        const found = D.parseAlbumDate(p.dateCreated);
        if (found) map.set(p.name.toLowerCase(), found);
      }
      return map;
    } catch (e) {
      return null; // 없거나 깨졌으면 앨범 날짜는 쓰지 않아요
    }
  }

  // 사진 파일 경로 → 날짜 { parts, from } 또는 null
  return function dateFromAlbum(filePath) {
    const dir = path.dirname(filePath);
    if (!cache.has(dir)) cache.set(dir, load(dir));
    const map = cache.get(dir);
    return (map && map.get(path.basename(filePath).toLowerCase())) || null;
  };
}

module.exports = { createAlbumDates };

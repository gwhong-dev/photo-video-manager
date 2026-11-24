// 파일 위치: lib/same-video.js
// 역할: 백업 폴더에 두 번 저장된 같은 영상 찾기 (비슷한 사진 화면의 "같은 영상" 묶음, 2026-11-24 사용자 요청)
//   예: 2026-11-20 폴더에 IMG_0001.MP4 와 IMG_0001_1.MP4 가 둘 다 있고 내용이 같은 경우 (#141 전 가져오기에서 생긴 것)
//
// 같은 영상으로 보는 조건 (모두 맞아야 해요)
//   1) 같은 폴더(날짜 폴더) + 같은 확장자
//   2) 가로 × 세로가 같고 알고 있음
//   3) 파일 크기 차이가 5% 안 (남길 영상 기준)
//   4) 화면 데이터 지문(lib/tools.js videoStreamHash, ffmpeg 로 화면 데이터만 읽은 sha256)이 같음
//      → 1)~3)에 맞는 후보만 지문을 계산해요 (영상 전체를 읽어서 오래 걸려요)
// 남길 영상: 이름 끝에 _1 · (1) 같은 꼬리가 없는 것 = 확장자를 뺀 이름이 가장 짧은 것 (같으면 이름순, 번호가 작은 것)
//   꼬리는 이름 뒤에 붙기만 해서, 꼬리 없는 원래 이름이 늘 가장 짧아요
// Electron 은 쓰지 않아요 (lib/ 규칙). 옮기기는 lib/similar-discard.js discardFiles 를 같이 써요
//
// 모양
//   buildVideoGroups(rows) → [{ ids: [남길 것 먼저], keepId, files: [row] }]  (rows = db.videoRows)
//   pendingRows(rows) → 지문을 아직 계산하지 않은 후보 줄
//   checkSameVideo(db, root, ids) → { files: [{ id, path, name, size, mtimeMs, vhash, keepers: [{ path, size, mtimeMs }], pair: null }], groups }
//     (틀리면 사람이 읽을 Error)

const path = require('path');
const { MAX_DISCARD } = require('./similar-discard');

const SIZE_GAP = 0.05; // 크기 차이 5% 안

// 확장자를 뺀 이름
function stemOf(name) {
  const s = String(name || '');
  return s.slice(0, s.length - path.extname(s).length);
}

const known = (n) => Number.isFinite(n) && n > 0;
const near = (a, b) => Math.abs(a - b) <= SIZE_GAP * Math.max(a, b);

// 1)~3) 후보 모음: 같은 폴더 · 확장자 · 가로 × 세로 안에서 크기 순으로 놓고 5% 안으로 이어지는 것끼리 → [[row]] (2개 이상인 것만)
function candidateSets(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (!r || !known(r.width) || !known(r.height) || !known(r.size)) continue;
    const key = [path.dirname(r.path).toLowerCase(), path.extname(r.path).toLowerCase(), r.width, r.height].join('|');
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const sets = [];
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.size - b.size || a.id - b.id);
    let cur = [list[0]];
    for (let k = 1; k < list.length; k++) {
      if (near(list[k - 1].size, list[k].size)) cur.push(list[k]);
      else {
        if (cur.length > 1) sets.push(cur);
        cur = [list[k]];
      }
    }
    if (cur.length > 1) sets.push(cur);
  }
  return sets;
}

// 지문을 아직 계산하지 않은 후보 (실패한 것은 다시 하지 않아요: vhashDone)
function pendingRows(rows) {
  return candidateSets(rows).flat().filter((r) => !r.vhashDone);
}

// 남길 영상 순서: 확장자를 뺀 이름이 짧은 것 → 이름순 → 번호가 작은 것
function keepOrder(a, b) {
  return stemOf(a.name).length - stemOf(b.name).length || String(a.name).localeCompare(String(b.name)) || a.id - b.id;
}

// 4) 지문까지 같은 것끼리 묶음
function buildVideoGroups(rows) {
  const groups = [];
  for (const set of candidateSets(rows)) {
    const byHash = new Map();
    for (const r of set) {
      if (typeof r.vhash !== 'string' || !r.vhash) continue;
      if (!byHash.has(r.vhash)) byHash.set(r.vhash, []);
      byHash.get(r.vhash).push(r);
    }
    for (const list of byHash.values()) {
      if (list.length < 2) continue;
      list.sort(keepOrder);
      const keep = list[0];
      // 남길 영상과 크기 차이가 5% 안인 것만 (후보는 이어진 사슬이라 끝끼리는 더 벌어질 수 있어요)
      const members = [keep, ...list.slice(1).filter((r) => near(keep.size, r.size))];
      if (members.length < 2) continue;
      groups.push({ ids: members.map((r) => r.id), keepId: keep.id, files: members });
    }
  }
  // 화면에서 보기 좋게: 남길 영상 번호 순
  groups.sort((a, b) => a.keepId - b.keepId);
  return groups;
}

// 옮기기 전 확인: 지금 DB 로 묶음을 다시 만들어서, 고른 영상이 모두 어느 묶음의 "남길 것이 아닌" 영상인지 봐요 (화면이 보낸 묶음을 믿지 않음)
function checkSameVideo(db, root, ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('옮길 영상을 골라 주세요');
  if (ids.length > MAX_DISCARD) throw new Error(`한 번에 ${MAX_DISCARD.toLocaleString('en-US')}개까지만 옮길 수 있어요`);
  if (!ids.every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('파일 번호 목록이 올바르지 않아요');
  if (new Set(ids).size !== ids.length) throw new Error('같은 영상이 두 번 들어 있어요');
  const groups = buildVideoGroups(db.videoRows(root));
  const where = new Map(); // id → { group, row }
  for (const g of groups) for (const r of g.files) where.set(r.id, { g, r });
  const touched = new Set();
  const files = [];
  for (const id of ids) {
    const hit = where.get(id);
    if (!hit) throw new Error('목록이 바뀌었어요. 화면을 다시 불러온 뒤 골라 주세요');
    if (hit.g.keepId === id) throw new Error('남길 영상은 옮길 수 없어요. 화면을 다시 불러온 뒤 골라 주세요');
    // DB 의 지금 값도 한 번 더 (사라짐 · 다른 폴더 · 영상이 아님)
    const f = db.getFile(id);
    if (!f || f.missing || f.root !== root || f.mediaType !== 'video' || f.path !== hit.r.path) throw new Error('목록이 바뀌었어요. 화면을 다시 불러온 뒤 골라 주세요');
    const k = hit.g.files[0];
    touched.add(hit.g);
    files.push({ id, path: hit.r.path, name: hit.r.name, size: hit.r.size, mtimeMs: hit.r.mtimeMs, vhash: hit.r.vhash, keepers: [{ path: k.path, size: k.size, mtimeMs: k.mtimeMs }], pair: null });
  }
  return { files, groups: touched.size };
}

// 옮기기 직전 지문 다시 보기: 버릴 영상과 남길 영상의 지문을 지금 다시 계산해서 둘 다 DB 값과 같아야 해요
//   hashOf(file) → 지문 문자열 | null. 다르거나 계산 못 하면 Error (그 영상은 옮기지 않아요)
function makeVerify(hashOf) {
  return async (f) => {
    const keeper = f.keepers && f.keepers[0];
    if (!f.vhash || !keeper) throw new Error('같은 영상인지 다시 확인할 수 없어서 옮기지 않았어요');
    const mine = await hashOf(f.path);
    if (mine !== f.vhash) throw new Error('영상 내용이 목록과 달라서 옮기지 않았어요');
    const theirs = await hashOf(keeper.path);
    if (theirs !== f.vhash) throw new Error('남길 영상의 내용이 달라서 옮기지 않았어요');
  };
}

module.exports = { stemOf, candidateSets, pendingRows, buildVideoGroups, checkSameVideo, makeVerify, SIZE_GAP };

// 파일 위치: lib/preview-drive.js
// 역할: 휴지통 확인 창 "미리보기"에서 쓰는 드라이브 판단기를 잠깐 다시 쓰기 (2026-11-21 사용자 지적: 확인 창 버튼이 1~2초 늦게 떠요)
//   드라이브 종류 · 휴지통 설정 · 휴지통에 든 크기를 읽으려면 PowerShell 을 켜서 1~2초 걸려요 (lib/platform.js createDriveKindOf)
//   → 미리보기(gallery-main.js 의 trash-preview · similar-preview)에서만 읽어 둔 것을 다시 쓰고, 갤러리를 열 때 뒤에서 미리 읽어 둬요
//   - 1분(freshMs)이 지났으면 지금 것을 바로 쓰고, 뒤에서 새로 읽어 다음 창부터 바꿔요
//   - 10분(maxMs)이 지났으면 기다려서 새로 읽어요 (USB 를 바꿔 꽂았을 수 있어서 너무 오래된 것은 안 써요)
//   - 옮긴 뒤에는 warm(root, { forget: true }) → 휴지통 크기가 바뀌었으니 버리고 뒤에서 새로 읽어요
//   ⚠️ 실제로 옮길 때(similar-discard · trash-selected)는 이것을 쓰지 않고 매번 새로 확인해요 → 미리보기가 옛 값이어도 옮기는 곳은 그때 정해져요
//   Electron은 쓰지 않아요 (lib/ 규칙)
//
// 모양: createPreviewDrive({ make, now, freshMs, maxMs, rootOf })
//   make(): 새 드라이브 판단기 (lib/platform.js createDriveKindOf 와 같은 모양: kindOf(p) + recycleOf + binUsedOf)
//   get(root) → Promise<판단기>   warm(root, { forget }) → 뒤에서 미리 읽기 (기다리지 않아요)

const { realRootOf } = require('./cleaner');

const FRESH_MS = 60 * 1000;
const MAX_MS = 10 * 60 * 1000;

function createPreviewDrive({ make, now = Date.now, freshMs = FRESH_MS, maxMs = MAX_MS, rootOf = realRootOf } = {}) {
  let cur = null; // { kindOf, ready, at } 지금 쓰는 판단기
  let next = null; // 뒤에서 새로 읽는 중인 판단기

  // 판단기를 새로 만들고 root 드라이브의 종류 · 휴지통 설정 · 든 크기를 미리 읽어요 (실패해도 조용히)
  //   못 읽은 판단기(드라이브 종류 모름 · 휴지통 크기 못 읽음 · 오류)는 이번 한 번만 쓰고 다시 쓰지 않아요
  //   (PowerShell 이 늦어 목록을 못 읽으면 모든 드라이브가 "모름"이 돼서, 그대로 두면 틀린 미리보기가 오래 남아요, #128 검증 ⚠️)
  function load(root) {
    const kindOf = make();
    const entry = { kindOf, at: now(), done: false, ok: false };
    entry.ready = (async () => {
      try {
        if (!root) return;
        const kind = await kindOf(root);
        if (typeof kindOf.recycleOf === 'function') await kindOf.recycleOf(root);
        const used = typeof kindOf.binUsedOf === 'function' ? await kindOf.binUsedOf(rootOf(root)) : undefined;
        entry.ok = kind !== 'unknown' && used !== null;
      } catch (e) {
        /* 미리 읽기 실패: 다시 쓰지 않아요 */
      } finally {
        entry.done = true;
      }
    })();
    return entry;
  }

  async function get(root) {
    if (cur && cur.done && !cur.ok) { // 못 읽은 것은 다시 쓰지 않고 새로 읽어요
      cur = null;
      next = null;
    }
    const age = cur ? now() - cur.at : Infinity;
    if (!cur || age > maxMs) {
      cur = load(root);
      next = null;
    } else if (age > freshMs && !next) {
      const fresh = load(root);
      next = fresh;
      fresh.ready.then(() => {
        if (next !== fresh) return; // 그 사이 버렸어요 (옮긴 뒤 등)
        next = null;
        if (fresh.ok) cur = fresh; // 못 읽었으면 지금 것을 그대로 (1분 뒤 다시 시도)
      });
    }
    const use = cur;
    await use.ready;
    return use.kindOf;
  }

  // 갤러리를 열 때(이미 있으면 그대로) · 옮긴 뒤(forget: 버리고 새로)
  function warm(root, { forget = false } = {}) {
    if (!root) return;
    if (forget) next = null;
    if (forget || !cur) cur = load(root);
  }

  return { get, warm };
}

module.exports = { createPreviewDrive, FRESH_MS, MAX_MS };

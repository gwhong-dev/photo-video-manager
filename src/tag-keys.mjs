// 파일 위치: src/tag-keys.mjs
// 역할: 갤러리 태그 단축키 (2026-11-18 사용자 승인)
//   T = 태그 붙이기 창 열기, 숫자 1~9 = 태그 화면에서 그 숫자로 정한 태그를 바로 붙이기
//   글 쓰는 칸(입력 칸 · 고르기 칸)에 있거나 다른 창 · 메뉴가 열려 있으면 동작하지 않아요
//   Ctrl · Alt · Shift 와 같이 누르거나 키를 누르고 있는 동안(반복)은 무시해요 (Ctrl+숫자 같은 다른 키와 겹치지 않게)
//   한글 입력 상태에서도 되도록 글자(e.key) 대신 자판 자리(e.code)를 먼저 봐요 (한글 상태의 T 는 'ㅅ')
//   React 와 화면을 모르는 계산만 있어요 (점검을 일반 Node로 돌려요)

import { formatCount } from './format.mjs';

// 글 쓰는 칸인지: 여기서는 T 와 숫자가 글자로 들어가야 해요
export function isTypingTarget(target) {
  const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!(target && target.isContentEditable);
}

// 키 하나 → 할 일. e = 키 이벤트 모양 { key, code, ctrlKey, altKey, metaKey, shiftKey, repeat, isComposing }
//   target = 키를 누른 곳(document.activeElement), open = 다른 창이나 메뉴가 열려 있는지
//   → null(아무것도 안 함) | { type: 'open' } (태그 붙이기 창) | { type: 'apply', key: 1~9 }
export function tagKeyAction(e, target, open) {
  if (!e || open) return null;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat || e.isComposing) return null;
  if (isTypingTarget(target)) return null;
  const code = typeof e.code === 'string' ? e.code : '';
  const key = typeof e.key === 'string' ? e.key : '';
  if (code === 'KeyT' || (!code && (key === 't' || key === 'T'))) return { type: 'open' };
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(code) || (!code ? /^([1-9])$/.exec(key) : null);
  if (m) return { type: 'apply', key: Number(m[1]) };
  return null;
}

// 단축키 숫자로 태그 찾기: tags = [{ name, hotkey }] → 이름 (없으면 null)
export function tagOfKey(tags, key) {
  const t = (tags || []).find((x) => x.hotkey === key);
  return t ? t.name : null;
}

// 숫자가 정해진 태그만 숫자 순으로 (우클릭 메뉴의 바로 붙이기 항목)
export function quickTags(tags) {
  return (tags || []).filter((t) => Number.isInteger(t.hotkey)).sort((a, b) => a.hotkey - b.hotkey);
}

// ---------- 화면 글 ----------
// 우클릭 메뉴의 바로 붙이기: "3장에 '여행' 붙이기"
export const quickTagLabel = (count, name) => `${formatCount(count)}장에 '${name}' 붙이기`;
// 정한 태그가 없는 숫자를 눌렀을 때
export const noKeyText = (key) => `숫자 ${key} 키에 정한 태그가 없어요. 태그 화면에서 태그마다 숫자를 정할 수 있어요.`;
// 고른 사진에 이미 모두 붙어 있을 때 (떼지 않아요: 잘못 눌러도 태그가 사라지지 않게)
export const alreadyText = (count, name) => `고른 ${formatCount(count)}장에 이미 모두 '${name}' 태그가 붙어 있어요.`;
// 숫자를 옮겼을 때 (다른 태그가 쓰던 숫자)
export function hotkeyText(name, key, moved) {
  if (key === null) return `'${name}' 태그의 숫자를 뺐어요.`;
  return moved ? `숫자 ${key} 키는 이제 '${name}' 태그예요. '${moved}' 태그에서는 숫자를 뺐어요.` : `숫자 ${key} 키를 누르면 '${name}' 태그가 붙어요.`;
}

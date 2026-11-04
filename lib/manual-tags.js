// 파일 위치: lib/manual-tags.js
// 역할: 내가 붙이는 태그(단계 5)의 규칙. 태그 이름 다듬기와 검사, 붙이기·떼기 미리보기 계산
//   - 태그는 DB(manual_tags 표)와 기록 파일(manual-edits.jsonl)에만 있어요. 사진 파일에는 쓰지 않아요 (2026-11-04 사용자 결정)
//   - 붙이기·떼기 한 번 = 묶음 하나 (종류 tagAdd / tagRemove). 날짜·위치 넣기와 같은 되돌리기 줄로 되돌려요
//   - 묶음의 파일별 값은 "그 사진에 내가 붙인 태그 이름 목록" 전체예요 (이전 → 이후). 되돌리면 이전 목록으로 돌아가요
//   DB와 Electron을 모르는 계산만 있어요 (점검을 일반 Node로 돌려요)

const TAG_KINDS = ['tagAdd', 'tagRemove'];
const isTagKind = (kind) => TAG_KINDS.includes(kind);
const MAX_TAG_CHARS = 40;
// 종류 태그(사진, 스크린샷, 비디오)는 앱이 자동으로 붙여요. 같은 이름을 직접 붙이면 헷갈려서 막아요
const RESERVED = ['사진', '스크린샷', '비디오'];
const PREVIEW_ROWS = 50; // 미리보기 목록에 보여 줄 최대 줄 수

// 태그 이름 다듬기: 앞뒤 공백 빼고 가운데 공백은 하나로. 틀리면 사람이 읽을 글자의 Error
function cleanTagName(raw) {
  if (typeof raw !== 'string') throw new Error('태그 이름을 적어 주세요.');
  const name = raw.replace(/\s+/g, ' ').trim();
  const length = Array.from(name).length;
  if (length < 1) throw new Error('태그 이름을 적어 주세요.');
  if (length > MAX_TAG_CHARS) throw new Error(`태그 이름은 ${MAX_TAG_CHARS}자까지 적을 수 있어요.`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('태그 이름에 쓸 수 없는 글자가 있어요.');
  if (RESERVED.includes(name)) throw new Error(`'${name}'은 앱이 자동으로 붙이는 종류 태그라 쓸 수 없어요.`);
  return name;
}

// 화면에서 온 요청 { op: 'add' | 'remove', name } → { kind, name }
function normalizeTagEdit(edit) {
  if (!edit || typeof edit !== 'object' || (edit.op !== 'add' && edit.op !== 'remove')) throw new Error('태그 작업이 올바르지 않아요.');
  return { kind: edit.op === 'add' ? 'tagAdd' : 'tagRemove', name: cleanTagName(edit.name) };
}

// 미리보기 계산: rows = 대상 파일들(getFilesByIds), getTags(경로) = 그 사진에 내가 붙인 태그 이름 목록, root = 지금 백업 폴더
//   사라진 사진과 다른 폴더 사진은 빼요(excluded). 이미 붙어 있거나(붙이기) 없는(떼기) 사진은 그대로(same)
//   → { kind, name, items: [{ id, name, path, status, before, after }], counts: { changed, same, excluded } }
function planTagEdit(rows, { kind, name }, getTags, root) {
  const items = [];
  let excluded = 0;
  for (const r of rows) {
    if (r.missing || r.root !== root) {
      excluded++;
      continue;
    }
    const before = [...getTags(r.path)].sort();
    const has = before.includes(name);
    let after = before;
    if (kind === 'tagAdd' && !has) after = [...before, name].sort();
    if (kind === 'tagRemove' && has) after = before.filter((t) => t !== name);
    items.push({ id: r.id, name: r.name, path: r.path, status: after === before ? 'same' : 'changed', before, after });
  }
  const changed = items.filter((it) => it.status === 'changed').length;
  return { kind, name, items, counts: { changed, same: items.length - changed, excluded } };
}

// 화면에 줄 미리보기 (경로 없음, 바뀌는 사진부터 최대 50줄)
function toTagPreview(plan) {
  const ordered = [...plan.items.filter((it) => it.status === 'changed'), ...plan.items.filter((it) => it.status !== 'changed')];
  return {
    kind: plan.kind,
    name: plan.name,
    counts: plan.counts,
    items: ordered.slice(0, PREVIEW_ROWS).map((it) => ({ id: it.id, name: it.name, status: it.status })),
    more: Math.max(0, ordered.length - PREVIEW_ROWS),
  };
}

// 기록 파일 줄의 태그 목록이 올바른 모양인지 (이름 글자 배열)
const validTagList = (v) => Array.isArray(v) && v.every((t) => typeof t === 'string' && t.length > 0 && t.length <= 200);

module.exports = { TAG_KINDS, isTagKind, cleanTagName, normalizeTagEdit, planTagEdit, toTagPreview, validTagList, MAX_TAG_CHARS };

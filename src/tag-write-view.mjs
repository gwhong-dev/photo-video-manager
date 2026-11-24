// 파일 위치: src/tag-write-view.mjs
// 역할: "태그를 파일에 쓰기" 띠와 쓰기 창의 글자 만들기 (31 ②). React 없이 값만 다뤄서 점검에서도 불러 확인해요
//   info = gallery:tag-write-info 결과 { total, writable, unwritable, unwritableExts, bytes, maxBytes, videoBytes, free, enough }
//   result = gallery:tag-write 결과 { total, written, same, failed: [{ name, why }], unwritable, jobUpdated, stopped }

import { formatBytes } from './format.mjs';

const n = (v) => Number(v || 0).toLocaleString('en-US');

// 띠: 쓸 수 있는 사진이 있을 때만 { title, sub, button }. 없으면 null (쓸 수 없는 형식만 남았으면 띠를 띄우지 않아요)
export function bannerText(info) {
  if (!info || !(info.writable > 0)) return null;
  return {
    title: `파일에 쓰지 않은 태그가 ${n(info.writable)}장에 있어요`,
    sub: ' 태그는 지금 이 PC 의 목록에만 있어요. 파일에 써 두면 다른 PC 와 다른 프로그램에서도 보여요',
    button: `${n(info.writable)}장 파일에 태그 쓰기`,
  };
}

// 쓰기 창 위쪽 줄들 [{ text, warn }]
export function infoLines(info) {
  if (!info) return [];
  const out = [];
  out.push({ text: `파일에 쓸 사진 ${n(info.writable)}장 (모두 ${formatBytes(info.bytes) || '0 B'})` });
  if (info.videoBytes > 0) out.push({ text: `그중 영상 ${formatBytes(info.videoBytes)}. 영상은 파일이 커서 오래 걸릴 수 있어요` });
  if (info.unwritable > 0) {
    const exts = (info.unwritableExts || []).join(', ');
    out.push({ text: `⚠️ ${exts ? `${exts} 파일` : '쓸 수 없는 형식'} ${n(info.unwritable)}장은 파일에 태그를 쓸 수 없어요. 이 PC 의 목록에만 남아요`, warn: true });
  }
  if (info.free !== null && info.free !== undefined) {
    const free = `백업 폴더 드라이브 빈 공간 ${formatBytes(info.free)}`;
    out.push(info.enough ? { text: free } : { text: `${free}. 가장 큰 파일(${formatBytes(info.maxBytes)})보다 넉넉해야 써요. 공간을 비운 뒤 다시 열어 주세요`, warn: true });
  }
  return out;
}

// 쓰기 버튼 글자
export function writeButtonText(info, running, progress) {
  if (running) return progress && progress.total ? `쓰는 중 (${n(progress.done)} / ${n(progress.total)}장)` : '쓰는 중';
  if (!info) return '쓸 사진을 찾는 중';
  if (!(info.writable > 0)) return '파일에 쓸 사진이 없어요';
  if (!info.enough) return '빈 공간이 모자라요';
  return `${n(info.writable)}장 파일에 태그 쓰기`;
}

// 끝난 뒤 알림 한 줄
export function resultText(r) {
  if (!r) return '';
  const parts = [];
  if (r.written > 0) parts.push(`${n(r.written)}장에 태그를 썼어요.`);
  if (r.same > 0) parts.push(`${n(r.same)}장은 파일에 이미 같은 태그가 있었어요.`);
  if (r.failed && r.failed.length) parts.push(`${n(r.failed.length)}장은 쓰지 못했어요. 다시 누르면 남은 사진만 이어서 써요.`);
  if (r.stopped) parts.push('앱을 꺼서 멈췄어요. 남은 사진은 다음에 이어서 써요.');
  if (r.unwritable > 0) parts.push(`${n(r.unwritable)}장은 쓸 수 없는 형식이라 이 PC 의 목록에만 남아요.`);
  if (!parts.length) parts.push('파일에 쓸 사진이 없었어요.');
  return parts.join(' ');
}

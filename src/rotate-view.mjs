// 파일 위치: src/rotate-view.mjs
// 역할: 돌리기 화면에서 쓰는 계산 · 문구 (화면 없이 점검할 수 있게 따로 둬요, 2026-11-23)

// 돌릴 수 있는 형식 (lib/media-edit.js 의 ROTATE_KIND 와 같게)
const ROTATABLE = /\.(jpe?g|png|mov|mp4|m4v)$/i;
export const canRotate = (name) => ROTATABLE.test(String(name || ''));

// 지금 각도에서 왼쪽(-90) · 오른쪽(+90)으로 한 번 더 → 0 · 90 · 180 · 270
export const nextTurn = (turn, step) => (((turn + step) % 360) + 360) % 360;

// 미리보기 칸(가로/세로 = ratio)에서 그림을 turn 만큼 돌렸을 때 칸 안에 들어가게 줄이는 비율
//   90 · 270 도면 가로세로가 바뀌어서 칸보다 커질 수 있어요 → min(ratio, 1/ratio) 로 줄여요
export const fitScale = (turn, ratio) => (turn === 90 || turn === 270 ? Math.min(ratio, 1 / ratio) : 1);

// 돌린 방향을 사람 말로
export function turnText(turn) {
  if (turn === 90) return '오른쪽으로 90도 돌린 모습이에요';
  if (turn === 180) return '거꾸로 돌린 모습이에요';
  if (turn === 270) return '왼쪽으로 90도 돌린 모습이에요';
  return '';
}

// 원본 바꾸기를 누르면 옛 원본이 어디로 가는지 (main 의 미리보기 결과 info = { trash, move, pair, warnings })
export function replaceHint(info) {
  if (!info) return '';
  const where = info.move > 0 && !info.trash ? '백업 폴더의 _정리완료원본 폴더로' : '휴지통으로';
  const pair = info.pair ? ' 라이브 포토의 짝 영상도 같이 돌려요.' : '';
  return `원본을 바꾸면 옛 원본은 ${where} 옮겨요.${pair}`;
}

// 저장한 뒤 알림 한 줄 (main 의 결과 r = { mode, done, fail, kept, pair })
export function rotateResultText(r) {
  if (!r) return '';
  const kept = r.kept && r.kept.length ? ` 돌린 파일 ${r.kept.length}개를 옮기지 못해 ${r.kept.join(', ')} 에 남겨 뒀어요.` : '';
  if (r.mode === 'copy') return r.done ? `돌린 복사본을 저장했어요.${r.pair ? ' 짝 영상도 같이 만들었어요.' : ''}` : '복사본을 만들지 못했어요.';
  if (!r.done) return `원본을 옮기지 못해 아무것도 바꾸지 않았어요.${kept}`;
  const fail = r.fail ? ` ${r.fail}개는 원본을 옮기지 못해 그대로 뒀어요.` : '';
  return `돌린 모습으로 원본을 바꿨어요.${r.pair && !r.fail ? ' 짝 영상도 같이 바꿨어요.' : ''}${fail}${kept}`;
}

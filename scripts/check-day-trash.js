// 파일 위치: scripts/check-day-trash.js
// 역할: 날짜 칸의 "이 날 N장 휴지통으로" 점검 (61). scripts/check.js 의 ITEMS 끝에 붙어요
//   2026-11-21 사용자 요청: 스크린샷처럼 그날 통째로 버릴 사진이 많을 때 "이 날 모두 선택" → 오른쪽 "휴지통으로" 두 번 가지 않게
//   링크는 확인 창(TrashDialog)을 여는 바로가기일 뿐이에요. 옮기기는 확인 창에서 눌러야만 해요
//   ⚠️ 진짜 휴지통은 쓰지 않아요. 진짜 앱 확인에서도 "그만두기"만 눌러요
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const path = require('path');
const { sub } = require('./check-gallery');

const items = [
  {
    no: 61,
    name: '날짜 칸에서 이 날 사진 휴지통으로',
    async run(env) {
      const out = [];
      const V = await import('../src/trash-view.mjs');

      // 61a 링크 글자: 결과를 말하고(장수), 끝에 → · 가운뎃점이 없음
      {
        const a = V.dayTrashLabel(4);
        const b = V.dayTrashLabel(1234);
        out.push(sub('61a 링크 글자 "이 날 4장 휴지통으로" (천 단위 쉼표, 끝에 → · 가운뎃점 없음)',
          a === '이 날 4장 휴지통으로' && b === '이 날 1,234장 휴지통으로' && !/[→·]/.test(a), `${a} / ${b}`));
      }

      // 61b 화면 연결: 휴지통이 있는 화면(갤러리 · 정보 없는 사진)에서 위치 제안이 닫혀 있을 때만 링크를 넘기고,
      //     누르면 그날 번호를 받아 선택 + 같은 확인 창(trashIds → TrashDialog). 색은 "이 날 모두 선택"과 같음
      //     받는 사이 화면 · 필터가 바뀌거나 다른 창이 열리면 안 열고, 두 번 눌러도 한 번만 (#127 검증 ⚠️로 막기까지 확인)
      {
        const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
        const app = read('src/App.jsx');
        const grid = read('src/components/DayGrid.jsx');
        const css = read('src/styles.css');
        const fn = (app.match(/const trashDay = async \(day\) => \{[\s\S]*?\n {2}\};/) || [''])[0];
        const dayTrashCss = (css.match(/\.day-trash \{[^}]*\}/) || [''])[0];
        const ok = /onTrashDay=\{trashScreen && !suggestOpen \? trashDay : undefined\}/.test(app)
          && /!viewCurrent \|\| !trashScreen \|\| suggestOpen \|\| openWindowsRef\.current \|\| dayTrashBusy\.current/.test(fn)
          && /api\.listFiles\(day, view\.filter\)/.test(fn)
          && /scopeRef\.current !== at \|\| openWindowsRef\.current \|\| ids\.length === 0/.test(fn) // 받는 사이 바뀌었으면 안 열어요
          && /dayTrashBusy\.current = false/.test(fn) && /setCellMenuAt\(null\); \/\/ 받는 사이/.test(fn)
          && /setSelection\(selectionOf\(ids\)\)/.test(fn) && /setTrashIds\(ids\)/.test(fn)
          && !/trashSelected/.test(fn) // 링크가 바로 옮기지 않아요 (확인 창만 열어요)
          && /onTrashDay && row\.dayCount > 0/.test(grid) && /dayTrashLabel\(row\.dayCount\)/.test(grid)
          && dayTrashCss !== '' && !/color/.test(dayTrashCss);
        out.push(sub('61b 갤러리 · 정보 없는 사진 화면(위치 제안 닫힘)에서만 링크, 누르면 그날 선택 + 확인 창만 열고 바로 옮기지 않음, 색은 일반 링크와 같음', ok,
          `trashDay ${fn ? '있음' : '없음'}, .day-trash ${dayTrashCss || '없음'}`));
      }

      // 61c 진짜 앱: 갤러리 화면에서 같은 날 3장의 날짜 칸에 "이 날 3장 휴지통으로" → 누르면 3장 고른 확인 창,
      //     오른쪽 패널도 3장, "그만두기"로 닫으면 파일 그대로
      {
        const { launchCheck } = require('./launch-check');
        const { makeImage } = require('./check-similar');
        const root = path.join(env.tmp, 'launch-day-trash-root');
        for (const [name, seed] of [['d1.jpg', 4], ['d2.jpg', 11], ['d3.jpg', 23]]) await makeImage(path.join(root, name), { seed });
        const names = () => fs.readdirSync(root).sort().join(',');
        const before = names();
        const ud = path.join(env.tmp, 'launch-day-trash-ud');
        fs.mkdirSync(ud, { recursive: true });
        fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ backupRoot: root }), 'utf8');
        const r = await launchCheck(path.join(__dirname, '..'), {
          env: { PVM_USER_DATA: ud },
          until: '백업 폴더 다시 읽기',
          untilMs: 30000,
          probe: `(${dayTrashProbe.toString()})()`,
        });
        const q = r.probed || {};
        const seen = JSON.stringify(q).slice(0, 600);
        out.push(sub('61c 진짜 앱: 날짜 칸에 "이 날 3장 휴지통으로", 누르면 고른 3장 확인 창(초점은 그만두기) + 칸 3개 선택 + 오른쪽 패널 "3장 휴지통으로 옮기기"',
          q.link === '이 날 3장 휴지통으로' && /고른 3장을 옮겨요/.test(q.dialogText || '') && q.focusCancel === true
            && q.selected === 3 && q.panelButton === '3장 휴지통으로 옮기기', seen));
        out.push(sub('61c 그만두기로 닫으면 파일 그대로, 화면 오류 없음',
          q.closed === true && names() === before && !(r.errors || []).some((e) => !/Failed to load resource/.test(e)),
          `${seen} / 오류 ${(r.errors || []).length}개`));
      }
      return out;
    },
  },
];

// 진짜 앱 창 안에서 도는 확인 (launch-check 의 probe). 링크와 "그만두기"만 누르고 옮기기는 누르지 않아요
async function dayTrashProbe() {
  const wait = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await new Promise((res) => setTimeout(res, 100));
    }
  };
  const q = {};
  const cells = await wait(() => document.querySelectorAll('button.cell').length >= 3, 30000);
  if (!cells) return { stop: '사진 칸이 3개가 안 돼요' };
  const link = await wait(() => document.querySelector('.day-label .day-trash'));
  if (!link) return { stop: '"이 날 N장 휴지통으로" 링크가 없어요' };
  q.link = link.innerText.trim();
  link.click();
  const dlg = await wait(() => {
    const d = document.querySelector('[aria-labelledby="trash-title"]');
    return d && /옮겨요/.test(d.innerText) ? d : null;
  });
  if (!dlg) return { ...q, stop: '링크를 눌러도 확인 창이 안 열려요' };
  q.dialogText = dlg.innerText;
  q.focusCancel = (document.activeElement && document.activeElement.innerText.trim()) === '그만두기';
  q.selected = document.querySelectorAll('button.cell.selected').length;
  const panel = document.querySelector('.panel-actions .trash-button');
  q.panelButton = panel ? panel.innerText.trim() : null;
  const foot = [...dlg.querySelectorAll('.dialog-foot button')];
  foot[0].click(); // 그만두기 (옮기지 않아요)
  q.closed = !!(await wait(() => !document.querySelector('[aria-labelledby="trash-title"]')));
  return q;
}

module.exports = { items };

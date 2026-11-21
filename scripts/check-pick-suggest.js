// 파일 위치: scripts/check-pick-suggest.js
// 역할: 고른 사진에 바로 주는 "근처 사진 위치 넣기" 점검 (62). scripts/check.js 의 ITEMS 끝에 붙어요
//   2026-11-21 사용자 요청: 위치 없는 사진을 고르면 "지도에서 고르기"만 있는 게 아니라, 같은 날 비슷한 시간에 찍은 사진 위치를 제안
//   빠르게 이 파일만 돌려 볼 때: node scripts/check-pick-suggest.js (vite build 를 먼저 해 두세요)
//   ⚠️ 실제 사진 · 실제 userData 는 쓰지 않아요. 진짜 앱 확인은 샘플 복사본 + 임시 userData 로 하고, 넣기 창은 "그만두기"로 닫아요
//
// 항목 모양은 check-gallery.js 와 같아요: { no, name, run(env) } → [{ label, status, detail }]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { sub } = require('./check-gallery');
const { pickSuggestions } = require('../lib/location-suggest');

// 계산에 넘길 파일 한 줄 (필요한 값만 덮어써서 써요)
let nextId = 1;
const file = (over = {}) => {
  const id = over.id || nextId++;
  return {
    id,
    path: `R1/${id}.jpg`,
    name: `${id}.jpg`,
    mediaType: 'photo',
    takenAt: '2026-10-25T14:00:00',
    takenDay: '2026-10-25',
    takenAtSource: 'exif',
    lat: null,
    lng: null,
    locationSource: null,
    model: null,
    ...over,
  };
};
const at = (hm) => `2026-10-25T${hm}:00`;
const PLACE = { lat: 37.5, lng: 127 };
const located = (over = {}) => file({ ...PLACE, locationSource: 'exif', model: 'iPhone', ...over });
const pickOf = (r, id) => r.picks.find((p) => p.id === id) || null;

const items = [
  {
    no: 62,
    name: '고른 사진에 근처 사진 위치 넣기',
    async run(env) {
      const out = [];
      const V = await import('../src/pick-view.mjs');

      // 62a 60분 안: 시간이 가장 가까운 위치 있는 사진 (위치 제안 탭과 같은 규칙)
      {
        const a = located({ takenAt: at('13:21') });
        const b = located({ takenAt: at('13:50'), lat: 37.505 });
        const t = file({ takenAt: at('13:25') });
        const r = pickSuggestions([a, b, t]);
        const p = pickOf(r, t.id);
        out.push(sub('62a 60분 안이면 시간이 가장 가까운 사진 (near, 4분)', !!p && p.kind === 'near' && p.sourceId === a.id && p.gapMinutes === 4, JSON.stringify(p)));
      }

      // 62b 60분 밖: 바로 앞 · 뒤 위치 사진이 서로 1km 안이면 시간이 가까운 쪽 (between). 같은 거리면 앞 사진
      {
        const a = located({ takenAt: at('10:00') });
        const b = located({ takenAt: at('16:00'), lat: 37.505 }); // 약 0.6km
        const t = file({ takenAt: at('12:00') });
        const t2 = file({ takenAt: at('13:00') });
        const r = pickSuggestions([a, b, t, t2]);
        const p = pickOf(r, t.id);
        const p2 = pickOf(r, t2.id);
        out.push(sub('62b 60분 밖, 앞뒤 사진이 1km 안 → 시간이 가까운 쪽 (between, 같은 차이면 앞 사진)',
          !!p && p.kind === 'between' && p.sourceId === a.id && p.gapMinutes === 120 && !!p2 && p2.sourceId === a.id && p2.gapMinutes === 180, JSON.stringify([p, p2])));
      }

      // 62c 제안하지 않는 경우: 앞뒤가 1km 넘게 떨어짐 · 한쪽만 있음 · 다른 날만 있음 · 시각을 믿을 수 없음 · 직접 넣은 위치만 있음
      {
        const far = [located({ takenAt: at('09:00') }), located({ takenAt: at('18:00'), lat: 37.5665, lng: 126.978 })];
        const tFar = file({ takenAt: at('13:00') });
        const oneSide = [located({ takenAt: at('09:00'), takenDay: '2026-10-26' })];
        const tOne = file({ takenAt: '2026-10-26T13:00:00', takenDay: '2026-10-26' });
        const tOtherDay = file({ takenAt: '2026-10-27T13:00:00', takenDay: '2026-10-27' });
        const tName = file({ takenAt: at('00:00'), takenAtSource: 'filename' });
        const tManual = file({ takenAt: at('09:05'), takenAtSource: 'manual' });
        const manualOnly = [located({ takenAt: '2026-10-28T09:00:00', takenDay: '2026-10-28', locationSource: 'manual' })];
        const tManLoc = file({ takenAt: '2026-10-28T09:01:00', takenDay: '2026-10-28' });
        const r = pickSuggestions([...far, tFar, ...oneSide, tOne, tOtherDay, tName, tManual, ...manualOnly, tManLoc]);
        const none = [tFar, tOne, tOtherDay, tName, tManual, tManLoc].map((t) => pickOf(r, t.id));
        out.push(sub('62c 앞뒤가 1km 넘게 떨어짐 · 한쪽만 · 다른 날만 · 이름 날짜(00:00) · 직접 넣은 시각 · 직접 넣은 위치만 → 제안 없음',
          none.every((p) => p === null), JSON.stringify(none)));
      }

      // 62d 화면으로 가는 값에 파일 경로가 없고, 근거 사진 정보(이름 · 시각 · 날짜 · 위치)가 있음. 이미 위치 있는 사진은 대상이 아님
      {
        const a = located({ takenAt: at('13:00') });
        const has = located({ takenAt: at('13:01') });
        const t = file({ takenAt: at('13:02') });
        const r = pickSuggestions([a, has, t]);
        const s = r.sources[pickOf(r, t.id).sourceId];
        out.push(sub('62d 경로 없음 · 근거 정보 있음 · 위치 있는 사진은 대상 아님',
          !JSON.stringify(r).includes('R1/') && s && s.name && s.takenDay === '2026-10-25' && typeof s.lat === 'number' && !pickOf(r, has.id) && r.picks.length === 1,
          JSON.stringify(r).slice(0, 300)));
      }

      // 62e 고른 사진 묶기: 같은 날 1km 안은 한 곳, 다른 날 · 먼 곳은 따로, 장수 많은 곳부터. 제안 없는 사진은 세지 않음
      {
        const res = {
          picks: [
            { id: 1, kind: 'near', sourceId: 100, gapMinutes: 0 },
            { id: 2, kind: 'near', sourceId: 100, gapMinutes: 0 },
            { id: 3, kind: 'near', sourceId: 101, gapMinutes: 21 }, // 0.6km → 같은 곳
            { id: 4, kind: 'between', sourceId: 102, gapMinutes: 90 }, // 다른 날
            { id: 5, kind: 'near', sourceId: 103, gapMinutes: 5 }, // 서울 → 다른 곳
          ],
          pickSources: {
            100: { id: 100, name: 'a.mp4', takenAt: at('13:21'), takenDay: '2026-10-25', ...PLACE },
            101: { id: 101, name: 'b.jpg', takenAt: at('19:02'), takenDay: '2026-10-25', lat: 37.505, lng: 127.0025 },
            102: { id: 102, name: 'c.jpg', takenAt: '2026-10-26T10:00:00', takenDay: '2026-10-26', ...PLACE },
            103: { id: 103, name: 'd.jpg', takenAt: at('20:00'), takenDay: '2026-10-25', lat: 37.5665, lng: 126.978 },
          },
        };
        const table = V.pickTable(res);
        const one = V.selectionPick(new Set([1, 2, 3, 99]), table);
        const many = V.selectionPick([5, 4, 1, 2], table);
        const none = V.selectionPick([99], table);
        const ok = one && one.count === 3 && one.places.length === 1 && one.places[0].source.id === 100 && one.places[0].ids.join() === '1,2,3'
          && one.places[0].kind === 'near' && one.places[0].gapMax === 21
          && many && many.places.length === 3 && many.places[0].ids.join() === '1,2' && none === null && V.selectionPick([1], null) === null;
        out.push(sub('62e 같은 날 1km 안은 한 곳(근거 = 먼저 찍은 사진), 다른 날 · 먼 곳은 따로, 장수 많은 곳부터', !!ok, JSON.stringify([one, many && many.places.map((g) => g.ids)])));

        // 62f 버튼 · 안내 글자: 결과를 말하고(장수), 끝에 → · 가운뎃점 없음. 여러 곳이면 한 곳씩 넣는다고 알림
        const label = V.pickButtonLabel(one);
        const note = V.pickNote(one);
        const noteMany = V.pickNote(many);
        const noteBetween = V.pickNote(V.selectionPick([4], table));
        out.push(sub('62f 버튼 "3장에 근처 사진 위치 넣기", 안내 "같은 날 21분 안에 찍은 사진 위치예요", 여러 곳 · 앞뒤 사진 안내 (→ · 가운뎃점 없음)',
          label === '3장에 근처 사진 위치 넣기' && note === '같은 날 21분 안에 찍은 사진 위치예요'
            && /3곳이라 한 곳씩 넣어요$/.test(noteMany) && noteBetween === '앞뒤로 찍은 사진이 같은 곳이에요'
            && ![label, note, noteMany, noteBetween].some((t) => /[→·]/.test(t)),
          `${label} / ${note} / ${noteMany} / ${noteBetween}`));
      }

      // 62g 연결: main 은 제안 표를 위치 제안 응답에 같이 주고, 넣기는 위치 제안과 같은 검사(via 'suggest', 위치만)를 거침.
      //     패널 · 우클릭 메뉴 맨 위에 버튼, 지도 창은 제안 위치에서 열림, 남은 곳이 있으면 선택을 남김
      {
        const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
        const main = read('gallery-main.js');
        const app = read('src/App.jsx');
        const dlg = read('src/components/EditDialog.jsx');
        const panel = read('src/components/DetailPanel.jsx');
        const menu = read('src/components/ContextMenu.jsx');
        const ok = /const p = pickSuggestions\(rows\);/.test(main) && /picks: p\.picks,/.test(main) && /pickSources: p\.sources,/.test(main)
          && /edit = \{ source: 'copy', sourceId: source\.id, date: false, time: false, location: true, via: 'suggest' \}/.test(dlg)
          && /const pickScreen = \(screen === 'gallery' \|\| screen === 'missing'\) && !suggestOpen && !screening/.test(app)
          && /mode === 'map' && pick \? \{ lat: pick\.places\[0\]\.source\.lat, lng: pick\.places\[0\]\.source\.lng \}/.test(app)
          && /onApplied\(r, \{ keep: dialog\.mode === 'suggest' && dialog\.more \}\)/.test(app)
          && /if \(!keep\) setSelection\(EMPTY_SELECTION\)/.test(app)
          && /\{pick && onSuggest && \(\s*<div className="pick-suggest">/.test(panel)
          && /<>\s*\{pick && onSuggest && <button type="button" role="menuitem" onClick=\{onSuggest\}>/.test(menu);
        out.push(sub('62g main 은 제안 표만 더 주고 넣기는 위치 제안 검사 그대로, 패널 · 메뉴 맨 위 버튼, 지도는 제안 위치에서, 남은 곳 있으면 선택 유지', ok));
      }

      // 62h 진짜 앱: IMG_0104.jpg 에만 위치를 적은 샘플 복사본에서, 같은 시각의 IMG_0104(1).jpg 를 고르면
      //     오른쪽 패널과 우클릭 메뉴에 "1장에 근처 사진 위치 넣기" → 누르면 근거 사진 IMG_0104.jpg 와 바뀜 1장 미리보기 → 그만두기
      {
        const { launchCheck } = require('./launch-check');
        const { detectTools, runOrThrow } = require('../lib/tools');
        const APP = path.join(__dirname, '..');
        const root = path.join(env.tmp, 'launch-pick-root');
        fs.cpSync(path.join(APP, 'test', 'samples', 'auto'), root, { recursive: true });
        const tools = await detectTools({}, APP);
        await runOrThrow(tools.exiftool.path, ['-overwrite_original', '-GPSLatitude=37.5', '-GPSLatitudeRef=N', '-GPSLongitude=127', '-GPSLongitudeRef=E', path.join(root, 'IMG_0104.jpg')], 'exiftool');
        const ud = path.join(env.tmp, 'launch-pick-ud');
        fs.mkdirSync(ud, { recursive: true });
        fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ backupRoot: root }), 'utf8');
        const r = await launchCheck(APP, {
          env: { PVM_USER_DATA: ud },
          until: '백업 폴더 다시 읽기',
          untilMs: 30000,
          probe: `(${pickProbe.toString()})()`,
        });
        const q = r.probed || {};
        const seen = JSON.stringify(q).slice(0, 700);
        out.push(sub('62h 진짜 앱: 위치 없는 사진을 고르면 패널 · 우클릭 메뉴 맨 위에 "1장에 근처 사진 위치 넣기"',
          q.panelButton === '1장에 근처 사진 위치 넣기' && /같은 날 1분 안에 찍은 사진 위치예요/.test(q.panelNote || '') && q.menuFirst === '1장에 근처 사진 위치 넣기', seen));
        out.push(sub('62h 누르면 "근처 사진 위치 넣기" 창: 근거 사진 IMG_0104.jpg, 바뀜 1장, 지도 보임, 검색 칸 없음',
          q.title === '근처 사진 위치 넣기' && /근거 사진 IMG_0104\.jpg/.test(q.dialogText || '') && /바뀜 1장/.test(q.dialogText || '')
            && q.map === true && q.search === false && /1장에 위치 넣기|1장 넣기|넣기/.test(q.applyText || ''), seen));
        out.push(sub('62h 그만두기로 닫음, 화면 오류 없음', q.closed === true && !(r.errors || []).some((e) => !/Failed to load resource/.test(e)),
          `${seen} / 오류 ${(r.errors || []).join(' | ').slice(0, 300)}`));
      }
      return out;
    },
  },
];

// 진짜 앱 창 안에서 도는 확인 (launch-check 의 probe). 넣기는 누르지 않고 "그만두기"로 닫아요
async function pickProbe() {
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
  const cell = await wait(() => document.querySelector('button.cell[aria-label="IMG_0104(1).jpg"]'), 30000);
  if (!cell) return { stop: 'IMG_0104(1).jpg 칸이 없어요', cells: [...document.querySelectorAll('button.cell')].map((c) => c.getAttribute('aria-label')) };
  cell.click();
  const btn = await wait(() => {
    const b = document.querySelector('.pick-suggest button');
    return b && /근처 사진 위치 넣기/.test(b.innerText) ? b : null;
  });
  if (!btn) return { ...q, stop: '패널에 근처 사진 위치 넣기 버튼이 없어요', panel: (document.querySelector('.panel-actions') || {}).innerText };
  q.panelButton = btn.innerText.trim();
  q.panelNote = (document.querySelector('.pick-suggest .detail-sub') || {}).innerText;
  // 우클릭 메뉴 첫 항목
  const rect = cell.getBoundingClientRect();
  cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 5, clientY: rect.top + 5, button: 2 }));
  const menu = await wait(() => document.querySelector('.context-menu'));
  q.menuFirst = menu ? (menu.querySelector('button') || {}).innerText : null;
  if (menu) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(() => !document.querySelector('.context-menu'), 3000);
  btn.click();
  const dlg = await wait(() => {
    const d = document.querySelector('[aria-labelledby="edit-title"]');
    return d && /바뀜/.test(d.innerText) ? d : null;
  });
  if (!dlg) return { ...q, stop: '넣기 창이 안 열리거나 미리보기가 없어요', text: (document.querySelector('[aria-labelledby="edit-title"]') || {}).innerText };
  q.title = dlg.querySelector('#edit-title').innerText.trim();
  q.dialogText = dlg.innerText;
  q.map = !!dlg.querySelector('.map-canvas');
  q.search = !!dlg.querySelector('.map-search');
  const foot = [...dlg.querySelectorAll('.dialog-foot button')];
  q.applyText = foot[1] ? foot[1].innerText.trim() : null;
  foot[0].click(); // 그만두기
  q.closed = !!(await wait(() => !document.querySelector('[aria-labelledby="edit-title"]')));
  return q;
}

module.exports = { items };

// 이 파일만 바로 돌릴 때: 임시 폴더를 만들고, 다 통과하면 지워요
if (require.main === module) {
  (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvm-check-pick-'));
    let failed = 0;
    for (const item of items) {
      let subs;
      try {
        subs = await item.run({ tmp });
      } catch (e) {
        subs = [sub('실행 중 오류', false, e.stack)];
      }
      const bad = subs.filter((s) => s.status === 'fail');
      if (bad.length) failed++;
      console.log(`${bad.length ? '❌' : '✅'} ${item.no}. ${item.name}`);
      for (const s of subs) console.log(`   ${s.status === 'ok' ? '✅' : '❌'} ${s.label}${s.status === 'ok' ? '' : ` — ${s.detail || ''}`}`);
    }
    if (!failed) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log(`임시 폴더: ${tmp}`);
    process.exitCode = failed ? 1 : 0;
  })();
}

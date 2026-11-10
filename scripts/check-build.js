// 파일 위치: scripts/check-build.js
// 역할: exe 만들기 설정 점검 (47번). exe 를 실제로 만들지는 않고 package.json 의 build 설정만 봐요 (몇십 ms)
//   exe 안에는 build.files 에 적은 파일만 들어가요. 새 lib 파일을 만들고 목록에 빠뜨리면
//   개발 중(npm start)에는 잘 되다가 exe 에서만 "Cannot find module" 로 안 켜져요. 그걸 미리 잡아요

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const APP = path.join(__dirname, '..');
const sub = (label, pass, detail = '') => ({ label, status: pass ? 'ok' : 'fail', detail });
const slash = (p) => p.split(path.sep).join('/');

// build.files 의 글자 하나가 파일 하나를 덮는지 ("lib/**/*" 같은 폴더 통째, 또는 파일 이름 그대로)
function covered(rel, patterns) {
  return patterns.some((p) => (p.endsWith('/**/*') ? rel.startsWith(p.slice(0, -4)) : rel === p));
}

// main.js 에서 시작해 require('./...') 로 불러오는 내 파일과, 바깥 패키지 이름을 모두 모아요
function requireGraph(entries) {
  const files = new Set();
  const packages = new Set();
  const todo = entries.map((e) => path.join(APP, e));
  while (todo.length) {
    const file = todo.pop();
    if (files.has(file)) continue;
    files.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\(\s*'([^']+)'\s*\)/g)) {
      const name = m[1];
      if (name.startsWith('.')) {
        let target = path.resolve(path.dirname(file), name);
        if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) target += '.js';
        todo.push(target);
      } else if (!name.startsWith('node:') && !builtinModules.includes(name) && name !== 'electron') {
        packages.add(name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]);
      }
    }
  }
  return { files: [...files].map((f) => slash(path.relative(APP, f))), packages: [...packages] };
}

const items = [
  {
    no: 47,
    name: 'exe 만들기 설정 (package.json build)',
    run: async () => {
      const out = [];
      const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
      const build = pkg.build || {};
      const patterns = build.files || [];

      // 47a 켤 때 필요한 내 파일이 모두 exe 에 들어가요 (main.js 가 불러오는 파일 + 창이 여는 화면 파일)
      const graph = requireGraph(['main.js', 'preload.js']);
      const needed = [...graph.files, 'package.json', 'index.html', 'dist/renderer/index.html'];
      const missing = needed.filter((rel) => !covered(rel, patterns));
      out.push(sub('47a 앱이 쓰는 파일이 모두 build.files 에 있음', missing.length === 0 && graph.files.length > 10, missing.length ? `빠진 파일: ${missing.join(', ')}` : `${needed.length}개`));

      // 47b 앱이 불러오는 바깥 패키지는 dependencies 에 있어요 (devDependencies 는 exe 에 안 들어가요)
      const deps = Object.keys(pkg.dependencies || {});
      const notDep = graph.packages.filter((p) => !deps.includes(p));
      out.push(sub('47b 앱이 불러오는 패키지가 모두 dependencies 에 있음', notDep.length === 0, notDep.length ? `dependencies 에 없음: ${notDep.join(', ')}` : graph.packages.join(', ')));

      // 47c sharp(썸네일)는 .node 실행 파일이 있어서 app.asar 밖으로 꺼내 둬야 불러올 수 있어요
      const unpack = build.asarUnpack || [];
      const unpacked = ['node_modules/sharp/', 'node_modules/@img/'].every((d) => unpack.some((u) => u.startsWith(d)));
      out.push(sub('47c sharp 와 @img 를 asar 밖에 둠 (asarUnpack)', unpacked, unpack.join(', ')));

      // 47d 결과 폴더는 vite 의 dist(화면 파일)와 겹치지 않고, 저장소에 올라가지 않아요
      const outDir = (build.directories || {}).output || 'dist';
      const ignored = fs.readFileSync(path.join(APP, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
      out.push(sub('47d 결과 폴더가 dist 가 아니고 .gitignore 에 있음', outDir !== 'dist' && ignored.includes(`${outDir}/`), `output: ${outDir}`));

      // 47e 더블클릭 스크립트와 npm run dist 가 있어요. .bat 은 CRLF 로 받도록 .gitattributes 에 적혀 있어요
      const attrs = fs.existsSync(path.join(APP, '.gitattributes')) ? fs.readFileSync(path.join(APP, '.gitattributes'), 'utf8') : '';
      const ok = !!(pkg.scripts || {}).dist && fs.existsSync(path.join(APP, 'scripts', 'build-exe.bat')) && /\*\.bat\s+text\s+eol=crlf/.test(attrs);
      out.push(sub('47e npm run dist, scripts/build-exe.bat, .bat 줄바꿈 CRLF', ok, (pkg.scripts || {}).dist || '(dist 없음)'));
      return out;
    },
  },
];

module.exports = { items, requireGraph, covered };

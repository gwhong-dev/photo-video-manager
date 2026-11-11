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

      // 47f exe 의 도구 찾기: 설정 폴더 tools → exe 옆 tools → PATH 순서 (exe 를 다시 만들면 exe 옆 폴더는 지워져서, #73 검증 ⚠️)
      //   main.js 가 exe 일 때 [설정 폴더, exe 폴더]를 넘기는지도 봐요
      const { candidates } = require('../lib/tools');
      const ud = path.join('U', 'photo-video-manager');
      const ex = path.join('X', 'win-unpacked');
      const list = candidates('exiftool', '', [ud, ex]);
      const want = [path.join(ud, 'tools', 'exiftool', 'exiftool.exe'), path.join(ud, 'tools', 'exiftool', 'exiftool'), path.join(ex, 'tools', 'exiftool', 'exiftool.exe'), path.join(ex, 'tools', 'exiftool', 'exiftool'), 'exiftool'];
      const one = candidates('magick', 'S\\magick.exe', 'P');
      const mainText = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
      const passes = /app\.isPackaged\s*\?\s*\[userDir\(\),\s*path\.dirname\(process\.execPath\)\]/.test(mainText);
      out.push(sub('47f 도구는 설정 폴더 tools, exe 옆 tools, PATH 순서로 찾음 (폴더 하나만 줘도 예전처럼)',
        JSON.stringify(list) === JSON.stringify(want) && JSON.stringify(one) === JSON.stringify(['S\\magick.exe', path.join('P', 'tools', 'imagemagick', 'magick.exe'), 'magick']) && passes,
        `${JSON.stringify(list)} / main.js 설정 폴더 넘김 ${passes}`));

      // 47g exe 퓨즈 runAsNode 꺼짐 (2026-11-11 결정). 퓨즈 = exe 안에 박아 두는 켜고 끄는 스위치
      //   꺼 두면 ELECTRON_RUN_AS_NODE=1 로 exe 를 그냥 Node 처럼 실행해 아무 코드나 돌리는 길이 막혀요
      //   대신 앱 코드가 process.fork 나 ELECTRON_RUN_AS_NODE 를 쓰면 exe 에서 고장 나서, 그것도 같이 봐요
      //   (점검 스크립트의 process.execPath 는 node.exe 로 돌아서 상관없어요)
      const fuses = build.electronFuses || {};
      const usesRunAsNode = graph.files.filter((rel) => /ELECTRON_RUN_AS_NODE|\bfork\s*\(|execPath\s*,/.test(fs.readFileSync(path.join(APP, rel), 'utf8')));
      out.push(sub('47g exe 퓨즈 runAsNode 꺼짐, 앱 코드는 fork · ELECTRON_RUN_AS_NODE 를 안 씀',
        fuses.runAsNode === false && usesRunAsNode.length === 0,
        `runAsNode: ${fuses.runAsNode}${usesRunAsNode.length ? ` / 쓰는 파일: ${usesRunAsNode.join(', ')}` : ''}`));
      return out;
    },
  },
];

module.exports = { items, requireGraph, covered };

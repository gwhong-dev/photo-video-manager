// 파일 위치: vite.config.mjs
// 역할: 갤러리 화면(src/)을 dist/renderer 로 만드는 설정 (npm start, npm run check 앞에서 자동으로 돌아요)
//   Vite = React 화면을 브라우저가 읽을 수 있는 파일로 묶어 주는 도구
//   base './' = 파일을 상대 경로로 불러와요 (Electron이 file:// 로 열기 때문)

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('./src'),
  base: './',
  plugins: [react()],
  build: {
    outDir: here('./dist/renderer'),
    emptyOutDir: true,
    // 작은 글꼴·이미지를 data: 주소로 끼워 넣지 않아요 (화면 보안 규칙 font-src 'self' 에 막혀요)
    assetsInlineLimit: 0,
  },
});

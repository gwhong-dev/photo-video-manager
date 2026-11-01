// 파일 위치: src/main.jsx
// 역할: 갤러리 화면을 시작하는 곳 (글꼴과 스타일을 불러오고 App을 그려요)

import React from 'react';
import { createRoot } from 'react-dom/client';
// 글꼴: IBM Plex Sans KR (인터넷 없이 쓰도록 패키지에 들어 있는 파일을 써요)
import '@fontsource/ibm-plex-sans-kr/korean-400.css';
import '@fontsource/ibm-plex-sans-kr/korean-600.css';
import '@fontsource/ibm-plex-sans-kr/latin-400.css';
import '@fontsource/ibm-plex-sans-kr/latin-600.css';
import './styles.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);

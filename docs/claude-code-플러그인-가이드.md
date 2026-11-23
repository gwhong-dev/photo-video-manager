# Claude Code 플러그인 설치·사용 가이드

> 정리일: 2026-10-29 / 대상: photo-video-manager (Electron + React, Windows, Git Bash)
> 출처: Anthropic 공식 마켓플레이스 `claude-plugins-official` (github.com/anthropics/claude-plugins-official, 2026-10-29 기준 목록 확인)
> **2026-11-23 바뀜**: 토큰 정리로 이 프로젝트에서는 `superpowers` · `context7` 를 끔 (`.claude/settings.json`, 근거 `docs/decisions/2026-11-23-token-diet.md`). 절차는 `CLAUDE.md` 하나만 따름. 아래 표는 처음 고를 때의 기록

---

## 0. 용어 한 줄 정리

| 용어 | 뜻 |
|---|---|
| **스킬(Skill)** | Claude가 특정 작업을 할 때 꺼내 보는 **작업 지침서** |
| **플러그인(Plugin)** | 스킬 + 명령어(`/commit` 같은) + 도구를 묶은 **설치 패키지** |
| **마켓플레이스** | 플러그인 목록 저장소. 공식 `claude-plugins-official`은 **처음부터 등록돼 있음** |

---

## 1. 설치 목록

### 🟢 필수 5개 (지금 설치)

| 플러그인 | 하는 일 | 이 프로젝트에서 쓰는 곳 |
|---|---|---|
| `superpowers` | 브레인스토밍 → 계획 → 구현 → 디버깅 순서로 작업 | 새 기능 시작할 때 (갤러리, 날짜 편집 등) |
| `commit-commands` | `/commit`, `/commit-push-pr` 명령어 | git 커밋·푸시·PR을 한 번에 |
| `context7` | 라이브러리 **최신 공식 문서**를 찾아서 참고 | Electron, React, SQLite, Leaflet 코드가 옛날 방식으로 작성되는 것을 방지 |
| `typescript-lsp` | JS/TS **문법 오류를 코드 수정 직후 바로 확인** | 모든 코드 작업 |
| `claude-md-management` | `/revise-claude-md`로 CLAUDE.md 정리 | 세션이 끝날 때 배운 내용 기록 |

### 🟡 필요할 때 추가

| 플러그인 | 하는 일 | 언제 |
|---|---|---|
| `playwright` | 화면 자동 테스트, 스크린샷 | 갤러리 같은 화면이 생기고 테스트가 필요할 때 (Electron 앱 테스트 지원) |
| `code-review` | `/code-review` 여러 관점으로 PR 검토 | main에 merge하기 전 |
| `learning-output-style` | 중요한 부분은 **직접 작성하도록 유도**하고 설명을 추가 | 공부 목적으로 작업할 때 (⚠️ 토큰 사용량 증가) |
| `feature-dev` | `/feature-dev` 7단계 기능 개발 흐름 | superpowers와 역할이 겹침 → **둘 중 하나만** 사용 |
| `security-guidance` | 위험한 코드 패턴 경고 + 변경 내용 보안 검토 | 배포 전 (⚠️ 매 턴마다 검토해서 토큰 사용량 증가) |

---

## 2. 설치 방법

### 방법 A. 직접 명령어 입력 (내 PC 전체에 적용)

**① TypeScript 언어 서버 먼저 설치** (Git Bash)
```bash
npm install -g typescript-language-server typescript
```

**② Claude Code 안에서 입력** (한 줄씩)
```
/plugin install superpowers@claude-plugins-official
/plugin install commit-commands@claude-plugins-official
/plugin install context7@claude-plugins-official
/plugin install typescript-lsp@claude-plugins-official
/plugin install claude-md-management@claude-plugins-official
/reload-plugins
```

**③ 확인**
```
/plugin
```
→ Installed 탭에 5개가 보이면 완료

### 방법 B. 저장소에 설정 파일 넣기 (프로젝트 단위, 반복 사용에 추천)

`photo-video-manager\.claude\settings.json`
```json
{
  "enabledPlugins": {
    "superpowers@claude-plugins-official": false,
    "commit-commands@claude-plugins-official": true,
    "context7@claude-plugins-official": false,
    "typescript-lsp@claude-plugins-official": true,
    "claude-md-management@claude-plugins-official": true
  }
}
```
- 이 파일을 commit해 두면 **다른 PC(노트북, 맥미니)에서 저장소를 열 때도 같은 플러그인을 쓰도록** 안내됨
- 새 프로젝트를 시작할 때는 이 파일만 복사하면 됨
- TypeScript 언어 서버(①)는 PC마다 한 번씩 설치해야 함

| 설정 위치 | 적용 범위 |
|---|---|
| `~/.claude/settings.json` | 내 PC의 모든 프로젝트 |
| `.claude/settings.json` | 이 저장소 (commit해서 공유) |
| `.claude/settings.local.json` | 이 저장소, 나만 (git에 안 올라감) |

---

## 3. 사용법 (작업 흐름에 연결)

```
① 새 기능 시작
   "docs/개발개요-v3.md 읽고 갤러리 기능 브레인스토밍하자"
   → superpowers가 질문 → 설계 → 계획 순서로 진행

② 구현 중
   라이브러리 사용법이 헷갈리면: "context7로 Electron 최신 문서 확인하고 작성해줘"
   오류는 typescript-lsp가 자동으로 잡아줌

③ 저장
   /commit            → 변경 내용을 보고 커밋 메시지 작성 + 커밋
   /commit-push-pr    → 커밋 + 푸시 + PR 생성

④ 세션 끝
   /revise-claude-md  → 이번 세션에서 배운 규칙을 CLAUDE.md에 반영
   "오늘 한 것과 남은 것 docs에 정리해줘"
```

---

## 4. 관리 명령어

| 명령어 | 기능 |
|---|---|
| `/plugin` | 플러그인 목록·검색 화면 (Discover / Installed 탭) |
| `/plugin install 이름@마켓` | 설치 |
| `/plugin uninstall 이름@마켓` | 삭제 |
| `/plugin marketplace update claude-plugins-official` | 목록 최신화 |
| `/reload-plugins` | 설치 후 바로 적용 |

---

## 5. 원칙

- **많이 설치하지 않는다.** 플러그인마다 Claude가 읽는 내용이 늘어나서 토큰이 더 들고 판단이 흐려질 수 있음
- 새 플러그인은 **공식 마켓플레이스 우선**, 커뮤니티 플러그인은 내용을 확인하고 설치
- 3개월에 한 번 `/plugin`을 열어서 **안 쓰는 플러그인은 삭제**

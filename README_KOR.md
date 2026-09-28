# claude-web-terminal (한국어 소개)

> Claude Code 의 [Agent View](https://docs.claude.com/en/docs/claude-code/overview)를 **브라우저 카드 UI** 로 띄우는 웹 터미널. 터미널에서 하던 `claude agents`(백그라운드 세션 목록·생성·접속·종료)를, CLI TUI 보다 풍부한 메타데이터와 함께 본다.

[English README](README.md)

## 어떤 문제를 푸나

Claude Code 의 백그라운드 에이전트 세션을 터미널 TUI 로 관리하면, 마지막 응답·토큰 합계·브랜치·메시지 수 같은 정보를 한눈에 보기 어렵습니다. 이걸 브라우저 카드로 렌더링해 가독성과 조작성을 끌어올렸습니다.

## 핵심 기능

- 세션 **목록·생성·접속·종료**를 카드 UI 로
- CLI TUI 가 안 보여주는 **풍부한 메타데이터**(마지막 어시스턴트 응답, 토큰 총량, 브랜치, 메시지 수)
- **로컬 세션 브라우저(📂)** — 이 PC 에 남아 있는 과거 세션을 골라 `claude --resume` 으로 이어 열기
- **폰에서 세션 띄우고 PC 에서 이어받기** (아래)
- `?demo=1` 플래그로 합성 데이터 데모 가능

## 폰에서 시작해 PC 에서 이어받기

자리를 비운 사이에 떠오른 작업을, 책상에 돌아왔을 때 그대로 이어받는 흐름입니다.

1. 폰에서 **내 텔레그램 봇**에 키워드(예: `blog`)를 보냅니다.
2. PC 에서 돌고 있는 `scripts/telegram-launcher.mjs` 가 그 키워드에 매핑된 디렉토리에서 `claude remote-control` 을 띄웁니다.
3. 폰으로 그 세션과 대화합니다. 세션은 내 PC 에서 도니까, 대화 기록도 `~/.claude/projects/` 에 그대로 남습니다.
4. 책상 앞에서 웹 터미널을 열고 📂 를 눌러 그 세션을 고르면, 대화가 터미널 탭에 복원됩니다.

런처는 **선택 도구**입니다. 서버는 런처를 전혀 참조하지 않고, 의존성도 추가하지 않습니다(Node ≥ 22 내장 모듈만). 설정 예시·명령어 표·설계 근거는 [English README → Resume sessions from your phone](README.md#resume-sessions-from-your-phone) 에 있습니다.

런처 설정(`~/.cwt-launcher/config.json`)은 봇 토큰을 평문으로 담으므로 **퍼미션 600 이 아니면 실행을 거부**합니다. 또 명령 처리는 **at-most-once** — 업데이트 커서를 먼저 디스크에 쓰고 나서 명령을 실행하므로, 죽는 타이밍이 나쁘면 명령이 유실될 수는 있어도 같은 메시지로 세션이 두 번 뜨는 일은 없습니다.

## 검증된 동작 (버전 고정)

폰→PC 이어받기는 Claude Code 의 **문서화되지 않은 관찰된 동작**에 기대고 있습니다. **Claude Code v2.1.227 (2026-08-27)** 에서 확인:

- (a) 대화 기록이 `~/.claude/projects/<dir>/<uuid>.jsonl` 에 남고, 각 레코드에 `cwd` 와 `sessionId` 필드가 있음
- (b) 헤드리스 `claude remote-control` 자식 세션도 로컬 대화 기록을 남김
- (c) `claude --resume <id>` 로 그 대화가 복원됨

**이 버전을 넘어선 호환성은 보장하지 않습니다.** 새 버전에서 재확인하는 절차는 [English README → Verified behavior](README.md#verified-behavior-version-pinned) 와 [docs/manual-smoke.md](docs/manual-smoke.md) 참조.

## 보안 모델 (2중, 둘 다 필수)

실제 셸 + `claude` REPL 을 띄워 HTTP/WebSocket 으로 노출하므로 접근 제어를 2겹으로 둡니다:

- **Loopback 바인드** — `127.0.0.1` 전용, 네트워크에서 도달 불가
- **시작 시마다 랜덤 인증 토큰** — httpOnly·SameSite=Strict 쿠키, 모든 API·WebSocket 업그레이드에서 `Origin` 헤더 검증

## 기술 스택

Node.js 18+ · Express · WebSocket · PTY · MIT

## 이 프로젝트의 핵심 포인트

"로컬에 셸을 열어 웹으로 노출"이라는 위험한 기능을, **loopback + 시작 시 토큰 + Origin 검증**이라는 3중 방어로 안전하게 만든 보안 설계가 핵심입니다.

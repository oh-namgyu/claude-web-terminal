# claude-web-terminal (한국어 소개)

> Claude Code 의 [Agent View](https://docs.claude.com/en/docs/claude-code/overview)를 **브라우저 카드 UI** 로 띄우는 웹 터미널. 터미널에서 하던 `claude agents`(백그라운드 세션 목록·생성·접속·종료)를, CLI TUI 보다 풍부한 메타데이터와 함께 본다.

[English README](README.md)

## 어떤 문제를 푸나

Claude Code 의 백그라운드 에이전트 세션을 터미널 TUI 로 관리하면, 마지막 응답·토큰 합계·브랜치·메시지 수 같은 정보를 한눈에 보기 어렵습니다. 이걸 브라우저 카드로 렌더링해 가독성과 조작성을 끌어올렸습니다.

## 핵심 기능

- 세션 **목록·생성·접속·종료**를 카드 UI 로
- CLI TUI 가 안 보여주는 **풍부한 메타데이터**(마지막 어시스턴트 응답, 토큰 총량, 브랜치, 메시지 수)
- `?demo=1` 플래그로 합성 데이터 데모 가능

## 보안 모델 (2중, 둘 다 필수)

실제 셸 + `claude` REPL 을 띄워 HTTP/WebSocket 으로 노출하므로 접근 제어를 2겹으로 둡니다:

- **Loopback 바인드** — `127.0.0.1` 전용, 네트워크에서 도달 불가
- **시작 시마다 랜덤 인증 토큰** — httpOnly·SameSite=Strict 쿠키, 모든 API·WebSocket 업그레이드에서 `Origin` 헤더 검증

## 기술 스택

Node.js 18+ · Express · WebSocket · PTY · MIT

## 이 프로젝트의 핵심 포인트

"로컬에 셸을 열어 웹으로 노출"이라는 위험한 기능을, **loopback + 시작 시 토큰 + Origin 검증**이라는 3중 방어로 안전하게 만든 보안 설계가 핵심입니다.

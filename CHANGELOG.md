# Changelog

All notable changes to claude-web-terminal.

## v0.6.0 — 2026-05-13

### Added
- **Server-Sent Events channel** (`/api/cc-events`) — the server now pushes session events to the client. Survives background-tab `setInterval` throttling, so idle notifications fire even when the page isn't in front.
- **In-app keyboard shortcuts help modal** — ⌨️ button in the sidebar opens a card with OS-aware modifier labels (`⌘` on macOS, `Ctrl` elsewhere).
- **User-toggleable mute** — bell button is now an actual on/off switch. `localStorage.cwt.notify` persists the preference independently of the browser permission.
- **`Cache-Control: no-cache, must-revalidate`** on static assets so a `npm start` after a pull reaches the browser without a forced reload.

### Fixed
- **Notification trigger condition** — previously watched for a non-existent `working → !working` transition. Claude Code v2.1.x writes `busy / waiting / idle`; the server now fires on any `busy → !busy` and tags the event with `reason` (`'needs input'` vs `'finished'`).
- **Session card status icons** — now show `⚙️` (busy) / `⏳` (waiting) / `⏸` (idle) instead of treating the real values as "unknown".
- **Bell off-state visibility** — `🔕` vs `🔔` was indistinguishable on some emoji fonts. Replaced with a CSS-drawn red diagonal strike + dimmed opacity, font-agnostic.
- **CHANGELOG v0.1.0 cwd note** — original wording claimed `?cwd=` was removed; actually it's restricted to the resume flow with server-side validation. Corrected.

### Changed
- **Notification & help buttons moved from panel header to sidebar** — reachable without opening the Agent panel.
- **Panel polling decoupled from notifications** — polling is now strictly UI-refresh; notifications come from SSE.

## v0.5.0 — 2026-05-13

### Added
- **WebSocket auto-reconnect** with exponential backoff (1s → 2s → 4s → 8s, max 5 attempts). Status line in the terminal shows reconnect progress.
- **Keyboard shortcuts** (Cmd/Ctrl modifier):
  - `T` — new tab
  - `W` — close active tab
  - `K` — open Agent panel and focus search
  - `1-9` — switch to nth tab
  - Suppressed during IME composition.
- **Browser notifications** on background-session `working → idle` transition. Toggle in the Agent panel header (🔕 / 🔔). Clicking a notification opens the session in a new tab.

## v0.4.0 — 2026-05-13

### Added
- **Time filter chips** (All / 2d / 5d / 7d / 2w / 1m) in the Agent panel. Combines with the text search filter.
- **`bin/cc-resume` CLI helper** — resumes a Claude Code session from any shell by resolving the original cwd.
- 3-tier cwd resolution: session metadata → `"cwd"` in transcript → slug backtracking. Handles hyphenated usernames (e.g. `alice-doe`) and ai-title-only metafiles.

## v0.3.0 — 2026-05-13

### Added (Phase 1-6 features)
- Model toggle (Opus / Sonnet / Haiku) for the active tab.
- Resume picker that lists past sessions from `~/.claude/projects/`.
- Session name editing via a modal dialog.
- Real-time search filter (name / cwd / id).
- Session deletion with confirmation (background sessions).
- Pin/favorite sessions with visual highlight and top-of-list sort.

### Changed
- Refactor: extracted DOM helpers (`_createEditButton`, `_createPinButton`, `_createNameRow`, `_sortByPinned`).
- All inline styles moved to CSS classes (`.agent-card-edit-btn`, `.agent-card-name-row`, `.agent-card.hidden`).

## v0.1.0 — 2026-05-13

### Initial public release
- Web terminal with multiple `claude` REPL tabs (xterm.js + node-pty).
- Agent View panel: list / create / attach / stop background and interactive sessions.
- IME-friendly input bar — fixes Safari + xterm.js composition for Korean / Chinese / Japanese.
- Demo mode (`?demo=1`) with synthetic placeholder data for screenshots.

### Security
- WebSocket authentication gate (CSWSH protection) — random 192-bit token bootstraps an httpOnly `SameSite=Strict` cookie.
- Origin allowlist on REST + WS upgrade (CSRF protection).
- `?cwd=` query restricted to the resume flow and validated server-side (must be under `/Users/` or `/home/` and exist on disk); ignored for `attach` and rejected otherwise.
- Inline `onclick` handlers removed in favor of `addEventListener` + `textContent` (XSS surface reduced).
- node-pty 1.1.0 macOS spawn-helper permission fix bundled (`scripts/fix-pty-perms.js`).

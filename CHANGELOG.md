# Changelog

All notable changes to claude-web-terminal.

## Unreleased — 2026-05-23

### Observability
- **Structured logging** (`lib/log.js`) with `LOG_LEVEL` (debug/info/warn/error) and `LOG_FORMAT` (text/json). All interesting events — boot, auth.*, origin.*, rate.*, session.*, ws.* — go through the logger so you can pipe stdout into Loki / jq when deploying inside a container.
- **`GET /api/metrics`** returns an auth-gated JSON snapshot: `uptime_seconds`, `boot_time_iso`, `counters` (requests_total, auth_failures_total, origin_blocked_total, rate_limited_total, sessions_created_total, sessions_stopped_total, ws_connections_total, ws_active), `sessions_active` (bg + interactive).

### Security
- **CSRF hardening on state-changing requests.** `POST`/`PUT`/`PATCH`/`DELETE` to any `/api/*` path now require an `Origin` header. Browsers always send one; `curl` / native apps usually don't — so a missing `Origin` on a mutating method is treated as a non-browser caller piggybacking on the auth cookie and rejected with 403.
- **Per-field metadata schema.** `POST /api/cc-sessions/:id/metadata` validates body against an allowlist (`name: string ≤ 200 chars`, `pinned: boolean`). Unknown fields are rejected with 400, so a buggy or hostile caller can't pollute `~/.claude/session-metadata.json`.
- **Session-create rate limit.** Sliding 60-second window, `RATE_LIMIT_PER_MIN` (default 30) per auth cookie, returns 429 past the cap. Stops a runaway loop from forking unbounded child processes.
- **Resume-cwd containment.** The `?cwd=…` parameter is `path.resolve()`-normalized and must land inside `os.homedir()`. A `../etc`-style escape that the old prefix-check would have accepted is now rejected; the server falls back to `DEFAULT_CWD`.
- **Optional token-print masking.** `AUTH_TOKEN_HIDE=true` redacts the bootstrap URL printed at startup (`?t=abcd…ef`), removing a leak vector for screen-shared or persistently-logged consoles.

### Added
- **GitHub Actions CI** runs Playwright e2e on every push and PR (Node 22 on Ubuntu, chromium-only) — ~47 s.
- **Dependabot** — weekly npm + github-actions updates, grouped by production/dev.
- **`SECURITY.md`** — private reporting via GitHub Security Advisories with an explicit threat model and in-scope list.
- **e2e security spec** (`e2e/security.spec.ts`) — 14 regression cases covering Origin gate, metadata schema, session-id validation, WS auth, rate-limit burst, resume-cwd containment. Full suite: 20/20 passing.

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

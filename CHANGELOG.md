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

## [0.7.0](https://github.com/oh-namgyu/claude-web-terminal/compare/v0.6.0...v0.7.0) (2026-08-25)


### Features

* **cwd:** filter search input inside dropdown ([672af1d](https://github.com/oh-namgyu/claude-web-terminal/commit/672af1d63a81a4af32a209a6f3c9a37c7da8417a))
* **palette+cwd:** @ file autocomplete + cwd picker dropdown ([a06d315](https://github.com/oh-namgyu/claude-web-terminal/commit/a06d31596585f0537da87e1ffbe3d70c389b3024))
* **slash-palette:** floating preview for slash commands ([1bfd1fb](https://github.com/oh-namgyu/claude-web-terminal/commit/1bfd1fb36bb84132cd070bb0740a4f81bb8554e9))


### Bug Fixes

* **cwd-picker:** dropdown menu uses position:fixed + JS coords (no off-screen clipping) ([13c9c76](https://github.com/oh-namgyu/claude-web-terminal/commit/13c9c763207e38ff71cd37d87336846134d22f74))
* **deps:** bump brace-expansion to 5.0.9 to resolve DoS advisories ([79488cc](https://github.com/oh-namgyu/claude-web-terminal/commit/79488ccde7d611576fbe92b46e8e8d2803490246))
* **docker:** copy scripts/ before npm ci so postinstall can run ([81f7319](https://github.com/oh-namgyu/claude-web-terminal/commit/81f731930309f0dd15da05d5e06906f72c0e0103))
* harden origin/WS checks, prevent event-loop blocks, atomic session metadata ([8d715dc](https://github.com/oh-namgyu/claude-web-terminal/commit/8d715dc9604eaf4f16291f900ef18eb495313292))
* **ime:** passthrough mode Hangul corruption — body text always buffered ([3306d06](https://github.com/oh-namgyu/claude-web-terminal/commit/3306d066b882329c63e8a0378e7b7bdd7f8b555b))
* patch ws DoS (npm audit) + CI audit gate + lint/contrib cleanup ([0a7cf7d](https://github.com/oh-namgyu/claude-web-terminal/commit/0a7cf7dadc3edf7035ebac079cd7ca53276f6e0a))
* **test+security:** npm test alias + SECURITY.md HOST=0.0.0.0 warning at top ([6283c97](https://github.com/oh-namgyu/claude-web-terminal/commit/6283c9794f7f799c84c600a4cbbb4599c077ff31))


### Security

* enforce Origin on state-changing methods + metadata schema allowlist ([0d2c8c9](https://github.com/oh-namgyu/claude-web-terminal/commit/0d2c8c94364c9b56bb2bde36eaf48077c331bb39))
* token-redact opt-in + session rate-limit + resume cwd containment ([90ead54](https://github.com/oh-namgyu/claude-web-terminal/commit/90ead54b059aec8dcec2ca8241017ede8bed251a))


### Performance

* **cwd:** boot warm-up + prefetch + Loading… placeholder ([1dd101e](https://github.com/oh-namgyu/claude-web-terminal/commit/1dd101e4374ad94e741bd5c48a2599d16d1e502d))


### Documentation

* add Korean README (README_KOR.md) ([dd84537](https://github.com/oh-namgyu/claude-web-terminal/commit/dd84537e9efb326d715583b7e50594bef78e7788))
* **changelog:** consolidate 2026-05-23 security pass ([34fca41](https://github.com/oh-namgyu/claude-web-terminal/commit/34fca417342af18c23e348f6fb79d6670c0b162f))
* **CHANGELOG:** correct cwd security note for v0.1.0 ([1526e2b](https://github.com/oh-namgyu/claude-web-terminal/commit/1526e2bb7692562627335417204f0b5c1dd7bce5))
* link Korean README from the top of README ([e8d7756](https://github.com/oh-namgyu/claude-web-terminal/commit/e8d7756b30e398e3ae5c4e78a7a1b314ea99156a))
* per-session pin design note in SECURITY.md + CHANGELOG observability entry ([f346c3f](https://github.com/oh-namgyu/claude-web-terminal/commit/f346c3f0c8e31dd1f916ff22398c9486b602dd52))
* **README:** add OS-aware keyboard shortcuts table ([f209231](https://github.com/oh-namgyu/claude-web-terminal/commit/f2092314f2e46276f39f0ebb818f4b3fbcfd5b0f))
* v0.6.0 — CHANGELOG entry + README notes for SSE & status values ([c7a8120](https://github.com/oh-namgyu/claude-web-terminal/commit/c7a812056a8135024bc9ce67016ca6454e6a8d4b))


### Continuous Integration

* eslint + release-please for conventional-commits releases ([93c75e3](https://github.com/oh-namgyu/claude-web-terminal/commit/93c75e33713fb2e4713c2461d5928ed3b632a767))
* GitHub Actions e2e + Dependabot + SECURITY.md ([8d0266b](https://github.com/oh-namgyu/claude-web-terminal/commit/8d0266bd34f7428ffa21ffa65ad5208681117cd5))


### Build System

* **deps-dev:** bump the dev group across 1 directory with 4 updates ([#10](https://github.com/oh-namgyu/claude-web-terminal/issues/10)) ([c4e3cc1](https://github.com/oh-namgyu/claude-web-terminal/commit/c4e3cc19def244ea3040bd091cc4b4941283069f))
* **deps:** bump actions/checkout from 4 to 6 ([#1](https://github.com/oh-namgyu/claude-web-terminal/issues/1)) ([e482b56](https://github.com/oh-namgyu/claude-web-terminal/commit/e482b56ae58c9c2f1bbf2acb9e75c0f665573e1d))
* **deps:** bump actions/setup-node from 4 to 6 ([#2](https://github.com/oh-namgyu/claude-web-terminal/issues/2)) ([451402a](https://github.com/oh-namgyu/claude-web-terminal/commit/451402a4f35afd5c8b506d0cd4f12b4829df63e5))
* **deps:** bump docker/login-action from 3 to 4 ([#5](https://github.com/oh-namgyu/claude-web-terminal/issues/5)) ([f1927d9](https://github.com/oh-namgyu/claude-web-terminal/commit/f1927d9aa148cd9c8ceed00d65ff66d5b6f1c165))
* **deps:** bump docker/setup-buildx-action from 3 to 4 ([#6](https://github.com/oh-namgyu/claude-web-terminal/issues/6)) ([aa9abad](https://github.com/oh-namgyu/claude-web-terminal/commit/aa9abad9cf145f5cad7cf7eaa75d45cd3170d114))
* **deps:** bump googleapis/release-please-action from 4 to 5 ([#4](https://github.com/oh-namgyu/claude-web-terminal/issues/4)) ([b75b221](https://github.com/oh-namgyu/claude-web-terminal/commit/b75b221694fe3e76c8011800f88c1cbcbb457108))
* **deps:** bump the production group across 1 directory with 3 updates ([#11](https://github.com/oh-namgyu/claude-web-terminal/issues/11)) ([8f224ac](https://github.com/oh-namgyu/claude-web-terminal/commit/8f224ac2ca921fae74f4501ff8dea58441fa74e7))
* Docker image (multi-stage Node 22 slim) + compose + ghcr publish ([9e45816](https://github.com/oh-namgyu/claude-web-terminal/commit/9e45816267b401e3f8c413591736a52fe6ddeffe))


### Code Refactoring

* extract DOM helpers, eliminate inline styles ([4c5ecf4](https://github.com/oh-namgyu/claude-web-terminal/commit/4c5ecf4cbe044c3f613c4a2385cd506d6993d0ee))
* split server.js and app.js into modules ([8902a26](https://github.com/oh-namgyu/claude-web-terminal/commit/8902a26d1bb52fb86c9b3601385549bf22199f9c))


### Tests

* **e2e:** Playwright E2E — 6 scenarios (bootstrap, static, origin gate) ([e207f57](https://github.com/oh-namgyu/claude-web-terminal/commit/e207f5754fe7759a1e2596d903b7968ddde6a06e))

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

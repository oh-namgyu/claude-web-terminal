# claude-web-terminal

[![CI](https://github.com/oh-namgyu/claude-web-terminal/actions/workflows/ci.yml/badge.svg)](https://github.com/oh-namgyu/claude-web-terminal/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![status](https://img.shields.io/badge/node-18%2B-green)

> **한글 요약** — 브라우저에서 Claude Code를 쓰는 셀프호스트 웹 터미널입니다. 백그라운드 세션의 목록·생성·접속·중지(Agent View)와, 이 PC에 남아 있는 과거 세션을 골라 이어서 여는 로컬 세션 브라우저를 지원합니다. 폰에서 내 텔레그램 봇에 키워드를 보내 PC 쪽 `claude remote-control` 세션을 띄워 두면, 나중에 책상 앞에서 그 대화를 웹 터미널에서 그대로 이어받을 수 있습니다. *(전체 한국어 문서: [README_KOR.md](README_KOR.md))*

**[🇰🇷 한국어 README](README_KOR.md)**

> A web UI for Claude Code's [Agent View](https://docs.claude.com/en/docs/claude-code/overview) — the same `claude agents` functionality you'd run in a terminal (list, create, attach, stop background sessions) but rendered as cards in your browser, with richer metadata (last assistant reply, token totals, branch, message count) than the CLI TUI shows.

![Agent View panel](docs/screenshot.png)

> Screenshot above uses the built-in `?demo=1` flag — all sessions and content are synthetic.

---

## Security model

This server spawns a real shell + `claude` REPL on your machine and exposes
it over HTTP/WebSocket, so it ships with two layers of access control,
**both required**:

- **Loopback bind** — `127.0.0.1` only; not reachable from the network.
- **Random per-start auth token** — set as an httpOnly `SameSite=Strict`
  cookie via a `?t=<token>` bootstrap URL. The `Origin` header is also
  validated on every API call and WebSocket upgrade, so a malicious page
  in your browser cannot cross-connect to the local server (CSWSH/CSRF
  protection).
- **State-changing requests require an `Origin` header.** Browsers
  always send one; `curl` and native apps usually don't — so a missing
  `Origin` on `POST`/`PUT`/`PATCH`/`DELETE` is treated as a non-browser
  caller piggybacking on the auth cookie and rejected with 403.
- **Per-field metadata schema.** Session metadata writes only accept
  `name` (string ≤ 200 chars) and `pinned` (boolean). Unknown fields
  are rejected — a buggy or hostile caller can't pollute
  `~/.claude/session-metadata.json`.
- **Session-create rate limit.** `POST /api/cc-sessions` is capped to
  `RATE_LIMIT_PER_MIN` (default 30) requests per minute per auth cookie;
  the cap stops a runaway loop from forking unbounded child processes.
- **Resume-cwd containment.** The `?cwd=…` parameter on the WebSocket
  resume path is `path.resolve()`-normalized and must land inside your
  `$HOME`. A `..`-rich or absolute escape (`/etc`, another user's
  `/Users/<bob>`) is rejected; the server falls back to `DEFAULT_CWD`.
  The resolved path is then re-checked with `fs.realpathSync`, so a
  symlink inside `$HOME` that points outside it (`~/x → /etc`) is rejected
  too — both the lexical path and its symlink target must be inside `$HOME`.
- **Optional token-print masking.** Set `AUTH_TOKEN_HIDE=true` to print
  a redacted bootstrap URL (`?t=abcd…ef`) at startup — useful when the
  console is screen-shared or persistently logged. You then need to
  know `AUTH_TOKEN` out-of-band.

- **Resume runs where the transcript says, not where the client asks.**
  The session browser sends an id and nothing else; the server re-reads
  that session from disk at spawn time and takes the working directory
  from the transcript's own records. The result must resolve inside
  `ALLOWED_RESUME_ROOTS` (default `$HOME`) or nothing is spawned.

Do not change `HOST` to `0.0.0.0` on a shared network — even with the
token, the API surface (cwds, session names, last assistant text, the
prompt previews returned by `/api/cc/resume-sessions`) is **not**
designed for multi-tenant exposure. Treat anyone who has the cookie as
having read access to every Claude conversation on this machine.

## Why

Claude Code v2 introduced background sessions (`claude --bg "<task>"`) and the
`claude agents` TUI to manage them. If you're juggling several long-running
agents at once — research, refactors, audits — the TUI is fine but doesn't
give you a quick visual overview, and you can't easily click between them.

**This project takes the same Agent View concept and renders it as a web UI**:
the cards expose more metadata than the CLI TUI, navigation is mouse-driven,
and you can attach a session into a new browser tab with one click. Under the
hood it just spawns `claude attach <id>` / `claude --bg "<prompt>"` / `claude
stop <id>` — the same commands you'd run yourself.

`claude-web-terminal` is a small Node/Express server that exposes a web UI
with:

- A real Claude Code terminal in your browser (via [xterm.js](https://xtermjs.org/) + [node-pty](https://github.com/microsoft/node-pty)) — multiple tabs with WebSocket auto-reconnect.
- A 🤖 side panel listing every active background session and every live interactive session — with names, last assistant response, token usage, branch, and message count.
- A 📂 **local session browser** listing the past sessions on this machine that `claude --resume` can reopen — including ones started somewhere else entirely, such as from your phone.
- One-click **attach** (new or current tab) and one-click **resume** (auto-resolves the session's original cwd).
- ➕ **create**, ✏️ **rename**, 🗑 **stop**, ⭐ **pin** sessions.
- 🔎 search + ⏱ time filter (2d / 5d / 7d / 2w / 1m) for quickly finding a session.
- 🔔 desktop notifications when a background session leaves the `busy` state (either `→ waiting` for input or `→ idle` when finished). Delivered via Server-Sent Events so they survive background-tab timer throttling.
- Model toggle (Opus / Sonnet / Haiku) and keyboard shortcuts (`Cmd+T/W/K/1-9`).
- An optional IME-friendly input bar that fixes Safari's broken Korean/Chinese/Japanese composition inside xterm.js.

## Quick start

```bash
git clone https://github.com/oh-namgyu/claude-web-terminal.git
cd claude-web-terminal
npm install
cp .env.example .env       # adjust HOST/PORT if you like
npm start
```

### Docker

A `compose.yml` is included; `ghcr.io/oh-namgyu/claude-web-terminal:latest` is built on every push to `main`:

```bash
docker compose up -d
docker compose logs cwt    # copy the bootstrap URL printed at boot
```

The compose file mounts `./cwt-home` → `~/.claude` (Claude credentials / session data) and `./work` → `/work` (the code you want Claude to see). Default bind is `127.0.0.1:8765`; if you change it to expose on a network, pair with `AUTH_TOKEN_HIDE=true`, set `AUTH_TOKEN` to a long random secret, and put a TLS-terminating reverse proxy in front.

On first start the console prints a bootstrap URL with a one-time token:

```
claude-web-terminal
  Open this URL once to authenticate (token is set as a cookie):
  →  http://127.0.0.1:8765/?t=<random-token>
```

Open that URL once — the server sets an httpOnly `SameSite=Strict` cookie,
strips the token from the URL, and subsequent visits to
`http://127.0.0.1:8765` work without the token. The first tab auto-runs
`claude` for you.

By default a new random token is generated on every restart. Set
`AUTH_TOKEN=<your-value>` in `.env` if you want the bootstrap URL to stay
the same across restarts.

## Keyboard shortcuts

The modifier is **⌘ Command** on macOS and **Ctrl** on Windows / Linux.
Shortcuts are suppressed while an IME composition is active so they don't
fight Korean / Chinese / Japanese input.

| Action                                    | macOS         | Windows / Linux |
| ----------------------------------------- | ------------- | --------------- |
| New tab                                   | `⌘ T`         | `Ctrl + T`      |
| Close active tab                          | `⌘ W`         | `Ctrl + W`      |
| Open Agent panel + focus search           | `⌘ K`         | `Ctrl + K`      |
| Switch to nth tab (1–9)                   | `⌘ 1` … `⌘ 9` | `Ctrl + 1` … `Ctrl + 9` |

> Most browsers also bind `Ctrl/⌘ + T` and `Ctrl/⌘ + W` for browser tabs.
> The page handler calls `preventDefault()` so the browser-level binding
> won't fire while the app is focused.

## CLI helper: `cc-resume`

`claude --resume <id>` only finds sessions whose original cwd matches
your current shell. If you can't remember where a session was created,
use the bundled helper — it locates the transcript, reads the original
cwd, and `cd`s there before resuming:

```bash
ln -s "$PWD/bin/cc-resume" /usr/local/bin/cc-resume   # or add bin/ to PATH

cc-resume <sessionId>     # full id
cc-resume 71fc583c        # prefix is enough if unambiguous
```

## Requirements

- Node.js 18+
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code/overview) on `PATH`, authenticated (Pro/Max login or `ANTHROPIC_API_KEY`).

## Testing

```bash
npm run test:e2e          # Playwright Chromium — 59 tests (servers auto-spawn)
npm run test:e2e:headed   # show browser
```

| Spec | Covers |
|---|---|
| `smoke.spec.ts` | Bootstrap (401 without token / `?t=` sets the `cwt_auth` httpOnly cookie / wrong token blocked), static UI, Origin gate |
| `security.spec.ts` | Origin enforcement on state-changing methods, metadata schema, id validation, WS auth, rate limit, metrics |
| `resume-sessions.spec.ts` | Transcript discovery driven directly against throwaway `~/.claude` trees — the corrupt / renamed / id-mismatched files it must skip |
| `resume-browser.spec.ts` | The session browser end to end against a fixture `~/.claude` and a fake `claude` on `PATH`: listing, resume spawn, cwd containment, `RESUME_BROWSER=0` |
| `telegram-launcher.spec.ts` | The launcher's decision logic with network and spawning injected: config permission refusal, chat allowlist, keyword→spawn mapping, offset-before-action ordering, stop-match verification, single-instance lock |

First run: `npx playwright install chromium` (~92MB). Token fixed via `E2E_AUTH_TOKEN` env (default `e2e-test-token-cwt-12345`).

The specs that assert on real terminal output need `/bin/zsh` (the pty spawns
it) and skip themselves without it — CI installs zsh explicitly so they can
never skip silently there.

## How it works

| What | Where it comes from | Status |
|---|---|---|
| Background session ID list | `/tmp/cc-daemon-<UID>/<daemon>/rv/<jobId>.sock` (existence = alive) | undocumented internal of Claude Code |
| Session metadata (name, status, kind, cwd, sessionId) | `~/.claude/sessions/<pid>.json` | undocumented internal |
| Transcript (last response, token usage, branch, msg count) | `~/.claude/projects/<cwd-slug>/<sessionUUID>.jsonl` | undocumented internal |
| `attach` / `stop` / `--bg` | Public `claude` CLI subcommands | stable |
| `status` values (`busy` / `waiting` / `idle`) | Field in the session metadata; the server polls it every 2s and pushes notifications over SSE | undocumented internal — pinned by [`server.js`](server.js) |
| Past (resumable) sessions | `~/.claude/projects/<encoded-dir>/<sessionUUID>.jsonl`, with the cwd read from the records — the directory name is a lossy encoding and is never decoded | undocumented internal — [`lib/resume-sessions.js`](lib/resume-sessions.js) |
| `--resume` | Public `claude` CLI flag | stable |

The live session listing relies on three undocumented paths. If a future
Claude Code release changes them, edit
[`lib/cc-sessions.js`](lib/cc-sessions.js); the past-session listing lives
separately in [`lib/resume-sessions.js`](lib/resume-sessions.js). The
notification trigger reads the same `status` field; adjust the state machine
in [`server.js`](server.js) if CC introduces new values. What exactly was
observed, and on which version, is in
[Verified behavior](#verified-behavior-version-pinned) below.

## Agent View panel

Click the 🤖 button on the left sidebar. The panel shows two sections:

- **⚡ Background (attachable)** — created via `claude --bg "<prompt>"` or via the ➕ button. You can attach in a new tab, replace the current tab, or stop the session.
- **💬 Interactive (read-only)** — any live `claude` REPL on the system (this app's own tabs, your VS Code claude, a raw shell tab). They are listed for visibility but can't be attached because they're not registered with the background daemon.

Each card shows the auto-generated name, the last assistant message snippet,
working directory + git branch, message count, total token usage, and time
since last update.

Past sessions are **not** in this panel — they live in the session browser
below, which is the single place this app lists resumable work.

## Local session browser

Click 📂 on the left sidebar. It lists the Claude Code transcripts this
machine already has: every session `claude --resume` can reopen, regardless of
where it was started — another terminal, an editor, or a phone (next section).
Each card shows the session's directory, its last prompt, message count and
age; clicking one opens a tab running `claude --resume <id>` in that session's
original directory.

Three environment variables control it — see [Configuration](#configuration):

- `RESUME_BROWSER=0` removes the feature end to end (the route 404s, the 📂 button never appears).
- `RESUME_PREVIEW=0` keeps the listing but blanks the prompt previews.
- `ALLOWED_RESUME_ROOTS` bounds where a resumed session may run.

## Resume sessions from your phone

You are away from the desk, you think of something, and you want the work
waiting for you when you get back. The flow, end to end:

1. From your phone, send a keyword — say `blog` — to **your own** Telegram bot.
2. `scripts/telegram-launcher.mjs`, running on your desktop, maps that keyword to a directory and starts `claude remote-control` there.
3. You drive that session from your phone. It runs on your machine, so its transcript is written to `~/.claude/projects/` like any other session.
4. Back at the keyboard, open claude-web-terminal, click 📂, and pick the session. The conversation is restored in a terminal tab and you carry on typing.

The launcher is **optional and standalone**: no part of the server imports it,
it adds no dependencies (Node ≥ 22 built-ins only), and the session browser
works exactly the same for sessions you started by hand.

### Launcher quickstart

```bash
mkdir -p ~/.cwt-launcher
cat > ~/.cwt-launcher/config.json <<'EOF'
{
  "botToken": "123456:example-bot-token-placeholder",
  "allowedChatIds": [11111111],
  "keywords": {
    "blog": "~/projects/blog",
    "api":  "~/projects/api"
  }
}
EOF
chmod 600 ~/.cwt-launcher/config.json

node scripts/telegram-launcher.mjs
```

- **`botToken`** — from [@BotFather](https://t.me/botfather). Create your own bot; the launcher only ever talks to that one.
- **`allowedChatIds`** — the numeric chat ids allowed to command it. Anything from any other chat is dropped without a reply, so a stranger who finds your bot learns nothing. Send a message to your bot and read the id from `getUpdates`, or ask any id-echo bot.
- **`keywords`** — keyword → directory. `~` is expanded; a directory that doesn't exist is a startup error, not a runtime surprise.

What the bot understands:

| Message | Effect |
|---|---|
| `<keyword>` | start `claude remote-control` in the mapped directory |
| `list` | reply with the keywords currently running |
| `stop <keyword>` | stop that session |
| `stop all` | stop every session this launcher started |
| anything else | reply with the keyword menu |

State lives in `~/.cwt-launcher/`: `offset` (the Telegram update cursor),
`pids/<keyword>.json`, `logs/<keyword>.log` (the child's own output), and
`launcher.lock` (single-instance guard, released automatically if a previous
launcher was killed).

Four decisions worth knowing before you rely on it:

- **The config must be mode 600.** It holds a bot token in clear text, so a file any other account can read is a leaked token. The launcher refuses to start otherwise; `--insecure-config` overrides at your own risk.
- **Commands are at-most-once.** The update cursor is persisted *before* the command is acted on. A crash at the wrong instant therefore loses a command — you resend it — rather than replaying it and starting a second session for the same message.
- **`stop` verifies before it kills.** The recorded pid is only signalled when its current start time and command line still match what was recorded at spawn. A pid that was recycled in the meantime is left alone and the record is dropped.
- **Only the keyword is logged.** Never the token, never the text of your messages.

## IME-friendly input bar

xterm.js's hidden helper textarea is 1×1px, which Safari/WebKit can refuse
to activate for IME composition (Korean, Japanese, Chinese). When that
happens you see decomposed jamo / kana / pinyin instead of composed
characters.

The bar below the terminal is a normal-sized textarea that Safari composes
properly. The message body is **always buffered** — you type, press Enter, and
the whole composed string is sent to the active tab as a single chunk (an
earlier design forwarded per-keystroke deltas, but IME composition could race
and corrupt the buffer, so live body send was dropped).

The mode indicator next to the bar reflects what the **navigation keys** do:

- **buffered** — the default. Only Enter sends; nothing is forwarded live.
- **slash (keys live)** — shown when your input starts with `/`, `@`, or `#`.
  The text is still buffered, but the navigation keys go live so Claude Code's
  slash-command popup, file-mention picker, and memory shortcut stay usable:
  **↑ ↓ ← → arrows, Escape, and Tab** are translated to the matching control
  sequences. (Backspace is not forwarded — edit in the textarea instead.) The
  app also shows its own slash/`@` palette above the bar for these prefixes.

## Preview without Claude Code installed

Open `http://127.0.0.1:8765/?demo=1&showAgents=1` to view the Agent View panel
with synthetic sample sessions. No real session data is used, no `claude` binary
is required for this preview. Helpful for screenshots and demos.

## Configuration

All via environment variables — see [`.env.example`](.env.example):

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind host. **Don't change to `0.0.0.0` on a shared network** — `/api/cc-sessions` exposes the cwd, name and last assistant text of every session. |
| `PORT` | `8765` | Web UI port |
| `CLAUDE_BIN` | *(PATH lookup)* | Path to the `claude` binary |
| `DEFAULT_CWD` | `$HOME` | Working directory for new tabs |
| `CWD_ROOTS` | `$HOME` | Comma-separated root dirs whose first-level children populate the cwd dropdown. `devs`/`docs`/`repos`/`projects`/`code` children get an extra nesting level. `~` is expanded. |
| `AUTH_TOKEN` | *(random per start)* | Fixed loopback auth token. If unset, a random 192-bit token is generated each start and printed to the console as `?t=<token>`. Open that URL once to set the auth cookie. |
| `AUTH_TOKEN_HIDE` | `false` | Print a masked bootstrap URL (`?t=abcd…ef`) so screen-shares / persisted logs don't leak the token. You then need `AUTH_TOKEN` out-of-band. |
| `ALLOWED_ORIGINS` | *(loopback http+https)* | Comma-separated extra origins **merged** with the built-in loopback set (`http`/`https` on `localhost`/`127.0.0.1`/`HOST`). Set when fronting with a custom origin (e.g. `https://cwt.local`). |
| `ALLOW_NO_ORIGIN_WS` | `false` | Allow WebSocket upgrades that carry no `Origin` header. Off by default (a missing Origin is treated as a non-browser caller and rejected, matching the POST policy). Set `1`/`true` for native clients or tests. |
| `RATE_LIMIT_PER_MIN` | `30` | Max `POST /api/cc-sessions` (session-create) requests per minute per auth cookie. |
| `RESUME_BROWSER` | `1` | Local session browser. `0` removes it end to end — `/api/cc/resume-sessions` 404s and the 📂 entry point never appears. |
| `RESUME_PREVIEW` | `1` | Show each past session's last prompt as a one-line preview. `0` lists the sessions without their prompt text. |
| `ALLOWED_RESUME_ROOTS` | `$HOME` | Colon-separated absolute dirs a resumed session may run in. The cwd comes from the transcript, never from the browser, and is rejected (nothing spawns) unless its realpath lands inside one of these roots. `~` is expanded. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `LOG_FORMAT` | `text` | `text` (single-line) \| `json` (one object per line, for log scrapers). |

## Verified behavior (version-pinned)

The phone → PC resume flow rests on **observed, undocumented Claude Code
behavior**. None of it is a published interface, and Anthropic has not
promised any of it will keep working. It was verified with
**Claude Code v2.1.227 (2026-08-27)**:

- **(a)** Transcripts are written to `~/.claude/projects/<dir>/<uuid>.jsonl`,
  one JSON record per line, each record carrying its own `cwd` and `sessionId`
  fields. (`<dir>` is a lossy encoding of the working directory — both `/` and
  `.` collapse to `-` — so this project reads the `cwd` field and never
  decodes the directory name.)
- **(b)** Headless `claude remote-control` child sessions write their
  conversation to a local transcript in that same tree.
- **(c)** `claude --resume <id>` restores that conversation.

**No compatibility promises are made beyond that version.** A Claude Code
upgrade may move the tree, change the record shape, or stop writing
transcripts for remote-control sessions, and the session browser would then
list nothing — or list sessions that refuse to resume.

### Re-verify on a new Claude Code version

Three commands, about a minute:

1. Send one keyword to your bot from the phone and exchange a message or two
   with the session it starts.
2. `ls -lt ~/.claude/projects/*/*.jsonl | head` — a transcript for that
   session should have just appeared. Confirm the records carry `cwd` and
   `sessionId`:
   `head -1 <that file> | grep -o '"\(cwd\|sessionId\)":"[^"]*"'`
3. Open the 📂 browser, pick that session, and check the restored
   conversation is the one you had on the phone.

If step 2 finds nothing, (a) or (b) has changed — start at
[`lib/resume-sessions.js`](lib/resume-sessions.js). If step 3 opens an empty
session, (c) has changed and the resume flag itself is the problem.
[`docs/manual-smoke.md`](docs/manual-smoke.md) has the full checklist,
including what evidence to record.

## What this is not

- Not a replacement for the Claude Code CLI — it spawns it.
- Not a cloud service. Everything runs on your machine.
- Not a multi-user system. The session paths assume a single UID.

## License

MIT — see [LICENSE](LICENSE). Security policy: [SECURITY.md](SECURITY.md).

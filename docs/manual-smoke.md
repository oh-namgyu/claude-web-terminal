# Manual smoke checklist

Two things the automated suite deliberately does not cover, because both need
credentials and a real Claude Code install that CI has no business holding:

1. **Launcher smoke** — a real bot token, a real phone, a real spawned session.
2. **Resume smoke** — a real past session restored in the web terminal.

The e2e suite covers everything around them: transcript discovery against
fixture trees, the resume spawn against a fake `claude`, and every launcher
decision with the network and process spawning injected. What it cannot prove
is that the *undocumented Claude Code behavior* the feature depends on still
holds — see [Verified behavior](../README.md#verified-behavior-version-pinned).
So run these two by hand after upgrading Claude Code, and after touching
`lib/resume-sessions.js`, `lib/ws.js` or `scripts/telegram-launcher.mjs`.

**Record the terminal/output snippet as evidence** for every step that says
so. Paste it into the PR or your notes with the Claude Code version
(`claude --version`) and the date. A checklist ticked from memory is worth
nothing a month later; the snippet is the thing a future reader can check.

---

## Gate 1 — Launcher smoke (real token)

**Needs:** a Telegram bot of your own, your chat id, `claude` on `PATH`, a phone.

| # | Step | Pass condition |
|---|---|---|
| 1 | `chmod 644 ~/.cwt-launcher/config.json`, then start the launcher | It **refuses** to start and names the mode. Restore with `chmod 600`. |
| 2 | Start the launcher with a valid mode-600 config | Prints the keyword and allowed-chat counts, then waits. |
| 3 | Start a second launcher in another terminal | It **refuses**: "another launcher is already running (pid …)". |
| 4 | From the phone, send an unmapped word (`hello`) | The bot replies with the keyword menu. Your word is **not** echoed back and does **not** appear in the launcher's stdout. |
| 5 | From a chat that is **not** in `allowedChatIds`, send a keyword | No reply at all, and no session starts. |
| 6 | From the phone, send a configured keyword (`blog`) | Bot replies `started blog (pid …)`. |
| 7 | `ls -lt ~/.claude/projects/*/*.jsonl \| head -3` | A transcript for the new session has just appeared. **Record this output.** |
| 8 | Exchange two or three messages with the session from the phone | The replies arrive; `~/.cwt-launcher/logs/blog.log` is being written. |
| 9 | Send `list` | The reply names `blog`. |
| 10 | Send `stop blog`, then `list` | Reply `stopped blog`; the following `list` says nothing is running; the pid is gone from `ps`. |
| 11 | Grep the launcher's stdout for the token and for any message text | Neither appears. **Record the grep and its empty result.** |

**Evidence to keep:** the output of step 7 and step 11, plus the bot's replies
from steps 6 and 10 (a screenshot is fine).

### Deliberate failure worth checking once

Kill the launcher with `kill -9` while a session is running, restart it, and
send `list`. The stale `launcher.lock` must be taken over rather than blocking
startup, and the still-running session must still be reported.

---

## Gate 2 — Resume smoke (real session)

**Needs:** at least one real past session in `~/.claude/projects/`. The
session from Gate 1 is the ideal candidate — it proves the phone → PC → desk
path in one go.

| # | Step | Pass condition |
|---|---|---|
| 1 | Start the server, open the UI, click 📂 | The panel lists real sessions, newest first, each showing its directory and last prompt. |
| 2 | Find the session from Gate 1 | It is in the list, with the prompt you typed on the phone as its preview. |
| 3 | Click it and accept the confirmation | A tab opens running `claude --resume <id>`. |
| 4 | Read the restored context | The conversation is the one from the phone — not an empty session. **Record the first screenful of terminal output.** |
| 5 | Ask the session something that needs earlier context ("what did I ask you first?") | It answers from the restored history. **Record the answer.** |
| 6 | Restart with `RESUME_PREVIEW=0` | Sessions are still listed; prompt previews are blank. |
| 7 | Restart with `RESUME_BROWSER=0` | The 📂 button is absent and `curl` on `/api/cc/resume-sessions` returns 404. |
| 8 | Restart with `ALLOWED_RESUME_ROOTS` set to a directory that holds none of your sessions | Resuming is refused and nothing spawns. |

**Evidence to keep:** the terminal snippets from steps 4 and 5. They are the
only proof that (b) and (c) in
[Verified behavior](../README.md#verified-behavior-version-pinned) still hold
on the version you are running.

---

## After the run

Note in the PR (or in `README.md` if you are moving the pin) the Claude Code
version you verified against. If either gate failed, the version pin in the
README is now wrong — say so explicitly rather than leaving the old version
claiming coverage it no longer has.

# Security policy

## Reporting a vulnerability

If you've found a security issue in `claude-web-terminal`, **please do not file a public GitHub issue**. Instead, report it privately via [GitHub Security Advisories](https://github.com/oh-namgyu/claude-web-terminal/security/advisories/new).

I'll acknowledge within 7 days and aim for a fix within 30 days for confirmed issues. Coordinated disclosure: please give me time to publish a patched release before disclosing publicly.

## Threat model & non-goals

`claude-web-terminal` is a **single-user, loopback-only** tool. The default deployment binds to `127.0.0.1` and is protected by:

- A random per-start auth token delivered via a `?t=<token>` bootstrap URL and stored as an httpOnly `SameSite=Strict` cookie.
- `Origin` header enforcement on all state-changing API calls and WebSocket upgrades.
- A per-field allowlist on session metadata writes.

The threat model **excludes**:

- Multi-tenant exposure. Anyone who holds the auth cookie can read every Claude transcript on the machine (`/api/cc-resume-sessions` returns full preview text), spawn shells, and stop running sessions. Do not change `HOST` away from loopback on a shared network — see [README → Security model](README.md#security-model).
- Defense against an attacker with physical or root access to the host running the server. Once they read the token cookie or environment, the game is over.
- A sandboxed `claude` subprocess. By design the server hands the user a real shell.

In-scope concerns I want to hear about:

- Auth/cookie bypass, CSRF, CSWSH, or Origin-check evasion paths.
- Path traversal or arbitrary file disclosure via any HTTP endpoint or WebSocket attach/resume parameter.
- XSS or HTML/JS injection in the dashboard rendering (xterm.js / DOMPurify usage / templated strings).
- Any case where a non-authenticated request can change state.
- Supply-chain risk in the dependency tree (Dependabot is on, but please flag a confirmed exploit).

## Multi-tenant deployment (out of scope, design note)

If you ever need to share a `claude-web-terminal` server across users — not the current design — the missing piece is per-session locking, since today anyone holding the auth cookie can attach to every Claude conversation on the machine. A future implementation would probably:

- add `pin_hash` (server-side hash) to the per-session metadata schema (`POST /api/cc-sessions/:id/lock { pin }`),
- require `?pin=<value>` matching the stored hash on the WebSocket attach/resume URL,
- prompt for the PIN in the dashboard the first time a user attaches.

I'm deliberately not building this until there's a real scenario — the current single-user loopback model keeps the surface small.

## Supported versions

Latest `main` only. Security fixes ship there first and are tagged in [CHANGELOG.md](CHANGELOG.md).

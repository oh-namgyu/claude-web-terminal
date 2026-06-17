# Contributing to claude-web-terminal

Thanks for your interest!

## Development setup

```bash
npm install
npm run lint
npm test            # Playwright e2e (installs chromium on first run)
npm start           # serves on http://127.0.0.1:8765
```

## Guidelines

- This tool exposes a terminal/CLI over HTTP. Keep it **loopback-first** and
  read [SECURITY.md](SECURITY.md) before touching auth, host binding, the
  Origin/CSRF checks, or the PTY/command paths.
- `npm run lint` must pass with **no warnings**, and the e2e suite must be green
  before opening a PR.
- Describe what changed and how you verified it.

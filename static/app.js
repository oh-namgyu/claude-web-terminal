'use strict';

// The frontend was split into focused modules under static/js/ loaded directly
// by index.html in dependency order:
//   js/tabs.js            — multi-tab claude REPL + terminal/WS lifecycle
//   js/agent-panel.js     — Agent View panel, session cards, SSE/busy bar, notifications
//   js/command-palette.js — slash (/) & at (@) palette + cwd picker + model toggle
//   js/ime.js             — IME-friendly input bar
//   js/boot.js            — send buttons, edit modal, global shortcuts, boot
//
// This file is intentionally a no-op placeholder: it is no longer referenced by
// index.html, but is kept so a direct GET /app.js still resolves (200).

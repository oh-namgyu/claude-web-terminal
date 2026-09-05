'use strict';

// Centralized configuration — every env-derived constant the server reads at
// boot lives here so the wiring in server.js, the auth middleware, the routes
// and the WebSocket handler all share a single source of truth.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const which = require('child_process').execSync;

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '8765', 10);

// Loopback auth token — generated each start unless overridden via AUTH_TOKEN env.
// Must be presented as `?t=<token>` on first visit; server sets an httpOnly
// SameSite=strict cookie that is then sent automatically for subsequent
// requests and the WebSocket upgrade.
const TOKEN = process.env.AUTH_TOKEN || crypto.randomBytes(24).toString('base64url');
// If you persist server logs or share your screen, the bootstrap URL with
// the token in clear text becomes a leak. Set AUTH_TOKEN_HIDE=true to print
// a masked URL — you must then know the token via .env or your secret
// manager. Default `false` keeps the existing copy-from-terminal flow.
const AUTH_TOKEN_HIDE = String(process.env.AUTH_TOKEN_HIDE || '').toLowerCase() === 'true';
const COOKIE_NAME = 'cwt_auth';

// Built-in loopback origins (http + https, with and without the port) so a
// TLS-terminating reverse proxy on the default https port still matches.
// ALLOWED_ORIGINS env (comma-separated) is *merged* with these defaults; set
// it when fronting the server with a custom origin (e.g. https://cwt.local).
const _defaultOrigins = [
    `http://${HOST}:${PORT}`,
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `https://${HOST}:${PORT}`,
    `https://localhost:${PORT}`,
    `https://127.0.0.1:${PORT}`,
    // Port-less https variants for the default 443 fronted by a proxy.
    `https://${HOST}`,
    `https://localhost`,
    `https://127.0.0.1`,
];
const _envOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
const ALLOWED_ORIGINS = new Set([..._defaultOrigins, ..._envOrigins]);

// Browsers always send Origin on a WebSocket upgrade, so a missing Origin is
// a non-browser client riding the auth cookie — rejected by default, matching
// the POST/PUT/PATCH/DELETE policy. Set ALLOW_NO_ORIGIN_WS=1 to permit
// Origin-less upgrades (native clients, curl --include-headers, tests).
const ALLOW_NO_ORIGIN_WS = String(process.env.ALLOW_NO_ORIGIN_WS || '').toLowerCase() === '1'
    || String(process.env.ALLOW_NO_ORIGIN_WS || '').toLowerCase() === 'true';

// State-changing requests must carry an Origin header. Browsers always do;
// curl / native apps usually don't — so a missing Origin on POST/PUT/PATCH/
// DELETE is a sign of a non-browser caller piggybacking on the auth cookie.
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Sliding-window rate limiter cap for session spawn.
const RATE_LIMIT_PER_MIN = Math.max(1, parseInt(process.env.RATE_LIMIT_PER_MIN || '30', 10));

const CLAUDE_BIN = (() => {
    if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
    try { return which('which claude', { encoding: 'utf-8' }).trim() || 'claude'; }
    catch { return 'claude'; }
})();
const DEFAULT_CWD = process.env.DEFAULT_CWD || os.homedir();

// cwd dropdown options — first-level children of well-known root dirs
// ($HOME by default, override with CWD_ROOTS=comma,separated,paths).
const CWD_ROOTS = (process.env.CWD_ROOTS || os.homedir())
    .split(',')
    .map(p => path.resolve(p.trim().replace(/^~(?=$|\/)/, os.homedir())))
    .filter(Boolean);

// ===== Local session browser (lib/resume-sessions.js) =====
// Both flags are on by default and are switched off with an explicit `0`.
// RESUME_BROWSER=0 removes the feature end to end: the API route 404s and the
// UI, which only shows its entry point once that route answers, stays hidden.
const RESUME_BROWSER = String(process.env.RESUME_BROWSER || '1') !== '0';
// RESUME_PREVIEW=0 keeps the listing but blanks every preview, for anyone who
// would rather not have the last prompt of each session on screen.
const RESUME_PREVIEW = String(process.env.RESUME_PREVIEW || '1') !== '0';

// Directories a resumed session is allowed to run in. A session's cwd comes
// from its transcript, not from the client, and is rejected unless its
// realpath lands inside one of these roots. Colon-separated (PATH-style, so a
// path containing a comma is not a problem), `~` is expanded, defaults to
// your home dir. Roots are realpath'd here so the comparison in
// lib/auth.js#resolveResumeCwd is symlink-stable (/tmp → /private/tmp).
const ALLOWED_RESUME_ROOTS = (process.env.ALLOWED_RESUME_ROOTS || os.homedir())
    .split(':')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir())))
    .map(p => { try { return fs.realpathSync(p); } catch { return p; } });

function ptyEnv() {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    // Make sure the dir containing claude is on PATH inside the pty.
    if (process.env.CLAUDE_BIN) {
        const binDir = path.dirname(process.env.CLAUDE_BIN);
        env.PATH = `${binDir}:${env.PATH || ''}`;
    }
    return env;
}

module.exports = {
    HOST, PORT, TOKEN, AUTH_TOKEN_HIDE, COOKIE_NAME,
    ALLOWED_ORIGINS, ALLOW_NO_ORIGIN_WS, STATE_CHANGING,
    RATE_LIMIT_PER_MIN, CLAUDE_BIN, DEFAULT_CWD, CWD_ROOTS,
    RESUME_BROWSER, RESUME_PREVIEW, ALLOWED_RESUME_ROOTS,
    ptyEnv,
};

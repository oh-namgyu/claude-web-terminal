'use strict';

// Auth, origin (CSRF) and rate-limit helpers plus the express middlewares that
// gate every request. Pure helpers (parseCookies/hasValidAuth/origin checks/
// safeResumeCwd) are also consumed by the WebSocket upgrade handler, so they
// are exported alongside the middleware factory.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const log = require('./log');
const metrics = require('./metrics');
const {
    TOKEN, COOKIE_NAME, ALLOWED_ORIGINS, ALLOW_NO_ORIGIN_WS,
    STATE_CHANGING, RATE_LIMIT_PER_MIN, ALLOWED_RESUME_ROOTS,
} = require('./config');

function parseCookies(header) {
    const out = {};
    (header || '').split(';').forEach(c => {
        const i = c.indexOf('=');
        if (i < 0) return;
        const k = c.slice(0, i).trim();
        const v = c.slice(i + 1).trim();
        if (k) out[k] = v;
    });
    return out;
}

// Constant-time compare — closes the timing side-channel on token comparison
// (returns false immediately on length mismatch, else timingSafeEqual).
function safeEqual(a, b) {
    const ba = Buffer.from(String(a == null ? '' : a));
    const bb = Buffer.from(String(b == null ? '' : b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function hasValidAuth(req) {
    const cookies = parseCookies(req.headers.cookie);
    return safeEqual(cookies[COOKIE_NAME], TOKEN);
}

// Browsers always set Origin on cross-origin WS upgrades; for top-level GETs
// from the address bar Origin can legitimately be absent. So we only enforce
// when Origin *is* present — and we always require a valid auth cookie too.
function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    return ALLOWED_ORIGINS.has(origin);
}

function originAllowedForWs(req) {
    const origin = req.headers.origin;
    if (!origin) return ALLOW_NO_ORIGIN_WS;
    return ALLOWED_ORIGINS.has(origin);
}

function originRequiredForMethod(req) {
    if (!STATE_CHANGING.has(req.method)) return true;
    const origin = req.headers.origin;
    if (!origin) return false;
    return ALLOWED_ORIGINS.has(origin);
}

// Sliding-window rate limiter for session spawn. Even an authenticated user
// could accidentally fire a loop that spawns a child process per call; this
// caps to N requests in the trailing 60s. State is keyed by the auth cookie
// since that's the only stable per-caller identifier we have.
const _rateBuckets = new Map();
function rateLimit(req) {
    const cookies = parseCookies(req.headers.cookie);
    const key = cookies[COOKIE_NAME] || req.ip || 'anon';
    const now = Date.now();
    const window = 60_000;
    const arr = (_rateBuckets.get(key) || []).filter(t => now - t < window);
    if (arr.length >= RATE_LIMIT_PER_MIN) {
        _rateBuckets.set(key, arr);
        return false;
    }
    arr.push(now);
    _rateBuckets.set(key, arr);
    return true;
}

// Resolve a resume-cwd parameter to a safe absolute path under the current
// user's home directory. Returns the resolved path or null if it escapes.
// The logical (path.resolve'd) path must be inside HOME, AND the realpath
// (symlinks followed) must also be inside HOME — otherwise a symlink such as
// ~/escape → /etc would pass the lexical prefix check while pointing outside
// the home tree. Both checks must hold.
function safeResumeCwd(input) {
    if (!input) return null;
    try {
        const home = os.homedir();
        const homeNormalized = home.endsWith(path.sep) ? home : home + path.sep;
        const isInsideHome = (p) => p === home || p.startsWith(homeNormalized);
        const abs = path.resolve(input);
        if (!isInsideHome(abs)) return null;
        if (!fs.existsSync(abs)) return null;
        // Re-check after resolving symlinks so a symlink inside HOME pointing
        // outside it (e.g. ~/x → /etc) is rejected.
        const real = fs.realpathSync(abs);
        if (!isInsideHome(real)) return null;
        return abs;
    } catch {
        return null;
    }
}

// Resolve the cwd of a session being resumed. Unlike safeResumeCwd above,
// the input never comes from the client: it is the `cwd` recorded inside the
// session transcript, and the client only ever sends a session id. The path
// is realpath'd first and the *resolved* value is both containment-checked
// against ALLOWED_RESUME_ROOTS and returned, so the caller spawns in exactly
// the directory that was validated.
//
// The residual race — the directory could be swapped between this realpath
// and the pty spawn — is acknowledged and harmless: the server and claude run
// as the same user with the same reach, so winning that race grants an
// attacker nothing they could not already do, and the worst outcome is claude
// failing to start.
function resolveResumeCwd(input) {
    if (!input) return null;
    try {
        const abs = path.resolve(input);
        if (!fs.existsSync(abs)) return null;
        const real = fs.realpathSync(abs);
        const inside = ALLOWED_RESUME_ROOTS.some(root => {
            const prefix = root.endsWith(path.sep) ? root : root + path.sep;
            return real === root || real.startsWith(prefix);
        });
        return inside ? real : null;
    } catch {
        return null;
    }
}

// ===== Express middlewares =====

// Bootstrap: accept ?t=<token>, set cookie, redirect to clean URL.
// All other paths require either a valid cookie OR a valid ?t param.
function bootstrap(req, res, next) {
    if (req.method === 'GET' && req.path === '/' && req.query.t) {
        if (safeEqual(req.query.t, TOKEN)) {
            // Mark the cookie `secure` only over HTTPS (direct, or behind a
            // TLS reverse proxy that sets X-Forwarded-Proto) — the docs
            // recommend fronting this with TLS.
            const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
            res.cookie(COOKIE_NAME, TOKEN, { httpOnly: true, sameSite: 'strict', secure: isHttps });
            return res.redirect('/');
        }
        metrics.counters.auth_failures_total++;
        log.warn('auth.bootstrap_bad_token', { ip: req.ip, path: req.path });
        return res.status(401).send('Invalid token.');
    }
    next();
}

// Auth gate — applies to everything except the unauthorized page itself.
function authGate(req, res, next) {
    if (hasValidAuth(req)) return next();
    metrics.counters.auth_failures_total++;
    log.warn('auth.missing_cookie', { method: req.method, path: req.path });
    // Self-contained page: an unauthenticated client can't fetch /style.css
    // (this same gate blocks it), so the styles live in an inline <style>
    // block with classes rather than inline style="" attributes.
    res.status(401).type('text/html').send(
        '<html><head><style>' +
        '.unauth-body{font-family:sans-serif;padding:40px;max-width:600px}' +
        '.unauth-cmd{background:#eee;padding:10px;border-radius:4px}' +
        '</style></head><body class="unauth-body">' +
        '<h2>Unauthorized</h2>' +
        '<p>This server requires a loopback token. Open the URL shown in the server console:</p>' +
        '<pre class="unauth-cmd">npm start</pre>' +
        '<p>Copy the printed <code>http://&hellip;/?t=&lt;token&gt;</code> URL into your browser. ' +
        'A cookie will be set so subsequent visits work without the token.</p>' +
        '</body></html>'
    );
}

// API requests: Origin check on top of the auth cookie.
// - GET/HEAD: reject if Origin is *present and not whitelisted* (browser CSRF).
// - POST/PUT/PATCH/DELETE: Origin must be present AND whitelisted. Reject a
//   missing Origin too, since a non-browser caller (curl/native app) on the
//   same machine could otherwise piggyback on the auth cookie.
function originGate(req, res, next) {
    if (!originRequiredForMethod(req)) {
        metrics.counters.origin_blocked_total++;
        log.warn('origin.missing_on_mutating', { method: req.method, path: req.path });
        return res.status(403).json({ error: 'origin header required for state-changing requests' });
    }
    if (!originAllowed(req)) {
        metrics.counters.origin_blocked_total++;
        log.warn('origin.not_allowed', { method: req.method, path: req.path, origin: req.headers.origin });
        return res.status(403).json({ error: 'origin not allowed' });
    }
    next();
}

module.exports = {
    parseCookies, safeEqual, hasValidAuth,
    originAllowed, originAllowedForWs, originRequiredForMethod,
    rateLimit, safeResumeCwd, resolveResumeCwd,
    bootstrap, authGate, originGate,
};

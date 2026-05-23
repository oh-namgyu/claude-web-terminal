'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const which = require('child_process').execSync;
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const { listSessions, createSession, stopSession, listResumableSessions, updateSessionMetadata, getSessionMetadata } = require('./lib/cc-sessions');
const log = require('./lib/log');

// Simple in-memory counters for /api/metrics. Reset on process restart;
// for cross-restart aggregation, scrape and forward to your own store.
const _bootTime = Date.now();
const _metrics = {
    requests_total: 0,
    auth_failures_total: 0,
    origin_blocked_total: 0,
    rate_limited_total: 0,
    sessions_created_total: 0,
    sessions_stopped_total: 0,
    ws_connections_total: 0,
    ws_active: 0,
};

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
const ALLOWED_ORIGINS = new Set([
    `http://${HOST}:${PORT}`,
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
]);

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

function hasValidAuth(req) {
    const cookies = parseCookies(req.headers.cookie);
    return cookies[COOKIE_NAME] === TOKEN;
}

// Browsers always set Origin on cross-origin WS upgrades; for top-level GETs
// from the address bar Origin can legitimately be absent. So we only enforce
// when Origin *is* present — and we always require a valid auth cookie too.
function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    return ALLOWED_ORIGINS.has(origin);
}

// State-changing requests must carry an Origin header. Browsers always do;
// curl / native apps usually don't — so a missing Origin on POST/PUT/PATCH/
// DELETE is a sign of a non-browser caller piggybacking on the auth cookie.
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
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
const RATE_LIMIT_PER_MIN = Math.max(1, parseInt(process.env.RATE_LIMIT_PER_MIN || '30', 10));
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
// We intentionally do NOT follow symlinks via realpath — the resolved logical
// path must already be a child of HOME so a malicious symlink that points to
// /etc still gets caught by the prefix check.
function safeResumeCwd(input) {
    if (!input) return null;
    try {
        const abs = path.resolve(input);
        const home = os.homedir();
        const homeNormalized = home.endsWith(path.sep) ? home : home + path.sep;
        if (abs !== home && !abs.startsWith(homeNormalized)) return null;
        if (!fs.existsSync(abs)) return null;
        return abs;
    } catch {
        return null;
    }
}
const CLAUDE_BIN = (() => {
    if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
    try { return which('which claude', { encoding: 'utf-8' }).trim() || 'claude'; }
    catch { return 'claude'; }
})();
const DEFAULT_CWD = process.env.DEFAULT_CWD || os.homedir();

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

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.json());

// Request counter on every incoming request (counts after express has parsed
// the URL but before any auth check, so failed-auth requests still register).
app.use((req, _res, next) => { _metrics.requests_total++; next(); });

// Bootstrap: accept ?t=<token>, set cookie, redirect to clean URL.
// All other paths require either a valid cookie OR a valid ?t param.
app.use((req, res, next) => {
    if (req.method === 'GET' && req.path === '/' && req.query.t) {
        if (req.query.t === TOKEN) {
            res.cookie(COOKIE_NAME, TOKEN, { httpOnly: true, sameSite: 'strict', secure: false });
            return res.redirect('/');
        }
        _metrics.auth_failures_total++;
        log.warn('auth.bootstrap_bad_token', { ip: req.ip, path: req.path });
        return res.status(401).send('Invalid token.');
    }
    next();
});

// Auth gate — applies to everything except the unauthorized page itself.
app.use((req, res, next) => {
    if (hasValidAuth(req)) return next();
    _metrics.auth_failures_total++;
    log.warn('auth.missing_cookie', { method: req.method, path: req.path });
    res.status(401).type('text/html').send(
        '<html><body style="font-family:sans-serif;padding:40px;max-width:600px">' +
        '<h2>Unauthorized</h2>' +
        '<p>This server requires a loopback token. Open the URL shown in the server console:</p>' +
        '<pre style="background:#eee;padding:10px;border-radius:4px">npm start</pre>' +
        '<p>Copy the printed <code>http://&hellip;/?t=&lt;token&gt;</code> URL into your browser. ' +
        'A cookie will be set so subsequent visits work without the token.</p>' +
        '</body></html>'
    );
});

// API requests: Origin check on top of the auth cookie.
// - GET/HEAD: reject if Origin is *present and not whitelisted* (browser CSRF).
// - POST/PUT/PATCH/DELETE: Origin must be present AND whitelisted. Reject a
//   missing Origin too, since a non-browser caller (curl/native app) on the
//   same machine could otherwise piggyback on the auth cookie.
app.use('/api/', (req, res, next) => {
    if (!originRequiredForMethod(req)) {
        _metrics.origin_blocked_total++;
        log.warn('origin.missing_on_mutating', { method: req.method, path: req.path });
        return res.status(403).json({ error: 'origin header required for state-changing requests' });
    }
    if (!originAllowed(req)) {
        _metrics.origin_blocked_total++;
        log.warn('origin.not_allowed', { method: req.method, path: req.path, origin: req.headers.origin });
        return res.status(403).json({ error: 'origin not allowed' });
    }
    next();
});

// `must-revalidate` forces the browser to re-check on every load, so a
// `git pull && npm start` doesn't leave the user staring at a cached UI.
app.use(express.static(path.join(__dirname, 'static'), {
    etag: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, must-revalidate'),
}));

app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

// Slash command palette — UI floating preview.
// Source: ~/.claude/commands/*.md frontmatter description
//       + hardcoded Claude Code builtins (subject to Anthropic CLI version drift).
const SLASH_COMMANDS_DIR = path.join(os.homedir(), '.claude', 'commands');
const BUILTIN_SLASH_COMMANDS = [
    { name: '/help',    description: 'Get help with using Claude Code' },
    { name: '/clear',   description: 'Clear the conversation context' },
    { name: '/init',    description: 'Initialize CLAUDE.md from the current codebase' },
    { name: '/cost',    description: 'Show token usage / cost summary' },
    { name: '/model',   description: 'Switch the active Claude model' },
    { name: '/config',  description: 'Open the configuration UI' },
    { name: '/compact', description: 'Compact the conversation to free context' },
    { name: '/export',  description: 'Export the current conversation' },
    { name: '/resume',  description: 'Resume a previous session' },
    { name: '/login',   description: 'Sign in to Anthropic' },
    { name: '/logout',  description: 'Sign out of Anthropic' },
    { name: '/add-dir', description: 'Add a working directory to the session' },
];
let _slashCache = null;
let _slashCacheAt = 0;
function listSlashCommands() {
    if (_slashCache && Date.now() - _slashCacheAt < 60000) return _slashCache;
    const user = [];
    try {
        const files = fs.readdirSync(SLASH_COMMANDS_DIR);
        for (const f of files) {
            if (!f.endsWith('.md')) continue;
            const name = '/' + f.replace(/\.md$/, '');
            let description = '';
            try {
                const content = fs.readFileSync(path.join(SLASH_COMMANDS_DIR, f), 'utf-8');
                const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
                if (m) {
                    const dm = m[1].match(/^description:\s*(.+)$/m);
                    if (dm) description = dm[1].trim();
                }
            } catch {}
            user.push({ name, description, source: 'user' });
        }
    } catch {}
    user.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    _slashCache = [
        ...BUILTIN_SLASH_COMMANDS.map(c => ({ ...c, source: 'builtin' })),
        ...user,
    ];
    _slashCacheAt = Date.now();
    return _slashCache;
}
app.get('/api/slash-commands', (_req, res) => {
    res.json({ commands: listSlashCommands() });
});

// Metrics — JSON snapshot of in-memory counters + uptime + active session
// count. Behind the same auth gate as everything else; loopback by default
// so this is safe to expose, but a downstream scraper still has to read the
// auth cookie.
app.get('/api/metrics', (_req, res) => {
    let sessionCounts = { bg: 0, interactive: 0 };
    try {
        const s = listSessions();
        sessionCounts = { bg: (s.bg || []).length, interactive: (s.interactive || []).length };
    } catch {}
    res.json({
        uptime_seconds: Math.floor((Date.now() - _bootTime) / 1000),
        boot_time_iso: new Date(_bootTime).toISOString(),
        counters: { ..._metrics },
        sessions_active: sessionCounts,
    });
});

app.get('/api/cc-sessions', (_req, res) => {
    try { res.json(listSessions()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// SSE channel for live session events. Survives background-tab throttling
// (the browser doesn't throttle incoming-byte handlers on open EventSource
// streams), so working→idle transitions reach the client immediately and
// the page can fire a Notification even when the panel is closed.
const _sseClients = new Set();
app.get('/api/cc-events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    _sseClients.add(res);
    const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 25000);
    req.on('close', () => { _sseClients.delete(res); clearInterval(ka); });
});

function _sseBroadcast(payload) {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of _sseClients) { try { c.write(line); } catch {} }
}

let _bgStatusPrev = {};
let _lastBusyKey = '';
setInterval(() => {
    if (_sseClients.size === 0) return;
    let bg, interactive;
    try { ({ bg = [], interactive = [] } = listSessions()); }
    catch { return; }

    // Notifications: only on bg sessions. Interactive sessions are
    // already in front of the user in another window/terminal, so the
    // toast would be noise.
    const seen = new Set();
    for (const s of bg) {
        seen.add(s.id);
        const prev = _bgStatusPrev[s.id];
        if (prev === 'busy' && s.status !== 'busy') {
            console.log(`[cwt] notify: ${s.id} busy → ${s.status}`);
            _sseBroadcast({
                type: 'idle',
                id: s.id,
                name: s.name || s.id.slice(0, 8),
                reason: s.status === 'waiting' ? 'needs input' : 'finished',
            });
        }
        if (prev !== undefined && prev !== s.status) {
            console.log(`[cwt] status: ${s.id.slice(0, 8)} ${prev} → ${s.status}`);
        }
        _bgStatusPrev[s.id] = s.status;
    }
    for (const id of Object.keys(_bgStatusPrev)) if (!seen.has(id)) delete _bgStatusPrev[id];

    // Busy indicator: cover bg + interactive so the user sees every Claude
    // turn that's still running, no matter where it was launched from.
    const toBusy = (kind) => (s) => ({
        id: s.id,
        kind,
        name: s.name || s.id.slice(0, 8),
        cwd: s.cwd || '',
        lastUser: (s.lastUser || '').slice(0, 120),
        lastAssistant: (s.lastAssistant || '').slice(0, 120),
        msgCount: s.msgCount || 0,
    });
    const busy = [
        ...bg.filter(s => s.status === 'busy').map(toBusy('bg')),
        ...interactive.filter(s => s.status === 'busy').map(toBusy('interactive')),
    ];
    const busyKey = JSON.stringify(busy);
    if (busyKey !== _lastBusyKey) {
        _lastBusyKey = busyKey;
        _sseBroadcast({ type: 'busy', sessions: busy });
    }
}, 2000);

app.post('/api/cc-sessions', async (req, res) => {
    if (!rateLimit(req)) {
        _metrics.rate_limited_total++;
        log.warn('rate.session_create', { limit: RATE_LIMIT_PER_MIN });
        return res.status(429).json({ error: `rate limited; max ${RATE_LIMIT_PER_MIN} sessions per minute` });
    }
    const prompt = (req.body && req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    try {
        const result = await createSession(prompt, ptyEnv(), DEFAULT_CWD, CLAUDE_BIN);
        _metrics.sessions_created_total++;
        log.info('session.created', { id: result.id });
        res.json(result);
    } catch (e) {
        log.error('session.create_failed', { err: e.message });
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/cc-sessions/:id', async (req, res) => {
    try {
        const result = await stopSession(req.params.id, ptyEnv(), CLAUDE_BIN);
        _metrics.sessions_stopped_total++;
        log.info('session.stopped', { id: req.params.id });
        res.json({ ok: true, ...result });
    } catch (e) {
        log.error('session.stop_failed', { id: req.params.id, err: e.message });
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/cc-resume-sessions', (_req, res) => {
    try { res.json(listResumableSessions()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Allowlist of writable metadata fields. Anything else in the body is
// silently dropped — keeps a hostile / buggy caller from polluting the
// shared session-metadata.json file.
const METADATA_FIELDS = {
    name: (v) => typeof v === 'string' && v.length <= 200,
    pinned: (v) => typeof v === 'boolean',
};

function _sanitizeMetadata(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const clean = {};
    for (const [k, validate] of Object.entries(METADATA_FIELDS)) {
        if (!(k in body)) continue;
        if (!validate(body[k])) return { _error: `invalid value for ${k}` };
        clean[k] = body[k];
    }
    return clean;
}

app.post('/api/cc-sessions/:id/metadata', (req, res) => {
    const id = req.params.id;
    if (!/^[a-f0-9-]{36}$|^[a-f0-9]{6,}$/i.test(id)) return res.status(400).json({ error: 'invalid id' });
    const clean = _sanitizeMetadata(req.body);
    if (!clean) return res.status(400).json({ error: 'body must be an object' });
    if (clean._error) return res.status(400).json({ error: clean._error });
    if (Object.keys(clean).length === 0) return res.status(400).json({ error: 'no allowed fields in body' });
    try {
        const meta = updateSessionMetadata(id, clean);
        res.json({ ok: true, metadata: meta });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/cc-sessions/:id/metadata', (req, res) => {
    const id = req.params.id;
    if (!/^[a-f0-9-]{36}$|^[a-f0-9]{6,}$/i.test(id)) return res.status(400).json({ error: 'invalid id' });
    try {
        const meta = getSessionMetadata(id);
        res.json(meta);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Manual WS upgrade so we can authenticate before allocating a pty.
server.on('upgrade', (req, socket, head) => {
    const ok = originAllowed(req) && hasValidAuth(req);
    if (!ok) {
        _metrics.auth_failures_total++;
        log.warn('ws.upgrade_unauth', { url: req.url, origin: req.headers.origin || '' });
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
    _metrics.ws_connections_total++;
    _metrics.ws_active++;
    ws.on('close', () => { _metrics.ws_active = Math.max(0, _metrics.ws_active - 1); });
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const attachId = url.searchParams.get('attach') || '';
    const resumeId = url.searchParams.get('resume') || '';
    const resumeCwd = url.searchParams.get('cwd') || '';
    // For resume sessions, use the original cwd if provided & safe.
    // For attach, always use DEFAULT_CWD.
    let cwd = DEFAULT_CWD;
    if (resumeId && resumeCwd) {
        const safe = safeResumeCwd(resumeCwd);
        if (safe) cwd = safe;
    }

    let term;
    try {
        term = pty.spawn('/bin/zsh', ['-l'], {
            name: 'xterm-256color',
            cols: 120,
            rows: 30,
            cwd,
            env: ptyEnv(),
        });
    } catch (e) {
        ws.send(`\r\nError spawning pty: ${e.message}\r\n`);
        ws.close();
        return;
    }

    let launchCmd = 'claude';
    if (attachId && /^[a-f0-9]+$/i.test(attachId)) {
        launchCmd = `claude attach ${attachId}`;
    } else if (resumeId && /^[a-f0-9-]+$/i.test(resumeId)) {
        launchCmd = `claude --resume ${resumeId}`;
    }
    setTimeout(() => term.write(launchCmd + '\r'), 500);

    term.onData(d => { if (ws.readyState === ws.OPEN) ws.send(d); });
    ws.on('message', d => term.write(d.toString()));
    ws.on('close', () => { try { term.kill(); } catch {} });
    term.onExit(() => { if (ws.readyState === ws.OPEN) ws.close(); });
});

server.listen(PORT, HOST, () => {
    log.info('boot', { host: HOST, port: PORT, default_cwd: DEFAULT_CWD,
                       token_hide: AUTH_TOKEN_HIDE, rate_limit_per_min: RATE_LIMIT_PER_MIN,
                       log_format: log.FORMAT });
    console.log('claude-web-terminal');
    console.log(`  Open this URL once to authenticate (token is set as a cookie):`);
    if (AUTH_TOKEN_HIDE) {
        const mask = TOKEN.slice(0, 4) + '…' + TOKEN.slice(-2);
        console.log(`  →  http://${HOST}:${PORT}/?t=${mask}   (AUTH_TOKEN_HIDE=true; full token suppressed)`);
    } else {
        console.log(`  →  http://${HOST}:${PORT}/?t=${TOKEN}`);
    }
    console.log('');
    console.log(`  default cwd: ${DEFAULT_CWD}`);
});

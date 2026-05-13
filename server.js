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

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '8765', 10);

// Loopback auth token — generated each start unless overridden via AUTH_TOKEN env.
// Must be presented as `?t=<token>` on first visit; server sets an httpOnly
// SameSite=strict cookie that is then sent automatically for subsequent
// requests and the WebSocket upgrade.
const TOKEN = process.env.AUTH_TOKEN || crypto.randomBytes(24).toString('base64url');
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

// Bootstrap: accept ?t=<token>, set cookie, redirect to clean URL.
// All other paths require either a valid cookie OR a valid ?t param.
app.use((req, res, next) => {
    if (req.method === 'GET' && req.path === '/' && req.query.t) {
        if (req.query.t === TOKEN) {
            res.cookie(COOKIE_NAME, TOKEN, { httpOnly: true, sameSite: 'strict', secure: false });
            return res.redirect('/');
        }
        return res.status(401).send('Invalid token.');
    }
    next();
});

// Auth gate — applies to everything except the unauthorized page itself.
app.use((req, res, next) => {
    if (hasValidAuth(req)) return next();
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

// API requests: extra Origin check on top of the auth cookie.
app.use('/api/', (req, res, next) => {
    if (!originAllowed(req)) return res.status(403).json({ error: 'origin not allowed' });
    next();
});

app.use(express.static(path.join(__dirname, 'static')));

app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
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
setInterval(() => {
    if (_sseClients.size === 0) return;
    let bg;
    try { ({ bg = [] } = listSessions()); }
    catch { return; }
    const seen = new Set();
    for (const s of bg) {
        seen.add(s.id);
        const prev = _bgStatusPrev[s.id];
        if (prev === 'working' && s.status === 'idle') {
            _sseBroadcast({ type: 'idle', id: s.id, name: s.name || s.id.slice(0, 8) });
        }
        _bgStatusPrev[s.id] = s.status;
    }
    for (const id of Object.keys(_bgStatusPrev)) if (!seen.has(id)) delete _bgStatusPrev[id];
}, 2000);

app.post('/api/cc-sessions', async (req, res) => {
    const prompt = (req.body && req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    try {
        const result = await createSession(prompt, ptyEnv(), DEFAULT_CWD, CLAUDE_BIN);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/cc-sessions/:id', async (req, res) => {
    try {
        const result = await stopSession(req.params.id, ptyEnv(), CLAUDE_BIN);
        res.json({ ok: true, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/cc-resume-sessions', (_req, res) => {
    try { res.json(listResumableSessions()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cc-sessions/:id/metadata', (req, res) => {
    const id = req.params.id;
    if (!/^[a-f0-9-]{36}$|^[a-f0-9]{6,}$/i.test(id)) return res.status(400).json({ error: 'invalid id' });
    try {
        const meta = updateSessionMetadata(id, req.body);
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
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const attachId = url.searchParams.get('attach') || '';
    const resumeId = url.searchParams.get('resume') || '';
    const resumeCwd = url.searchParams.get('cwd') || '';
    // For resume sessions, use the original cwd if provided & safe.
    // For attach, always use DEFAULT_CWD.
    let cwd = DEFAULT_CWD;
    if (resumeId && resumeCwd) {
        // Basic safety: cwd must exist and be under /Users or /home
        if ((resumeCwd.startsWith('/Users/') || resumeCwd.startsWith('/home/')) &&
            fs.existsSync(resumeCwd)) {
            cwd = resumeCwd;
        }
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
    console.log('claude-web-terminal');
    console.log(`  Open this URL once to authenticate (token is set as a cookie):`);
    console.log(`  →  http://${HOST}:${PORT}/?t=${TOKEN}`);
    console.log('');
    console.log(`  default cwd: ${DEFAULT_CWD}`);
});

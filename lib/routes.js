'use strict';

// All HTTP API route handlers + the SSE event channel and its background
// poller. server.js calls registerRoutes(app) after the auth/origin gates and
// static middleware are mounted.

const fs = require('fs');
const os = require('os');
const path = require('path');

const log = require('./log');
const metrics = require('./metrics');
const { rateLimit, safeResumeCwd } = require('./auth');
const {
    listSessions, createSession, stopSession,
    updateSessionMetadata, getSessionMetadata, isValidMetadataId,
} = require('./cc-sessions');
const { listResumeSessions, demoResumeSessions } = require('./resume-sessions');
const {
    DEFAULT_CWD, CLAUDE_BIN, CWD_ROOTS, RATE_LIMIT_PER_MIN, RESUME_BROWSER, ptyEnv,
} = require('./config');

// ===== Slash command palette =====
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

// ===== cwd dropdown options =====
// devs/ and docs/ get an extra level since each child is usually a project.
const _CWD_EXTRA_DEPTH = new Set(['devs', 'docs', 'repos', 'projects', 'code']);
let _cwdOptionsCache = null;
let _cwdOptionsAt = 0;
function listCwdOptions() {
    if (_cwdOptionsCache && Date.now() - _cwdOptionsAt < 60000) return _cwdOptionsCache;
    const out = [];
    for (const root of CWD_ROOTS) {
        if (!fs.existsSync(root)) continue;
        out.push({ path: root, label: root.replace(os.homedir(), '~'), isRoot: true });
        try {
            const children = fs.readdirSync(root, { withFileTypes: true });
            for (const d of children) {
                if (!d.isDirectory()) continue;
                if (d.name.startsWith('.') || d.name === 'node_modules') continue;
                const p = path.join(root, d.name);
                out.push({ path: p, label: p.replace(os.homedir(), '~'), isRoot: false });
                if (_CWD_EXTRA_DEPTH.has(d.name)) {
                    try {
                        const grand = fs.readdirSync(p, { withFileTypes: true });
                        for (const g of grand) {
                            if (!g.isDirectory()) continue;
                            if (g.name.startsWith('.') || g.name === 'node_modules') continue;
                            const gp = path.join(p, g.name);
                            out.push({ path: gp, label: gp.replace(os.homedir(), '~'), isRoot: false });
                        }
                    } catch {}
                }
            }
        } catch {}
    }
    _cwdOptionsCache = out;
    _cwdOptionsAt = Date.now();
    return _cwdOptionsCache;
}

// ===== File listing for the `@` palette =====
// gitignore-aware via simple skip-set. Capped at 1000 entries.
function listFiles(cwd, q) {
    const SKIP_DIRS = new Set(['node_modules', '.venv', 'venv', '.git', 'dist', 'build', '.next', '__pycache__', 'playwright-report', 'test-results']);
    const out = [];
    const MAX = 1000;
    // Hard cap on directory entries visited. A synchronous recursive walk over
    // a pathological tree (huge monorepo, symlink fan-out) would otherwise
    // block the event loop for seconds; stop early once we've inspected this
    // many nodes even if MAX results weren't reached.
    const MAX_VISITS = 20000;
    let visited = 0;
    let walkCapped = false;
    function walk(dir, relPrefix) {
        if (out.length >= MAX || visited >= MAX_VISITS) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
            if (out.length >= MAX) return;
            if (visited >= MAX_VISITS) { walkCapped = true; return; }
            visited++;
            if (e.name.startsWith('.') && e.name !== '.env.example') continue;
            if (SKIP_DIRS.has(e.name)) continue;
            const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
            if (e.isDirectory()) { walk(path.join(dir, e.name), rel); continue; }
            if (!e.isFile()) continue;
            if (q && !rel.toLowerCase().includes(q) && !e.name.toLowerCase().includes(q)) continue;
            out.push({ path: rel, name: e.name });
        }
    }
    walk(cwd, '');
    if (q) {
        out.sort((a, b) => {
            const aHit = a.name.toLowerCase().startsWith(q) ? 0 : 1;
            const bHit = b.name.toLowerCase().startsWith(q) ? 0 : 1;
            if (aHit !== bHit) return aHit - bHit;
            return a.path.localeCompare(b.path);
        });
    }
    return { files: out.slice(0, 200), total: out.length, capped: out.length >= MAX || walkCapped };
}

// ===== SSE channel for live session events =====
// Survives background-tab throttling (the browser doesn't throttle
// incoming-byte handlers on open EventSource streams), so working→idle
// transitions reach the client immediately and the page can fire a
// Notification even when the panel is closed.
const _sseClients = new Set();
function _sseBroadcast(payload) {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of _sseClients) { try { c.write(line); } catch {} }
}

let _bgStatusPrev = {};
let _lastBusyKey = '';
function _pollSessions() {
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
}

// ===== Metadata write allowlist =====
// Anything else in the body is silently dropped — keeps a hostile / buggy
// caller from polluting the shared session-metadata.json file.
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

function registerRoutes(app) {
    app.get('/api/health', (_req, res) => {
        res.json({ ok: true });
    });

    app.get('/api/slash-commands', (_req, res) => {
        res.json({ commands: listSlashCommands() });
    });

    app.get('/api/cwd-options', (_req, res) => {
        res.json({ options: listCwdOptions(), default: DEFAULT_CWD });
    });

    // Warm cache at boot so the first dropdown open is instant (recursive
    // readdirSync over $HOME is ~100ms cold on macOS APFS).
    setImmediate(() => { try { listCwdOptions(); } catch {} });

    app.get('/api/files', (req, res) => {
        const reqCwd = String(req.query.cwd || '');
        const q = String(req.query.q || '').toLowerCase();
        const cwd = safeResumeCwd(reqCwd);
        if (!cwd) return res.status(400).json({ error: 'cwd not allowed' });
        const { files, total, capped } = listFiles(cwd, q);
        res.json({ cwd, files, total, capped });
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
            uptime_seconds: Math.floor((Date.now() - metrics.bootTime) / 1000),
            boot_time_iso: new Date(metrics.bootTime).toISOString(),
            counters: { ...metrics.counters },
            sessions_active: sessionCounts,
        });
    });

    app.get('/api/cc-sessions', (_req, res) => {
        try { res.json(listSessions()); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

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

    app.post('/api/cc-sessions', async (req, res) => {
        if (!rateLimit(req)) {
            metrics.counters.rate_limited_total++;
            log.warn('rate.session_create', { limit: RATE_LIMIT_PER_MIN });
            return res.status(429).json({ error: `rate limited; max ${RATE_LIMIT_PER_MIN} sessions per minute` });
        }
        const prompt = (req.body && req.body.prompt || '').trim();
        if (!prompt) return res.status(400).json({ error: 'prompt required' });
        try {
            const result = await createSession(prompt, ptyEnv(), DEFAULT_CWD, CLAUDE_BIN);
            metrics.counters.sessions_created_total++;
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
            metrics.counters.sessions_stopped_total++;
            log.info('session.stopped', { id: req.params.id });
            res.json({ ok: true, ...result });
        } catch (e) {
            log.error('session.stop_failed', { id: req.params.id, err: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    // Local session browser — Claude Code transcripts on this machine that
    // `claude --resume` can pick up, including sessions started elsewhere
    // (another terminal, an editor, a phone driving `claude remote-control`).
    // Preview text is returned to the caller but never logged.
    app.get('/api/cc/resume-sessions', (req, res) => {
        // RESUME_BROWSER=0 takes the feature off the wire entirely; the UI
        // reads the 404 as "no entry point".
        if (!RESUME_BROWSER) return res.status(404).json({ error: 'resume browser disabled' });
        // Demo mode serves fixtures and never touches a real transcript.
        if (String(req.query.demo || '') === '1') return res.json({ sessions: demoResumeSessions() });
        try {
            res.json({ sessions: listResumeSessions() });
        } catch (e) {
            log.error('resume.list_failed', { err: e.message });
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/cc-sessions/:id/metadata', (req, res) => {
        const id = req.params.id;
        if (!isValidMetadataId(id)) return res.status(400).json({ error: 'invalid id' });
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
        if (!isValidMetadataId(id)) return res.status(400).json({ error: 'invalid id' });
        try {
            const meta = getSessionMetadata(id);
            res.json(meta);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Background poller drives the SSE broadcasts.
    setInterval(_pollSessions, 2000);
}

module.exports = { registerRoutes };

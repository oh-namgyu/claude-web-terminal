'use strict';

// WebSocket terminal bridge: authenticate the upgrade before allocating a pty,
// then pipe a login zsh ↔ the browser. server.js calls attachWebSocket(server,
// wss) once the HTTP server and WebSocketServer are created.

const pty = require('node-pty');

const log = require('./log');
const metrics = require('./metrics');
const { originAllowedForWs, hasValidAuth, safeResumeCwd, resolveResumeCwd } = require('./auth');
const { findResumeSession, isResumeSessionId } = require('./resume-sessions');
const { PORT, DEFAULT_CWD, ptyEnv } = require('./config');

// Decide where a new pty starts and what it launches. Ids have already been
// format-checked by the caller. Returns { cwd, launchCmd } or { error } — on
// an error nothing is spawned and the socket is closed.
//
// The three cases resolve their cwd differently:
//   - attach : DEFAULT_CWD (attach reuses the original session's own cwd)
//   - resume : read back from the session transcript, never from the query
//              string, then re-validated against the allowed roots
//   - fresh  : ?cwd= if present and inside $HOME, else DEFAULT_CWD
function _resolveSpawn({ attachId, resumeId, reqCwd }) {
    if (attachId) return { cwd: DEFAULT_CWD, launchCmd: `claude attach ${attachId}` };
    if (resumeId) {
        // Re-resolved here at spawn time: the client sends an id and nothing
        // else, so a crafted `?cwd=` cannot steer where the pty lands.
        const session = findResumeSession(null, resumeId);
        if (!session) return { error: 'unknown resume session' };
        const cwd = resolveResumeCwd(session.cwd);
        if (!cwd) return { error: 'resume cwd not allowed' };
        return { cwd, launchCmd: `claude --resume ${resumeId}` };
    }
    const safe = reqCwd ? safeResumeCwd(reqCwd) : null;
    return { cwd: safe || DEFAULT_CWD, launchCmd: 'claude' };
}

function _handleConnection(ws, req) {
    metrics.counters.ws_connections_total++;
    metrics.counters.ws_active++;
    ws.on('close', () => { metrics.counters.ws_active = Math.max(0, metrics.counters.ws_active - 1); });
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const attachId = url.searchParams.get('attach') || '';
    const resumeId = url.searchParams.get('resume') || '';
    const reqCwd = url.searchParams.get('cwd') || '';
    // Strictly validate any supplied id — on a format mismatch reject
    // immediately rather than silently downgrading to a plain `claude`.
    // (The id is interpolated into a login-shell command, so a missing
    // check is a potential injection; block it before the pty spawn.)
    if (attachId && !/^[a-f0-9]+$/i.test(attachId)) { ws.close(1008, 'invalid attach id'); return; }
    // A resume id is a full session UUID — the id of a transcript on this
    // machine. Anything else is refused outright.
    if (resumeId && !isResumeSessionId(resumeId)) { ws.close(1008, 'invalid resume id'); return; }

    const { cwd, launchCmd, error } = _resolveSpawn({ attachId, resumeId, reqCwd });
    if (error) {
        // id only — a session preview must never reach the log.
        log.warn('ws.resume_rejected', { id: resumeId, reason: error });
        ws.close(1008, error);
        return;
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

    // Give the login shell time to settle before injecting the launch command.
    // Hold the timer so a ws close (→ term.kill) before it fires can't write
    // to a dead pty.
    let launchTimer = setTimeout(() => {
        launchTimer = null;
        try { term.write(launchCmd + '\r'); } catch {}
    }, 500);

    term.onData(d => { if (ws.readyState === ws.OPEN) ws.send(d); });
    ws.on('message', d => term.write(d.toString()));
    ws.on('close', () => {
        if (launchTimer) { clearTimeout(launchTimer); launchTimer = null; }
        try { term.kill(); } catch {}
    });
    term.onExit(() => { if (ws.readyState === ws.OPEN) ws.close(); });
}

function attachWebSocket(server, wss) {
    // Manual WS upgrade so we can authenticate before allocating a pty.
    server.on('upgrade', (req, socket, head) => {
        const ok = originAllowedForWs(req) && hasValidAuth(req);
        if (!ok) {
            metrics.counters.auth_failures_total++;
            log.warn('ws.upgrade_unauth', { url: req.url, origin: req.headers.origin || '' });
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    wss.on('connection', _handleConnection);
}

module.exports = { attachWebSocket };

'use strict';

// WebSocket terminal bridge: authenticate the upgrade before allocating a pty,
// then pipe a login zsh ↔ the browser. server.js calls attachWebSocket(server,
// wss) once the HTTP server and WebSocketServer are created.

const pty = require('node-pty');

const log = require('./log');
const metrics = require('./metrics');
const { originAllowedForWs, hasValidAuth, safeResumeCwd } = require('./auth');
const { PORT, DEFAULT_CWD, ptyEnv } = require('./config');

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
    if (resumeId && !/^[a-f0-9-]+$/i.test(resumeId)) { ws.close(1008, 'invalid resume id'); return; }
    // cwd resolution (in order):
    //   - attach: always DEFAULT_CWD (attach reuses the original session's cwd)
    //   - resume/fresh: ?cwd= if present and inside $HOME, else DEFAULT_CWD
    let cwd = DEFAULT_CWD;
    if (!attachId && reqCwd) {
        const safe = safeResumeCwd(reqCwd);
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

    let launchCmd = 'claude';                            // id already validated above (mismatch → rejected)
    if (attachId) launchCmd = `claude attach ${attachId}`;
    else if (resumeId) launchCmd = `claude --resume ${resumeId}`;
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

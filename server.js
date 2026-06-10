'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const log = require('./lib/log');
const metrics = require('./lib/metrics');
const { HOST, PORT, TOKEN, AUTH_TOKEN_HIDE, DEFAULT_CWD, RATE_LIMIT_PER_MIN } = require('./lib/config');
const { bootstrap, authGate, originGate } = require('./lib/auth');
const { registerRoutes } = require('./lib/routes');
const { attachWebSocket } = require('./lib/ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.json());

// Request counter on every incoming request (counts after express has parsed
// the URL but before any auth check, so failed-auth requests still register).
app.use((req, _res, next) => { metrics.counters.requests_total++; next(); });

// Bootstrap (?t=<token> → cookie) → auth gate → /api/ origin gate.
app.use(bootstrap);
app.use(authGate);
app.use('/api/', originGate);

// `must-revalidate` forces the browser to re-check on every load, so a
// `git pull && npm start` doesn't leave the user staring at a cached UI.
app.use(express.static(path.join(__dirname, 'static'), {
    etag: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache, must-revalidate'),
}));

registerRoutes(app);
attachWebSocket(server, wss);

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

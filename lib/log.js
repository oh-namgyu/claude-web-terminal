'use strict';

// Minimal structured logger. No deps. Two modes:
//   LOG_FORMAT=text (default) — human-readable single line, colorized timestamps
//   LOG_FORMAT=json           — one JSON object per line, suitable for jq /
//                                container log scrapers.
// LOG_LEVEL = debug|info|warn|error (default info). Anything below the
// configured level is silently dropped, so a noisy `debug` doesn't slow the
// hot path in production.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;
const FORMAT = String(process.env.LOG_FORMAT || 'text').toLowerCase();

function _format(level, event, fields, msg) {
    if (FORMAT === 'json') {
        return JSON.stringify({
            ts: new Date().toISOString(),
            level, event,
            ...fields,
            msg: msg || undefined,
        });
    }
    const ts = new Date().toISOString();
    const kv = Object.entries(fields || {}).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
    return `${ts} ${level.toUpperCase()} ${event}${kv ? ' ' + kv : ''}${msg ? ' — ' + msg : ''}`;
}

function _emit(level, event, fields, msg) {
    if ((LEVELS[level] || 0) < LEVEL) return;
    const line = _format(level, event, fields, msg);
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
}

module.exports = {
    debug: (event, fields, msg) => _emit('debug', event, fields, msg),
    info:  (event, fields, msg) => _emit('info',  event, fields, msg),
    warn:  (event, fields, msg) => _emit('warn',  event, fields, msg),
    error: (event, fields, msg) => _emit('error', event, fields, msg),
    LEVELS, LEVEL, FORMAT,
};

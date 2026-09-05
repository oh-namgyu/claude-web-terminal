'use strict';

// Decision logic for scripts/telegram-launcher.mjs.
//
// Everything here is pure or takes its side effects as injected callbacks, so
// the rules that matter — who is allowed to talk to the bot, what a message
// turns into, whether a recorded pid is still the process we started — can be
// tested without a bot token, a network, or a child process.
//
// No runtime dependencies: Node built-ins only.

const path = require('path');

// `stop`, `list` and `all` are the command vocabulary; a directory keyword may
// not shadow them or the grammar becomes ambiguous.
const RESERVED_WORDS = new Set(['stop', 'list', 'all']);
const KEYWORD_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// `ps -o lstart=` has one-second resolution, so two reads of the same process
// can differ by up to a second of rounding. Anything larger is a different
// process wearing a recycled pid.
const START_TIME_TOLERANCE_MS = 1000;

function expandHome(p, home) {
    if (p === '~') return home;
    if (p.startsWith('~/')) return path.join(home, p.slice(2));
    return p;
}

function _validateChatIds(raw, errors) {
    if (!Array.isArray(raw) || raw.length === 0) {
        errors.push('allowedChatIds must be a non-empty array');
        return [];
    }
    const out = [];
    for (const id of raw) {
        const n = typeof id === 'string' ? Number(id) : id;
        if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
            errors.push(`allowedChatIds entries must be integers, found ${JSON.stringify(id)}`);
            continue;
        }
        out.push(n);
    }
    return out;
}

function _validateKeywords(raw, errors, home, dirExists) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push('keywords must be an object of { keyword: directory }');
        return {};
    }
    const entries = Object.entries(raw);
    if (entries.length === 0) errors.push('keywords must contain at least one entry');
    const out = {};
    for (const [kw, dir] of entries) {
        if (!KEYWORD_RE.test(kw)) {
            errors.push(`keyword "${kw}" must match ${KEYWORD_RE}`);
            continue;
        }
        if (RESERVED_WORDS.has(kw)) {
            errors.push(`keyword "${kw}" is reserved (${[...RESERVED_WORDS].join(', ')})`);
            continue;
        }
        if (typeof dir !== 'string' || !dir.trim()) {
            errors.push(`keyword "${kw}" must map to a directory path`);
            continue;
        }
        const abs = path.resolve(expandHome(dir.trim(), home));
        if (!dirExists(abs)) {
            errors.push(`keyword "${kw}" maps to a directory that does not exist`);
            continue;
        }
        out[kw] = abs;
    }
    return out;
}

// Validate a parsed config file plus the permissions of the file it came from.
//   opts.mode      fs.Stats#mode, or null when the file could not be stat'ed
//   opts.insecure  true when --insecure-config was passed
//   opts.home      value used to expand a leading `~` in directory paths
//   opts.dirExists (absPath) => boolean
// Returns { ok, errors, config }. Errors never quote the bot token.
function validateConfig(raw, opts = {}) {
    const errors = [];
    const home = opts.home || '';
    const dirExists = opts.dirExists || (() => true);
    const mode = opts.mode === undefined ? null : opts.mode;

    // The file holds a bot token in clear text. A mode any other account on the
    // machine can read is a leaked token, so this is a refusal, not a warning.
    if (opts.insecure !== true) {
        if (mode === null) errors.push('config file permissions could not be read');
        else if ((mode & 0o777) !== 0o600) {
            const found = (mode & 0o777).toString(8).padStart(3, '0');
            errors.push(`config file must be mode 600, found ${found} — run chmod 600 on it (or pass --insecure-config)`);
        }
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push('config must be a JSON object');
        return { ok: false, errors, config: null };
    }
    if (typeof raw.botToken !== 'string' || !raw.botToken.trim()) {
        errors.push('botToken must be a non-empty string');
    }
    const allowedChatIds = _validateChatIds(raw.allowedChatIds, errors);
    const keywords = _validateKeywords(raw.keywords, errors, home, dirExists);

    if (errors.length) return { ok: false, errors, config: null };
    return {
        ok: true,
        errors,
        config: { botToken: raw.botToken.trim(), allowedChatIds, keywords },
    };
}

function keywordMenu(keywords) {
    const names = Object.keys(keywords).sort();
    return [
        `Keywords: ${names.join(', ') || '(none configured)'}`,
        'Commands: list · stop <keyword> · stop all',
    ].join('\n');
}

// ctx.running may be an array or a callback, so a batch of updates sees the
// state left behind by the updates before it.
function _running(ctx) {
    const r = typeof ctx.running === 'function' ? ctx.running() : ctx.running;
    return Array.isArray(r) ? r : [];
}

// One Telegram update → one action, or `ignore`.
//
// Actions deliberately carry only the keyword, never the message text: the
// caller logs actions, and a user's prompt is not ours to write to disk.
function decideAction(update, ctx) {
    const msg = update && update.message;
    const chat = msg && msg.chat;
    const chatId = chat && Number.isSafeInteger(chat.id) ? chat.id : null;
    const text = msg && typeof msg.text === 'string' ? msg.text : null;
    if (chatId === null || text === null) return { type: 'ignore', reason: 'no-text-message' };
    if (!ctx.allowedChatIds.includes(chatId)) return { type: 'ignore', reason: 'chat-not-allowed', chatId };

    const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const [head, arg] = words;

    if (words.length === 1 && head === 'list') {
        return { type: 'list', chatId, running: _running(ctx) };
    }
    if (words.length === 2 && head === 'stop') {
        if (arg === 'all') return { type: 'stop', chatId, keywords: _running(ctx) };
        if (Object.hasOwn(ctx.keywords, arg)) return { type: 'stop', chatId, keywords: [arg] };
        return { type: 'menu', chatId };
    }
    if (words.length === 1 && Object.hasOwn(ctx.keywords, head)) {
        return { type: 'spawn', chatId, keyword: head, cwd: ctx.keywords[head] };
    }
    return { type: 'menu', chatId };
}

// Drive one batch of updates.
//
// The offset is persisted BEFORE the update is acted on. That makes delivery
// at-most-once: if the process dies between the two, the command is lost and
// the user simply sends it again. The alternative ordering (act, then persist)
// would replay the command on restart and spawn a second `claude
// remote-control` for the same message — duplication is the worse failure for
// something that starts processes, so we take the loss.
async function processUpdates(updates, ctx, io) {
    let offset = null;
    for (const update of updates) {
        if (update && Number.isSafeInteger(update.update_id)) {
            offset = update.update_id + 1;
            await io.saveOffset(offset);
        }
        await io.perform(decideAction(update, ctx));
    }
    return offset;
}

// Parse one `ps -p <pid> -o lstart=,args=` line into { pid, startedAt, argv }.
// Returns null when the process is gone (empty output) or the line is not in
// the expected shape — both mean "cannot confirm", and every caller treats
// that as "do not kill".
const _PS_RE = /^\s*([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*?)\s*$/;
function parseProcessInfo(pid, psOutput) {
    const line = String(psOutput || '').split('\n').find((l) => l.trim());
    if (!line) return null;
    const m = _PS_RE.exec(line);
    if (!m) return null;
    const startedAt = Date.parse(m[1].replace(/\s+/g, ' '));
    if (!Number.isFinite(startedAt)) return null;
    return { pid, startedAt, argv: m[2].split(/\s+/) };
}

// Is the process currently holding this pid the one we recorded?
//
// Both sides come from the same `ps` fields, so start time and command line
// are compared like for like. A pid that was recycled since we wrote the
// record fails on one of them and is left alone.
//
// Residual race: the pid could still be recycled between this check and the
// kill(2) that follows. The replacement would belong to the same user on the
// same desktop, and closing the window properly needs pidfd/kqueue plumbing
// this tool does not justify — so the race is accepted, not fixed.
function pidRecordMatches(record, live) {
    if (!record || !live) return false;
    if (!Number.isSafeInteger(record.pid) || record.pid !== live.pid) return false;
    if (!Array.isArray(record.argv) || !Array.isArray(live.argv)) return false;
    if (record.argv.length !== live.argv.length) return false;
    if (record.argv.some((a, i) => a !== live.argv[i])) return false;
    if (!Number.isFinite(record.startedAt) || !Number.isFinite(live.startedAt)) return false;
    return Math.abs(record.startedAt - live.startedAt) <= START_TIME_TOLERANCE_MS;
}

// Single-instance guard. `wx` makes the create atomic; an existing lock is
// honoured only while its recorded pid is alive, so a launcher killed with
// SIGKILL does not lock the user out forever.
//
// Two launchers starting at the same instant could both find the same stale
// lock and both take it. A desktop helper started by hand does not warrant
// the flock(2) plumbing that would close that window.
function _lockHolder(fs, lockPath) {
    try { return parseInt(String(fs.readFileSync(lockPath, 'utf-8')).trim(), 10); }
    catch { return 0; }
}

function acquireLock({ lockPath, pid, fs, isAlive }) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.writeFileSync(lockPath, String(pid), { flag: 'wx' });
            return { ok: true };
        } catch (e) {
            if (e.code !== 'EEXIST') return { ok: false, error: e.message };
        }
        const holder = _lockHolder(fs, lockPath);
        if (Number.isSafeInteger(holder) && holder > 0 && holder !== pid && isAlive(holder)) {
            return { ok: false, heldBy: holder };
        }
        try { fs.unlinkSync(lockPath); } catch { /* raced with another release */ }
    }
    return { ok: false, error: 'lock file kept reappearing' };
}

function releaseLock({ lockPath, pid, fs }) {
    if (_lockHolder(fs, lockPath) !== pid) return false;
    try { fs.unlinkSync(lockPath); return true; }
    catch { return false; }
}

module.exports = {
    validateConfig, decideAction, processUpdates, keywordMenu,
    parseProcessInfo, pidRecordMatches, acquireLock, releaseLock, expandHome,
    RESERVED_WORDS, KEYWORD_RE, START_TIME_TOLERANCE_MS,
};

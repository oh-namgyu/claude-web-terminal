#!/usr/bin/env node
// Telegram → `claude remote-control` launcher (optional, standalone).
//
// Send a keyword to your own Telegram bot from your phone; this process, which
// runs on your desktop, starts `claude remote-control` in the directory that
// keyword maps to. The session's transcript lands in ~/.claude/projects like
// any other, so you can later open it in claude-web-terminal's 📂 local
// session browser and carry on at the keyboard.
//
// Not part of the web server: nothing in lib/ imports this, and the server
// runs perfectly well without it. Node built-ins only — no dependencies.
//
//   node scripts/telegram-launcher.mjs [--insecure-config] [--config <path>]
//
// Config: ~/.cwt-launcher/config.json, mode 600
//   { "botToken": "...", "allowedChatIds": [123], "keywords": { "blog": "~/projects/blog" } }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import {
    validateConfig, processUpdates, keywordMenu,
    parseProcessInfo, pidRecordMatches, acquireLock, releaseLock,
} from './lib/launcher-core.js';

const HOME = os.homedir();
const args = process.argv.slice(2);
const INSECURE = args.includes('--insecure-config');
const STATE_DIR = path.join(HOME, '.cwt-launcher');
const CONFIG_PATH = (() => {
    const i = args.indexOf('--config');
    return i !== -1 && args[i + 1] ? path.resolve(args[i + 1]) : path.join(STATE_DIR, 'config.json');
})();
const OFFSET_PATH = path.join(STATE_DIR, 'offset');
const LOCK_PATH = path.join(STATE_DIR, 'launcher.lock');
const PIDS_DIR = path.join(STATE_DIR, 'pids');
const LOGS_DIR = path.join(STATE_DIR, 'logs');

const POLL_TIMEOUT_S = 30;
const CHILD_ARGV = ['remote-control'];
// `ps` right after spawn can still show the pre-exec image. Settle first, so
// the signature we record is the one a later `ps` will produce.
const SPAWN_SETTLE_MS = 500;

// Logs carry action types, keywords and pids — never the bot token and never
// the text of a message.
function log(...parts) {
    console.log(`[cwt-launcher ${new Date().toISOString()}]`, ...parts);
}

// ===== Telegram =====
// The token is in the URL, so no error from here may ever quote it.
async function callApi(token, method, params, timeoutMs) {
    let res;
    try {
        res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(params),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (e) {
        // Only `.message` is ever printed, and it is built here — the cause is
        // carried for a debugger, never rendered into a log line.
        throw new Error(`telegram ${method} failed: ${e.name}`, { cause: e });
    }
    if (!res.ok) throw new Error(`telegram ${method} returned HTTP ${res.status}`);
    const body = await res.json();
    if (!body.ok) throw new Error(`telegram ${method} rejected the request`);
    return body.result;
}

// ===== State on disk =====
function readOffset() {
    try {
        const n = parseInt(fs.readFileSync(OFFSET_PATH, 'utf-8').trim(), 10);
        return Number.isSafeInteger(n) ? n : 0;
    } catch { return 0; }
}

// fsync'd: the at-most-once guarantee in processUpdates() is only worth
// anything if the offset has really reached the disk before we act.
function writeOffset(offset) {
    const fd = fs.openSync(OFFSET_PATH, 'w');
    try {
        fs.writeSync(fd, String(offset));
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
}

const pidFile = (keyword) => path.join(PIDS_DIR, `${keyword}.json`);

function readPidRecord(keyword) {
    try { return JSON.parse(fs.readFileSync(pidFile(keyword), 'utf-8')); }
    catch { return null; }
}

function liveProcess(pid) {
    try {
        const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,args='], {
            encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
        });
        return parseProcessInfo(pid, out);
    } catch { return null; }
}

// Keywords whose recorded process is still the process we started. A record
// that no longer matches is dropped here, so `list` never shows a ghost.
function runningKeywords() {
    const out = [];
    let files;
    try { files = fs.readdirSync(PIDS_DIR); } catch { return out; }
    for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const keyword = f.slice(0, -'.json'.length);
        const record = readPidRecord(keyword);
        if (record && pidRecordMatches(record, liveProcess(record.pid))) out.push(keyword);
        else try { fs.unlinkSync(pidFile(keyword)); } catch { /* already gone */ }
    }
    return out.sort();
}

// ===== Actions =====
function startSession(keyword, cwd) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const logPath = path.join(LOGS_DIR, `${keyword}.log`);
    const fd = fs.openSync(logPath, 'a');
    let child;
    try {
        child = spawn('claude', CHILD_ARGV, {
            cwd, detached: true, stdio: ['ignore', fd, fd],
        });
    } finally { fs.closeSync(fd); }
    child.unref();
    return { pid: child.pid, logPath };
}

async function recordSpawn(keyword, pid) {
    await sleep(SPAWN_SETTLE_MS);
    const live = liveProcess(pid);
    // No `ps` reading available: record what we know, and accept that a later
    // `stop` will refuse to kill it (refusing is the safe direction — the user
    // can always kill it by hand).
    const record = live || { pid, startedAt: Date.now(), argv: ['claude', ...CHILD_ARGV] };
    fs.mkdirSync(PIDS_DIR, { recursive: true });
    fs.writeFileSync(pidFile(keyword), JSON.stringify(record, null, 2));
    return record;
}

function stopSession(keyword) {
    const record = readPidRecord(keyword);
    if (!record) return `${keyword}: not running`;
    const live = liveProcess(record.pid);
    if (!pidRecordMatches(record, live)) {
        try { fs.unlinkSync(pidFile(keyword)); } catch { /* already gone */ }
        return `${keyword}: not stopped — the recorded process is gone or no longer matches`;
    }
    // Detached children lead their own process group, so the negative pid takes
    // the whole tree down. Falls back to the single pid if the group is gone.
    try { process.kill(-record.pid, 'SIGTERM'); }
    catch {
        try { process.kill(record.pid, 'SIGTERM'); }
        catch { return `${keyword}: could not signal pid ${record.pid}`; }
    }
    try { fs.unlinkSync(pidFile(keyword)); } catch { /* already gone */ }
    return `stopped ${keyword}`;
}

function makePerformer(config, reply) {
    return async function perform(action) {
        switch (action.type) {
            case 'ignore':
                if (action.reason === 'chat-not-allowed') log('ignored update from chat outside the allowlist');
                return;
            case 'spawn': {
                if (runningKeywords().includes(action.keyword)) {
                    await reply(action.chatId, `${action.keyword} is already running`);
                    return;
                }
                const { pid, logPath } = startSession(action.keyword, action.cwd);
                const record = await recordSpawn(action.keyword, pid);
                log('spawned', action.keyword, 'pid', record.pid);
                await reply(action.chatId, `started ${action.keyword} (pid ${record.pid})\nlog: ${logPath}`);
                return;
            }
            case 'stop': {
                if (!action.keywords.length) { await reply(action.chatId, 'nothing running'); return; }
                const lines = action.keywords.map(stopSession);
                log('stop', action.keywords.join(','));
                await reply(action.chatId, lines.join('\n'));
                return;
            }
            case 'list': {
                const running = action.running;
                await reply(action.chatId, running.length ? `running: ${running.join(', ')}` : 'nothing running');
                return;
            }
            default:
                await reply(action.chatId, keywordMenu(config.keywords));
        }
    };
}

// ===== Startup =====
function loadConfig() {
    let raw = null;
    let mode = null;
    try {
        mode = fs.statSync(CONFIG_PATH).mode;
        raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (e) {
        console.error(`cannot read ${CONFIG_PATH}: ${e.code || e.name}`);
        process.exit(2);
    }
    const { ok, errors, config } = validateConfig(raw, {
        mode, insecure: INSECURE, home: HOME,
        dirExists: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    });
    if (!ok) {
        console.error(`invalid config (${CONFIG_PATH}):`);
        for (const e of errors) console.error(`  - ${e}`);
        process.exit(2);
    }
    return config;
}

async function main() {
    if (args.includes('--help') || args.includes('-h')) {
        console.log('usage: node scripts/telegram-launcher.mjs [--config <path>] [--insecure-config]');
        return;
    }
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const config = loadConfig();

    const lock = acquireLock({
        lockPath: LOCK_PATH, pid: process.pid, fs,
        isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
    });
    if (!lock.ok) {
        console.error(lock.heldBy
            ? `another launcher is already running (pid ${lock.heldBy})`
            : `could not take the lock: ${lock.error}`);
        process.exit(3);
    }
    const cleanup = () => { releaseLock({ lockPath: LOCK_PATH, pid: process.pid, fs }); };
    process.on('exit', cleanup);
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => { cleanup(); process.exit(0); });
    }

    const reply = (chatId, text) => callApi(config.botToken, 'sendMessage', { chat_id: chatId, text }, 15_000)
        .catch((e) => log('reply failed:', e.message));
    const ctx = {
        allowedChatIds: config.allowedChatIds,
        keywords: config.keywords,
        running: runningKeywords,
    };
    const io = { saveOffset: writeOffset, perform: makePerformer(config, reply) };

    let offset = readOffset();
    log(`listening — ${Object.keys(config.keywords).length} keyword(s), ${config.allowedChatIds.length} allowed chat(s)`);
    for (;;) {
        let updates;
        try {
            updates = await callApi(config.botToken, 'getUpdates',
                { offset, timeout: POLL_TIMEOUT_S }, (POLL_TIMEOUT_S + 10) * 1000);
        } catch (e) {
            log(e.message, '— retrying in 5s');
            await sleep(5000);
            continue;
        }
        const next = await processUpdates(updates, ctx, io);
        if (next !== null) offset = next;
    }
}

main().catch((e) => { console.error(`launcher failed: ${e.message}`); process.exit(1); });

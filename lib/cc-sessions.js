'use strict';

// Claude Code session discovery & control.
//
// All paths used here are undocumented internal details of the Claude Code
// CLI (tested against v2.1.140). If you upgrade Claude Code and the panel
// breaks, this is the file to update.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const UID = process.getuid ? process.getuid() : 501;
const CC_DAEMON_ROOT = `/tmp/cc-daemon-${UID}`;
const CC_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const CC_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const _transcriptCache = new Map();

function _slugCwd(cwd) {
    return cwd.replace(/[/.]/g, '-');
}

function _isProcessAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function _liveJobIds() {
    const ids = new Set();
    if (!fs.existsSync(CC_DAEMON_ROOT)) return ids;
    for (const d of fs.readdirSync(CC_DAEMON_ROOT)) {
        const rvDir = path.join(CC_DAEMON_ROOT, d, 'rv');
        if (!fs.existsSync(rvDir)) continue;
        for (const f of fs.readdirSync(rvDir)) {
            if (f.endsWith('.sock')) ids.add(f.replace(/\.sock$/, ''));
        }
    }
    return ids;
}

function _readTranscriptPreview(filepath) {
    try {
        const st = fs.statSync(filepath);
        const cached = _transcriptCache.get(filepath);
        if (cached && cached.mtimeMs === st.mtimeMs) return cached.info;
        const lines = fs.readFileSync(filepath, 'utf-8').split('\n').filter(Boolean);
        let lastAssistant = '', lastUser = '', branch = '', msgCount = 0;
        let inputTokens = 0, outputTokens = 0;
        for (const line of lines) {
            let d;
            try { d = JSON.parse(line); } catch { continue; }
            const msg = d.message || {};
            const content = msg.content || d.content || '';
            let text = '';
            if (Array.isArray(content)) {
                for (const c of content) if (c && c.type === 'text') { text = c.text || ''; break; }
            } else if (typeof content === 'string') text = content;
            if (d.gitBranch) branch = d.gitBranch;
            if (d.type === 'assistant') {
                msgCount++;
                if (text && !text.startsWith('<')) lastAssistant = text;
                const u = msg.usage || {};
                inputTokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
                outputTokens += (u.output_tokens || 0);
            } else if (d.type === 'user') {
                if (text && !text.startsWith('<') && !text.startsWith('local-command')) lastUser = text;
            }
        }
        const info = {
            lastAssistant: lastAssistant.slice(0, 160),
            lastUser: lastUser.slice(0, 160),
            branch,
            msgCount,
            tokens: { input: inputTokens, output: outputTokens },
        };
        _transcriptCache.set(filepath, { mtimeMs: st.mtimeMs, info });
        return info;
    } catch {
        return null;
    }
}

function listSessions() {
    const live = _liveJobIds();
    const bg = [], interactive = [];
    if (!fs.existsSync(CC_SESSIONS_DIR)) return { bg, interactive };
    for (const f of fs.readdirSync(CC_SESSIONS_DIR)) {
        if (!f.endsWith('.json')) continue;
        let meta;
        try { meta = JSON.parse(fs.readFileSync(path.join(CC_SESSIONS_DIR, f), 'utf-8')); }
        catch { continue; }
        let preview = null;
        if (meta.sessionId && meta.cwd) {
            const tp = path.join(CC_PROJECTS_DIR, _slugCwd(meta.cwd), meta.sessionId + '.jsonl');
            if (fs.existsSync(tp)) preview = _readTranscriptPreview(tp);
        }
        const base = {
            cwd: meta.cwd || '',
            status: meta.status || 'unknown',
            updatedAt: meta.updatedAt || meta.startedAt || 0,
            lastAssistant: preview ? preview.lastAssistant : '',
            lastUser: preview ? preview.lastUser : '',
            branch: preview ? preview.branch : '',
            msgCount: preview ? preview.msgCount : 0,
            tokens: preview ? preview.tokens : null,
            entrypoint: meta.entrypoint || '',
        };
        if (meta.kind === 'bg' && meta.jobId) {
            if (!live.has(meta.jobId)) continue;
            bg.push({ id: meta.jobId, name: meta.name || '(untitled)', kind: 'bg', ...base });
        } else if (meta.kind === 'interactive') {
            if (!_isProcessAlive(meta.pid)) continue;
            const nameFb = preview && preview.lastUser
                ? preview.lastUser
                : (meta.sessionId ? meta.sessionId.slice(0, 8) : '(interactive)');
            interactive.push({
                id: meta.sessionId || '',
                pid: meta.pid,
                name: meta.name || nameFb,
                kind: 'interactive',
                ...base,
            });
        }
    }
    bg.sort((a, b) => b.updatedAt - a.updatedAt);
    interactive.sort((a, b) => b.updatedAt - a.updatedAt);
    return { bg, interactive };
}

function createSession(prompt, env, cwd, claudeBin = 'claude') {
    return new Promise((resolve, reject) => {
        const proc = spawn(claudeBin, ['--bg', prompt], {
            env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '', err = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.stderr.on('data', d => { err += d.toString(); });
        const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 15000);
        proc.on('exit', () => {
            clearTimeout(timer);
            const m = out.match(/backgrounded\s*[·•]\s*([a-f0-9]{6,})/i);
            if (m) resolve({ id: m[1], output: out });
            else reject(new Error(`no session id in output. stdout=${out} stderr=${err}`));
        });
        proc.on('error', reject);
    });
}

function stopSession(id, env, claudeBin = 'claude') {
    return new Promise((resolve, reject) => {
        if (!/^[a-f0-9]{6,}$/i.test(id)) return reject(new Error('invalid session id'));
        execFile(claudeBin, ['stop', id], { env, timeout: 10000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`${err.message} stderr=${stderr}`));
            resolve({ output: stdout });
        });
    });
}

module.exports = { listSessions, createSession, stopSession };

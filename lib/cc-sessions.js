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

// Extract cwd from the first events in a jsonl transcript. Slug→cwd reverse
// lookup is unreliable (both `.` and `/` map to `-`), so we read it directly.
function _cwdFromTranscript(filepath) {
    try {
        const fd = fs.openSync(filepath, 'r');
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const m = buf.slice(0, n).toString('utf-8').match(/"cwd":"([^"]+)"/);
        if (m && fs.existsSync(m[1])) return m[1];
    } catch {}
    return '';
}

// Decode a slug like `-Users-alice-doe-programs-devs-redacted-project` back to a
// real path. Slugging maps both `/` and `.` (and `-`) to `-`, so at each
// token boundary we try both `/` (new segment) and `-` (extend last
// segment) and verify the final path exists. Backtracking is bounded by
// token count (typically ≤10).
function _cwdFromSlug(slug) {
    const tokens = slug.replace(/^-/, '').split('-');
    if (!tokens.length) return '';
    function dfs(i, acc) {
        if (i === tokens.length) return fs.existsSync(acc) ? acc : null;
        const withSlash = acc + '/' + tokens[i];
        const r1 = dfs(i + 1, withSlash);
        if (r1) return r1;
        if (acc !== '') {
            const r2 = dfs(i + 1, acc + '-' + tokens[i]);
            if (r2) return r2;
        }
        return null;
    }
    return dfs(1, '/' + tokens[0]) || '';
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
        // Walk back to the last meaningful event so we can flag interactive
        // sessions that are still mid-turn — CC only updates the metadata
        // 'status' field for bg sessions, so for interactive we look at
        // whether the last non-meta event was a user message (= awaiting
        // model response).
        let lastEventType = '';
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const d = JSON.parse(lines[i]);
                if (d.type === 'user' || d.type === 'assistant') { lastEventType = d.type; break; }
            } catch { continue; }
        }
        const info = {
            lastAssistant: lastAssistant.slice(0, 160),
            lastUser: lastUser.slice(0, 160),
            branch,
            msgCount,
            tokens: { input: inputTokens, output: outputTokens },
            lastEventType,
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
        // Promote 'unknown'/'idle' to 'busy' when the transcript shows the
        // last event was a user message — that means the model hasn't
        // responded yet. Only do this for interactive sessions; bg
        // sessions get a reliable status from the daemon.
        let status = meta.status || 'unknown';
        if (meta.kind === 'interactive' && preview && preview.lastEventType === 'user'
            && (status === 'unknown' || status === 'idle')) {
            status = 'busy';
        }
        const base = {
            cwd: meta.cwd || '',
            status,
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

function listResumableSessions() {
    // Build sessionId → cwd map from active sessions
    const sessionCwdMap = {};
    if (fs.existsSync(CC_SESSIONS_DIR)) {
        for (const f of fs.readdirSync(CC_SESSIONS_DIR)) {
            if (!f.endsWith('.json')) continue;
            try {
                const meta = JSON.parse(fs.readFileSync(path.join(CC_SESSIONS_DIR, f), 'utf-8'));
                if (meta.sessionId && meta.cwd) sessionCwdMap[meta.sessionId] = meta.cwd;
            } catch {}
        }
    }

    const all = [];
    if (!fs.existsSync(CC_PROJECTS_DIR)) return all;
    for (const cwdSlug of fs.readdirSync(CC_PROJECTS_DIR)) {
        const projDir = path.join(CC_PROJECTS_DIR, cwdSlug);
        if (!fs.statSync(projDir).isDirectory()) continue;
        for (const f of fs.readdirSync(projDir)) {
            if (!f.endsWith('.jsonl')) continue;
            const sessionId = f.replace(/\.jsonl$/, '');
            const filepath = path.join(projDir, f);
            try {
                const st = fs.statSync(filepath);
                const cached = _transcriptCache.get(filepath);
                const cwd = sessionCwdMap[sessionId] || _cwdFromTranscript(filepath) || _cwdFromSlug(cwdSlug) || '';
                if (cached && cached.mtimeMs === st.mtimeMs) {
                    const info = cached.info;
                    all.push({
                        id: sessionId, cwd, lastAssistant: info.lastAssistant,
                        lastUser: info.lastUser, branch: info.branch, msgCount: info.msgCount,
                        tokens: info.tokens, updatedAt: st.mtimeMs,
                    });
                    continue;
                }
                const preview = _readTranscriptPreview(filepath);
                if (preview) {
                    all.push({
                        id: sessionId, cwd, lastAssistant: preview.lastAssistant,
                        lastUser: preview.lastUser, branch: preview.branch, msgCount: preview.msgCount,
                        tokens: preview.tokens, updatedAt: st.mtimeMs,
                    });
                }
            } catch {}
        }
    }
    all.sort((a, b) => b.updatedAt - a.updatedAt);
    return all;
}

const METADATA_FILE = path.join(os.homedir(), '.claude', 'session-metadata.json');

function _loadMetadata() {
    try {
        if (fs.existsSync(METADATA_FILE)) {
            return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
        }
    } catch {}
    return {};
}

function _saveMetadata(meta) {
    const dir = path.dirname(METADATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(METADATA_FILE, JSON.stringify(meta, null, 2), 'utf-8');
}

function updateSessionMetadata(sessionId, metadata) {
    const all = _loadMetadata();
    all[sessionId] = { ...all[sessionId], ...metadata };
    _saveMetadata(all);
    return all[sessionId];
}

function getSessionMetadata(sessionId) {
    const all = _loadMetadata();
    return all[sessionId] || {};
}

module.exports = {
    listSessions, createSession, stopSession, listResumableSessions,
    updateSessionMetadata, getSessionMetadata,
    _cwdFromTranscript, _cwdFromSlug, CC_PROJECTS_DIR,
};

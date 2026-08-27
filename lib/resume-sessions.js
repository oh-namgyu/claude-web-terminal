'use strict';

// Local Claude Code session discovery for the resume browser.
//
// Claude Code writes one JSONL transcript per session to
//     <claudeDir>/projects/<encoded-cwd-dir>/<sessionId>.jsonl
// (shape verified against Claude Code v2.1.227). The directory name is a
// LOSSY encoding of the session's working directory — `/` and `.` both
// collapse to `-` — so it can never be decoded back reliably. Every record
// carries the real `cwd`, and that is the only value this module trusts.
//
// Discovery is best-effort by design: a transcript that is empty, truncated,
// unparseable or shaped differently is skipped in silence. One malformed file
// on disk must never turn the listing into an error.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { RESUME_PREVIEW } = require('./config');

// Read only the tail of each transcript. A long session is several megabytes
// and everything we need (the newest cwd, the last user message, the session
// id) is at the end.
const TAIL_BYTES = 256 * 1024;
const MAX_SESSIONS = 50;
const PREVIEW_MAX_CHARS = 120;

// Transcript file names are full session UUIDs. Anything else in the projects
// tree (editor backups, exports, hand-copied files) is not ours to resume.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isResumeSessionId(id) {
    return typeof id === 'string' && UUID_RE.test(id);
}

function defaultClaudeDir() {
    return path.join(os.homedir(), '.claude');
}

// Last TAIL_BYTES of a file as text. A non-zero start offset almost always
// lands mid-record, so the first (partial) line is dropped rather than being
// counted as corrupt input.
function _readTail(filepath, size) {
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(filepath, 'r');
    try { fs.readSync(fd, buf, 0, len, start); }
    finally { fs.closeSync(fd); }
    const text = buf.toString('utf-8');
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl === -1 ? '' : text.slice(nl + 1);
}

// Text of a transcript record. `message.content` is either a plain string or
// an array of typed blocks; only the first text block is of interest here.
function _messageText(rec) {
    const msg = rec.message || {};
    const content = msg.content !== undefined ? msg.content : rec.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        for (const c of content) {
            if (c && c.type === 'text' && typeof c.text === 'string') return c.text;
        }
    }
    return '';
}

// Single-line, control-character-free, hard-capped preview text.
function _cleanPreview(text) {
    // eslint-disable-next-line no-control-regex
    const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return flat.slice(0, PREVIEW_MAX_CHARS);
}

// Parse one transcript tail into a listing entry, or return null if the file
// is not a resumable session. Rejection is deliberate and silent for: an
// empty file, a tail with no parseable records, a transcript whose records
// claim a different sessionId than the file name (a copy or a rename — the
// id we would hand to `claude --resume` is not the one inside), and a
// transcript with no user message at all.
function _readSession(filepath, id, st, wantPreview) {
    if (!st.isFile() || st.size === 0) return null;
    let text;
    try { text = _readTail(filepath, st.size); }
    catch { return null; }

    let cwd = '';
    let lastUserText = '';
    let msgCount = 0;
    let sawOwnId = false;

    for (const line of text.split('\n')) {
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); }
        catch { continue; }
        if (!rec || typeof rec !== 'object') continue;
        if (typeof rec.sessionId === 'string') {
            if (rec.sessionId.toLowerCase() !== id.toLowerCase()) return null;
            sawOwnId = true;
        }
        // Newest record wins: a session that moved keeps its latest cwd.
        if (typeof rec.cwd === 'string' && rec.cwd) cwd = rec.cwd;
        if (rec.type === 'user' || rec.type === 'assistant') msgCount++;
        if (rec.type === 'user' && !rec.isMeta) {
            const t = _messageText(rec);
            // `<...>` payloads are CLI-internal wrappers (command output,
            // system reminders), not something a person typed.
            if (t && !t.startsWith('<')) lastUserText = t;
        }
    }

    if (!sawOwnId || !lastUserText) return null;
    return {
        id,
        cwd,
        preview: wantPreview ? _cleanPreview(lastUserText) : '',
        updatedAt: st.mtimeMs,
        // Counted from the tail only, so a session longer than TAIL_BYTES
        // reports fewer messages than it really has. It is a rough "how big
        // is this conversation" hint, not a total.
        msgCount,
    };
}

// Every `<claudeDir>/projects/*/<uuid>.jsonl`, newest first. Only names and
// stats are touched here — file contents are read lazily by the callers so a
// capped listing never parses more transcripts than it returns.
function _candidateFiles(claudeDir) {
    const projectsDir = path.join(claudeDir, 'projects');
    const out = [];
    let dirs;
    try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); }
    catch { return out; }
    for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const dir = path.join(projectsDir, d.name);
        let files;
        try { files = fs.readdirSync(dir); }
        catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.jsonl')) continue;
            const id = f.slice(0, -'.jsonl'.length);
            if (!isResumeSessionId(id)) continue;
            const filepath = path.join(dir, f);
            let stat;
            try { stat = fs.statSync(filepath); }
            catch { continue; }
            out.push({ filepath, id, stat });
        }
    }
    out.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    return out;
}

// Up to MAX_SESSIONS resumable sessions, newest first.
// claudeDir defaults to ~/.claude and is injectable so tests can point at a
// fixture tree.
function listResumeSessions(claudeDir, opts = {}) {
    const dir = claudeDir || defaultClaudeDir();
    const wantPreview = opts.preview !== undefined ? opts.preview : RESUME_PREVIEW;
    const limit = opts.limit !== undefined ? opts.limit : MAX_SESSIONS;
    const out = [];
    for (const c of _candidateFiles(dir)) {
        const entry = _readSession(c.filepath, c.id, c.stat, wantPreview);
        if (entry) out.push(entry);
        if (out.length >= limit) break;
    }
    return out;
}

// One session by id, re-read from disk on every call — never cached. The
// listing a client is acting on may be seconds or hours old, so the spawn
// path resolves the id against what is on disk *now*, through the same
// validation and the same cwd extraction as listResumeSessions. The two can
// therefore never disagree about whether a session is resumable or where it
// lives. The MAX_SESSIONS cap is a display concern and is not applied here:
// an id that scrolled off the list is still resumable.
function findResumeSession(claudeDir, id, opts = {}) {
    if (!isResumeSessionId(id)) return null;
    const dir = claudeDir || defaultClaudeDir();
    const wantPreview = opts.preview !== undefined ? opts.preview : RESUME_PREVIEW;
    for (const c of _candidateFiles(dir)) {
        if (c.id.toLowerCase() !== id.toLowerCase()) continue;
        const entry = _readSession(c.filepath, c.id, c.stat, wantPreview);
        if (entry) return entry;
    }
    return null;
}

// Synthetic entries for demo mode (`?demo=1`). Demo mode must never touch a
// real transcript, so the route serves these instead of scanning claudeDir.
// Every value is an obvious placeholder, matching the client-side demo data
// used by the Agent View panel.
function demoResumeSessions() {
    const now = Date.now();
    return [
        { id: '00000000-0000-4000-8000-000000000001', cwd: '/path/to/demo-project', preview: '[Sample] fix login bug', updatedAt: now - 12 * 60000, msgCount: 24 },
        { id: '00000000-0000-4000-8000-000000000002', cwd: '/path/to/demo-project', preview: '[Sample] add pagination to the results table', updatedAt: now - 3 * 3600000, msgCount: 8 },
        { id: '00000000-0000-4000-8000-000000000003', cwd: '/path/to/another-repo', preview: '[Sample] why does the nightly job time out?', updatedAt: now - 26 * 3600000, msgCount: 41 },
    ];
}

module.exports = {
    listResumeSessions, findResumeSession, demoResumeSessions,
    isResumeSessionId, defaultClaudeDir,
    MAX_SESSIONS, PREVIEW_MAX_CHARS, TAIL_BYTES,
};

'use strict';

/* exported toggleResumePanel */
// Local session browser — lists the Claude Code transcripts this machine
// already has (including sessions started from another terminal, an editor,
// or a phone driving `claude remote-control`) and reopens one in a tab as
// `claude --resume <id>`.
//
// Same shape as the Agent View panel next door: the panel reuses the
// .agents-panel / .agent-card classes, and only one of the two is open at a
// time since they share the same slot on screen.

const _resumeIsDemo = new URLSearchParams(location.search).get('demo') === '1';
const _RESUME_API = '/api/cc/resume-sessions' + (_resumeIsDemo ? '?demo=1' : '');

// A session's identity on screen is the directory it ran in — that is what
// the user recognises, far more than a uuid.
function _resumeDirName(cwd) {
    if (!cwd) return '(unknown directory)';
    return cwd.split('/').filter(Boolean).pop() || cwd;
}

function _openResumeSession(s) {
    if (_resumeIsDemo) {
        alert('Demo mode — resuming is disabled. Open a real instance without ?demo=1.');
        return;
    }
    const detail = s.preview ? `\n\n"${s.preview}"` : '';
    if (!confirm(`Resume this session in a new tab?\n\n${_resumeDirName(s.cwd)}${detail}\n\nRuns: claude --resume ${s.id}`)) return;
    // Only the id travels to the server. It re-reads the session from disk and
    // decides the working directory itself.
    addTab({ resumeId: s.id });
    toggleResumePanel();
}

function _renderResumeCard(s) {
    const card = document.createElement('div');
    card.className = 'agent-card resumable';
    card.dataset.sessionId = s.id;
    card.dataset.updatedAt = String(s.updatedAt || 0);

    const name = document.createElement('div');
    name.className = 'agent-card-name';
    name.textContent = `📂 ${_resumeDirName(s.cwd)}`;
    card.appendChild(name);

    if (s.preview) {
        const preview = document.createElement('div');
        preview.className = 'agent-card-last';
        preview.title = s.preview;
        preview.textContent = `💬 ${s.preview}`;
        card.appendChild(preview);
    }

    const meta = document.createElement('div');
    meta.className = 'agent-card-meta';
    const idSpan = document.createElement('span');
    idSpan.className = 'agent-card-id';
    idSpan.textContent = (s.id || '').slice(0, 8);
    meta.appendChild(idSpan);
    if (s.cwd) {
        meta.append(' · ');
        const cwdSpan = document.createElement('span');
        cwdSpan.className = 'agent-card-cwd';
        cwdSpan.textContent = shortCwd(s.cwd);
        meta.appendChild(cwdSpan);
    }
    if (s.msgCount) meta.append(` · ${s.msgCount} msgs`);
    if (s.updatedAt) meta.append(` · ${_fmtAgo(s.updatedAt)}`);
    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'agent-card-actions';
    const resumeBtn = document.createElement('button');
    resumeBtn.textContent = '↪️ resume';
    resumeBtn.addEventListener('click', (e) => { e.stopPropagation(); _openResumeSession(s); });
    actions.appendChild(resumeBtn);
    card.appendChild(actions);

    card.addEventListener('click', () => _openResumeSession(s));
    return card;
}

async function loadResumeSessions() {
    const list = document.getElementById('resumeList');
    try {
        const r = await fetch(_RESUME_API);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { sessions = [] } = await r.json();
        list.replaceChildren();
        if (!sessions.length) {
            const empty = document.createElement('div');
            empty.className = 'agents-empty';
            empty.append(
                'No local sessions found.',
                document.createElement('br'), document.createElement('br'),
                'Sessions appear here once you have run ',
                Object.assign(document.createElement('code'), { textContent: 'claude' }),
                ' in a directory on this machine.',
            );
            list.appendChild(empty);
            return;
        }
        sessions.forEach(s => list.appendChild(_renderResumeCard(s)));
    } catch (e) {
        list.replaceChildren(Object.assign(document.createElement('div'),
            { className: 'agents-empty', textContent: 'Error: ' + e.message }));
    }
}

function toggleResumePanel() {
    const panel = document.getElementById('resumePanel');
    const agents = document.getElementById('agentsPanel');
    const opening = !panel.classList.contains('open');
    // Both panels occupy the same slot, so opening one closes the other.
    if (opening && agents.classList.contains('open')) toggleAgentsPanel();
    panel.classList.toggle('open', opening);
    if (opening) loadResumeSessions();
}

document.getElementById('resumeRefreshBtn').addEventListener('click', loadResumeSessions);
document.getElementById('resumeBtn').addEventListener('click', toggleResumePanel);

document.addEventListener('click', (e) => {
    const panel = document.getElementById('resumePanel');
    const sidebar = document.querySelector('.sidebar');
    if (!panel.classList.contains('open')) return;
    if (panel.contains(e.target) || (sidebar && sidebar.contains(e.target))) return;
    panel.classList.remove('open');
});

// The entry point stays hidden until the server answers: with RESUME_BROWSER=0
// the route 404s and no button ever appears.
(async function _initResumePanel() {
    try {
        const r = await fetch(_RESUME_API);
        if (!r.ok) return;
        document.getElementById('resumeBtn').hidden = false;
    } catch {}
})();

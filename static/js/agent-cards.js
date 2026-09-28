'use strict';

/* exported loadCCSessions */
// Session-card rendering for the Agent View panel. Split out of agent-panel.js
// (which keeps panel state, filtering, the busy bar, notifications, the
// new-session form and the attach/stop/pin actions). loadCCSessions is driven
// by agent-panel.js's polling; the builders here populate #agentsList.

function _fmtAgo(ms) {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
}

function _fmtTokens(t) {
    if (!t) return '';
    const total = (t.input || 0) + (t.output || 0);
    if (total < 1000) return total + 'tok';
    if (total < 1000000) return (total / 1000).toFixed(1) + 'k';
    return (total / 1000000).toFixed(1) + 'M';
}

function _createEditButton(sessionId, displayName) {
    const btn = document.createElement('button');
    btn.className = 'agent-card-edit-btn';
    btn.textContent = '✏️';
    btn.addEventListener('click', (e) => { e.stopPropagation(); openEditModal(sessionId, displayName); });
    return btn;
}

function _createPinButton(sessionId, isPinned) {
    const btn = document.createElement('button');
    btn.textContent = isPinned ? '⭐' : '☆';
    btn.title = isPinned ? 'Unpin session' : 'Pin session';
    btn.addEventListener('click', (e) => { e.stopPropagation(); togglePinSession(sessionId, !isPinned); });
    return btn;
}

function _createNameRow(displayText, sessionId, displayName) {
    const nameEl = document.createElement('div');
    nameEl.className = 'agent-card-name';
    nameEl.textContent = displayText;
    const row = document.createElement('div');
    row.className = 'agent-card-name-row';
    row.append(nameEl, _createEditButton(sessionId, displayName));
    return row;
}

function _sortByPinned(items, metadataMap) {
    return [...items].sort((a, b) => {
        const aPinned = metadataMap[a.id]?.pinned === true ? 1 : 0;
        const bPinned = metadataMap[b.id]?.pinned === true ? 1 : 0;
        if (aPinned !== bPinned) return bPinned - aPinned;
        return b.updatedAt - a.updatedAt;
    });
}

// `?demo=1` shows synthetic data (for screenshots). Every value is an obvious placeholder.
const _DEMO_DATA = {
    bg: [
        { id: 'demo-001', name: '[Sample] Task A', kind: 'bg', cwd: '/path/to/demo-project', status: 'working', updatedAt: Date.now() - 4 * 60000, lastAssistant: '[demo] Latest assistant response would appear here, wrapping to two lines if it is a longer message.', lastUser: '', branch: 'demo-branch', msgCount: 18, tokens: { input: 400000, output: 12000 }, entrypoint: 'cli' },
        { id: 'demo-002', name: '[Sample] Task B', kind: 'bg', cwd: '/path/to/demo-project', status: 'idle', updatedAt: Date.now() - 22 * 60000, lastAssistant: '[demo] Each card shows the auto-generated session name and the last assistant reply.', lastUser: '', branch: 'main', msgCount: 9, tokens: { input: 180000, output: 4200 }, entrypoint: 'cli' },
        { id: 'demo-003', name: '[Sample] Task C', kind: 'bg', cwd: '/path/to/another-repo', status: 'idle', updatedAt: Date.now() - 105 * 60000, lastAssistant: '[demo] Clicking ➕ new tab launches a new tab with `claude attach <id>`.', lastUser: '', branch: 'demo-branch', msgCount: 24, tokens: { input: 612000, output: 18900 }, entrypoint: 'cli' },
    ],
    interactive: [
        { id: 'demo-interactive-1', pid: 0, name: '[Sample] Interactive session', kind: 'interactive', cwd: '/path/to/demo-project', status: 'waiting', updatedAt: Date.now() - 8 * 60000, lastAssistant: '[demo] VS Code or shell-launched sessions appear here as read-only — they cannot be attached.', lastUser: '', branch: 'main', msgCount: 6, tokens: { input: 95000, output: 2100 }, entrypoint: 'claude-vscode' },
    ],
};

// Fetch the live session lists. Past (resumable) sessions are NOT here — they
// live in the 📂 local session browser (js/resume-panel.js), which reads
// /api/cc/resume-sessions. This panel only shows what is running right now.
async function _fetchSessionData(isDemo) {
    const { bg = [], interactive = [] } = isDemo ? _DEMO_DATA : await (await fetch('/api/cc-sessions')).json();
    if (!isDemo) _checkStatusTransitions(bg);
    return { bg, interactive };
}

// Preload metadata for the background sessions — fetched in parallel so a long
// session list doesn't serialize N round-trips.
async function _buildMetadataMap(bg) {
    const metadataMap = {};
    await Promise.all(bg.map(async ({ id }) => {
        try {
            metadataMap[id] = await fetch(`/api/cc-sessions/${id}/metadata`).then(r => r.json()).catch(() => ({}));
        } catch {}
    }));
    return metadataMap;
}

function _renderEmptyState(list) {
    const empty = document.createElement('div');
    empty.className = 'agents-empty';
    empty.append(
        'No active sessions.',
        document.createElement('br'), document.createElement('br'),
        'Click ',
        Object.assign(document.createElement('code'), { textContent: '➕' }),
        ' above to create a background session, or run ',
        Object.assign(document.createElement('code'), { textContent: 'claude --bg "<task>"' }),
        ' in any terminal.',
        document.createElement('br'), document.createElement('br'),
        'Past sessions live in the 📂 local session browser.',
    );
    list.appendChild(empty);
}

// Card scaffold: the outer element (class + dataset + tracking), the name row,
// and the optional last-assistant preview. The caller appends meta/actions.
function _buildCardBase(s, extraClass, displayText, displayName, metadataMap) {
    const card = document.createElement('div');
    const isPinned = metadataMap[s.id]?.pinned === true;
    card.className = 'agent-card' + extraClass + (isPinned ? ' pinned' : '');
    card.dataset.sessionId = s.id;
    card.dataset.updatedAt = String(s.updatedAt || 0);
    _lastRenderedCards.push(card);

    card.appendChild(_createNameRow(displayText, s.id, displayName));

    if (s.lastAssistant) {
        const last = document.createElement('div');
        last.className = 'agent-card-last';
        last.title = s.lastAssistant;
        last.textContent = `💬 ${s.lastAssistant}`;
        card.appendChild(last);
    }
    return { card, isPinned };
}

function _renderCardMeta(s) {
    const cwdShort = shortCwd(s.cwd);
    const branch = s.branch && s.branch !== 'HEAD' ? `@${s.branch}` : '';
    const meta = document.createElement('div');
    meta.className = 'agent-card-meta';
    const idSpan = document.createElement('span');
    idSpan.className = 'agent-card-id';
    idSpan.textContent = (s.id || '').slice(0, 12);
    meta.appendChild(idSpan);
    if (cwdShort) {
        meta.append(' · ');
        const cwdSpan = document.createElement('span');
        cwdSpan.className = 'agent-card-cwd';
        cwdSpan.textContent = cwdShort + branch;
        meta.appendChild(cwdSpan);
    }
    if (s.msgCount) meta.append(` · ${s.msgCount} msgs`);
    if (s.tokens) meta.append(` · ${_fmtTokens(s.tokens)}`);
    if (s.updatedAt) meta.append(` · ${_fmtAgo(s.updatedAt)}`);
    if (s.entrypoint) meta.append(` · ${s.entrypoint}`);
    return meta;
}

function _renderCard(s, attachable, metadataMap) {
    const status = s.status === 'busy' ? '⚙️'
        : s.status === 'waiting' ? '⏳'
        : s.status === 'idle' ? '⏸'
        : '●';
    const displayName = metadataMap[s.id]?.name || s.name;
    const { card, isPinned } = _buildCardBase(s, attachable ? '' : ' interactive',
        `${status} ${displayName}`, displayName, metadataMap);
    card.appendChild(_renderCardMeta(s));

    if (attachable) {
        const actions = document.createElement('div');
        actions.className = 'agent-card-actions';
        const newTabBtn = document.createElement('button');
        newTabBtn.textContent = '➕ new tab';
        newTabBtn.addEventListener('click', () => openSessionInNewTab(s.id));
        const curBtn = document.createElement('button');
        curBtn.textContent = '🔄 current';
        curBtn.addEventListener('click', () => openSessionInCurrentTab(s.id));
        const stopBtn = document.createElement('button');
        stopBtn.className = 'btn-danger';
        stopBtn.title = 'Stop session';
        stopBtn.textContent = '🗑';
        stopBtn.addEventListener('click', () => stopSession(s.id, s.name));
        actions.append(_createPinButton(s.id, isPinned), newTabBtn, curBtn, stopBtn);
        card.appendChild(actions);
    } else {
        const note = document.createElement('div');
        note.className = 'agent-card-readonly-note';
        note.textContent = 'read-only — interactive sessions cannot be attached from outside';
        card.appendChild(note);
    }
    return card;
}

function _renderSection(list, title, items, attachable, metadataMap) {
    if (!items.length) return;
    const section = document.createElement('div');
    section.className = 'agents-section';
    const t = document.createElement('div');
    t.className = 'agents-section-title';
    t.textContent = title;
    section.appendChild(t);
    _sortByPinned(items, metadataMap).forEach(s => section.appendChild(_renderCard(s, attachable, metadataMap)));
    list.appendChild(section);
}

async function loadCCSessions() {
    const list = document.getElementById('agentsList');
    try {
        const isDemo = new URLSearchParams(location.search).get('demo') === '1';
        const { bg, interactive } = await _fetchSessionData(isDemo);
        const metadataMap = await _buildMetadataMap(bg);
        list.replaceChildren();
        _lastRenderedCards = [];

        if (bg.length === 0 && interactive.length === 0) {
            _renderEmptyState(list);
            return;
        }
        _renderSection(list, '⚡ Background (attachable)', bg, true, metadataMap);
        _renderSection(list, '💬 Interactive (read-only)', interactive, false, metadataMap);
        _applyFilters();
    } catch (e) {
        list.replaceChildren(
            Object.assign(document.createElement('div'), { className: 'agents-empty', textContent: 'Error: ' + e.message })
        );
    }
}

'use strict';

// ===== Tabs (multi claude REPL) =====
const tabs = [];
let activeIdx = -1;
let nextTabId = 1;

function renderTabs() {
    const bar = document.getElementById('tabBar');
    bar.replaceChildren();
    tabs.forEach((t, i) => {
        const label = t.attachId ? `claude:${t.attachId.slice(0, 8)}`
                    : t.resumeId ? `📌${t.resumeId.slice(0, 8)}`
                    : `claude #${t.id}`;
        const div = document.createElement('div');
        div.className = 'tab' + (i === activeIdx ? ' active' : '');
        div.addEventListener('click', () => activateTab(t.id));
        const labelSpan = document.createElement('span');
        labelSpan.textContent = label;
        const xSpan = document.createElement('span');
        xSpan.className = 'x';
        xSpan.textContent = '×';
        xSpan.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
        div.append(labelSpan, xSpan);
        bar.appendChild(div);
    });
    const addBtn = document.createElement('button');
    addBtn.className = 'tab-add';
    addBtn.textContent = '+ tab';
    addBtn.addEventListener('click', () => addTab());
    bar.appendChild(addBtn);
}

function addTab(opts) {
    const tab = { id: nextTabId++, term: null, ws: null, fitAddon: null,
                   attachId: (opts && opts.attachId) || null,
                   resumeId: (opts && opts.resumeId) || null,
                   resumeCwd: (opts && opts.resumeCwd) || null };
    tabs.push(tab);
    activeIdx = tabs.length - 1;
    renderTabs();
    connectTab(tab);
}

function closeTab(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    const t = tabs[idx];
    t.closed = true;
    try { if (t.ws) t.ws.close(); } catch {}
    try { if (t.term) t.term.dispose(); } catch {}
    tabs.splice(idx, 1);
    if (!tabs.length) {
        activeIdx = -1;
        document.getElementById('terminal').innerHTML = '';
        renderTabs();
        return;
    }
    if (activeIdx >= tabs.length) activeIdx = tabs.length - 1;
    renderTabs();
    activateTab(tabs[activeIdx].id);
}

function activateTab(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    activeIdx = idx;
    const t = tabs[idx];
    const container = document.getElementById('terminal');
    container.innerHTML = '';
    if (t.term) {
        container.appendChild(t.term.element);
        t.fitAddon.fit();
        t.term.focus();
    } else {
        connectTab(t);
    }
    renderTabs();
}

function _wsQueryFor(tab) {
    if (tab.attachId) return `?attach=${encodeURIComponent(tab.attachId)}`;
    if (tab.resumeId) {
        let q = `?resume=${encodeURIComponent(tab.resumeId)}`;
        if (tab.resumeCwd) q += `&cwd=${encodeURIComponent(tab.resumeCwd)}`;
        return q;
    }
    return '';
}

function _scheduleReconnect(tab) {
    if (tab.closed) return;
    tab.reconnectAttempts = (tab.reconnectAttempts || 0) + 1;
    if (tab.reconnectAttempts > 5) {
        tab.term.write('\r\n\x1b[31m[reconnect failed — close & reopen tab]\x1b[0m\r\n');
        return;
    }
    const delay = Math.min(8000, 1000 * 2 ** (tab.reconnectAttempts - 1));
    tab.term.write(`\r\n\x1b[33m[reconnecting in ${delay / 1000}s… attempt ${tab.reconnectAttempts}/5]\x1b[0m\r\n`);
    setTimeout(() => { if (!tab.closed) _openWs(tab); }, delay);
}

function _openWs(tab) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    tab.ws = new WebSocket(`${proto}://${location.host}/${_wsQueryFor(tab)}`);
    tab.ws.onopen = () => {
        if (tab.reconnectAttempts) tab.term.write('\r\n\x1b[32m[reconnected]\x1b[0m\r\n');
        tab.reconnectAttempts = 0;
        tab.term.focus();
    };
    tab.ws.onmessage = e => tab.term.write(e.data);
    tab.ws.onclose = () => {
        if (tab.closed) return;
        tab.term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');
        _scheduleReconnect(tab);
    };
}

function connectTab(tab) {
    const container = document.getElementById('terminal');
    container.innerHTML = '';
    tab.term = new Terminal({
        theme: { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#4fc3f7' },
        fontFamily: 'Menlo, "Fira Code", monospace',
        fontSize: 14, cursorBlink: true,
    });
    tab.fitAddon = new FitAddon.FitAddon();
    tab.term.loadAddon(tab.fitAddon);
    tab.term.open(container);
    tab.fitAddon.fit();
    tab.reconnectAttempts = 0;
    tab.closed = false;

    _openWs(tab);
    tab.term.onData(data => {
        if (tab.ws && tab.ws.readyState === WebSocket.OPEN) tab.ws.send(data);
    });
}

window.addEventListener('resize', () => {
    if (activeIdx < 0) return;
    const t = tabs[activeIdx];
    if (t && t.fitAddon) t.fitAddon.fit();
});

// ===== Agent View panel =====
let _pollTimer = null;
let _lastRenderedCards = [];

function _ensurePolling() {
    const panel = document.getElementById('agentsPanel');
    const want = panel.classList.contains('open');
    if (want && !_pollTimer) {
        loadCCSessions();
        _pollTimer = setInterval(loadCCSessions, 3000);
    } else if (!want && _pollTimer) {
        clearInterval(_pollTimer); _pollTimer = null;
    }
}

function toggleAgentsPanel() {
    const panel = document.getElementById('agentsPanel');
    panel.classList.toggle('open');
    _ensurePolling();
}

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

let _activeDays = 0;

// Track status per session to detect working→idle transitions and notify.
const _prevStatus = {};
let _statusBaselineDone = false;

function _notifySessionIdle(s) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    const n = new Notification('Claude session idle', {
        body: `${s.name || s.id.slice(0, 8)} finished working`,
        tag: `cc-idle-${s.id}`,
    });
    n.onclick = () => { window.focus(); openSessionInNewTab(s.id); n.close(); };
}

function _checkStatusTransitions(bg) {
    // Kept for debug visibility only — the actual notification is fired
    // from the SSE handler so background-tab throttling can't drop it.
    const transitions = [];
    const seen = new Set();
    for (const s of bg) {
        seen.add(s.id);
        const prev = _prevStatus[s.id];
        if (prev !== undefined && prev !== s.status) {
            transitions.push(`${s.id.slice(0, 8)}: ${prev} → ${s.status}`);
        }
        _prevStatus[s.id] = s.status;
    }
    for (const id of Object.keys(_prevStatus)) if (!seen.has(id)) delete _prevStatus[id];
    if (transitions.length) console.debug('[cwt] status transitions:', transitions);
    _statusBaselineDone = true;
}

// Live event stream from server — survives background-tab throttling.
let _sse = null;
function _connectSSE() {
    if (_sse || typeof EventSource === 'undefined') return;
    _sse = new EventSource('/api/cc-events');
    _sse.onmessage = (e) => {
        try {
            const d = JSON.parse(e.data);
            if (d.type === 'idle') _notifySessionIdle({ id: d.id, name: d.name });
        } catch {}
    };
    _sse.onerror = () => { /* EventSource auto-reconnects */ };
}
_connectSSE();

function _applyFilters() {
    const q = (document.getElementById('agentsSearchInput').value || '').toLowerCase().trim();
    const cutoff = _activeDays > 0 ? Date.now() - _activeDays * 86400000 : 0;
    _lastRenderedCards.forEach(card => {
        let show = true;
        if (q) {
            const text = card.textContent.toLowerCase();
            const id = card.dataset.sessionId?.toLowerCase() || '';
            show = text.includes(q) || id.includes(q);
        }
        if (show && cutoff > 0) {
            const updated = parseInt(card.dataset.updatedAt || '0', 10);
            show = updated >= cutoff;
        }
        card.classList.toggle('hidden', !show);
    });
}

// `?demo=1` 쿼리로 합성 데이터 표시 (스크린샷용). 모든 값을 명백한 placeholder로 유지.
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

async function loadCCSessions() {
    const list = document.getElementById('agentsList');
    try {
        const isDemo = new URLSearchParams(location.search).get('demo') === '1';
        const { bg = [], interactive = [] } = isDemo ? _DEMO_DATA : await (await fetch('/api/cc-sessions')).json();
        if (!isDemo) _checkStatusTransitions(bg);
        const resumable = isDemo ? [] : await (await fetch('/api/cc-resume-sessions')).json().catch(() => []);

        // Preload metadata for all sessions
        const allIds = [...bg.map(s => s.id), ...resumable.map(s => s.id)];
        const metadataMap = {};
        for (const id of allIds) {
            try {
                metadataMap[id] = await fetch(`/api/cc-sessions/${id}/metadata`).then(r => r.json()).catch(() => ({}));
            } catch {}
        }
        list.replaceChildren();
        _lastRenderedCards = [];

        if (bg.length === 0 && interactive.length === 0) {
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
            );
            list.appendChild(empty);
            return;
        }
        const renderCard = (s, attachable) => {
            const status = (s.status === 'idle') ? '⏸' : (s.status === 'working') ? '⚙️' : '●';
            const cwdShort = s.cwd ? s.cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~').split('/').slice(-2).join('/') : '';
            const branch = s.branch && s.branch !== 'HEAD' ? `@${s.branch}` : '';
            const idShort = (s.id || '').slice(0, 12);

            const card = document.createElement('div');
            const isPinned = metadataMap[s.id]?.pinned === true;
            card.className = 'agent-card' + (attachable ? '' : ' interactive') + (isPinned ? ' pinned' : '');
            card.dataset.sessionId = s.id;
            card.dataset.updatedAt = String(s.updatedAt || 0);
            _lastRenderedCards.push(card);

            const displayName = metadataMap[s.id]?.name || s.name;
            card.appendChild(_createNameRow(`${status} ${displayName}`, s.id, displayName));

            if (s.lastAssistant) {
                const last = document.createElement('div');
                last.className = 'agent-card-last';
                last.title = s.lastAssistant;
                last.textContent = `💬 ${s.lastAssistant}`;
                card.appendChild(last);
            }

            const meta = document.createElement('div');
            meta.className = 'agent-card-meta';
            const idSpan = document.createElement('span');
            idSpan.className = 'agent-card-id';
            idSpan.textContent = idShort;
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
            card.appendChild(meta);

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
        };
        const renderSection = (title, items, attachable) => {
            if (!items.length) return;
            const section = document.createElement('div');
            section.className = 'agents-section';
            const t = document.createElement('div');
            t.className = 'agents-section-title';
            t.textContent = title;
            section.appendChild(t);
            _sortByPinned(items, metadataMap).forEach(s => section.appendChild(renderCard(s, attachable)));
            list.appendChild(section);
        };
        const renderResumableCard = (s) => {
            const idShort = (s.id || '').slice(0, 12);
            const branch = s.branch && s.branch !== 'HEAD' ? `@${s.branch}` : '';
            const card = document.createElement('div');
            const isPinned = metadataMap[s.id]?.pinned === true;
            card.className = 'agent-card resumable' + (isPinned ? ' pinned' : '');
            card.dataset.sessionId = s.id;
            card.dataset.updatedAt = String(s.updatedAt || 0);
            _lastRenderedCards.push(card);

            const displayName = metadataMap[s.id]?.name || `📌 ${idShort}`;
            card.appendChild(_createNameRow(displayName, s.id, displayName));

            if (s.lastAssistant) {
                const last = document.createElement('div');
                last.className = 'agent-card-last';
                last.title = s.lastAssistant;
                last.textContent = `💬 ${s.lastAssistant}`;
                card.appendChild(last);
            }

            const meta = document.createElement('div');
            meta.className = 'agent-card-meta';
            if (branch) meta.append(branch + ' · ');
            if (s.msgCount) meta.append(`${s.msgCount} msgs · `);
            if (s.tokens) meta.append(`${_fmtTokens(s.tokens)} · `);
            if (s.updatedAt) meta.append(_fmtAgo(s.updatedAt));
            if (meta.textContent.endsWith(' · ')) {
                meta.textContent = meta.textContent.slice(0, -3);
            }
            card.appendChild(meta);

            const actions = document.createElement('div');
            actions.className = 'agent-card-actions';
            const openBtn = document.createElement('button');
            openBtn.textContent = '↪️ resume';
            openBtn.addEventListener('click', (e) => { e.stopPropagation(); addTab({ resumeId: s.id, resumeCwd: s.cwd }); });
            actions.append(_createPinButton(s.id, isPinned), openBtn);
            card.appendChild(actions);

            card.addEventListener('click', () => {
                addTab({ resumeId: s.id, resumeCwd: s.cwd });
            });
            return card;
        };
        renderSection('⚡ Background (attachable)', bg, true);
        renderSection('💬 Interactive (read-only)', interactive, false);
        if (resumable.length > 0) {
            const section = document.createElement('div');
            section.className = 'agents-section';
            const t = document.createElement('div');
            t.className = 'agents-section-title';
            t.textContent = '📌 Past Sessions (resumable)';
            section.appendChild(t);
            _sortByPinned(resumable, metadataMap).forEach(s => section.appendChild(renderResumableCard(s)));
            list.appendChild(section);
        }
        _applyFilters();
    } catch (e) {
        list.replaceChildren(
            Object.assign(document.createElement('div'), { className: 'agents-empty', textContent: 'Error: ' + e.message })
        );
    }
}

function openSessionInNewTab(attachId) {
    addTab({ attachId });
}

function openSessionInCurrentTab(attachId) {
    if (activeIdx < 0) { addTab({ attachId }); return; }
    const t = tabs[activeIdx];
    if (t.ws) { t.ws.onclose = null; try { t.ws.close(); } catch {} }
    try { if (t.term) t.term.dispose(); } catch {}
    t.attachId = attachId;
    t.term = null; t.ws = null; t.fitAddon = null;
    connectTab(t);
    renderTabs();
}

async function stopSession(id, name) {
    if (!confirm(`Stop background session?\n\n${name}\n(${id})`)) return;
    try {
        const r = await fetch('/api/cc-sessions/' + encodeURIComponent(id), { method: 'DELETE' });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'failed');
        await loadCCSessions();
    } catch (e) {
        alert('Stop failed: ' + e.message);
    }
}

async function togglePinSession(id, pinned) {
    try {
        const r = await fetch(`/api/cc-sessions/${encodeURIComponent(id)}/metadata`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned })
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'failed');
        await loadCCSessions();
    } catch (e) {
        alert('Pin failed: ' + e.message);
    }
}

function openNewAgentForm() {
    document.getElementById('newAgentForm').hidden = false;
    document.getElementById('newAgentPrompt').focus();
}
function closeNewAgentForm() {
    document.getElementById('newAgentForm').hidden = true;
    document.getElementById('newAgentPrompt').value = '';
}
async function submitNewAgent() {
    const prompt = document.getElementById('newAgentPrompt').value.trim();
    if (!prompt) return;
    const btns = document.querySelectorAll('.new-agent-actions button');
    btns.forEach(b => b.disabled = true);
    btns[0].textContent = 'Creating…';
    try {
        const r = await fetch('/api/cc-sessions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'failed');
        closeNewAgentForm();
        await loadCCSessions();
    } catch (e) {
        alert('Create failed: ' + e.message);
    } finally {
        btns.forEach(b => b.disabled = false);
        btns[0].textContent = 'Create';
    }
}

function _updateNotifyBtn() {
    const btn = document.getElementById('agentsNotifyBtn');
    if (!('Notification' in window)) { btn.disabled = true; btn.title = 'Notifications not supported'; return; }
    const perm = Notification.permission;
    const granted = perm === 'granted';
    btn.textContent = '🔔';
    btn.classList.toggle('active', granted);
    btn.classList.toggle('notify-off', !granted);
    btn.title = granted
        ? 'Notifications: ON — click to send a test toast'
        : perm === 'denied'
            ? 'Notifications: BLOCKED by browser — unblock in site settings'
            : 'Notifications: OFF — click to enable';
}

document.getElementById('agentsNotifyBtn').addEventListener('click', async () => {
    if (!('Notification' in window)) { alert('This browser does not support notifications.'); return; }
    if (Notification.permission === 'denied') {
        alert('Notifications are blocked by the browser. Re-enable them in your browser/OS settings, then reload.');
        return;
    }
    if (Notification.permission === 'default') {
        await Notification.requestPermission();
    } else if (Notification.permission === 'granted') {
        try {
            new Notification('claude-web-terminal', { body: 'Test notification — pipeline OK.', tag: 'cwt-test' });
        } catch (e) {
            alert('Notification.permission is "granted" but firing failed: ' + e.message);
        }
    }
    _updateNotifyBtn();
    _ensurePolling();
});
_updateNotifyBtn();
_ensurePolling();

const _IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const _MOD = _IS_MAC ? '⌘' : 'Ctrl';
document.getElementById('kbdT').textContent = `${_MOD} T`;
document.getElementById('kbdW').textContent = `${_MOD} W`;
document.getElementById('kbdK').textContent = `${_MOD} K`;
document.getElementById('kbdN').textContent = `${_MOD} 1 … ${_MOD} 9`;

const shortcutsModal = document.getElementById('shortcutsModal');
document.getElementById('agentsHelpBtn').addEventListener('click', () => { shortcutsModal.hidden = false; });
document.getElementById('shortcutsModalClose').addEventListener('click', () => { shortcutsModal.hidden = true; });
shortcutsModal.addEventListener('click', (e) => { if (e.target === shortcutsModal) shortcutsModal.hidden = true; });

document.getElementById('agentsBtn').addEventListener('click', toggleAgentsPanel);
document.getElementById('agentsNewBtn').addEventListener('click', openNewAgentForm);
document.getElementById('agentsRefreshBtn').addEventListener('click', loadCCSessions);
document.getElementById('newAgentSubmitBtn').addEventListener('click', submitNewAgent);
document.getElementById('newAgentCancelBtn').addEventListener('click', closeNewAgentForm);

document.addEventListener('click', (e) => {
    const panel = document.getElementById('agentsPanel');
    const sidebar = document.querySelector('.sidebar');
    if (!panel.classList.contains('open')) return;
    if (panel.contains(e.target) || (sidebar && sidebar.contains(e.target))) return;
    panel.classList.remove('open');
    _ensurePolling();
});

// ===== IME-friendly input bar =====
const PASSTHROUGH_PREFIXES = ['/', '@', '#'];
const imeInput = document.getElementById('imeInput');
const imeMode = document.getElementById('imeMode');
const imeSend = document.getElementById('imeSend');

function sendToActive(data) {
    if (activeIdx < 0) return false;
    const t = tabs[activeIdx];
    if (!t || !t.ws || t.ws.readyState !== WebSocket.OPEN) return false;
    t.ws.send(data);
    return true;
}

function isPassthroughText(v) {
    return v.length > 0 && PASSTHROUGH_PREFIXES.includes(v[0]);
}

function updateImeMode() {
    const pass = isPassthroughText(imeInput.value);
    imeInput.classList.toggle('passthrough', pass);
    imeMode.classList.toggle('passthrough', pass);
    imeMode.textContent = pass ? 'passthrough' : 'buffered';
}

let _prevImeValue = '';

imeInput.addEventListener('input', (e) => {
    if (e.isComposing) { _prevImeValue = imeInput.value; updateImeMode(); return; }
    const cur = imeInput.value;
    if (isPassthroughText(cur) || isPassthroughText(_prevImeValue)) {
        if (cur.length >= _prevImeValue.length && cur.startsWith(_prevImeValue)) {
            const delta = cur.slice(_prevImeValue.length);
            if (delta) sendToActive(delta);
        } else if (cur.length < _prevImeValue.length && _prevImeValue.startsWith(cur)) {
            const n = _prevImeValue.length - cur.length;
            sendToActive('\x7f'.repeat(n));
        }
    }
    _prevImeValue = cur;
    updateImeMode();
});

imeInput.addEventListener('compositionend', () => {
    _prevImeValue = imeInput.value;
    updateImeMode();
});

imeInput.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const pass = isPassthroughText(imeInput.value);
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (pass) sendToActive('\r');
        else if (imeInput.value.length > 0) sendToActive(imeInput.value + '\r');
        imeInput.value = ''; _prevImeValue = ''; updateImeMode();
        return;
    }
    if (pass) {
        const map = { Escape: '\x1b', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B',
                      ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Tab: '\t' };
        const seq = map[e.key];
        if (seq !== undefined) {
            e.preventDefault();
            sendToActive(seq);
            if (e.key === 'Escape') {
                imeInput.value = ''; _prevImeValue = ''; updateImeMode();
            }
        }
    }
});

document.querySelectorAll('.model-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const m = btn.dataset.model;
        if (!m) return;
        if (!sendToActive(`/model ${m}\r`)) {
            alert('No active tab to switch model in.');
        }
    });
});

imeSend.addEventListener('click', () => {
    if (imeInput.value.length === 0) return;
    const pass = isPassthroughText(imeInput.value);
    if (pass) sendToActive('\r');
    else sendToActive(imeInput.value + '\r');
    imeInput.value = ''; _prevImeValue = ''; updateImeMode();
    imeInput.focus();
});

updateImeMode();

// ===== Session metadata edit modal =====
function openEditModal(sessionId, currentName) {
    const modal = document.getElementById('editSessionModal');
    document.getElementById('editSessionId').textContent = sessionId.slice(0, 12);
    document.getElementById('editSessionName').value = currentName;
    modal.hidden = false;
    document.getElementById('editSessionName').focus();
    modal._currentSessionId = sessionId;
}

function closeEditModal() {
    document.getElementById('editSessionModal').hidden = true;
}

document.getElementById('editModalClose').addEventListener('click', closeEditModal);
document.getElementById('editModalCancel').addEventListener('click', closeEditModal);
document.getElementById('editModalSave').addEventListener('click', async () => {
    const modal = document.getElementById('editSessionModal');
    const sessionId = modal._currentSessionId;
    const newName = document.getElementById('editSessionName').value.trim();
    if (!newName) {
        alert('Name cannot be empty');
        return;
    }
    try {
        await fetch(`/api/cc-sessions/${sessionId}/metadata`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
        });
        closeEditModal();
        await loadCCSessions();
    } catch (err) {
        alert('Save failed: ' + err.message);
    }
});

document.getElementById('editSessionName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('editModalSave').click();
    else if (e.key === 'Escape') closeEditModal();
});

document.getElementById('agentsSearchInput').addEventListener('input', _applyFilters);

// Global shortcuts: Cmd/Ctrl + (T new tab, W close tab, K focus search,
// 1-9 switch to nth tab). Skipped during IME composition so they don't
// fight Korean/Chinese/Japanese input.
document.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        addTab();
    } else if (e.key === 'w' || e.key === 'W') {
        if (activeIdx < 0) return;
        e.preventDefault();
        closeTab(tabs[activeIdx].id);
    } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        const panel = document.getElementById('agentsPanel');
        if (!panel.classList.contains('open')) toggleAgentsPanel();
        document.getElementById('agentsSearchInput').focus();
    } else if (/^[1-9]$/.test(e.key)) {
        const n = parseInt(e.key, 10) - 1;
        if (tabs[n]) { e.preventDefault(); activateTab(tabs[n].id); }
    }
});

document.querySelectorAll('.time-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.time-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _activeDays = parseInt(btn.dataset.days, 10) || 0;
        _applyFilters();
    });
});

// 데모 모드일 때는 실제 PTY 안 띄움 — 터미널 영역에 placeholder만 표시 (스크린샷에 zsh 프롬프트 노출 방지)
const _params = new URLSearchParams(location.search);
if (_params.get('demo') === '1') {
    const c = document.getElementById('terminal');
    c.innerHTML = '<div style="padding:24px;color:#8a93a6;font-family:ui-monospace,monospace;font-size:13px;line-height:1.6">' +
        '[demo mode]<br>' +
        '<br>' +
        'The terminal area would normally show an active <code>claude</code> REPL.<br>' +
        'Open a real instance without <code>?demo=1</code> to use the tool.' +
        '</div>';
    renderTabs();
} else {
    addTab();
}

// `?showAgents=1` 쿼리로 처음부터 패널 열기 (스크린샷·데모용)
if (_params.get('showAgents') === '1') {
    setTimeout(toggleAgentsPanel, 200);
}

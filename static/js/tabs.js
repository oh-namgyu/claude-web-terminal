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
    const newCwd = (opts && opts.newCwd) || (typeof currentCwd !== 'undefined' ? currentCwd : null);
    const tab = { id: nextTabId++, term: null, ws: null, fitAddon: null,
                   attachId: (opts && opts.attachId) || null,
                   resumeId: (opts && opts.resumeId) || null,
                   newCwd,
                   cwd: newCwd || null };
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
    // Resume sends the id and nothing else: the server re-reads the session
    // from disk and decides the working directory itself, so a cwd from the
    // client would be ignored anyway.
    if (tab.resumeId) return `?resume=${encodeURIComponent(tab.resumeId)}`;
    if (tab.newCwd) return `?cwd=${encodeURIComponent(tab.newCwd)}`;
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

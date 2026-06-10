'use strict';

/* exported _checkStatusTransitions, _applyFilters, openSessionInCurrentTab, stopSession, togglePinSession */
// These are consumed by agent-cards.js (and _applyFilters also by boot.js).

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

// Compress an absolute cwd to a short label: collapse the user's home prefix
// (/Users/<name> or /home/<name>) to `~`, then keep only the last two path
// segments. Shared by the busy tooltip and the agent cards.
function shortCwd(cwd) {
    if (!cwd) return '';
    return cwd
        .replace(/^\/Users\/[^/]+/, '~')
        .replace(/^\/home\/[^/]+/, '~')
        .split('/').slice(-2).join('/');
}

let _activeDays = 0;

// Track status per session to detect working→idle transitions and notify.
const _prevStatus = {};

function _notifySessionIdle(s) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (!_notifyUserEnabled()) return;
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
}

// Live event stream from server — survives background-tab throttling.
let _sse = null;
let _busySessions = [];

function _renderBusyBar() {
    const bar = document.getElementById('busyBar');
    const count = document.getElementById('busyCount');
    if (_busySessions.length === 0) { bar.hidden = true; return; }
    bar.hidden = false;
    count.textContent = _busySessions.length;
}

function _renderBusyTooltip() {
    const tip = document.getElementById('busyTooltip');
    tip.replaceChildren();
    for (const s of _busySessions) {
        const row = document.createElement('div');
        row.className = 'busy-tooltip-row';
        const name = document.createElement('div');
        name.className = 'busy-tooltip-name';
        const kindLabel = s.kind === 'interactive' ? '💬' : '⚡';
        name.textContent = `${kindLabel} ${s.name}`;
        row.appendChild(name);
        const msg = document.createElement('div');
        msg.className = 'busy-tooltip-msg';
        msg.textContent = s.lastUser ? `→ ${s.lastUser}` : s.lastAssistant ? `← ${s.lastAssistant}` : '(no message yet)';
        row.appendChild(msg);
        const meta = document.createElement('div');
        meta.className = 'busy-tooltip-meta';
        const cwdShort = shortCwd(s.cwd);
        meta.textContent = [s.id.slice(0, 8), cwdShort, s.msgCount ? `${s.msgCount} msgs` : ''].filter(Boolean).join(' · ');
        row.appendChild(meta);
        tip.appendChild(row);
    }
}

function _connectSSE() {
    if (_sse || typeof EventSource === 'undefined') return;
    _sse = new EventSource('/api/cc-events');
    _sse.onmessage = (e) => {
        try {
            const d = JSON.parse(e.data);
            if (d.type === 'idle') _notifySessionIdle({ id: d.id, name: d.name });
            else if (d.type === 'busy') { _busySessions = d.sessions || []; _renderBusyBar(); _renderBusyTooltip(); }
        } catch {}
    };
    _sse.onerror = () => { /* EventSource auto-reconnects */ };
}
_connectSSE();

// Hover the chip to expand the tooltip.
const _busyChip = document.getElementById('busyChip');
const _busyTip = document.getElementById('busyTooltip');
_busyChip.addEventListener('mouseenter', () => { if (_busySessions.length) _busyTip.hidden = false; });
_busyChip.addEventListener('mouseleave', () => { _busyTip.hidden = true; });

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

// Session-card rendering — the demo data, data-fetch helpers and all card /
// section builders (loadCCSessions and friends) — lives in agent-cards.js,
// loaded right after this file. This module keeps panel state, filtering, the
// busy bar, notifications, the new-session form and the session actions below.

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

function _notifyUserEnabled() {
    return localStorage.getItem('cwt.notify') !== 'off';
}

function _updateNotifyBtn() {
    const btn = document.getElementById('agentsNotifyBtn');
    if (!('Notification' in window)) { btn.disabled = true; btn.title = 'Notifications not supported'; return; }
    const perm = Notification.permission;
    const on = perm === 'granted' && _notifyUserEnabled();
    btn.textContent = '🔔';
    btn.classList.toggle('active', on);
    btn.classList.toggle('notify-off', !on);
    btn.title = perm === 'denied'
        ? 'Notifications: BLOCKED by browser — unblock in site settings'
        : perm === 'default'
            ? 'Notifications: OFF — click to grant permission'
            : on
                ? 'Notifications: ON — click to mute'
                : 'Notifications: MUTED — click to unmute';
}

document.getElementById('agentsNotifyBtn').addEventListener('click', async () => {
    if (!('Notification' in window)) { alert('This browser does not support notifications.'); return; }
    if (Notification.permission === 'denied') {
        alert('Notifications are blocked by the browser. Re-enable them in your browser/OS settings, then reload.');
        return;
    }
    if (Notification.permission === 'default') {
        await Notification.requestPermission();
        if (Notification.permission === 'granted') localStorage.setItem('cwt.notify', 'on');
    } else {
        // Granted — toggle the user-side mute flag.
        const muted = !_notifyUserEnabled();
        if (muted) {
            localStorage.setItem('cwt.notify', 'on');
            try {
                new Notification('claude-web-terminal', { body: 'Notifications ON — test toast.', tag: 'cwt-test' });
            } catch {}
        } else {
            localStorage.setItem('cwt.notify', 'off');
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

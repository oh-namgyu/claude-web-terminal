'use strict';

/* exported openEditModal */
// `openEditModal` is called from agent-panel.js (edit-button handler).

// ===== Send buttons, edit modal, global shortcuts & boot =====

imeSend.addEventListener('click', () => {
    if (imeInput.value.length === 0) return;
    sendToActive(imeInput.value + '\r');
    imeInput.value = ''; updateImeMode();
    imeInput.focus();
});

// bgSend — start a new background session with the current prompt.
// Stays in the foreground tab; user can open the Agent panel to see it.
const imeBgSend = document.getElementById('imeBgSend');
imeBgSend.addEventListener('click', async () => {
    const prompt = imeInput.value.trim();
    if (!prompt) { imeInput.focus(); return; }
    imeBgSend.disabled = true;
    const orig = imeBgSend.textContent;
    imeBgSend.textContent = '…';
    try {
        const r = await fetch('/api/cc-sessions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'failed');
        imeInput.value = ''; updateImeMode();
        const id = (data.id || '').slice(0, 8);
        if (('Notification' in window) && Notification.permission === 'granted' && _notifyUserEnabled()) {
            new Notification('Background session started', { body: id ? `id ${id}` : prompt.slice(0, 80), tag: `cwt-bgstart-${id || Date.now()}` });
        }
    } catch (e) {
        alert('bgSend failed: ' + e.message);
    } finally {
        imeBgSend.disabled = false;
        imeBgSend.textContent = orig;
        imeInput.focus();
    }
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

// Demo mode: don't spawn a real pty — show a placeholder in the terminal
// area instead (keeps the zsh prompt out of screenshots).
const _params = new URLSearchParams(location.search);
if (_params.get('demo') === '1') {
    const c = document.getElementById('terminal');
    c.innerHTML = '<div class="demo-placeholder">' +
        '[demo mode]<br>' +
        '<br>' +
        'The terminal area would normally show an active <code>claude</code> REPL.<br>' +
        'Open a real instance without <code>?demo=1</code> to use the tool.' +
        '</div>';
    renderTabs();
} else {
    addTab();
}

// `?showAgents=1` opens the panel on load (for screenshots / demos).
if (_params.get('showAgents') === '1') {
    setTimeout(toggleAgentsPanel, 200);
}

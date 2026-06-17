'use strict';

/* exported updateSlashPalette, movePaletteSel */
// These are driven from ime.js (input + keydown handlers).

// ===== Command palette — slash (/) and at (@) =====
// Triggered when imeInput starts with '/' or '@'. Body text is buffered so the
// CLI never sees per-keystroke; this palette gives back the live preview that
// the old passthrough mode used to provide.
//   '/' → /api/slash-commands (builtins + ~/.claude/commands/*.md)
//   '@' → /api/files?cwd=<currentCwd>&q=<query>
const slashPalette = document.getElementById('slashPalette');
let _slashCommandsCache = null;
let _slashCommandsFetched = 0;
let _paletteItems = [];
let _paletteIdx = -1;
let _atFetchAbort = null;

async function loadSlashCommands() {
    if (_slashCommandsCache && Date.now() - _slashCommandsFetched < 60000) return _slashCommandsCache;
    try {
        const r = await fetch('/api/slash-commands', { credentials: 'include' });
        if (!r.ok) return null;
        const j = await r.json();
        _slashCommandsCache = j.commands || [];
        _slashCommandsFetched = Date.now();
        return _slashCommandsCache;
    } catch { return null; }
}

async function loadFiles(cwd, q) {
    if (!cwd) return null;
    if (_atFetchAbort) { try { _atFetchAbort.abort(); } catch {} }
    _atFetchAbort = new AbortController();
    try {
        const url = `/api/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`;
        const r = await fetch(url, { credentials: 'include', signal: _atFetchAbort.signal });
        if (!r.ok) return null;
        const j = await r.json();
        return j.files || [];
    } catch { return null; }
}

function slashPaletteOpen() { return !slashPalette.classList.contains('hidden'); }

function hideSlashPalette() {
    slashPalette.classList.add('hidden');
    _paletteItems = [];
    _paletteIdx = -1;
}

function escHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

async function updateSlashPalette() {
    const v = imeInput.value;
    if (v.startsWith('/')) await renderSlashMode(v);
    else if (v.startsWith('@')) await renderAtMode(v);
    else hideSlashPalette();
}

async function renderSlashMode(v) {
    const cmds = await loadSlashCommands();
    if (!cmds) { hideSlashPalette(); return; }
    const firstToken = v.split(/\s+/)[0].slice(1).toLowerCase();
    const filtered = cmds.filter(c => c.name.slice(1).toLowerCase().startsWith(firstToken));
    if (!filtered.length) { hideSlashPalette(); return; }
    _paletteItems = filtered.slice(0, 20).map(c => ({
        token: c.name, label: c.name, sub: c.description || '', tag: c.source,
    }));
    _paletteIdx = 0;
    renderPaletteDOM();
}

async function renderAtMode(v) {
    const cwd = currentCwd || (cwdOptions[0] && cwdOptions[0].path) || '';
    if (!cwd) { hideSlashPalette(); return; }
    const q = v.split(/\s+/)[0].slice(1);
    const files = await loadFiles(cwd, q);
    if (!files || !files.length) { hideSlashPalette(); return; }
    _paletteItems = files.slice(0, 20).map(f => ({
        token: '@' + f.path, label: '@' + f.path, sub: '', tag: 'file',
    }));
    _paletteIdx = 0;
    renderPaletteDOM();
}

function renderPaletteDOM() {
    slashPalette.innerHTML = _paletteItems.map((it, i) => `
        <div class="slash-item${i === _paletteIdx ? ' sel' : ''}" data-i="${i}" role="option">
            <span class="slash-name">${escHtml(it.label)}</span>
            <span class="slash-desc">${escHtml(it.sub)}</span>
            <span class="slash-source">${escHtml(it.tag)}</span>
        </div>
    `).join('');
    slashPalette.classList.remove('hidden');
}

function movePaletteSel(delta) {
    if (!_paletteItems.length) return;
    _paletteIdx = (_paletteIdx + delta + _paletteItems.length) % _paletteItems.length;
    slashPalette.querySelectorAll('.slash-item').forEach((el, i) => el.classList.toggle('sel', i === _paletteIdx));
    const cur = slashPalette.querySelector('.slash-item.sel');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
}

function pickPaletteSel() {
    if (_paletteIdx < 0 || _paletteIdx >= _paletteItems.length) { hideSlashPalette(); return; }
    const it = _paletteItems[_paletteIdx];
    const rest = imeInput.value.split(/\s+/).slice(1).join(' ');
    imeInput.value = rest ? `${it.token} ${rest}` : `${it.token} `;
    updateImeMode();
    hideSlashPalette();
    imeInput.focus();
    imeInput.selectionStart = imeInput.selectionEnd = imeInput.value.length;
}

slashPalette.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.slash-item');
    if (!item) return;
    e.preventDefault();
    _paletteIdx = parseInt(item.dataset.i, 10);
    pickPaletteSel();
});

document.addEventListener('mousedown', (e) => {
    if (!slashPaletteOpen()) return;
    if (slashPalette.contains(e.target) || e.target === imeInput) return;
    hideSlashPalette();
});

// Prefetch immediately so the dropdown is ready before the user clicks it.
loadCwdOptions();
loadSlashCommands();

// ===== cwd picker — toolbar dropdown for working directory =====
let cwdOptions = [];
let currentCwd = null;
let _cwdFilter = '';
const cwdPicker = document.getElementById('cwdPicker');
const cwdMenu = document.getElementById('cwdMenu');
const cwdLabel = document.getElementById('cwdLabel');
const cwdSearch = document.getElementById('cwdSearch');
const cwdList = document.getElementById('cwdList');

async function loadCwdOptions() {
    if (cwdOptions.length) return cwdOptions;
    try {
        const r = await fetch('/api/cwd-options', { credentials: 'include' });
        if (!r.ok) return [];
        const j = await r.json();
        cwdOptions = j.options || [];
        if (!currentCwd && j.default) {
            const exact = cwdOptions.find(o => o.path === j.default);
            currentCwd = (exact && exact.path) || (cwdOptions[0] && cwdOptions[0].path) || null;
        }
        renderCwdMenu();
        updateCwdLabel();
        return cwdOptions;
    } catch { return []; }
}

function updateCwdLabel() {
    if (!currentCwd) { cwdLabel.textContent = '(default)'; return; }
    const opt = cwdOptions.find(o => o.path === currentCwd);
    cwdLabel.textContent = opt ? opt.label : currentCwd.replace(/^.*\//, '');
    cwdLabel.title = currentCwd;
}

function renderCwdMenu() {
    if (!cwdOptions.length) {
        cwdList.innerHTML = '<div class="cwd-option placeholder">Loading…</div>';
        return;
    }
    const q = _cwdFilter.toLowerCase();
    const filtered = q ? cwdOptions.filter(o => o.label.toLowerCase().includes(q)) : cwdOptions;
    if (!filtered.length) {
        cwdList.innerHTML = '<div class="cwd-option placeholder">No match</div>';
        return;
    }
    cwdList.innerHTML = filtered.map(o => `
        <div class="cwd-option${o.isRoot ? ' root' : ''}${o.path === currentCwd ? ' cur' : ''}" data-path="${escHtml(o.path)}" role="option">
            ${escHtml(o.label)}
        </div>
    `).join('');
}

cwdMenu.addEventListener('click', (e) => {
    const el = e.target.closest('.cwd-option');
    if (!el || !el.dataset.path) return;
    currentCwd = el.dataset.path;
    cwdPicker.removeAttribute('open');
    _cwdFilter = ''; cwdSearch.value = '';
    renderCwdMenu();
    updateCwdLabel();
    addTab({ newCwd: currentCwd });
    imeInput.focus();
});

cwdSearch.addEventListener('input', () => { _cwdFilter = cwdSearch.value; renderCwdMenu(); });
cwdSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cwdPicker.removeAttribute('open'); }
    if (e.key === 'Enter') {
        e.preventDefault();
        const first = cwdList.querySelector('.cwd-option[data-path]');
        if (first) first.click();
    }
});
cwdSearch.addEventListener('click', (e) => e.stopPropagation());

// Position the dropdown menu relative to the picker so overflow:hidden
// ancestors and tight ime-bar layouts can't clip or push it off-screen.
function _positionCwdMenu() {
    if (!cwdPicker.open) return;
    if (!cwdOptions.length) { renderCwdMenu(); loadCwdOptions(); }
    const r = cwdPicker.getBoundingClientRect();
    const menuW = Math.min(420, Math.max(280, r.width));
    let left = r.right - menuW;
    if (left < 8) left = 8;
    const maxLeft = window.innerWidth - menuW - 8;
    if (left > maxLeft) left = Math.max(8, maxLeft);
    const bottom = window.innerHeight - r.top + 4;
    cwdMenu.style.left = left + 'px';
    cwdMenu.style.bottom = bottom + 'px';
    cwdMenu.style.width = menuW + 'px';
}
cwdPicker.addEventListener('toggle', () => {
    _positionCwdMenu();
    if (cwdPicker.open) { setTimeout(() => cwdSearch.focus(), 0); }
});
window.addEventListener('resize', _positionCwdMenu);

document.querySelectorAll('.model-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const m = btn.dataset.model;
        if (!m) return;
        if (!sendToActive(`/model ${m}\r`)) {
            alert('No active tab to switch model in.');
        }
    });
});

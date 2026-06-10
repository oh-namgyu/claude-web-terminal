'use strict';

/* exported imeSend */
// `imeSend` (the Send button element) is wired up in boot.js.

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
    // Body text is always buffered. Passthrough(`/`,`@`,`#`) only keeps keydown shortcuts(Esc/arrows/Tab) live.
    imeMode.textContent = pass ? 'slash (keys live)' : 'buffered';
}

imeInput.addEventListener('input', () => {
    // Body text is always buffered — sent on Enter as a single chunk.
    // The previous design sent deltas live in passthrough mode (`/`,`@`,`#`-prefix),
    // but Hangul/IME composition could race out of bounds and corrupt the buffer.
    // Slash commands with non-ASCII args are common, so live body send is dropped.
    // Shortcut keys (arrows/Esc/Tab) still go live via keydown below.
    updateImeMode();
    updateSlashPalette();
});

imeInput.addEventListener('compositionend', () => {
    updateImeMode();
    updateSlashPalette();
});

imeInput.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    // Slash palette intercept — when open, arrows/Tab/Enter/Esc drive the palette.
    if (slashPaletteOpen()) {
        if (e.key === 'ArrowDown') { e.preventDefault(); movePaletteSel(+1); return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); movePaletteSel(-1); return; }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
            e.preventDefault();
            pickPaletteSel();
            return;
        }
        if (e.key === 'Escape') { e.preventDefault(); hideSlashPalette(); return; }
    }
    const pass = isPassthroughText(imeInput.value);
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (imeInput.value.length > 0) sendToActive(imeInput.value + '\r');
        else if (pass) sendToActive('\r');
        imeInput.value = ''; updateImeMode();
        hideSlashPalette();
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
                imeInput.value = ''; updateImeMode();
            }
        }
    }
});

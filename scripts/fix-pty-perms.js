#!/usr/bin/env node
'use strict';

// node-pty 1.1.0 prebuilds ship `spawn-helper` without +x on macOS.
// Calling pty.spawn then fails with "posix_spawnp failed."
// This script flips the executable bit on the helpers shipped for each
// platform/arch that's present in the prebuilds folder.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
if (!fs.existsSync(root)) process.exit(0);

let fixed = 0;
for (const entry of fs.readdirSync(root)) {
    const helper = path.join(root, entry, 'spawn-helper');
    try {
        fs.statSync(helper);
        fs.chmodSync(helper, 0o755);
        fixed++;
    } catch {}
}
if (fixed > 0) {
    console.log(`[claude-web-terminal] fixed +x on ${fixed} spawn-helper binary(ies)`);
}

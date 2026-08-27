// Minimal flat-config. recommended preset + Node/browser globals + a few
// targeted rules. Anything noisier than this gets disabled — the goal is to
// catch real mistakes (typos, dead code, accidental globals), not impose
// stylistic preferences the existing codebase doesn't follow.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    js.configs.recommended,
    {
        files: ['eslint.config.js'],
        languageOptions: {
            ecmaVersion: 2024, sourceType: 'commonjs',
            globals: { ...globals.node },
        },
    },
    {
        files: ['server.js', 'lib/**/*.js', 'scripts/**/*.js', 'bin/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-prototype-builtins': 'off',
        },
    },
    {
        // The Telegram launcher is a standalone ESM entry point (Node ≥22
        // built-ins only); its testable core next door stays CommonJS so the
        // Playwright specs can import it the same way they import lib/.
        files: ['scripts/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2024, sourceType: 'module',
            globals: { ...globals.node },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        files: ['static/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'script',
            // The frontend is split into ordered classic <script> modules under
            // static/js/ (see index.html). Top-level declarations share one
            // global lexical scope across those files at runtime, but eslint
            // lints each file in isolation — so symbols defined in one module
            // and referenced in another are declared here as shared globals.
            globals: {
                ...globals.browser, Terminal: 'readonly', FitAddon: 'readonly',
                tabs: 'writable', activeIdx: 'writable', renderTabs: 'writable',
                addTab: 'writable', closeTab: 'writable', activateTab: 'writable',
                connectTab: 'writable', currentCwd: 'writable',
                imeInput: 'writable', imeSend: 'writable', sendToActive: 'writable',
                updateImeMode: 'writable', updateSlashPalette: 'writable',
                slashPaletteOpen: 'writable', movePaletteSel: 'writable',
                pickPaletteSel: 'writable', hideSlashPalette: 'writable',
                loadCCSessions: 'writable', _applyFilters: 'writable',
                _activeDays: 'writable', toggleAgentsPanel: 'writable',
                openEditModal: 'writable', _notifyUserEnabled: 'writable',
                loadCwdOptions: 'writable', loadSlashCommands: 'writable',
                openSessionInNewTab: 'writable', openSessionInCurrentTab: 'writable',
                stopSession: 'writable', togglePinSession: 'writable',
                shortCwd: 'writable', _lastRenderedCards: 'writable',
                _checkStatusTransitions: 'writable', _fmtAgo: 'writable',
                toggleResumePanel: 'writable', loadResumeSessions: 'writable',
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
            // Symbols are declared in their home module and also listed as
            // shared globals above so cross-module references lint clean; the
            // overlap is intentional, not an accidental redeclaration.
            'no-redeclare': 'off',
        },
    },
    {
        files: ['e2e/**/*.ts', 'playwright.config.ts'],
        ignores: ['e2e/**/*.ts', 'playwright.config.ts'],  // Skip TS for now — typed lint deserves its own pass.
    },
    {
        ignores: ['node_modules/**', 'test-results/**', 'playwright-report/**',
                  'e2e/**', 'playwright.config.ts', '*.d.ts'],
    },
];

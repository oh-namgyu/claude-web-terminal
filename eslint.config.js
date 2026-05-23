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
        files: ['static/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'script',
            globals: { ...globals.browser, Terminal: 'readonly', FitAddon: 'readonly' },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
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

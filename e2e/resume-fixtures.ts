import fs from "fs";
import os from "os";
import path from "path";

// Fixture tree for the resume-browser e2e specs. Built once at config load
// (before any server starts) and pointed at by the extra webServers in
// playwright.config.ts, which run with HOME=FIXTURE_HOME so the server reads
// this tree instead of the developer's real ~/.claude.
//
// realpath the tmp dir up front: on macOS /var is a symlink to /private/var,
// and the fixture home doubles as the only allowed resume root — the
// containment check compares realpaths, so the root must already be one.
const ROOT = path.join(fs.realpathSync(os.tmpdir()), "cwt-resume-e2e");

export const FIXTURE_HOME = path.join(ROOT, "home");
export const FIXTURE_BIN = path.join(ROOT, "bin");
// Every e2e server gets this as CLAUDE_BIN (see playwright.config.ts).
export const FAKE_CLAUDE = path.join(FIXTURE_BIN, "claude");
export const FIXTURE_OUTSIDE = path.join(ROOT, "outside");
export const PROJECT_NAME = "resume-project-a";
export const PROJECT_DIR = path.join(FIXTURE_HOME, "work", PROJECT_NAME);

// A session the server can discover and the fake claude accepts.
export const VALID_ID = "11111111-1111-4111-8111-111111111111";
// Discoverable too, but the fake claude exits non-zero on it — this is how we
// check that a failing `claude` surfaces its message in the terminal.
export const REJECTED_ID = "22222222-2222-4222-8222-222222222222";
// Discoverable, but its recorded cwd is a symlink pointing outside the
// allowed roots, so the spawn must be refused.
export const ESCAPE_ID = "33333333-3333-4333-8333-333333333333";
// Well-formed uuid that is not on disk at all.
export const UNKNOWN_ID = "44444444-4444-4444-8444-444444444444";

// The transcripts below live in a directory whose name is deliberately NOT
// derivable from any cwd. Claude Code's own encoding is lossy (slashes and
// dots both become dashes); the cwd must come from the records.
const ENCODED_DIR = "-lossy-encoded-name-that-decodes-to-nothing";

type Rec = Record<string, unknown>;

function userRec(id: string, cwd: string, text: string): Rec {
    return { type: "user", sessionId: id, cwd, timestamp: new Date().toISOString(), message: { role: "user", content: text } };
}

function assistantRec(id: string, cwd: string, text: string): Rec {
    return { type: "assistant", sessionId: id, cwd, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }] } };
}

function writeJsonl(dir: string, name: string, records: Rec[], mtime?: Date) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    if (mtime) fs.utimesSync(file, mtime, mtime);
}

function writeFakeClaude() {
    fs.mkdirSync(FIXTURE_BIN, { recursive: true });
    const script = [
        "#!/bin/sh",
        "# Fake `claude` for the e2e servers: echo the argv and cwd the",
        "# server chose, then exit. Never contacts anything.",
        'echo "FAKE-CLAUDE ARGV: $*"',
        'echo "FAKE-CLAUDE CWD: $PWD"',
        `if [ "$2" = "${REJECTED_ID}" ]; then`,
        '  echo "FAKE-CLAUDE ERROR: no conversation found for session $2" >&2',
        "  exit 3",
        "fi",
        "exit 0",
        "",
    ].join("\n");
    fs.writeFileSync(FAKE_CLAUDE, script);
    fs.chmodSync(FAKE_CLAUDE, 0o755);
}

export function buildResumeFixtures() {
    fs.rmSync(ROOT, { recursive: true, force: true });

    const projects = path.join(FIXTURE_HOME, ".claude", "projects", ENCODED_DIR);
    fs.mkdirSync(projects, { recursive: true });

    // The pty runs `zsh -l` with HOME set to this fixture tree. Without a
    // .zshrc, a fresh zsh (e.g. the CI runner's apt install) launches the
    // interactive zsh-newuser-install wizard, which swallows the injected
    // `claude --resume` command. An empty rc file suppresses it everywhere.
    fs.writeFileSync(path.join(FIXTURE_HOME, ".zshrc"), "# fixture home\n");
    // Debian/Ubuntu's /etc/zsh/zshrc runs compinit, which stops on an
    // interactive "insecure directories" prompt on the CI runner. ~/.zshenv
    // is sourced before the global zshrc, and skip_global_compinit is the
    // switch that file honours.
    fs.writeFileSync(path.join(FIXTURE_HOME, ".zshenv"), "skip_global_compinit=1\n");
    fs.mkdirSync(PROJECT_DIR, { recursive: true });
    fs.mkdirSync(FIXTURE_OUTSIDE, { recursive: true });

    // A directory inside the fixture home that resolves outside it.
    const escapeLink = path.join(FIXTURE_HOME, "escape-link");
    fs.symlinkSync(FIXTURE_OUTSIDE, escapeLink, "dir");

    const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

    writeJsonl(projects, `${VALID_ID}.jsonl`, [
        userRec(VALID_ID, PROJECT_DIR, "add a health check endpoint"),
        assistantRec(VALID_ID, PROJECT_DIR, "Added the endpoint."),
        userRec(VALID_ID, PROJECT_DIR, "now write a test for it"),
    ], t(1));

    writeJsonl(projects, `${REJECTED_ID}.jsonl`, [
        userRec(REJECTED_ID, PROJECT_DIR, "rename the config module"),
        assistantRec(REJECTED_ID, PROJECT_DIR, "Renamed."),
    ], t(10));

    writeJsonl(projects, `${ESCAPE_ID}.jsonl`, [
        userRec(ESCAPE_ID, escapeLink, "work in the linked directory"),
    ], t(20));

    // Files that must all be skipped in silence.
    writeJsonl(projects, "not-a-uuid.jsonl", [userRec(VALID_ID, PROJECT_DIR, "wrong file name")], t(30));
    writeJsonl(projects, "55555555-5555-4555-8555-555555555555.jsonl", [
        userRec(VALID_ID, PROJECT_DIR, "sessionId does not match the file name"),
    ], t(31));
    writeJsonl(projects, "66666666-6666-4666-8666-666666666666.jsonl", [
        assistantRec("66666666-6666-4666-8666-666666666666", PROJECT_DIR, "no user message in here"),
    ], t(32));
    fs.writeFileSync(path.join(projects, "77777777-7777-4777-8777-777777777777.jsonl"), "{not json at all\n\u0000\n");

    writeFakeClaude();
    return { FIXTURE_HOME, FIXTURE_BIN, PROJECT_DIR };
}

// Number of fixture sessions the browser is expected to list.
export const EXPECTED_SESSION_COUNT = 3;

import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { listResumeSessions, findResumeSession } from "../lib/resume-sessions";

// Discovery unit tests for lib/resume-sessions.js. No server and no browser
// involved — the module is driven directly against throwaway ~/.claude trees,
// which is the only way to cover the files it is supposed to skip.

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let claudeDir: string;
let projectsDir: string;
// The encoded directory name is lossy in the real thing, so the fixtures use
// a name that decodes to nothing: cwd can only come from the records.
const ENCODED_DIR = "-not-a-decodable-path";
const REAL_CWD = "/tmp/cwt-unit/project one.v2";

function rec(type: string, id: string, text: string, extra: Record<string, unknown> = {}) {
    return JSON.stringify({
        type, sessionId: id, cwd: REAL_CWD, timestamp: new Date().toISOString(),
        message: { role: type, content: text }, ...extra,
    });
}

function write(name: string, lines: string[], minutesAgo = 5) {
    const file = path.join(projectsDir, name);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    const when = new Date(Date.now() - minutesAgo * 60_000);
    fs.utimesSync(file, when, when);
    return file;
}

test.beforeEach(() => {
    claudeDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cwt-unit-"));
    projectsDir = path.join(claudeDir, "projects", ENCODED_DIR);
    fs.mkdirSync(projectsDir, { recursive: true });
});

test.afterEach(() => {
    fs.rmSync(claudeDir, { recursive: true, force: true });
});

test.describe("listResumeSessions — discovery", () => {
  test("a listing reads at most maxScan transcripts, however many are unusable", () => {
    write(`${ID_A}.jsonl`, ["{not json"], 1);
    write(`${ID_B}.jsonl`, ["{not json"], 2);
    write(`${ID_C}.jsonl`, [rec("user", ID_C, "only usable one")], 3);
    expect(listResumeSessions(claudeDir, { maxScan: 2 })).toHaveLength(0);
    expect(listResumeSessions(claudeDir, { maxScan: 3 })).toHaveLength(1);
  });

  test("valid transcript is listed, with cwd read from the record", () => {
    write(`${ID_A}.jsonl`, [
      rec("user", ID_A, "first question"),
      rec("assistant", ID_A, "an answer"),
      rec("user", ID_A, "second question"),
    ]);
    const sessions = listResumeSessions(claudeDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(ID_A);
    // Not derived from the (lossy) directory name.
    expect(sessions[0].cwd).toBe(REAL_CWD);
    expect(sessions[0].preview).toBe("second question");
    expect(sessions[0].msgCount).toBe(3);
    expect(sessions[0].updatedAt).toBeGreaterThan(0);
  });

  test("corrupt, empty, non-uuid, id-mismatch and user-less files are skipped", () => {
    write(`${ID_A}.jsonl`, [rec("user", ID_A, "the only real session")]);
    write("corrupt.jsonl", ["{ not json", "]["]);
    write(`${ID_B}.jsonl`, ["{ not json at all", "also not json"]);
    write("plain-name.jsonl", [rec("user", ID_A, "file name is not a uuid")]);
    // Records claim a different session than the file they live in.
    write(`${ID_C}.jsonl`, [rec("user", ID_A, "copied from another session")]);
    // Assistant-only transcript: nothing a user ever asked.
    write("dddddddd-dddd-4ddd-8ddd-dddddddddddd.jsonl", [
      rec("assistant", "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "unprompted"),
    ]);
    fs.writeFileSync(path.join(projectsDir, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl"), "");

    const sessions = listResumeSessions(claudeDir);
    expect(sessions.map((s) => s.id)).toEqual([ID_A]);
  });

  test("a missing claudeDir yields an empty list, not an error", () => {
    expect(listResumeSessions(path.join(claudeDir, "nope"))).toEqual([]);
  });

  test("caps at 50 entries, newest first", () => {
    for (let i = 0; i < 55; i++) {
      const id = `f0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      write(`${id}.jsonl`, [rec("user", id, `session number ${i}`)], 100 - i);
    }
    const sessions = listResumeSessions(claudeDir);
    expect(sessions).toHaveLength(50);
    // Highest index was written with the most recent mtime.
    expect(sessions[0].preview).toBe("session number 54");
    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i - 1].updatedAt).toBeGreaterThanOrEqual(sessions[i].updatedAt);
    }
  });
});

test.describe("listResumeSessions — preview text", () => {
  test("truncates to 120 chars and flattens control characters", () => {
    const noisy = "line one\nline\ttwo\u0000\u0007 end " + "x".repeat(200);
    write(`${ID_A}.jsonl`, [rec("user", ID_A, noisy)]);
    const [session] = listResumeSessions(claudeDir);
    expect(session.preview).toHaveLength(120);
    expect(session.preview.startsWith("line one line two end xxx")).toBe(true);
    expect(session.preview).not.toMatch(/[\n\t]/);
  });

  test("preview:false blanks the text but keeps the session", () => {
    write(`${ID_A}.jsonl`, [rec("user", ID_A, "sensitive prompt text")]);
    const [session] = listResumeSessions(claudeDir, { preview: false });
    expect(session.id).toBe(ID_A);
    expect(session.preview).toBe("");
    expect(session.cwd).toBe(REAL_CWD);
  });
});

test.describe("findResumeSession", () => {
  test("returns the entry for a known id and null otherwise", () => {
    write(`${ID_A}.jsonl`, [rec("user", ID_A, "still here")]);
    expect(findResumeSession(claudeDir, ID_A)?.cwd).toBe(REAL_CWD);
    expect(findResumeSession(claudeDir, ID_B)).toBeNull();
    expect(findResumeSession(claudeDir, "../../etc/passwd")).toBeNull();
    expect(findResumeSession(claudeDir, "not-a-uuid")).toBeNull();
  });

  test("re-reads on every call, so a deleted session stops resolving", () => {
    const file = write(`${ID_A}.jsonl`, [rec("user", ID_A, "about to vanish")]);
    expect(findResumeSession(claudeDir, ID_A)).not.toBeNull();
    fs.rmSync(file);
    expect(findResumeSession(claudeDir, ID_A)).toBeNull();
  });
});

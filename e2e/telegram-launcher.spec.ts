import { test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  validateConfig, decideAction, processUpdates, keywordMenu,
  parseProcessInfo, pidRecordMatches, acquireLock, releaseLock,
} from "../scripts/lib/launcher-core";

// Unit coverage for the Telegram launcher's decision logic. No server, no
// browser, no bot token: every side effect the launcher has (network, spawn,
// offset persistence) is injected, which is the whole point of keeping the
// rules in scripts/lib/launcher-core.js.

let home: string;
let blogDir: string;

const BASE_CONFIG = () => ({
  botToken: "123456:example-bot-token-placeholder",
  allowedChatIds: [4242],
  keywords: { blog: blogDir },
});

const dirExists = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const validate = (raw: unknown, opts: Record<string, unknown> = {}) =>
  validateConfig(raw, { mode: 0o600, home, dirExists, ...opts });

test.beforeEach(() => {
  home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cwt-launcher-"));
  blogDir = path.join(home, "projects", "blog");
  fs.mkdirSync(blogDir, { recursive: true });
});

test.afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test.describe("config validation", () => {
  test("a mode-600 config with existing dirs is accepted", () => {
    const { ok, config } = validate(BASE_CONFIG());
    expect(ok).toBe(true);
    expect(config.keywords.blog).toBe(blogDir);
    expect(config.allowedChatIds).toEqual([4242]);
  });

  test("a world- or group-readable config is refused, --insecure-config overrides", () => {
    const loose = validate(BASE_CONFIG(), { mode: 0o644 });
    expect(loose.ok).toBe(false);
    expect(loose.errors.join(" ")).toContain("mode 600");
    // The refusal must not quote the secret it is protecting.
    expect(loose.errors.join(" ")).not.toContain("example-bot-token-placeholder");

    expect(validate(BASE_CONFIG(), { mode: 0o644, insecure: true }).ok).toBe(true);
    // Unreadable permissions are refused too — we cannot confirm the file is safe.
    expect(validate(BASE_CONFIG(), { mode: null }).ok).toBe(false);
  });

  test("a keyword pointing at a missing directory is refused", () => {
    const cfg = BASE_CONFIG();
    cfg.keywords = { gone: path.join(home, "no-such-dir") };
    const { ok, errors } = validate(cfg);
    expect(ok).toBe(false);
    expect(errors.join(" ")).toContain("does not exist");
  });

  test("`~` in a mapped directory is expanded against home", () => {
    const cfg = BASE_CONFIG();
    cfg.keywords = { blog: "~/projects/blog" };
    expect(validate(cfg).config.keywords.blog).toBe(blogDir);
  });

  test("missing token, empty allowlist and reserved keywords are all rejected", () => {
    expect(validate({ ...BASE_CONFIG(), botToken: "" }).ok).toBe(false);
    expect(validate({ ...BASE_CONFIG(), allowedChatIds: [] }).ok).toBe(false);
    expect(validate({ ...BASE_CONFIG(), allowedChatIds: ["nope"] }).ok).toBe(false);
    expect(validate({ ...BASE_CONFIG(), keywords: {} }).ok).toBe(false);
    const reserved = validate({ ...BASE_CONFIG(), keywords: { stop: blogDir } });
    expect(reserved.ok).toBe(false);
    expect(reserved.errors.join(" ")).toContain("reserved");
    expect(validate("not an object").ok).toBe(false);
  });
});

test.describe("update → action", () => {
  const ctx = () => ({ allowedChatIds: [4242], keywords: { blog: blogDir }, running: ["blog"] });
  const msg = (chatId: number, text: string, id = 1) =>
    ({ update_id: id, message: { chat: { id: chatId }, text } });

  test("messages from a chat outside the allowlist are ignored", () => {
    const action = decideAction(msg(9999, "blog"), ctx());
    expect(action).toEqual({ type: "ignore", reason: "chat-not-allowed", chatId: 9999 });
  });

  test("non-text updates are ignored", () => {
    expect(decideAction({ update_id: 1 }, ctx()).type).toBe("ignore");
    expect(decideAction({ update_id: 1, message: { chat: { id: 4242 } } }, ctx()).type).toBe("ignore");
  });

  test("a known keyword maps to a spawn in the configured directory", () => {
    const action = decideAction(msg(4242, "  BLOG  "), ctx());
    expect(action).toMatchObject({ type: "spawn", keyword: "blog", cwd: blogDir, chatId: 4242 });
  });

  test("unknown text falls back to the menu and never echoes the text", () => {
    const action = decideAction(msg(4242, "please deploy the production database"), ctx());
    expect(action).toEqual({ type: "menu", chatId: 4242 });
    expect(JSON.stringify(action)).not.toContain("database");
    expect(keywordMenu({ blog: blogDir })).toContain("blog");
  });

  test("stop <keyword>, stop all and list read the running set", () => {
    expect(decideAction(msg(4242, "stop blog"), ctx())).toMatchObject({ type: "stop", keywords: ["blog"] });
    expect(decideAction(msg(4242, "stop all"), ctx())).toMatchObject({ type: "stop", keywords: ["blog"] });
    expect(decideAction(msg(4242, "list"), ctx())).toMatchObject({ type: "list", running: ["blog"] });
    // An unknown keyword after `stop` is a typo, not a command.
    expect(decideAction(msg(4242, "stop nope"), ctx()).type).toBe("menu");
    expect(decideAction(msg(4242, "stop"), ctx()).type).toBe("menu");
  });

  test("running may be a callback so a batch sees its own effects", () => {
    let running: string[] = [];
    const live = { allowedChatIds: [4242], keywords: { blog: blogDir }, running: () => running };
    expect(decideAction(msg(4242, "stop all"), live)).toMatchObject({ keywords: [] });
    running = ["blog"];
    expect(decideAction(msg(4242, "stop all"), live)).toMatchObject({ keywords: ["blog"] });
  });
});

test.describe("offset persistence", () => {
  test("the offset is written before the update is acted on", async () => {
    const calls: string[] = [];
    const ctx = { allowedChatIds: [4242], keywords: { blog: blogDir }, running: [] };
    const updates = [
      { update_id: 10, message: { chat: { id: 4242 }, text: "blog" } },
      { update_id: 11, message: { chat: { id: 4242 }, text: "list" } },
    ];
    const offset = await processUpdates(updates, ctx, {
      saveOffset: async (n: number) => { calls.push(`offset:${n}`); },
      perform: async (a: { type: string }) => { calls.push(`perform:${a.type}`); },
    });
    // At-most-once: every offset write precedes the action it covers, so a
    // crash loses the command rather than replaying it into a second spawn.
    expect(calls).toEqual(["offset:11", "perform:spawn", "offset:12", "perform:list"]);
    expect(offset).toBe(12);
  });
});

test.describe("pid record matching", () => {
  const record = { pid: 4321, startedAt: 1_700_000_000_000, argv: ["claude", "remote-control"] };

  test("an identical live process matches, a recycled pid does not", () => {
    expect(pidRecordMatches(record, { ...record })).toBe(true);
    // ps has one-second resolution, so a small drift is still the same process.
    expect(pidRecordMatches(record, { ...record, startedAt: record.startedAt + 900 })).toBe(true);

    // Same pid, different process: started later, or running something else.
    expect(pidRecordMatches(record, { ...record, startedAt: record.startedAt + 60_000 })).toBe(false);
    expect(pidRecordMatches(record, { ...record, argv: ["vim", "notes.md"] })).toBe(false);
    expect(pidRecordMatches(record, { ...record, pid: 4322 })).toBe(false);
    // No live process at all — `ps` found nothing, so nothing may be killed.
    expect(pidRecordMatches(record, null)).toBe(false);
    expect(pidRecordMatches(null, { ...record })).toBe(false);
  });

  test("a ps line parses into the same shape the record is compared against", () => {
    const live = parseProcessInfo(4321, "Thu Aug 27 17:45:16 2026     claude remote-control\n");
    expect(live).not.toBeNull();
    expect(live!.argv).toEqual(["claude", "remote-control"]);
    expect(live!.startedAt).toBe(Date.parse("Thu Aug 27 17:45:16 2026"));
    // Empty output = the process is gone; garbage = we cannot confirm.
    expect(parseProcessInfo(4321, "")).toBeNull();
    expect(parseProcessInfo(4321, "not a ps line")).toBeNull();
  });
});

test.describe("single-instance lock", () => {
  const isAlive = (alive: number[]) => (pid: number) => alive.includes(pid);

  test("a second launcher is refused while the holder is alive", () => {
    const lockPath = path.join(home, "launcher.lock");
    expect(acquireLock({ lockPath, pid: 100, fs, isAlive: isAlive([100]) })).toEqual({ ok: true });
    const second = acquireLock({ lockPath, pid: 200, fs, isAlive: isAlive([100, 200]) });
    expect(second.ok).toBe(false);
    expect(second.heldBy).toBe(100);
  });

  test("a stale lock left by a killed launcher is taken over", () => {
    const lockPath = path.join(home, "launcher.lock");
    fs.writeFileSync(lockPath, "100");
    // pid 100 is gone — the lock file outlived it.
    expect(acquireLock({ lockPath, pid: 200, fs, isAlive: isAlive([200]) })).toEqual({ ok: true });
    expect(fs.readFileSync(lockPath, "utf-8")).toBe("200");
  });

  test("release only removes a lock this process owns", () => {
    const lockPath = path.join(home, "launcher.lock");
    acquireLock({ lockPath, pid: 100, fs, isAlive: isAlive([100]) });
    expect(releaseLock({ lockPath, pid: 200, fs })).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(releaseLock({ lockPath, pid: 100, fs })).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

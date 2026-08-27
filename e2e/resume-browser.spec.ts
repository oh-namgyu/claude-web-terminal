import { test, expect, Page } from "@playwright/test";
import fs from "fs";
import { AUTH_TOKEN, BASE_URL, RESUME_BASE_URL, RESUME_DISABLED_BASE_URL } from "../playwright.config";
import {
  VALID_ID, REJECTED_ID, ESCAPE_ID, UNKNOWN_ID,
  PROJECT_NAME, PROJECT_DIR, EXPECTED_SESSION_COUNT,
} from "./resume-fixtures";

// End-to-end coverage for the local session browser. The server under test
// runs with HOME pointed at a fixture tree (see resume-fixtures.ts) and a fake
// `claude` first on PATH, so a "resume" really spawns a pty and we can read
// back what the server decided to run and where.

const COOKIE = `cwt_auth=${AUTH_TOKEN}`;
// The pty is a login zsh; without it nothing can be launched at all.
const HAS_ZSH = fs.existsSync("/bin/zsh");

async function openApp(page: Page, base = RESUME_BASE_URL) {
  await page.context().addCookies([
    { name: "cwt_auth", value: AUTH_TOKEN, url: base, httpOnly: true },
  ]);
  await page.goto(base, { waitUntil: "domcontentloaded" });
}

// Open a WebSocket from inside the page and report how the server closed it.
function wsOutcome(page: Page, query: string) {
  return page.evaluate((q) => new Promise<{ code: number; opened: boolean }>((resolve) => {
    let opened = false;
    const ws = new WebSocket(`ws://${location.host}/${q}`);
    ws.onopen = () => { opened = true; };
    ws.onclose = (e) => resolve({ code: e.code, opened });
    setTimeout(() => resolve({ code: -1, opened }), 10_000);
  }), query);
}

test.describe("Resume API", () => {
  test("lists the fixture sessions with cwd taken from the transcript", async ({ request }) => {
    const res = await request.get(`${RESUME_BASE_URL}/api/cc/resume-sessions`, {
      headers: { cookie: COOKIE },
    });
    expect(res.status()).toBe(200);
    const { sessions } = await res.json();
    expect(sessions).toHaveLength(EXPECTED_SESSION_COUNT);
    const valid = sessions.find((s: { id: string }) => s.id === VALID_ID);
    // The transcript lives in a directory whose name decodes to nothing.
    expect(valid.cwd).toBe(PROJECT_DIR);
    expect(valid.preview).toBe("now write a test for it");
    expect(valid.msgCount).toBe(3);
    // Newest first.
    expect(sessions[0].id).toBe(VALID_ID);
  });

  test("requires auth", async ({ request }) => {
    const res = await request.get(`${RESUME_BASE_URL}/api/cc/resume-sessions`);
    expect(res.status()).toBe(401);
  });

  test("demo mode returns fixtures instead of reading real transcripts", async ({ request }) => {
    // Deliberately the default server, whose HOME is the real one.
    const res = await request.get(`${BASE_URL}/api/cc/resume-sessions?demo=1`, {
      headers: { cookie: COOKIE },
    });
    expect(res.status()).toBe(200);
    const { sessions } = await res.json();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0].id).toBe("00000000-0000-4000-8000-000000000001");
    expect(sessions[0].preview).toBe("[Sample] fix login bug");
    // Nothing from the real machine leaked into the response.
    for (const s of sessions) {
      expect(s.id.startsWith("00000000-0000-4000-8000-")).toBe(true);
      expect(s.cwd.startsWith("/path/to/")).toBe(true);
    }
  });
});

test.describe("Resume picker UI", () => {
  test("panel lists the sessions and resuming runs claude --resume in the recorded cwd", async ({ page }) => {
    test.skip(!HAS_ZSH, "the pty needs /bin/zsh");
    await openApp(page);

    await expect(page.locator("#resumeBtn")).toBeVisible();
    await page.locator("#resumeBtn").click();
    await expect(page.locator("#resumePanel")).toHaveClass(/open/);
    const cards = page.locator("#resumeList .agent-card");
    await expect(cards).toHaveCount(EXPECTED_SESSION_COUNT);
    await expect(cards.first()).toContainText(PROJECT_NAME);
    await expect(cards.first()).toContainText("now write a test for it");

    page.once("dialog", (d) => d.accept());
    await cards.first().click();

    const terminal = page.locator("#terminal");
    await expect(terminal).toContainText(`FAKE-CLAUDE ARGV: --resume ${VALID_ID}`, { timeout: 20_000 });
    // The pty landed in the cwd the server read back from the transcript.
    await expect(terminal).toContainText(`FAKE-CLAUDE CWD: ${PROJECT_DIR}`);
  });

  test("a claude that refuses the session surfaces its error in the terminal", async ({ page }) => {
    test.skip(!HAS_ZSH, "the pty needs /bin/zsh");
    await openApp(page);
    await page.locator("#resumeBtn").click();
    const rejected = page.locator(`#resumeList .agent-card[data-session-id="${REJECTED_ID}"]`);
    await expect(rejected).toHaveCount(1);

    page.once("dialog", (d) => d.accept());
    await rejected.click();

    await expect(page.locator("#terminal"))
      .toContainText("FAKE-CLAUDE ERROR: no conversation found", { timeout: 20_000 });
  });
});

test.describe("Resume spawn validation", () => {
  test("a malformed id is refused before anything spawns", async ({ page }) => {
    await openApp(page);
    const { code } = await wsOutcome(page, "?resume=not-a-uuid");
    expect(code).toBe(1008);
  });

  test("a well-formed id with no session on disk is refused", async ({ page }) => {
    await openApp(page);
    const { code } = await wsOutcome(page, `?resume=${UNKNOWN_ID}`);
    expect(code).toBe(1008);
  });

  test("a session whose cwd resolves outside the allowed roots is refused", async ({ page }) => {
    await openApp(page);
    const { code } = await wsOutcome(page, `?resume=${ESCAPE_ID}`);
    expect(code).toBe(1008);
  });

  test("a client-supplied cwd cannot steer a resume", async ({ page }) => {
    test.skip(!HAS_ZSH, "the pty needs /bin/zsh");
    await openApp(page);
    // The escape path is handed over explicitly; the server ignores it and
    // uses the transcript's own cwd instead.
    const cwdParam = encodeURIComponent("/etc");
    const output = await page.evaluate(([q]) => new Promise<string>((resolve) => {
      let buf = "";
      const ws = new WebSocket(`ws://${location.host}/${q}`);
      ws.onmessage = (e) => {
        buf += typeof e.data === "string" ? e.data : "";
        if (buf.includes("FAKE-CLAUDE CWD:")) { ws.close(); resolve(buf); }
      };
      ws.onclose = () => resolve(buf);
      setTimeout(() => { ws.close(); resolve(buf); }, 20_000);
    }), [`?resume=${VALID_ID}&cwd=${cwdParam}`]);
    expect(output).toContain(`FAKE-CLAUDE CWD: ${PROJECT_DIR}`);
  });
});

test.describe("RESUME_BROWSER=0", () => {
  test("the route 404s and the UI shows no entry point", async ({ page, request }) => {
    const res = await request.get(`${RESUME_DISABLED_BASE_URL}/api/cc/resume-sessions`, {
      headers: { cookie: COOKIE },
    });
    expect(res.status()).toBe(404);

    await openApp(page, RESUME_DISABLED_BASE_URL);
    await expect(page.locator("#resumeBtn")).toBeHidden();
  });
});

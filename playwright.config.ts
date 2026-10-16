import { defineConfig, devices } from "@playwright/test";
import { buildResumeFixtures, FIXTURE_HOME, FAKE_CLAUDE } from "./e2e/resume-fixtures";

const PORT = 8765;
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const AUTH_TOKEN = process.env.E2E_AUTH_TOKEN || "e2e-test-token-cwt-12345";

// Two extra servers for the local session browser: one reading a fixture
// ~/.claude tree (HOME is redirected, so the developer's real transcripts are
// never touched), one with the feature switched off.
const RESUME_PORT = 8788;
const RESUME_DISABLED_PORT = 8789;
const RESUME_BASE_URL = `http://${HOST}:${RESUME_PORT}`;
const RESUME_DISABLED_BASE_URL = `http://${HOST}:${RESUME_DISABLED_PORT}`;

// Built at config load, i.e. before any of the servers below start.
buildResumeFixtures();

// No spec may launch the real Claude Code CLI: the rate-limit spec POSTs
// /api/cc-sessions, which would start real background sessions on a machine
// whose cwd is trusted, and the outcome would depend on the host's install,
// login and trust state. CLAUDE_BIN overrides the server's `which claude`,
// and lib/config.js puts its directory first on the pty's PATH, so the pty
// picks up the fake too.
const serverEnv = { HOST, AUTH_TOKEN, LOG_LEVEL: "warn", CLAUDE_BIN: FAKE_CLAUDE };
const resumeServerEnv = { ...serverEnv, HOME: FIXTURE_HOME };

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, trace: "on-first-retry", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node server.js",
      url: BASE_URL,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { ...serverEnv, PORT: String(PORT), RATE_LIMIT_PER_MIN: "5" },
    },
    {
      command: "node server.js",
      url: RESUME_BASE_URL,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { ...resumeServerEnv, PORT: String(RESUME_PORT) },
    },
    {
      command: "node server.js",
      url: RESUME_DISABLED_BASE_URL,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { ...resumeServerEnv, PORT: String(RESUME_DISABLED_PORT), RESUME_BROWSER: "0" },
    },
  ],
});

export { AUTH_TOKEN, BASE_URL, RESUME_BASE_URL, RESUME_DISABLED_BASE_URL };

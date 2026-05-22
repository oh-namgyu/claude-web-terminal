import { defineConfig, devices } from "@playwright/test";

const PORT = 8765;
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const AUTH_TOKEN = process.env.E2E_AUTH_TOKEN || "e2e-test-token-cwt-12345";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, trace: "on-first-retry", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node server.js",
    url: BASE_URL,
    timeout: 60_000,
    reuseExistingServer: false,
    env: { PORT: String(PORT), HOST, AUTH_TOKEN },
  },
});

export { AUTH_TOKEN, BASE_URL };

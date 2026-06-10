import { test, expect } from "@playwright/test";
import { AUTH_TOKEN, BASE_URL } from "../playwright.config";

// claude-web-terminal golden path — loopback + ?t=<token> bootstrap + cwt_auth cookie.
// /api/* enforces the Origin whitelist + cookie validation.

test.describe("Bootstrap", () => {
  test("/ without token → 401 + guidance HTML", async ({ page, context }) => {
    await context.clearCookies();
    const res = await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(res?.status()).toBe(401);
    await expect(page.locator("body")).toContainText(/loopback token|t=/i);
  });

  test("/ with ?t=<AUTH_TOKEN> → sets cookie + 302", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto(`/?t=${AUTH_TOKEN}`, { waitUntil: "domcontentloaded" });
    const cookies = await context.cookies(BASE_URL);
    const auth = cookies.find((c) => c.name === "cwt_auth");
    expect(auth?.value).toBe(AUTH_TOKEN);
    expect(auth?.httpOnly).toBeTruthy();
  });

  test("wrong token → 401 (no cookie set)", async ({ page, context }) => {
    await context.clearCookies();
    const res = await page.goto("/?t=wrong-token-xxx", { waitUntil: "domcontentloaded" });
    expect(res?.status()).toBe(401);
    const cookies = await context.cookies(BASE_URL);
    expect(cookies.find((c) => c.name === "cwt_auth")).toBeUndefined();
  });
});

test.describe("Static UI (cookie-gated)", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      { name: "cwt_auth", value: AUTH_TOKEN, url: BASE_URL, httpOnly: true },
    ]);
  });

  test("/ loads → index.html OK + core assets", async ({ page }) => {
    const res = await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(/.+/); // title is non-empty
    await expect(page.locator("body")).not.toBeEmpty();
  });

  test("/app.js, /style.css → 200", async ({ request, context }) => {
    const cookieHeader = `cwt_auth=${AUTH_TOKEN}`;
    const js = await request.get(`${BASE_URL}/app.js`, { headers: { cookie: cookieHeader } });
    const css = await request.get(`${BASE_URL}/style.css`, { headers: { cookie: cookieHeader } });
    expect(js.status()).toBe(200);
    expect(css.status()).toBe(200);
  });
});

test.describe("API origin gate", () => {
  test("cookie + bad Origin → 403 (CSRF block)", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health`, {
      headers: {
        cookie: `cwt_auth=${AUTH_TOKEN}`,
        origin: "https://evil.example",
      },
    });
    expect(res.status()).toBe(403);
  });
});

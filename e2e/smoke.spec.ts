import { test, expect } from "@playwright/test";
import { AUTH_TOKEN, BASE_URL } from "../playwright.config";

// claude-web-terminal 골든패스 — loopback + ?t=<token> 부트스트랩 + cwt_auth 쿠키.
// /api/* 는 Origin 화이트리스트 + 쿠키 검증.

test.describe("Bootstrap", () => {
  test("토큰 없이 / → 401 + 안내 HTML", async ({ page, context }) => {
    await context.clearCookies();
    const res = await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(res?.status()).toBe(401);
    await expect(page.locator("body")).toContainText(/loopback token|t=/i);
  });

  test("?t=<AUTH_TOKEN> 으로 / 접근 → 쿠키 발급 + 302", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto(`/?t=${AUTH_TOKEN}`, { waitUntil: "domcontentloaded" });
    const cookies = await context.cookies(BASE_URL);
    const auth = cookies.find((c) => c.name === "cwt_auth");
    expect(auth?.value).toBe(AUTH_TOKEN);
    expect(auth?.httpOnly).toBeTruthy();
  });

  test("잘못된 토큰 → 401 (쿠키 발급 안 함)", async ({ page, context }) => {
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

  test("/ 로드 → index.html 정상 + 핵심 자산", async ({ page }) => {
    const res = await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(/.+/); // 타이틀 비어있지 않음
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
  test("쿠키 + 잘못된 Origin → 403 (CSRF 차단)", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health`, {
      headers: {
        cookie: `cwt_auth=${AUTH_TOKEN}`,
        origin: "https://evil.example",
      },
    });
    expect(res.status()).toBe(403);
  });
});

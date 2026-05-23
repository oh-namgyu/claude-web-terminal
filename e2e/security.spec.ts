import { test, expect } from "@playwright/test";
import { AUTH_TOKEN, BASE_URL } from "../playwright.config";

// 보안 회귀 — Origin 강제, metadata schema, id 형식, WS 인증.
// smoke.spec.ts 는 골든패스, 여기는 거절 케이스만.

const COOKIE = `cwt_auth=${AUTH_TOKEN}`;

test.describe("Origin gate — state-changing methods", () => {
  test("POST without Origin → 403", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/cc-sessions/abcdef123456/metadata`, {
      headers: { cookie: COOKIE, "content-type": "application/json" },
      data: { name: "x" },
    });
    expect(res.status()).toBe(403);
  });

  test("DELETE without Origin → 403", async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/cc-sessions/abcdef123456`, {
      headers: { cookie: COOKIE },
    });
    expect(res.status()).toBe(403);
  });

  test("POST with allowed Origin → passes Origin gate (auth still required)", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/cc-sessions/abcdef123456/metadata`, {
      headers: { cookie: COOKIE, origin: BASE_URL, "content-type": "application/json" },
      data: { name: "renamed" },
    });
    // Origin OK → not 403. Either 200 (saved) or 500 (no such session). 403 means Origin gate misfired.
    expect(res.status()).not.toBe(403);
  });

  test("GET without Origin → allowed (browser address-bar pattern)", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health`, {
      headers: { cookie: COOKIE },
    });
    expect(res.status()).toBe(200);
  });
});

test.describe("Metadata schema validation", () => {
  const url = `${BASE_URL}/api/cc-sessions/abcdef123456/metadata`;
  const headers = { cookie: COOKIE, origin: BASE_URL, "content-type": "application/json" };

  test("non-object body → 400", async ({ request }) => {
    const res = await request.post(url, { headers, data: "not an object" });
    expect(res.status()).toBe(400);
  });

  test("empty / unknown-only fields → 400", async ({ request }) => {
    const res = await request.post(url, { headers, data: { evil: "x", __proto__: { polluted: true } } });
    expect(res.status()).toBe(400);
  });

  test("name too long → 400", async ({ request }) => {
    const res = await request.post(url, { headers, data: { name: "x".repeat(500) } });
    expect(res.status()).toBe(400);
  });

  test("pinned wrong type → 400", async ({ request }) => {
    const res = await request.post(url, { headers, data: { pinned: "yes" } });
    expect(res.status()).toBe(400);
  });

  test("valid name → not 400 (drops to 500 if no session, but schema OK)", async ({ request }) => {
    const res = await request.post(url, { headers, data: { name: "ok" } });
    expect(res.status()).not.toBe(400);
  });
});

test.describe("Session id validation", () => {
  test("invalid id format on metadata POST → 400", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/cc-sessions/../etc-passwd/metadata`, {
      headers: { cookie: COOKIE, origin: BASE_URL, "content-type": "application/json" },
      data: { name: "x" },
    });
    // Express path resolution will route this somewhere — either 404 or 400, but never 200.
    expect([400, 404]).toContain(res.status());
  });

  test("non-hex id on DELETE → 500 (invalid session id)", async ({ request }) => {
    const res = await request.delete(`${BASE_URL}/api/cc-sessions/ZZZZZZ`, {
      headers: { cookie: COOKIE, origin: BASE_URL },
    });
    // 500 (invalid session id raised in stopSession) — anything but 200.
    expect(res.status()).not.toBe(200);
  });
});

test.describe("WebSocket auth", () => {
  test("WS upgrade without cookie → 401", async ({ request }) => {
    // Playwright APIRequestContext does an HTTP upgrade-style request: missing
    // cookie means hasValidAuth=false → server.on('upgrade') destroys socket.
    const res = await request.get(`${BASE_URL}/ws`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
      maxRedirects: 0,
    });
    expect([401, 400]).toContain(res.status());
  });
});

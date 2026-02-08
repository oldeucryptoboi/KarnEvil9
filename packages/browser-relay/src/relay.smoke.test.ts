/**
 * Smoke test — launches a real headless Chromium via the relay server.
 * Skipped automatically when Playwright is not installed.
 *
 * Run with:  pnpm --filter @openvger/browser-relay test -- relay.smoke
 */
import { describe, it, expect, afterAll } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ManagedDriver } from "./drivers/managed.js";
import { RelayServer } from "./server.js";

const FIXTURE = pathToFileURL(
  resolve(import.meta.dirname, "__fixtures__/smoke.html"),
).href;

let available = false;
try {
  const moduleName = "playwright";
  await import(moduleName);
  available = true;
} catch { /* playwright not installed */ }

describe.skipIf(!available)("relay smoke test (real Chromium via HTTP)", () => {
  const driver = new ManagedDriver({ headless: true });
  const relay = new RelayServer({ port: 0, driver });
  let baseUrl: string;

  afterAll(async () => {
    await relay.shutdown();
  });

  async function startRelay(): Promise<string> {
    if (baseUrl) return baseUrl;
    const app = relay.getExpressApp();
    const server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    return baseUrl;
  }

  async function post(path: string, body: unknown) {
    const url = await startRelay();
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json();
  }

  async function get(path: string) {
    const url = await startRelay();
    const response = await fetch(`${url}${path}`);
    return response.json();
  }

  it("health check returns ok with browser inactive", async () => {
    const result = await get("/health") as any;
    expect(result.status).toBe("ok");
    expect(result.driver).toBe("managed");
    expect(result.browser_active).toBe(false);
  });

  it("navigates to a local HTML fixture", async () => {
    const result = await post("/actions", { action: "navigate", url: FIXTURE }) as any;
    expect(result.success).toBe(true);
    expect(result.title).toBe("Smoke Test Page");
  });

  it("health reflects browser_active after navigate", async () => {
    const result = await get("/health") as any;
    expect(result.browser_active).toBe(true);
  });

  it("takes an accessibility snapshot", async () => {
    const result = await post("/actions", { action: "snapshot" }) as any;
    expect(result.success).toBe(true);
    expect(result.snapshot.length).toBeGreaterThan(0);
    expect(result.snapshot).toContain("Hello OpenVger");
  });

  it("clicks a button by role", async () => {
    const result = await post("/actions", {
      action: "click",
      target: { role: "button", name: "Submit" },
    }) as any;
    expect(result.success).toBe(true);
    expect(result.element_found).toBe(true);
  });

  it("reads text from an element after click", async () => {
    const result = await post("/actions", {
      action: "get_text",
      target: { selector: "#result" },
    }) as any;
    expect(result.success).toBe(true);
    expect(result.text).toBe("clicked");
  });

  it("fills an input by label", async () => {
    const result = await post("/actions", {
      action: "fill",
      target: { label: "Email" },
      value: "test@openvger.dev",
    }) as any;
    expect(result.success).toBe(true);
    expect(result.element_found).toBe(true);
  });

  it("clicks a link and verifies result", async () => {
    const result = await post("/actions", {
      action: "click",
      target: { role: "link", name: "Learn more" },
    }) as any;
    expect(result.success).toBe(true);
    expect(result.element_found).toBe(true);

    // Verify the onclick handler fired
    const text = await post("/actions", {
      action: "get_text",
      target: { selector: "#link-result" },
    }) as any;
    expect(text.text).toBe("followed");
  });

  it("gets text from a specific heading", async () => {
    const result = await post("/actions", {
      action: "get_text",
      target: { role: "heading", name: "Hello OpenVger" },
    }) as any;
    expect(result.success).toBe(true);
    expect(result.text).toContain("Hello OpenVger");
  });

  it("returns error for ambiguous heading target", async () => {
    const result = await post("/actions", {
      action: "get_text",
      target: { role: "heading" },
    }) as any;
    expect(result.success).toBe(false);
    expect(result.element_found).toBe(false);
    expect(result.error).toContain("resolved to");
  });

  it("closes the browser", async () => {
    const result = await post("/close", {}) as any;
    expect(result.closed).toBe(true);
  });

  it("health confirms browser inactive after close", async () => {
    const result = await get("/health") as any;
    expect(result.browser_active).toBe(false);
  });
});

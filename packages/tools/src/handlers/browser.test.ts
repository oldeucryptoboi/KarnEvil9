import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PolicyProfile } from "@karnevil9/schemas";
import { browserHandler, createBrowserHandler } from "./browser.js";
import type { BrowserDriverLike } from "./browser.js";

const openPolicy: PolicyProfile = {
  allowed_paths: [],
  allowed_endpoints: [],
  allowed_commands: [],
  require_approval_for_writes: false,
};

// ── Fetch mock setup ───────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockFetch(body: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    statusText: status >= 500 ? "Internal Server Error" : "OK",
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Mode tests (mock / dry_run) ────────────────────────────────────

describe("browserHandler — mock mode", () => {
  it("returns mock response for navigate (no fetch call)", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy;
    const result = (await browserHandler(
      { action: "navigate", url: "https://example.com" }, "mock", openPolicy
    )) as any;
    expect(result.success).toBe(true);
    expect(result.url).toBe("https://example.com");
    expect(result.title).toBe("Example Domain");
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns mock response for any valid action", async () => {
    const result = (await browserHandler(
      { action: "snapshot" }, "mock", openPolicy
    )) as any;
    expect(result.success).toBe(true);
  });
});

describe("browserHandler — dry_run mode", () => {
  it("navigate returns description (no fetch call)", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy;
    const result = (await browserHandler(
      { action: "navigate", url: "https://example.com" }, "dry_run", openPolicy
    )) as any;
    expect(result.success).toBe(true);
    expect(result.url).toContain("[dry_run]");
    expect(result.url).toContain("https://example.com");
    expect(spy).not.toHaveBeenCalled();
  });

  it("click returns description with target", async () => {
    const result = (await browserHandler(
      { action: "click", target: { role: "button", name: "Submit" } }, "dry_run", openPolicy
    )) as any;
    expect(result.success).toBe(true);
    expect(result.url).toContain("[dry_run]");
    expect(result.url).toContain("Submit");
  });

  it("snapshot returns description", async () => {
    const result = (await browserHandler(
      { action: "snapshot" }, "dry_run", openPolicy
    )) as any;
    expect(result.success).toBe(true);
    expect(result.snapshot).toContain("[dry_run]");
  });

  it("get_text returns description", async () => {
    const result = (await browserHandler(
      { action: "get_text", target: { label: "Email" } }, "dry_run", openPolicy
    )) as any;
    expect(result.success).toBe(true);
    expect(result.text).toContain("[dry_run]");
  });
});

describe("browserHandler — invalid action", () => {
  it("rejects unknown actions", async () => {
    const result = (await browserHandler(
      { action: "destroy" }, "mock", openPolicy
    )) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown action");
  });
});

// ── Real mode — fetch to relay ─────────────────────────────────────

describe("browserHandler — real mode (fetch to relay)", () => {
  it("calls fetch with correct URL and body for navigate", async () => {
    mockFetch({ success: true, url: "https://example.com", title: "Example" });
    const result = (await browserHandler(
      { action: "navigate", url: "https://example.com" }, "real", openPolicy
    )) as any;
    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:9222/actions",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "navigate", url: "https://example.com" }),
      }),
    );
  });

  it("calls fetch with correct body for click", async () => {
    mockFetch({ success: true, element_found: true });
    const input = { action: "click", target: { role: "button", name: "Submit" } };
    const result = (await browserHandler(input, "real", openPolicy)) as any;
    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:9222/actions",
      expect.objectContaining({
        body: JSON.stringify(input),
      }),
    );
  });

  it("returns relay error response for 4xx", async () => {
    mockFetch({ success: false, error: "Element not found" }, 422);
    const result = (await browserHandler(
      { action: "click", target: { selector: "#missing" } }, "real", openPolicy
    )) as any;
    expect(result.success).toBe(false);
    expect(result.error).toBe("Element not found");
  });

  it("throws on 5xx relay server error", async () => {
    mockFetch("Internal Server Error", 500);
    await expect(
      browserHandler({ action: "snapshot" }, "real", openPolicy)
    ).rejects.toThrow(/Browser relay server error: 500/);
  });
});

// ── Policy enforcement ─────────────────────────────────────────────

describe("browserHandler — policy enforcement", () => {
  it("navigate enforces endpoint policy in real mode", async () => {
    const restrictedPolicy: PolicyProfile = {
      ...openPolicy,
      allowed_endpoints: ["https://api.allowed.com"],
    };
    await expect(
      browserHandler(
        { action: "navigate", url: "https://evil.com" }, "real", restrictedPolicy
      ),
    ).rejects.toThrow();
  });

  it("dry_run does NOT enforce policy", async () => {
    const restrictedPolicy: PolicyProfile = {
      ...openPolicy,
      allowed_endpoints: ["https://api.allowed.com"],
    };
    const result = (await browserHandler(
      { action: "navigate", url: "https://evil.com" }, "dry_run", restrictedPolicy
    )) as any;
    expect(result.success).toBe(true);
  });

  it("policy enforcement runs before fetch", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy;
    const restrictedPolicy: PolicyProfile = {
      ...openPolicy,
      allowed_endpoints: ["https://api.allowed.com"],
    };
    try {
      await browserHandler(
        { action: "navigate", url: "https://evil.com" }, "real", restrictedPolicy
      );
    } catch { /* expected */ }
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── createBrowserHandler with in-process driver ──────────────────

describe("createBrowserHandler — with driver", () => {
  let mockDriver: BrowserDriverLike;
  let handler: ReturnType<typeof createBrowserHandler>;

  beforeEach(() => {
    mockDriver = {
      execute: vi.fn().mockResolvedValue({ success: true, url: "https://example.com", title: "Example" }),
    };
    handler = createBrowserHandler(mockDriver);
  });

  it("calls driver.execute() directly for navigate", async () => {
    const result = (await handler(
      { action: "navigate", url: "https://example.com" }, "real", openPolicy
    )) as any;
    expect(result.success).toBe(true);
    expect(mockDriver.execute).toHaveBeenCalledWith({ action: "navigate", url: "https://example.com" });
  });

  it("calls driver.execute() for snapshot", async () => {
    (mockDriver.execute as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true, snapshot: "<tree>" });
    const result = (await handler(
      { action: "snapshot" }, "real", openPolicy
    )) as any;
    expect(result.success).toBe(true);
    expect(result.snapshot).toBe("<tree>");
    expect(mockDriver.execute).toHaveBeenCalledWith({ action: "snapshot" });
  });

  it("does NOT call fetch when driver is provided", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    await handler({ action: "click", target: { role: "button", name: "Go" } }, "real", openPolicy);
    expect(fetchSpy).not.toHaveBeenCalled();
    globalThis.fetch = originalFetch;
  });

  it("still returns mock response in mock mode", async () => {
    const result = (await handler(
      { action: "navigate", url: "https://example.com" }, "mock", openPolicy
    )) as any;
    expect(result.success).toBe(true);
    expect(result.title).toBe("Example Domain");
    expect(mockDriver.execute).not.toHaveBeenCalled();
  });

  it("still returns dry_run response in dry_run mode", async () => {
    const result = (await handler(
      { action: "navigate", url: "https://example.com" }, "dry_run", openPolicy
    )) as any;
    expect(result.success).toBe(true);
    expect(result.url).toContain("[dry_run]");
    expect(mockDriver.execute).not.toHaveBeenCalled();
  });

  it("enforces policy before calling driver for navigate", async () => {
    const restrictedPolicy: PolicyProfile = {
      ...openPolicy,
      allowed_endpoints: ["https://api.allowed.com"],
    };
    await expect(
      handler({ action: "navigate", url: "https://evil.com" }, "real", restrictedPolicy),
    ).rejects.toThrow();
    expect(mockDriver.execute).not.toHaveBeenCalled();
  });

  it("rejects unknown actions even with driver", async () => {
    const result = (await handler(
      { action: "destroy" }, "real", openPolicy
    )) as any;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown action");
    expect(mockDriver.execute).not.toHaveBeenCalled();
  });
});

describe("createBrowserHandler — without driver (relay fallback)", () => {
  it("calls fetch to relay URL", async () => {
    const handler = createBrowserHandler();
    mockFetch({ success: true, url: "https://example.com", title: "Example" });
    const result = (await handler(
      { action: "navigate", url: "https://example.com" }, "real", openPolicy
    )) as any;
    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:9222/actions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "navigate", url: "https://example.com" }),
      }),
    );
  });
});

describe("backward-compatible browserHandler export", () => {
  it("is a function (ToolHandler)", () => {
    expect(typeof browserHandler).toBe("function");
  });

  it("uses relay fallback (no driver)", async () => {
    mockFetch({ success: true, snapshot: "<tree>" });
    const result = (await browserHandler(
      { action: "snapshot" }, "real", openPolicy
    )) as any;
    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:9222/actions",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveTarget, callOnElement, getBoundingRect } from "./target-resolver.js";
import type { CDPClient } from "./client.js";

// ── Mock CDPClient ──────────────────────────────────────────────────

function createMockCDP(overrides?: Partial<CDPClient>): CDPClient {
  return {
    send: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    waitForEvent: vi.fn(),
    connected: true,
    listTargets: vi.fn(),
    getVersion: vi.fn(),
    ...overrides,
  } as unknown as CDPClient;
}

describe("resolveTarget", () => {
  let cdp: CDPClient;

  beforeEach(() => {
    cdp = createMockCDP();
  });

  it("resolves a role+name target to an element", async () => {
    const mockObjectId = "node-123";
    const send = vi.fn()
      // First call: Runtime.evaluate to find elements
      .mockResolvedValueOnce({
        result: { type: "object", objectId: mockObjectId },
      })
      // Second call: Runtime.callFunctionOn to check marker
      .mockResolvedValueOnce({
        result: { type: "object", value: null },
      });
    cdp = createMockCDP({ send } as any);

    const result = await resolveTarget(cdp, { role: "button", name: "Submit" });
    expect(result.objectId).toBe(mockObjectId);
    expect(send).toHaveBeenCalledTimes(2);

    // Verify the first call is Runtime.evaluate
    const firstCall = send.mock.calls[0];
    expect(firstCall[0]).toBe("Runtime.evaluate");
    expect(firstCall[1].expression).toContain("button");
    expect(firstCall[1].expression).toContain("Submit");
  });

  it("resolves a label target", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({
        result: { type: "object", objectId: "label-el" },
      })
      .mockResolvedValueOnce({
        result: { type: "object", value: null },
      });
    cdp = createMockCDP({ send } as any);

    const result = await resolveTarget(cdp, { label: "Email" });
    expect(result.objectId).toBe("label-el");
    const expr = send.mock.calls[0][1].expression;
    expect(expr).toContain("label");
    expect(expr).toContain("Email");
  });

  it("resolves a placeholder target", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({
        result: { type: "object", objectId: "ph-el" },
      })
      .mockResolvedValueOnce({
        result: { type: "object", value: null },
      });
    cdp = createMockCDP({ send } as any);

    const result = await resolveTarget(cdp, { placeholder: "Search..." });
    expect(result.objectId).toBe("ph-el");
    const expr = send.mock.calls[0][1].expression;
    expect(expr).toContain("placeholder");
  });

  it("resolves a text target", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({
        result: { type: "object", objectId: "text-el" },
      })
      .mockResolvedValueOnce({
        result: { type: "object", value: null },
      });
    cdp = createMockCDP({ send } as any);

    const result = await resolveTarget(cdp, { text: "Learn more" });
    expect(result.objectId).toBe("text-el");
    const expr = send.mock.calls[0][1].expression;
    expect(expr).toContain("Learn more");
  });

  it("resolves a CSS selector target", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({
        result: { type: "object", objectId: "css-el" },
      })
      .mockResolvedValueOnce({
        result: { type: "object", value: null },
      });
    cdp = createMockCDP({ send } as any);

    const result = await resolveTarget(cdp, { selector: "#main .content" });
    expect(result.objectId).toBe("css-el");
    const expr = send.mock.calls[0][1].expression;
    expect(expr).toContain("#main .content");
  });

  it("throws when element not found", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({
        result: { type: "object", objectId: "marker-obj" },
      })
      .mockResolvedValueOnce({
        result: { type: "object", value: '{"__notFound":true,"count":0}' },
      });
    cdp = createMockCDP({ send } as any);

    await expect(resolveTarget(cdp, { role: "button", name: "Missing" }))
      .rejects.toThrow("Element not found");
  });

  it("throws when target is ambiguous (no nth)", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({
        result: { type: "object", objectId: "marker-obj" },
      })
      .mockResolvedValueOnce({
        result: { type: "object", value: '{"__ambiguous":true,"count":3}' },
      });
    cdp = createMockCDP({ send } as any);

    await expect(resolveTarget(cdp, { role: "listitem" }))
      .rejects.toThrow("resolved to 3 elements");
  });

  it("throws when no locator fields provided", async () => {
    await expect(resolveTarget(cdp, {}))
      .rejects.toThrow("Target must specify at least one of");
  });

  it("throws on Runtime.evaluate exception", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      result: { type: "undefined" },
      exceptionDetails: { exceptionId: 1, text: "SyntaxError", lineNumber: 0, columnNumber: 0 },
    });
    cdp = createMockCDP({ send } as any);

    await expect(resolveTarget(cdp, { selector: "div" }))
      .rejects.toThrow("Target resolution failed: SyntaxError");
  });
});

describe("callOnElement", () => {
  it("calls a function on the element and returns the value", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      result: { type: "string", value: "hello world" },
    });
    const cdp = createMockCDP({ send } as any);

    const result = await callOnElement<string>(cdp, { objectId: "el-1" }, "function() { return this.textContent; }");
    expect(result).toBe("hello world");
    expect(send).toHaveBeenCalledWith("Runtime.callFunctionOn", {
      functionDeclaration: "function() { return this.textContent; }",
      objectId: "el-1",
      returnByValue: true,
    });
  });

  it("throws on exception", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      result: { type: "undefined" },
      exceptionDetails: { exceptionId: 1, text: "TypeError", lineNumber: 0, columnNumber: 0 },
    });
    const cdp = createMockCDP({ send } as any);

    await expect(callOnElement(cdp, { objectId: "el-1" }, "function() { throw new Error(); }"))
      .rejects.toThrow("callOnElement failed: TypeError");
  });
});

describe("getBoundingRect", () => {
  it("returns the bounding rect of an element", async () => {
    const rect = { x: 10, y: 20, width: 100, height: 50 };
    const send = vi.fn().mockResolvedValueOnce({
      result: { type: "object", value: rect },
    });
    const cdp = createMockCDP({ send } as any);

    const result = await getBoundingRect(cdp, { objectId: "el-1" });
    expect(result).toEqual(rect);
  });
});

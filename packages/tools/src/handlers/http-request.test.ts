import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PolicyProfile } from "@karnevil9/schemas";

/* ------------------------------------------------------------------ *
 *  Mock policy enforcer — replace only assertEndpointAllowedAsync     *
 *  to avoid DNS resolution in tests while preserving error classes.   *
 * ------------------------------------------------------------------ */

const { mockAssertEndpoint } = vi.hoisted(() => ({
  mockAssertEndpoint: vi.fn(),
}));

vi.mock("../policy-enforcer.js", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return {
    ...mod,
    assertEndpointAllowedAsync: mockAssertEndpoint,
  };
});

import { httpRequestHandler } from "./http-request.js";
import { SsrfError } from "../policy-enforcer.js";

const openPolicy: PolicyProfile = {
  allowed_paths: [],
  allowed_endpoints: [],
  allowed_commands: [],
  require_approval_for_writes: false,
};

const mockFetch = vi.fn();

/* ------------------------------------------------------------------ *
 *  Redirect chaining                                                  *
 * ------------------------------------------------------------------ */

describe("httpRequestHandler — redirect chaining", () => {
  beforeEach(() => {
    mockAssertEndpoint.mockReset().mockResolvedValue(undefined);
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows a single redirect and returns final response", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: "https://example.com/final" },
      }))
      .mockResolvedValueOnce(new Response("final content", { status: 200 }));

    const result = (await httpRequestHandler(
      { url: "https://example.com/start", method: "GET" }, "live", openPolicy
    )) as any;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(200);
    expect(result.body).toBe("final content");
  });

  it("follows chained redirects (301 -> 302 -> 200)", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, {
        status: 301,
        headers: { Location: "https://example.com/step2" },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: "https://example.com/step3" },
      }))
      .mockResolvedValueOnce(new Response("done", { status: 200 }));

    const result = (await httpRequestHandler(
      { url: "https://example.com/start", method: "GET" }, "live", openPolicy
    )) as any;

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result.status).toBe(200);
    expect(result.body).toBe("done");
  });

  it("stops after MAX_REDIRECTS (5) hops", async () => {
    for (let i = 0; i < 6; i++) {
      mockFetch.mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: `https://example.com/r${i + 1}` },
      }));
    }

    const result = (await httpRequestHandler(
      { url: "https://example.com/start", method: "GET" }, "live", openPolicy
    )) as any;

    expect(mockFetch).toHaveBeenCalledTimes(6); // initial + 5 redirect fetches
    expect(result.status).toBe(302); // last response still a redirect
  });

  it("validates each redirect target against SSRF policy", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: "http://127.0.0.1/admin" },
    }));

    // First call (initial URL) passes, second call (redirect URL) rejects
    mockAssertEndpoint
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new SsrfError("Requests to private IP blocked"));

    await expect(
      httpRequestHandler(
        { url: "https://example.com/start", method: "GET" }, "live", openPolicy
      )
    ).rejects.toThrow(SsrfError);
  });

  it("returns error for malformed redirect URL", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: "https://[invalid" },
    }));

    const result = (await httpRequestHandler(
      { url: "https://example.com/start", method: "GET" }, "live", openPolicy
    )) as any;

    expect(result.error).toContain("Malformed redirect URL");
    expect(result.status).toBe(302);
  });

  it("stops redirect loop when Location header is missing", async () => {
    mockFetch.mockResolvedValueOnce(new Response("no redirect", { status: 302 }));

    const result = (await httpRequestHandler(
      { url: "https://example.com/start", method: "GET" }, "live", openPolicy
    )) as any;

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.body).toBe("no redirect");
  });

  it("resolves relative redirect URLs against the original URL", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: "/relative/path" },
      }))
      .mockResolvedValueOnce(new Response("resolved", { status: 200 }));

    const result = (await httpRequestHandler(
      { url: "https://example.com/start", method: "GET" }, "live", openPolicy
    )) as any;

    expect(result.status).toBe(200);
    const secondCallUrl = mockFetch.mock.calls[1]![0];
    expect(secondCallUrl).toBe("https://example.com/relative/path");
  });
});

/* ------------------------------------------------------------------ *
 *  Response body size limit (readBodyWithLimit)                       *
 * ------------------------------------------------------------------ */

describe("httpRequestHandler — response body size limit", () => {
  beforeEach(() => {
    mockAssertEndpoint.mockReset().mockResolvedValue(undefined);
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects response body exceeding 10 MB", async () => {
    const tenMB = 10 * 1024 * 1024;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(tenMB));
        controller.enqueue(new Uint8Array(1)); // 1 byte over limit
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce(new Response(stream, { status: 200 }));

    await expect(
      httpRequestHandler(
        { url: "https://example.com/big", method: "GET" }, "live", openPolicy
      )
    ).rejects.toThrow(/exceeds.*byte limit/);
  });

  it("accepts response body at exactly 10 MB", async () => {
    const tenMB = 10 * 1024 * 1024;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(tenMB));
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce(new Response(stream, { status: 200 }));

    const result = (await httpRequestHandler(
      { url: "https://example.com/exact", method: "GET" }, "live", openPolicy
    )) as any;

    expect(result.status).toBe(200);
  });

  it("handles response with no body gracefully", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = (await httpRequestHandler(
      { url: "https://example.com/empty", method: "DELETE" }, "live", openPolicy
    )) as any;

    expect(result.status).toBe(204);
    expect(result.body).toBe("");
  });
});

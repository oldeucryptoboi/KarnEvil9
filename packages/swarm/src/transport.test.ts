import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PeerTransport } from "./transport.js";
import type { SwarmNodeIdentity, HeartbeatMessage, SwarmTaskRequest, GossipMessage } from "./types.js";

describe("PeerTransport", () => {
  let transport: PeerTransport;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    transport = new PeerTransport({ token: "test-token", timeout_ms: 5000 });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(status: number, body: unknown, ok = true) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok,
      status,
      statusText: ok ? "OK" : "Error",
      json: () => Promise.resolve(body),
    });
  }

  it("should fetch identity from a peer", async () => {
    const identity: SwarmNodeIdentity = {
      node_id: "remote-1",
      display_name: "Remote",
      api_url: "http://remote:3100",
      capabilities: ["read-file"],
      version: "0.1.0",
    };
    mockFetch(200, identity);

    const result = await transport.fetchIdentity("http://remote:3100");
    expect(result.ok).toBe(true);
    expect(result.data?.node_id).toBe("remote-1");
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("http://remote:3100/api/plugins/swarm/identity");
    expect(call[1].headers.Authorization).toBe("Bearer test-token");
  });

  it("should send heartbeat", async () => {
    mockFetch(200, { ok: true });
    const heartbeat: HeartbeatMessage = {
      node_id: "local-1",
      timestamp: new Date().toISOString(),
      active_sessions: 2,
      load: 0.5,
    };

    const result = await transport.sendHeartbeat("http://remote:3100", heartbeat);
    expect(result.ok).toBe(true);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("http://remote:3100/api/plugins/swarm/heartbeat");
    expect(call[1].method).toBe("POST");
  });

  it("should send task request", async () => {
    mockFetch(200, { accepted: true });
    const request: SwarmTaskRequest = {
      task_id: "task-1",
      originator_node_id: "local-1",
      originator_session_id: "session-1",
      task_text: "Do something",
      correlation_id: "corr-1",
      nonce: "nonce-1",
    };

    const result = await transport.sendTaskRequest("http://remote:3100", request);
    expect(result.ok).toBe(true);
    expect(result.data?.accepted).toBe(true);
  });

  it("should send gossip", async () => {
    const remotePeers: GossipMessage = {
      sender_node_id: "remote-1",
      peers: [{ node_id: "peer-x", api_url: "http://peer-x:3100", status: "active" }],
    };
    mockFetch(200, remotePeers);

    const gossip: GossipMessage = {
      sender_node_id: "local-1",
      peers: [{ node_id: "peer-a", api_url: "http://peer-a:3100", status: "active" }],
    };
    const result = await transport.sendGossip("http://remote:3100", gossip);
    expect(result.ok).toBe(true);
    expect(result.data?.peers).toHaveLength(1);
  });

  it("should handle HTTP error responses", async () => {
    mockFetch(403, { error: "Forbidden" }, false);

    const result = await transport.fetchIdentity("http://remote:3100");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toBe("Forbidden");
  });

  it("should handle network errors", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await transport.fetchIdentity("http://unreachable:3100");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("should handle timeout (AbortError)", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    globalThis.fetch = vi.fn().mockRejectedValue(abortError);

    const result = await transport.fetchIdentity("http://slow:3100");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(408);
    expect(result.error).toContain("timed out");
  });

  it("should strip trailing slash from base URL", async () => {
    mockFetch(200, {});
    await transport.fetchIdentity("http://remote:3100/");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("http://remote:3100/api/plugins/swarm/identity");
  });

  it("should work without auth token", async () => {
    transport = new PeerTransport();
    mockFetch(200, { node_id: "remote" });

    await transport.fetchIdentity("http://remote:3100");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1].headers.Authorization).toBeUndefined();
  });

  // ─── SSRF protection tests ─────────────────────────────────────
  it("rejects private IPv4 peer URLs (127.0.0.1)", async () => {
    mockFetch(200, {});
    const result = await transport.fetchIdentity("http://127.0.0.1:3100");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("SSRF");
    // fetch should NOT have been called
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects 10.x.x.x peer URLs", async () => {
    mockFetch(200, {});
    const result = await transport.sendHeartbeat("http://10.0.0.5:3100", {
      node_id: "local", timestamp: new Date().toISOString(), active_sessions: 0, load: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("SSRF");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects 192.168.x.x peer URLs", async () => {
    mockFetch(200, {});
    const result = await transport.fetchIdentity("http://192.168.1.1:3100");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("SSRF");
  });

  it("rejects 169.254.169.254 (AWS IMDS)", async () => {
    mockFetch(200, {});
    const result = await transport.fetchIdentity("http://169.254.169.254");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("SSRF");
  });

  it("rejects CGNAT 100.64.x.x peer URLs", async () => {
    mockFetch(200, {});
    const result = await transport.fetchIdentity("http://100.64.0.1:3100");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("SSRF");
  });

  it("rejects localhost peer URLs", async () => {
    mockFetch(200, {});
    const result = await transport.fetchIdentity("http://localhost:3100");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("SSRF");
  });

  it("rejects 0.0.0.0 peer URLs", async () => {
    mockFetch(200, {});
    const result = await transport.fetchIdentity("http://0.0.0.0:3100");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("SSRF");
  });

  it("rejects IPv6 loopback peer URLs", async () => {
    mockFetch(200, {});
    const result = await transport.fetchIdentity("http://[::1]:3100");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("SSRF");
  });

  it("rejects non-HTTP protocols (ftp)", async () => {
    mockFetch(200, {});
    const result = await transport.fetchIdentity("ftp://remote:3100");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("SSRF");
  });

  it("allows public IP peer URLs", async () => {
    mockFetch(200, { node_id: "remote-1" });
    const result = await transport.fetchIdentity("http://203.0.113.10:3100");
    expect(result.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  // ─── Path injection protection tests ───────────────────────────
  it("should encode taskId in sendCheckpointRequest URL to prevent path injection", async () => {
    mockFetch(200, { status: "running" });
    await transport.sendCheckpointRequest("http://remote:3100", "task/../../../etc/passwd");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const url = call[0] as string;
    expect(url).not.toContain("../");
    expect(url).toContain(encodeURIComponent("task/../../../etc/passwd"));
  });

  it("should encode taskId in sendCancelTask URL to prevent path injection", async () => {
    mockFetch(200, { ok: true });
    await transport.sendCancelTask("http://remote:3100", "task/../../admin/delete");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const url = call[0] as string;
    expect(url).not.toContain("admin/delete");
    expect(url).toContain(encodeURIComponent("task/../../admin/delete"));
  });

  it("should encode taskId with special characters in checkpoint URL", async () => {
    mockFetch(200, { status: "running" });
    await transport.sendCheckpointRequest("http://remote:3100", "task with spaces & special=chars");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const url = call[0] as string;
    expect(url).not.toContain(" ");
    expect(url).toContain(encodeURIComponent("task with spaces & special=chars"));
  });

  it("should send join message", async () => {
    mockFetch(200, { ok: true });
    const result = await transport.sendJoin("http://remote:3100", {
      identity: {
        node_id: "local-1",
        display_name: "Local",
        api_url: "http://localhost:3100",
        capabilities: [],
        version: "0.1.0",
      },
    });
    expect(result.ok).toBe(true);
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("http://remote:3100/api/plugins/swarm/join");
  });

  it("should send leave message", async () => {
    mockFetch(200, { ok: true });
    const result = await transport.sendLeave("http://remote:3100", {
      node_id: "local-1",
      reason: "shutting down",
    });
    expect(result.ok).toBe(true);
  });
});

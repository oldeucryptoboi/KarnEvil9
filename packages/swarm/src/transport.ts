import { lookup } from "node:dns/promises";
import type {
  SwarmNodeIdentity,
  HeartbeatMessage,
  SwarmTaskRequest,
  SwarmTaskResult,
  GossipMessage,
  JoinMessage,
  LeaveMessage,
  TaskCheckpointStatus,
  TaskRFQ,
  BidObject,
} from "./types.js";

export interface TransportResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  latency_ms: number;
}

export interface PeerTransportConfig {
  token?: string;
  timeout_ms?: number;
}

export class PeerTransport {
  private token?: string;
  private timeoutMs: number;

  constructor(config: PeerTransportConfig = {}) {
    this.token = config.token;
    this.timeoutMs = config.timeout_ms ?? 10000;
  }

  async fetchIdentity(apiUrl: string): Promise<TransportResponse<SwarmNodeIdentity>> {
    return this.send<SwarmNodeIdentity>(apiUrl, "/api/plugins/swarm/identity", "GET");
  }

  async sendHeartbeat(apiUrl: string, heartbeat: HeartbeatMessage): Promise<TransportResponse> {
    return this.send(apiUrl, "/api/plugins/swarm/heartbeat", "POST", heartbeat);
  }

  async sendJoin(apiUrl: string, join: JoinMessage): Promise<TransportResponse> {
    return this.send(apiUrl, "/api/plugins/swarm/join", "POST", join);
  }

  async sendLeave(apiUrl: string, leave: LeaveMessage): Promise<TransportResponse> {
    return this.send(apiUrl, "/api/plugins/swarm/leave", "POST", leave);
  }

  async sendGossip(apiUrl: string, gossip: GossipMessage): Promise<TransportResponse<GossipMessage>> {
    return this.send<GossipMessage>(apiUrl, "/api/plugins/swarm/gossip", "POST", gossip);
  }

  async sendTaskRequest(apiUrl: string, request: SwarmTaskRequest): Promise<TransportResponse<{ accepted: boolean; reason?: string }>> {
    return this.send(apiUrl, "/api/plugins/swarm/task", "POST", request);
  }

  async sendTaskResult(apiUrl: string, result: SwarmTaskResult): Promise<TransportResponse> {
    return this.send(apiUrl, "/api/plugins/swarm/result", "POST", result);
  }

  async sendCheckpointRequest(apiUrl: string, taskId: string): Promise<TransportResponse<TaskCheckpointStatus>> {
    return this.send<TaskCheckpointStatus>(apiUrl, `/api/plugins/swarm/task/${taskId}/status`, "GET");
  }

  async sendCancelTask(apiUrl: string, taskId: string): Promise<TransportResponse> {
    return this.send(apiUrl, `/api/plugins/swarm/task/${taskId}/cancel`, "POST");
  }

  async sendRFQ(apiUrl: string, rfq: TaskRFQ): Promise<TransportResponse> {
    return this.send(apiUrl, "/api/plugins/swarm/rfq", "POST", rfq);
  }

  async sendBid(apiUrl: string, bid: BidObject): Promise<TransportResponse> {
    return this.send(apiUrl, "/api/plugins/swarm/bid", "POST", bid);
  }

  /**
   * Validate that a URL does not point to a private/internal IP address.
   * Prevents SSRF via malicious peer `api_url` values received through gossip.
   */
  private async assertNotPrivateUrl(url: string): Promise<void> {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`SSRF: non-HTTP protocol "${parsed.protocol}"`);
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    // Check hostname directly (catches IP literals)
    if (isPrivateIPv4(hostname) || isPrivateIPv6(hostname) || hostname === "localhost" || hostname === "0.0.0.0") {
      throw new Error(`SSRF: private IP address "${hostname}"`);
    }
    // Resolve hostname to check the actual IP
    try {
      const { address } = await lookup(hostname);
      if (isPrivateIPv4(address)) {
        throw new Error(`SSRF: "${hostname}" resolves to private IP ${address}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("SSRF:")) throw err;
      // DNS lookup failure — allow the fetch to fail naturally
    }
  }

  private async send<T = unknown>(
    baseUrl: string,
    path: string,
    method: string,
    body?: unknown,
  ): Promise<TransportResponse<T>> {
    const url = `${baseUrl.replace(/\/$/, "")}${path}`;
    const start = Date.now();

    // SSRF protection: reject private/internal URLs from gossip-discovered peers
    try {
      await this.assertNotPrivateUrl(url);
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
        latency_ms: Date.now() - start,
      };
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const latency_ms = Date.now() - start;

      if (!response.ok) {
        let errorText: string;
        try {
          const errBody = await response.json() as Record<string, unknown>;
          errorText = typeof errBody.error === "string" ? errBody.error : response.statusText;
        } catch {
          errorText = response.statusText;
        }
        return { ok: false, status: response.status, error: errorText, latency_ms };
      }

      const data = await response.json() as T;
      return { ok: true, status: response.status, data, latency_ms };
    } catch (err) {
      const latency_ms = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        status: isAbort ? 408 : 0,
        error: isAbort ? `Request timed out after ${this.timeoutMs}ms` : message,
        latency_ms,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Private IP helpers (self-contained to avoid cross-package dep) ──

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p))) return false;
  const octets = parts.map(Number);
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return true;                       // 127.0.0.0/8
  if (a === 10) return true;                        // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16
  if (a === 169 && b === 254) return true;          // 169.254.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 0) return true;                         // 0.0.0.0/8
  return false;
}

function isPrivateIPv6(hostname: string): boolean {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const lower = bare.toLowerCase();
  if (lower === "::1" || lower === "::" || lower === "0:0:0:0:0:0:0:1") return true;
  if (lower.startsWith("::ffff:")) return isPrivateIPv4(lower.slice(7));
  if (lower.startsWith("fe80")) return true;  // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;  // unique local
  return false;
}

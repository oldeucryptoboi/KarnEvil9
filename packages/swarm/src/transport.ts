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

  private async send<T = unknown>(
    baseUrl: string,
    path: string,
    method: string,
    body?: unknown,
  ): Promise<TransportResponse<T>> {
    const url = `${baseUrl.replace(/\/$/, "")}${path}`;
    const start = Date.now();
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

/**
 * CDP WebSocket client — connect to Chrome via --remote-debugging-port,
 * send commands, receive events, discover targets via /json/list.
 */

import WebSocket from "ws";
import type {
  CDPRequest,
  CDPResponse,
  CDPEvent,
  CDPTargetInfo,
  CDPVersionInfo,
  CDPMethodMap,
} from "./protocol.js";

export interface CDPClientOptions {
  host?: string;
  port?: number;
  /** Direct WebSocket URL — overrides host/port target discovery */
  wsUrl?: string;
  /** Pre-connected WebSocket — bridge mode (extension CDP bridge) */
  ws?: WebSocket;
}

type EventCallback = (params: Record<string, unknown>) => void;

export class CDPClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (result: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  private eventListeners = new Map<string, Set<EventCallback>>();
  private readonly host: string;
  private readonly port: number;
  private readonly wsUrl?: string;
  private readonly bridgeMode: boolean;
  private _connected = false;

  constructor(options?: CDPClientOptions) {
    this.host = options?.host ?? "localhost";
    this.port = options?.port ?? 9223;
    this.wsUrl = options?.wsUrl;
    this.bridgeMode = !!options?.ws;
    if (options?.ws) {
      this.ws = options.ws;
    }
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Discover available page targets via the HTTP /json/list endpoint. */
  async listTargets(): Promise<CDPTargetInfo[]> {
    if (this.bridgeMode) {
      throw new Error("listTargets() is not available in bridge mode");
    }
    const url = `http://${this.host}:${this.port}/json/list`;
    const response = await fetch(url);
    return response.json() as Promise<CDPTargetInfo[]>;
  }

  /** Get Chrome version info via /json/version. */
  async getVersion(): Promise<CDPVersionInfo> {
    if (this.bridgeMode) {
      throw new Error("getVersion() is not available in bridge mode");
    }
    const url = `http://${this.host}:${this.port}/json/version`;
    const response = await fetch(url);
    return response.json() as Promise<CDPVersionInfo>;
  }

  /** Connect to a CDP WebSocket. Discovers first page target if no wsUrl given. */
  async connect(): Promise<void> {
    // Bridge mode: WebSocket already provided, just attach handlers
    if (this.bridgeMode && this.ws) {
      this.attachHandlers(this.ws);
      this._connected = true;
      return;
    }

    let url = this.wsUrl;
    if (!url) {
      const targets = await this.listTargets();
      const pageTarget = targets.find((t) => t.type === "page");
      if (!pageTarget) {
        throw new Error("No page target found. Open a tab in Chrome first.");
      }
      url = pageTarget.webSocketDebuggerUrl;
    }

    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url!);

      this.ws.on("open", () => {
        this._connected = true;
        resolve();
      });

      this.ws.on("error", (err: Error) => {
        if (!this._connected) {
          reject(new Error(`CDP connection failed: ${err.message}`));
        }
      });

      this.attachHandlers(this.ws);
    });
  }

  /** Attach message and close handlers to a WebSocket. */
  private attachHandlers(ws: WebSocket): void {
    ws.on("message", (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as CDPResponse | CDPEvent;
      if ("id" in msg) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`CDP error: ${msg.error.message} (code ${msg.error.code})`));
          } else {
            pending.resolve(msg.result ?? {});
          }
        }
      } else if ("method" in msg) {
        const listeners = this.eventListeners.get(msg.method);
        if (listeners) {
          for (const cb of listeners) cb(msg.params ?? {});
        }
      }
    });

    ws.on("close", () => {
      this._connected = false;
      // Reject all pending requests
      for (const [, pending] of this.pending) {
        pending.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  /** Send a CDP command and wait for the response. */
  async send<M extends keyof CDPMethodMap>(
    method: M,
    ...args: CDPMethodMap[M]["params"] extends void ? [] : [CDPMethodMap[M]["params"]]
  ): Promise<CDPMethodMap[M]["result"]> {
    if (!this.ws || !this._connected) {
      throw new Error("Not connected to CDP");
    }

    const id = this.nextId++;
    const request: CDPRequest = {
      id,
      method,
      params: args[0] as Record<string, unknown> | undefined,
    };

    return new Promise<CDPMethodMap[M]["result"]>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as unknown as (result: Record<string, unknown>) => void,
        reject,
      });
      this.ws!.send(JSON.stringify(request));
    });
  }

  /** Subscribe to a CDP event. */
  on(method: string, callback: EventCallback): void {
    let listeners = this.eventListeners.get(method);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(method, listeners);
    }
    listeners.add(callback);
  }

  /** Unsubscribe from a CDP event. */
  off(method: string, callback: EventCallback): void {
    const listeners = this.eventListeners.get(method);
    if (listeners) {
      listeners.delete(callback);
      if (listeners.size === 0) this.eventListeners.delete(method);
    }
  }

  /** Wait for a specific CDP event to fire (once). */
  waitForEvent(method: string, timeoutMs = 30000): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(method, handler);
        reject(new Error(`Timeout waiting for CDP event: ${method}`));
      }, timeoutMs);

      const handler = (params: Record<string, unknown>) => {
        clearTimeout(timer);
        this.off(method, handler);
        resolve(params);
      };

      this.on(method, handler);
    });
  }

  /** Close the WebSocket connection. In bridge mode, detach without closing the shared WS. */
  async disconnect(): Promise<void> {
    if (this.ws) {
      this._connected = false;
      if (!this.bridgeMode) {
        this.ws.close();
      }
      // Reject any pending requests
      for (const [, pending] of this.pending) {
        pending.reject(new Error("CDP client disconnected"));
      }
      this.pending.clear();
      this.ws = null;
    }
  }
}

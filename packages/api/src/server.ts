import express from "express";
import { v4 as uuid } from "uuid";
import type { Kernel, ContextBudgetConfig } from "@karnevil9/kernel";
import { Kernel as KernelClass } from "@karnevil9/kernel";
import type { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import type { Journal } from "@karnevil9/journal";
import type { PermissionEngine } from "@karnevil9/permissions";
import type { Planner, Task, ApprovalDecision, ExecutionMode, SessionLimits, PolicyProfile, JournalEvent } from "@karnevil9/schemas";
import { validateJournalEventData } from "@karnevil9/schemas";
import type { PluginRegistry } from "@karnevil9/plugins";
import type { ActiveMemory } from "@karnevil9/memory";
import type { MetricsCollector } from "@karnevil9/metrics";
import { createMetricsRouter } from "@karnevil9/metrics";
import type { Scheduler } from "@karnevil9/scheduler";
import { createSchedulerRoutes } from "@karnevil9/scheduler";
import type { MeshManager } from "@karnevil9/swarm";
import type { ServerResponse, Server, IncomingMessage } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { parse as parseUrl } from "node:url";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve as pathResolve, dirname as pathDirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { WebSocketServer, WebSocket } from "ws";
import { spawn, type ChildProcess } from "node:child_process";
import yaml from "js-yaml";

// ─── Constants ────────────────────────────────────────────────────
const SSE_KEEPALIVE_INTERVAL_MS = 15_000;
const SSE_MAX_LIFETIME_MS = 30 * 60 * 1000;       // 30 minutes
const SSE_MAX_EVENT_BYTES = 100_000;               // 100 KB per broadcast event
const KERNEL_EVICTION_DELAY_MS = 60_000;           // Keep session queryable 60s after completion
const PLANNER_TIMEOUT_MS = 120_000;
const SESSION_TIMEOUT_BUFFER_MS = 30_000;          // Extra buffer beyond max_duration_ms
const RATE_LIMITER_PRUNE_INTERVAL_MS = 60_000;
const MAX_JOURNAL_PAGE = 500;
const MAX_REPLAY_EVENTS = 1000;
const MAX_PLUGIN_BODY_BYTES = 1024 * 1024;         // 1 MB for plugin route bodies
const MAX_IMPORT_BUNDLE_BYTES = 10 * 1024 * 1024;  // 10 MB for session import bundles
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Structured error logging — omits stack traces in production. */
function logError(label: string, err: unknown): void {
  if (process.env.NODE_ENV === "production") {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[api] ${label}: ${msg}`);
  } else {
    console.error(`[api] ${label}:`, err);
  }
}

// ─── Rate Limiter (Sliding Window) ──────────────────────────────────

export class RateLimiter {
  private windows = new Map<string, number[]>();
  /** Insertion-order tracking for LRU eviction */
  private accessOrder: string[] = [];
  readonly maxRequests: number;
  readonly windowMs: number;

  /** Maximum tracked IPs to prevent memory exhaustion */
  static readonly MAX_IPS = 10_000;

  constructor(maxRequests = 100, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(key);
    if (!timestamps) {
      // LRU eviction: if at capacity, drop the oldest-accessed IP
      if (this.windows.size >= RateLimiter.MAX_IPS) {
        this.evictOldest();
      }
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Slide window: remove timestamps older than the window
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }

    // Update LRU access order
    this.touchAccessOrder(key);

    // Record this request
    timestamps.push(now);

    const count = timestamps.length;
    const remaining = Math.max(0, this.maxRequests - count);
    // resetAt: when the oldest request in the window will expire
    const resetAt = timestamps.length > 0 ? timestamps[0]! + this.windowMs : now + this.windowMs;
    const allowed = count <= this.maxRequests;

    return { allowed, remaining, resetAt };
  }

  /** Periodically prune expired entries to prevent memory leak */
  prune(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      // Remove expired timestamps
      while (timestamps.length > 0 && timestamps[0]! < cutoff) {
        timestamps.shift();
      }
      // Delete entries with no remaining timestamps
      if (timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
    // Hard cap: evict oldest-accessed entries if still over limit
    while (this.windows.size > RateLimiter.MAX_IPS) {
      this.evictOldest();
    }
  }

  /** Evict the least-recently-used IP from the windows map */
  private evictOldest(): void {
    // Walk accessOrder from front (oldest) to find one still in the map
    while (this.accessOrder.length > 0) {
      const oldest = this.accessOrder.shift()!;
      if (this.windows.has(oldest)) {
        this.windows.delete(oldest);
        return;
      }
    }
    // Fallback: evict first key from map iteration order
    const firstKey = this.windows.keys().next().value;
    if (firstKey !== undefined) this.windows.delete(firstKey);
  }

  /** Move key to end of access order (most recently used) */
  private touchAccessOrder(key: string): void {
    this.accessOrder.push(key);
    // Periodically compact to avoid unbounded growth of the access order array
    if (this.accessOrder.length > RateLimiter.MAX_IPS * 3) {
      const seen = new Set<string>();
      const compacted: string[] = [];
      // Walk from end (most recent) to front, keeping only the last occurrence
      for (let i = this.accessOrder.length - 1; i >= 0; i--) {
        const k = this.accessOrder[i]!;
        if (!seen.has(k) && this.windows.has(k)) {
          seen.add(k);
          compacted.push(k);
        }
      }
      compacted.reverse();
      this.accessOrder = compacted;
    }
  }

  /** For testing: return current size of tracked IPs */
  get size(): number {
    return this.windows.size;
  }
}

function getClientIP(req: IncomingMessage, trustedProxies?: string[]): string {
  const directIp = req.socket.remoteAddress ?? "unknown";
  // Only trust X-Forwarded-For when the direct connection comes from a known reverse proxy.
  if (trustedProxies && trustedProxies.length > 0 && trustedProxies.includes(directIp)) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      // Walk the chain right-to-left: the rightmost untrusted IP is the real client.
      const ips = forwarded.split(",").map((ip) => ip.trim());
      for (let i = ips.length - 1; i >= 0; i--) {
        const ip = ips[i]!;
        if (!trustedProxies.includes(ip)) return ip;
      }
      // All IPs are trusted proxies — fall back to the leftmost
      return ips[0] ?? directIp;
    }
  }
  return directIp;
}

/** Whitelist safe headers before forwarding to plugin route handlers. */
const SAFE_PLUGIN_HEADERS = new Set([
  "content-type", "accept", "content-length", "user-agent",
  "accept-language", "accept-encoding", "origin", "referer",
]);

function filterSafeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SAFE_PLUGIN_HEADERS.has(key.toLowerCase()) && value !== undefined) {
      filtered[key] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return filtered;
}

// ─── Input Validation ──────────────────────────────────────────────

const VALID_MODES = new Set(["mock", "dry_run", "live"]);
const MAX_TEXT_LENGTH = 10000;
const MAX_SUBMITTED_BY_LENGTH = 200;

function validateSessionInput(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Request body must be a JSON object";
  const b = body as Record<string, unknown>;

  if (typeof b.text !== "string" || b.text.trim().length === 0) return "text is required and must be a non-empty string";
  if (b.text.length > MAX_TEXT_LENGTH) return `text must be at most ${MAX_TEXT_LENGTH} characters`;

  if (b.submitted_by !== undefined && (typeof b.submitted_by !== "string" || b.submitted_by.length > MAX_SUBMITTED_BY_LENGTH)) {
    return `submitted_by must be a string of at most ${MAX_SUBMITTED_BY_LENGTH} characters`;
  }

  if (b.mode !== undefined && (typeof b.mode !== "string" || !VALID_MODES.has(b.mode))) {
    return `mode must be one of: ${[...VALID_MODES].join(", ")}`;
  }

  if (b.constraints !== undefined && (typeof b.constraints !== "object" || Array.isArray(b.constraints))) {
    return "constraints must be an object";
  }

  if (b.limits !== undefined) {
    if (typeof b.limits !== "object" || Array.isArray(b.limits)) return "limits must be an object";
    const limits = b.limits as Record<string, unknown>;
    for (const key of ["max_steps", "max_duration_ms", "max_cost_usd", "max_tokens"]) {
      if (limits[key] !== undefined && (typeof limits[key] !== "number" || !Number.isFinite(limits[key] as number) || (limits[key] as number) <= 0)) {
        return `limits.${key} must be a finite positive number`;
      }
    }
  }

  // policy is server-controlled and not accepted from clients

  return null; // valid
}

function validateApprovalInput(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Request body must be a JSON object";
  const b = body as Record<string, unknown>;

  if (b.decision === undefined) return "decision is required";

  if (typeof b.decision === "string") {
    if (!["allow_once", "allow_session", "allow_always", "deny"].includes(b.decision)) {
      return "decision must be one of: allow_once, allow_session, allow_always, deny";
    }
    return null;
  }

  if (typeof b.decision === "object" && b.decision !== null) {
    const d = b.decision as Record<string, unknown>;
    if (typeof d.type !== "string") return "decision.type is required for object decisions";
    if (!["allow_constrained", "allow_observed", "deny_with_alternative"].includes(d.type)) {
      return `Invalid decision type: ${d.type}`;
    }
    return null;
  }

  return "decision must be a string or object";
}

function validateCompactInput(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Request body must be a JSON object";
  const b = body as Record<string, unknown>;

  if (b.retain_sessions !== undefined) {
    if (!Array.isArray(b.retain_sessions)) return "retain_sessions must be an array";
    if (!b.retain_sessions.every((s: unknown) => typeof s === "string")) return "retain_sessions must contain only strings";
  }

  return null;
}

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  request: unknown;
  timer: ReturnType<typeof setTimeout>;
  created_at: number;
}

interface SSEClient {
  res: ServerResponse;
  paused: boolean;
  missedEvents: number;
}

interface WSClient {
  ws: WebSocket;
  activeSessionIds: Set<string>;
}

export interface ApiServerConfig {
  toolRegistry: ToolRegistry;
  journal: Journal;
  toolRuntime?: ToolRuntime;
  permissions?: PermissionEngine;
  planner?: Planner;
  pluginRegistry?: PluginRegistry;
  defaultMode?: ExecutionMode;
  defaultLimits?: SessionLimits;
  defaultPolicy?: PolicyProfile;
  maxConcurrentSessions?: number;
  maxSseClientsPerSession?: number;
  agentic?: boolean;
  apiToken?: string;
  /** Set to true to explicitly allow running without an API token. */
  insecure?: boolean;
  metricsCollector?: MetricsCollector;
  scheduler?: Scheduler;
  approvalTimeoutMs?: number;
  corsOrigins?: string | string[];
  swarm?: MeshManager;
  activeMemory?: ActiveMemory;
  contextBudgetConfig?: ContextBudgetConfig;
  checkpointDir?: string;
  /** IP addresses of trusted reverse proxies; enables X-Forwarded-For parsing. */
  trustedProxies?: string[];
  /** Name advertised via Bonjour/mDNS (e.g. "EDDIE"). Defaults to OS hostname. */
  serviceName?: string;
  /** Rate limiter configuration. */
  rateLimit?: { windowMs?: number; maxRequests?: number };
}

/** Validate numeric config values at startup to fail fast on misconfigurations. */
function validateApiConfig(config: ApiServerConfig): void {
  const errors: string[] = [];
  if (config.maxConcurrentSessions !== undefined) {
    if (!Number.isInteger(config.maxConcurrentSessions) || config.maxConcurrentSessions < 1) {
      errors.push("maxConcurrentSessions must be a positive integer");
    }
  }
  if (config.maxSseClientsPerSession !== undefined) {
    if (!Number.isInteger(config.maxSseClientsPerSession) || config.maxSseClientsPerSession < 1) {
      errors.push("maxSseClientsPerSession must be a positive integer");
    }
  }
  if (config.approvalTimeoutMs !== undefined) {
    if (typeof config.approvalTimeoutMs !== "number" || config.approvalTimeoutMs < 0) {
      errors.push("approvalTimeoutMs must be a non-negative number");
    }
  }
  if (config.defaultLimits) {
    const l = config.defaultLimits;
    if (l.max_steps !== undefined && (!Number.isInteger(l.max_steps) || l.max_steps < 1)) {
      errors.push("defaultLimits.max_steps must be a positive integer");
    }
    if (l.max_duration_ms !== undefined && (typeof l.max_duration_ms !== "number" || l.max_duration_ms < 1000)) {
      errors.push("defaultLimits.max_duration_ms must be >= 1000");
    }
  }
  if (config.trustedProxies) {
    for (const p of config.trustedProxies) {
      if (typeof p !== "string" || p.trim().length === 0) {
        errors.push("trustedProxies entries must be non-empty strings");
        break;
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`Invalid API server configuration:\n  - ${errors.join("\n  - ")}`);
  }
}

export class ApiServer {
  private app: express.Application;
  private kernels = new Map<string, Kernel>();
  private activeSessions = new Set<string>();
  private toolRegistry: ToolRegistry;
  private toolRuntime?: ToolRuntime;
  private journal: Journal;
  private permissions?: PermissionEngine;
  private planner?: Planner;
  private defaultMode: ExecutionMode;
  private defaultLimits: SessionLimits;
  private defaultPolicy: PolicyProfile;
  private pendingApprovals = new Map<string, PendingApproval>();
  private sseClients = new Map<string, SSEClient[]>();
  private pluginRegistry?: PluginRegistry;
  private maxConcurrentSessions: number;
  private maxSseClientsPerSession: number;
  private agentic: boolean;
  private apiToken?: string;
  private metricsCollector?: MetricsCollector;
  private scheduler?: Scheduler;
  private swarm?: MeshManager;
  private activeMemory?: ActiveMemory;
  private contextBudgetConfig?: ContextBudgetConfig;
  private checkpointDir?: string;
  private approvalTimeoutMs: number;
  private corsOrigins?: string | string[];
  private trustedProxies?: string[];
  private httpServer?: Server;
  private rateLimiter: RateLimiter;
  private rateLimiterPruneInterval?: ReturnType<typeof setInterval>;
  private journalUnsubscribe?: () => void;
  private wss?: WebSocketServer;
  private wsClients = new Set<WSClient>();
  private serviceName?: string;
  private dnssdProcess?: ChildProcess;
  /** API key rotation: old keys kept for a grace period */
  private rotatedKeys = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly KEY_ROTATION_GRACE_MS = 5 * 60 * 1000; // 5 minutes
  private insecureMode: boolean = false;

  constructor(config: ApiServerConfig);
  constructor(toolRegistry: ToolRegistry, journal: Journal);
  constructor(configOrRegistry: ApiServerConfig | ToolRegistry, journal?: Journal) {
    this.app = express();
    this.app.use(express.json({ limit: "1mb" }));
    // Security headers
    this.app.use((_req, res, next) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("X-XSS-Protection", "0");
      res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      res.setHeader("Cache-Control", "no-store");
      next();
    });
    if (journal !== undefined) {
      // Legacy constructor: (toolRegistry, journal)
      const toolRegistry = configOrRegistry as ToolRegistry;
      this.toolRegistry = toolRegistry;
      this.journal = journal;
      // toolRuntime, permissions, planner remain undefined (optional)
      this.defaultMode = "live";
      this.defaultLimits = { max_steps: 30, max_duration_ms: 300000, max_cost_usd: 5, max_tokens: 200000, max_iterations: 15 };
      this.defaultPolicy = { allowed_paths: [], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: true };
      this.maxConcurrentSessions = 50;
      this.maxSseClientsPerSession = 10;
      this.agentic = false;
      this.approvalTimeoutMs = 300000; // 5 minutes
      this.insecureMode = true;
      this.rateLimiter = new RateLimiter();
      this.rateLimiterPruneInterval = setInterval(() => this.rateLimiter.prune(), RATE_LIMITER_PRUNE_INTERVAL_MS);
      this.rateLimiterPruneInterval.unref();
      // No token in legacy constructor — unauthenticated
    } else {
      const config = configOrRegistry as ApiServerConfig;
      validateApiConfig(config);
      this.toolRegistry = config.toolRegistry;
      this.toolRuntime = config.toolRuntime;
      this.journal = config.journal;
      this.permissions = config.permissions;
      this.planner = config.planner;
      this.pluginRegistry = config.pluginRegistry;
      this.defaultMode = config.defaultMode ?? "live";
      this.defaultLimits = config.defaultLimits ?? { max_steps: 30, max_duration_ms: 300000, max_cost_usd: 5, max_tokens: 200000, max_iterations: 15 };
      this.defaultPolicy = config.defaultPolicy ?? { allowed_paths: [], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: true };
      this.maxConcurrentSessions = config.maxConcurrentSessions ?? 50;
      this.maxSseClientsPerSession = config.maxSseClientsPerSession ?? 10;
      this.agentic = config.agentic ?? false;
      this.apiToken = config.apiToken;
      this.metricsCollector = config.metricsCollector;
      this.scheduler = config.scheduler;
      this.swarm = config.swarm;
      this.activeMemory = config.activeMemory;
      this.contextBudgetConfig = config.contextBudgetConfig;
      this.checkpointDir = config.checkpointDir;
      this.approvalTimeoutMs = config.approvalTimeoutMs ?? 300000; // 5 minutes
      this.corsOrigins = config.corsOrigins;
      this.trustedProxies = config.trustedProxies;
      this.serviceName = config.serviceName;
      this.insecureMode = config.insecure === true;
      const rlWindow = config.rateLimit?.windowMs ?? 60000;
      const rlMax = config.rateLimit?.maxRequests ?? 100;
      this.rateLimiter = new RateLimiter(rlMax, rlWindow);
      this.rateLimiterPruneInterval = setInterval(() => this.rateLimiter.prune(), RATE_LIMITER_PRUNE_INTERVAL_MS);
      this.rateLimiterPruneInterval.unref();
    }
    if (this.metricsCollector) {
      this.metricsCollector.attach(this.journal);
    }
    if (!this.apiToken) {
      const insecure = journal !== undefined ? true : (configOrRegistry as ApiServerConfig).insecure === true;
      if (!insecure) {
        throw new Error(
          "API token is required. Set apiToken in config, KARNEVIL9_API_TOKEN env var, or pass insecure: true (--insecure) to allow unauthenticated access."
        );
      }
      console.warn("[api] WARNING: Running in insecure mode — all endpoints are unauthenticated.");
    }
    // CORS middleware
    if (this.corsOrigins === "*") {
      console.warn("[api] WARNING: CORS wildcard origin '*' allows any website to make requests. Use explicit origins in production.");
    }
    if (this.corsOrigins) {
      const origins = this.corsOrigins;
      this.app.use((req, res, next) => {
        const origin = req.headers.origin;
        const allowed = typeof origins === "string"
          ? origins === "*" || origin === origins
          : origin !== undefined && (origins.includes("*") || origins.includes(origin));
        if (allowed && origin) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
          res.setHeader("Access-Control-Max-Age", "86400");
        }
        if (req.method === "OPTIONS") { res.status(204).end(); return; }
        next();
      });
    }
    this.setupRoutes();
    this.journalUnsubscribe = this.journal.on((event) => {
      this.broadcastEvent(event.session_id, event);
      this.broadcastWsEvent(event.session_id, event);
    });
  }

  registerKernel(sessionId: string, kernel: Kernel): void { this.kernels.set(sessionId, kernel); }

  private static readonly MAX_PENDING_APPROVALS = 10_000;

  registerApproval(requestId: string, request: unknown, resolve: (decision: ApprovalDecision) => void): void {
    // Reject request IDs with control characters at registration time for audit trail consistency
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional security check for control chars
    if (/[\x00-\x1f\x7f]/.test(requestId)) {
      resolve("deny");
      return;
    }
    // Cap pending approvals to prevent unbounded memory growth
    if (this.pendingApprovals.size >= ApiServer.MAX_PENDING_APPROVALS) {
      resolve("deny");
      return;
    }
    const timer = setTimeout(() => {
      if (this.pendingApprovals.has(requestId)) {
        this.pendingApprovals.delete(requestId);
        resolve("deny"); // Auto-deny on timeout
      }
    }, this.approvalTimeoutMs);
    this.pendingApprovals.set(requestId, { resolve, request, timer, created_at: Date.now() });

    // Broadcast approve.needed to ALL WS clients so dashboard and session-specific
    // clients both receive real-time approval notifications
    const req = request as Record<string, unknown> | undefined;
    const sessionId = typeof req?.session_id === "string" ? req.session_id : undefined;
    const approveMsg = {
      type: "approve.needed",
      request_id: requestId,
      session_id: sessionId,
      request,
    };
    for (const client of this.wsClients) {
      this.wsSend(client.ws, approveMsg);
    }
  }

  broadcastEvent(sessionId: string, data: unknown): void {
    const clients = this.sseClients.get(sessionId);
    if (!clients) return;
    const event = data as JournalEvent;
    const seqId = event.seq !== undefined ? `id: ${event.seq}\n` : "";
    const payload = JSON.stringify(data);
    if (payload.length > SSE_MAX_EVENT_BYTES) {
      logError("SSE broadcast", new Error(`Dropped oversized event (${payload.length} bytes > ${SSE_MAX_EVENT_BYTES}) for session ${sessionId}, type=${event.type}`));
      return;
    }
    const msg = `${seqId}data: ${payload}\n\n`;
    const toRemove: SSEClient[] = [];
    for (const client of clients) {
      if (client.paused) {
        client.missedEvents++;
        if (client.missedEvents > 1000) {
          try { client.res.end(); } catch { /* response already destroyed */ }
          toRemove.push(client);
        }
        continue;
      }
      if (client.res.destroyed) {
        toRemove.push(client);
        continue;
      }
      const ok = client.res.write(msg);
      if (!ok) {
        client.paused = true;
        client.missedEvents++;
      }
    }
    if (toRemove.length > 0) {
      const remaining = clients.filter((c) => !toRemove.includes(c));
      if (remaining.length === 0) this.sseClients.delete(sessionId);
      else this.sseClients.set(sessionId, remaining);
    }
  }

  listen(port: number): Server {
    this.httpServer = this.app.listen(port, () => {
      const addr = this.httpServer!.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      console.log(`KarnEvil9 API listening on http://localhost:${actualPort}`);
      this.publishBonjour(actualPort);
    });
    this.setupWebSocket(this.httpServer);
    return this.httpServer;
  }

  private publishBonjour(port: number): void {
    const name = this.serviceName || require("node:os").hostname() as string;
    try {
      // Use dns-sd CLI which registers with the system mDNSResponder.
      // This works reliably on macOS/Linux and is visible to iOS NWBrowser.
      // dns-sd -R <name> <type> <domain> <port> — runs until killed.
      const proc = spawn("dns-sd", ["-R", name, "_karnevil9._tcp", "local.", String(port)], {
        stdio: "ignore",
        detached: false,
      });
      proc.unref();
      this.dnssdProcess = proc;
      proc.on("error", (err) => {
        console.warn(`Bonjour: dns-sd failed — ${err.message}`);
        this.dnssdProcess = undefined;
      });
      proc.on("exit", (code) => {
        if (code !== null && code !== 0) {
          console.warn(`Bonjour: dns-sd exited with code ${code}`);
        }
        this.dnssdProcess = undefined;
      });
      console.log(`Bonjour: advertising "${name}" as _karnevil9._tcp on port ${port}`);
    } catch (err) {
      console.warn(`Bonjour: failed to publish — ${err instanceof Error ? err.message : err}`);
    }
  }

  async shutdown(): Promise<void> {
    // Auto-deny all pending approvals
    for (const [id, approval] of this.pendingApprovals) {
      clearTimeout(approval.timer);
      approval.resolve("deny");
      this.pendingApprovals.delete(id);
    }
    // Abort all running kernels
    const abortPromises: Promise<void>[] = [];
    for (const kernel of this.kernels.values()) {
      abortPromises.push(kernel.abort().catch(() => { /* best effort */ }));
    }
    await Promise.allSettled(abortPromises);
    // Close all SSE connections
    for (const [, clients] of this.sseClients) {
      for (const client of clients) client.res.end();
    }
    this.sseClients.clear();
    // Close all WebSocket connections
    for (const client of this.wsClients) {
      client.ws.close(1001, "Server shutting down");
    }
    this.wsClients.clear();
    if (this.wss) this.wss.close();
    // Unsubscribe journal listener
    if (this.journalUnsubscribe) this.journalUnsubscribe();
    // Stop rate limiter pruning
    if (this.rateLimiterPruneInterval) clearInterval(this.rateLimiterPruneInterval);
    // Clear rotated key grace timers
    for (const timer of this.rotatedKeys.values()) clearTimeout(timer);
    this.rotatedKeys.clear();
    // Stop scheduler
    if (this.scheduler) await this.scheduler.stop();
    // Detach metrics
    if (this.metricsCollector) this.metricsCollector.detach();
    // Wait for pending journal writes to flush
    await this.journal.close();
    // Unpublish Bonjour service
    if (this.dnssdProcess) {
      this.dnssdProcess.kill();
      this.dnssdProcess = undefined;
    }
    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    }
  }

  getExpressApp(): express.Application { return this.app; }

  private setupWebSocket(server: Server): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req: IncomingMessage, socket, head) => {
      const parsed = parseUrl(req.url ?? "", true);
      if (parsed.pathname !== "/api/ws") {
        socket.destroy();
        return;
      }

      // Authenticate via ?token= query param
      if (this.apiToken) {
        const token = parsed.query.token;
        if (typeof token !== "string") {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        const provided = Buffer.from(token);
        const expected = Buffer.from(this.apiToken);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.wss!.emit("connection", ws, req);
      });
    });

    this.wss.on("connection", (ws: WebSocket) => {
      const client: WSClient = { ws, activeSessionIds: new Set() };
      this.wsClients.add(client);

      ws.on("message", async (raw: Buffer | string) => {
        // Cap WS message size to prevent DoS via oversized payloads (64 KB)
        const MAX_WS_MESSAGE_SIZE = 64 * 1024;
        const rawLength = typeof raw === "string" ? raw.length : raw.byteLength;
        if (rawLength > MAX_WS_MESSAGE_SIZE) {
          this.wsSend(ws, { type: "error", message: `Message too large (${rawLength} bytes, max ${MAX_WS_MESSAGE_SIZE})` });
          return;
        }
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf-8"));
        } catch {
          this.wsSend(ws, { type: "error", message: "Invalid JSON" });
          return;
        }

        try {
          switch (msg.type) {
            case "submit":
              await this.handleWsSubmit(client, msg);
              break;
            case "abort":
              await this.handleWsAbort(msg);
              break;
            case "approve":
              this.handleWsApprove(msg);
              break;
            case "ping":
              this.wsSend(ws, { type: "pong" });
              break;
            default:
              this.wsSend(ws, { type: "error", message: `Unknown message type: ${String(msg.type)}` });
          }
        } catch (err) {
          this.wsSend(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });

      ws.on("close", () => {
        client.activeSessionIds.clear();
        this.wsClients.delete(client);
      });

      ws.on("error", () => {
        client.activeSessionIds.clear();
        this.wsClients.delete(client);
      });
    });
  }

  private wsSend(ws: WebSocket, data: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(data));
    } catch {
      // Socket closed between readyState check and send — ignore
    }
  }

  private broadcastWsEvent(sessionId: string, event: JournalEvent): void {
    for (const client of this.wsClients) {
      if (client.activeSessionIds.has(sessionId)) {
        this.wsSend(client.ws, { type: "event", session_id: sessionId, event });
      }
    }
  }

  private async handleWsSubmit(client: WSClient, msg: Record<string, unknown>): Promise<void> {
    const text = msg.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      this.wsSend(client.ws, { type: "error", message: "text is required and must be a non-empty string" });
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      this.wsSend(client.ws, { type: "error", message: `text must be at most ${MAX_TEXT_LENGTH} characters` });
      return;
    }
    if (this.activeSessions.size >= this.maxConcurrentSessions) {
      this.wsSend(client.ws, { type: "error", message: "Max concurrent sessions reached" });
      return;
    }
    if (!this.toolRuntime || !this.permissions || !this.planner) {
      this.wsSend(client.ws, { type: "error", message: "Server not fully configured" });
      return;
    }

    const mode = (typeof msg.mode === "string" && VALID_MODES.has(msg.mode)) ? msg.mode as ExecutionMode : this.defaultMode;
    const task: Task = { task_id: uuid(), text: text.trim(), created_at: new Date().toISOString() };

    const kernel = new KernelClass({
      journal: this.journal,
      toolRuntime: this.toolRuntime,
      toolRegistry: this.toolRegistry,
      permissions: this.permissions,
      pluginRegistry: this.pluginRegistry,
      planner: this.planner,
      mode,
      limits: this.defaultLimits,
      policy: this.defaultPolicy,
      agentic: this.agentic,
      activeMemory: this.activeMemory,
      preGrantedScopes: this.pluginRegistry?.getPluginPermissions(),
      ...(this.agentic && this.contextBudgetConfig ? { contextBudgetConfig: this.contextBudgetConfig } : {}),
      ...(this.checkpointDir ? { checkpointDir: this.checkpointDir } : {}),
      plannerTimeoutMs: PLANNER_TIMEOUT_MS,
      plannerRetries: 2,
    });

    const session = await kernel.createSession(task);
    this.kernels.set(session.session_id, kernel);
    this.activeSessions.add(session.session_id);
    client.activeSessionIds.add(session.session_id);

    this.wsSend(client.ws, { type: "session.created", session_id: session.session_id, task });

    // Replay the session.created journal event that was emitted during createSession()
    // before this client was subscribed to the session ID.
    this.wsSend(client.ws, {
      type: "event",
      session_id: session.session_id,
      event: {
        type: "session.created",
        session_id: session.session_id,
        timestamp: session.created_at,
        payload: { task_id: task.task_id, task_text: task.text, mode: session.mode },
      },
    });

    this.runSessionLifecycle(kernel, session.session_id, this.defaultLimits.max_duration_ms);
  }

  private async handleWsAbort(msg: Record<string, unknown>): Promise<void> {
    const sessionId = msg.session_id;
    if (typeof sessionId !== "string") return;
    const kernel = this.kernels.get(sessionId);
    if (kernel) await kernel.abort();
  }

  private handleWsApprove(msg: Record<string, unknown>): void {
    const requestId = msg.request_id;
    if (typeof requestId !== "string") return;
    const approval = this.pendingApprovals.get(requestId);
    if (!approval) return;
    // Validate decision payload — same validation as the REST endpoint
    const validationError = validateApprovalInput({ decision: msg.decision });
    if (validationError) return;
    // Atomically remove from map first to prevent double-resolution race
    // (concurrent WS + REST approve on the same request_id)
    this.pendingApprovals.delete(requestId);
    clearTimeout(approval.timer);
    // Reject expired approvals
    const age = Date.now() - approval.created_at;
    if (age > this.approvalTimeoutMs * 2) {
      return;
    }
    const decision = msg.decision as ApprovalDecision;
    approval.resolve(decision);

    // Broadcast approve.resolved to all WS clients so dashboard updates in real time
    const req = approval.request as Record<string, unknown> | undefined;
    const sessionId = typeof req?.session_id === "string" ? req.session_id : undefined;
    const resolvedMsg = {
      type: "approve.resolved",
      request_id: requestId,
      session_id: sessionId,
      decision,
    };
    for (const client of this.wsClients) {
      this.wsSend(client.ws, resolvedMsg);
    }
  }

  /** Shared session lifecycle: timeout, error broadcast, cleanup. */
  private runSessionLifecycle(kernel: Kernel, sessionId: string, maxDurationMs: number): void {
    const sessionTimeoutMs = maxDurationMs + SESSION_TIMEOUT_BUFFER_MS;
    const kernelPromise = kernel.run();
    let sessionTimer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      sessionTimer = setTimeout(() => reject(new Error(`Session timed out after ${sessionTimeoutMs}ms`)), sessionTimeoutMs);
      sessionTimer.unref();
    });
    Promise.race([kernelPromise, timeoutPromise])
      .catch((err) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        // Persist failure to journal so replays/reconnects can see it
        this.journal.emit(sessionId, "session.failed", { error: errorMsg }).catch(() => {});
        try {
          this.broadcastEvent(sessionId, {
            type: "session.failed",
            session_id: sessionId,
            payload: { error: errorMsg },
            timestamp: new Date().toISOString(),
          });
        } catch (broadcastErr) {
          logError("runSessionLifecycle broadcast", broadcastErr);
        }
      })
      .finally(() => {
        clearTimeout(sessionTimer!);
        this.activeSessions.delete(sessionId);
        setTimeout(() => this.kernels.delete(sessionId), KERNEL_EVICTION_DELAY_MS).unref();
      })
      .catch((err) => {
        logError("runSessionLifecycle unhandled", err);
      });
  }

  async discoverRecoverableSessions(): Promise<string[]> {
    const sessions = new Map<string, Set<string>>();
    try {
      for await (const event of this.journal.readAllStream()) {
        const types = sessions.get(event.session_id) ?? new Set();
        types.add(event.type);
        sessions.set(event.session_id, types);
      }
    } catch {
      // Return partial results if the journal stream errors mid-read
    }
    const terminalTypes = new Set(["session.completed", "session.failed", "session.aborted"]);
    const recoverable: string[] = [];
    for (const [sessionId, types] of sessions) {
      if (!types.has("session.started") || !types.has("plan.accepted")) continue;
      if ([...types].some((t) => terminalTypes.has(t))) continue;
      recoverable.push(sessionId);
    }
    return recoverable;
  }

  private setupRoutes(): void {
    const router = express.Router();

    // Health check is always unauthenticated
    router.get("/health", async (_req, res) => {
      const journalHealth = await this.journal.checkHealth();
      const toolCount = this.toolRegistry.list().length;
      const activeSessionCount = this.activeSessions.size;

      const journalStatus = journalHealth.writable ? "ok" as const : "error" as const;
      const toolsStatus = toolCount > 0 ? "ok" as const : "warning" as const;
      const diskWarning = journalHealth.disk_usage && journalHealth.disk_usage.usage_pct > 90;
      const overallStatus = journalStatus === "error" ? "degraded" : diskWarning ? "warning" : "healthy";

      res.json({
        status: overallStatus,
        version: "0.1.0",
        timestamp: new Date().toISOString(),
        checks: {
          journal: {
            status: journalStatus,
            detail: journalHealth.writable ? "writable" : "not writable",
            ...(journalHealth.disk_usage ? { disk_usage: journalHealth.disk_usage } : {}),
          },
          tools: { status: toolsStatus, loaded: toolCount },
          sessions: { status: "ok", active: activeSessionCount },
          planner: { status: this.planner ? "ok" : "unavailable" },
          permissions: { status: this.permissions ? "ok" : "unavailable" },
          runtime: { status: this.toolRuntime ? "ok" : "unavailable" },
          plugins: {
            status: this.pluginRegistry ? "ok" : "unavailable",
            loaded: this.pluginRegistry?.listPlugins().filter((p) => p.status === "active").length ?? 0,
            failed: this.pluginRegistry?.listPlugins().filter((p) => p.status === "failed").length ?? 0,
          },
          scheduler: {
            status: this.scheduler ? (this.scheduler.isRunning() ? "ok" : "stopped") : "unavailable",
            schedules: this.scheduler?.listSchedules().length ?? 0,
          },
          swarm: {
            status: this.swarm ? (this.swarm.isRunning ? "ok" : "stopped") : "unavailable",
            peers: this.swarm?.peerCount ?? 0,
            active_peers: this.swarm?.getActivePeers().length ?? 0,
          },
        },
      });
    });

    // ─── API Docs (unauthenticated) ──────────────────────────────────
    // Load OpenAPI spec from YAML and serve as JSON + interactive Swagger UI
    let openApiSpec: Record<string, unknown> | null = null;
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = pathDirname(__filename);
      const specPath = pathResolve(__dirname, "..", "openapi.yaml");
      const specYaml = readFileSync(specPath, "utf-8");
      openApiSpec = yaml.load(specYaml) as Record<string, unknown>;
    } catch (err) {
      logError("Failed to load openapi.yaml", err);
    }

    router.get("/docs/openapi.json", (_req, res) => {
      if (!openApiSpec) {
        res.status(500).json({ error: "OpenAPI spec not loaded" });
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.json(openApiSpec);
    });

    // Serve Swagger UI static assets with relaxed CSP
    try {
      const esmRequire = createRequire(import.meta.url);
      const swaggerUiPath = pathDirname(esmRequire.resolve("swagger-ui-dist/package.json"));
      router.use("/docs/assets", (_req, res, next) => {
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:");
        next();
      }, express.static(swaggerUiPath));
    } catch {
      logError("swagger-ui-dist", "swagger-ui-dist not found — /api/docs UI will be unavailable");
    }

    router.get("/docs", (_req, res) => {
      // Override security headers for the docs page so Swagger UI can load its assets
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:");
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>KarnEvil9 API Docs</title>
  <link rel="stylesheet" href="/api/docs/assets/swagger-ui.css" />
  <style>body { margin: 0; padding: 0; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/api/docs/assets/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: "/api/docs/openapi.json",
      dom_id: "#swagger-ui",
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: "BaseLayout",
    });
  </script>
</body>
</html>`);
    });

    // Bearer token auth middleware — applied to all routes after /health
    if (this.apiToken) {
      router.use((req, res, next) => {
        const auth = req.headers.authorization;
        const clientIp = getClientIP(req, this.trustedProxies);
        const safePath = req.path.replace(/[\r\n]/g, "");
        if (!auth || !auth.startsWith("Bearer ")) {
          console.warn(`[api] AUTH_FAIL: missing/malformed Authorization header from ${clientIp} ${req.method} ${safePath}`);
          this.journal.emit("_system", "auth.failed", { ip: clientIp, method: req.method, path: safePath, reason: "missing_or_malformed_header" }).catch(() => {});
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
        const providedToken = auth.slice(7);
        const provided = Buffer.from(providedToken);

        // Check current API token
        const expected = Buffer.from(this.apiToken!);
        const currentMatch = provided.length === expected.length && timingSafeEqual(provided, expected);

        // Check rotated (grace period) keys
        let rotatedMatch = false;
        if (!currentMatch) {
          for (const oldKey of this.rotatedKeys.keys()) {
            const oldBuf = Buffer.from(oldKey);
            if (provided.length === oldBuf.length && timingSafeEqual(provided, oldBuf)) {
              rotatedMatch = true;
              break;
            }
          }
        }

        if (!currentMatch && !rotatedMatch) {
          console.warn(`[api] AUTH_FAIL: invalid token from ${clientIp} ${req.method} ${safePath}`);
          this.journal.emit("_system", "auth.failed", { ip: clientIp, method: req.method, path: safePath, reason: "invalid_token" }).catch(() => {});
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
        // Strip the raw token so it cannot leak in error handler logs
        delete req.headers.authorization;
        next();
      });
    }

    // Rate limiting — applied after auth, before business routes
    // Health endpoint is exempt from rate limiting
    router.use((req, res, next) => {
      if (req.path === "/health") { next(); return; }
      const ip = getClientIP(req, this.trustedProxies);
      const result = this.rateLimiter.check(ip);
      res.setHeader("X-RateLimit-Limit", String(this.rateLimiter.maxRequests));
      res.setHeader("X-RateLimit-Remaining", String(result.remaining));
      res.setHeader("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
      if (!result.allowed) {
        const retryAfterSec = Math.ceil((result.resetAt - Date.now()) / 1000);
        res.setHeader("Retry-After", String(Math.max(1, retryAfterSec)));
        this.journal.emit("_system", "auth.rate_limited", { ip, method: req.method, path: req.path.replace(/[\r\n]/g, "") }).catch(() => {});
        res.status(429).json({ error: "Rate limit exceeded. Try again later." });
        return;
      }
      next();
    });

    // ─── API Key Rotation ──────────────────────────────────────────────
    router.post("/auth/rotate-key", (req, res) => {
      if (this.insecureMode || !this.apiToken) {
        res.status(403).json({ error: "Key rotation is only available when authentication is enabled" });
        return;
      }
      const oldKey = this.apiToken;
      const newKey = randomUUID();
      this.apiToken = newKey;

      // Keep old key valid for 5-minute grace period
      const graceTimer = setTimeout(() => {
        this.rotatedKeys.delete(oldKey);
      }, ApiServer.KEY_ROTATION_GRACE_MS);
      graceTimer.unref();
      this.rotatedKeys.set(oldKey, graceTimer);

      const rotatedAt = new Date().toISOString();
      this.journal.emit("_system", "auth.key_rotated", { rotated_at: rotatedAt, ip: getClientIP(req, this.trustedProxies) }).catch(() => {});
      res.json({ new_key: newKey, rotated_at: rotatedAt });
    });

    // Metrics endpoint (behind auth)
    if (this.metricsCollector) {
      const metricsRoute = createMetricsRouter(this.metricsCollector);
      router.get(metricsRoute.path, async (req: express.Request, res: express.Response) => {
        try {
          await metricsRoute.handler(
            { method: req.method, path: req.path, params: req.params as Record<string, string>, query: req.query as Record<string, string>, body: req.body },
            {
              json: (data: unknown) => res.json(data),
              text: (data: string, contentType?: string) => { res.set("Content-Type", contentType ?? "text/plain; charset=utf-8"); res.end(data); },
              status: (code: number) => ({
                json: (data: unknown) => res.status(code).json(data),
                text: (data: string, contentType?: string) => { res.status(code).set("Content-Type", contentType ?? "text/plain; charset=utf-8").end(data); },
              }),
            }
          );
        } catch {
          res.status(500).json({ error: "Error collecting metrics" });
        }
      });
    }

    router.get("/sessions", async (_req, res) => {
      const sessionMap = new Map<string, Record<string, unknown>>();

      // Active in-memory sessions (authoritative)
      for (const [, kernel] of this.kernels) {
        const s = kernel.getSession();
        if (s) {
          sessionMap.set(s.session_id, {
            session_id: s.session_id,
            status: s.status,
            created_at: s.created_at,
            updated_at: s.updated_at,
            task_text: s.task?.text,
            mode: s.mode,
          });
        }
      }

      // Historical sessions from journal (fill in what's not in memory)
      for (const sid of this.journal.getKnownSessionIds()) {
        if (sessionMap.has(sid)) continue;
        const events = await this.journal.readSession(sid, { limit: 1 });
        if (events.length === 0) continue;
        const first = events[0]!;
        const allEvents = await this.journal.readSession(sid);
        const createdEvt = allEvents.find((e) => e.type === "session.created");
        const terminalEvt = [...allEvents].reverse().find((e) =>
          e.type === "session.completed" || e.type === "session.failed" || e.type === "session.aborted"
        );
        const statusMap: Record<string, string> = {
          "session.completed": "completed",
          "session.failed": "failed",
          "session.aborted": "aborted",
        };
        sessionMap.set(sid, {
          session_id: sid,
          status: terminalEvt ? (statusMap[terminalEvt.type] ?? "unknown") : "unknown",
          created_at: first.timestamp,
          task_text: (createdEvt?.payload?.task_text as string) ?? (createdEvt?.payload?.task as string) ?? undefined,
          mode: (createdEvt?.payload?.mode as string) ?? undefined,
        });
      }

      res.json({ sessions: [...sessionMap.values()] });
    });

    router.post("/sessions", async (req, res) => {
      try {
        const validationError = validateSessionInput(req.body);
        if (validationError) { res.status(400).json({ error: validationError }); return; }
        if (this.activeSessions.size >= this.maxConcurrentSessions) {
          res.status(429).json({ error: "Max concurrent sessions reached" });
          return;
        }
        const { text, constraints, submitted_by, mode, limits } = req.body as {
          text: string;
          constraints?: Record<string, unknown>;
          submitted_by?: string;
          mode?: ExecutionMode;
          limits?: Partial<SessionLimits>;
        };
        const task: Task = { task_id: uuid(), text, constraints, submitted_by, created_at: new Date().toISOString() };

        if (this.toolRuntime && this.permissions && this.planner) {
          // Clamp client-supplied limits to server-configured maximums
          const effectiveLimits = { ...this.defaultLimits };
          if (limits) {
            if (typeof limits.max_steps === "number") effectiveLimits.max_steps = Math.min(limits.max_steps, this.defaultLimits.max_steps);
            if (typeof limits.max_duration_ms === "number") effectiveLimits.max_duration_ms = Math.min(limits.max_duration_ms, this.defaultLimits.max_duration_ms);
            if (typeof limits.max_cost_usd === "number") effectiveLimits.max_cost_usd = Math.min(limits.max_cost_usd, this.defaultLimits.max_cost_usd);
            if (typeof limits.max_tokens === "number") effectiveLimits.max_tokens = Math.min(limits.max_tokens, this.defaultLimits.max_tokens);
          }
          // Policy is server-controlled — clients cannot override security boundaries
          const kernelConfig = {
            journal: this.journal,
            toolRuntime: this.toolRuntime,
            toolRegistry: this.toolRegistry,
            permissions: this.permissions,
            pluginRegistry: this.pluginRegistry,
            planner: this.planner,
            mode: mode ?? this.defaultMode,
            limits: effectiveLimits,
            policy: this.defaultPolicy,
            agentic: this.agentic,
            activeMemory: this.activeMemory,
            preGrantedScopes: this.pluginRegistry?.getPluginPermissions(),
            ...(this.agentic && this.contextBudgetConfig ? { contextBudgetConfig: this.contextBudgetConfig } : {}),
            ...(this.checkpointDir ? { checkpointDir: this.checkpointDir } : {}),
            plannerTimeoutMs: PLANNER_TIMEOUT_MS,
            plannerRetries: 2,
          };
          const kernel = new KernelClass(kernelConfig);
          const session = await kernel.createSession(task);
          this.kernels.set(session.session_id, kernel);
          this.activeSessions.add(session.session_id);

          this.runSessionLifecycle(kernel, session.session_id, effectiveLimits.max_duration_ms);

          res.json({ session_id: session.session_id, status: session.status, task });
        } else {
          res.json({ task, message: "Task created. Use a kernel to start a session." });
        }
      } catch (err) { logError("POST /sessions", err); res.status(500).json({ error: "Internal server error" }); }
    });

    router.get("/sessions/:id", (req, res) => {
      if (!UUID_RE.test(req.params.id!)) { res.status(400).json({ error: "Invalid session ID format" }); return; }
      const kernel = this.kernels.get(req.params.id!);
      if (!kernel) { res.status(404).json({ error: "Session not found" }); return; }
      res.json(kernel.getSession());
    });

    router.post("/sessions/:id/abort", async (req, res) => {
      if (!UUID_RE.test(req.params.id!)) { res.status(400).json({ error: "Invalid session ID format" }); return; }
      const kernel = this.kernels.get(req.params.id!);
      if (!kernel) { res.status(404).json({ error: "Session not found" }); return; }
      await kernel.abort();
      res.json({ status: "aborted" });
    });

    router.get("/sessions/:id/journal", async (req, res) => {
      if (!UUID_RE.test(req.params.id!)) { res.status(400).json({ error: "Invalid session ID format" }); return; }
      try {
        const offset = Math.max(0, parseInt(req.query.offset as string, 10) || 0);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit as string, 10) || MAX_JOURNAL_PAGE), MAX_JOURNAL_PAGE);
        const total = this.journal.getSessionEventCount(req.params.id!);
        const events = await this.journal.readSession(req.params.id!, { offset, limit });
        res.json({ events, total, offset, limit });
      } catch (err) { logError("GET /sessions/:id/journal", err); res.status(500).json({ error: "Internal server error" }); }
    });

    router.get("/sessions/:id/stream", async (req, res) => {
      if (!UUID_RE.test(req.params.id!)) { res.status(400).json({ error: "Invalid session ID format" }); return; }
      const sessionId = req.params.id!;
      const existingClients = this.sseClients.get(sessionId) ?? [];
      if (existingClients.length >= this.maxSseClientsPerSession) {
        res.status(429).json({ error: "Max SSE clients per session reached" });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });

      // Replay catch-up from Last-Event-ID or after_seq query param
      const lastEventId = req.headers["last-event-id"] as string | undefined;
      const afterSeqParam = req.query.after_seq as string | undefined;
      const rawAfterSeq = lastEventId !== undefined ? parseInt(lastEventId, 10) : afterSeqParam !== undefined ? parseInt(afterSeqParam, 10) : NaN;
      const afterSeq = Number.isNaN(rawAfterSeq) || !Number.isSafeInteger(rawAfterSeq) || rawAfterSeq < 0
        ? undefined
        : rawAfterSeq;

      if (afterSeq !== undefined) {
        const MAX_REPLAY = 500;
        try {
          // Use offset to skip events before afterSeq, avoiding unbounded memory when afterSeq is large.
          // afterSeq is a seq number (0-based), so offset = afterSeq + 1 skips past it.
          const replayOffset = Math.min(afterSeq + 1, Number.MAX_SAFE_INTEGER - MAX_REPLAY);
          const events = await this.journal.readSession(sessionId, { offset: replayOffset, limit: MAX_REPLAY + 1 });
          let replayCount = 0;
          const serverResForReplay = res as unknown as ServerResponse;
          for (const event of events) {
            if (serverResForReplay.destroyed) break;
            if (event.seq === undefined || !Number.isSafeInteger(event.seq)) continue;
            if (event.seq > afterSeq) {
              if (replayCount >= MAX_REPLAY) {
                res.write(`data: ${JSON.stringify({ type: "replay.truncated", remaining: events.length - replayCount })}\n\n`);
                break;
              }
              const seqId = `id: ${event.seq}\n`;
              res.write(`${seqId}data: ${JSON.stringify(event)}\n\n`);
              replayCount++;
            }
          }
        } catch (err) {
          logError("SSE replay", err);
          res.write(`data: ${JSON.stringify({ type: "replay.error", message: "Failed to replay events" })}\n\n`);
        }
      }

      // Express Response extends Node ServerResponse — cast once for SSE plumbing
      const serverRes = res as unknown as ServerResponse;
      const client: SSEClient = { res: serverRes, paused: false, missedEvents: 0 };
      const clients = this.sseClients.get(sessionId) ?? [];
      clients.push(client);
      this.sseClients.set(sessionId, clients);

      const keepalive = setInterval(() => {
        if (!client.paused && !serverRes.destroyed) res.write(":keepalive\n\n");
      }, SSE_KEEPALIVE_INTERVAL_MS);
      keepalive.unref();

      const onDrain = () => {
        client.paused = false;
        client.missedEvents = 0;
      };
      serverRes.on("drain", onDrain);

      const maxLifetime = setTimeout(() => {
        res.end();
      }, SSE_MAX_LIFETIME_MS);
      maxLifetime.unref();

      let sseCleaned = false;
      const cleanupSse = () => {
        if (sseCleaned) return;
        sseCleaned = true;
        clearInterval(keepalive);
        clearTimeout(maxLifetime);
        serverRes.off("drain", onDrain);
        const remaining = (this.sseClients.get(sessionId) ?? []).filter((c) => c !== client);
        if (remaining.length === 0) this.sseClients.delete(sessionId);
        else this.sseClients.set(sessionId, remaining);
      };
      req.on("close", cleanupSse);
      req.on("error", cleanupSse);
    });

    router.get("/approvals", (_req, res) => {
      const pending = [...this.pendingApprovals.entries()].map(([id, { request }]) => ({ request_id: id, request }));
      res.json({ pending });
    });

    router.post("/approvals/:id", (req, res) => {
      const approvalError = validateApprovalInput(req.body);
      if (approvalError) { res.status(400).json({ error: approvalError }); return; }
      const approval = this.pendingApprovals.get(req.params.id!);
      if (!approval) { res.status(404).json({ error: "Approval not found" }); return; }
      // Atomically remove from map first to prevent double-resolution race
      // (concurrent WS + REST approve on the same request_id)
      this.pendingApprovals.delete(req.params.id!);
      clearTimeout(approval.timer);
      // Reject approvals that have been pending longer than twice the timeout
      const age = Date.now() - approval.created_at;
      if (age > this.approvalTimeoutMs * 2) {
        res.status(410).json({ error: "Approval request has expired" });
        return;
      }
      const { decision } = req.body as { decision: ApprovalDecision };
      approval.resolve(decision);
      // Broadcast approve.resolved to all WS clients
      const approvalReq = approval.request as Record<string, unknown> | undefined;
      const approvalSessionId = typeof approvalReq?.session_id === "string" ? approvalReq.session_id : undefined;
      const resolvedMsg = {
        type: "approve.resolved",
        request_id: req.params.id!,
        session_id: approvalSessionId,
        decision,
      };
      for (const client of this.wsClients) {
        this.wsSend(client.ws, resolvedMsg);
      }
      // Audit trail: log who approved what (sanitize to prevent log injection)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitization of control chars
      const requestId = req.params.id!.replace(/[\x00-\x1f\x7f]/g, "");
      const sourceIp = getClientIP(req, this.trustedProxies);
      const decisionStr = typeof decision === "string" ? decision : typeof decision === "object" && decision !== null && "type" in decision ? (decision as { type: string }).type : "unknown";
      console.log(`[api] Approval resolved: request_id=${requestId} decision=${decisionStr} source_ip=${sourceIp}`);
      res.json({ status: "resolved", decision });
    });

    router.get("/tools", (_req, res) => {
      const tools = this.toolRegistry.list().map((t) => ({
        name: t.name, version: t.version, description: t.description,
        permissions: t.permissions, runner: t.runner, supports: t.supports,
      }));
      res.json({ tools });
    });

    router.get("/tools/:name", (req, res) => {
      const tool = this.toolRegistry.get(req.params.name!);
      if (!tool) { res.status(404).json({ error: "Tool not found" }); return; }
      res.json(tool);
    });

    router.post("/sessions/:id/replay", async (req, res) => {
      if (!UUID_RE.test(req.params.id!)) { res.status(400).json({ error: "Invalid session ID format" }); return; }
      try {
        const totalEvents = this.journal.getSessionEventCount(req.params.id!);
        if (totalEvents === 0) { res.status(404).json({ error: "No events found for session" }); return; }
        const events = await this.journal.readSession(req.params.id!, { limit: MAX_REPLAY_EVENTS });
        const truncated = totalEvents > MAX_REPLAY_EVENTS;
        res.json({ session_id: req.params.id, event_count: events.length, total_events: totalEvents, truncated, events });
      } catch (err) { logError("POST /sessions/:id/replay", err); res.status(500).json({ error: "Internal server error" }); }
    });

    router.post("/sessions/:id/recover", async (req, res) => {
      if (!UUID_RE.test(req.params.id!)) { res.status(400).json({ error: "Invalid session ID format" }); return; }
      try {
        const sessionId = req.params.id!;
        if (this.kernels.has(sessionId)) {
          res.status(409).json({ error: "Session already active" });
          return;
        }
        if (this.activeSessions.size >= this.maxConcurrentSessions) {
          res.status(429).json({ error: "Max concurrent sessions reached" });
          return;
        }
        if (!this.toolRuntime || !this.permissions || !this.planner) {
          res.status(503).json({ error: "Server not fully configured for recovery" });
          return;
        }
        const kernel = new KernelClass({
          journal: this.journal,
          toolRuntime: this.toolRuntime,
          toolRegistry: this.toolRegistry,
          permissions: this.permissions,
          planner: this.planner,
          mode: this.defaultMode,
          limits: this.defaultLimits,
          policy: this.defaultPolicy,
          plannerTimeoutMs: PLANNER_TIMEOUT_MS,
          plannerRetries: 2,
        });
        const session = await kernel.resumeSession(sessionId);
        if (!session) {
          res.status(404).json({ error: "Session not recoverable" });
          return;
        }
        this.kernels.set(sessionId, kernel);
        this.activeSessions.add(sessionId);

        this.runSessionLifecycle(kernel, sessionId, this.defaultLimits.max_duration_ms);

        res.json({ session_id: sessionId, status: session.status });
      } catch (err) { logError("POST /sessions/:id/recover", err); res.status(500).json({ error: "Internal server error" }); }
    });

    // ─── Session Export / Import ─────────────────────────────────────

    router.get("/sessions/:id/export", async (req, res) => {
      try {
        const rawId = req.params.id!;
        // Sanitize session ID to prevent path traversal
        if (!SAFE_SESSION_ID_RE.test(rawId)) { res.status(400).json({ error: "Invalid session ID format" }); return; }

        // Try in-memory kernel first, then fall back to journal
        const kernel = this.kernels.get(rawId);
        const session = kernel ? kernel.getSession() : null;
        const events = await this.journal.readSession(rawId);

        if (!session && events.length === 0) {
          res.status(404).json({ error: "Session not found" });
          return;
        }

        // Reconstruct session from journal if not in memory
        let sessionObj: Record<string, unknown>;
        if (session) {
          sessionObj = { ...session };
        } else {
          const createdEvt = events.find((e) => e.type === "session.created");
          const terminalEvt = [...events].reverse().find((e) =>
            e.type === "session.completed" || e.type === "session.failed" || e.type === "session.aborted"
          );
          const statusMap: Record<string, string> = {
            "session.completed": "completed",
            "session.failed": "failed",
            "session.aborted": "aborted",
          };
          sessionObj = {
            session_id: rawId,
            status: terminalEvt ? (statusMap[terminalEvt.type] ?? "unknown") : "unknown",
            created_at: events[0]!.timestamp,
            task_text: (createdEvt?.payload?.task_text as string) ?? (createdEvt?.payload?.task as string) ?? undefined,
            mode: (createdEvt?.payload?.mode as string) ?? undefined,
          };
        }

        // Extract plan from journal events
        const planEvent = [...events].reverse().find((e) => e.type === "plan.accepted");
        const plan = (planEvent?.payload?.plan as Record<string, unknown> | undefined) ?? null;

        const bundle = {
          version: 1,
          exported_at: new Date().toISOString(),
          session: sessionObj,
          events,
          plan,
        };

        res.setHeader("Content-Disposition", `attachment; filename="session-${rawId}.json"`);
        res.json(bundle);
      } catch (err) { logError("GET /sessions/:id/export", err); res.status(500).json({ error: "Internal server error" }); }
    });

    router.post("/sessions/import", express.json({ limit: "10mb" }), async (req, res) => {
      try {
        // Check content-length before parsing (defense in depth — express.json handles parsing limit)
        const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);
        if (contentLength > MAX_IMPORT_BUNDLE_BYTES) {
          res.status(413).json({ error: "Import bundle too large (max 10MB)" });
          return;
        }

        const body = req.body;
        if (!body || typeof body !== "object") {
          res.status(400).json({ error: "Request body must be a JSON object" });
          return;
        }

        const { version, session, events } = body as {
          version?: unknown;
          session?: unknown;
          events?: unknown;
        };

        // Validate required fields
        if (version === undefined || version === null) {
          res.status(400).json({ error: "Missing required field: version" });
          return;
        }
        if (typeof version !== "number" || version !== 1) {
          res.status(400).json({ error: "Unsupported bundle version" });
          return;
        }
        if (!session || typeof session !== "object") {
          res.status(400).json({ error: "Missing or invalid required field: session" });
          return;
        }
        if (!Array.isArray(events)) {
          res.status(400).json({ error: "Missing or invalid required field: events" });
          return;
        }

        // Validate each event against the schema
        for (let i = 0; i < events.length; i++) {
          const evt = events[i];
          const validation = validateJournalEventData(evt);
          if (!validation.valid) {
            res.status(400).json({ error: `Invalid event at index ${i}: ${validation.errors.join(", ")}` });
            return;
          }
        }

        // Create a new session ID for the imported session
        const newSessionId = `imported-${uuid()}`;

        // Replay all events into the journal under the new session ID
        let imported = 0;
        for (const evt of events as JournalEvent[]) {
          await this.journal.emit(newSessionId, evt.type, evt.payload);
          imported++;
        }

        res.json({ session_id: newSessionId, events_imported: imported });
      } catch (err) { logError("POST /sessions/import", err); res.status(500).json({ error: "Internal server error" }); }
    });

    // ─── Plugin Management Routes ─────────────────────────────────────

    router.get("/plugins", async (_req, res) => {
      if (!this.pluginRegistry) { res.json({ plugins: [], available: [] }); return; }
      // Refresh discovered to pick up any new plugins on disk
      try { await this.pluginRegistry.refreshDiscovered(); } catch { /* non-critical */ }
      const loaded = this.pluginRegistry.listPlugins();
      const loadedIds = new Set(loaded.map((p) => p.id));
      const discovered = this.pluginRegistry.listDiscovered();
      // Build "available" list: discovered plugins that are not in the loaded set
      const available = discovered
        .filter((d) => !loadedIds.has(d.manifest.id))
        .map((d) => ({
          id: d.manifest.id,
          manifest: d.manifest,
          status: "available" as const,
          config: {},
        }));
      res.json({ plugins: loaded, available });
    });

    router.get("/plugins/:id", (req, res) => {
      if (!this.pluginRegistry) { res.status(404).json({ error: "Plugin system not configured" }); return; }
      const plugin = this.pluginRegistry.getPlugin(req.params.id!);
      if (!plugin) { res.status(404).json({ error: "Plugin not found" }); return; }
      res.json(plugin);
    });

    router.post("/plugins/:id/reload", async (req, res) => {
      if (!this.pluginRegistry) { res.status(404).json({ error: "Plugin system not configured" }); return; }
      const pluginId = req.params.id!;
      const existing = this.pluginRegistry.getPlugin(pluginId);
      if (!existing || existing.status === "unloaded") {
        res.status(404).json({ error: `Plugin "${pluginId}" is not loaded` });
        return;
      }
      try {
        console.log(`[api] PLUGIN_RELOAD: plugin_id=${pluginId} source_ip=${getClientIP(req, this.trustedProxies)}`);
        const state = await this.pluginRegistry.reloadPlugin(pluginId);
        res.json(state);
      } catch (err) { logError("POST /plugins/:id/reload", err); res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" }); }
    });

    router.post("/plugins/:id/unload", async (req, res) => {
      if (!this.pluginRegistry) { res.status(404).json({ error: "Plugin system not configured" }); return; }
      const pluginId = req.params.id!;
      const existing = this.pluginRegistry.getPlugin(pluginId);
      if (!existing || existing.status === "unloaded") {
        res.status(404).json({ error: `Plugin "${pluginId}" is not loaded` });
        return;
      }
      try {
        console.log(`[api] PLUGIN_UNLOAD: plugin_id=${pluginId} source_ip=${getClientIP(req, this.trustedProxies)}`);
        await this.pluginRegistry.unloadPlugin(pluginId);
        res.json({ status: "unloaded", id: pluginId });
      } catch (err) { logError("POST /plugins/:id/unload", err); res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" }); }
    });

    router.post("/plugins/:id/install", async (req, res) => {
      if (!this.pluginRegistry) { res.status(404).json({ error: "Plugin system not configured" }); return; }
      const pluginId = req.params.id!;
      try {
        // Refresh discovered to ensure we have the latest
        await this.pluginRegistry.refreshDiscovered();
        console.log(`[api] PLUGIN_INSTALL: plugin_id=${pluginId} source_ip=${getClientIP(req, this.trustedProxies)}`);
        const state = await this.pluginRegistry.installPlugin(pluginId);
        res.json(state);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("already loaded")) {
          res.status(409).json({ error: message });
        } else if (message.includes("not found")) {
          res.status(404).json({ error: message });
        } else {
          logError("POST /plugins/:id/install", err);
          res.status(500).json({ error: message });
        }
      }
    });

    // ─── Plugin-Provided Routes ─────────────────────────────────────

    const registerRoute = (method: string, path: string, handler: (req: express.Request, res: express.Response) => Promise<void>) => {
      switch (method) {
        case "get": router.get(path, handler); break;
        case "post": router.post(path, handler); break;
        case "put": router.put(path, handler); break;
        case "delete": router.delete(path, handler); break;
        case "patch": router.patch(path, handler); break;
      }
    };

    if (this.pluginRegistry) {
      for (const route of this.pluginRegistry.getRoutes()) {
        const method = route.method.toLowerCase();
        registerRoute(method, route.path.replace("/api/", "/"), async (req: express.Request, res: express.Response) => {
            // Validate plugin request body size
            if (req.body && JSON.stringify(req.body).length > MAX_PLUGIN_BODY_BYTES) {
              res.status(413).json({ error: "Plugin request body too large" });
              return;
            }
            try {
              await route.handler(
                {
                  method: req.method,
                  path: req.path,
                  params: req.params as Record<string, string>,
                  query: req.query as Record<string, string>,
                  body: req.body,
                  headers: filterSafeHeaders(req.headers),
                },
                {
                  json: (data: unknown) => res.json(data),
                  text: (data: string, contentType?: string) => {
                    res.set("Content-Type", contentType ?? "text/plain; charset=utf-8");
                    res.end(data);
                  },
                  status: (code: number) => ({
                    json: (data: unknown) => res.status(code).json(data),
                    text: (data: string, contentType?: string) => {
                      res.status(code).set("Content-Type", contentType ?? "text/plain; charset=utf-8").end(data);
                    },
                  }),
                }
              );
            } catch (err) {
              logError("plugin route error", err); res.status(500).json({ error: "Internal server error" });
            }
          });
      }
    }

    // ─── Scheduler Routes ───────────────────────────────────────────────

    if (this.scheduler) {
      const schedulerRoutes = createSchedulerRoutes(this.scheduler);
      for (const route of schedulerRoutes) {
        const method = route.method.toLowerCase();
        registerRoute(method, route.path, async (req: express.Request, res: express.Response) => {
            try {
              await route.handler(
                {
                  method: req.method,
                  path: req.path,
                  params: req.params as Record<string, string>,
                  query: req.query as Record<string, string>,
                  body: req.body,
                },
                {
                  json: (data: unknown) => res.json(data),
                  text: (data: string, contentType?: string) => {
                    res.set("Content-Type", contentType ?? "text/plain; charset=utf-8");
                    res.end(data);
                  },
                  status: (code: number) => ({
                    json: (data: unknown) => res.status(code).json(data),
                    text: (data: string, contentType?: string) => {
                      res.status(code).set("Content-Type", contentType ?? "text/plain; charset=utf-8").end(data);
                    },
                  }),
                }
              );
            } catch (err) {
              logError("scheduler route error", err);
              res.status(500).json({ error: "Internal server error" });
            }
          });
      }
    }

    router.post("/journal/compact", async (req, res) => {
      try {
        const compactError = validateCompactInput(req.body);
        if (compactError) { res.status(400).json({ error: compactError }); return; }
        const { retain_sessions } = req.body as { retain_sessions?: string[] };
        const result = await this.journal.compact(retain_sessions);
        res.json(result);
      } catch (err) { logError("POST /journal/compact", err); res.status(500).json({ error: "Internal server error" }); }
    });

    // ─── Coverage Report ──────────────────────────────────────────────
    router.get("/coverage", (_req, res) => {
      try {
        // Find the monorepo root (3 levels up from packages/api/src)
        const __filename = fileURLToPath(import.meta.url);
        const monorepoRoot = pathResolve(pathDirname(__filename), "../../..");

        const packagesDir = pathJoin(monorepoRoot, "packages");
        if (!existsSync(packagesDir)) {
          res.status(404).json({ error: "No coverage data found. Run `pnpm test:coverage` to generate." });
          return;
        }

        const packages: Record<string, unknown> = {};
        const total: Record<string, { total: number; covered: number; pct: number }> = {
          statements: { total: 0, covered: 0, pct: 0 },
          branches: { total: 0, covered: 0, pct: 0 },
          functions: { total: 0, covered: 0, pct: 0 },
          lines: { total: 0, covered: 0, pct: 0 },
        };

        let foundAny = false;
        let latestTimestamp = 0;

        const pkgDirs = readdirSync(packagesDir);
        for (const pkgName of pkgDirs) {
          // Reject path traversal segments and hidden directories
          if (pkgName.includes("..") || pkgName.includes("/") || pkgName.includes("\\") || pkgName.startsWith(".")) continue;
          const summaryPath = pathJoin(packagesDir, pkgName, "coverage", "coverage-summary.json");
          // Ensure resolved path stays within the packages directory (symlink guard)
          if (!pathResolve(summaryPath).startsWith(packagesDir + "/")) continue;
          if (!existsSync(summaryPath)) continue;

          try {
            const raw = readFileSync(summaryPath, "utf-8");
            // Safe parse: strip prototype pollution keys
            const summary = JSON.parse(raw, (key, value) => {
              if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
              return value;
            }) as Record<string, Record<string, { total: number; covered: number; pct: number }>>;
            const pkgTotal = summary.total;
            if (!pkgTotal) continue;

            foundAny = true;
            packages[pkgName] = pkgTotal;

            // Accumulate totals
            for (const key of ["statements", "branches", "functions", "lines"] as const) {
              const entry = pkgTotal[key];
              if (entry) {
                total[key]!.total += entry.total;
                total[key]!.covered += entry.covered;
              }
            }

            // Track latest modification time for "last generated" timestamp
            const st = statSync(summaryPath);
            if (st.mtimeMs > latestTimestamp) latestTimestamp = st.mtimeMs;
          } catch {
            // Skip malformed coverage files
          }
        }

        if (!foundAny) {
          res.status(404).json({ error: "No coverage data found. Run `pnpm test:coverage` to generate." });
          return;
        }

        // Calculate overall percentages
        for (const key of ["statements", "branches", "functions", "lines"] as const) {
          const entry = total[key]!;
          entry.pct = entry.total > 0 ? Math.round((entry.covered / entry.total) * 10000) / 100 : 0;
        }

        res.json({
          total,
          packages,
          generated_at: new Date(latestTimestamp).toISOString(),
        });
      } catch (err) {
        logError("GET /coverage", err);
        res.status(500).json({ error: "Internal server error" });
      }
    });

    this.app.use("/api", router);
  }
}

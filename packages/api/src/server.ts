import express from "express";
import { v4 as uuid } from "uuid";
import type { Kernel } from "@jarvis/kernel";
import { Kernel as KernelClass } from "@jarvis/kernel";
import type { ToolRegistry, ToolRuntime } from "@jarvis/tools";
import type { Journal } from "@jarvis/journal";
import type { PermissionEngine } from "@jarvis/permissions";
import type { Planner, Task, ApprovalDecision, ExecutionMode, SessionLimits, PolicyProfile, JournalEvent } from "@jarvis/schemas";
import type { PluginRegistry } from "@jarvis/plugins";
import type { MetricsCollector } from "@jarvis/metrics";
import { createMetricsRouter } from "@jarvis/metrics";
import type { ServerResponse, Server } from "node:http";
import { timingSafeEqual } from "node:crypto";

// ─── Input Validation ──────────────────────────────────────────────

const VALID_MODES = new Set(["mock", "dry_run", "real"]);
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
      if (limits[key] !== undefined && (typeof limits[key] !== "number" || (limits[key] as number) <= 0)) {
        return `limits.${key} must be a positive number`;
      }
    }
  }

  if (b.policy !== undefined) {
    if (typeof b.policy !== "object" || Array.isArray(b.policy)) return "policy must be an object";
  }

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
}

interface SSEClient {
  res: ServerResponse;
  paused: boolean;
  missedEvents: number;
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
  approvalTimeoutMs?: number;
  corsOrigins?: string | string[];
}

export class ApiServer {
  private app: express.Application;
  private kernels = new Map<string, Kernel>();
  private activeSessionCount = 0;
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
  private approvalTimeoutMs: number;
  private corsOrigins?: string | string[];
  private httpServer?: Server;

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
      res.setHeader("Content-Security-Policy", "default-src 'none'");
      res.setHeader("Cache-Control", "no-store");
      next();
    });
    if (journal !== undefined) {
      // Legacy constructor: (toolRegistry, journal)
      const toolRegistry = configOrRegistry as ToolRegistry;
      this.toolRegistry = toolRegistry;
      this.journal = journal;
      // toolRuntime, permissions, planner remain undefined (optional)
      this.defaultMode = "mock";
      this.defaultLimits = { max_steps: 20, max_duration_ms: 300000, max_cost_usd: 10, max_tokens: 100000 };
      this.defaultPolicy = { allowed_paths: [], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: true };
      this.maxConcurrentSessions = 50;
      this.maxSseClientsPerSession = 10;
      this.agentic = false;
      this.approvalTimeoutMs = 300000; // 5 minutes
      // No token in legacy constructor — unauthenticated
    } else {
      const config = configOrRegistry as ApiServerConfig;
      this.toolRegistry = config.toolRegistry;
      this.toolRuntime = config.toolRuntime;
      this.journal = config.journal;
      this.permissions = config.permissions;
      this.planner = config.planner;
      this.pluginRegistry = config.pluginRegistry;
      this.defaultMode = config.defaultMode ?? "mock";
      this.defaultLimits = config.defaultLimits ?? { max_steps: 20, max_duration_ms: 300000, max_cost_usd: 10, max_tokens: 100000 };
      this.defaultPolicy = config.defaultPolicy ?? { allowed_paths: [], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: true };
      this.maxConcurrentSessions = config.maxConcurrentSessions ?? 50;
      this.maxSseClientsPerSession = config.maxSseClientsPerSession ?? 10;
      this.agentic = config.agentic ?? false;
      this.apiToken = config.apiToken;
      this.metricsCollector = config.metricsCollector;
      this.approvalTimeoutMs = config.approvalTimeoutMs ?? 300000; // 5 minutes
      this.corsOrigins = config.corsOrigins;
    }
    if (this.metricsCollector) {
      this.metricsCollector.attach(this.journal);
    }
    if (!this.apiToken) {
      const insecure = journal !== undefined ? true : (configOrRegistry as ApiServerConfig).insecure === true;
      if (!insecure) {
        throw new Error(
          "API token is required. Set apiToken in config, JARVIS_API_TOKEN env var, or pass insecure: true (--insecure) to allow unauthenticated access."
        );
      }
      console.warn("[api] WARNING: Running in insecure mode — all endpoints are unauthenticated.");
    }
    // CORS middleware
    if (this.corsOrigins) {
      const origins = this.corsOrigins;
      this.app.use((req, res, next) => {
        const origin = req.headers.origin;
        const allowed = typeof origins === "string"
          ? origins === "*" || origin === origins
          : origin !== undefined && origins.includes(origin);
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
    this.journal.on((event) => { this.broadcastEvent(event.session_id, event); });
  }

  registerKernel(sessionId: string, kernel: Kernel): void { this.kernels.set(sessionId, kernel); }

  registerApproval(requestId: string, request: unknown, resolve: (decision: ApprovalDecision) => void): void {
    const timer = setTimeout(() => {
      if (this.pendingApprovals.has(requestId)) {
        this.pendingApprovals.delete(requestId);
        resolve("deny"); // Auto-deny on timeout
      }
    }, this.approvalTimeoutMs);
    this.pendingApprovals.set(requestId, { resolve, request, timer });
  }

  broadcastEvent(sessionId: string, data: unknown): void {
    const clients = this.sseClients.get(sessionId);
    if (!clients) return;
    const event = data as JournalEvent;
    const seqId = event.seq !== undefined ? `id: ${event.seq}\n` : "";
    const msg = `${seqId}data: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      if (client.paused) {
        client.missedEvents++;
        if (client.missedEvents > 1000) {
          client.res.end();
          const remaining = clients.filter((c) => c !== client);
          if (remaining.length === 0) this.sseClients.delete(sessionId);
          else this.sseClients.set(sessionId, remaining);
        }
        continue;
      }
      const ok = client.res.write(msg);
      if (!ok) {
        client.paused = true;
        client.missedEvents++;
      }
    }
  }

  listen(port: number): Server {
    this.httpServer = this.app.listen(port, () => { console.log(`Jarvis API listening on http://localhost:${port}`); });
    return this.httpServer;
  }

  async shutdown(): Promise<void> {
    // Auto-deny all pending approvals
    for (const [id, approval] of this.pendingApprovals) {
      clearTimeout(approval.timer);
      approval.resolve("deny");
      this.pendingApprovals.delete(id);
    }
    // Close all SSE connections
    for (const [, clients] of this.sseClients) {
      for (const client of clients) client.res.end();
    }
    this.sseClients.clear();
    // Detach metrics
    if (this.metricsCollector) this.metricsCollector.detach();
    // Wait for pending journal writes to flush
    await this.journal.close();
    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    }
  }

  getExpressApp(): express.Application { return this.app; }

  async discoverRecoverableSessions(): Promise<string[]> {
    const allEvents = await this.journal.readAll();
    const sessions = new Map<string, Set<string>>();
    for (const event of allEvents) {
      const types = sessions.get(event.session_id) ?? new Set();
      types.add(event.type);
      sessions.set(event.session_id, types);
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
      const activeSessionCount = this.activeSessionCount;

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
        },
      });
    });

    // Metrics endpoint (unauthenticated, like /health)
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
          res.status(500).set("Content-Type", "text/plain").end("# Error collecting metrics\n");
        }
      });
    }

    // Bearer token auth middleware — applied to all routes after /health
    if (this.apiToken) {
      const token = this.apiToken;
      router.use((req, res, next) => {
        const auth = req.headers.authorization;
        if (!auth || !auth.startsWith("Bearer ")) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
        const provided = Buffer.from(auth.slice(7));
        const expected = Buffer.from(token);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
        next();
      });
    }

    router.post("/sessions", async (req, res) => {
      try {
        const validationError = validateSessionInput(req.body);
        if (validationError) { res.status(400).json({ error: validationError }); return; }
        if (this.activeSessionCount >= this.maxConcurrentSessions) {
          res.status(429).json({ error: "Max concurrent sessions reached" });
          return;
        }
        const { text, constraints, submitted_by, mode, limits, policy } = req.body as {
          text: string;
          constraints?: Record<string, unknown>;
          submitted_by?: string;
          mode?: ExecutionMode;
          limits?: Partial<SessionLimits>;
          policy?: Partial<PolicyProfile>;
        };
        const task: Task = { task_id: uuid(), text, constraints, submitted_by, created_at: new Date().toISOString() };

        if (this.toolRuntime && this.permissions && this.planner) {
          const kernelConfig = {
            journal: this.journal,
            toolRuntime: this.toolRuntime,
            toolRegistry: this.toolRegistry,
            permissions: this.permissions,
            planner: this.planner,
            mode: mode ?? this.defaultMode,
            limits: { ...this.defaultLimits, ...limits },
            policy: { ...this.defaultPolicy, ...policy },
            agentic: this.agentic,
          };
          const kernel = new KernelClass(kernelConfig);
          const session = await kernel.createSession(task);
          this.kernels.set(session.session_id, kernel);
          this.activeSessionCount++;

          // Run in background — enforce outer timeout, clean up on completion
          const sessionTimeoutMs = (limits?.max_duration_ms ?? this.defaultLimits.max_duration_ms) + 30000;
          const kernelPromise = kernel.run();
          const timeoutPromise = new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error(`Session timed out after ${sessionTimeoutMs}ms`)), sessionTimeoutMs);
            t.unref();
          });
          Promise.race([kernelPromise, timeoutPromise])
            .catch((err) => {
              this.broadcastEvent(session.session_id, {
                type: "session.failed",
                session_id: session.session_id,
                payload: { error: err instanceof Error ? err.message : String(err) },
                timestamp: new Date().toISOString(),
              });
            })
            .finally(() => {
              this.activeSessionCount--;
              // Keep session queryable for 60s after completion, then evict
              setTimeout(() => this.kernels.delete(session.session_id), 60000).unref();
            });

          res.json({ session_id: session.session_id, status: session.status, task });
        } else {
          res.json({ task, message: "Task created. Use a kernel to start a session." });
        }
      } catch (err) { console.error("[api] POST /sessions error:", err); res.status(500).json({ error: "Internal server error" }); }
    });

    router.get("/sessions/:id", (req, res) => {
      const kernel = this.kernels.get(req.params.id!);
      if (!kernel) { res.status(404).json({ error: "Session not found" }); return; }
      res.json(kernel.getSession());
    });

    router.post("/sessions/:id/abort", async (req, res) => {
      const kernel = this.kernels.get(req.params.id!);
      if (!kernel) { res.status(404).json({ error: "Session not found" }); return; }
      await kernel.abort();
      res.json({ status: "aborted" });
    });

    router.get("/sessions/:id/journal", async (req, res) => {
      try {
        const events = await this.journal.readSession(req.params.id!);
        res.json({ events });
      } catch (err) { console.error("[api] GET /sessions/:id/journal error:", err); res.status(500).json({ error: "Internal server error" }); }
    });

    router.get("/sessions/:id/stream", async (req, res) => {
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
      const afterSeq = lastEventId !== undefined ? parseInt(lastEventId, 10) : afterSeqParam !== undefined ? parseInt(afterSeqParam, 10) : undefined;

      if (afterSeq !== undefined && !isNaN(afterSeq)) {
        const events = await this.journal.readSession(sessionId);
        let replayCount = 0;
        const MAX_REPLAY = 500;
        for (const event of events) {
          if (event.seq !== undefined && event.seq > afterSeq) {
            if (replayCount >= MAX_REPLAY) {
              res.write(`data: ${JSON.stringify({ type: "replay.truncated", remaining: events.length - replayCount })}\n\n`);
              break;
            }
            const seqId = `id: ${event.seq}\n`;
            res.write(`${seqId}data: ${JSON.stringify(event)}\n\n`);
            replayCount++;
          }
        }
      }

      const client: SSEClient = { res: res as unknown as ServerResponse, paused: false, missedEvents: 0 };
      const clients = this.sseClients.get(sessionId) ?? [];
      clients.push(client);
      this.sseClients.set(sessionId, clients);

      const keepalive = setInterval(() => {
        if (!client.paused) res.write(":keepalive\n\n");
      }, 15000);

      (res as unknown as ServerResponse).on("drain", () => {
        client.paused = false;
        client.missedEvents = 0;
      });

      // Force-close after 30 minutes to prevent zombie connections
      const maxLifetime = setTimeout(() => {
        res.end();
      }, 30 * 60 * 1000);
      maxLifetime.unref();

      const cleanupSse = () => {
        clearInterval(keepalive);
        clearTimeout(maxLifetime);
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
      const { decision } = req.body as { decision: ApprovalDecision };
      clearTimeout(approval.timer);
      approval.resolve(decision);
      this.pendingApprovals.delete(req.params.id!);
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
      try {
        const events = await this.journal.readSession(req.params.id!);
        if (events.length === 0) { res.status(404).json({ error: "No events found for session" }); return; }
        res.json({ session_id: req.params.id, event_count: events.length, events });
      } catch (err) { console.error("[api] POST /sessions/:id/replay error:", err); res.status(500).json({ error: "Internal server error" }); }
    });

    router.post("/sessions/:id/recover", async (req, res) => {
      try {
        const sessionId = req.params.id!;
        if (this.kernels.has(sessionId)) {
          res.status(409).json({ error: "Session already active" });
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
        });
        const session = await kernel.resumeSession(sessionId);
        if (!session) {
          res.status(404).json({ error: "Session not recoverable" });
          return;
        }
        this.kernels.set(sessionId, kernel);
        res.json({ session_id: sessionId, status: session.status });
      } catch (err) { console.error("[api] POST /sessions/:id/recover error:", err); res.status(500).json({ error: "Internal server error" }); }
    });

    // ─── Plugin Management Routes ─────────────────────────────────────

    router.get("/plugins", (_req, res) => {
      if (!this.pluginRegistry) { res.json({ plugins: [] }); return; }
      res.json({ plugins: this.pluginRegistry.listPlugins() });
    });

    router.get("/plugins/:id", (req, res) => {
      if (!this.pluginRegistry) { res.status(404).json({ error: "Plugin system not configured" }); return; }
      const plugin = this.pluginRegistry.getPlugin(req.params.id!);
      if (!plugin) { res.status(404).json({ error: "Plugin not found" }); return; }
      res.json(plugin);
    });

    router.post("/plugins/:id/reload", async (req, res) => {
      if (!this.pluginRegistry) { res.status(404).json({ error: "Plugin system not configured" }); return; }
      try {
        const state = await this.pluginRegistry.reloadPlugin(req.params.id!);
        res.json(state);
      } catch (err) { console.error("[api] POST /plugins/:id/reload error:", err); res.status(500).json({ error: "Internal server error" }); }
    });

    router.post("/plugins/:id/unload", async (req, res) => {
      if (!this.pluginRegistry) { res.status(404).json({ error: "Plugin system not configured" }); return; }
      try {
        await this.pluginRegistry.unloadPlugin(req.params.id!);
        res.json({ status: "unloaded" });
      } catch (err) { console.error("[api] POST /plugins/:id/unload error:", err); res.status(500).json({ error: "Internal server error" }); }
    });

    // ─── Plugin-Provided Routes ─────────────────────────────────────

    if (this.pluginRegistry) {
      for (const route of this.pluginRegistry.getRoutes()) {
        const method = route.method.toLowerCase();
        if (method === "get" || method === "post" || method === "put" || method === "delete" || method === "patch") {
          (router as any)[method](route.path.replace("/api/", "/"), async (req: express.Request, res: express.Response) => {
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
              console.error("[api] plugin route error:", err); res.status(500).json({ error: "Internal server error" });
            }
          });
        }
      }
    }

    router.post("/journal/compact", async (req, res) => {
      try {
        const compactError = validateCompactInput(req.body);
        if (compactError) { res.status(400).json({ error: compactError }); return; }
        const { retain_sessions } = req.body as { retain_sessions?: string[] };
        const result = await this.journal.compact(retain_sessions);
        res.json(result);
      } catch (err) { console.error("[api] POST /journal/compact error:", err); res.status(500).json({ error: "Internal server error" }); }
    });

    this.app.use("/api", router);
  }
}

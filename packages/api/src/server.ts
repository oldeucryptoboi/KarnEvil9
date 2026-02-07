import express from "express";
import { v4 as uuid } from "uuid";
import type { Kernel } from "@openflaw/kernel";
import type { ToolRegistry } from "@openflaw/tools";
import type { Journal } from "@openflaw/journal";
import type { Task, ApprovalDecision } from "@openflaw/schemas";
import type { ServerResponse } from "node:http";

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  request: unknown;
}

export class ApiServer {
  private app: express.Application;
  private kernels = new Map<string, Kernel>();
  private toolRegistry: ToolRegistry;
  private journal: Journal;
  private pendingApprovals = new Map<string, PendingApproval>();
  private sseClients = new Map<string, ServerResponse[]>();

  constructor(toolRegistry: ToolRegistry, journal: Journal) {
    this.app = express();
    this.app.use(express.json());
    this.toolRegistry = toolRegistry;
    this.journal = journal;
    this.setupRoutes();
  }

  registerKernel(sessionId: string, kernel: Kernel): void { this.kernels.set(sessionId, kernel); }

  registerApproval(requestId: string, request: unknown, resolve: (decision: ApprovalDecision) => void): void {
    this.pendingApprovals.set(requestId, { resolve, request });
  }

  broadcastEvent(sessionId: string, data: unknown): void {
    const clients = this.sseClients.get(sessionId);
    if (!clients) return;
    const msg = `data: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  }

  listen(port: number): void {
    this.app.listen(port, () => { console.log(`OpenFlaw API listening on http://localhost:${port}`); });
  }

  getExpressApp(): express.Application { return this.app; }

  private setupRoutes(): void {
    const router = express.Router();

    router.post("/sessions", async (req, res) => {
      try {
        const { text, constraints, submitted_by } = req.body as { text?: string; constraints?: Record<string, unknown>; submitted_by?: string };
        if (!text) { res.status(400).json({ error: "text is required" }); return; }
        const task: Task = { task_id: uuid(), text, constraints, submitted_by, created_at: new Date().toISOString() };
        res.json({ task, message: "Task created. Use a kernel to start a session." });
      } catch (err) { res.status(500).json({ error: String(err) }); }
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
      } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    router.get("/sessions/:id/stream", (req, res) => {
      const sessionId = req.params.id!;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const clients = this.sseClients.get(sessionId) ?? [];
      clients.push(res as unknown as ServerResponse);
      this.sseClients.set(sessionId, clients);
      const keepalive = setInterval(() => { res.write(":keepalive\n\n"); }, 15000);
      req.on("close", () => {
        clearInterval(keepalive);
        const remaining = (this.sseClients.get(sessionId) ?? []).filter((c) => c !== (res as unknown as ServerResponse));
        if (remaining.length === 0) this.sseClients.delete(sessionId);
        else this.sseClients.set(sessionId, remaining);
      });
    });

    router.get("/approvals", (_req, res) => {
      const pending = [...this.pendingApprovals.entries()].map(([id, { request }]) => ({ request_id: id, request }));
      res.json({ pending });
    });

    router.post("/approvals/:id", (req, res) => {
      const approval = this.pendingApprovals.get(req.params.id!);
      if (!approval) { res.status(404).json({ error: "Approval not found" }); return; }
      const { decision } = req.body as { decision?: ApprovalDecision };
      if (!decision || !["allow_once", "allow_session", "allow_always", "deny"].includes(decision)) {
        res.status(400).json({ error: "Invalid decision" }); return;
      }
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
      } catch (err) { res.status(500).json({ error: String(err) }); }
    });

    router.get("/health", (_req, res) => {
      res.json({ status: "ok", version: "0.1.0", tools_loaded: this.toolRegistry.list().length });
    });

    this.app.use("/api", router);
  }
}

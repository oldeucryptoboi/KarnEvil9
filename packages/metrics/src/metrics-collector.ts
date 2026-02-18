import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from "prom-client";
import type { Journal } from "@karnevil9/journal";
import type { JournalEvent } from "@karnevil9/schemas";

export interface MetricsCollectorConfig {
  registry?: Registry;
  prefix?: string;
  collectDefault?: boolean;
}

export class MetricsCollector {
  private readonly registry: Registry;
  private readonly prefix: string;
  private unsubscribe?: () => void;

  // Internal tracking maps
  private readonly plannerStartTimes = new Map<string, number>();
  private readonly stepToolNames = new Map<string, string>();

  // ─── Session Metrics ───────────────────────────────────────────────
  private readonly sessionsTotal: Counter;
  private readonly sessionsActive: Gauge;

  // ─── Step & Tool Metrics ───────────────────────────────────────────
  private readonly stepsTotal: Counter;
  private readonly toolExecutionsTotal: Counter;
  private readonly toolDurationSeconds: Histogram;

  // ─── Token & Cost Metrics ──────────────────────────────────────────
  private readonly tokensTotal: Counter;
  private readonly costUsdTotal: Counter;

  // ─── Planner Metrics ───────────────────────────────────────────────
  private readonly plannerCallsTotal: Counter;
  private readonly plannerDurationSeconds: Histogram;

  // ─── Permission Metrics ────────────────────────────────────────────
  private readonly permissionDecisionsTotal: Counter;

  // ─── Safety Metrics ────────────────────────────────────────────────
  private readonly circuitBreakerOpen: Gauge;
  private readonly futilityDetectedTotal: Counter;
  private readonly contextBudgetAssessmentsTotal: Counter;

  // ─── Limit Metrics ─────────────────────────────────────────────────
  private readonly limitsExceededTotal: Counter;
  private readonly policyViolationsTotal: Counter;

  // ─── Journal Disk Metrics ─────────────────────────────────────────
  private readonly journalDiskUsagePct: Gauge;
  private readonly journalDiskWarningsTotal: Counter;

  // ─── Plugin Metrics ────────────────────────────────────────────────
  private readonly pluginsStatus: Gauge;

  constructor(config?: MetricsCollectorConfig) {
    this.registry = config?.registry ?? new Registry();
    this.prefix = config?.prefix ?? "karnevil9_";

    if (config?.collectDefault !== false) {
      collectDefaultMetrics({ register: this.registry, prefix: this.prefix });
    }

    // Session metrics
    this.sessionsTotal = new Counter({
      name: `${this.prefix}sessions_total`,
      help: "Total number of sessions by status",
      labelNames: ["status"] as const,
      registers: [this.registry],
    });

    this.sessionsActive = new Gauge({
      name: `${this.prefix}sessions_active`,
      help: "Number of currently active sessions",
      registers: [this.registry],
    });

    // Step & Tool metrics
    this.stepsTotal = new Counter({
      name: `${this.prefix}steps_total`,
      help: "Total number of steps by status and tool name",
      labelNames: ["status", "tool_name"] as const,
      registers: [this.registry],
    });

    this.toolExecutionsTotal = new Counter({
      name: `${this.prefix}tool_executions_total`,
      help: "Total tool executions by tool name and status",
      labelNames: ["tool_name", "status"] as const,
      registers: [this.registry],
    });

    this.toolDurationSeconds = new Histogram({
      name: `${this.prefix}tool_duration_seconds`,
      help: "Tool execution duration in seconds",
      labelNames: ["tool_name"] as const,
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
      registers: [this.registry],
    });

    // Token & Cost metrics
    this.tokensTotal = new Counter({
      name: `${this.prefix}tokens_total`,
      help: "Total tokens consumed by model and type",
      labelNames: ["model", "type"] as const,
      registers: [this.registry],
    });

    this.costUsdTotal = new Counter({
      name: `${this.prefix}cost_usd_total`,
      help: "Total cost in USD by model",
      labelNames: ["model"] as const,
      registers: [this.registry],
    });

    // Planner metrics
    this.plannerCallsTotal = new Counter({
      name: `${this.prefix}planner_calls_total`,
      help: "Total planner calls by status",
      labelNames: ["status"] as const,
      registers: [this.registry],
    });

    this.plannerDurationSeconds = new Histogram({
      name: `${this.prefix}planner_duration_seconds`,
      help: "Planner call duration in seconds",
      buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120],
      registers: [this.registry],
    });

    // Permission metrics
    this.permissionDecisionsTotal = new Counter({
      name: `${this.prefix}permission_decisions_total`,
      help: "Total permission decisions by decision type",
      labelNames: ["decision"] as const,
      registers: [this.registry],
    });

    // Safety metrics
    this.circuitBreakerOpen = new Gauge({
      name: `${this.prefix}circuit_breaker_open`,
      help: "Whether a circuit breaker is open (1) or closed (0) by plugin ID",
      labelNames: ["plugin_id"] as const,
      registers: [this.registry],
    });

    this.futilityDetectedTotal = new Counter({
      name: `${this.prefix}futility_detected_total`,
      help: "Total number of futility detections",
      registers: [this.registry],
    });

    this.contextBudgetAssessmentsTotal = new Counter({
      name: `${this.prefix}context_budget_assessments_total`,
      help: "Total context budget assessments by verdict",
      labelNames: ["verdict"] as const,
      registers: [this.registry],
    });

    // Limit metrics
    this.limitsExceededTotal = new Counter({
      name: `${this.prefix}limits_exceeded_total`,
      help: "Total number of limit breaches by limit type",
      labelNames: ["limit"] as const,
      registers: [this.registry],
    });

    this.policyViolationsTotal = new Counter({
      name: `${this.prefix}policy_violations_total`,
      help: "Total policy violations by tool name",
      labelNames: ["tool_name"] as const,
      registers: [this.registry],
    });

    // Journal disk metrics
    this.journalDiskUsagePct = new Gauge({
      name: `${this.prefix}journal_disk_usage_pct`,
      help: "Journal disk usage percentage from last warning event",
      registers: [this.registry],
    });

    this.journalDiskWarningsTotal = new Counter({
      name: `${this.prefix}journal_disk_warnings_total`,
      help: "Total number of journal disk warning events",
      registers: [this.registry],
    });

    // Plugin metrics
    this.pluginsStatus = new Gauge({
      name: `${this.prefix}plugins_status`,
      help: "Plugin status (1 = active state indicated by status label)",
      labelNames: ["plugin_id", "status"] as const,
      registers: [this.registry],
    });
  }

  attach(journal: Journal): void {
    this.detach();
    this.unsubscribe = journal.on((event) => this.handleEvent(event));
  }

  detach(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  handleEvent(event: JournalEvent): void {
    switch (event.type) {
      // ─── Session Events ────────────────────────────────────────────
      case "session.created":
        this.sessionsTotal.inc({ status: "created" });
        this.sessionsActive.inc();
        break;

      case "session.completed":
        this.sessionsTotal.inc({ status: "completed" });
        this.sessionsActive.dec();
        this.cleanupSession(event.session_id);
        break;

      case "session.failed":
        this.sessionsTotal.inc({ status: "failed" });
        this.sessionsActive.dec();
        this.cleanupSession(event.session_id);
        break;

      case "session.aborted":
        this.sessionsTotal.inc({ status: "aborted" });
        this.sessionsActive.dec();
        this.cleanupSession(event.session_id);
        break;

      // ─── Step Events ───────────────────────────────────────────────
      case "step.started": {
        const toolName = this.extractToolName(event.payload);
        const stepId = event.payload.step_id as string | undefined;
        if (stepId && toolName) {
          this.stepToolNames.set(stepId, toolName);
        }
        this.stepsTotal.inc({ status: "started", tool_name: toolName ?? "unknown" });
        break;
      }

      case "step.succeeded": {
        const stepId = event.payload.step_id as string | undefined;
        const toolName = (stepId ? this.stepToolNames.get(stepId) : undefined) ?? "unknown";
        this.stepsTotal.inc({ status: "succeeded", tool_name: toolName });
        if (stepId) this.stepToolNames.delete(stepId);
        break;
      }

      case "step.failed": {
        const stepId = event.payload.step_id as string | undefined;
        const toolName = (stepId ? this.stepToolNames.get(stepId) : undefined) ?? "unknown";
        this.stepsTotal.inc({ status: "failed", tool_name: toolName });
        if (stepId) this.stepToolNames.delete(stepId);
        break;
      }

      // ─── Tool Events ──────────────────────────────────────────────
      case "tool.succeeded": {
        const toolName = (event.payload.tool_name as string | undefined) ?? "unknown";
        this.toolExecutionsTotal.inc({ tool_name: toolName, status: "succeeded" });
        const durationMs = event.payload.duration_ms as number | undefined;
        if (durationMs !== undefined) {
          this.toolDurationSeconds.observe({ tool_name: toolName }, durationMs / 1000);
        }
        break;
      }

      case "tool.failed": {
        const toolName = (event.payload.tool_name as string | undefined) ?? "unknown";
        this.toolExecutionsTotal.inc({ tool_name: toolName, status: "failed" });
        const durationMs = event.payload.duration_ms as number | undefined;
        if (durationMs !== undefined) {
          this.toolDurationSeconds.observe({ tool_name: toolName }, durationMs / 1000);
        }
        break;
      }

      // ─── Token & Cost Events ──────────────────────────────────────
      case "usage.recorded": {
        const model = (event.payload.model as string | undefined) ?? "unknown";
        const inputTokens = event.payload.input_tokens as number | undefined;
        const outputTokens = event.payload.output_tokens as number | undefined;
        const costUsd = event.payload.cost_usd as number | undefined;

        if (inputTokens !== undefined) {
          this.tokensTotal.inc({ model, type: "input" }, inputTokens);
        }
        if (outputTokens !== undefined) {
          this.tokensTotal.inc({ model, type: "output" }, outputTokens);
        }
        if (costUsd !== undefined) {
          this.costUsdTotal.inc({ model }, costUsd);
        }
        break;
      }

      // ─── Planner Events ───────────────────────────────────────────
      case "planner.requested":
        this.plannerStartTimes.set(event.session_id, Date.parse(event.timestamp));
        break;

      case "planner.plan_received": {
        this.plannerCallsTotal.inc({ status: "accepted" });
        const startTime = this.plannerStartTimes.get(event.session_id);
        if (startTime !== undefined) {
          const durationSec = (Date.parse(event.timestamp) - startTime) / 1000;
          this.plannerDurationSeconds.observe(durationSec);
          this.plannerStartTimes.delete(event.session_id);
        }
        break;
      }

      case "planner.plan_rejected": {
        this.plannerCallsTotal.inc({ status: "rejected" });
        const startTime = this.plannerStartTimes.get(event.session_id);
        if (startTime !== undefined) {
          const durationSec = (Date.parse(event.timestamp) - startTime) / 1000;
          this.plannerDurationSeconds.observe(durationSec);
          this.plannerStartTimes.delete(event.session_id);
        }
        break;
      }

      // ─── Permission Events ────────────────────────────────────────
      case "permission.requested":
        this.permissionDecisionsTotal.inc({ decision: "requested" });
        break;

      case "permission.granted":
        this.permissionDecisionsTotal.inc({ decision: "allowed" });
        break;

      case "permission.denied":
        this.permissionDecisionsTotal.inc({ decision: "denied" });
        break;

      // ─── Safety Events ────────────────────────────────────────────
      case "plugin.hook_circuit_open": {
        const pluginId = (event.payload.plugin_id as string | undefined) ?? "unknown";
        this.circuitBreakerOpen.set({ plugin_id: pluginId }, 1);
        break;
      }

      case "plugin.hook_fired": {
        const pluginId = (event.payload.plugin_id as string | undefined) ?? "unknown";
        this.circuitBreakerOpen.set({ plugin_id: pluginId }, 0);
        break;
      }

      case "futility.detected":
        this.futilityDetectedTotal.inc();
        break;

      case "context.budget_assessed": {
        const verdict = (event.payload.verdict as string | undefined) ?? "unknown";
        this.contextBudgetAssessmentsTotal.inc({ verdict });
        break;
      }

      // ─── Limit & Policy Events ────────────────────────────────────
      case "limit.exceeded": {
        const limit = (event.payload.limit as string | undefined) ?? "unknown";
        this.limitsExceededTotal.inc({ limit });
        break;
      }

      case "policy.violated": {
        const toolName = (event.payload.tool_name as string | undefined) ?? "unknown";
        this.policyViolationsTotal.inc({ tool_name: toolName });
        break;
      }

      // ─── Journal Disk Events ──────────────────────────────────────
      case "journal.disk_warning": {
        const usagePct = event.payload.usage_pct as number | undefined;
        if (usagePct !== undefined) {
          this.journalDiskUsagePct.set(usagePct);
        }
        this.journalDiskWarningsTotal.inc();
        break;
      }

      // ─── Plugin Events ────────────────────────────────────────────
      case "plugin.loaded": {
        const pluginId = (event.payload.plugin_id as string | undefined) ?? "unknown";
        this.pluginsStatus.set({ plugin_id: pluginId, status: "active" }, 1);
        break;
      }

      case "plugin.failed": {
        const pluginId = (event.payload.plugin_id as string | undefined) ?? "unknown";
        this.pluginsStatus.set({ plugin_id: pluginId, status: "failed" }, 1);
        this.pluginsStatus.set({ plugin_id: pluginId, status: "active" }, 0);
        break;
      }

      case "plugin.unloaded": {
        const pluginId = (event.payload.plugin_id as string | undefined) ?? "unknown";
        this.pluginsStatus.set({ plugin_id: pluginId, status: "active" }, 0);
        break;
      }

      default:
        // Unhandled event types are silently ignored
        break;
    }
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }

  getRegistry(): Registry {
    return this.registry;
  }

  reset(): void {
    this.registry.resetMetrics();
    this.plannerStartTimes.clear();
    this.stepToolNames.clear();
  }

  private extractToolName(payload: Record<string, unknown>): string | undefined {
    // step.started payloads may include tool_name, tool_ref.name, or tool (bare string from kernel)
    if (typeof payload.tool_name === "string") return payload.tool_name;
    if (typeof payload.tool === "string") return payload.tool;
    const toolRef = payload.tool_ref as Record<string, unknown> | undefined;
    if (toolRef && typeof toolRef.name === "string") return toolRef.name;
    // Check step object for tool_ref
    const step = payload.step as Record<string, unknown> | undefined;
    if (step) {
      if (typeof step.tool_name === "string") return step.tool_name;
      if (typeof step.tool === "string") return step.tool;
      const ref = step.tool_ref as Record<string, unknown> | undefined;
      if (ref && typeof ref.name === "string") return ref.name;
    }
    return undefined;
  }

  private cleanupSession(sessionId: string): void {
    this.plannerStartTimes.delete(sessionId);
    // We can't efficiently clean stepToolNames by session, but entries
    // will be garbage-collected as maps are bounded by active step IDs
  }
}

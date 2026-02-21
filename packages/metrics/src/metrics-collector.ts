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

  // Internal tracking maps (bounded to prevent memory leaks in long-running processes)
  private static readonly MAX_TRACKING_ENTRIES = 10000;
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

  // ─── Swarm Delegation Metrics ────────────────────────────────────
  private readonly swarmTrustScore: Gauge;
  private readonly swarmContractsTotal: Counter;
  private readonly swarmRedelegationsTotal: Counter;
  private readonly swarmCheckpointsTotal: Counter;
  private readonly swarmBudgetAlertsTotal: Counter;
  private readonly swarmTaskCancellationsTotal: Counter;
  private readonly swarmPreemptionsTotal: Counter;
  private readonly swarmDelegationDepth: Histogram;

  // ─── Phase 3 Swarm Metrics ────────────────────────────────────
  private readonly swarmVerificationsTotal: Counter;
  private readonly swarmDisputesTotal: Counter;
  private readonly swarmDecompositionsTotal: Counter;
  private readonly swarmSubtasksPerDecomposition: Histogram;
  private readonly swarmReoptimizationsTotal: Counter;
  private readonly swarmAnomaliesTotal: Counter;
  private readonly swarmQuarantinedPeers: Gauge;
  private readonly swarmSseConnections: Gauge;
  private readonly swarmMonitoringEventsPushed: Counter;

  // ─── Phase 4 Swarm Metrics ────────────────────────────────────
  private readonly swarmParetoFrontSize: Histogram;
  private readonly swarmGamingDetectedTotal: Counter;
  private readonly swarmMonitoringLevelNegotiatedTotal: Counter;
  private readonly swarmReversibilityEscalationsTotal: Counter;
  private readonly swarmRootCauseDiagnosesTotal: Counter;
  private readonly swarmCredentialVerificationsTotal: Counter;
  private readonly swarmProposalsGeneratedTotal: Counter;
  private readonly swarmDctOperationsTotal: Counter;
  private readonly swarmSybilReportsTotal: Counter;
  private readonly swarmCollusionReportsTotal: Counter;
  private readonly swarmAuctionsTotal: Counter;
  private readonly swarmBidsReceivedTotal: Counter;

  // ─── Phase 5 Swarm Metrics ────────────────────────────────────
  private readonly swarmBondsTotal: Counter;
  private readonly swarmBondAmountUsd: Counter;
  private readonly swarmConsensusRoundsTotal: Counter;
  private readonly swarmConsensusAgreementRatio: Histogram;
  private readonly swarmFirebreaksTotal: Counter;
  private readonly swarmDelegateeRoutingTotal: Counter;
  private readonly swarmBehavioralScoresGauge: Gauge;
  private readonly swarmRenegotiationsTotal: Counter;
  private readonly swarmFrictionAssessmentsTotal: Counter;
  private readonly swarmSabotageReportsTotal: Counter;
  private readonly swarmCheckpointsSavedTotal: Counter;
  private readonly swarmFrontRunningTotal: Counter;

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

    // Swarm delegation metrics
    this.swarmTrustScore = new Gauge({
      name: `${this.prefix}swarm_trust_score`,
      help: "Peer trust score from reputation system",
      labelNames: ["peer_node_id"] as const,
      registers: [this.registry],
    });

    this.swarmContractsTotal = new Counter({
      name: `${this.prefix}swarm_contracts_total`,
      help: "Total delegation contracts by status",
      labelNames: ["status"] as const,
      registers: [this.registry],
    });

    this.swarmRedelegationsTotal = new Counter({
      name: `${this.prefix}swarm_redelegations_total`,
      help: "Total number of task redelegations",
      registers: [this.registry],
    });

    this.swarmCheckpointsTotal = new Counter({
      name: `${this.prefix}swarm_checkpoints_total`,
      help: "Total task checkpoints by status",
      labelNames: ["status"] as const,
      registers: [this.registry],
    });

    this.swarmBudgetAlertsTotal = new Counter({
      name: `${this.prefix}swarm_budget_alerts_total`,
      help: "Total budget alerts by metric",
      labelNames: ["metric"] as const,
      registers: [this.registry],
    });

    this.swarmTaskCancellationsTotal = new Counter({
      name: `${this.prefix}swarm_task_cancellations_total`,
      help: "Total task cancellations",
      registers: [this.registry],
    });

    this.swarmPreemptionsTotal = new Counter({
      name: `${this.prefix}swarm_preemptions_total`,
      help: "Total task preemptions",
      registers: [this.registry],
    });

    this.swarmDelegationDepth = new Histogram({
      name: `${this.prefix}swarm_delegation_depth`,
      help: "Delegation chain depth distribution",
      buckets: [1, 2, 3, 4, 5],
      registers: [this.registry],
    });

    // Phase 3 swarm metrics
    this.swarmVerificationsTotal = new Counter({
      name: `${this.prefix}swarm_verifications_total`,
      help: "Total task verifications by result",
      labelNames: ["result"] as const,
      registers: [this.registry],
    });

    this.swarmDisputesTotal = new Counter({
      name: `${this.prefix}swarm_disputes_total`,
      help: "Total disputes by status",
      labelNames: ["status"] as const,
      registers: [this.registry],
    });

    this.swarmDecompositionsTotal = new Counter({
      name: `${this.prefix}swarm_decompositions_total`,
      help: "Total task decompositions",
      labelNames: ["skipped"] as const,
      registers: [this.registry],
    });

    this.swarmSubtasksPerDecomposition = new Histogram({
      name: `${this.prefix}swarm_subtasks_per_decomposition`,
      help: "Number of subtasks per decomposition",
      buckets: [1, 2, 3, 5, 8, 10],
      registers: [this.registry],
    });

    this.swarmReoptimizationsTotal = new Counter({
      name: `${this.prefix}swarm_reoptimizations_total`,
      help: "Total reoptimization evaluations by action",
      labelNames: ["action"] as const,
      registers: [this.registry],
    });

    this.swarmAnomaliesTotal = new Counter({
      name: `${this.prefix}swarm_anomalies_total`,
      help: "Total anomalies detected by type and severity",
      labelNames: ["type", "severity"] as const,
      registers: [this.registry],
    });

    this.swarmQuarantinedPeers = new Gauge({
      name: `${this.prefix}swarm_quarantined_peers`,
      help: "Number of currently quarantined peers",
      registers: [this.registry],
    });

    this.swarmSseConnections = new Gauge({
      name: `${this.prefix}swarm_sse_connections`,
      help: "Number of active SSE monitoring connections",
      registers: [this.registry],
    });

    this.swarmMonitoringEventsPushed = new Counter({
      name: `${this.prefix}swarm_monitoring_events_pushed`,
      help: "Total monitoring events pushed via SSE",
      labelNames: ["event_type"] as const,
      registers: [this.registry],
    });

    // Phase 4 swarm metrics
    this.swarmParetoFrontSize = new Histogram({
      name: `${this.prefix}swarm_pareto_front_size`,
      help: "Size of Pareto front in peer selection",
      buckets: [1, 2, 3, 5, 8, 10, 15, 20],
      registers: [this.registry],
    });

    this.swarmGamingDetectedTotal = new Counter({
      name: `${this.prefix}swarm_gaming_detected_total`,
      help: "Total gaming flags detected by type and severity",
      labelNames: ["flag_type", "severity"] as const,
      registers: [this.registry],
    });

    this.swarmMonitoringLevelNegotiatedTotal = new Counter({
      name: `${this.prefix}swarm_monitoring_level_negotiated_total`,
      help: "Total monitoring level negotiations by level",
      labelNames: ["level"] as const,
      registers: [this.registry],
    });

    this.swarmReversibilityEscalationsTotal = new Counter({
      name: `${this.prefix}swarm_reversibility_escalations_total`,
      help: "Total reversibility-based escalations",
      registers: [this.registry],
    });

    this.swarmRootCauseDiagnosesTotal = new Counter({
      name: `${this.prefix}swarm_root_cause_diagnoses_total`,
      help: "Total root cause diagnoses by cause and response",
      labelNames: ["root_cause", "response"] as const,
      registers: [this.registry],
    });

    this.swarmCredentialVerificationsTotal = new Counter({
      name: `${this.prefix}swarm_credential_verifications_total`,
      help: "Total credential verifications by result",
      labelNames: ["result"] as const,
      registers: [this.registry],
    });

    this.swarmProposalsGeneratedTotal = new Counter({
      name: `${this.prefix}swarm_proposals_generated_total`,
      help: "Total decomposition proposals generated",
      registers: [this.registry],
    });

    this.swarmDctOperationsTotal = new Counter({
      name: `${this.prefix}swarm_dct_operations_total`,
      help: "Total DCT operations by type",
      labelNames: ["operation"] as const,
      registers: [this.registry],
    });

    this.swarmSybilReportsTotal = new Counter({
      name: `${this.prefix}swarm_sybil_reports_total`,
      help: "Total Sybil detection reports by indicator",
      labelNames: ["indicator"] as const,
      registers: [this.registry],
    });

    this.swarmCollusionReportsTotal = new Counter({
      name: `${this.prefix}swarm_collusion_reports_total`,
      help: "Total collusion detection reports by indicator",
      labelNames: ["indicator"] as const,
      registers: [this.registry],
    });

    this.swarmAuctionsTotal = new Counter({
      name: `${this.prefix}swarm_auctions_total`,
      help: "Total auctions by status",
      labelNames: ["status"] as const,
      registers: [this.registry],
    });

    this.swarmBidsReceivedTotal = new Counter({
      name: `${this.prefix}swarm_bids_received_total`,
      help: "Total bids received in auctions",
      registers: [this.registry],
    });

    // Phase 5 swarm metrics
    this.swarmBondsTotal = new Counter({
      name: `${this.prefix}swarm_bonds_total`,
      help: "Total bond operations by type",
      labelNames: ["type"] as const,
      registers: [this.registry],
    });

    this.swarmBondAmountUsd = new Counter({
      name: `${this.prefix}swarm_bond_amount_usd`,
      help: "Total bond amount in USD by type",
      labelNames: ["type"] as const,
      registers: [this.registry],
    });

    this.swarmConsensusRoundsTotal = new Counter({
      name: `${this.prefix}swarm_consensus_rounds_total`,
      help: "Total consensus rounds by outcome",
      labelNames: ["outcome"] as const,
      registers: [this.registry],
    });

    this.swarmConsensusAgreementRatio = new Histogram({
      name: `${this.prefix}swarm_consensus_agreement_ratio`,
      help: "Consensus agreement ratio distribution",
      buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
      registers: [this.registry],
    });

    this.swarmFirebreaksTotal = new Counter({
      name: `${this.prefix}swarm_firebreaks_total`,
      help: "Total firebreak triggers by action",
      labelNames: ["action"] as const,
      registers: [this.registry],
    });

    this.swarmDelegateeRoutingTotal = new Counter({
      name: `${this.prefix}swarm_delegatee_routing_total`,
      help: "Total delegatee routing decisions by target",
      labelNames: ["target"] as const,
      registers: [this.registry],
    });

    this.swarmBehavioralScoresGauge = new Gauge({
      name: `${this.prefix}swarm_behavioral_score`,
      help: "Peer behavioral composite score",
      labelNames: ["peer_node_id"] as const,
      registers: [this.registry],
    });

    this.swarmRenegotiationsTotal = new Counter({
      name: `${this.prefix}swarm_renegotiations_total`,
      help: "Total contract renegotiations by outcome",
      labelNames: ["outcome"] as const,
      registers: [this.registry],
    });

    this.swarmFrictionAssessmentsTotal = new Counter({
      name: `${this.prefix}swarm_friction_assessments_total`,
      help: "Total friction assessments by level",
      labelNames: ["level"] as const,
      registers: [this.registry],
    });

    this.swarmSabotageReportsTotal = new Counter({
      name: `${this.prefix}swarm_sabotage_reports_total`,
      help: "Total sabotage reports by indicator",
      labelNames: ["indicator"] as const,
      registers: [this.registry],
    });

    this.swarmCheckpointsSavedTotal = new Counter({
      name: `${this.prefix}swarm_checkpoints_saved_total`,
      help: "Total checkpoints saved for task resumption",
      registers: [this.registry],
    });

    this.swarmFrontRunningTotal = new Counter({
      name: `${this.prefix}swarm_front_running_total`,
      help: "Total front-running detection events",
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
          if (this.stepToolNames.size >= MetricsCollector.MAX_TRACKING_ENTRIES) {
            const oldest = this.stepToolNames.keys().next().value;
            if (oldest !== undefined) this.stepToolNames.delete(oldest);
          }
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
        if (this.plannerStartTimes.size >= MetricsCollector.MAX_TRACKING_ENTRIES) {
          // Evict oldest entry to prevent unbounded growth
          const oldest = this.plannerStartTimes.keys().next().value;
          if (oldest !== undefined) this.plannerStartTimes.delete(oldest);
        }
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

      // ─── Swarm Delegation Events ──────────────────────────────────
      case "swarm.reputation_updated": {
        const peerNodeId = (event.payload.peer_node_id as string | undefined) ?? "unknown";
        const trustScore = event.payload.trust_score as number | undefined;
        if (trustScore !== undefined) {
          this.swarmTrustScore.set({ peer_node_id: peerNodeId }, trustScore);
        }
        break;
      }

      case "swarm.contract_created":
        this.swarmContractsTotal.inc({ status: "created" });
        break;

      case "swarm.contract_completed":
        this.swarmContractsTotal.inc({ status: "completed" });
        break;

      case "swarm.contract_violated":
        this.swarmContractsTotal.inc({ status: "violated" });
        break;

      case "swarm.task_redelegated":
        this.swarmRedelegationsTotal.inc();
        break;

      case "swarm.task_checkpoint_received":
        this.swarmCheckpointsTotal.inc({ status: "received" });
        break;

      case "swarm.task_checkpoint_missed":
        this.swarmCheckpointsTotal.inc({ status: "missed" });
        break;

      case "swarm.budget_alert": {
        const metric = (event.payload.metric as string | undefined) ?? "unknown";
        this.swarmBudgetAlertsTotal.inc({ metric });
        break;
      }

      case "swarm.task_cancelled":
        this.swarmTaskCancellationsTotal.inc();
        break;

      case "swarm.task_preempted":
        this.swarmPreemptionsTotal.inc();
        break;

      case "swarm.attestation_chain_invalid": {
        const depth = event.payload.invalid_at_depth as number | undefined;
        if (depth !== undefined) {
          this.swarmDelegationDepth.observe(depth);
        }
        break;
      }

      case "swarm.task_result_received": {
        // Track delegation depth from attestation chain if available
        const chainDepth = event.payload.chain_depth as number | undefined;
        if (chainDepth !== undefined) {
          this.swarmDelegationDepth.observe(chainDepth);
        }
        break;
      }

      // ─── Phase 3 Swarm Events ──────────────────────────────────────

      case "swarm.task_verified":
        this.swarmVerificationsTotal.inc({ result: "passed" });
        break;

      case "swarm.task_verification_failed":
        this.swarmVerificationsTotal.inc({ result: "failed" });
        break;

      case "swarm.dispute_opened":
        this.swarmDisputesTotal.inc({ status: "opened" });
        break;

      case "swarm.dispute_resolved": {
        const resolvedFor = (event.payload.resolved_for as string | undefined) ?? "unknown";
        this.swarmDisputesTotal.inc({ status: `resolved_${resolvedFor}` });
        break;
      }

      case "swarm.task_decomposed": {
        const skipped = event.payload.skip_delegation as boolean | undefined;
        this.swarmDecompositionsTotal.inc({ skipped: skipped ? "true" : "false" });
        const subtaskCount = event.payload.subtask_count as number | undefined;
        if (subtaskCount !== undefined) {
          this.swarmSubtasksPerDecomposition.observe(subtaskCount);
        }
        break;
      }

      case "swarm.reoptimization_triggered": {
        const actions = event.payload.actions as Record<string, number> | undefined;
        if (actions) {
          for (const [action, count] of Object.entries(actions)) {
            if (count > 0) this.swarmReoptimizationsTotal.inc({ action }, count);
          }
        }
        break;
      }

      case "swarm.peer_redelegate_on_drift":
        this.swarmReoptimizationsTotal.inc({ action: "redelegate" });
        break;

      case "swarm.anomaly_detected": {
        const anomalyType = (event.payload.type as string | undefined) ?? "unknown";
        const anomalySeverity = (event.payload.severity as string | undefined) ?? "unknown";
        this.swarmAnomaliesTotal.inc({ type: anomalyType, severity: anomalySeverity });
        const quarantinedCount = event.payload.quarantined_count as number | undefined;
        if (quarantinedCount !== undefined) {
          this.swarmQuarantinedPeers.set(quarantinedCount);
        }
        break;
      }

      case "swarm.data_access_violation":
        this.swarmAnomaliesTotal.inc({ type: "data_access_violation", severity: "high" });
        break;

      case "swarm.monitoring_event_pushed": {
        const eventType = (event.payload.event_type as string | undefined) ?? "unknown";
        this.swarmMonitoringEventsPushed.inc({ event_type: eventType });
        const sseConnections = event.payload.sse_connections as number | undefined;
        if (sseConnections !== undefined) {
          this.swarmSseConnections.set(sseConnections);
        }
        break;
      }

      // ─── Phase 4 Swarm Events ──────────────────────────────────────

      case "swarm.pareto_selection_completed": {
        const frontSize = event.payload.front_size as number | undefined;
        if (frontSize !== undefined) {
          this.swarmParetoFrontSize.observe(frontSize);
        }
        break;
      }

      case "swarm.gaming_detected": {
        const flagType = (event.payload.flag_type as string | undefined) ?? "unknown";
        const severity = (event.payload.severity as string | undefined) ?? "unknown";
        this.swarmGamingDetectedTotal.inc({ flag_type: flagType, severity });
        break;
      }

      case "swarm.monitoring_level_negotiated": {
        const level = (event.payload.level as string | undefined) ?? "unknown";
        this.swarmMonitoringLevelNegotiatedTotal.inc({ level });
        break;
      }

      case "swarm.reversibility_escalation":
        this.swarmReversibilityEscalationsTotal.inc();
        break;

      case "swarm.root_cause_diagnosed": {
        const rootCause = (event.payload.root_cause as string | undefined) ?? "unknown";
        const response = (event.payload.recommended_response as string | undefined) ?? "unknown";
        this.swarmRootCauseDiagnosesTotal.inc({ root_cause: rootCause, response });
        break;
      }

      case "swarm.peer_credential_verified":
        this.swarmCredentialVerificationsTotal.inc({ result: "verified" });
        break;

      case "swarm.peer_credential_rejected":
        this.swarmCredentialVerificationsTotal.inc({ result: "rejected" });
        break;

      case "swarm.credential_issued":
        this.swarmCredentialVerificationsTotal.inc({ result: "issued" });
        break;

      case "swarm.task_decomposed_recursive":
        this.swarmProposalsGeneratedTotal.inc();
        break;

      case "swarm.proposals_generated":
        this.swarmProposalsGeneratedTotal.inc();
        break;

      case "swarm.dct_created":
        this.swarmDctOperationsTotal.inc({ operation: "created" });
        break;

      case "swarm.dct_attenuated":
        this.swarmDctOperationsTotal.inc({ operation: "attenuated" });
        break;

      case "swarm.dct_validated":
        this.swarmDctOperationsTotal.inc({ operation: "validated" });
        break;

      case "swarm.dct_validation_failed":
        this.swarmDctOperationsTotal.inc({ operation: "validation_failed" });
        break;

      case "swarm.dct_revoked":
        this.swarmDctOperationsTotal.inc({ operation: "revoked" });
        break;

      case "swarm.sybil_detected": {
        const indicator = (event.payload.indicator as string | undefined) ?? "unknown";
        this.swarmSybilReportsTotal.inc({ indicator });
        break;
      }

      case "swarm.collusion_detected": {
        const indicator = (event.payload.indicator as string | undefined) ?? "unknown";
        this.swarmCollusionReportsTotal.inc({ indicator });
        break;
      }

      case "swarm.proof_of_work_required":
      case "swarm.proof_of_work_verified":
        // Tracked under sybil reports
        break;

      case "swarm.auction_created":
        this.swarmAuctionsTotal.inc({ status: "created" });
        break;

      case "swarm.bid_received":
        this.swarmBidsReceivedTotal.inc();
        break;

      case "swarm.auction_awarded":
        this.swarmAuctionsTotal.inc({ status: "awarded" });
        break;

      // ─── Phase 5 Swarm Events ──────────────────────────────────────

      case "swarm.bond_held":
        this.swarmBondsTotal.inc({ type: "held" });
        {
          const amount = event.payload.amount as number | undefined;
          if (amount !== undefined) this.swarmBondAmountUsd.inc({ type: "held" }, amount);
        }
        break;

      case "swarm.bond_released":
        this.swarmBondsTotal.inc({ type: "released" });
        {
          const amount = event.payload.amount as number | undefined;
          if (amount !== undefined) this.swarmBondAmountUsd.inc({ type: "released" }, amount);
        }
        break;

      case "swarm.bond_slashed":
        this.swarmBondsTotal.inc({ type: "slashed" });
        {
          const amount = event.payload.slashed_amount as number | undefined;
          if (amount !== undefined) this.swarmBondAmountUsd.inc({ type: "slashed" }, amount);
        }
        break;

      case "swarm.consensus_round_created":
        this.swarmConsensusRoundsTotal.inc({ outcome: "created" });
        break;

      case "swarm.consensus_vote_received":
        // Just track — individual votes don't increment round counters
        break;

      case "swarm.consensus_reached": {
        this.swarmConsensusRoundsTotal.inc({ outcome: "agreed" });
        const ratio = event.payload.agreement_ratio as number | undefined;
        if (ratio !== undefined) this.swarmConsensusAgreementRatio.observe(ratio);
        break;
      }

      case "swarm.consensus_failed": {
        this.swarmConsensusRoundsTotal.inc({ outcome: "disagreed" });
        const ratio = event.payload.agreement_ratio as number | undefined;
        if (ratio !== undefined) this.swarmConsensusAgreementRatio.observe(ratio);
        break;
      }

      case "swarm.firebreak_triggered":
        this.swarmFirebreaksTotal.inc({ action: "halt" });
        break;

      case "swarm.firebreak_authority_requested":
        this.swarmFirebreaksTotal.inc({ action: "request_authority" });
        break;

      case "swarm.delegatee_routed": {
        const target = (event.payload.target as string | undefined) ?? "unknown";
        this.swarmDelegateeRoutingTotal.inc({ target });
        break;
      }

      case "swarm.human_delegation_requested":
        this.swarmDelegateeRoutingTotal.inc({ target: "human_requested" });
        break;

      case "swarm.behavioral_observation_recorded":
        // Tracked via behavioral_score_updated
        break;

      case "swarm.behavioral_score_updated": {
        const nodeId = (event.payload.node_id as string | undefined) ?? "unknown";
        const newScore = event.payload.new_score as number | undefined;
        if (newScore !== undefined) {
          this.swarmBehavioralScoresGauge.set({ peer_node_id: nodeId }, newScore);
        }
        break;
      }

      case "swarm.contract_renegotiation_requested":
        this.swarmRenegotiationsTotal.inc({ outcome: "requested" });
        break;

      case "swarm.contract_renegotiation_accepted":
        this.swarmRenegotiationsTotal.inc({ outcome: "accepted" });
        break;

      case "swarm.contract_renegotiation_rejected":
        this.swarmRenegotiationsTotal.inc({ outcome: "rejected" });
        break;

      case "swarm.friction_assessed": {
        const level = (event.payload.level as string | undefined) ?? "unknown";
        this.swarmFrictionAssessmentsTotal.inc({ level });
        break;
      }

      case "swarm.friction_escalation_triggered":
        // Already tracked by friction_assessed
        break;

      case "swarm.friction_approval_received":
        this.swarmFrictionAssessmentsTotal.inc({ level: "approved" });
        break;

      case "swarm.sabotage_detected": {
        const indicator = (event.payload.indicator as string | undefined) ?? "unknown";
        this.swarmSabotageReportsTotal.inc({ indicator });
        break;
      }

      case "swarm.feedback_discounted":
        this.swarmSabotageReportsTotal.inc({ indicator: "discounted" });
        break;

      case "swarm.checkpoint_saved":
        this.swarmCheckpointsSavedTotal.inc();
        break;

      case "swarm.task_resumed_from_checkpoint":
        this.swarmCheckpointsSavedTotal.inc();
        break;

      case "swarm.bid_committed":
        // Tracked via existing bid metrics
        break;

      case "swarm.bid_revealed":
        // Tracked via existing bid metrics
        break;

      case "swarm.front_running_detected":
        this.swarmFrontRunningTotal.inc();
        break;

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

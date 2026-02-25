/**
 * KarnEvil9 Core Types
 *
 * These are the canonical data models for the entire runtime.
 * Every component references these types. Nothing is implicit.
 */

// ─── Session ────────────────────────────────────────────────────────

export type SessionStatus =
  | "created"
  | "planning"
  | "running"
  | "awaiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "aborted";

export type ExecutionMode = "real" | "dry_run" | "mock";

export interface SessionLimits {
  max_steps: number;
  max_duration_ms: number;
  max_cost_usd: number;
  max_tokens: number;
  max_iterations?: number;
}

export interface PolicyProfile {
  allowed_paths: string[];
  allowed_endpoints: string[];
  allowed_commands: string[];
  require_approval_for_writes: boolean;
  readonly_paths?: string[];
  writable_paths?: string[];
}

export interface Session {
  session_id: string;
  status: SessionStatus;
  mode: ExecutionMode;
  task: Task;
  active_plan_id: string | null;
  limits: SessionLimits;
  policy: PolicyProfile;
  created_at: string;
  updated_at: string;
}

// ─── Task ───────────────────────────────────────────────────────────

export interface TaskConstraints {
  tool_allowlist?: string[];
  tool_denylist?: string[];
  path_scope?: string[];
  [key: string]: unknown;
}

export interface Task {
  task_id: string;
  text: string;
  constraints?: TaskConstraints;
  submitted_by?: string;
  created_at: string;
}

// ─── Plan ───────────────────────────────────────────────────────────

export type FailurePolicy = "abort" | "replan" | "continue";

export interface ToolRef {
  name: string;
  version_range?: string;
}

export interface Step {
  step_id: string;
  title: string;
  description?: string;
  tool_ref: ToolRef;
  input: Record<string, unknown>;
  success_criteria: string[];
  failure_policy: FailurePolicy;
  timeout_ms: number;
  max_retries: number;
  depends_on?: string[];
  input_from?: Record<string, string>;
}

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface StepResult {
  step_id: string;
  status: StepStatus;
  output?: unknown;
  error?: { code: string; message: string; data?: unknown };
  started_at: string;
  finished_at?: string;
  attempts: number;
}

export interface ArtifactSpec {
  name: string;
  type: "file" | "patch" | "pr_url" | "report" | "other";
  description?: string;
}

export interface Plan {
  plan_id: string;
  schema_version: string;
  goal: string;
  assumptions: string[];
  steps: Step[];
  artifacts?: ArtifactSpec[];
  created_at: string;
}

// ─── Usage / Cost Tracking ──────────────────────────────────────────

export interface UsageMetrics {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd?: number;
  model?: string;
}

export interface PlanResult {
  plan: Plan;
  usage?: UsageMetrics;
}

export interface ModelPricing {
  input_cost_per_1k_tokens: number;
  output_cost_per_1k_tokens: number;
}

// ─── Tool Manifest ──────────────────────────────────────────────────

export type ToolRunner = "shell" | "http" | "internal" | "container";

export interface ToolManifest {
  name: string;
  version: string;
  description: string;
  runner: ToolRunner;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  permissions: string[];
  timeout_ms: number;
  supports: {
    mock: true;
    dry_run: boolean;
  };
  mock_responses?: Record<string, unknown>[];
}

// ─── Error Infrastructure ───────────────────────────────────────────

export const ErrorCodes = {
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  CIRCUIT_BREAKER_OPEN: "CIRCUIT_BREAKER_OPEN",
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_OUTPUT: "INVALID_OUTPUT",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  EXECUTION_ERROR: "EXECUTION_ERROR",
  POLICY_VIOLATION: "POLICY_VIOLATION",
  NO_RUNTIME: "NO_RUNTIME",
  TIMEOUT: "TIMEOUT",
  DURATION_LIMIT: "DURATION_LIMIT",
  SESSION_LIMIT_REACHED: "SESSION_LIMIT_REACHED",
  PLUGIN_NOT_FOUND: "PLUGIN_NOT_FOUND",
  PLUGIN_LOAD_FAILED: "PLUGIN_LOAD_FAILED",
  PLUGIN_TIMEOUT: "PLUGIN_TIMEOUT",
  PLUGIN_HOOK_FAILED: "PLUGIN_HOOK_FAILED",
  PLUGIN_HOOK_BLOCKED: "PLUGIN_HOOK_BLOCKED",
  SCHEDULE_NOT_FOUND: "SCHEDULE_NOT_FOUND",
  SCHEDULE_INVALID: "SCHEDULE_INVALID",
  SCHEDULER_NOT_RUNNING: "SCHEDULER_NOT_RUNNING",
  VAULT_NOT_FOUND: "VAULT_NOT_FOUND",
  VAULT_SCHEMA_INVALID: "VAULT_SCHEMA_INVALID",
  VAULT_INGESTION_FAILED: "VAULT_INGESTION_FAILED",
  VAULT_CLASSIFICATION_FAILED: "VAULT_CLASSIFICATION_FAILED",
  VAULT_EMBEDDING_FAILED: "VAULT_EMBEDDING_FAILED",
  VAULT_NO_EMBEDDER: "VAULT_NO_EMBEDDER",
  SWARM_NO_PEERS: "SWARM_NO_PEERS",
  SWARM_CONTRACT_VIOLATED: "SWARM_CONTRACT_VIOLATED",
  SWARM_ATTESTATION_INVALID: "SWARM_ATTESTATION_INVALID",
  SWARM_REDELEGATION_EXHAUSTED: "SWARM_REDELEGATION_EXHAUSTED",
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

export class KarnEvil9Error extends Error {
  readonly code: ErrorCode;
  readonly data?: unknown;
  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "KarnEvil9Error";
    this.code = code;
    this.data = data;
  }
}

// ─── Tool Execution ─────────────────────────────────────────────────

export interface ToolExecutionRequest {
  request_id: string;
  tool_name: string;
  tool_version: string;
  input: Record<string, unknown>;
  mode: ExecutionMode;
  session_id: string;
  step_id: string;
}

export interface ToolExecutionResult {
  request_id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; data?: unknown };
  duration_ms: number;
  mode: ExecutionMode;
  cost_usd?: number;
  tokens_used?: number;
}

// ─── Permissions ────────────────────────────────────────────────────

export interface Permission {
  scope: string;
  domain: string;
  action: string;
  target: string;
}

export type ApprovalDecision = "allow_once" | "allow_session" | "allow_always" | "deny"
  | AllowConstrained | AllowObserved | DenyWithAlternative;

export interface AllowConstrained {
  type: "allow_constrained";
  scope: "once" | "session" | "always";
  constraints: PermissionConstraints;
}

export interface AllowObserved {
  type: "allow_observed";
  scope: "once" | "session" | "always";
  telemetry_level: "basic" | "detailed";
}

export interface DenyWithAlternative {
  type: "deny_with_alternative";
  reason: string;
  alternative: { tool_name: string; suggested_input?: Record<string, unknown> };
}

export interface PermissionConstraints {
  readonly_paths?: string[];
  writable_paths?: string[];
  max_duration_ms?: number;
  input_overrides?: Record<string, unknown>;
  output_redact_fields?: string[];
}

export interface PermissionCheckResult {
  allowed: boolean;
  constraints?: PermissionConstraints;
  observed?: boolean;
  alternative?: { tool_name: string; suggested_input?: Record<string, unknown> };
}

export interface PermissionRequest {
  request_id: string;
  session_id: string;
  step_id: string;
  tool_name: string;
  permissions: Permission[];
}

export interface PermissionGrant {
  scope: string;
  decision: ApprovalDecision;
  granted_by: string;
  granted_at: string;
  ttl?: "step" | "session" | "global";
}

// ─── Journal Events ─────────────────────────────────────────────────

export type JournalEventType =
  | "session.created"
  | "session.started"
  | "session.completed"
  | "session.failed"
  | "session.aborted"
  | "session.paused"
  | "session.resumed"
  | "planner.requested"
  | "planner.plan_received"
  | "planner.plan_rejected"
  | "plan.accepted"
  | "plan.replaced"
  | "step.started"
  | "step.succeeded"
  | "step.failed"
  | "permission.requested"
  | "permission.granted"
  | "permission.denied"
  | "tool.requested"
  | "tool.started"
  | "tool.succeeded"
  | "tool.failed"
  | "policy.violated"
  | "session.checkpoint"
  | "limit.exceeded"
  | "plugin.discovered"
  | "plugin.loading"
  | "plugin.loaded"
  | "plugin.failed"
  | "plugin.unloaded"
  | "plugin.reloaded"
  | "plugin.hook_fired"
  | "plugin.hook_failed"
  | "plugin.hook_circuit_open"
  | "plugin.service_started"
  | "plugin.service_stopped"
  | "plugin.service_failed"
  | "plan.criticized"
  | "memory.lesson_extracted"
  | "futility.detected"
  | "permission.observed_execution"
  | "usage.recorded"
  | "context.budget_assessed"
  | "context.delegation_started"
  | "context.delegation_completed"
  | "context.checkpoint_triggered"
  | "context.summarize_triggered"
  | "context.checkpoint_saved"
  | "context.checkpoint_failed"
  | "context.session_rotated"
  | "scheduler.started"
  | "scheduler.stopped"
  | "scheduler.job_triggered"
  | "scheduler.job_completed"
  | "scheduler.job_failed"
  | "scheduler.job_skipped"
  | "scheduler.schedule_created"
  | "scheduler.schedule_updated"
  | "scheduler.schedule_deleted"
  | "scheduler.schedule_paused"
  | "scheduler.save_failed"
  | "swarm.started"
  | "swarm.stopped"
  | "swarm.peer_joined"
  | "swarm.peer_left"
  | "swarm.peer_suspected"
  | "swarm.peer_unreachable"
  | "swarm.task_delegated"
  | "swarm.task_accepted"
  | "swarm.task_result_received"
  | "swarm.task_delegation_failed"
  | "swarm.task_delegation_timeout"
  | "swarm.gossip_round"
  | "swarm.contract_created"
  | "swarm.contract_completed"
  | "swarm.contract_violated"
  | "swarm.task_redelegated"
  | "swarm.reputation_updated"
  | "swarm.task_checkpoint_received"
  | "swarm.task_checkpoint_missed"
  | "swarm.task_monitoring_started"
  | "swarm.task_monitoring_stopped"
  | "swarm.task_cancelled"
  | "swarm.budget_alert"
  | "swarm.task_preempted"
  | "swarm.attestation_chain_invalid"
  | "swarm.task_verified"
  | "swarm.task_verification_failed"
  | "swarm.dispute_opened"
  | "swarm.dispute_resolved"
  | "swarm.task_decomposed"
  | "swarm.reoptimization_triggered"
  | "swarm.peer_redelegate_on_drift"
  | "swarm.anomaly_detected"
  | "swarm.data_access_violation"
  | "swarm.monitoring_event_pushed"
  | "swarm.pareto_selection_completed"
  | "swarm.gaming_detected"
  | "swarm.monitoring_level_negotiated"
  | "swarm.reversibility_escalation"
  | "swarm.root_cause_diagnosed"
  | "swarm.peer_credential_verified"
  | "swarm.peer_credential_rejected"
  | "swarm.credential_issued"
  | "swarm.task_decomposed_recursive"
  | "swarm.proposals_generated"
  | "swarm.dct_created"
  | "swarm.dct_attenuated"
  | "swarm.dct_validated"
  | "swarm.dct_validation_failed"
  | "swarm.dct_revoked"
  | "swarm.sybil_detected"
  | "swarm.collusion_detected"
  | "swarm.proof_of_work_required"
  | "swarm.proof_of_work_verified"
  | "swarm.auction_created"
  | "swarm.bid_received"
  | "swarm.auction_awarded"
  | "swarm.bond_held"
  | "swarm.bond_released"
  | "swarm.bond_slashed"
  | "swarm.consensus_round_created"
  | "swarm.consensus_vote_received"
  | "swarm.consensus_reached"
  | "swarm.consensus_failed"
  | "swarm.firebreak_triggered"
  | "swarm.firebreak_authority_requested"
  | "swarm.delegatee_routed"
  | "swarm.human_delegation_requested"
  | "swarm.behavioral_observation_recorded"
  | "swarm.behavioral_score_updated"
  | "swarm.contract_renegotiation_requested"
  | "swarm.contract_renegotiation_accepted"
  | "swarm.contract_renegotiation_rejected"
  | "swarm.friction_assessed"
  | "swarm.friction_escalation_triggered"
  | "swarm.friction_approval_received"
  | "swarm.sabotage_detected"
  | "swarm.feedback_discounted"
  | "swarm.checkpoint_saved"
  | "swarm.task_resumed_from_checkpoint"
  | "swarm.bid_committed"
  | "swarm.bid_revealed"
  | "swarm.front_running_detected"
  | "agent.started"
  | "agent.progress"
  | "agent.tool_call"
  | "agent.completed"
  | "agent.failed"
  | "agent.aborted"
  | "hook.input_modified"
  | "vault.ingestion_started"
  | "vault.ingestion_completed"
  | "vault.object_created"
  | "vault.object_updated"
  | "vault.object_classified"
  | "vault.entity_extracted"
  | "vault.entity_deduplicated"
  | "vault.link_created"
  | "vault.context_generated"
  | "vault.janitor_completed"
  | "vault.vectorize_completed"
  | "vault.relationships_discovered"
  | "vault.dashboard_generated"
  | "vault.insights_generated"
  | "vault.dropzone_processed"
  | "vault.error"
  | "journal.disk_warning"
  | "journal.disk_critical";

// ─── Context Budget / Checkpoint ────────────────────────────────────

export interface CheckpointFinding {
  step_title: string;
  tool_name: string;
  status: "succeeded" | "failed";
  summary: string;
}

export interface SessionCheckpointData {
  checkpoint_id: string;
  source_session_id: string;
  task_text: string;
  findings: CheckpointFinding[];
  next_steps: string[];
  open_questions: string[];
  last_plan_goal: string;
  usage_at_checkpoint: { total_tokens: number; total_cost_usd: number; iterations_completed: number };
  artifacts: Record<string, unknown>;
  created_at: string;
}

export interface JournalEvent {
  event_id: string;
  timestamp: string;
  session_id: string;
  type: JournalEventType;
  payload: Record<string, unknown>;
  hash_prev?: string;
  seq?: number;
}

// ─── Memory ─────────────────────────────────────────────────────────

export interface TaskState {
  session_id: string;
  plan: Plan | null;
  step_results: Map<string, StepResult>;
  artifacts: Map<string, unknown>;
}

export interface WorkingMemory {
  session_id: string;
  entries: Map<string, unknown>;
}

export interface MemoryItem {
  key: string;
  value: unknown;
  source: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryLesson {
  lesson_id: string;
  task_summary: string;
  outcome: "succeeded" | "failed";
  lesson: string;
  tool_names: string[];
  created_at: string;
  session_id: string;
  relevance_count: number;
  last_retrieved_at?: string;
}

// ─── Planner Contract ───────────────────────────────────────────────

/** Tool schema as presented to the planner (no implementation details). */
export interface ToolSchemaForPlanner {
  name: string;
  version: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
}

/** Planner interface. Defined here so kernel and planner packages share it without circular deps. */
export interface Planner {
  generatePlan(
    task: Task,
    toolSchemas: ToolSchemaForPlanner[],
    stateSnapshot: Record<string, unknown>,
    constraints: Record<string, unknown>
  ): Promise<PlanResult>;
}

// ─── Tool Handler ──────────────────────────────────────────────────

export type ToolHandler = (
  input: Record<string, unknown>,
  mode: ExecutionMode,
  policy: PolicyProfile
) => Promise<unknown>;

// ─── Plugin System ─────────────────────────────────────────────────

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  entry: string;
  permissions: string[];
  config_schema?: Record<string, unknown>;
  provides: {
    tools?: string[];
    hooks?: HookName[];
    routes?: string[];
    commands?: string[];
    planners?: string[];
    services?: string[];
  };
}

export type PluginStatus = "discovered" | "loading" | "active" | "failed" | "unloaded";

export interface PluginState {
  id: string;
  manifest: PluginManifest;
  status: PluginStatus;
  loaded_at?: string;
  failed_at?: string;
  error?: string;
  config: Record<string, unknown>;
}

export type HookName =
  | "before_session_start"
  | "after_session_end"
  | "before_plan"
  | "after_plan"
  | "before_step"
  | "after_step"
  | "before_tool_call"
  | "after_tool_call"
  | "on_error";

export interface HookContext {
  session_id: string;
  plugin_id: string;
  [key: string]: unknown;
}

export type HookResult =
  | { action: "continue"; data?: Record<string, unknown> }
  | { action: "modify"; data: Record<string, unknown> }
  | { action: "block"; reason: string }
  | { action: "observe" };

export type HookHandler = (context: HookContext) => Promise<HookResult>;

export interface HookOptions {
  priority?: number;
  timeout_ms?: number;
}

export interface HookRegistration {
  plugin_id: string;
  hook: HookName;
  handler: HookHandler;
  priority: number;
  timeout_ms: number;
}

export interface PluginService {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  health?(): Promise<{ ok: boolean; detail?: string }>;
}

export interface PluginLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export type RouteHandler = (
  req: { method: string; path: string; params: Record<string, string>; query: Record<string, string>; body: unknown; headers?: Record<string, string> },
  res: {
    json(data: unknown): void;
    text(data: string, contentType?: string): void;
    status(code: number): { json(data: unknown): void; text(data: string, contentType?: string): void };
  }
) => Promise<void>;

export interface CommandOptions {
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
  options?: Array<{ flags: string; description: string; default?: unknown }>;
  action: (...args: unknown[]) => Promise<void>;
}

export type PluginRegisterFn = (api: PluginApi) => Promise<void>;

export interface PluginApi {
  readonly id: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly logger: PluginLogger;
  registerTool(manifest: ToolManifest, handler: ToolHandler): void;
  registerHook(hook: HookName, handler: HookHandler, opts?: HookOptions): void;
  registerRoute(method: string, path: string, handler: RouteHandler): void;
  registerCommand(name: string, opts: CommandOptions): void;
  registerPlanner(planner: Planner): void;
  registerService(service: PluginService): void;
}

// ─── Scheduler ─────────────────────────────────────────────────────

export type ScheduleType = "at" | "every" | "cron";
export type JobActionType = "createSession" | "emitEvent";
export type ScheduleStatus = "active" | "paused" | "completed" | "failed";
export type MissedSchedulePolicy = "skip" | "catchup_one" | "catchup_all";

export interface ScheduleTriggerAt { type: "at"; at: string; }
export interface ScheduleTriggerEvery { type: "every"; interval: string; start_at?: string; }
export interface ScheduleTriggerCron { type: "cron"; expression: string; timezone?: string; }
export type ScheduleTrigger = ScheduleTriggerAt | ScheduleTriggerEvery | ScheduleTriggerCron;

export interface JobActionCreateSession {
  type: "createSession";
  task_text: string;
  mode?: ExecutionMode;
  constraints?: TaskConstraints;
  agentic?: boolean;
}

export interface JobActionEmitEvent {
  type: "emitEvent";
  session_id?: string;
  event_type: JournalEventType;
  payload: Record<string, unknown>;
}

export type JobAction = JobActionCreateSession | JobActionEmitEvent;

export interface ScheduleOptions {
  delete_after_run?: boolean;
  missed_policy?: MissedSchedulePolicy;
  max_failures?: number;
  description?: string;
  tags?: string[];
}

export interface Schedule {
  schedule_id: string;
  name: string;
  trigger: ScheduleTrigger;
  action: JobAction;
  options: ScheduleOptions;
  status: ScheduleStatus;
  run_count: number;
  failure_count: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_session_id?: string;
  last_error?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

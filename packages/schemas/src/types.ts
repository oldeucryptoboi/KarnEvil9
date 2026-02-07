/**
 * OpenFlaw Core Types
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
}

export interface PolicyProfile {
  allowed_paths: string[];
  allowed_endpoints: string[];
  allowed_commands: string[];
  require_approval_for_writes: boolean;
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
}

// ─── Permissions ────────────────────────────────────────────────────

export interface Permission {
  scope: string;
  domain: string;
  action: string;
  target: string;
}

export type ApprovalDecision = "allow_once" | "allow_session" | "allow_always" | "deny";

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
  | "tool.failed";

export interface JournalEvent {
  event_id: string;
  timestamp: string;
  session_id: string;
  type: JournalEventType;
  payload: Record<string, unknown>;
  hash_prev?: string;
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
  ): Promise<Plan>;
}

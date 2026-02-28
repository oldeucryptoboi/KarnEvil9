import type {
  Task,
  SessionLimits,
  PolicyProfile,
  ExecutionMode,
  Planner,
  ModelPricing,
  CheckpointFinding,
} from "@karnevil9/schemas";
import type { Journal } from "@karnevil9/journal";
import type { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import { PermissionEngine, DelegationBridge } from "@karnevil9/permissions";
import { v4 as uuid } from "uuid";
import { Kernel } from "./kernel.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface SubagentRequest {
  task_text: string;
  tool_allowlist?: string[];
  max_tokens: number;
  max_cost_usd: number;
  max_iterations: number;
  max_duration_ms: number;
}

export interface SubagentResult {
  status: "completed" | "failed" | "aborted";
  findings: CheckpointFinding[];
  subagent_session_id: string;
  tokens_used: number;
  cost_usd: number;
}

// ─── Shared dependencies for child kernel ───────────────────────────

export interface SubagentDeps {
  journal: Journal;
  toolRegistry: ToolRegistry;
  toolRuntime?: ToolRuntime;
  permissions?: PermissionEngine;
  planner?: Planner;
  mode: ExecutionMode;
  policy: PolicyProfile;
  modelPricing?: ModelPricing;
  parentSessionId?: string;
  delegationSecret?: string;
}

// ─── Runner ─────────────────────────────────────────────────────────

export async function runSubagent(
  deps: SubagentDeps,
  request: SubagentRequest,
): Promise<SubagentResult> {
  const limits: SessionLimits = {
    max_steps: 20,
    max_duration_ms: request.max_duration_ms,
    max_cost_usd: request.max_cost_usd,
    max_tokens: request.max_tokens,
    max_iterations: request.max_iterations,
  };

  // Derive constrained child permissions via delegation bridge
  let childPermissions = deps.permissions;
  if (deps.parentSessionId && deps.delegationSecret && deps.permissions) {
    const bridge = new DelegationBridge({ signingSecret: deps.delegationSecret });
    const parentGrants = deps.permissions.listGrants(deps.parentSessionId);
    const token = bridge.deriveChildToken(parentGrants, uuid(), {
      tool_allowlist: request.tool_allowlist,
    });
    const childEngine = new PermissionEngine(
      deps.journal,
      deps.permissions.getPromptFn(),
    );
    bridge.applyTokenAsGrants(childEngine, "child-" + uuid(), token);
    const enforcer = bridge.createEnforcer(token);
    childEngine.setDCTEnforcer(enforcer);
    childPermissions = childEngine;
  }

  const childKernel = new Kernel({
    journal: deps.journal,
    toolRegistry: deps.toolRegistry,
    toolRuntime: deps.toolRuntime,
    permissions: childPermissions,
    planner: deps.planner,
    mode: deps.mode,
    limits,
    policy: deps.policy,
    agentic: true,
    modelPricing: deps.modelPricing,
    // No contextBudgetConfig — prevent nested delegation
  });

  const task: Task = {
    task_id: uuid(),
    text: request.task_text,
    constraints: request.tool_allowlist ? { tool_allowlist: request.tool_allowlist } : undefined,
    created_at: new Date().toISOString(),
  };

  const session = await childKernel.createSession(task);

  try {
    await childKernel.run();
  } catch {
    // Child failure should not crash parent
  }

  const taskState = childKernel.getTaskState();
  const usageSummary = childKernel.getUsageSummary();
  const finalSession = childKernel.getSession();

  const findings: CheckpointFinding[] = [];
  if (taskState) {
    const plan = taskState.getPlan();
    const stepResults = taskState.getAllStepResults();
    for (const result of stepResults) {
      const step = plan?.steps.find(s => s.step_id === result.step_id);
      const rawSummary = result.status === "succeeded"
        ? (typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? ""))
        : (result.error?.message ?? "unknown error");
      findings.push({
        step_title: step?.title ?? result.step_id,
        tool_name: step?.tool_ref.name ?? "unknown",
        status: result.status === "succeeded" ? "succeeded" : "failed",
        summary: rawSummary.slice(0, 500),
      });
    }
  }

  return {
    status: finalSession?.status === "completed" ? "completed"
      : finalSession?.status === "aborted" ? "aborted"
      : "failed",
    findings,
    subagent_session_id: session.session_id,
    tokens_used: usageSummary?.total_tokens ?? 0,
    cost_usd: usageSummary?.total_cost_usd ?? 0,
  };
}

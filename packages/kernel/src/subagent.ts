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
  tool_blocklist?: string[];
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

  // If blocklist specified, create a filtered registry proxy that hides blocked tools
  // from the planner's schema list so it never plans steps using them.
  let childRegistry = deps.toolRegistry;
  if (request.tool_blocklist && request.tool_blocklist.length > 0) {
    const blocked = new Set(request.tool_blocklist);
    childRegistry = new Proxy(deps.toolRegistry, {
      get(target, prop, receiver) {
        if (prop === "list") {
          return () => target.list().filter(t => !blocked.has(t.name));
        }
        if (prop === "getSchemasForPlanner") {
          return () => target.getSchemasForPlanner().filter(s => !blocked.has(s.name));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  const childKernel = new Kernel({
    journal: deps.journal,
    toolRegistry: childRegistry,
    toolRuntime: deps.toolRuntime,
    permissions: childPermissions,
    planner: deps.planner,
    mode: deps.mode,
    limits,
    policy: deps.policy,
    agentic: true,
    modelPricing: deps.modelPricing,
    plannerTimeoutMs: 90_000, // Child needs time to synthesize results
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
      const toolName = step?.tool_ref.name ?? "unknown";
      let rawSummary: string;
      if (result.status === "succeeded") {
        // For respond steps, extract the text field directly to preserve full output
        if (toolName === "respond" && typeof result.output === "object" && result.output !== null) {
          const out = result.output as Record<string, unknown>;
          rawSummary = typeof out.text === "string" ? out.text : JSON.stringify(result.output);
        } else {
          rawSummary = typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? "");
        }
      } else {
        rawSummary = result.error?.message ?? "unknown error";
      }
      // Generous limit for respond text, compact for other tools
      const maxLen = toolName === "respond" ? 4000 : 500;
      findings.push({
        step_title: step?.title ?? result.step_id,
        tool_name: toolName,
        status: result.status === "succeeded" ? "succeeded" : "failed",
        summary: rawSummary.slice(0, maxLen),
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

// ─── Helpers for extracting child session output ─────────────────

/**
 * Scan a child session's findings for a `respond` tool step and extract
 * the `.text` field from its output. Returns undefined if no respond step found.
 */
export function extractRespondText(result: SubagentResult): string | undefined {
  for (const finding of result.findings) {
    if (finding.tool_name === "respond" && finding.status === "succeeded" && finding.summary) {
      // The finding summary may be the raw JSON output from respond handler: { delivered: true, text: "..." }
      try {
        const parsed = JSON.parse(finding.summary);
        if (typeof parsed === "object" && parsed !== null && typeof parsed.text === "string") {
          return parsed.text;
        }
      } catch {
        // Not JSON — use the summary string directly
      }
      return finding.summary;
    }
  }
  return undefined;
}

/**
 * Fallback summarizer: concatenates finding summaries into a readable string.
 */
export function summarizeFindings(findings: CheckpointFinding[]): string {
  if (findings.length === 0) return "No findings from child session.";
  return findings
    .map(f => `[${f.status}] ${f.step_title} (${f.tool_name}): ${f.summary}`)
    .join("\n");
}

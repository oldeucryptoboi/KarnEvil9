import type { ToolHandler } from "../tool-runtime.js";
import type { CheckpointFinding } from "@karnevil9/schemas";

// ─── Local type definitions ──────────────────────────────────────────
// These mirror kernel types to avoid a circular dependency (tools → kernel).
// The actual implementations are injected via DelegateHandlerDeps.

interface SubagentRequest {
  task_text: string;
  tool_allowlist?: string[];
  tool_blocklist?: string[];
  max_tokens: number;
  max_cost_usd: number;
  max_iterations: number;
  max_duration_ms: number;
}

interface SubagentResult {
  status: "completed" | "failed" | "aborted";
  findings: CheckpointFinding[];
  subagent_session_id: string;
  tokens_used: number;
  cost_usd: number;
}

export interface DelegateHandlerDeps {
  /** Mutable deps object passed to runSubagent — planner is set after construction */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subagentDeps: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runSubagent: (deps: any, request: SubagentRequest) => Promise<SubagentResult>;
  extractRespondText: (result: SubagentResult) => string | undefined;
  summarizeFindings: (findings: CheckpointFinding[]) => string;
}

/**
 * Factory function that creates a delegate tool handler.
 * The handler spawns a child session via runSubagent() to process a subtask
 * and returns a concise summary, keeping the parent session's context clean.
 */
export function createDelegateHandler(deps: DelegateHandlerDeps): ToolHandler {
  return async (
    input: Record<string, unknown>,
    mode,
    _policy,
  ): Promise<unknown> => {
    // Validate input
    if (typeof input.task !== "string" || !input.task.trim()) {
      throw new Error("input.task must be a non-empty string");
    }

    const task = input.task.trim();

    // Dry run support
    if (mode === "dry_run") {
      return {
        status: "dry_run",
        summary: `[dry_run] Would delegate: ${task.slice(0, 200)}...`,
      };
    }

    // Parse optional parameters
    let toolAllowlist = Array.isArray(input.tool_allowlist)
      ? (input.tool_allowlist as string[]).filter(t => typeof t === "string")
      : undefined;
    const maxIterations = typeof input.max_iterations === "number" && input.max_iterations > 0
      ? Math.min(input.max_iterations, 15) // cap at 15 to prevent runaway children
      : 5;

    // Prevent nested delegation: strip 'delegate' from allowlist if present
    if (toolAllowlist) {
      toolAllowlist = toolAllowlist.filter(t => t !== "delegate");
    }

    // Build SubagentRequest
    const request: SubagentRequest = {
      task_text: task,
      tool_allowlist: toolAllowlist,
      tool_blocklist: ["delegate"],
      max_tokens: 100_000,
      max_cost_usd: 0.50,
      max_iterations: maxIterations,
      max_duration_ms: 120_000, // 2 minutes
    };

    const result = await deps.runSubagent(deps.subagentDeps, request);

    // Extract the child's respond text if available, otherwise summarize findings
    const summary = deps.extractRespondText(result) || deps.summarizeFindings(result.findings);

    return {
      status: result.status,
      summary,
      findings: result.findings,
      session_id: result.subagent_session_id,
      tokens_used: result.tokens_used,
    };
  };
}

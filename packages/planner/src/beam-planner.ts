/**
 * Adaptive Beam Search Planner (K=2)
 *
 * Inspired by "Probabilistic Dreaming for World Models" (Gavin Wong, ICLR 2026),
 * which showed that maintaining just K=2 hypotheses about state gives 4.5%
 * improvement and 28% lower variance by avoiding mode collapse. Applied here
 * to agentic planning: generate a primary plan, then a contrastive alternative
 * using a different strategy, score both, and pick the winner.
 *
 * Paper: https://arxiv.org/abs/2505.07077
 */
import type { Task, Plan, PlanResult, Planner, ToolSchemaForPlanner, UsageMetrics } from "@karnevil9/schemas";

// ─── Complexity Classification ─────────────────────────────────────

export type ComplexityLevel = "trivial" | "moderate" | "complex";

export interface ComplexitySignals {
  taskWordCount: number;
  hasPlan: boolean;
  failedStepCount: number;
  toolCount: number;
  memoryHitCount: number;
  iteration: number;
}

export function extractSignals(
  task: Task,
  stateSnapshot: Record<string, unknown>,
  toolSchemas: ToolSchemaForPlanner[],
): ComplexitySignals {
  const taskWordCount = task.text.trim().split(/\s+/).length;
  const hasPlan = !!stateSnapshot.has_plan;
  const stepResults = stateSnapshot.step_results as Record<string, { status: string }> | undefined;
  let failedStepCount = 0;
  if (stepResults) {
    for (const result of Object.values(stepResults)) {
      if (result.status === "failed") failedStepCount++;
    }
  }
  const toolCount = toolSchemas.length;
  const memories = stateSnapshot.relevant_memories as unknown[] | undefined;
  const memoryHitCount = memories?.length ?? 0;
  const iteration = (stateSnapshot.iteration as number) ?? 0;

  return { taskWordCount, hasPlan, failedStepCount, toolCount, memoryHitCount, iteration };
}

export function classifyComplexity(signals: ComplexitySignals): ComplexityLevel {
  // Trivial: short task, first iteration, no history, no failures
  if (
    signals.taskWordCount <= 15 &&
    !signals.hasPlan &&
    signals.failedStepCount === 0 &&
    signals.iteration === 0
  ) {
    return "trivial";
  }

  // Complex: failures present, deep iteration, or (long task + many tools)
  if (
    signals.failedStepCount > 0 ||
    signals.iteration >= 3 ||
    (signals.taskWordCount > 50 && signals.toolCount > 8)
  ) {
    return "complex";
  }

  return "moderate";
}

// ─── Plan Scoring ──────────────────────────────────────────────────

export interface ScoringContext {
  toolOutcomes: Array<{ tool: string; status: string }>;
  memories: Array<{ task: string; outcome: string; lesson: string }>;
}

export interface ScoreBreakdown {
  structural: number;
  goalAdvancement: number;
  diversity: number;
  parsimony: number;
  toolFamiliarity: number;
  total: number;
}

export function scorePlan(
  plan: Plan,
  context: ScoringContext,
): ScoreBreakdown {
  // ── Structural quality (30 pts) ──
  let structural = 30;
  const respondSteps = plan.steps.filter(s => s.tool_ref.name === "respond");
  for (const rs of respondSteps) {
    if (!rs.depends_on || rs.depends_on.length === 0) {
      // respond without depends_on on first step is fine; otherwise penalize
      if (plan.steps.indexOf(rs) > 0) structural -= 5;
    }
  }
  // Penalize duplicate tool+input combos
  const seen = new Set<string>();
  for (const step of plan.steps) {
    const key = step.tool_ref.name + "::" + JSON.stringify(step.input);
    if (seen.has(key)) structural -= 10;
    seen.add(key);
  }
  structural = Math.max(0, structural);

  // ── Goal advancement (25 pts) ──
  let goalAdvancement = 25;
  // Reward steps that reference prior results via input_from
  const hasInputFrom = plan.steps.some(s => s.input_from && Object.keys(s.input_from).length > 0);
  if (!hasInputFrom && plan.steps.length > 1) goalAdvancement -= 5;
  // Penalize re-fetching data available from previous iterations
  const previousSuccessTools = new Set(
    context.toolOutcomes.filter(o => o.status === "succeeded").map(o => o.tool),
  );
  for (const step of plan.steps) {
    if (previousSuccessTools.has(step.tool_ref.name)) {
      // Same tool used previously and succeeded — might be re-fetching
      goalAdvancement -= 3;
    }
  }
  goalAdvancement = Math.max(0, goalAdvancement);

  // ── Strategy diversity (20 pts) ──
  let diversity = 20;
  const previousTools = new Set(context.toolOutcomes.map(o => o.tool));
  const currentTools = new Set(plan.steps.map(s => s.tool_ref.name));
  if (previousTools.size > 0) {
    // Reward using tools NOT used before
    let novelTools = 0;
    for (const t of currentTools) {
      if (!previousTools.has(t)) novelTools++;
    }
    const novelRatio = currentTools.size > 0 ? novelTools / currentTools.size : 0;
    diversity = Math.round(20 * (0.3 + 0.7 * novelRatio)); // baseline 30% + up to 70% for novelty
  }
  // Penalize repeating tools that previously failed
  const failedTools = new Set(
    context.toolOutcomes.filter(o => o.status === "failed").map(o => o.tool),
  );
  for (const step of plan.steps) {
    if (failedTools.has(step.tool_ref.name)) diversity -= 5;
  }
  diversity = Math.max(0, diversity);

  // ── Parsimony (15 pts) ──
  // Fewer steps is better (Occam's razor), with diminishing penalty
  const stepCount = plan.steps.length;
  let parsimony: number;
  if (stepCount <= 2) parsimony = 15;
  else if (stepCount <= 4) parsimony = 12;
  else if (stepCount <= 6) parsimony = 9;
  else if (stepCount <= 8) parsimony = 6;
  else parsimony = 3;

  // ── Tool familiarity (10 pts) ──
  let toolFamiliarity = 5; // base score
  if (context.memories.length > 0) {
    // Bonus for tools that succeeded in memory lessons
    const successLessons = context.memories.filter(m => m.outcome === "success");
    if (successLessons.length > 0) {
      toolFamiliarity += Math.min(5, successLessons.length);
    }
  }

  const total = structural + goalAdvancement + diversity + parsimony + toolFamiliarity;

  return { structural, goalAdvancement, diversity, parsimony, toolFamiliarity, total };
}

// ─── BeamPlanner (Decorator) ───────────────────────────────────────

export interface BeamPlannerConfig {
  delegate: Planner;
  /** Minimum complexity level to trigger beam search. Default: "complex" */
  beamThreshold?: "moderate" | "complex";
}

export class BeamPlanner implements Planner {
  private delegate: Planner;
  private beamThreshold: "moderate" | "complex";

  constructor(config: BeamPlannerConfig) {
    this.delegate = config.delegate;
    this.beamThreshold = config.beamThreshold ?? "complex";
  }

  abort(): void {
    this.delegate.abort?.();
  }

  async generatePlan(
    task: Task,
    toolSchemas: ToolSchemaForPlanner[],
    stateSnapshot: Record<string, unknown>,
    constraints: Record<string, unknown>,
  ): Promise<PlanResult> {
    // 1. Extract complexity signals
    const signals = extractSignals(task, stateSnapshot, toolSchemas);
    const complexity = classifyComplexity(signals);

    // 2. Check if beam search should trigger
    const thresholdMet =
      this.beamThreshold === "moderate"
        ? complexity === "moderate" || complexity === "complex"
        : complexity === "complex";

    if (!thresholdMet) {
      // K=1: delegate directly, zero overhead
      return this.delegate.generatePlan(task, toolSchemas, stateSnapshot, constraints);
    }

    // 3. Generate primary plan via delegate
    const primary = await this.delegate.generatePlan(task, toolSchemas, stateSnapshot, constraints);

    // 4. If primary has 0 steps (done signal), return immediately
    if (primary.plan.steps.length === 0) {
      return primary;
    }

    // 5. Build contrastive snapshot
    const primarySummary = primary.plan.steps
      .map(s => `${s.step_id}: ${s.tool_ref.name} — ${s.title}`)
      .join("\n");
    const primaryTools = [...new Set(primary.plan.steps.map(s => s.tool_ref.name))];

    const contrastiveSnapshot: Record<string, unknown> = {
      ...stateSnapshot,
      beam_contrastive: {
        primary_plan_summary: primarySummary,
        primary_tools: primaryTools,
        instruction:
          "Generate a FUNDAMENTALLY DIFFERENT approach to this task. " +
          "Use different tools, different ordering, or a completely different strategy. " +
          "Do NOT simply reorder the same steps.",
      },
    };

    // 6. Generate alternative plan
    let alternative: PlanResult;
    try {
      alternative = await this.delegate.generatePlan(task, toolSchemas, contrastiveSnapshot, constraints);
    } catch {
      // Alternative generation failed — return primary
      return {
        ...primary,
        metadata: {
          ...primary.metadata,
          beam_search: {
            triggered: true,
            complexity,
            alternative_failed: true,
            winner: "primary",
          },
        },
      };
    }

    // 7. If alternative has 0 steps, return primary
    if (alternative.plan.steps.length === 0) {
      return {
        ...primary,
        metadata: {
          ...primary.metadata,
          beam_search: {
            triggered: true,
            complexity,
            alternative_empty: true,
            winner: "primary",
          },
        },
      };
    }

    // 8. Score both plans
    const scoringContext = buildScoringContext(stateSnapshot);
    const primaryScore = scorePlan(primary.plan, scoringContext);
    const alternativeScore = scorePlan(alternative.plan, scoringContext);

    // 9. Pick the winner
    const winner = alternativeScore.total > primaryScore.total ? "alternative" : "primary";
    const winnerResult = winner === "alternative" ? alternative : primary;

    // 10. Merge usage metrics
    const mergedUsage = mergeUsageMetrics(primary.usage, alternative.usage);

    return {
      plan: winnerResult.plan,
      usage: mergedUsage,
      metadata: {
        ...winnerResult.metadata,
        beam_search: {
          triggered: true,
          complexity,
          primary_score: primaryScore,
          alternative_score: alternativeScore,
          winner,
          primary_tools: primaryTools,
          alternative_tools: [...new Set(alternative.plan.steps.map(s => s.tool_ref.name))],
        },
      },
    };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function buildScoringContext(stateSnapshot: Record<string, unknown>): ScoringContext {
  const toolOutcomes: Array<{ tool: string; status: string }> = [];
  const raw = stateSnapshot.tool_outcome_history;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry && typeof entry === "object" && "tool" in entry && "status" in entry) {
        toolOutcomes.push({ tool: String(entry.tool), status: String(entry.status) });
      }
    }
  }

  const memories: Array<{ task: string; outcome: string; lesson: string }> = [];
  const rawMemories = stateSnapshot.relevant_memories;
  if (Array.isArray(rawMemories)) {
    for (const m of rawMemories) {
      if (m && typeof m === "object" && "task" in m && "outcome" in m && "lesson" in m) {
        memories.push({ task: String(m.task), outcome: String(m.outcome), lesson: String(m.lesson) });
      }
    }
  }

  return { toolOutcomes, memories };
}

function mergeUsageMetrics(
  a: UsageMetrics | undefined,
  b: UsageMetrics | undefined,
): UsageMetrics | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    cost_usd: (a.cost_usd ?? 0) + (b.cost_usd ?? 0) || undefined,
    model: a.model ?? b.model,
  };
}

import { v4 as uuid } from "uuid";
import type {
  TaskAttribute,
  SubTaskSpec,
  TaskDecomposition,
  SwarmTaskConstraints,
  VerifiabilityAssessment,
  DecompositionProposal,
} from "./types.js";
import type { DelegateeRouter } from "./delegatee-router.js";

export interface DecomposerConfig {
  complexity_floor_words?: number;    // tasks with fewer words skip delegation (default 20)
  max_sub_tasks?: number;             // max decomposition depth (default 10)
  default_timeout_ms?: number;        // per-subtask timeout (default 300000)
  default_max_cost_usd?: number;      // per-subtask cost cap (default 1.0)
  router?: DelegateeRouter;           // optional human-vs-AI router (Gap 4)
}

// ─── Keyword maps ──────────────────────────────────────────────────

const HIGH_COMPLEXITY_KEYWORDS = ["analyze", "compare", "research", "investigate", "evaluate", "synthesize", "optimize", "refactor"];
const MEDIUM_COMPLEXITY_KEYWORDS = ["implement", "create", "develop", "configure", "integrate", "migrate"];
const HIGH_CRITICALITY_KEYWORDS = ["critical", "urgent", "production", "deploy", "delete", "security", "rollback"];
const LOW_REVERSIBILITY_KEYWORDS = ["delete", "send", "deploy", "publish", "email", "push", "drop", "remove"];
const HIGH_VERIFIABILITY_KEYWORDS = ["test", "verify", "check", "count", "validate", "assert", "measure"];
const LOW_VERIFIABILITY_KEYWORDS = ["design", "brainstorm", "think", "consider", "plan", "propose"];
const HUMAN_KEYWORDS = ["approve", "review", "decide", "choose", "subjective", "opinion", "preference"];

const CAPABILITY_MAP: Record<string, string> = {
  file: "read-file",
  read: "read-file",
  write: "write-file",
  shell: "shell-exec",
  command: "shell-exec",
  run: "shell-exec",
  execute: "shell-exec",
  browser: "browser",
  web: "browser",
  scrape: "browser",
  http: "http-request",
  api: "http-request",
  fetch: "http-request",
  request: "http-request",
};

const SEQUENTIAL_CONNECTIVES = [
  "and then", "after that", "then", "next", "followed by",
  "subsequently", "once done", "when complete", "after this",
  "first", "second", "third", "finally", "lastly",
];

export class TaskDecomposer {
  private config: Required<Omit<DecomposerConfig, "router">>;
  private router?: DelegateeRouter;

  constructor(config?: DecomposerConfig) {
    this.config = {
      complexity_floor_words: config?.complexity_floor_words ?? 20,
      max_sub_tasks: config?.max_sub_tasks ?? 10,
      default_timeout_ms: config?.default_timeout_ms ?? 300000,
      default_max_cost_usd: config?.default_max_cost_usd ?? 1.0,
    };
    this.router = config?.router;
  }

  setRouter(router: DelegateeRouter): void {
    this.router = router;
  }

  analyze(taskText: string): TaskAttribute {
    const lower = taskText.toLowerCase();
    const words = taskText.split(/\s+/).filter((w) => w.length > 0);
    const wordCount = words.length;
    const sentences = taskText.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;

    // Complexity
    const hasHighComplexity = HIGH_COMPLEXITY_KEYWORDS.some((k) => lower.includes(k));
    const hasMedComplexity = MEDIUM_COMPLEXITY_KEYWORDS.some((k) => lower.includes(k));
    let complexity: TaskAttribute["complexity"] = "low";
    if (hasHighComplexity || (wordCount > 100 && sentences > 5)) {
      complexity = "high";
    } else if (hasMedComplexity || wordCount > 50 || sentences > 3) {
      complexity = "medium";
    }

    // Criticality
    const hasHighCriticality = HIGH_CRITICALITY_KEYWORDS.some((k) => lower.includes(k));
    const criticality: TaskAttribute["criticality"] = hasHighCriticality ? "high" : wordCount > 80 ? "medium" : "low";

    // Verifiability
    const hasHighVerifiability = HIGH_VERIFIABILITY_KEYWORDS.some((k) => lower.includes(k));
    const hasLowVerifiability = LOW_VERIFIABILITY_KEYWORDS.some((k) => lower.includes(k));
    let verifiability: TaskAttribute["verifiability"] = "medium";
    if (hasHighVerifiability) verifiability = "high";
    else if (hasLowVerifiability) verifiability = "low";

    // Reversibility
    const hasLowReversibility = LOW_REVERSIBILITY_KEYWORDS.some((k) => lower.includes(k));
    const reversibility: TaskAttribute["reversibility"] = hasLowReversibility ? "low" : "high";

    // Estimated cost/duration (derived from complexity)
    const costMap: Record<string, TaskAttribute["estimated_cost"]> = { low: "low", medium: "medium", high: "high" };
    const durationMap: Record<string, TaskAttribute["estimated_duration"]> = { low: "short", medium: "medium", high: "long" };

    // Required capabilities
    const required_capabilities: string[] = [];
    const capSet = new Set<string>();
    for (const [keyword, cap] of Object.entries(CAPABILITY_MAP)) {
      if (lower.includes(keyword) && !capSet.has(cap)) {
        capSet.add(cap);
        required_capabilities.push(cap);
      }
    }

    return {
      complexity,
      criticality,
      verifiability,
      reversibility,
      estimated_cost: costMap[complexity]!,
      estimated_duration: durationMap[complexity]!,
      required_capabilities,
    };
  }

  shouldDelegate(attributes: TaskAttribute): boolean {
    // Don't delegate trivially simple or highly critical low-reversibility tasks
    if (attributes.complexity === "low" && attributes.required_capabilities.length === 0) {
      return false;
    }
    if (attributes.criticality === "high" && attributes.reversibility === "low") {
      return false;
    }
    return true;
  }

  decompose(params: {
    task_text: string;
    available_peers: Array<{ node_id: string; capabilities: string[]; trust_score?: number }>;
    constraints?: SwarmTaskConstraints;
  }): TaskDecomposition {
    const { task_text, available_peers, constraints } = params;
    const words = task_text.split(/\s+/).filter((w) => w.length > 0);

    // Check complexity floor
    if (words.length < this.config.complexity_floor_words) {
      return {
        original_task_text: task_text,
        sub_tasks: [],
        execution_order: [],
        skip_delegation: true,
        skip_reason: `Task has ${words.length} words, below complexity floor of ${this.config.complexity_floor_words}`,
      };
    }

    // If no peers available, skip
    if (available_peers.length === 0) {
      return {
        original_task_text: task_text,
        sub_tasks: [],
        execution_order: [],
        skip_delegation: true,
        skip_reason: "No peers available for delegation",
      };
    }

    // Try to decompose
    const subtaskTexts = this.extractSubtasks(task_text);

    // If only one subtask and it matches the original, treat as atomic
    if (subtaskTexts.length <= 1) {
      const attributes = this.analyze(task_text);
      if (!this.shouldDelegate(attributes)) {
        return {
          original_task_text: task_text,
          sub_tasks: [],
          execution_order: [],
          skip_delegation: true,
          skip_reason: "Task is atomic and not suitable for delegation",
        };
      }

      // Single subtask — delegate as-is
      const subTaskId = uuid();
      const subTask: SubTaskSpec = {
        sub_task_id: subTaskId,
        task_text,
        attributes,
        constraints: this.attenuateConstraints(constraints, 1),
        depends_on: [],
        delegation_target: this.inferDelegationTarget(task_text),
        parallel_group: "group-0",
      };

      return {
        original_task_text: task_text,
        sub_tasks: [subTask],
        execution_order: [[subTaskId]],
      };
    }

    // Multiple subtasks
    const subTasks: SubTaskSpec[] = [];
    const isSequential = this.hasSequentialConnectives(task_text);

    for (let i = 0; i < Math.min(subtaskTexts.length, this.config.max_sub_tasks); i++) {
      const text = subtaskTexts[i]!;
      const attributes = this.analyze(text);
      const subTaskId = uuid();

      const subTask: SubTaskSpec = {
        sub_task_id: subTaskId,
        task_text: text,
        attributes,
        constraints: this.attenuateConstraints(constraints, subtaskTexts.length),
        depends_on: isSequential && i > 0 ? [subTasks[i - 1]!.sub_task_id] : [],
        delegation_target: this.inferDelegationTarget(text),
        parallel_group: isSequential ? `group-${i}` : "group-0",
      };
      subTasks.push(subTask);
    }

    // Apply router if present (Gap 4: human-vs-AI routing)
    if (this.router) {
      const decisions = this.router.routeAll(subTasks);
      for (const decision of decisions) {
        const st = subTasks.find(s => s.sub_task_id === decision.sub_task_id);
        if (st) {
          st.delegation_target = decision.target;
        }
      }
    }

    // Build execution order
    const executionOrder = this.buildExecutionOrder(subTasks);

    return {
      original_task_text: task_text,
      sub_tasks: subTasks,
      execution_order: executionOrder,
    };
  }

  assessVerifiability(subtaskText: string, _attributes?: TaskAttribute): VerifiabilityAssessment {
    const lower = subtaskText.toLowerCase();
    const hasHighVerifiability = HIGH_VERIFIABILITY_KEYWORDS.some(k => lower.includes(k));
    const hasLowVerifiability = LOW_VERIFIABILITY_KEYWORDS.some(k => lower.includes(k));

    if (hasHighVerifiability) {
      return { level: "verifiable", reason: "Task contains verifiable keywords (test, verify, check, etc.)" };
    }
    if (hasLowVerifiability) {
      return {
        level: "unverifiable",
        reason: "Task contains unverifiable keywords (design, brainstorm, think, etc.)",
        suggested_decomposition: [
          `Define acceptance criteria for: ${subtaskText}`,
          `Implement: ${subtaskText}`,
          `Verify implementation of: ${subtaskText}`,
        ],
      };
    }
    return { level: "partially_verifiable", reason: "Task verifiability could not be determined" };
  }

  decomposeRecursive(params: {
    task_text: string;
    available_peers?: Array<{ node_id: string; capabilities: string[]; trust_score?: number }>;
    constraints?: SwarmTaskConstraints;
    max_depth?: number;
    current_depth?: number;
  }): TaskDecomposition {
    const maxDepth = params.max_depth ?? 3;
    const currentDepth = params.current_depth ?? 0;
    const availablePeers = params.available_peers ?? [];

    const decomposition = this.decompose({
      task_text: params.task_text,
      available_peers: availablePeers,
      constraints: params.constraints,
    });

    if (decomposition.skip_delegation || currentDepth >= maxDepth) {
      return decomposition;
    }

    // Re-decompose unverifiable subtasks
    const refinedSubTasks: SubTaskSpec[] = [];
    for (const subtask of decomposition.sub_tasks) {
      const assessment = this.assessVerifiability(subtask.task_text, subtask.attributes);
      if (assessment.level === "unverifiable" && currentDepth < maxDepth - 1 && assessment.suggested_decomposition) {
        // Replace with suggested decomposition
        for (const suggestedText of assessment.suggested_decomposition) {
          const subAttrs = this.analyze(suggestedText);
          refinedSubTasks.push({
            sub_task_id: uuid(),
            task_text: suggestedText,
            attributes: subAttrs,
            constraints: subtask.constraints,
            depends_on: [],
            delegation_target: this.inferDelegationTarget(suggestedText),
            parallel_group: subtask.parallel_group,
          });
        }
      } else {
        refinedSubTasks.push(subtask);
      }
    }

    const executionOrder = this.buildExecutionOrder(refinedSubTasks);
    return {
      original_task_text: params.task_text,
      sub_tasks: refinedSubTasks,
      execution_order: executionOrder,
    };
  }

  generateProposals(params: {
    task_text: string;
    available_peers?: Array<{ node_id: string; capabilities: string[]; trust_score?: number }>;
    constraints?: SwarmTaskConstraints;
    count?: number;
  }): DecompositionProposal[] {
    const count = params.count ?? 3;
    const availablePeers = params.available_peers ?? [];
    const proposals: DecompositionProposal[] = [];

    // Strategy 1: Recursive decomposition
    const recursive = this.decomposeRecursive({
      task_text: params.task_text,
      available_peers: availablePeers,
      constraints: params.constraints,
    });
    proposals.push(this.buildProposal(params.task_text, recursive, "recursive"));

    // Strategy 2: Flat parallel decomposition
    if (count >= 2) {
      const parallel = this.decompose({
        task_text: params.task_text,
        available_peers: availablePeers,
        constraints: params.constraints,
      });
      // Force all to parallel
      for (const st of parallel.sub_tasks) {
        st.depends_on = [];
        st.parallel_group = "group-0";
      }
      if (parallel.sub_tasks.length > 0) {
        parallel.execution_order = [parallel.sub_tasks.map(st => st.sub_task_id)];
      }
      proposals.push(this.buildProposal(params.task_text, parallel, "parallel"));
    }

    // Strategy 3: Sequential decomposition
    if (count >= 3) {
      const sequential = this.decompose({
        task_text: params.task_text,
        available_peers: availablePeers,
        constraints: params.constraints,
      });
      // Force all to sequential
      for (let i = 0; i < sequential.sub_tasks.length; i++) {
        sequential.sub_tasks[i]!.parallel_group = `group-${i}`;
        if (i > 0) {
          sequential.sub_tasks[i]!.depends_on = [sequential.sub_tasks[i - 1]!.sub_task_id];
        }
      }
      sequential.execution_order = sequential.sub_tasks.map(st => [st.sub_task_id]);
      proposals.push(this.buildProposal(params.task_text, sequential, "sequential"));
    }

    // Rank by composite score: verifiability*0.4 + cost_efficiency*0.3 + parallelism*0.3
    proposals.sort((a, b) => {
      const scoreA = a.verifiability_score * 0.4 + (1 / (a.estimated_total_cost_usd + 0.01)) * 0.3 + (a.confidence) * 0.3;
      const scoreB = b.verifiability_score * 0.4 + (1 / (b.estimated_total_cost_usd + 0.01)) * 0.3 + (b.confidence) * 0.3;
      return scoreB - scoreA;
    });

    return proposals;
  }

  computeVerifiabilityScore(decomposition: TaskDecomposition): number {
    if (decomposition.sub_tasks.length === 0) return 0;
    const scores: number[] = decomposition.sub_tasks.map(st => {
      switch (st.attributes.verifiability) {
        case "high": return 1.0;
        case "medium": return 0.6;
        case "low": return 0.2;
        default: return 0;
      }
    });
    return scores.reduce((sum, s) => sum + s, 0) / scores.length;
  }

  private buildProposal(
    taskText: string,
    decomposition: TaskDecomposition,
    strategy: string,
  ): DecompositionProposal {
    const totalCost = decomposition.sub_tasks.reduce(
      (sum, st) => sum + (st.constraints.max_cost_usd ?? 1.0), 0
    );
    const totalDuration = decomposition.sub_tasks.reduce(
      (sum, st) => sum + (st.constraints.max_duration_ms ?? 300000), 0
    );
    const parallelGroups = decomposition.execution_order.length;
    const confidence = parallelGroups > 0 ? 1 / parallelGroups : 0.5;

    return {
      proposal_id: uuid(),
      original_task_text: taskText,
      decomposition,
      estimated_total_cost_usd: totalCost,
      estimated_total_duration_ms: totalDuration,
      verifiability_score: this.computeVerifiabilityScore(decomposition),
      confidence,
      generation_strategy: strategy,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private extractSubtasks(text: string): string[] {
    // Try numbered list extraction: "1. ...", "2. ..."
    const numberedMatch = text.match(/(?:^|\n)\s*\d+[.)]\s+.+/g);
    if (numberedMatch && numberedMatch.length > 1) {
      return numberedMatch.map((m) => m.replace(/^\s*\d+[.)]\s+/, "").trim()).filter((s) => s.length > 0);
    }

    // Try bullet list extraction: "- ...", "* ..."
    const bulletMatch = text.match(/(?:^|\n)\s*[-*]\s+.+/g);
    if (bulletMatch && bulletMatch.length > 1) {
      return bulletMatch.map((m) => m.replace(/^\s*[-*]\s+/, "").trim()).filter((s) => s.length > 0);
    }

    // Try sequential connective splitting
    for (const connective of SEQUENTIAL_CONNECTIVES) {
      if (text.toLowerCase().includes(connective)) {
        const parts = text.split(new RegExp(connective, "i")).map((p) => p.trim()).filter((p) => p.length > 0);
        if (parts.length > 1) return parts;
      }
    }

    // Try sentence splitting for long texts
    const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 10);
    if (sentences.length > 2) return sentences;

    // Cannot decompose further
    return [text];
  }

  private hasSequentialConnectives(text: string): boolean {
    const lower = text.toLowerCase();
    return SEQUENTIAL_CONNECTIVES.some((c) => lower.includes(c));
  }

  private inferDelegationTarget(text: string): SubTaskSpec["delegation_target"] {
    const lower = text.toLowerCase();
    if (HUMAN_KEYWORDS.some((k) => lower.includes(k))) return "human";
    return "ai";
  }

  private attenuateConstraints(parentConstraints: SwarmTaskConstraints | undefined, numSubtasks: number): SwarmTaskConstraints {
    const base: SwarmTaskConstraints = {
      max_tokens: parentConstraints?.max_tokens
        ? Math.ceil(parentConstraints.max_tokens / numSubtasks)
        : undefined,
      max_cost_usd: parentConstraints?.max_cost_usd
        ? parentConstraints.max_cost_usd / numSubtasks
        : this.config.default_max_cost_usd,
      max_duration_ms: parentConstraints?.max_duration_ms
        ? Math.ceil(parentConstraints.max_duration_ms / numSubtasks)
        : this.config.default_timeout_ms,
      tool_allowlist: parentConstraints?.tool_allowlist,
    };
    return base;
  }

  private buildExecutionOrder(subTasks: SubTaskSpec[]): string[][] {
    // Group by parallel_group
    const groups = new Map<string, string[]>();
    for (const st of subTasks) {
      const group = st.parallel_group ?? "default";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(st.sub_task_id);
    }

    // Sort groups by name
    const sortedKeys = [...groups.keys()].sort();
    return sortedKeys.map((k) => groups.get(k)!);
  }
}

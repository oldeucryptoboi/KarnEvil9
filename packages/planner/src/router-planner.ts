import type { PlanResult, Planner, Task, ToolSchemaForPlanner } from "@karnevil9/schemas";

export type TaskDomain = "file_ops" | "network" | "code_gen" | "shell" | "social" | "general";

export interface RouterConfig {
  delegate: Planner;
}

const DOMAIN_KEYWORDS: Record<TaskDomain, string[]> = {
  file_ops: ["read", "write", "file", "path", "directory", "folder", "copy", "move", "delete", "rename"],
  network: ["fetch", "http", "api", "url", "download", "upload", "request", "endpoint"],
  shell: ["run", "exec", "command", "install", "build", "compile", "script", "npm", "pip"],
  code_gen: ["generate", "create", "implement", "refactor", "code", "function", "class"],
  social: ["post", "comment", "vote", "reply", "feed", "moltbook", "submolt", "browse", "social", "upvote", "downvote"],
  general: [],
};

const DOMAIN_TOOL_PATTERNS: Record<TaskDomain, string[]> = {
  file_ops: ["read-file", "write-file"],
  network: ["http-request"],
  shell: ["shell-exec"],
  code_gen: [],
  social: [],
  general: [],
};

// Pre-compile keyword regexes at module scope (avoids per-call allocation and ReDoS from unescaped specials)
const DOMAIN_REGEXES: Record<TaskDomain, RegExp[]> = Object.fromEntries(
  Object.entries(DOMAIN_KEYWORDS).map(([domain, keywords]) => [
    domain,
    keywords.map(kw => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")),
  ])
) as Record<TaskDomain, RegExp[]>;

export function classifyTask(taskText: string, _toolNames: string[]): TaskDomain {
  const lower = taskText.toLowerCase();
  const scores: Record<TaskDomain, number> = {
    file_ops: 0,
    network: 0,
    shell: 0,
    code_gen: 0,
    social: 0,
    general: 0,
  };

  // Score based on keyword matches in task text
  for (const [domain, regexes] of Object.entries(DOMAIN_REGEXES) as [TaskDomain, RegExp[]][]) {
    for (const regex of regexes) {
      if (regex.test(lower)) scores[domain]++;
    }
  }

  // Find highest-scoring domain (exclude general from scoring)
  let best: TaskDomain = "general";
  let bestScore = 0;
  for (const [domain, score] of Object.entries(scores) as [TaskDomain, number][]) {
    if (domain !== "general" && score > bestScore) {
      best = domain;
      bestScore = score;
    }
  }

  return best;
}

export function filterToolsByDomain(
  toolSchemas: ToolSchemaForPlanner[],
  domain: TaskDomain
): ToolSchemaForPlanner[] {
  if (domain === "general") return toolSchemas;

  const patterns = DOMAIN_TOOL_PATTERNS[domain];
  if (patterns.length === 0) return toolSchemas;

  const filtered = toolSchemas.filter(s => patterns.includes(s.name));
  // Fallback: if filtering leaves 0 tools, return all
  return filtered.length > 0 ? filtered : toolSchemas;
}

export class RouterPlanner implements Planner {
  private delegate: Planner;

  constructor(config: RouterConfig) {
    this.delegate = config.delegate;
  }

  async generatePlan(
    task: Task,
    toolSchemas: ToolSchemaForPlanner[],
    stateSnapshot: Record<string, unknown>,
    constraints: Record<string, unknown>
  ): Promise<PlanResult> {
    const domain = classifyTask(task.text, toolSchemas.map(s => s.name));
    const filtered = filterToolsByDomain(toolSchemas, domain);
    return this.delegate.generatePlan(
      task,
      filtered,
      { ...stateSnapshot, task_domain: domain },
      constraints
    );
  }
}

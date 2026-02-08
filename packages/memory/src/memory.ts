import { v4 as uuid } from "uuid";
import { readFile, writeFile, mkdir, rename, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Plan,
  StepResult,
  TaskState,
  WorkingMemory,
  MemoryItem,
  MemoryLesson,
  SessionStatus,
} from "@openvger/schemas";

export class TaskStateManager {
  private state: TaskState;

  constructor(sessionId: string) {
    this.state = {
      session_id: sessionId,
      plan: null,
      step_results: new Map(),
      artifacts: new Map(),
    };
  }

  setPlan(plan: Plan): void { this.state.plan = plan; }
  getPlan(): Plan | null { return this.state.plan; }

  setStepResult(stepId: string, result: StepResult): void {
    this.state.step_results.set(stepId, result);
  }

  getStepResult(stepId: string): StepResult | undefined {
    return this.state.step_results.get(stepId);
  }

  getAllStepResults(): StepResult[] {
    return [...this.state.step_results.values()];
  }

  setArtifact(name: string, value: unknown): void {
    this.state.artifacts.set(name, value);
  }

  getArtifact(name: string): unknown {
    return this.state.artifacts.get(name);
  }

  getSnapshot(): Record<string, unknown> {
    const stepTitles: Record<string, string> = {};
    if (this.state.plan) {
      for (const step of this.state.plan.steps) {
        stepTitles[step.step_id] = step.title;
      }
    }
    return {
      session_id: this.state.session_id,
      has_plan: this.state.plan !== null,
      plan_goal: this.state.plan?.goal ?? null,
      total_steps: this.state.plan?.steps.length ?? 0,
      completed_steps: [...this.state.step_results.values()].filter(
        (r) => r.status === "succeeded"
      ).length,
      failed_steps: [...this.state.step_results.values()].filter(
        (r) => r.status === "failed"
      ).length,
      step_titles: stepTitles,
      step_results: Object.fromEntries(
        [...this.state.step_results.entries()].map(([k, v]) => [
          k, { status: v.status, output: v.output, error: v.error },
        ])
      ),
      artifacts: Object.fromEntries(this.state.artifacts),
    };
  }
}

export class WorkingMemoryManager {
  private memory: WorkingMemory;

  constructor(sessionId: string) {
    this.memory = { session_id: sessionId, entries: new Map() };
  }

  set(key: string, value: unknown): void { this.memory.entries.set(key, value); }
  get(key: string): unknown { return this.memory.entries.get(key); }
  has(key: string): boolean { return this.memory.entries.has(key); }
  delete(key: string): boolean { return this.memory.entries.delete(key); }
  clear(): void { this.memory.entries.clear(); }

  list(): Array<{ key: string; value: unknown }> {
    return [...this.memory.entries.entries()].map(([key, value]) => ({ key, value }));
  }
}

export class LongTermMemory {
  private items = new Map<string, MemoryItem>();
  private maxItems: number;

  constructor(maxItems = 1000) {
    this.maxItems = maxItems;
  }

  write(key: string, value: unknown, source: string): void {
    // Evict oldest entry if at capacity (before adding, to stay within limit)
    if (!this.items.has(key) && this.items.size >= this.maxItems) {
      // Remove the oldest item by created_at
      let oldestKey: string | undefined;
      let oldestTime = "";
      for (const [k, v] of this.items) {
        if (!oldestKey || v.created_at < oldestTime) {
          oldestKey = k;
          oldestTime = v.created_at;
        }
      }
      if (oldestKey) this.items.delete(oldestKey);
    }
    this.items.set(key, {
      key, value, source, created_at: new Date().toISOString(),
    });
  }

  read(key: string): MemoryItem | undefined { return this.items.get(key); }

  search(query: string): MemoryItem[] {
    const lower = query.toLowerCase();
    return [...this.items.values()].filter(
      (item) =>
        item.key.toLowerCase().includes(lower) ||
        String(item.value).toLowerCase().includes(lower)
    );
  }

  list(): MemoryItem[] { return [...this.items.values()]; }

  get size(): number { return this.items.size; }
}

// ─── Active Memory (Cross-Session Learning) ──────────────────────────

const MAX_LESSONS = 100;
const MAX_SEARCH_RESULTS = 5;
const PRUNE_AGE_DAYS = 30;

export class ActiveMemory {
  private lessons: MemoryLesson[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      const lines = content.trim().split("\n").filter(l => l.length > 0);
      this.lessons = lines.map(line => JSON.parse(line) as MemoryLesson);
    } catch {
      this.lessons = [];
    }
    this.prune();
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const content = this.lessons.map(l => JSON.stringify(l)).join("\n") + (this.lessons.length > 0 ? "\n" : "");
    // Atomic write: write to temp file, fsync, then rename
    const tmpPath = this.filePath + ".tmp";
    const fh = await open(tmpPath, "w");
    try {
      await fh.writeFile(content, "utf-8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, this.filePath);
  }

  addLesson(lesson: MemoryLesson): void {
    this.lessons.push(lesson);
    // FIFO eviction of least-relevant lessons when over max
    if (this.lessons.length > MAX_LESSONS) {
      // Sort by relevance_count ascending, then by created_at ascending (oldest first)
      this.lessons.sort((a, b) => {
        if (a.relevance_count !== b.relevance_count) return a.relevance_count - b.relevance_count;
        return a.created_at.localeCompare(b.created_at);
      });
      this.lessons = this.lessons.slice(this.lessons.length - MAX_LESSONS);
    }
  }

  search(taskText: string, toolNames?: string[]): MemoryLesson[] {
    const lower = taskText.toLowerCase();
    const words = lower.split(/\s+/).filter(w => w.length > 3);

    const scored = this.lessons.map(lesson => {
      let score = 0;
      const lessonLower = lesson.task_summary.toLowerCase() + " " + lesson.lesson.toLowerCase();
      for (const word of words) {
        if (lessonLower.includes(word)) score++;
      }
      // Boost for matching tool names
      if (toolNames) {
        for (const toolName of toolNames) {
          if (lesson.tool_names.includes(toolName)) score += 2;
        }
      }
      return { lesson, score };
    });

    const matches = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SEARCH_RESULTS);

    // Update retrieval metadata
    const now = new Date().toISOString();
    for (const m of matches) {
      m.lesson.relevance_count++;
      m.lesson.last_retrieved_at = now;
    }

    return matches.map(m => m.lesson);
  }

  getLessons(): MemoryLesson[] {
    return [...this.lessons];
  }

  private prune(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - PRUNE_AGE_DAYS);
    const cutoffStr = cutoff.toISOString();

    this.lessons = this.lessons.filter(lesson => {
      // Keep if retrieved recently
      if (lesson.last_retrieved_at && lesson.last_retrieved_at > cutoffStr) return true;
      // Keep if created recently
      if (lesson.created_at > cutoffStr) return true;
      // Keep if has high relevance
      if (lesson.relevance_count > 0) return true;
      // Prune old unretrieved lessons
      return false;
    });
  }
}

const SENSITIVE_PATTERN = /Bearer\s\S+|ghp_\S+|sk-\S+|AKIA[A-Z0-9]{16}\S*|-----BEGIN\s+PRIVATE\sKEY-----/gi;

function redactSensitive(text: string): string {
  return text.replace(SENSITIVE_PATTERN, "[REDACTED]");
}

export function extractLesson(
  taskText: string,
  plan: Plan,
  stepResults: StepResult[],
  sessionStatus: SessionStatus,
  sessionId?: string
): MemoryLesson | null {
  if (!plan || plan.steps.length === 0) return null;
  // Don't extract lessons from sessions that haven't finished
  if (sessionStatus === "running" || sessionStatus === "created" || sessionStatus === "planning") return null;

  const succeeded = stepResults.filter(r => r.status === "succeeded");
  const failed = stepResults.filter(r => r.status === "failed");
  const toolNames = [...new Set(plan.steps.map(s => s.tool_ref.name))];
  const outcome: "succeeded" | "failed" = sessionStatus === "completed" ? "succeeded" : "failed";

  let lesson: string;
  if (outcome === "succeeded") {
    lesson = `Completed using ${toolNames.join(", ")}. ${succeeded.length} step(s) succeeded.`;
  } else {
    const errorMessages = failed
      .filter(r => r.error)
      .map(r => r.error!.message)
      .slice(0, 3);
    lesson = errorMessages.length > 0
      ? `Failed: ${errorMessages.join("; ")}`
      : `Failed with ${failed.length} failed step(s) using ${toolNames.join(", ")}.`;
  }

  return {
    lesson_id: uuid(),
    task_summary: redactSensitive(taskText.slice(0, 200)),
    outcome,
    lesson,
    tool_names: toolNames,
    created_at: new Date().toISOString(),
    session_id: sessionId ?? plan.plan_id,
    relevance_count: 0,
  };
}

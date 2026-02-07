import type {
  Plan,
  StepResult,
  TaskState,
  WorkingMemory,
  MemoryItem,
} from "@openflaw/schemas";

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

  write(key: string, value: unknown, source: string): void {
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
}

import { randomUUID } from "node:crypto";
import { readFile, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { JournalEventType } from "@karnevil9/schemas";
import type { TaskCheckpoint } from "./types.js";

const MAX_CHECKPOINTS_PER_TASK = 10;

export class CheckpointSerializer {
  private checkpoints = new Map<string, TaskCheckpoint[]>(); // task_id -> checkpoints
  private filePath: string;
  private emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;

  constructor(filePath: string, emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void) {
    this.filePath = filePath;
    this.emitEvent = emitEvent;
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      const lines = content.trim().split("\n").filter(l => l.length > 0);
      this.checkpoints.clear();
      for (const line of lines) {
        const cp = JSON.parse(line) as TaskCheckpoint;
        if (!this.checkpoints.has(cp.task_id)) {
          this.checkpoints.set(cp.task_id, []);
        }
        this.checkpoints.get(cp.task_id)!.push(cp);
      }
    } catch {
      this.checkpoints.clear();
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const allCheckpoints: TaskCheckpoint[] = [];
    for (const cps of this.checkpoints.values()) {
      allCheckpoints.push(...cps);
    }
    const content = allCheckpoints.map(c => JSON.stringify(c)).join("\n") + (allCheckpoints.length > 0 ? "\n" : "");
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

  saveCheckpoint(checkpoint: Omit<TaskCheckpoint, "checkpoint_id">): TaskCheckpoint {
    const cp: TaskCheckpoint = {
      ...checkpoint,
      checkpoint_id: randomUUID(),
    };

    if (!this.checkpoints.has(cp.task_id)) {
      this.checkpoints.set(cp.task_id, []);
    }
    const list = this.checkpoints.get(cp.task_id)!;
    list.push(cp);

    // FIFO eviction
    if (list.length > MAX_CHECKPOINTS_PER_TASK) {
      list.splice(0, list.length - MAX_CHECKPOINTS_PER_TASK);
    }

    this.emitEvent?.("swarm.checkpoint_saved" as JournalEventType, {
      checkpoint_id: cp.checkpoint_id,
      task_id: cp.task_id,
      peer_node_id: cp.peer_node_id,
      findings_so_far: cp.findings_so_far,
    });

    return cp;
  }

  getLatest(taskId: string): TaskCheckpoint | undefined {
    const list = this.checkpoints.get(taskId);
    if (!list || list.length === 0) return undefined;
    return list[list.length - 1];
  }

  getAll(taskId: string): TaskCheckpoint[] {
    return [...(this.checkpoints.get(taskId) ?? [])];
  }

  canResume(taskId: string): boolean {
    const list = this.checkpoints.get(taskId);
    return list !== undefined && list.length > 0;
  }

  getCheckpointById(checkpointId: string): TaskCheckpoint | undefined {
    for (const list of this.checkpoints.values()) {
      const found = list.find(cp => cp.checkpoint_id === checkpointId);
      if (found) return found;
    }
    return undefined;
  }

  get taskCount(): number {
    return this.checkpoints.size;
  }
}

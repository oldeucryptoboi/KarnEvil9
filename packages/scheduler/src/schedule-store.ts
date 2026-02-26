import { readFile, mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { Schedule } from "@karnevil9/schemas";

export class ScheduleStore {
  private schedules = new Map<string, Schedule>();
  private filePath: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      const lines = content.trim().split("\n").filter(l => l.length > 0);
      this.schedules.clear();
      for (const line of lines) {
        try {
          const schedule = JSON.parse(line) as Schedule;
          this.schedules.set(schedule.schedule_id, schedule);
        } catch {
          // Skip corrupted lines rather than losing all schedules
        }
      }
    } catch {
      this.schedules.clear();
    }
  }

  async save(): Promise<void> {
    let releaseLock: () => void;
    const acquired = new Promise<void>((resolve) => { releaseLock = resolve; });
    const prev = this.writeLock;
    this.writeLock = acquired;
    await prev;

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const entries = [...this.schedules.values()];
      const content = entries.map(s => JSON.stringify(s)).join("\n") + (entries.length > 0 ? "\n" : "");
      const tmpPath = this.filePath + ".tmp";
      const fh = await open(tmpPath, "w");
      try {
        await fh.writeFile(content, "utf-8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmpPath, this.filePath);
    } finally {
      releaseLock!();
    }
  }

  get(id: string): Schedule | undefined {
    return this.schedules.get(id);
  }

  set(schedule: Schedule): void {
    this.schedules.set(schedule.schedule_id, schedule);
  }

  delete(id: string): boolean {
    return this.schedules.delete(id);
  }

  has(id: string): boolean {
    return this.schedules.has(id);
  }

  getAll(): Schedule[] {
    return [...this.schedules.values()];
  }

  getActive(): Schedule[] {
    return [...this.schedules.values()].filter(s => s.status === "active");
  }

  get size(): number {
    return this.schedules.size;
  }
}

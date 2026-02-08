import { createHash } from "node:crypto";
import { appendFile, readFile, mkdir, writeFile, rename, access, constants, open, unlink, statfs } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { v4 as uuid } from "uuid";
import type { JournalEvent, JournalEventType } from "@jarvis/schemas";
import { validateJournalEventData } from "@jarvis/schemas";
import { redactPayload } from "./redact.js";

export interface JournalOptions {
  fsync?: boolean;
  redact?: boolean;
}

export type JournalListener = (event: JournalEvent) => void;

export class Journal {
  private filePath: string;
  private lastHash: string | undefined;
  private listeners: JournalListener[] = [];
  private writeLock: Promise<void> = Promise.resolve();
  private sessionIndex = new Map<string, JournalEvent[]>();
  private nextSeq = 0;
  private fsync: boolean;
  private redact: boolean;

  constructor(filePath: string, options?: JournalOptions) {
    this.filePath = filePath;
    this.fsync = options?.fsync ?? true;
    this.redact = options?.redact ?? true;
  }

  async init(): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    if (existsSync(this.filePath)) {
      const content = await readFile(this.filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      let maxSeq = -1;
      let prevHash: string | undefined;
      const tempIndex = new Map<string, JournalEvent[]>();
      try {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          const event = JSON.parse(line) as JournalEvent;
          // Verify hash chain integrity during init
          if (i > 0 && event.hash_prev !== prevHash) {
            throw new Error(`Journal integrity violation at event ${i} (seq=${event.seq}): hash chain broken`);
          }
          prevHash = this.hash(line);
          const bucket = tempIndex.get(event.session_id);
          if (bucket) bucket.push(event);
          else tempIndex.set(event.session_id, [event]);
          if (event.seq !== undefined && event.seq > maxSeq) maxSeq = event.seq;
        }
      } catch (err) {
        // Reset all in-memory state on corruption — leave instance unusable
        this.sessionIndex.clear();
        this.lastHash = undefined;
        this.nextSeq = 0;
        throw err;
      }
      // Only commit to in-memory state after successful validation
      for (const [sid, events] of tempIndex) {
        this.sessionIndex.set(sid, events);
      }
      this.nextSeq = maxSeq + 1;
      if (lines.length > 0) {
        this.lastHash = prevHash;
      }
    }
  }

  on(listener: JournalListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async emit(
    sessionId: string,
    type: JournalEventType,
    payload: Record<string, unknown>
  ): Promise<JournalEvent> {
    let releaseLock: () => void;
    const acquired = new Promise<void>((resolve) => { releaseLock = resolve; });
    const prev = this.writeLock;
    this.writeLock = acquired;
    await prev;

    try {
      const redactedPayload = this.redact
        ? redactPayload(payload) as Record<string, unknown>
        : payload;

      const seq = this.nextSeq; // capture before write — only commit on success

      const event: JournalEvent = {
        event_id: uuid(),
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        type,
        payload: redactedPayload,
        hash_prev: this.lastHash,
        seq,
      };

      const validation = validateJournalEventData(event);
      if (!validation.valid) {
        throw new Error(`Invalid journal event: ${validation.errors.join(", ")}`);
      }

      const line = JSON.stringify(event);
      if (this.fsync) {
        const fh = await open(this.filePath, "a");
        await fh.write(line + "\n", undefined, "utf-8");
        await fh.sync();
        await fh.close();
      } else {
        await appendFile(this.filePath, line + "\n", "utf-8");
      }

      // Only update in-memory state after successful write
      this.nextSeq = seq + 1;
      this.lastHash = this.hash(line);

      const bucket = this.sessionIndex.get(sessionId);
      if (bucket) bucket.push(event);
      else this.sessionIndex.set(sessionId, [event]);

      for (const listener of this.listeners) {
        try { listener(event); } catch { /* listeners must not break the journal */ }
      }

      return event;
    } finally {
      releaseLock!();
    }
  }

  async tryEmit(
    sessionId: string,
    type: JournalEventType,
    payload: Record<string, unknown>
  ): Promise<JournalEvent | null> {
    try {
      return await this.emit(sessionId, type, payload);
    } catch {
      return null;
    }
  }

  async readAll(): Promise<JournalEvent[]> {
    if (!existsSync(this.filePath)) return [];
    const content = await readFile(this.filePath, "utf-8");
    return content.trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as JournalEvent);
  }

  async readSession(sessionId: string, options?: { offset?: number; limit?: number }): Promise<JournalEvent[]> {
    const events = this.sessionIndex.get(sessionId) ?? [];
    if (!options) return events;
    const start = options.offset ?? 0;
    const end = options.limit !== undefined ? start + options.limit : undefined;
    return events.slice(start, end);
  }

  getSessionEventCount(sessionId: string): number {
    return (this.sessionIndex.get(sessionId) ?? []).length;
  }

  async compact(retainSessionIds?: string[]): Promise<{ before: number; after: number }> {
    let releaseLock: () => void;
    const acquired = new Promise<void>((resolve) => { releaseLock = resolve; });
    const prev = this.writeLock;
    this.writeLock = acquired;

    const tmpPath = `${this.filePath}.tmp`;

    try {
      const allEvents = await this.readAll();
      const before = allEvents.length;

      const filtered = retainSessionIds
        ? allEvents.filter((e) => retainSessionIds.includes(e.session_id))
        : allEvents;

      // Rebuild hash chain and rewrite seq
      let prevHash: string | undefined;
      let seq = 0;
      const lines: string[] = [];

      for (const event of filtered) {
        const rebuilt: JournalEvent = { ...event, hash_prev: prevHash, seq: seq++ };
        const line = JSON.stringify(rebuilt);
        lines.push(line);
        prevHash = this.hash(line);
      }

      if (this.fsync) {
        const fh = await open(tmpPath, "w");
        await fh.write(lines.length > 0 ? lines.join("\n") + "\n" : "", undefined, "utf-8");
        await fh.sync();
        await fh.close();
      } else {
        await writeFile(tmpPath, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf-8");
      }

      await rename(tmpPath, this.filePath);

      // Rebuild in-memory state
      this.lastHash = prevHash;
      this.nextSeq = seq;
      this.sessionIndex.clear();
      for (const line of lines) {
        const event = JSON.parse(line) as JournalEvent;
        const bucket = this.sessionIndex.get(event.session_id);
        if (bucket) bucket.push(event);
        else this.sessionIndex.set(event.session_id, [event]);
      }

      return { before, after: filtered.length };
    } catch (err) {
      // Clean up orphaned tmp file
      try { await unlink(tmpPath); } catch { /* tmp may not exist */ }
      throw err;
    } finally {
      releaseLock!();
    }
  }

  async verifyIntegrity(): Promise<{ valid: boolean; brokenAt?: number }> {
    const events = await this.readAll();
    let prevHash: string | undefined;
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      if (i > 0 && event.hash_prev !== prevHash) {
        return { valid: false, brokenAt: i };
      }
      const line = JSON.stringify(event);
      prevHash = this.hash(line);
    }
    return { valid: true };
  }

  async checkHealth(): Promise<{ writable: boolean; disk_usage?: { available_bytes: number; total_bytes: number; usage_pct: number } }> {
    try {
      let writable = false;
      if (existsSync(this.filePath)) {
        await access(this.filePath, constants.W_OK);
        writable = true;
      } else {
        // File doesn't exist yet — check parent dir is writable
        const dir = dirname(this.filePath);
        await access(dir, constants.W_OK);
        writable = true;
      }
      const disk = await this.getDiskUsage();
      return { writable, ...(disk ? { disk_usage: disk } : {}) };
    } catch {
      return { writable: false };
    }
  }

  async getDiskUsage(): Promise<{ available_bytes: number; total_bytes: number; usage_pct: number } | null> {
    try {
      const target = existsSync(this.filePath) ? this.filePath : dirname(this.filePath);
      const stats = await statfs(target);
      const total = stats.blocks * stats.bsize;
      const available = stats.bavail * stats.bsize;
      const used = total - available;
      const usage_pct = total > 0 ? Math.round((used / total) * 10000) / 100 : 0;
      return { available_bytes: available, total_bytes: total, usage_pct };
    } catch {
      return null;
    }
  }

  /**
   * Wait for any pending writes to complete. Call this before process exit
   * to ensure no journal events are lost.
   */
  async close(): Promise<void> {
    await this.writeLock;
  }

  getFilePath(): string {
    return this.filePath;
  }

  private hash(data: string): string {
    return createHash("sha256").update(data).digest("hex");
  }
}

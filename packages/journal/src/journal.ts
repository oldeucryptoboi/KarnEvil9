import { createHash } from "node:crypto";
import { appendFile, readFile, mkdir, writeFile, rename, access, constants, open, unlink, statfs } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { v4 as uuid } from "uuid";
import type { JournalEvent, JournalEventType } from "@karnevil9/schemas";
import { validateJournalEventData } from "@karnevil9/schemas";
import { redactPayload } from "./redact.js";

export interface JournalOptions {
  fsync?: boolean;
  redact?: boolean;
  /** If true, acquire an advisory lockfile to prevent multi-process corruption. Default: true */
  lock?: boolean;
  /** Maximum number of sessions to keep in the in-memory index (LRU eviction). Default: 10000 */
  maxSessionsIndexed?: number;
  /** How to handle corruption on init. "truncate" (default) auto-repairs; "strict" throws. */
  recovery?: "truncate" | "strict";
}

export type JournalListener = (event: JournalEvent) => void;

export class Journal {
  private filePath: string;
  private lastHash: string | undefined;
  private listeners: JournalListener[] = [];
  private writeLock: Promise<void> = Promise.resolve();
  private sessionIndex = new Map<string, JournalEvent[]>();
  private sessionAccessOrder: string[] = [];
  private maxSessionsIndexed: number;
  private nextSeq = 0;
  private fsync: boolean;
  private redact: boolean;
  private lockEnabled: boolean;
  private lockPath: string;
  private locked = false;
  private recovery: "truncate" | "strict";

  constructor(filePath: string, options?: JournalOptions) {
    this.filePath = filePath;
    this.fsync = options?.fsync ?? true;
    this.redact = options?.redact ?? true;
    this.lockEnabled = options?.lock ?? true;
    this.lockPath = `${filePath}.lock`;
    this.maxSessionsIndexed = options?.maxSessionsIndexed ?? 10000;
    this.recovery = options?.recovery ?? "truncate";
  }

  async init(): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    if (this.lockEnabled) {
      await this.acquireLock();
    }
    if (existsSync(this.filePath)) {
      const content = await readFile(this.filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      // Fix C1: Truncate incomplete last line from crash
      if (lines.length > 0) {
        try { JSON.parse(lines[lines.length - 1]!); }
        catch {
          lines.pop();
          const cleanContent = lines.length > 0 ? lines.join("\n") + "\n" : "";
          await writeFile(this.filePath, cleanContent, "utf-8");
          console.error(`Journal: truncated incomplete last line from crash`);
        }
      }

      let maxSeq = -1;
      let prevHash: string | undefined;
      const tempIndex = new Map<string, JournalEvent[]>();
      let validCount = lines.length;
      try {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          const event = JSON.parse(line) as JournalEvent;
          // Verify hash chain integrity during init
          if (i > 0 && event.hash_prev !== prevHash) {
            if (this.recovery === "strict") {
              throw new Error(`Journal integrity violation at event ${i} (seq=${event.seq}): hash chain broken`);
            }
            // Truncate mode: keep valid prefix
            validCount = i;
            console.error(`Journal: recovered from corruption at event ${i}, truncated ${lines.length - i} events`);
            // Rewrite file atomically with valid prefix
            const validLines = lines.slice(0, i);
            const tmpPath = `${this.filePath}.tmp`;
            const repairContent = validLines.length > 0 ? validLines.join("\n") + "\n" : "";
            await writeFile(tmpPath, repairContent, "utf-8");
            await rename(tmpPath, this.filePath);
            break;
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
        this.trackSessionAccess(sid);
        this.sessionIndex.set(sid, events);
      }
      this.nextSeq = maxSeq + 1;
      if (validCount > 0 && tempIndex.size > 0) {
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
      const lineHash = this.hash(line); // compute before write — pure function, no side effects

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
      this.lastHash = lineHash;

      const bucket = this.sessionIndex.get(sessionId);
      if (bucket) {
        bucket.push(event);
      } else {
        this.sessionIndex.set(sessionId, [event]);
      }
      this.trackSessionAccess(sessionId);
      this.evictSessionsIfNeeded();

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

  async readAll(options?: { limit?: number }): Promise<JournalEvent[]> {
    if (!existsSync(this.filePath)) return [];
    const content = await readFile(this.filePath, "utf-8");
    const events = content.trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as JournalEvent);
    if (options?.limit !== undefined && options.limit < events.length) {
      return events.slice(events.length - options.limit);
    }
    return events;
  }

  async *readAllStream(): AsyncGenerator<JournalEvent, void, undefined> {
    if (!existsSync(this.filePath)) return;
    const content = await readFile(this.filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      yield JSON.parse(line) as JournalEvent;
    }
  }

  async readSession(sessionId: string, options?: { offset?: number; limit?: number }): Promise<JournalEvent[]> {
    const events = this.sessionIndex.get(sessionId) ?? [];
    if (events.length > 0) {
      this.trackSessionAccess(sessionId);
    }
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
      this.sessionAccessOrder = [];
      for (const line of lines) {
        const event = JSON.parse(line) as JournalEvent;
        const bucket = this.sessionIndex.get(event.session_id);
        if (bucket) {
          bucket.push(event);
        } else {
          this.sessionIndex.set(event.session_id, [event]);
          this.trackSessionAccess(event.session_id);
        }
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
    if (this.lockEnabled && this.locked) {
      await this.releaseLock();
    }
  }

  /**
   * Register SIGINT/SIGTERM handlers that flush pending writes before exit.
   * Returns a cleanup function to remove the handlers.
   */
  registerShutdownHandler(): () => void {
    const handler = () => {
      this.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
    return () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    };
  }

  getFilePath(): string {
    return this.filePath;
  }

  private hash(data: string): string {
    return createHash("sha256").update(data).digest("hex");
  }

  private async acquireLock(): Promise<void> {
    try {
      const fh = await open(this.lockPath, "wx");
      await fh.write(String(process.pid), undefined, "utf-8");
      await fh.close();
      this.locked = true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Lock file exists — check if the owning process is still alive
        let pid: number;
        try {
          const content = await readFile(this.lockPath, "utf-8");
          pid = parseInt(content.trim(), 10);
        } catch {
          // Can't read the lockfile — remove it and retry
          await this.removeStaleLock();
          return this.acquireLock();
        }

        if (isNaN(pid)) {
          // Invalid PID in lockfile — treat as stale
          await this.removeStaleLock();
          return this.acquireLock();
        }

        // Check if process is still running
        try {
          process.kill(pid, 0);
          // Process is alive — lock is held
          throw new Error(`Journal is locked by process ${pid} (lockfile: ${this.lockPath})`);
        } catch (killErr: unknown) {
          if ((killErr as NodeJS.ErrnoException).code === "ESRCH") {
            // Process is dead — stale lock
            await this.removeStaleLock();
            return this.acquireLock();
          }
          // Re-throw if it's our custom error or an unexpected error
          throw killErr;
        }
      }
      throw err;
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      await unlink(this.lockPath);
    } catch {
      // Lockfile may already be gone
    }
    this.locked = false;
  }

  private async removeStaleLock(): Promise<void> {
    try {
      await unlink(this.lockPath);
    } catch {
      // May have been cleaned up by another process
    }
  }

  private trackSessionAccess(sessionId: string): void {
    const idx = this.sessionAccessOrder.indexOf(sessionId);
    if (idx !== -1) {
      this.sessionAccessOrder.splice(idx, 1);
    }
    this.sessionAccessOrder.push(sessionId);
  }

  private evictSessionsIfNeeded(): void {
    while (this.sessionIndex.size > this.maxSessionsIndexed && this.sessionAccessOrder.length > 0) {
      const oldest = this.sessionAccessOrder.shift()!;
      this.sessionIndex.delete(oldest);
    }
  }
}

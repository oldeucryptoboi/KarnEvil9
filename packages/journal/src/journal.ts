import { createHash } from "node:crypto";
import { appendFile, readFile, mkdir, writeFile, rename, access, constants, open, unlink, statfs } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
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
  /** Maximum total bytes of event data to keep in the session index. Default: 256MB.
   *  When exceeded during init, oldest sessions are evicted to stay under the limit. */
  maxIndexBytes?: number;
  /** If true, init only reads the tail of the journal to recover seq/hash state.
   *  Sessions are loaded lazily from disk on first access. Drastically reduces startup memory. */
  lazyInit?: boolean;
  /** How to handle corruption on init. "truncate" (default) auto-repairs; "strict" throws. */
  recovery?: "truncate" | "strict";
  /** Disk usage percentage to emit a warning event. Default: 85 */
  diskWarningPct?: number;
  /** Disk usage percentage to refuse writes. Default: 95 */
  diskCriticalPct?: number;
  /** Minimum interval between disk checks in milliseconds. Default: 60000 */
  diskCheckIntervalMs?: number;
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
  private maxIndexBytes: number;
  private currentIndexBytes = 0;
  private lazyInit: boolean;
  private nextSeq = 0;
  private fsync: boolean;
  private redact: boolean;
  private lockEnabled: boolean;
  private lockPath: string;
  private locked = false;
  private recovery: "truncate" | "strict";
  private diskWarningPct: number;
  private diskCriticalPct: number;
  private diskCheckIntervalMs: number;
  private lastDiskCheckMs = 0;
  private lastDiskUsagePct = 0;
  private diskWarningEmitted = false;
  private pendingDiskWarning = false;

  constructor(filePath: string, options?: JournalOptions) {
    this.filePath = filePath;
    this.fsync = options?.fsync ?? true;
    this.redact = options?.redact ?? true;
    this.lockEnabled = options?.lock ?? true;
    this.lockPath = `${filePath}.lock`;
    this.maxSessionsIndexed = options?.maxSessionsIndexed ?? 10000;
    this.maxIndexBytes = options?.maxIndexBytes ?? 256 * 1024 * 1024; // 256 MB
    this.lazyInit = options?.lazyInit ?? false;
    this.recovery = options?.recovery ?? "truncate";
    this.diskWarningPct = options?.diskWarningPct ?? 85;
    this.diskCriticalPct = options?.diskCriticalPct ?? 95;
    this.diskCheckIntervalMs = options?.diskCheckIntervalMs ?? 60000;
  }

  async init(): Promise<void> {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    if (this.lockEnabled) {
      await this.acquireLock();
    }
    // Initialize disk check timer so the first check respects the interval
    this.lastDiskCheckMs = Date.now();
    if (existsSync(this.filePath)) {
      if (this.lazyInit) {
        await this.initLazy();
        return;
      }
      // Stream the journal line-by-line to avoid loading the entire file into
      // memory (V8 string limit is ~512 MB; journals can exceed this).
      const fileStream = createReadStream(this.filePath, { encoding: "utf-8" });
      const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

      let eventIndex = 0;
      let byteOffset = 0;
      let lastValidByteOffset = 0;
      let maxSeq = -1;
      let prevHash: string | undefined;
      // Track per-session byte sizes so we can evict the heaviest sessions
      const tempIndex = new Map<string, JournalEvent[]>();
      const tempSessionBytes = new Map<string, number>();
      const tempAccessOrder: string[] = [];
      let tempIndexBytes = 0;
      // Sessions evicted from tempIndex during init — we still validate their
      // hashes but don't store their events in memory.
      const evictedSessions = new Set<string>();
      let needsTruncation = false;

      try {
        for await (const line of rl) {
          const lineBytes = Buffer.byteLength(line, "utf-8") + 1; // +1 for newline

          if (!line.trim()) {
            byteOffset += lineBytes;
            continue;
          }

          let event: JournalEvent;
          try {
            event = JSON.parse(line) as JournalEvent;
          } catch {
            // Check if more non-empty lines follow — if so, it's a mid-file corruption.
            // A trailing partial line is a crash artifact and should always be truncated.
            let isTrailing = true;
            for await (const remaining of rl) {
              if (remaining.trim()) { isTrailing = false; break; }
            }
            if (this.recovery === "strict" && !isTrailing) {
              throw new Error(`Journal parse error at event ${eventIndex}: corrupted JSON`);
            }
            needsTruncation = true;
            console.error(`Journal: corrupted JSON at event ${eventIndex}, truncating`);
            break;
          }

          if (eventIndex > 0 && event.hash_prev !== prevHash) {
            if (this.recovery === "strict") {
              throw new Error(`Journal integrity violation at event ${eventIndex} (seq=${event.seq}): hash chain broken`);
            }
            needsTruncation = true;
            console.error(`Journal: hash chain broken at event ${eventIndex}, truncating`);
            break;
          }

          prevHash = this.hash(line);

          // Only store event data for sessions that haven't been evicted
          if (!evictedSessions.has(event.session_id)) {
            const bucket = tempIndex.get(event.session_id);
            if (bucket) {
              bucket.push(event);
            } else {
              tempIndex.set(event.session_id, [event]);
              tempAccessOrder.push(event.session_id);
            }
            tempIndexBytes += lineBytes;
            tempSessionBytes.set(event.session_id, (tempSessionBytes.get(event.session_id) ?? 0) + lineBytes);
          }
          if (event.seq !== undefined && event.seq > maxSeq) maxSeq = event.seq;

          byteOffset += lineBytes;
          lastValidByteOffset = byteOffset;
          eventIndex++;

          // Evict oldest sessions when memory budget exceeded.
          // Runs every 5000 events to amortize overhead.
          if (eventIndex % 5000 === 0 && tempIndexBytes > this.maxIndexBytes) {
            while (tempIndexBytes > this.maxIndexBytes * 0.75 && tempAccessOrder.length > 0) {
              const oldest = tempAccessOrder.shift()!;
              const sessionBytes = tempSessionBytes.get(oldest) ?? 0;
              tempIndexBytes -= sessionBytes;
              tempIndex.delete(oldest);
              tempSessionBytes.delete(oldest);
              evictedSessions.add(oldest);
            }
          }
        }
      } catch (err) {
        this.sessionIndex.clear();
        this.lastHash = undefined;
        this.nextSeq = 0;
        throw err;
      } finally {
        rl.close();
        fileStream.destroy();
      }

      // Truncate corrupt tail in place (no rewrite needed)
      if (needsTruncation) {
        const fh = await open(this.filePath, "r+");
        try {
          await fh.truncate(lastValidByteOffset);
        } finally {
          await fh.close();
        }
        console.error(`Journal: truncated to ${lastValidByteOffset} bytes (${eventIndex} valid events)`);
      }

      // Only commit to in-memory state after successful validation.
      // Apply LRU eviction: if there are more sessions than maxSessionsIndexed,
      // only keep the most recently accessed ones to avoid OOM on large journals.
      this.currentIndexBytes = 0;
      for (const [sid, events] of tempIndex) {
        this.trackSessionAccess(sid);
        this.sessionIndex.set(sid, events);
      }
      this.currentIndexBytes = tempIndexBytes;
      this.evictSessionsIfNeeded();
      // Release tempIndex memory now that we've committed
      tempIndex.clear();

      this.nextSeq = maxSeq + 1;
      if (eventIndex > 0 && this.sessionIndex.size > 0) {
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

    let event: JournalEvent;
    let emitWarningAfter = false;
    let warningUsagePct = 0;

    try {
      await this.checkDiskIfDue();

      const redactedPayload = this.redact
        ? redactPayload(payload) as Record<string, unknown>
        : payload;

      const seq = this.nextSeq; // capture before write — only commit on success

      event = {
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
        try {
          await fh.write(line + "\n", undefined, "utf-8");
          await fh.sync();
        } finally {
          await fh.close();
        }
      } else {
        await appendFile(this.filePath, line + "\n", "utf-8");
      }

      // Only update in-memory state after successful write
      this.nextSeq = seq + 1;
      this.lastHash = lineHash;

      // Track new session IDs in lazy mode
      if (this.lazySessionIds) {
        this.lazySessionIds.add(sessionId);
      }
      const eventBytes = Buffer.byteLength(line, "utf-8");
      const bucket = this.sessionIndex.get(sessionId);
      if (bucket) {
        bucket.push(event);
      } else {
        this.sessionIndex.set(sessionId, [event]);
      }
      this.currentIndexBytes += eventBytes;
      this.trackSessionAccess(sessionId);
      this.evictSessionsIfNeeded();

      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (err) {
          console.warn("[journal] Listener threw:", err instanceof Error ? err.message : String(err));
        }
      }

      // Check if a disk warning needs to be emitted after releasing the lock
      if (this.pendingDiskWarning && type !== "journal.disk_warning") {
        this.pendingDiskWarning = false;
        emitWarningAfter = true;
        warningUsagePct = this.lastDiskUsagePct;
      }
    } finally {
      releaseLock!();
    }

    // Emit disk warning outside the write lock to avoid deadlock
    if (emitWarningAfter) {
      await this.tryEmit("_system", "journal.disk_warning", {
        usage_pct: warningUsagePct,
        threshold: this.diskWarningPct,
      });
    }

    return event;
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
    const events: JournalEvent[] = [];
    for await (const event of this.readAllStream()) {
      events.push(event);
    }
    if (options?.limit !== undefined && options.limit < events.length) {
      return events.slice(events.length - options.limit);
    }
    return events;
  }

  async *readAllStream(): AsyncGenerator<JournalEvent, void, undefined> {
    if (!existsSync(this.filePath)) return;
    const fileStream = createReadStream(this.filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });
    let skipped = 0;
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line) as JournalEvent;
        } catch {
          skipped++;
        }
      }
    } finally {
      if (skipped > 0) {
        console.warn(`[journal] readAllStream: skipped ${skipped} corrupted line(s)`);
      }
      rl.close();
      fileStream.destroy();
    }
  }

  async readSession(sessionId: string, options?: { offset?: number; limit?: number }): Promise<JournalEvent[]> {
    let events = this.sessionIndex.get(sessionId);
    if (!events && this.lazyInit && this.lazySessionIds?.has(sessionId)) {
      // Lazy mode: load from disk on cache miss
      events = await this.loadSessionFromDisk(sessionId);
    }
    events = events ?? [];
    if (events.length > 0) {
      this.trackSessionAccess(sessionId);
    }
    const start = options?.offset ?? 0;
    const end = options?.limit !== undefined ? start + options.limit : undefined;
    // Always return a defensive copy so callers cannot mutate the index
    return events.slice(start, end);
  }

  getSessionEventCount(sessionId: string): number {
    const cached = this.sessionIndex.get(sessionId);
    if (cached) return cached.length;
    // In lazy mode, we don't know the count without loading — return 0 if not loaded
    return 0;
  }

  getKnownSessionIds(): string[] {
    if (this.lazySessionIds) {
      return [...this.lazySessionIds];
    }
    return [...this.sessionIndex.keys()];
  }

  async compact(retainSessionIds?: string[]): Promise<{ before: number; after: number }> {
    let releaseLock: () => void;
    const acquired = new Promise<void>((resolve) => { releaseLock = resolve; });
    const prev = this.writeLock;
    this.writeLock = acquired;
    await prev;

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
        try {
          await fh.write(lines.length > 0 ? lines.join("\n") + "\n" : "", undefined, "utf-8");
          await fh.sync();
        } finally {
          await fh.close();
        }
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

  async readVerifiedSession(sessionId: string): Promise<JournalEvent[]> {
    const integrity = await this.verifyIntegrity();
    if (!integrity.valid) throw new Error(`Journal integrity check failed at event index ${integrity.brokenAt}`);
    return this.readSession(sessionId);
  }

  async readVerifiedAll(): Promise<JournalEvent[]> {
    const integrity = await this.verifyIntegrity();
    if (!integrity.valid) throw new Error(`Journal integrity check failed at event index ${integrity.brokenAt}`);
    return this.readAll();
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

  private async checkDiskIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastDiskCheckMs < this.diskCheckIntervalMs) return;
    this.lastDiskCheckMs = now;

    const usage = await this.getDiskUsage();
    if (!usage) return;

    this.lastDiskUsagePct = usage.usage_pct;

    if (usage.usage_pct >= this.diskCriticalPct) {
      throw new Error(
        `Journal write refused: disk usage at ${usage.usage_pct}% exceeds critical threshold ${this.diskCriticalPct}%`
      );
    }

    if (usage.usage_pct >= this.diskWarningPct && !this.diskWarningEmitted) {
      this.diskWarningEmitted = true;
      this.pendingDiskWarning = true;
    } else if (usage.usage_pct < this.diskWarningPct && this.diskWarningEmitted) {
      this.diskWarningEmitted = false;
    }
  }

  getDiskUsageCached(): number {
    return this.lastDiskUsagePct;
  }

  private hash(data: string): string {
    return createHash("sha256").update(data).digest("hex");
  }

  private async acquireLock(): Promise<void> {
    try {
      const fh = await open(this.lockPath, "wx");
      try {
        await fh.write(String(process.pid), undefined, "utf-8");
      } finally {
        await fh.close();
      }
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

        if (Number.isNaN(pid)) {
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

  /**
   * Lazy init: read only enough to recover seq/hash state and build a lightweight
   * session ID set. Events are loaded from disk on demand via readSession().
   * This keeps startup memory O(1) instead of O(journal_size).
   */
  private async initLazy(): Promise<void> {
    const fileStream = createReadStream(this.filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    let maxSeq = -1;
    let prevHash: string | undefined;
    let eventIndex = 0;
    let byteOffset = 0;
    let lastValidByteOffset = 0;
    let needsTruncation = false;
    const sessionIds = new Set<string>();

    try {
      for await (const line of rl) {
        const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
        if (!line.trim()) { byteOffset += lineBytes; continue; }

        let event: JournalEvent;
        try {
          event = JSON.parse(line) as JournalEvent;
        } catch {
          let isTrailing = true;
          for await (const remaining of rl) {
            if (remaining.trim()) { isTrailing = false; break; }
          }
          if (this.recovery === "strict" && !isTrailing) {
            throw new Error(`Journal parse error at event ${eventIndex}: corrupted JSON`);
          }
          needsTruncation = true;
          console.error(`Journal: corrupted JSON at event ${eventIndex}, truncating`);
          break;
        }

        if (eventIndex > 0 && event.hash_prev !== prevHash) {
          if (this.recovery === "strict") {
            throw new Error(`Journal integrity violation at event ${eventIndex} (seq=${event.seq}): hash chain broken`);
          }
          needsTruncation = true;
          console.error(`Journal: hash chain broken at event ${eventIndex}, truncating`);
          break;
        }

        prevHash = this.hash(line);
        sessionIds.add(event.session_id);
        if (event.seq !== undefined && event.seq > maxSeq) maxSeq = event.seq;

        byteOffset += lineBytes;
        lastValidByteOffset = byteOffset;
        eventIndex++;
      }
    } finally {
      rl.close();
      fileStream.destroy();
    }

    if (needsTruncation) {
      const fh = await open(this.filePath, "r+");
      try { await fh.truncate(lastValidByteOffset); } finally { await fh.close(); }
      console.error(`Journal: truncated to ${lastValidByteOffset} bytes (${eventIndex} valid events)`);
    }

    this.nextSeq = maxSeq + 1;
    if (eventIndex > 0) {
      this.lastHash = prevHash;
    }
    // Store known session IDs for getKnownSessionIds() without loading events
    this.lazySessionIds = sessionIds;
    console.error(`Journal: lazy init completed — ${eventIndex} events, ${sessionIds.size} sessions (index empty, on-demand loading)`);
  }

  /**
   * Load a session's events from disk into the session index (cache).
   * Used in lazy mode when a readSession() call misses the in-memory index.
   */
  private async loadSessionFromDisk(sessionId: string): Promise<JournalEvent[]> {
    if (!existsSync(this.filePath)) return [];
    const fileStream = createReadStream(this.filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });
    const events: JournalEvent[] = [];
    let sessionBytes = 0;
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as JournalEvent;
          if (event.session_id === sessionId) {
            events.push(event);
            sessionBytes += Buffer.byteLength(line, "utf-8");
          }
        } catch { /* skip corrupted lines */ }
      }
    } finally {
      rl.close();
      fileStream.destroy();
    }
    // Cache the loaded session in the index
    if (events.length > 0) {
      this.sessionIndex.set(sessionId, events);
      this.currentIndexBytes += sessionBytes;
      this.trackSessionAccess(sessionId);
      this.evictSessionsIfNeeded();
    }
    return events;
  }

  // Set of known session IDs for lazy mode (populated by initLazy)
  private lazySessionIds: Set<string> | undefined;

  private evictSessionsIfNeeded(): void {
    while (
      (this.sessionIndex.size > this.maxSessionsIndexed || this.currentIndexBytes > this.maxIndexBytes)
      && this.sessionAccessOrder.length > 0
    ) {
      const oldest = this.sessionAccessOrder.shift()!;
      const evicted = this.sessionIndex.get(oldest);
      if (evicted) {
        // Estimate byte size from event count × average event size (avoid re-serializing)
        for (const e of evicted) {
          this.currentIndexBytes -= Buffer.byteLength(JSON.stringify(e), "utf-8");
        }
        this.sessionIndex.delete(oldest);
      }
    }
    if (this.currentIndexBytes < 0) this.currentIndexBytes = 0;
  }
}

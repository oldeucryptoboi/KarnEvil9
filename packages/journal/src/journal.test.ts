import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Journal } from "./journal.js";

const TEST_DIR = resolve(import.meta.dirname ?? ".", "../../.test-data");
const TEST_FILE = resolve(TEST_DIR, "test-journal.jsonl");

describe("Journal", () => {
  beforeEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* may not exist */ }
  });

  afterEach(async () => {
    try { await rm(TEST_DIR, { recursive: true }); } catch { /* cleanup */ }
  });

  it("creates directory and file on init + emit", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const event = await journal.emit("sess-1", "session.created", { task: "test" });
    expect(event.event_id).toBeTruthy();
    expect(event.session_id).toBe("sess-1");
    expect(event.type).toBe("session.created");
    expect(event.payload).toEqual({ task: "test" });
    expect(existsSync(TEST_FILE)).toBe(true);
  });

  it("reads all events", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    await journal.emit("sess-2", "session.created", {});

    const all = await journal.readAll();
    expect(all).toHaveLength(3);
  });

  it("reads events filtered by session", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-1", "session.started", {});

    const sess1Events = await journal.readSession("sess-1");
    expect(sess1Events).toHaveLength(2);
    expect(sess1Events.every((e) => e.session_id === "sess-1")).toBe(true);
  });

  it("maintains hash chain integrity", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const e1 = await journal.emit("sess-1", "session.created", {});
    const e2 = await journal.emit("sess-1", "session.started", {});

    expect(e1.hash_prev).toBeUndefined();
    expect(e2.hash_prev).toBeTruthy();

    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("detects broken hash chain", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    await journal.emit("sess-1", "session.completed", {});

    // Tamper with the journal file: modify the second line
    const content = await readFile(TEST_FILE, "utf-8");
    const lines = content.trim().split("\n");
    const parsed = JSON.parse(lines[1]!);
    parsed.payload = { tampered: true };
    lines[1] = JSON.stringify(parsed);
    await writeFile(TEST_FILE, lines.join("\n") + "\n", "utf-8");

    const journal2 = new Journal(TEST_FILE, { fsync: false, lock: false, recovery: "strict" });
    // init() with strict recovery throws on tampering
    await expect(journal2.init()).rejects.toThrow("Journal integrity violation at event 2");
  });

  it("returns valid integrity for empty journal", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("notifies listeners on emit", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const received: string[] = [];
    journal.on((event) => { received.push(event.type); });
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    expect(received).toEqual(["session.created", "session.started"]);
  });

  it("supports removing listeners", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const received: string[] = [];
    const unsub = journal.on((event) => { received.push(event.type); });
    await journal.emit("sess-1", "session.created", {});
    unsub();
    await journal.emit("sess-1", "session.started", {});
    expect(received).toEqual(["session.created"]);
  });

  it("continues when a listener throws", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const received: string[] = [];
    journal.on(() => { throw new Error("boom"); });
    journal.on((event) => { received.push(event.type); });
    await journal.emit("sess-1", "session.created", {});
    expect(received).toEqual(["session.created"]);
  });

  it("resumes hash chain from existing file", async () => {
    const journal1 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal1.init();
    await journal1.emit("sess-1", "session.created", {});
    await journal1.emit("sess-1", "session.started", {});

    // Create a new journal instance pointing to the same file
    const journal2 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal2.init();
    await journal2.emit("sess-1", "session.completed", {});

    const integrity = await journal2.verifyIntegrity();
    expect(integrity.valid).toBe(true);
    const all = await journal2.readAll();
    expect(all).toHaveLength(3);
  });

  it("returns empty array for readAll on nonexistent file", async () => {
    const journal = new Journal(resolve(TEST_DIR, "nonexistent.jsonl"), { lock: false });
    await journal.init();
    const events = await journal.readAll();
    expect(events).toEqual([]);
  });

  it("concurrent emits don't corrupt hash chain", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();

    // Fire 20 concurrent emits from different sessions
    const promises = Array.from({ length: 20 }, (_, i) =>
      journal.emit(`sess-${i % 3}`, "session.created", { index: i })
    );
    await Promise.all(promises);

    const events = await journal.readAll();
    expect(events).toHaveLength(20);

    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  // ─── Sequence Number Tests ────────────────────────────────────────

  it("assigns monotonically increasing seq numbers", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const e1 = await journal.emit("sess-1", "session.created", {});
    const e2 = await journal.emit("sess-1", "session.started", {});
    const e3 = await journal.emit("sess-2", "session.created", {});

    expect(e1.seq).toBe(0);
    expect(e2.seq).toBe(1);
    expect(e3.seq).toBe(2);
  });

  it("resumes seq from max on init (re-open existing journal)", async () => {
    const journal1 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal1.init();
    await journal1.emit("sess-1", "session.created", {});
    await journal1.emit("sess-1", "session.started", {});

    const journal2 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal2.init();
    const e3 = await journal2.emit("sess-1", "session.completed", {});
    expect(e3.seq).toBe(2);
  });

  it("old events without seq are still readable (backward compat)", async () => {
    // Manually write an event without seq field
    const { mkdirSync } = await import("node:fs");
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    const legacyEvent = JSON.stringify({
      event_id: "legacy-1",
      timestamp: new Date().toISOString(),
      session_id: "sess-old",
      type: "session.created",
      payload: {},
    });
    await writeFile(TEST_FILE, legacyEvent + "\n", "utf-8");

    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const events = await journal.readSession("sess-old");
    expect(events).toHaveLength(1);
    expect(events[0]!.seq).toBeUndefined();

    // New events should start at seq 0 since no prior seq existed
    const e = await journal.emit("sess-old", "session.started", {});
    expect(e.seq).toBe(0);
  });

  // ─── Session Index Tests ──────────────────────────────────────────

  it("readSession returns correct events after emit (via index)", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    await journal.emit("sess-2", "session.started", {});
    await journal.emit("sess-1", "session.completed", {});

    const sess1 = await journal.readSession("sess-1");
    expect(sess1).toHaveLength(3);
    expect(sess1.map((e) => e.type)).toEqual(["session.created", "session.started", "session.completed"]);

    const sess2 = await journal.readSession("sess-2");
    expect(sess2).toHaveLength(2);
  });

  it("readSession with offset/limit paginates correctly", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    await journal.emit("sess-1", "session.completed", {});

    const page1 = await journal.readSession("sess-1", { offset: 0, limit: 2 });
    expect(page1).toHaveLength(2);
    expect(page1[0]!.type).toBe("session.created");
    expect(page1[1]!.type).toBe("session.started");

    const page2 = await journal.readSession("sess-1", { offset: 2, limit: 2 });
    expect(page2).toHaveLength(1);
    expect(page2[0]!.type).toBe("session.completed");
  });

  it("getSessionEventCount returns correct count", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    expect(journal.getSessionEventCount("sess-1")).toBe(0);

    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    expect(journal.getSessionEventCount("sess-1")).toBe(2);

    await journal.emit("sess-2", "session.created", {});
    expect(journal.getSessionEventCount("sess-1")).toBe(2);
    expect(journal.getSessionEventCount("sess-2")).toBe(1);
  });

  // ─── Compaction Tests ─────────────────────────────────────────────

  it("compaction removes events for non-retained sessions", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    await journal.emit("sess-3", "session.created", {});

    const result = await journal.compact(["sess-1"]);
    expect(result.before).toBe(4);
    expect(result.after).toBe(2);

    const all = await journal.readAll();
    expect(all).toHaveLength(2);
    expect(all.every((e) => e.session_id === "sess-1")).toBe(true);
  });

  it("hash chain is valid after compaction", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-1", "session.started", {});

    await journal.compact(["sess-1"]);
    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("index is correct after compaction", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-1", "session.started", {});

    await journal.compact(["sess-1"]);
    expect(journal.getSessionEventCount("sess-1")).toBe(2);
    expect(journal.getSessionEventCount("sess-2")).toBe(0);

    const sess1 = await journal.readSession("sess-1");
    expect(sess1).toHaveLength(2);
  });

  it("compaction returns before/after counts", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});

    const result = await journal.compact(["sess-1"]);
    expect(result).toEqual({ before: 2, after: 1 });
  });

  it("index survives compaction", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-1", "session.started", {});

    await journal.compact(["sess-1"]);

    // New emit after compaction should still be indexed
    await journal.emit("sess-1", "session.completed", {});
    expect(journal.getSessionEventCount("sess-1")).toBe(3);

    const events = await journal.readSession("sess-1");
    expect(events[2]!.type).toBe("session.completed");
  });

  it("compaction without retainSessionIds is a no-op (keeps all)", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});

    const result = await journal.compact();
    expect(result.before).toBe(2);
    expect(result.after).toBe(2);
  });

  it("seq numbers are rebuilt after compaction", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-1", "session.started", {});

    await journal.compact(["sess-1"]);
    const events = await journal.readSession("sess-1");
    expect(events[0]!.seq).toBe(0);
    expect(events[1]!.seq).toBe(1);

    // Next emit should continue from seq 2
    const e = await journal.emit("sess-1", "session.completed", {});
    expect(e.seq).toBe(2);
  });

  // ─── Health Check Tests ───────────────────────────────────────────

  it("checkHealth returns writable for accessible journal", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    const health = await journal.checkHealth();
    expect(health.writable).toBe(true);
  });

  it("checkHealth returns not writable for nonexistent file", async () => {
    const journal = new Journal(resolve(TEST_DIR, "nonexistent-dir", "nope.jsonl"), { lock: false });
    // Don't init — file doesn't exist
    const health = await journal.checkHealth();
    expect(health.writable).toBe(false);
  });

  it("getFilePath returns the configured path", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    expect(journal.getFilePath()).toBe(TEST_FILE);
  });

  // ─── Redaction Tests ────────────────────────────────────────────────

  it("redacts sensitive payload fields on emit", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const event = await journal.emit("sess-1", "session.created", {
      authorization: "Bearer secret-token-123",
      safe_field: "visible",
    });
    expect(event.payload.authorization).toBe("[REDACTED]");
    expect(event.payload.safe_field).toBe("visible");

    // Also verify it's stored redacted on disk
    const events = await journal.readAll();
    const stored = events.find((e) => e.event_id === event.event_id)!;
    expect(stored.payload.authorization).toBe("[REDACTED]");
  });

  it("preserves payload when redaction is disabled", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, redact: false, lock: false });
    await journal.init();
    const event = await journal.emit("sess-1", "session.created", {
      authorization: "Bearer secret-token-123",
    });
    expect(event.payload.authorization).toBe("Bearer secret-token-123");
  });

  // ─── Fsync Option Tests ─────────────────────────────────────────────

  it("disabling fsync works for tests", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", { test: true });
    const events = await journal.readAll();
    expect(events).toHaveLength(1);
  });

  it("enabling fsync does not crash", async () => {
    const journal = new Journal(TEST_FILE, { fsync: true, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", { test: true });
    const events = await journal.readAll();
    expect(events).toHaveLength(1);
  });

  // ─── tryEmit Tests ──────────────────────────────────────────────────

  it("tryEmit returns event on success", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    const event = await journal.tryEmit("sess-1", "session.created", { test: true });
    expect(event).not.toBeNull();
    expect(event!.type).toBe("session.created");
  });

  it("tryEmit returns null on failure", async () => {
    const journal = new Journal(resolve(TEST_DIR, "nonexistent-dir", "sub", "test.jsonl"), { fsync: false, lock: false });
    // Don't init — directory doesn't exist, emit will fail
    const event = await journal.tryEmit("sess-1", "session.created", {});
    expect(event).toBeNull();
  });

  // ─── getDiskUsage Tests ─────────────────────────────────────────────

  it("getDiskUsage returns disk stats", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    const usage = await journal.getDiskUsage();
    expect(usage).not.toBeNull();
    expect(usage!.total_bytes).toBeGreaterThan(0);
    expect(usage!.available_bytes).toBeGreaterThan(0);
    expect(usage!.usage_pct).toBeGreaterThanOrEqual(0);
    expect(usage!.usage_pct).toBeLessThanOrEqual(100);
  });

  it("checkHealth includes disk_usage", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    const health = await journal.checkHealth();
    expect(health.writable).toBe(true);
    expect(health.disk_usage).toBeDefined();
    expect(health.disk_usage!.total_bytes).toBeGreaterThan(0);
  });

  // ─── close() Tests ─────────────────────────────────────────────────

  it("close() waits for pending writes to flush", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();

    // Fire multiple writes concurrently
    const writes = Array.from({ length: 10 }, (_, i) =>
      journal.emit(`sess-${i}`, "session.created", { step: i })
    );

    // Close should wait for all pending writes
    await journal.close();

    // All writes should have completed — await them to be sure
    await Promise.all(writes);

    // Verify all events were written
    const events = await journal.readAll();
    expect(events.length).toBe(10);
  });

  it("close() is safe to call multiple times", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});

    // Multiple close calls should not throw
    await journal.close();
    await journal.close();
    await journal.close();
  });

  it("close() resolves immediately when no writes pending", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();

    // No writes — close should resolve instantly
    await journal.close();
  });

  // ─── M1: Advisory Lockfile Tests ────────────────────────────────────

  it("acquires lockfile on init", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: true });
    await journal.init();

    expect(existsSync(TEST_FILE + ".lock")).toBe(true);

    // Read the lock file to verify it contains our PID
    const lockContent = await readFile(TEST_FILE + ".lock", "utf-8");
    expect(parseInt(lockContent.trim(), 10)).toBe(process.pid);

    await journal.close();
  });

  it("second init on same file throws when locked", async () => {
    const journal1 = new Journal(TEST_FILE, { fsync: false, lock: true });
    await journal1.init();

    const journal2 = new Journal(TEST_FILE, { fsync: false, lock: true });
    await expect(journal2.init()).rejects.toThrow(/Journal is locked by process/);

    await journal1.close();
  });

  it("cleans up stale lockfile on init", async () => {
    // Create a lockfile with a PID that doesn't exist
    const { mkdirSync } = await import("node:fs");
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });

    // Use a very high PID that is extremely unlikely to exist
    const fakePid = 2147483647;
    await writeFile(TEST_FILE + ".lock", String(fakePid), "utf-8");

    const journal = new Journal(TEST_FILE, { fsync: false, lock: true });
    // Should succeed because the stale lock is cleaned up
    await journal.init();

    // Lock should now be acquired by our process
    const lockContent = await readFile(TEST_FILE + ".lock", "utf-8");
    expect(parseInt(lockContent.trim(), 10)).toBe(process.pid);

    await journal.close();
  });

  it("releases lockfile on close", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: true });
    await journal.init();
    expect(existsSync(TEST_FILE + ".lock")).toBe(true);

    await journal.close();
    expect(existsSync(TEST_FILE + ".lock")).toBe(false);
  });

  it("lockfile not created when lock=false", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});

    expect(existsSync(TEST_FILE + ".lock")).toBe(false);

    await journal.close();
  });

  // ─── M4: readAll Guard Tests ────────────────────────────────────────

  it("readAll with limit returns last N events", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    await journal.emit("sess-1", "session.completed", {});

    const last2 = await journal.readAll({ limit: 2 });
    expect(last2).toHaveLength(2);
    expect(last2[0]!.type).toBe("session.started");
    expect(last2[1]!.type).toBe("session.completed");
  });

  it("readAll without limit returns all events", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    await journal.emit("sess-1", "session.completed", {});

    const all = await journal.readAll();
    expect(all).toHaveLength(3);
  });

  it("readAll with limit larger than event count returns all", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});

    const all = await journal.readAll({ limit: 100 });
    expect(all).toHaveLength(2);
  });

  it("readAllStream yields events one at a time", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-1", "session.started", {});
    await journal.emit("sess-1", "session.completed", {});

    const events = [];
    for await (const event of journal.readAllStream()) {
      events.push(event);
    }
    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe("session.created");
    expect(events[2]!.type).toBe("session.completed");
  });

  it("readAllStream returns empty for nonexistent file", async () => {
    const journal = new Journal(resolve(TEST_DIR, "nonexistent-stream.jsonl"), { lock: false });
    await journal.init();

    const events = [];
    for await (const event of journal.readAllStream()) {
      events.push(event);
    }
    expect(events).toHaveLength(0);
  });

  // ─── M5: sessionIndex LRU Cap Tests ────────────────────────────────

  it("evicts oldest session when maxSessionsIndexed exceeded", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false, maxSessionsIndexed: 3 });
    await journal.init();

    // Add events for 4 sessions (max is 3)
    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-3", "session.created", {});
    await journal.emit("sess-4", "session.created", {});

    // sess-1 should have been evicted (oldest)
    expect(journal.getSessionEventCount("sess-1")).toBe(0);

    // sess-2, sess-3, sess-4 should still be indexed
    expect(journal.getSessionEventCount("sess-2")).toBe(1);
    expect(journal.getSessionEventCount("sess-3")).toBe(1);
    expect(journal.getSessionEventCount("sess-4")).toBe(1);
  });

  it("readSession refreshes session in LRU order", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false, maxSessionsIndexed: 3 });
    await journal.init();

    await journal.emit("sess-1", "session.created", {});
    await journal.emit("sess-2", "session.created", {});
    await journal.emit("sess-3", "session.created", {});

    // Access sess-1 to refresh it (moves it to most-recently-used)
    await journal.readSession("sess-1");

    // Now add sess-4 — sess-2 should be evicted (it's now the oldest)
    await journal.emit("sess-4", "session.created", {});

    expect(journal.getSessionEventCount("sess-1")).toBe(1); // still present (was refreshed)
    expect(journal.getSessionEventCount("sess-2")).toBe(0); // evicted
    expect(journal.getSessionEventCount("sess-3")).toBe(1);
    expect(journal.getSessionEventCount("sess-4")).toBe(1);
  });

  it("default maxSessionsIndexed is 10000", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();

    // Verify we can add many sessions without eviction
    // (just testing that default is large, not creating 10000 sessions)
    for (let i = 0; i < 50; i++) {
      await journal.emit(`sess-${i}`, "session.created", {});
    }

    // All 50 should still be indexed
    for (let i = 0; i < 50; i++) {
      expect(journal.getSessionEventCount(`sess-${i}`)).toBe(1);
    }
  });

  // ─── Anti-Corruption / Recovery Tests ─────────────────────────────

  it("recovers from partial last line (crash mid-write)", async () => {
    const journal1 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal1.init();
    await journal1.emit("sess-1", "session.created", {});
    await journal1.emit("sess-1", "session.started", {});

    // Simulate crash mid-write: append incomplete JSON
    const { appendFileSync, mkdirSync } = await import("node:fs");
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    appendFileSync(TEST_FILE, '{"incomplete');

    // New journal should recover by truncating the partial line
    const journal2 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal2.init();

    const events = await journal2.readAll();
    expect(events).toHaveLength(2);

    // Should be able to continue writing
    await journal2.emit("sess-1", "session.completed", {});
    const integrity = await journal2.verifyIntegrity();
    expect(integrity.valid).toBe(true);
    expect(await journal2.readAll()).toHaveLength(3);
  });

  it("recovers from hash chain break in truncate mode (default)", async () => {
    const journal1 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal1.init();
    await journal1.emit("sess-1", "session.created", {});
    await journal1.emit("sess-1", "session.started", {});
    await journal1.emit("sess-1", "step.started", { step_id: "s1" });
    await journal1.emit("sess-1", "step.succeeded", { step_id: "s1" });
    await journal1.emit("sess-1", "session.completed", {});

    // Corrupt event 3's hash_prev to break the chain
    const content = await readFile(TEST_FILE, "utf-8");
    const lines = content.trim().split("\n");
    const parsed = JSON.parse(lines[3]!);
    parsed.hash_prev = "0000000000000000000000000000000000000000000000000000000000000000";
    lines[3] = JSON.stringify(parsed);
    await writeFile(TEST_FILE, lines.join("\n") + "\n", "utf-8");

    // Default recovery ("truncate") should keep events 0-2 and discard 3-4
    const journal2 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal2.init();

    const events = await journal2.readAll();
    expect(events).toHaveLength(3);

    // Hash chain should be valid for the surviving events
    const integrity = await journal2.verifyIntegrity();
    expect(integrity.valid).toBe(true);

    // Should be able to continue writing
    const e = await journal2.emit("sess-1", "session.completed", {});
    expect(e.seq).toBe(3);
  });

  it("strict recovery throws on hash chain break", async () => {
    const journal1 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal1.init();
    await journal1.emit("sess-1", "session.created", {});
    await journal1.emit("sess-1", "session.started", {});
    await journal1.emit("sess-1", "session.completed", {});

    // Corrupt event 1's hash_prev
    const content = await readFile(TEST_FILE, "utf-8");
    const lines = content.trim().split("\n");
    const parsed = JSON.parse(lines[1]!);
    parsed.hash_prev = "bad_hash";
    lines[1] = JSON.stringify(parsed);
    await writeFile(TEST_FILE, lines.join("\n") + "\n", "utf-8");

    const journal2 = new Journal(TEST_FILE, { fsync: false, lock: false, recovery: "strict" });
    await expect(journal2.init()).rejects.toThrow("Journal integrity violation at event 1");
  });

  it("recovers from empty file left after truncating all lines", async () => {
    const { mkdirSync } = await import("node:fs");
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });

    // Write only an incomplete line (no valid events)
    await writeFile(TEST_FILE, '{"broken\n', "utf-8");

    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();

    // Should start fresh
    const events = await journal.readAll();
    expect(events).toHaveLength(0);

    // Should be able to write new events
    const e = await journal.emit("sess-1", "session.created", {});
    expect(e.seq).toBe(0);
    expect(e.hash_prev).toBeUndefined();
  });

  it("truncate recovery preserves valid events in session index", async () => {
    const journal1 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal1.init();
    await journal1.emit("sess-1", "session.created", {});
    await journal1.emit("sess-2", "session.created", {});
    await journal1.emit("sess-1", "session.started", {});

    // Corrupt event 2 (sess-1 session.started) to break chain
    const content = await readFile(TEST_FILE, "utf-8");
    const lines = content.trim().split("\n");
    const parsed = JSON.parse(lines[2]!);
    parsed.hash_prev = "corrupted";
    lines[2] = JSON.stringify(parsed);
    await writeFile(TEST_FILE, lines.join("\n") + "\n", "utf-8");

    const journal2 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal2.init();

    // Only events 0 and 1 should survive
    expect(journal2.getSessionEventCount("sess-1")).toBe(1);
    expect(journal2.getSessionEventCount("sess-2")).toBe(1);
  });

  it("hash chain break at event 1 leaves only event 0", async () => {
    const journal1 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal1.init();
    await journal1.emit("sess-1", "session.created", {});
    await journal1.emit("sess-1", "session.started", {});
    await journal1.emit("sess-1", "session.completed", {});

    // Corrupt event 1's hash_prev — only event 0 should survive
    const content = await readFile(TEST_FILE, "utf-8");
    const lines = content.trim().split("\n");
    const parsed = JSON.parse(lines[1]!);
    parsed.hash_prev = "wrong";
    lines[1] = JSON.stringify(parsed);
    await writeFile(TEST_FILE, lines.join("\n") + "\n", "utf-8");

    const journal2 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal2.init();

    const events = await journal2.readAll();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("session.created");

    // Continue writing — hash chain should be valid
    const e = await journal2.emit("sess-1", "session.started", {});
    expect(e.seq).toBe(1);
    expect(e.hash_prev).toBeTruthy();
    const integrity = await journal2.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("partial line in strict mode is still truncated (strict only affects hash chain)", async () => {
    const journal1 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal1.init();
    await journal1.emit("sess-1", "session.created", {});

    // Append partial line
    const { appendFileSync } = await import("node:fs");
    appendFileSync(TEST_FILE, '{"half_written');

    // Strict mode should still recover from the partial line (it's a JSON issue, not a hash chain issue)
    const journal2 = new Journal(TEST_FILE, { fsync: false, lock: false, recovery: "strict" });
    await journal2.init();

    const events = await journal2.readAll();
    expect(events).toHaveLength(1);
  });

  it("partial line followed by hash chain break is handled (both corruptions)", async () => {
    const journal1 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal1.init();
    await journal1.emit("sess-1", "session.created", {});
    await journal1.emit("sess-1", "session.started", {});
    await journal1.emit("sess-1", "session.completed", {});

    // Corrupt event 2's hash_prev AND append a partial line
    const content = await readFile(TEST_FILE, "utf-8");
    const lines = content.trim().split("\n");
    const parsed = JSON.parse(lines[2]!);
    parsed.hash_prev = "bad";
    lines[2] = JSON.stringify(parsed);
    await writeFile(TEST_FILE, lines.join("\n") + "\n" + '{"garbage', "utf-8");

    const journal2 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal2.init();

    // Partial line trimmed first, then hash chain break truncates to 2 events
    const events = await journal2.readAll();
    expect(events).toHaveLength(2);
    const integrity = await journal2.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("recovered journal file is clean on re-init", async () => {
    const journal1 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal1.init();
    await journal1.emit("sess-1", "session.created", {});
    await journal1.emit("sess-1", "session.started", {});
    await journal1.emit("sess-1", "session.completed", {});

    // Corrupt event 2
    const content = await readFile(TEST_FILE, "utf-8");
    const lines = content.trim().split("\n");
    const parsed = JSON.parse(lines[2]!);
    parsed.hash_prev = "corrupt";
    lines[2] = JSON.stringify(parsed);
    await writeFile(TEST_FILE, lines.join("\n") + "\n", "utf-8");

    // First init: recovers
    const journal2 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal2.init();
    expect(await journal2.readAll()).toHaveLength(2);

    // Second init: file should be clean — no recovery needed, no stderr output
    const journal3 = new Journal(TEST_FILE, { fsync: false, lock: false, recovery: "strict" });
    await journal3.init(); // would throw if file is still corrupted
    expect(await journal3.readAll()).toHaveLength(2);
    const integrity = await journal3.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("atomic rewrite removes tmp file after hash chain recovery", async () => {
    const journal1 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal1.init();
    await journal1.emit("sess-1", "session.created", {});
    await journal1.emit("sess-1", "session.started", {});

    // Corrupt event 1
    const content = await readFile(TEST_FILE, "utf-8");
    const lines = content.trim().split("\n");
    const parsed = JSON.parse(lines[1]!);
    parsed.hash_prev = "broken";
    lines[1] = JSON.stringify(parsed);
    await writeFile(TEST_FILE, lines.join("\n") + "\n", "utf-8");

    const journal2 = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal2.init();

    // tmp file should not linger after rename
    expect(existsSync(TEST_FILE + ".tmp")).toBe(false);
  });

  it("registerShutdownHandler returns a working cleanup function", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();

    const cleanup = journal.registerShutdownHandler();
    expect(typeof cleanup).toBe("function");

    // Cleanup should not throw
    cleanup();
  });

  it("registerShutdownHandler can be called multiple times safely", async () => {
    const journal = new Journal(TEST_FILE, { fsync: false, lock: false });
    await journal.init();

    const cleanup1 = journal.registerShutdownHandler();
    const cleanup2 = journal.registerShutdownHandler();

    // Both cleanups should work
    cleanup1();
    cleanup2();
  });
});

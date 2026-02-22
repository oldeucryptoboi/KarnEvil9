import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";

describe("Journal Lifecycle Smoke", () => {
  let testDir: string;
  let journalPath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `karnevil9-e2e-journal-${uuid()}`);
    journalPath = join(testDir, "journal", "events.jsonl");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("creates journal file and parent directories on init", async () => {
    const journal = new Journal(journalPath, { fsync: false, redact: false });
    await journal.init();

    // Parent directory should be created
    expect(existsSync(join(testDir, "journal"))).toBe(true);
  });

  it("emits events and persists them to disk", async () => {
    const journal = new Journal(journalPath, { fsync: false, redact: false });
    await journal.init();

    const sessionId = uuid();
    await journal.emit(sessionId, "session.created", { task_text: "smoke test" });
    await journal.emit(sessionId, "session.started", {});
    await journal.emit(sessionId, "session.completed", {});

    // File should exist after emitting events
    expect(existsSync(journalPath)).toBe(true);
    const fileStat = await stat(journalPath);
    expect(fileStat.size).toBeGreaterThan(0);

    // Read events back
    const events = await journal.readAll();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual([
      "session.created",
      "session.started",
      "session.completed",
    ]);
  });

  it("maintains hash chain integrity across multiple events", async () => {
    const journal = new Journal(journalPath, { fsync: false, redact: false });
    await journal.init();

    const sessionId = uuid();
    await journal.emit(sessionId, "session.created", { task_text: "integrity test" });
    await journal.emit(sessionId, "session.started", {});
    await journal.emit(sessionId, "planner.requested", { task_text: "test" });
    await journal.emit(sessionId, "session.completed", {});

    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);
    expect(integrity.brokenAt).toBeUndefined();
  });

  it("survives restart — reloads events from existing file", async () => {
    const sessionId = uuid();

    // First journal instance writes events
    const journal1 = new Journal(journalPath, { fsync: false, redact: false });
    await journal1.init();
    await journal1.emit(sessionId, "session.created", { task_text: "restart test" });
    await journal1.emit(sessionId, "session.started", {});
    await journal1.close();

    // Second journal instance reads them back
    const journal2 = new Journal(journalPath, { fsync: false, redact: false });
    await journal2.init();
    const events = await journal2.readAll();
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("session.created");
    expect(events[1]!.type).toBe("session.started");

    // Can continue writing with proper hash chain
    await journal2.emit(sessionId, "session.completed", {});
    const integrity = await journal2.verifyIntegrity();
    expect(integrity.valid).toBe(true);
  });

  it("health check reports writable status", async () => {
    const journal = new Journal(journalPath, { fsync: false, redact: false });
    await journal.init();

    const health = await journal.checkHealth();
    expect(health.writable).toBe(true);
    expect(health.disk_usage).toBeDefined();
    expect(health.disk_usage!.total_bytes).toBeGreaterThan(0);
    expect(health.disk_usage!.usage_pct).toBeGreaterThanOrEqual(0);
    expect(health.disk_usage!.usage_pct).toBeLessThanOrEqual(100);
  });

  it("compact preserves integrity after compaction", async () => {
    const journal = new Journal(journalPath, { fsync: false, redact: false });
    await journal.init();

    const session1 = uuid();
    const session2 = uuid();
    await journal.emit(session1, "session.created", { task_text: "s1" });
    await journal.emit(session2, "session.created", { task_text: "s2" });
    await journal.emit(session1, "session.completed", {});
    await journal.emit(session2, "session.completed", {});

    // Compact, retaining only session2
    const result = await journal.compact([session2]);
    expect(result.before).toBe(4);
    expect(result.after).toBe(2);

    // Integrity should still hold after compaction
    const integrity = await journal.verifyIntegrity();
    expect(integrity.valid).toBe(true);

    // Only session2 events should remain
    const events = await journal.readAll();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.session_id === session2)).toBe(true);
  });

  it("sequential numbering (seq) is monotonically increasing", async () => {
    const journal = new Journal(journalPath, { fsync: false, redact: false });
    await journal.init();

    const sessionId = uuid();
    for (let i = 0; i < 10; i++) {
      await journal.emit(sessionId, "session.checkpoint", { i });
    }

    const events = await journal.readAll();
    for (let i = 0; i < events.length; i++) {
      expect(events[i]!.seq).toBe(i);
    }
  });

  it("event listener fires for each emitted event", async () => {
    const journal = new Journal(journalPath, { fsync: false, redact: false });
    await journal.init();

    const received: string[] = [];
    const unsubscribe = journal.on((event) => {
      received.push(event.type);
    });

    const sessionId = uuid();
    await journal.emit(sessionId, "session.created", {});
    await journal.emit(sessionId, "session.started", {});
    await journal.emit(sessionId, "session.completed", {});

    expect(received).toEqual(["session.created", "session.started", "session.completed"]);

    unsubscribe();
    await journal.emit(sessionId, "session.checkpoint", {});
    expect(received).toHaveLength(3); // no more events after unsubscribe
  });
});

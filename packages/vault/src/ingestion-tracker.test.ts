import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { IngestionTracker } from "./ingestion-tracker.js";

describe("IngestionTracker", () => {
  let tmpDir: string;
  let tracker: IngestionTracker;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vault-tracker-test-${uuid()}`);
    await mkdir(tmpDir, { recursive: true });
    tracker = new IngestionTracker(join(tmpDir, "ingestion-log.jsonl"));
    await tracker.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("starts empty", () => {
    expect(tracker.size()).toBe(0);
  });

  it("tracks an ingestion", async () => {
    await tracker.track("chatgpt", "conv_123", "Hello world", "obj-1");
    expect(tracker.size()).toBe(1);
    expect(tracker.hasBeenIngested("chatgpt", "conv_123")).toBe(true);
    expect(tracker.hasBeenIngested("chatgpt", "conv_456")).toBe(false);
  });

  it("detects content changes", async () => {
    await tracker.track("chatgpt", "conv_123", "Version 1", "obj-1");

    expect(tracker.hasContentChanged("chatgpt", "conv_123", "Version 1")).toBe(false);
    expect(tracker.hasContentChanged("chatgpt", "conv_123", "Version 2")).toBe(true);
  });

  it("returns true for hasContentChanged on unknown source", () => {
    expect(tracker.hasContentChanged("unknown", "x", "content")).toBe(true);
  });

  it("retrieves a record", async () => {
    await tracker.track("test", "item-1", "content", "obj-1");
    const record = tracker.getRecord("test", "item-1");
    expect(record).toBeDefined();
    expect(record!.object_id).toBe("obj-1");
    expect(record!.content_hash).toBeTruthy();
  });

  it("retrieves object ID", async () => {
    await tracker.track("test", "item-1", "content", "obj-42");
    expect(tracker.getObjectId("test", "item-1")).toBe("obj-42");
    expect(tracker.getObjectId("test", "unknown")).toBeUndefined();
  });

  it("persists across init cycles", async () => {
    const filePath = join(tmpDir, "persist.jsonl");
    const t1 = new IngestionTracker(filePath);
    await t1.init();
    await t1.track("source", "id-1", "data", "obj-1");
    await t1.track("source", "id-2", "data2", "obj-2");

    const t2 = new IngestionTracker(filePath);
    await t2.init();
    expect(t2.size()).toBe(2);
    expect(t2.hasBeenIngested("source", "id-1")).toBe(true);
  });

  it("skips malformed JSONL lines during init", async () => {
    const filePath = join(tmpDir, "malformed.jsonl");
    const validRecord = JSON.stringify({
      source: "test",
      source_id: "ok-1",
      content_hash: "abc123",
      object_id: "obj-1",
      ingested_at: new Date().toISOString(),
    });
    const content = `${validRecord}\n{not valid json\n{"also": "broken\n${validRecord.replace("ok-1", "ok-2").replace("obj-1", "obj-2")}\n`;
    await writeFile(filePath, content, "utf-8");

    const t = new IngestionTracker(filePath);
    await t.init();
    // Should have loaded the 2 valid records, skipped the 2 malformed ones
    expect(t.size()).toBe(2);
    expect(t.hasBeenIngested("test", "ok-1")).toBe(true);
    expect(t.hasBeenIngested("test", "ok-2")).toBe(true);
  });

  it("compacts deduplicating records", async () => {
    // Track same source_id multiple times to simulate updates
    await tracker.track("test", "item-1", "v1", "obj-1");
    await tracker.track("test", "item-1", "v2", "obj-1");

    const sizeBefore = tracker.size();
    await tracker.compact();

    // Re-read
    const t2 = new IngestionTracker(join(tmpDir, "ingestion-log.jsonl"));
    await t2.init();
    expect(t2.size()).toBe(sizeBefore);
    expect(t2.hasContentChanged("test", "item-1", "v2")).toBe(false);
  });
});

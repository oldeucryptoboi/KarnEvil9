import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import type { HookContext, HookRegistration, HookResult } from "@jarvis/schemas";
import { Journal } from "@jarvis/journal";
import { HookRunner } from "./hook-runner.js";

describe("HookRunner", () => {
  let testDir: string;
  let journal: Journal;
  let runner: HookRunner;

  beforeEach(async () => {
    testDir = join(tmpdir(), `jarvis-test-${uuid()}`);
    await mkdir(testDir, { recursive: true });
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false, lock: false });
    await journal.init();
    runner = new HookRunner(journal);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const ctx: HookContext = { session_id: "s1", plugin_id: "kernel" };

  it("returns continue when no hooks registered", async () => {
    const result = await runner.run("before_step", ctx);
    expect(result.action).toBe("continue");
  });

  it("executes hooks in priority order", async () => {
    const order: number[] = [];

    runner.register({
      plugin_id: "p2", hook: "before_step",
      handler: async () => { order.push(2); return { action: "observe" }; },
      priority: 200, timeout_ms: 5000,
    });
    runner.register({
      plugin_id: "p1", hook: "before_step",
      handler: async () => { order.push(1); return { action: "observe" }; },
      priority: 50, timeout_ms: 5000,
    });

    await runner.run("before_step", ctx);
    expect(order).toEqual([1, 2]);
  });

  it("handles timeout", async () => {
    runner.register({
      plugin_id: "slow", hook: "before_step",
      handler: async () => { await new Promise(() => {}); return { action: "observe" }; },
      priority: 100, timeout_ms: 50,
    });

    const result = await runner.run("before_step", ctx);
    expect(result.action).toBe("continue"); // failed hook skipped

    const events = await journal.readAll();
    expect(events.some((e) => e.type === "plugin.hook_failed")).toBe(true);
  });

  it("trips circuit breaker after N failures", async () => {
    let callCount = 0;
    runner.register({
      plugin_id: "failing", hook: "before_step",
      handler: async () => {
        callCount++;
        throw new Error("always fails");
      },
      priority: 100, timeout_ms: 5000,
    });

    // Trip the breaker (default threshold is 5)
    for (let i = 0; i < 6; i++) {
      await runner.run("before_step", ctx);
    }

    const events = await journal.readAll();
    const circuitOpenEvents = events.filter((e) => e.type === "plugin.hook_circuit_open");
    expect(circuitOpenEvents.length).toBeGreaterThan(0);
  });

  it("handles block result - short circuits chain", async () => {
    const order: string[] = [];

    runner.register({
      plugin_id: "blocker", hook: "before_step",
      handler: async () => {
        order.push("blocker");
        return { action: "block", reason: "denied" };
      },
      priority: 50, timeout_ms: 5000,
    });
    runner.register({
      plugin_id: "after-blocker", hook: "before_step",
      handler: async () => {
        order.push("after");
        return { action: "observe" };
      },
      priority: 100, timeout_ms: 5000,
    });

    const result = await runner.run("before_step", ctx);
    expect(result.action).toBe("block");
    expect((result as { reason: string }).reason).toBe("denied");
    expect(order).toEqual(["blocker"]); // second hook NOT called
  });

  it("handles modify result - merges data forward", async () => {
    runner.register({
      plugin_id: "modifier", hook: "before_step",
      handler: async () => ({ action: "modify", data: { extra: true } }),
      priority: 50, timeout_ms: 5000,
    });
    runner.register({
      plugin_id: "observer", hook: "before_step",
      handler: async (ctx) => {
        // Should see the merged data from the modifier
        return { action: "continue", data: { saw_extra: ctx.extra } };
      },
      priority: 100, timeout_ms: 5000,
    });

    const result = await runner.run("before_step", ctx);
    expect(result.action).toBe("modify");
    expect((result as { data: Record<string, unknown> }).data.extra).toBe(true);
    expect((result as { data: Record<string, unknown> }).data.saw_extra).toBe(true);
  });

  it("continue with data merges forward", async () => {
    runner.register({
      plugin_id: "enricher", hook: "before_step",
      handler: async () => ({ action: "continue", data: { enriched: true } }),
      priority: 100, timeout_ms: 5000,
    });

    const result = await runner.run("before_step", ctx);
    expect(result.action).toBe("modify");
    expect((result as { data: Record<string, unknown> }).data.enriched).toBe(true);
  });

  it("journals hook_fired events", async () => {
    runner.register({
      plugin_id: "logger", hook: "before_step",
      handler: async () => ({ action: "observe" }),
      priority: 100, timeout_ms: 5000,
    });

    await runner.run("before_step", ctx);

    const events = await journal.readAll();
    expect(events.some((e) => e.type === "plugin.hook_fired")).toBe(true);
  });

  it("rejects invalid hook result action", async () => {
    runner.register({
      plugin_id: "bad-action", hook: "before_step",
      handler: async () => ({ action: "delete_everything" } as unknown as HookResult),
      priority: 100, timeout_ms: 5000,
    });

    const result = await runner.run("before_step", ctx);
    expect(result.action).toBe("continue"); // invalid result treated as failure, skipped

    const events = await journal.readAll();
    expect(events.some((e) => e.type === "plugin.hook_failed")).toBe(true);
  });

  it("rejects block action on after_step hook", async () => {
    runner.register({
      plugin_id: "bad-blocker", hook: "after_step",
      handler: async () => ({ action: "block", reason: "should not be allowed" }),
      priority: 100, timeout_ms: 5000,
    });

    const result = await runner.run("after_step", ctx);
    expect(result.action).toBe("continue"); // rejected, skipped

    const events = await journal.readAll();
    expect(events.some((e) => e.type === "plugin.hook_failed")).toBe(true);
  });

  it("deep clones modify data to prevent reference sharing", async () => {
    const shared = { nested: { value: 1 } };
    runner.register({
      plugin_id: "ref-sharer", hook: "before_step",
      handler: async () => ({ action: "modify", data: { obj: shared } }),
      priority: 50, timeout_ms: 5000,
    });
    runner.register({
      plugin_id: "receiver", hook: "before_step",
      handler: async (ctx) => {
        const obj = ctx.obj as typeof shared;
        // Mutating should not affect original
        if (obj) obj.nested.value = 999;
        return { action: "observe" };
      },
      priority: 100, timeout_ms: 5000,
    });

    await runner.run("before_step", ctx);
    expect(shared.nested.value).toBe(1); // original untouched
  });

  it("unregisterPlugin removes all hooks for a plugin", async () => {
    runner.register({
      plugin_id: "to-remove", hook: "before_step",
      handler: async () => ({ action: "modify", data: { present: true } }),
      priority: 100, timeout_ms: 5000,
    });

    let result = await runner.run("before_step", ctx);
    expect(result.action).toBe("modify");

    runner.unregisterPlugin("to-remove");
    result = await runner.run("before_step", ctx);
    expect(result.action).toBe("continue");
  });
});

import { describe, it, expect } from "vitest";
import { JournalAdapter } from "./journal-adapter.js";
import type { JournalEvent } from "@karnevil9/schemas";

function makeEvent(overrides: Partial<JournalEvent>): JournalEvent {
  return {
    event_id: "evt-1",
    timestamp: "2026-02-17T12:00:00Z",
    session_id: "session-1",
    type: "session.created",
    payload: {},
    ...overrides,
  };
}

describe("JournalAdapter", () => {
  it("has correct name and source", () => {
    const adapter = new JournalAdapter({ readEvents: async () => [] });
    expect(adapter.name).toBe("journal");
    expect(adapter.source).toBe("karnevil9-journal");
  });

  it("yields items grouped by session", async () => {
    const events: JournalEvent[] = [
      makeEvent({ session_id: "s1", type: "session.created", payload: { task: { text: "Build feature" } } }),
      makeEvent({ session_id: "s1", type: "step.succeeded", payload: { step_title: "Read file", tool_name: "read-file" } }),
      makeEvent({ session_id: "s1", type: "session.completed", payload: {} }),
      makeEvent({ session_id: "s2", type: "session.created", payload: { task_text: "Fix bug" } }),
      makeEvent({ session_id: "s2", type: "step.failed", payload: { step_title: "Write file", tool_name: "write-file" } }),
    ];

    const adapter = new JournalAdapter({ readEvents: async () => events });
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }

    expect(items.length).toBe(2);
    expect(items[0]!.source).toBe("karnevil9-journal");
    expect(items[0]!.source_id).toBe("s1");
    expect(items[0]!.title).toBe("Build feature");
    expect(items[0]!.content).toContain("[succeeded] Read file");
    expect(items[1]!.title).toBe("Fix bug");
    expect(items[1]!.content).toContain("[failed] Write file");
  });

  it("handles empty events", async () => {
    const adapter = new JournalAdapter({ readEvents: async () => [] });
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }
    expect(items.length).toBe(0);
  });

  it("handles async generator readEvents (not Promise)", async () => {
    async function* eventGen(): AsyncGenerator<JournalEvent, void, undefined> {
      yield makeEvent({ session_id: "gen-1", type: "session.created", payload: { task_text: "Generator task" } });
      yield makeEvent({ session_id: "gen-1", type: "step.succeeded", payload: { step_title: "Step A", tool_name: "tool-a" } });
    }

    const adapter = new JournalAdapter({ readEvents: eventGen });
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }

    expect(items.length).toBe(1);
    expect(items[0]!.title).toBe("Generator task");
    expect(items[0]!.content).toContain("[succeeded] Step A");
  });

  it("falls back to Session ID when no task_text or task.text", async () => {
    const events: JournalEvent[] = [
      makeEvent({ session_id: "orphan-sess", type: "step.succeeded", payload: { step_title: "Do thing", tool_name: "t" } }),
    ];

    const adapter = new JournalAdapter({ readEvents: async () => events });
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }

    expect(items.length).toBe(1);
    expect(items[0]!.title).toBe("Session orphan-sess");
  });

  it("sets metadata object_type to Conversation", async () => {
    const events: JournalEvent[] = [
      makeEvent({ session_id: "s1", type: "session.created", payload: { task_text: "Test" } }),
    ];

    const adapter = new JournalAdapter({ readEvents: async () => events });
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }

    expect(items[0]!.metadata.object_type).toBe("Conversation");
  });
});

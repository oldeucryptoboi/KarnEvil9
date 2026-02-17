import type { JournalEvent } from "@karnevil9/schemas";
import type { IngestItem } from "../types.js";
import { BaseAdapter } from "./adapter.js";

export interface JournalAdapterOptions {
  readEvents: () => AsyncGenerator<JournalEvent, void, undefined> | Promise<JournalEvent[]>;
}

export class JournalAdapter extends BaseAdapter {
  readonly name = "journal";
  readonly source = "karnevil9-journal";
  private readEvents: JournalAdapterOptions["readEvents"];

  constructor(options: JournalAdapterOptions) {
    super();
    this.readEvents = options.readEvents;
  }

  async *extract(): AsyncGenerator<IngestItem, void, undefined> {
    const eventsOrGen = this.readEvents();
    const events: JournalEvent[] = [];

    if (Symbol.asyncIterator in eventsOrGen) {
      for await (const event of eventsOrGen) {
        events.push(event);
      }
    } else {
      events.push(...(await eventsOrGen));
    }

    // Group events by session
    const sessions = new Map<string, JournalEvent[]>();
    for (const event of events) {
      if (!sessions.has(event.session_id)) {
        sessions.set(event.session_id, []);
      }
      sessions.get(event.session_id)!.push(event);
    }

    for (const [sessionId, sessionEvents] of sessions) {
      const created = sessionEvents.find((e) => e.type === "session.created");
      const taskText = (created?.payload?.task_text as string) ??
        (created?.payload?.task as { text?: string })?.text ??
        `Session ${sessionId}`;

      const steps = sessionEvents
        .filter((e) => e.type === "step.succeeded" || e.type === "step.failed")
        .map((e) => {
          const status = e.type === "step.succeeded" ? "succeeded" : "failed";
          const title = (e.payload.step_title as string) ?? (e.payload.step_id as string) ?? "";
          const tool = (e.payload.tool_name as string) ?? "";
          return `- [${status}] ${title} (${tool})`;
        });

      const status = sessionEvents.find((e) => e.type.startsWith("session.completed") || e.type.startsWith("session.failed"));
      const sessionStatus = status?.type.replace("session.", "") ?? "unknown";

      const content = [
        `Session ID: ${sessionId}`,
        `Status: ${sessionStatus}`,
        "",
        "## Steps",
        ...steps,
      ].join("\n");

      yield {
        source: "karnevil9-journal",
        source_id: sessionId,
        title: taskText,
        content,
        created_at: created?.timestamp ?? sessionEvents[0]!.timestamp,
        metadata: {
          object_type: "Conversation",
          session_status: sessionStatus,
          step_count: steps.length,
        },
      };
    }
  }
}

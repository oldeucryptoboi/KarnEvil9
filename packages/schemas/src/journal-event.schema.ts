export const JournalEventSchema = {
  type: "object",
  required: ["event_id", "timestamp", "session_id", "type", "payload"],
  properties: {
    event_id: { type: "string", minLength: 1 },
    timestamp: { type: "string", format: "date-time" },
    session_id: { type: "string", minLength: 1 },
    type: {
      type: "string",
      enum: [
        "session.created", "session.started", "session.completed", "session.failed",
        "session.aborted", "session.paused", "session.resumed",
        "planner.requested", "planner.plan_received", "planner.plan_rejected",
        "plan.accepted", "plan.replaced",
        "step.started", "step.succeeded", "step.failed",
        "permission.requested", "permission.granted", "permission.denied",
        "tool.requested", "tool.started", "tool.succeeded", "tool.failed",
      ],
    },
    payload: { type: "object" },
    hash_prev: { type: "string" },
  },
  additionalProperties: false,
} as const;

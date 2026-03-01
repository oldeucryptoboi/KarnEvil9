import { describe, it, expect } from "vitest";
import {
  dim, green, red, yellow, cyan, bold,TERMINAL_EVENTS,
  chatPrompt, colorForType, truncate, formatEvent, helpText,
} from "./chat-formatter.js";

describe("ANSI helpers", () => {
  it("dim wraps with correct codes", () => {
    expect(dim("test")).toBe("\x1b[2mtest\x1b[0m");
  });

  it("green wraps with correct codes", () => {
    expect(green("ok")).toBe("\x1b[32mok\x1b[0m");
  });

  it("red wraps with correct codes", () => {
    expect(red("err")).toBe("\x1b[31merr\x1b[0m");
  });

  it("yellow wraps with correct codes", () => {
    expect(yellow("warn")).toBe("\x1b[33mwarn\x1b[0m");
  });

  it("cyan wraps with correct codes", () => {
    expect(cyan("info")).toBe("\x1b[36minfo\x1b[0m");
  });

  it("bold wraps with correct codes", () => {
    expect(bold("strong")).toBe("\x1b[1mstrong\x1b[0m");
  });
});

describe("chatPrompt", () => {
  it("shows [running] prefix when active", () => {
    const p = chatPrompt(true);
    expect(p).toContain("[running]");
    expect(p).toContain("karnevil9> ");
  });

  it("shows bare prompt when idle", () => {
    expect(chatPrompt(false)).toBe("karnevil9> ");
  });
});

describe("colorForType", () => {
  it("returns green for completed", () => {
    expect(colorForType("session.completed")).toBe(green);
  });

  it("returns green for succeeded", () => {
    expect(colorForType("step.succeeded")).toBe(green);
  });

  it("returns red for failed", () => {
    expect(colorForType("step.failed")).toBe(red);
  });

  it("returns red for error", () => {
    expect(colorForType("session.error")).toBe(red);
  });

  it("returns yellow for warning", () => {
    expect(colorForType("tool.warning")).toBe(yellow);
  });

  it("returns yellow for abort", () => {
    expect(colorForType("session.aborted")).toBe(yellow);
  });

  it("returns yellow for permission", () => {
    expect(colorForType("permission.requested")).toBe(yellow);
  });

  it("returns cyan for default/unknown types", () => {
    expect(colorForType("session.created")).toBe(cyan);
    expect(colorForType("plan.generated")).toBe(cyan);
  });
});

describe("truncate", () => {
  it("passes through strings under limit", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  it("passes through strings at exact limit", () => {
    const s = "x".repeat(100);
    expect(truncate(s, 100)).toBe(s);
  });

  it("truncates with size note over limit", () => {
    const s = "x".repeat(150);
    const result = truncate(s, 100);
    expect(result).toContain("x".repeat(100));
    expect(result).toContain("150 chars total");
  });
});

describe("formatEvent", () => {
  const sid = "test-session-id";

  describe("session lifecycle", () => {
    it("formats session.created with task and mode", () => {
      const event = {
        type: "session.created",
        timestamp: "2025-01-01T12:00:00.000Z",
        payload: { task_text: "Do something", mode: "live" },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("session.created");
      expect(result).toContain("Do something");
      expect(result).toContain("live");
    });

    it("suppresses session.started", () => {
      const event = {
        type: "session.started",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {},
      };
      expect(formatEvent(sid, event)).toBeNull();
    });

    it("formats session.completed as bold green", () => {
      const event = {
        type: "session.completed",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {},
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("Session completed");
    });

    it("formats session.failed with error message", () => {
      const event = {
        type: "session.failed",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { error: { code: "TIMEOUT", message: "exceeded limit" } },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("Session failed");
      expect(result).toContain("TIMEOUT");
    });

    it("formats session.aborted as bold yellow", () => {
      const event = {
        type: "session.aborted",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {},
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("Session aborted");
    });
  });

  describe("planner", () => {
    it("suppresses first planner.requested", () => {
      const event = {
        type: "planner.requested",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { iteration: 1 },
      };
      expect(formatEvent(sid, event)).toBeNull();
    });

    it("shows subsequent planner.requested with iteration", () => {
      const event = {
        type: "planner.requested",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { iteration: 3 },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("iteration 3");
    });

    it("formats planner.plan_received with goal and step count", () => {
      const event = {
        type: "planner.plan_received",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { goal: "List files", step_count: 2 },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("List files");
      expect(result).toContain("2 steps");
    });

    it("formats plan.accepted with step list", () => {
      const event = {
        type: "plan.accepted",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {
          plan: {
            steps: [
              { tool: "read-file", description: "Read input" },
              { tool: "write-file", description: "Write output" },
            ],
          },
        },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("read-file");
      expect(result).toContain("write-file");
      expect(result).toContain("Read input");
    });

    it("suppresses plan.accepted with empty steps", () => {
      const event = {
        type: "plan.accepted",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { plan: { steps: [] } },
      };
      expect(formatEvent(sid, event)).toBeNull();
    });

    it("suppresses plan.replaced", () => {
      const event = {
        type: "plan.replaced",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { previous_plan_id: "a", new_plan_id: "b" },
      };
      expect(formatEvent(sid, event)).toBeNull();
    });
  });

  describe("steps", () => {
    it("formats step.started with tool and title", () => {
      const event = {
        type: "step.started",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { tool: "shell-exec", title: "Run ls command" },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("shell-exec");
      expect(result).toContain("Run ls command");
    });

    it("formats step.succeeded with string output", () => {
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T12:34:56.000Z",
        payload: { output: "hello world" },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("step.succeeded");
      expect(result).toContain("hello world");
      expect(result).toContain("12:34:56");
    });

    it("formats step.succeeded with shell exec output (extracts stdout)", () => {
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { output: { exit_code: 0, stdout: "file1.txt\nfile2.txt\n", stderr: "" } },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("file1.txt");
      expect(result).not.toContain("exit_code");
      expect(result).not.toContain("stderr");
    });

    it("formats step.succeeded with file content output", () => {
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { output: { content: "file contents here", exists: true, size: 18 } },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("file contents here");
      expect(result).not.toContain("exists");
    });

    it("formats step.succeeded shows stderr in red", () => {
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { output: { exit_code: 0, stdout: "ok", stderr: "warning!" } },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("ok");
      expect(result).toContain("warning!");
    });

    it("formats step.failed with error", () => {
      const event = {
        type: "step.failed",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { error: { code: "TIMEOUT", message: "timed out" } },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("step.failed");
      expect(result).toContain("TIMEOUT");
      expect(result).toContain("timed out");
    });
  });

  describe("tools", () => {
    it("formats tool.started with name and mode", () => {
      const event = {
        type: "tool.started",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { tool_name: "shell-exec", mode: "live" },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("shell-exec");
      expect(result).toContain("live");
    });

    it("formats tool.succeeded with name and duration", () => {
      const event = {
        type: "tool.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { tool_name: "read-file", duration_ms: 1500 },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("read-file");
      expect(result).toContain("1.5s");
    });

    it("formats tool.failed with name in red", () => {
      const event = {
        type: "tool.failed",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { tool_name: "http-request" },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("http-request");
    });
  });

  describe("permissions", () => {
    it("formats permission.requested with tool and scopes", () => {
      const event = {
        type: "permission.requested",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {
          tool_name: "shell-exec",
          permissions: [{ scope: "shell:exec:*" }],
        },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("shell-exec");
      expect(result).toContain("shell:exec:*");
    });

    it("formats permission.requested with non-array permissions", () => {
      const event = {
        type: "permission.requested",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {
          tool_name: "write-file",
          permissions: "fs:write:*",
        },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("write-file");
      expect(result).toContain("Scopes:");
    });

    it("suppresses permission.granted", () => {
      const event = {
        type: "permission.granted",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { tool_name: "read-file", decision: "allow_once" },
      };
      expect(formatEvent(sid, event)).toBeNull();
    });
  });

  describe("quiet events", () => {
    it("suppresses usage.recorded", () => {
      const event = {
        type: "usage.recorded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { input_tokens: 100 },
      };
      expect(formatEvent(sid, event)).toBeNull();
    });

    it("suppresses session.checkpoint", () => {
      const event = {
        type: "session.checkpoint",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { completed_step_ids: ["s1"] },
      };
      expect(formatEvent(sid, event)).toBeNull();
    });

    it("suppresses tool.requested", () => {
      const event = {
        type: "tool.requested",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { tool_name: "shell-exec" },
      };
      expect(formatEvent(sid, event)).toBeNull();
    });
  });

  describe("browser output formatting", () => {
    it("formats browser success with url and title", () => {
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {
          output: {
            success: true,
            url: "https://example.com",
            title: "Example Page",
          },
        },
      };
      const result = formatEvent(sid, event)!;
      expect(result).toContain("https://example.com");
      expect(result).toContain("Example Page");
    });

    it("formats browser failure with error", () => {
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {
          output: {
            success: false,
            error: "Navigation timeout",
          },
        },
      };
      const result = formatEvent(sid, event)!;
      expect(result).toContain("Navigation timeout");
    });

    it("formats browser success with text content", () => {
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {
          output: {
            success: true,
            text: "Page content here",
          },
        },
      };
      const result = formatEvent(sid, event)!;
      expect(result).toContain("Page content here");
    });

    it("formats browser success with short snapshot", () => {
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {
          output: {
            success: true,
            snapshot: "Short snapshot text",
          },
        },
      };
      const result = formatEvent(sid, event)!;
      expect(result).toContain("Snapshot:");
      expect(result).toContain("Short snapshot text");
    });

    it("formats browser success with long snapshot (truncated)", () => {
      const longSnapshot = "x".repeat(1000);
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {
          output: {
            success: true,
            snapshot: longSnapshot,
          },
        },
      };
      const result = formatEvent(sid, event)!;
      expect(result).toContain("Snapshot:");
      expect(result).toContain("1000 chars");
    });

    it("formats browser success with array result (with titles)", () => {
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {
          output: {
            success: true,
            result: [
              { title: "Item 1", rank: 1, points: 100 },
              { title: "Item 2", rank: 2 },
            ],
          },
        },
      };
      const result = formatEvent(sid, event)!;
      expect(result).toContain("Item 1");
      expect(result).toContain("Item 2");
      expect(result).toContain("100");
    });

    it("formats browser success with array result (without titles)", () => {
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {
          output: {
            success: true,
            result: [
              { data: "raw data" },
            ],
          },
        },
      };
      const result = formatEvent(sid, event)!;
      expect(result).toContain("raw data");
    });

    it("formats browser success with non-array result", () => {
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {
          output: {
            success: true,
            result: "plain text result",
          },
        },
      };
      const result = formatEvent(sid, event)!;
      expect(result).toContain("plain text result");
    });

    it("formats browser success with no parts (falls through to JSON)", () => {
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {
          output: {
            success: true,
          },
        },
      };
      const result = formatEvent(sid, event)!;
      // No url, title, text, snapshot, or result — falls through to JSON
      expect(result).toContain("step.succeeded");
    });

    it("formats step.succeeded with empty stdout (shows no output)", () => {
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { output: { exit_code: 0, stdout: "", stderr: "" } },
      };
      const result = formatEvent(sid, event)!;
      expect(result).toContain("(no output)");
    });

    it("formats step.succeeded with non-object non-string output", () => {
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { output: 42 },
      };
      const result = formatEvent(sid, event)!;
      expect(result).toContain("42");
    });

    it("formats step.succeeded with null output", () => {
      const event = {
        type: "step.succeeded",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { output: null },
      };
      // output is null so step.succeeded with null output should still show something
      const result = formatEvent(sid, event);
      // payload.output is null, so the condition payload?.output != null is false
      // This means it falls through to the generic branch
      expect(result).not.toBeNull();
    });
  });

  describe("plan.accepted edge cases", () => {
    it("formats plan.accepted with tool_ref style steps", () => {
      const event = {
        type: "plan.accepted",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {
          plan: {
            steps: [
              { tool_ref: { name: "read-file" }, title: "Read a file" },
              { tool_ref: { name: "write-file" }, title: "Write output" },
            ],
          },
        },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("read-file");
      expect(result).toContain("write-file");
      expect(result).toContain("Read a file");
    });

    it("formats plan.accepted without plan object", () => {
      const event = {
        type: "plan.accepted",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {},
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("plan.accepted");
    });
  });

  describe("session.failed edge cases", () => {
    it("formats session.failed without error object", () => {
      const event = {
        type: "session.failed",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {},
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("Session failed");
      expect(result).toContain("unknown error");
    });
  });

  describe("missing timestamp", () => {
    it("handles missing timestamp gracefully", () => {
      const event = {
        type: "session.completed",
        payload: {},
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("Session completed");
    });
  });

  describe("generic fallback", () => {
    it("shows unknown event types with truncated payload", () => {
      const event = {
        type: "custom.event",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: { data: "some value" },
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("custom.event");
      expect(result).toContain("some value");
    });

    it("shows type only for empty payload unknown events", () => {
      const event = {
        type: "custom.empty",
        timestamp: "2025-01-01T00:00:00.000Z",
        payload: {},
      };
      const result = formatEvent(sid, event);
      expect(result).toContain("custom.empty");
    });
  });
});

describe("TERMINAL_EVENTS", () => {
  it("includes session.completed, session.failed, session.aborted", () => {
    expect(TERMINAL_EVENTS.has("session.completed")).toBe(true);
    expect(TERMINAL_EVENTS.has("session.failed")).toBe(true);
    expect(TERMINAL_EVENTS.has("session.aborted")).toBe(true);
  });

  it("does not include non-terminal events", () => {
    expect(TERMINAL_EVENTS.has("session.created")).toBe(false);
  });
});

describe("helpText", () => {
  it("contains /help, /abort, /quit", () => {
    const text = helpText();
    expect(text).toContain("/help");
    expect(text).toContain("/abort");
    expect(text).toContain("/quit");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import {
  StatusBar,
  formatTokens,
  shortenModel,
  formatCost,
  type StatusBarWriter,
} from "./status-bar.js";

// ─── Mock Writer ─────────────────────────────────────────────────

class MockStatusBarWriter implements StatusBarWriter {
  written: string[] = [];
  rows = 24;
  cols = 80;

  write(data: string): void {
    this.written.push(data);
  }
  getSize(): { rows: number; cols: number } {
    return { rows: this.rows, cols: this.cols };
  }

  /** Join all written data for assertion convenience. */
  output(): string {
    return this.written.join("");
  }

  reset(): void {
    this.written = [];
  }
}

// ─── Pure formatting helpers ─────────────────────────────────────

describe("formatTokens", () => {
  it("returns raw number for small values", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands as k", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(15432)).toBe("15.4k");
    expect(formatTokens(999999)).toBe("1000.0k");
  });

  it("formats millions as M", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

describe("shortenModel", () => {
  it("strips date suffix from Claude models", () => {
    expect(shortenModel("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
  });

  it("strips date suffix from OpenAI models", () => {
    expect(shortenModel("gpt-4o-20241120")).toBe("gpt-4o");
  });

  it("leaves short model names unchanged", () => {
    expect(shortenModel("gpt-4o")).toBe("gpt-4o");
    expect(shortenModel("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });

  it("only strips 8+ digit suffixes", () => {
    expect(shortenModel("model-1234567")).toBe("model-1234567");
    expect(shortenModel("model-12345678")).toBe("model");
  });
});

describe("formatCost", () => {
  it("formats zero", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("formats small costs with 4 decimal places", () => {
    expect(formatCost(0.0012)).toBe("$0.0012");
    expect(formatCost(0.005)).toBe("$0.0050");
  });

  it("formats normal costs with 2 decimal places", () => {
    expect(formatCost(0.03)).toBe("$0.03");
    expect(formatCost(1.5)).toBe("$1.50");
  });
});

// ─── StatusBar class ─────────────────────────────────────────────

describe("StatusBar", () => {
  let writer: MockStatusBarWriter;

  beforeEach(() => {
    writer = new MockStatusBarWriter();
  });

  describe("setup", () => {
    it("sets scroll region and repaints", () => {
      const bar = new StatusBar(writer);
      bar.setup();
      expect(bar.isActive).toBe(true);
      const out = writer.output();
      // Should contain scroll region escape: \x1b[1;22r (24 - 2 = 22)
      expect(out).toContain("\x1b[1;22r");
      // Should contain reverse video for status lines
      expect(out).toContain("\x1b[7m");
    });

    it("does not activate when terminal is too small", () => {
      writer.rows = 4;
      const bar = new StatusBar(writer);
      bar.setup();
      expect(bar.isActive).toBe(false);
      expect(writer.written.length).toBe(0);
    });

    it("works at minimum size (5 rows)", () => {
      writer.rows = 5;
      const bar = new StatusBar(writer);
      bar.setup();
      expect(bar.isActive).toBe(true);
      const out = writer.output();
      // Scroll region: 1 to 3 (5 - 2 = 3)
      expect(out).toContain("\x1b[1;3r");
    });
  });

  describe("teardown", () => {
    it("resets scroll region and clears status lines", () => {
      const bar = new StatusBar(writer);
      bar.setup();
      writer.reset();
      bar.teardown();
      expect(bar.isActive).toBe(false);
      const out = writer.output();
      // Reset scroll region
      expect(out).toContain("\x1b[r");
      // Clear status lines (rows 23 and 24)
      expect(out).toContain("\x1b[23;1H");
      expect(out).toContain("\x1b[24;1H");
      expect(out).toContain("\x1b[K");
    });

    it("is a no-op when not active", () => {
      const bar = new StatusBar(writer);
      bar.teardown();
      expect(writer.written.length).toBe(0);
    });
  });

  describe("update", () => {
    it("merges data and triggers repaint", () => {
      const bar = new StatusBar(writer, { wsUrl: "ws://localhost:3100/api/ws" });
      bar.setup();
      writer.reset();
      bar.update({ connection: "connected", sessionState: "running", sessionId: "abc123def456" });
      const out = writer.output();
      // Should contain save + move + content + restore
      expect(out).toContain("\x1b7"); // save
      expect(out).toContain("\x1b8"); // restore
      // Should show "connected | running" on line 1
      expect(out).toContain("connected | running");
    });

    it("does not repaint when not active", () => {
      const bar = new StatusBar(writer);
      // Not setup, not active
      bar.update({ connection: "connected" });
      expect(writer.written.length).toBe(0);
    });
  });

  describe("repaint content", () => {
    it("shows connection and session state on line 1", () => {
      const bar = new StatusBar(writer, { connection: "connected", sessionState: "idle" });
      bar.setup();
      const out = writer.output();
      expect(out).toContain("connected | idle");
    });

    it("shows wsUrl and mode when idle", () => {
      const bar = new StatusBar(writer, {
        connection: "connected",
        sessionState: "idle",
        wsUrl: "ws://localhost:3100/api/ws",
        mode: "live",
      });
      bar.setup();
      const out = writer.output();
      expect(out).toContain("ws://localhost:3100/api/ws");
      expect(out).toContain("live");
    });

    it("strips token from wsUrl in display", () => {
      const bar = new StatusBar(writer, {
        sessionState: "idle",
        wsUrl: "ws://localhost:3100/api/ws?token=secret123",
        mode: "live",
      });
      bar.setup();
      const out = writer.output();
      expect(out).not.toContain("secret123");
      expect(out).toContain("ws://localhost:3100/api/ws");
    });

    it("shows session info when running", () => {
      const bar = new StatusBar(writer, {
        connection: "connected",
        sessionState: "running",
        sessionId: "abcdef123456789",
        model: "claude-sonnet-4-5-20250929",
        mode: "live",
        totalTokens: 15432,
        costUsd: 0.03,
      });
      bar.setup();
      const out = writer.output();
      // Shortened session ID
      expect(out).toContain("abc..789");
      // Shortened model
      expect(out).toContain("claude-sonnet-4-5");
      // Formatted tokens
      expect(out).toContain("tokens 15.4k");
      // Formatted cost
      expect(out).toContain("$0.03");
    });

    it("omits tokens and cost when zero", () => {
      const bar = new StatusBar(writer, {
        sessionState: "running",
        sessionId: "s1",
        model: "gpt-4o",
        mode: "mock",
        totalTokens: 0,
        costUsd: 0,
      });
      bar.setup();
      const out = writer.output();
      expect(out).not.toContain("tokens");
      expect(out).not.toContain("$");
    });
  });

  describe("onResize", () => {
    it("re-establishes scroll region with new dimensions", () => {
      const bar = new StatusBar(writer);
      bar.setup();
      writer.reset();
      writer.rows = 30;
      bar.onResize();
      const out = writer.output();
      // New scroll region: 1 to 28 (30 - 2)
      expect(out).toContain("\x1b[1;28r");
    });

    it("disables if terminal becomes too small", () => {
      const bar = new StatusBar(writer);
      bar.setup();
      expect(bar.isActive).toBe(true);
      writer.reset();
      writer.rows = 3;
      bar.onResize();
      expect(bar.isActive).toBe(false);
      const out = writer.output();
      // Should reset scroll region
      expect(out).toContain("\x1b[r");
    });

    it("is a no-op when not active", () => {
      const bar = new StatusBar(writer);
      bar.onResize();
      expect(writer.written.length).toBe(0);
    });
  });
});

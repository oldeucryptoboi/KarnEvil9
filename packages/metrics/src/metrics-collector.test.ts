import { describe, it, expect, beforeEach } from "vitest";
import { Registry } from "prom-client";
import { MetricsCollector } from "./metrics-collector.js";
import type { JournalEvent } from "@karnevil9/schemas";

function makeEvent(
  type: JournalEvent["type"],
  payload: Record<string, unknown> = {},
  overrides: Partial<JournalEvent> = {}
): JournalEvent {
  return {
    event_id: "evt-1",
    timestamp: new Date().toISOString(),
    session_id: "sess-1",
    type,
    payload,
    ...overrides,
  };
}

describe("MetricsCollector", () => {
  let collector: MetricsCollector;
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
    collector = new MetricsCollector({ registry, collectDefault: false });
  });

  // ─── Session Metrics ─────────────────────────────────────────────

  describe("session metrics", () => {
    it("increments sessions_total on session.created", async () => {
      collector.handleEvent(makeEvent("session.created"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_sessions_total");
      expect(metrics).toContain('status="created"');
      expect(metrics).toContain(" 1");
    });

    it("increments sessions_active on session.created", async () => {
      collector.handleEvent(makeEvent("session.created"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_sessions_active");
      expect(metrics).toContain(" 1");
    });

    it("decrements sessions_active on terminal events", async () => {
      collector.handleEvent(makeEvent("session.created"));
      collector.handleEvent(makeEvent("session.completed"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_sessions_active");
      expect(metrics).toContain(" 0");
    });

    it("tracks failed sessions", async () => {
      collector.handleEvent(makeEvent("session.created"));
      collector.handleEvent(makeEvent("session.failed"));
      const totalMetrics = await registry.getSingleMetricAsString("karnevil9_sessions_total");
      expect(totalMetrics).toContain('status="failed"');
    });

    it("tracks aborted sessions", async () => {
      collector.handleEvent(makeEvent("session.created"));
      collector.handleEvent(makeEvent("session.aborted"));
      const totalMetrics = await registry.getSingleMetricAsString("karnevil9_sessions_total");
      expect(totalMetrics).toContain('status="aborted"');
    });
  });

  // ─── Step Metrics ────────────────────────────────────────────────

  describe("step metrics", () => {
    it("tracks step.started with tool name from tool_ref", async () => {
      collector.handleEvent(
        makeEvent("step.started", {
          step_id: "step-1",
          tool_ref: { name: "readFile" },
        })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_steps_total");
      expect(metrics).toContain('tool_name="readFile"');
      expect(metrics).toContain('status="started"');
    });

    it("tracks step.succeeded with tool name from step.started", async () => {
      collector.handleEvent(
        makeEvent("step.started", { step_id: "step-1", tool_name: "shellExec" })
      );
      collector.handleEvent(
        makeEvent("step.succeeded", { step_id: "step-1" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_steps_total");
      expect(metrics).toContain('status="succeeded"');
      expect(metrics).toContain('tool_name="shellExec"');
    });

    it("falls back to unknown when step_id not tracked", async () => {
      collector.handleEvent(makeEvent("step.failed", { step_id: "step-999" }));
      const metrics = await registry.getSingleMetricAsString("karnevil9_steps_total");
      expect(metrics).toContain('tool_name="unknown"');
    });

    it("carries tool name from step.started (bare tool key) through to step.succeeded", async () => {
      collector.handleEvent(
        makeEvent("step.started", { step_id: "s-carry", tool: "read-file" })
      );
      collector.handleEvent(
        makeEvent("step.succeeded", { step_id: "s-carry" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_steps_total");
      expect(metrics).toContain('status="succeeded"');
      expect(metrics).toContain('tool_name="read-file"');
    });

    it("cleans up stepToolNames after step completion", async () => {
      collector.handleEvent(
        makeEvent("step.started", { step_id: "s-cleanup", tool_name: "shellExec" })
      );
      collector.handleEvent(
        makeEvent("step.succeeded", { step_id: "s-cleanup" })
      );
      // A second step.failed with the same step_id should fall back to unknown
      collector.handleEvent(
        makeEvent("step.failed", { step_id: "s-cleanup" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_steps_total");
      expect(metrics).toContain('status="failed"');
      expect(metrics).toContain('tool_name="unknown"');
    });
  });

  // ─── Tool Metrics ────────────────────────────────────────────────

  describe("tool metrics", () => {
    it("tracks tool.succeeded with duration", async () => {
      collector.handleEvent(
        makeEvent("tool.succeeded", { tool_name: "readFile", duration_ms: 150 })
      );

      const execMetrics = await registry.getSingleMetricAsString("karnevil9_tool_executions_total");
      expect(execMetrics).toContain('tool_name="readFile"');
      expect(execMetrics).toContain('status="succeeded"');

      const durMetrics = await registry.getSingleMetricAsString("karnevil9_tool_duration_seconds");
      expect(durMetrics).toContain('tool_name="readFile"');
      // 150ms = 0.15s should be in the 0.25 bucket
      expect(durMetrics).toContain("le=\"0.25\"");
    });

    it("tracks tool.failed with status and duration", async () => {
      collector.handleEvent(
        makeEvent("tool.failed", { tool_name: "writeFile", duration_ms: 5000 })
      );
      const execMetrics = await registry.getSingleMetricAsString("karnevil9_tool_executions_total");
      expect(execMetrics).toContain('status="failed"');

      const durMetrics = await registry.getSingleMetricAsString("karnevil9_tool_duration_seconds");
      expect(durMetrics).toContain('tool_name="writeFile"');
      // 5000ms = 5s should be in the 5 bucket
      expect(durMetrics).toContain("le=\"5\"");
    });
  });

  // ─── Token & Cost Metrics ────────────────────────────────────────

  describe("token & cost metrics", () => {
    it("tracks usage.recorded with input/output tokens and cost", async () => {
      collector.handleEvent(
        makeEvent("usage.recorded", {
          model: "claude-3-opus",
          input_tokens: 1000,
          output_tokens: 500,
          cost_usd: 0.05,
        })
      );

      const tokenMetrics = await registry.getSingleMetricAsString("karnevil9_tokens_total");
      expect(tokenMetrics).toContain('model="claude-3-opus"');
      expect(tokenMetrics).toContain('type="input"');
      expect(tokenMetrics).toContain('type="output"');

      const costMetrics = await registry.getSingleMetricAsString("karnevil9_cost_usd_total");
      expect(costMetrics).toContain('model="claude-3-opus"');
      expect(costMetrics).toContain("0.05");
    });

    it("uses unknown model when not provided", async () => {
      collector.handleEvent(makeEvent("usage.recorded", { input_tokens: 100 }));
      const metrics = await registry.getSingleMetricAsString("karnevil9_tokens_total");
      expect(metrics).toContain('model="unknown"');
    });
  });

  // ─── Planner Metrics ─────────────────────────────────────────────

  describe("planner metrics", () => {
    it("tracks planner call with duration", async () => {
      const startTime = new Date("2025-01-01T00:00:00.000Z");
      const endTime = new Date("2025-01-01T00:00:05.000Z");

      collector.handleEvent(
        makeEvent("planner.requested", {}, { timestamp: startTime.toISOString() })
      );
      collector.handleEvent(
        makeEvent("planner.plan_received", {}, { timestamp: endTime.toISOString() })
      );

      const callMetrics = await registry.getSingleMetricAsString("karnevil9_planner_calls_total");
      expect(callMetrics).toContain('status="accepted"');

      const durMetrics = await registry.getSingleMetricAsString("karnevil9_planner_duration_seconds");
      // 5 seconds
      expect(durMetrics).toContain("le=\"5\"");
    });

    it("tracks rejected planner calls", async () => {
      collector.handleEvent(
        makeEvent("planner.requested", {}, { timestamp: "2025-01-01T00:00:00.000Z" })
      );
      collector.handleEvent(
        makeEvent("planner.plan_rejected", {}, { timestamp: "2025-01-01T00:00:02.000Z" })
      );

      const metrics = await registry.getSingleMetricAsString("karnevil9_planner_calls_total");
      expect(metrics).toContain('status="rejected"');
    });

    it("handles plan_rejected without preceding planner.requested (no planner configured)", async () => {
      // Kernel emits plan_rejected before planner.requested when no planner is set
      collector.handleEvent(
        makeEvent("planner.plan_rejected", {}, { timestamp: "2025-01-01T00:00:01.000Z" })
      );

      const callMetrics = await registry.getSingleMetricAsString("karnevil9_planner_calls_total");
      expect(callMetrics).toContain('status="rejected"');

      // Duration should have zero observations (no start time available)
      const durMetrics = await registry.getSingleMetricAsString("karnevil9_planner_duration_seconds");
      expect(durMetrics).toContain("karnevil9_planner_duration_seconds_count 0");
    });
  });

  // ─── Permission Metrics ──────────────────────────────────────────

  describe("permission metrics", () => {
    it("tracks permission lifecycle", async () => {
      collector.handleEvent(makeEvent("permission.requested"));
      collector.handleEvent(makeEvent("permission.granted"));
      collector.handleEvent(makeEvent("permission.denied"));

      const metrics = await registry.getSingleMetricAsString("karnevil9_permission_decisions_total");
      expect(metrics).toContain('decision="requested"');
      expect(metrics).toContain('decision="allowed"');
      expect(metrics).toContain('decision="denied"');
    });
  });

  // ─── Safety Metrics ──────────────────────────────────────────────

  describe("safety metrics", () => {
    it("tracks circuit breaker open/close", async () => {
      collector.handleEvent(
        makeEvent("plugin.hook_circuit_open", { plugin_id: "my-plugin" })
      );
      let metrics = await registry.getSingleMetricAsString("karnevil9_circuit_breaker_open");
      expect(metrics).toContain('plugin_id="my-plugin"');
      expect(metrics).toContain(" 1");

      collector.handleEvent(
        makeEvent("plugin.hook_fired", { plugin_id: "my-plugin" })
      );
      metrics = await registry.getSingleMetricAsString("karnevil9_circuit_breaker_open");
      expect(metrics).toContain(" 0");
    });

    it("tracks futility detection", async () => {
      collector.handleEvent(makeEvent("futility.detected"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_futility_detected_total");
      expect(metrics).toContain(" 1");
    });

    it("tracks context budget assessments", async () => {
      collector.handleEvent(
        makeEvent("context.budget_assessed", { verdict: "within_budget" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_context_budget_assessments_total");
      expect(metrics).toContain('verdict="within_budget"');
    });
  });

  // ─── Limit & Policy Metrics ──────────────────────────────────────

  describe("limit & policy metrics", () => {
    it("tracks limit.exceeded by limit type", async () => {
      collector.handleEvent(
        makeEvent("limit.exceeded", { limit: "max_duration_ms", value: 300000, actual: 305000 })
      );
      collector.handleEvent(
        makeEvent("limit.exceeded", { limit: "max_tokens", value: 100000, actual: 110000 })
      );
      collector.handleEvent(
        makeEvent("limit.exceeded", { limit: "max_cost_usd", value: 10, actual: 12 })
      );
      collector.handleEvent(
        makeEvent("limit.exceeded", { limit: "max_steps", value: 20, actual: 25 })
      );
      collector.handleEvent(
        makeEvent("limit.exceeded", { limit: "max_iterations", value: 5 })
      );

      const metrics = await registry.getSingleMetricAsString("karnevil9_limits_exceeded_total");
      expect(metrics).toContain('limit="max_duration_ms"');
      expect(metrics).toContain('limit="max_tokens"');
      expect(metrics).toContain('limit="max_cost_usd"');
      expect(metrics).toContain('limit="max_steps"');
      expect(metrics).toContain('limit="max_iterations"');
    });

    it("tracks policy.violated by tool name", async () => {
      collector.handleEvent(
        makeEvent("policy.violated", {
          tool_name: "shell-exec",
          violation_code: "POLICY_VIOLATION",
          violation_message: "Command not allowed",
        })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_policy_violations_total");
      expect(metrics).toContain('tool_name="shell-exec"');
      expect(metrics).toContain(" 1");
    });
  });

  // ─── Plugin Metrics ──────────────────────────────────────────────

  describe("plugin metrics", () => {
    it("tracks plugin loaded/unloaded", async () => {
      collector.handleEvent(makeEvent("plugin.loaded", { plugin_id: "logger" }));
      let metrics = await registry.getSingleMetricAsString("karnevil9_plugins_status");
      expect(metrics).toContain('plugin_id="logger"');
      expect(metrics).toContain('status="active"');

      collector.handleEvent(makeEvent("plugin.unloaded", { plugin_id: "logger" }));
      metrics = await registry.getSingleMetricAsString("karnevil9_plugins_status");
      // active should now be 0
      expect(metrics).toContain('status="active"');
    });

    it("tracks plugin failure", async () => {
      collector.handleEvent(makeEvent("plugin.failed", { plugin_id: "broken" }));
      const metrics = await registry.getSingleMetricAsString("karnevil9_plugins_status");
      expect(metrics).toContain('status="failed"');
    });
  });

  // ─── Journal Disk Metrics ─────────────────────────────────────────

  describe("journal disk metrics", () => {
    it("tracks journal.disk_warning with usage_pct", async () => {
      collector.handleEvent(
        makeEvent("journal.disk_warning", { usage_pct: 88, threshold: 85 })
      );
      const gaugeMetrics = await registry.getSingleMetricAsString("karnevil9_journal_disk_usage_pct");
      expect(gaugeMetrics).toContain("88");

      const counterMetrics = await registry.getSingleMetricAsString("karnevil9_journal_disk_warnings_total");
      expect(counterMetrics).toContain(" 1");
    });

    it("increments warning counter on multiple warnings", async () => {
      collector.handleEvent(makeEvent("journal.disk_warning", { usage_pct: 86 }));
      collector.handleEvent(makeEvent("journal.disk_warning", { usage_pct: 90 }));

      const counterMetrics = await registry.getSingleMetricAsString("karnevil9_journal_disk_warnings_total");
      expect(counterMetrics).toContain(" 2");

      const gaugeMetrics = await registry.getSingleMetricAsString("karnevil9_journal_disk_usage_pct");
      expect(gaugeMetrics).toContain("90");
    });
  });

  // ─── Utility Methods ─────────────────────────────────────────────

  describe("utility methods", () => {
    it("getMetrics returns Prometheus exposition format", async () => {
      collector.handleEvent(makeEvent("session.created"));
      const output = await collector.getMetrics();
      expect(output).toContain("# HELP karnevil9_sessions_total");
      expect(output).toContain("# TYPE karnevil9_sessions_total counter");
    });

    it("getContentType returns prometheus content type", () => {
      const contentType = collector.getContentType();
      expect(contentType).toContain("text/plain");
    });

    it("reset clears all metrics", async () => {
      collector.handleEvent(makeEvent("session.created"));
      collector.reset();
      const output = await collector.getMetrics();
      // After reset, counter values should be 0 (no labeled series remain)
      expect(output).not.toContain('status="created"');
    });

    it("handles unknown event types gracefully", () => {
      // Should not throw
      collector.handleEvent(makeEvent("session.started" as JournalEvent["type"]));
    });
  });

  // ─── Edge Cases ──────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles tool events without duration_ms", async () => {
      collector.handleEvent(makeEvent("tool.succeeded", { tool_name: "readFile" }));
      const metrics = await registry.getSingleMetricAsString("karnevil9_tool_executions_total");
      expect(metrics).toContain('tool_name="readFile"');
    });

    it("handles step.started with bare tool key (kernel format)", async () => {
      collector.handleEvent(
        makeEvent("step.started", {
          step_id: "s-bare",
          tool: "read-file",
        })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_steps_total");
      expect(metrics).toContain('tool_name="read-file"');
    });

    it("handles step.started with nested step.tool_ref", async () => {
      collector.handleEvent(
        makeEvent("step.started", {
          step_id: "s-1",
          step: { tool_ref: { name: "httpRequest" } },
        })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_steps_total");
      expect(metrics).toContain('tool_name="httpRequest"');
    });

    it("handles multiple sessions independently for planner duration", async () => {
      collector.handleEvent(
        makeEvent("planner.requested", {}, {
          session_id: "sess-a",
          timestamp: "2025-01-01T00:00:00.000Z",
        })
      );
      collector.handleEvent(
        makeEvent("planner.requested", {}, {
          session_id: "sess-b",
          timestamp: "2025-01-01T00:00:01.000Z",
        })
      );
      collector.handleEvent(
        makeEvent("planner.plan_received", {}, {
          session_id: "sess-a",
          timestamp: "2025-01-01T00:00:03.000Z",
        })
      );
      collector.handleEvent(
        makeEvent("planner.plan_received", {}, {
          session_id: "sess-b",
          timestamp: "2025-01-01T00:00:04.000Z",
        })
      );

      const metrics = await registry.getSingleMetricAsString("karnevil9_planner_duration_seconds");
      // Both observations should be recorded (3s and 3s)
      expect(metrics).toContain("karnevil9_planner_duration_seconds_count 2");
    });

    it("cleans up planner start times on session terminal events", () => {
      collector.handleEvent(
        makeEvent("planner.requested", {}, { session_id: "sess-cleanup" })
      );
      collector.handleEvent(
        makeEvent("session.completed", {}, { session_id: "sess-cleanup" })
      );
      // Internal state should be cleaned up — no way to directly verify,
      // but the session.completed should not throw
    });
  });

  // ─── Swarm Reoptimization Safety ────────────────────────────────

  describe("swarm reoptimization safety", () => {
    it("skips __proto__/constructor/prototype keys in actions payload", async () => {
      collector.handleEvent(
        makeEvent("swarm.reoptimization_triggered", {
          actions: {
            __proto__: 5,
            constructor: 3,
            prototype: 2,
            redelegate: 1,
          },
        })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_reoptimizations_total");
      expect(metrics).toContain('action="redelegate"');
      expect(metrics).not.toContain('action="__proto__"');
      expect(metrics).not.toContain('action="constructor"');
      expect(metrics).not.toContain('action="prototype"');
      // Verify Object.prototype was not polluted
      expect(({} as any).polluted).toBeUndefined();
    });

    it("caps action entries to prevent label cardinality explosion", async () => {
      const actions: Record<string, number> = {};
      for (let i = 0; i < 100; i++) {
        actions[`action_${i}`] = 1;
      }
      // Should not throw and should cap at 50 entries
      collector.handleEvent(
        makeEvent("swarm.reoptimization_triggered", { actions })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_reoptimizations_total");
      // Count unique action labels — should be at most 50
      const actionMatches = metrics.match(/action="action_\d+"/g) ?? [];
      expect(actionMatches.length).toBeLessThanOrEqual(50);
    });

    it("skips non-number counts in actions payload", async () => {
      collector.handleEvent(
        makeEvent("swarm.reoptimization_triggered", {
          actions: {
            redelegate: 1,
            bad_count: "not_a_number",
            negative: -1,
          },
        })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_reoptimizations_total");
      expect(metrics).toContain('action="redelegate"');
      // non-number and negative should be skipped
    });
  });

  // ─── Label Sanitization ─────────────────────────────────────────

  describe("label sanitization", () => {
    it("truncates long tool_name labels to prevent cardinality bomb", async () => {
      const longName = "a".repeat(200);
      collector.handleEvent(
        makeEvent("tool.succeeded", { tool_name: longName, duration_ms: 10 })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_tool_executions_total");
      // Should be truncated to 64 chars
      expect(metrics).toContain("a".repeat(64));
      expect(metrics).not.toContain("a".repeat(65));
    });

    it("replaces special characters in label values", async () => {
      collector.handleEvent(
        makeEvent("tool.succeeded", { tool_name: "evil\ntool\x00name", duration_ms: 10 })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_tool_executions_total");
      expect(metrics).toContain("evil_tool_name");
    });

    it("sanitizes peer_node_id in swarm events", async () => {
      const maliciousId = "peer\x00injected" + "x".repeat(200);
      collector.handleEvent(
        makeEvent("swarm.reputation_updated", { peer_node_id: maliciousId, trust_score: 0.5 })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_trust_score");
      // Null byte replaced and length truncated to 64 chars
      expect(metrics).toContain("peer_injected");
      expect(metrics).not.toContain("x".repeat(200));
    });

    it("sanitizes plugin_id in plugin events", async () => {
      collector.handleEvent(
        makeEvent("plugin.loaded", { plugin_id: "bad<script>alert(1)</script>" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_plugins_status");
      expect(metrics).not.toContain("<script>");
      expect(metrics).toContain("bad_script_");
    });
  });
});

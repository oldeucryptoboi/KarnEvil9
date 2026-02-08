import { describe, it, expect } from "vitest";
import { UsageAccumulator } from "./usage-accumulator.js";
import type { UsageMetrics } from "@openvger/schemas";

describe("UsageAccumulator", () => {
  it("starts at zero", () => {
    const acc = new UsageAccumulator();
    expect(acc.totalTokens).toBe(0);
    expect(acc.totalCostUsd).toBe(0);
    const summary = acc.getSummary();
    expect(summary.total_tokens).toBe(0);
    expect(summary.call_count).toBe(0);
  });

  it("accumulates token counts across multiple records", () => {
    const acc = new UsageAccumulator();
    acc.record({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
    acc.record({ input_tokens: 200, output_tokens: 100, total_tokens: 300 });

    expect(acc.totalTokens).toBe(450);
    const summary = acc.getSummary();
    expect(summary.total_input_tokens).toBe(300);
    expect(summary.total_output_tokens).toBe(150);
    expect(summary.total_tokens).toBe(450);
    expect(summary.call_count).toBe(2);
  });

  it("uses cost_usd from usage when provided", () => {
    const acc = new UsageAccumulator();
    acc.record({ input_tokens: 100, output_tokens: 50, total_tokens: 150, cost_usd: 0.05 });
    acc.record({ input_tokens: 200, output_tokens: 100, total_tokens: 300, cost_usd: 0.10 });

    expect(acc.totalCostUsd).toBeCloseTo(0.15);
  });

  it("computes cost from pricing when cost_usd not provided", () => {
    const acc = new UsageAccumulator({
      input_cost_per_1k_tokens: 3.0,   // $3 per 1k input tokens
      output_cost_per_1k_tokens: 15.0,  // $15 per 1k output tokens
    });

    acc.record({ input_tokens: 1000, output_tokens: 500, total_tokens: 1500 });
    // Expected: (1000/1000)*3 + (500/1000)*15 = 3 + 7.5 = 10.5
    expect(acc.totalCostUsd).toBeCloseTo(10.5);
  });

  it("prefers cost_usd over pricing computation", () => {
    const acc = new UsageAccumulator({
      input_cost_per_1k_tokens: 3.0,
      output_cost_per_1k_tokens: 15.0,
    });

    acc.record({ input_tokens: 1000, output_tokens: 500, total_tokens: 1500, cost_usd: 1.0 });
    // Should use provided cost_usd, not computed
    expect(acc.totalCostUsd).toBeCloseTo(1.0);
  });

  it("does not compute cost when no pricing and no cost_usd", () => {
    const acc = new UsageAccumulator();
    acc.record({ input_tokens: 1000, output_tokens: 500, total_tokens: 1500 });
    expect(acc.totalCostUsd).toBe(0);
  });

  it("tracks model field without affecting accumulation", () => {
    const acc = new UsageAccumulator();
    acc.record({ input_tokens: 100, output_tokens: 50, total_tokens: 150, model: "claude-sonnet-4-5-20250929" });
    expect(acc.totalTokens).toBe(150);
  });

  it("getSummary returns consistent snapshot", () => {
    const acc = new UsageAccumulator({ input_cost_per_1k_tokens: 1.0, output_cost_per_1k_tokens: 2.0 });
    acc.record({ input_tokens: 500, output_tokens: 250, total_tokens: 750 });

    const s1 = acc.getSummary();
    const s2 = acc.getSummary();
    expect(s1).toEqual(s2);
    expect(s1.total_cost_usd).toBeCloseTo(0.5 + 0.5); // 500/1000*1 + 250/1000*2
  });
});

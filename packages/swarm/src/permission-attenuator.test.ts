import { describe, it, expect } from "vitest";
import { attenuateConstraints, validateTaskRequest } from "./permission-attenuator.js";

describe("attenuateConstraints", () => {
  it("should intersect tool_allowlists when both present", () => {
    const result = attenuateConstraints(
      { tool_allowlist: ["read-file", "write-file", "shell-exec"] },
      { tool_allowlist: ["read-file", "http-request"] },
      { max_duration_ms: 60000, max_tokens: 10000, max_cost_usd: 1.0 },
    );
    expect(result.tool_allowlist).toEqual(["read-file"]);
  });

  it("should use boundary allowlist when parent has none", () => {
    const result = attenuateConstraints(
      {},
      { tool_allowlist: ["read-file"] },
      { max_duration_ms: 60000, max_tokens: 10000, max_cost_usd: 1.0 },
    );
    expect(result.tool_allowlist).toEqual(["read-file"]);
  });

  it("should keep parent allowlist when boundary has none", () => {
    const result = attenuateConstraints(
      { tool_allowlist: ["read-file", "write-file"] },
      {},
      { max_duration_ms: 60000, max_tokens: 10000, max_cost_usd: 1.0 },
    );
    expect(result.tool_allowlist).toEqual(["read-file", "write-file"]);
  });

  it("should produce empty allowlist when intersection is empty", () => {
    const result = attenuateConstraints(
      { tool_allowlist: ["read-file"] },
      { tool_allowlist: ["shell-exec"] },
      { max_duration_ms: 60000, max_tokens: 10000, max_cost_usd: 1.0 },
    );
    expect(result.tool_allowlist).toEqual([]);
  });

  it("should take min of parent and SLO max_tokens", () => {
    const result = attenuateConstraints(
      { max_tokens: 5000 },
      {},
      { max_duration_ms: 60000, max_tokens: 10000, max_cost_usd: 1.0 },
    );
    expect(result.max_tokens).toBe(5000);
  });

  it("should use SLO max_tokens when parent has none", () => {
    const result = attenuateConstraints(
      {},
      {},
      { max_duration_ms: 60000, max_tokens: 10000, max_cost_usd: 1.0 },
    );
    expect(result.max_tokens).toBe(10000);
  });

  it("should take min of parent and SLO max_cost_usd", () => {
    const result = attenuateConstraints(
      { max_cost_usd: 0.5 },
      {},
      { max_duration_ms: 60000, max_tokens: 10000, max_cost_usd: 1.0 },
    );
    expect(result.max_cost_usd).toBe(0.5);
  });

  it("should take min of parent and SLO max_duration_ms", () => {
    const result = attenuateConstraints(
      { max_duration_ms: 30000 },
      {},
      { max_duration_ms: 60000, max_tokens: 10000, max_cost_usd: 1.0 },
    );
    expect(result.max_duration_ms).toBe(30000);
  });

  it("should apply SLO limits when parent has no budget constraints", () => {
    const result = attenuateConstraints(
      {},
      {},
      { max_duration_ms: 60000, max_tokens: 10000, max_cost_usd: 1.0 },
    );
    expect(result.max_duration_ms).toBe(60000);
    expect(result.max_tokens).toBe(10000);
    expect(result.max_cost_usd).toBe(1.0);
  });

  it("should select the smaller of parent and SLO for all budgets", () => {
    const result = attenuateConstraints(
      { max_tokens: 3000, max_cost_usd: 2.0, max_duration_ms: 120000 },
      {},
      { max_duration_ms: 60000, max_tokens: 10000, max_cost_usd: 1.0 },
    );
    expect(result.max_tokens).toBe(3000);
    expect(result.max_cost_usd).toBe(1.0);
    expect(result.max_duration_ms).toBe(60000);
  });

  it("should combine both allowlist intersection and budget minimization", () => {
    const result = attenuateConstraints(
      { tool_allowlist: ["a", "b", "c"], max_tokens: 5000 },
      { tool_allowlist: ["b", "c", "d"] },
      { max_duration_ms: 60000, max_tokens: 3000, max_cost_usd: 1.0 },
    );
    expect(result.tool_allowlist).toEqual(["b", "c"]);
    expect(result.max_tokens).toBe(3000);
  });
});

describe("validateTaskRequest", () => {
  it("should validate when node has all required capabilities", () => {
    const result = validateTaskRequest(
      { constraints: { tool_allowlist: ["read-file", "shell-exec"] } },
      ["read-file", "shell-exec", "http-request"],
    );
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("should reject when node is missing capabilities", () => {
    const result = validateTaskRequest(
      { constraints: { tool_allowlist: ["read-file", "shell-exec"] } },
      ["read-file"],
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("shell-exec");
  });

  it("should validate when no constraints specified", () => {
    const result = validateTaskRequest({}, ["read-file"]);
    expect(result.valid).toBe(true);
  });

  it("should validate when constraints have no tool_allowlist", () => {
    const result = validateTaskRequest(
      { constraints: { max_tokens: 1000 } },
      ["read-file"],
    );
    expect(result.valid).toBe(true);
  });

  it("should validate when tool_allowlist is empty", () => {
    const result = validateTaskRequest(
      { constraints: { tool_allowlist: [] } },
      ["read-file"],
    );
    expect(result.valid).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import {
  getReversibilityPolicy,
  getMaxRedelegations,
  shouldAutoRedelegate,
  getResponseForFailure,
  DEFAULT_REVERSIBILITY_POLICY_CONFIG,
} from "./reversibility-policy.js";
import type { ReversibilityPolicyConfig, TaskAttribute } from "./types.js";

const baseTaskAttributes: TaskAttribute = {
  complexity: "medium",
  criticality: "medium",
  verifiability: "medium",
  reversibility: "medium",
  estimated_cost: "medium",
  estimated_duration: "medium",
  required_capabilities: [],
};

function taskWith(overrides: Partial<TaskAttribute>): TaskAttribute {
  return { ...baseTaskAttributes, ...overrides };
}

describe("DEFAULT_REVERSIBILITY_POLICY_CONFIG", () => {
  it("should export the default config with expected values", () => {
    expect(DEFAULT_REVERSIBILITY_POLICY_CONFIG).toEqual({
      low_reversibility_policy: "escalate_only",
      medium_reversibility_policy: "cautious_redelegate",
      high_reversibility_policy: "auto_redelegate",
      max_auto_redelegations_low: 0,
      max_auto_redelegations_medium: 1,
      max_auto_redelegations_high: 3,
      require_human_approval_low: true,
    });
  });
});

describe("getReversibilityPolicy", () => {
  it("should return escalate_only for low reversibility", () => {
    expect(getReversibilityPolicy("low")).toBe("escalate_only");
  });

  it("should return cautious_redelegate for medium reversibility", () => {
    expect(getReversibilityPolicy("medium")).toBe("cautious_redelegate");
  });

  it("should return auto_redelegate for high reversibility", () => {
    expect(getReversibilityPolicy("high")).toBe("auto_redelegate");
  });

  it("should respect custom config overrides", () => {
    const customConfig: ReversibilityPolicyConfig = {
      ...DEFAULT_REVERSIBILITY_POLICY_CONFIG,
      low_reversibility_policy: "cautious_redelegate",
      high_reversibility_policy: "escalate_only",
    };
    expect(getReversibilityPolicy("low", customConfig)).toBe("cautious_redelegate");
    expect(getReversibilityPolicy("high", customConfig)).toBe("escalate_only");
  });
});

describe("getMaxRedelegations", () => {
  it("should return 0 for low reversibility", () => {
    expect(getMaxRedelegations("low")).toBe(0);
  });

  it("should return 1 for medium reversibility", () => {
    expect(getMaxRedelegations("medium")).toBe(1);
  });

  it("should return 3 for high reversibility", () => {
    expect(getMaxRedelegations("high")).toBe(3);
  });

  it("should respect custom config overrides", () => {
    const customConfig: ReversibilityPolicyConfig = {
      ...DEFAULT_REVERSIBILITY_POLICY_CONFIG,
      max_auto_redelegations_medium: 5,
    };
    expect(getMaxRedelegations("medium", customConfig)).toBe(5);
  });
});

describe("shouldAutoRedelegate", () => {
  it("should disallow redelegation for escalate_only policy (low reversibility)", () => {
    const result = shouldAutoRedelegate(taskWith({ reversibility: "low" }), 0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("escalate_only");
  });

  it("should disallow when redelegation count reaches the limit", () => {
    const result = shouldAutoRedelegate(taskWith({ reversibility: "high" }), 3);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("3/3");
    expect(result.reason).toContain("Redelegation limit reached");
  });

  it("should disallow cautious_redelegate with high criticality", () => {
    const result = shouldAutoRedelegate(
      taskWith({ reversibility: "medium", criticality: "high" }),
      0,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("High criticality");
  });

  it("should allow redelegation for auto_redelegate within limits", () => {
    const result = shouldAutoRedelegate(taskWith({ reversibility: "high" }), 1);
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("2/3");
  });

  it("should allow cautious_redelegate with non-high criticality", () => {
    const result = shouldAutoRedelegate(
      taskWith({ reversibility: "medium", criticality: "low" }),
      0,
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("1/1");
  });
});

describe("getResponseForFailure", () => {
  it("should abort on malicious behavior with low reversibility", () => {
    const result = getResponseForFailure({
      taskAttributes: taskWith({ reversibility: "low" }),
      rootCause: "malicious_behavior",
      redelegationCount: 0,
    });
    expect(result.action).toBe("abort_task");
    expect(result.reason).toContain("Malicious");
  });

  it("should escalate on low reversibility + high criticality", () => {
    const result = getResponseForFailure({
      taskAttributes: taskWith({ reversibility: "low", criticality: "high" }),
      rootCause: "transient_failure",
      redelegationCount: 0,
    });
    expect(result.action).toBe("escalate_to_human");
    expect(result.reason).toContain("high criticality");
  });

  it("should escalate on low reversibility with non-transient failure", () => {
    const result = getResponseForFailure({
      taskAttributes: taskWith({ reversibility: "low", criticality: "low" }),
      rootCause: "peer_overload",
      redelegationCount: 0,
    });
    expect(result.action).toBe("escalate_to_human");
    expect(result.reason).toContain("peer_overload");
  });

  it("should decompose on task_complexity_mismatch", () => {
    const result = getResponseForFailure({
      taskAttributes: taskWith({ reversibility: "high" }),
      rootCause: "task_complexity_mismatch",
      redelegationCount: 0,
    });
    expect(result.action).toBe("decompose_and_redelegate");
    expect(result.reason).toContain("complexity mismatch");
  });

  it("should wait and retry on network_partition", () => {
    const result = getResponseForFailure({
      taskAttributes: taskWith({ reversibility: "high" }),
      rootCause: "network_partition",
      redelegationCount: 0,
    });
    expect(result.action).toBe("wait_and_retry");
    expect(result.reason).toContain("Network partition");
  });

  it("should quarantine and redelegate on malicious behavior (non-low reversibility)", () => {
    const result = getResponseForFailure({
      taskAttributes: taskWith({ reversibility: "high" }),
      rootCause: "malicious_behavior",
      redelegationCount: 0,
    });
    expect(result.action).toBe("quarantine_and_redelegate");
    expect(result.reason).toContain("quarantine");
  });

  it("should redelegate when auto-redelegate is allowed and no specific root cause matches", () => {
    const result = getResponseForFailure({
      taskAttributes: taskWith({ reversibility: "high" }),
      rootCause: "resource_exhaustion",
      redelegationCount: 0,
    });
    expect(result.action).toBe("redelegate_to_alternative");
  });

  it("should escalate as fallback when redelegation limit is reached", () => {
    const result = getResponseForFailure({
      taskAttributes: taskWith({ reversibility: "high" }),
      rootCause: "resource_exhaustion",
      redelegationCount: 3,
    });
    expect(result.action).toBe("escalate_to_human");
    expect(result.reason).toContain("Redelegation limit reached");
  });

  it("should use custom config when provided", () => {
    const customConfig: ReversibilityPolicyConfig = {
      ...DEFAULT_REVERSIBILITY_POLICY_CONFIG,
      high_reversibility_policy: "escalate_only",
    };
    const result = getResponseForFailure({
      taskAttributes: taskWith({ reversibility: "high" }),
      rootCause: "resource_exhaustion",
      redelegationCount: 0,
      config: customConfig,
    });
    // escalate_only means shouldAutoRedelegate returns false -> fallback escalation
    expect(result.action).toBe("escalate_to_human");
  });
});

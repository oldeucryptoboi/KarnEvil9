import type {
  ReversibilityPolicy,
  ReversibilityPolicyConfig,
  TaskAttribute,
  RootCause,
  DiagnosedResponse,
} from "./types.js";

export const DEFAULT_REVERSIBILITY_POLICY_CONFIG: ReversibilityPolicyConfig = {
  low_reversibility_policy: "escalate_only",
  medium_reversibility_policy: "cautious_redelegate",
  high_reversibility_policy: "auto_redelegate",
  max_auto_redelegations_low: 0,
  max_auto_redelegations_medium: 1,
  max_auto_redelegations_high: 3,
  require_human_approval_low: true,
};

export function getReversibilityPolicy(
  reversibility: "low" | "medium" | "high",
  config: ReversibilityPolicyConfig = DEFAULT_REVERSIBILITY_POLICY_CONFIG,
): ReversibilityPolicy {
  switch (reversibility) {
    case "low": return config.low_reversibility_policy;
    case "medium": return config.medium_reversibility_policy;
    case "high": return config.high_reversibility_policy;
  }
}

export function getMaxRedelegations(
  reversibility: "low" | "medium" | "high",
  config: ReversibilityPolicyConfig = DEFAULT_REVERSIBILITY_POLICY_CONFIG,
): number {
  switch (reversibility) {
    case "low": return config.max_auto_redelegations_low;
    case "medium": return config.max_auto_redelegations_medium;
    case "high": return config.max_auto_redelegations_high;
  }
}

export function shouldAutoRedelegate(
  taskAttributes: TaskAttribute,
  redelegationCount: number,
  config: ReversibilityPolicyConfig = DEFAULT_REVERSIBILITY_POLICY_CONFIG,
): { allowed: boolean; reason: string } {
  const policy = getReversibilityPolicy(taskAttributes.reversibility, config);
  const maxRedelegations = getMaxRedelegations(taskAttributes.reversibility, config);

  if (policy === "escalate_only") {
    return { allowed: false, reason: `Low reversibility tasks require escalation (policy: escalate_only)` };
  }

  if (redelegationCount >= maxRedelegations) {
    return {
      allowed: false,
      reason: `Redelegation limit reached (${redelegationCount}/${maxRedelegations}) for ${taskAttributes.reversibility} reversibility`,
    };
  }

  if (policy === "cautious_redelegate" && taskAttributes.criticality === "high") {
    return { allowed: false, reason: "High criticality + medium reversibility requires human approval" };
  }

  return { allowed: true, reason: `Auto-redelegate allowed (${redelegationCount + 1}/${maxRedelegations})` };
}

export function getResponseForFailure(params: {
  taskAttributes: TaskAttribute;
  rootCause?: RootCause;
  redelegationCount: number;
  config?: ReversibilityPolicyConfig;
}): { action: DiagnosedResponse; reason: string } {
  const { taskAttributes, rootCause, redelegationCount, config } = params;
  const cfg = config ?? DEFAULT_REVERSIBILITY_POLICY_CONFIG;
  const reversibility = taskAttributes.reversibility;

  // Malicious + low reversibility → abort
  if (rootCause === "malicious_behavior" && reversibility === "low") {
    return { action: "abort_task", reason: "Malicious behavior detected on irreversible task" };
  }

  // Low reversibility + high criticality → always escalate
  if (reversibility === "low" && taskAttributes.criticality === "high") {
    return { action: "escalate_to_human", reason: "Low reversibility + high criticality requires human decision" };
  }

  // Low reversibility + non-transient → escalate
  if (reversibility === "low" && rootCause && rootCause !== "transient_failure") {
    return { action: "escalate_to_human", reason: `Low reversibility with ${rootCause} — requires human approval` };
  }

  // Complexity mismatch → decompose
  if (rootCause === "task_complexity_mismatch") {
    return { action: "decompose_and_redelegate", reason: "Task complexity mismatch — decompose into simpler subtasks" };
  }

  // Network partition → wait and retry
  if (rootCause === "network_partition") {
    return { action: "wait_and_retry", reason: "Network partition detected — wait for recovery" };
  }

  // Malicious → quarantine and redelegate
  if (rootCause === "malicious_behavior") {
    return { action: "quarantine_and_redelegate", reason: "Malicious behavior — quarantine peer and redelegate" };
  }

  // Check if auto-redelegate is allowed
  const autoResult = shouldAutoRedelegate(taskAttributes, redelegationCount, cfg);
  if (autoResult.allowed) {
    return { action: "redelegate_to_alternative", reason: autoResult.reason };
  }

  // Fallback to escalation
  return { action: "escalate_to_human", reason: autoResult.reason };
}

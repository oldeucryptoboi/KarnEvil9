import type { SwarmTaskConstraints, ContractPermissionBoundary, ContractSLO, DelegationCapabilityToken } from "./types.js";

export function attenuateConstraints(
  parent: SwarmTaskConstraints,
  boundary: ContractPermissionBoundary,
  slo: ContractSLO,
): SwarmTaskConstraints {
  const result: SwarmTaskConstraints = { ...parent };

  // tool_allowlist: intersection of parent and boundary (if both present)
  if (parent.tool_allowlist && boundary.tool_allowlist) {
    const boundarySet = new Set(boundary.tool_allowlist);
    result.tool_allowlist = parent.tool_allowlist.filter(t => boundarySet.has(t));
  } else if (boundary.tool_allowlist) {
    result.tool_allowlist = [...boundary.tool_allowlist];
  }
  // If only parent has tool_allowlist, keep parent's (already spread above)

  // Budget constraints: take the minimum
  if (slo.max_tokens !== undefined) {
    result.max_tokens = parent.max_tokens !== undefined
      ? Math.min(parent.max_tokens, slo.max_tokens)
      : slo.max_tokens;
  }

  if (slo.max_cost_usd !== undefined) {
    result.max_cost_usd = parent.max_cost_usd !== undefined
      ? Math.min(parent.max_cost_usd, slo.max_cost_usd)
      : slo.max_cost_usd;
  }

  if (slo.max_duration_ms !== undefined) {
    result.max_duration_ms = parent.max_duration_ms !== undefined
      ? Math.min(parent.max_duration_ms, slo.max_duration_ms)
      : slo.max_duration_ms;
  }

  return result;
}

export function validateTaskRequest(
  request: { constraints?: SwarmTaskConstraints },
  nodeCapabilities: string[],
): { valid: boolean; reason?: string } {
  const allowlist = request.constraints?.tool_allowlist;
  if (allowlist && allowlist.length > 0) {
    const capSet = new Set(nodeCapabilities);
    const missing = allowlist.filter(t => !capSet.has(t));
    if (missing.length > 0) {
      return {
        valid: false,
        reason: `Node lacks required capabilities: ${missing.join(", ")}`,
      };
    }
  }
  return { valid: true };
}

export function attenuateFromDCT(dct: DelegationCapabilityToken): SwarmTaskConstraints {
  const constraints: SwarmTaskConstraints = {};

  for (const caveat of dct.caveats) {
    switch (caveat.type) {
      case "tool_restriction":
        constraints.tool_allowlist = caveat.value as string[];
        break;
      case "cost_limit":
        constraints.max_cost_usd = caveat.value as number;
        break;
      case "token_limit":
        constraints.max_tokens = caveat.value as number;
        break;
      case "time_bound": {
        const bound = caveat.value as { not_after?: string };
        if (bound.not_after) {
          const remaining = new Date(bound.not_after).getTime() - Date.now();
          if (remaining > 0) constraints.max_duration_ms = remaining;
        }
        break;
      }
    }
  }

  return constraints;
}

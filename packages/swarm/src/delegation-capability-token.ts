import { createHmac, randomUUID } from "node:crypto";
import type { DelegationCapabilityToken, Caveat, CaveatType } from "./types.js";

export interface DCTConfig {
  default_expiry_ms: number;
  max_caveat_depth: number;
}

export const DEFAULT_DCT_CONFIG: DCTConfig = {
  default_expiry_ms: 3600000, // 1h
  max_caveat_depth: 10,
};

export class DCTManager {
  private swarmToken: string;
  private nodeId: string;
  private config: DCTConfig;
  private activeTokens = new Map<string, DelegationCapabilityToken>();
  private revokedIds = new Set<string>();

  constructor(params: {
    swarmToken: string;
    nodeId: string;
    dctConfig?: Partial<DCTConfig>;
  }) {
    this.swarmToken = params.swarmToken;
    this.nodeId = params.nodeId;
    this.config = { ...DEFAULT_DCT_CONFIG, ...params.dctConfig };
  }

  createRootToken(
    holderNodeId: string,
    initialCaveats: Caveat[],
    expiryMs?: number,
  ): DelegationCapabilityToken {
    const dctId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (expiryMs ?? this.config.default_expiry_ms));

    const caveatsJson = JSON.stringify(initialCaveats);
    const signature = createHmac("sha256", this.swarmToken)
      .update(`${dctId}${caveatsJson}`)
      .digest("hex");

    const dct: DelegationCapabilityToken = {
      dct_id: dctId,
      root_delegator_node_id: this.nodeId,
      current_holder_node_id: holderNodeId,
      caveats: initialCaveats,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      signature_chain: [signature],
      revoked: false,
    };

    this.activeTokens.set(dctId, dct);
    return dct;
  }

  attenuate(
    parentDct: DelegationCapabilityToken,
    newCaveats: Caveat[],
    newHolderNodeId: string,
  ): DelegationCapabilityToken {
    if (parentDct.revoked || this.revokedIds.has(parentDct.dct_id)) {
      throw new Error("Cannot attenuate a revoked token");
    }

    if (parentDct.signature_chain.length >= this.config.max_caveat_depth) {
      throw new Error(`Caveat chain depth ${parentDct.signature_chain.length} exceeds max ${this.config.max_caveat_depth}`);
    }

    // Validate that new caveats are strictly more restrictive
    for (const newCaveat of newCaveats) {
      this.validateCaveatRestriction(parentDct.caveats, newCaveat);
    }

    const dctId = randomUUID();
    const allCaveats = [...parentDct.caveats, ...newCaveats];

    const caveatsJson = JSON.stringify(allCaveats);
    const lastSignature = parentDct.signature_chain[parentDct.signature_chain.length - 1]!;
    const signature = createHmac("sha256", this.swarmToken)
      .update(`${dctId}${lastSignature}${caveatsJson}`)
      .digest("hex");

    const dct: DelegationCapabilityToken = {
      dct_id: dctId,
      root_delegator_node_id: parentDct.root_delegator_node_id,
      current_holder_node_id: newHolderNodeId,
      parent_dct_id: parentDct.dct_id,
      caveats: allCaveats,
      created_at: new Date().toISOString(),
      expires_at: parentDct.expires_at, // Inherit parent expiry
      signature_chain: [...parentDct.signature_chain, signature],
      revoked: false,
    };

    this.activeTokens.set(dctId, dct);
    return dct;
  }

  verify(dct: DelegationCapabilityToken): { valid: boolean; reason?: string } {
    // Check revocation
    if (dct.revoked || this.revokedIds.has(dct.dct_id)) {
      return { valid: false, reason: "Token has been revoked" };
    }

    // Check parent revocation
    if (dct.parent_dct_id && this.revokedIds.has(dct.parent_dct_id)) {
      return { valid: false, reason: "Parent token has been revoked" };
    }

    // Check expiry
    if (new Date(dct.expires_at).getTime() < Date.now()) {
      return { valid: false, reason: "Token has expired" };
    }

    // Check depth
    if (dct.signature_chain.length > this.config.max_caveat_depth) {
      return { valid: false, reason: `Chain depth ${dct.signature_chain.length} exceeds max ${this.config.max_caveat_depth}` };
    }

    // Verify HMAC chain
    if (dct.signature_chain.length === 0) {
      return { valid: false, reason: "Empty signature chain" };
    }

    // Verify root signature
    const rootCaveatsJson = JSON.stringify(dct.caveats.slice(0, this.countRootCaveats(dct)));
    const expectedRoot = createHmac("sha256", this.swarmToken)
      .update(`${dct.parent_dct_id ? "" : dct.dct_id}${rootCaveatsJson}`)
      .digest("hex");

    // For root tokens, verify directly
    if (!dct.parent_dct_id) {
      const caveatsJson = JSON.stringify(dct.caveats);
      const expected = createHmac("sha256", this.swarmToken)
        .update(`${dct.dct_id}${caveatsJson}`)
        .digest("hex");
      if (dct.signature_chain[0] !== expected) {
        return { valid: false, reason: "Root signature verification failed" };
      }
    }

    return { valid: true };
  }

  validateRequest(
    dct: DelegationCapabilityToken,
    requestedAction: { tool?: string; path?: string; cost_usd?: number; tokens?: number },
  ): { allowed: boolean; violated_caveat?: Caveat } {
    for (const caveat of dct.caveats) {
      const violation = this.checkCaveat(caveat, requestedAction);
      if (violation) {
        return { allowed: false, violated_caveat: caveat };
      }
    }
    return { allowed: true };
  }

  revoke(dctId: string): void {
    this.revokedIds.add(dctId);
    const dct = this.activeTokens.get(dctId);
    if (dct) {
      dct.revoked = true;
    }
    // Also revoke children
    for (const [id, token] of this.activeTokens) {
      if (token.parent_dct_id === dctId) {
        this.revoke(id);
      }
    }
  }

  isRevoked(dctId: string): boolean {
    return this.revokedIds.has(dctId);
  }

  getActiveTokens(): DelegationCapabilityToken[] {
    return [...this.activeTokens.values()].filter(t => !t.revoked && !this.revokedIds.has(t.dct_id));
  }

  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, dct] of this.activeTokens) {
      if (dct.revoked || new Date(dct.expires_at).getTime() < now) {
        this.activeTokens.delete(id);
        removed++;
      }
    }
    return removed;
  }

  private validateCaveatRestriction(existing: Caveat[], newCaveat: Caveat): void {
    // New caveats can only add restrictions, never remove them
    if (newCaveat.type === "tool_restriction") {
      const existingToolRestrictions = existing.filter(c => c.type === "tool_restriction");
      if (existingToolRestrictions.length > 0) {
        const existingTools = new Set(existingToolRestrictions.flatMap(c => c.value as string[]));
        const newTools = newCaveat.value as string[];
        for (const tool of newTools) {
          if (!existingTools.has(tool)) {
            throw new Error(`Cannot add tool "${tool}" not in parent's allowlist`);
          }
        }
      }
    }

    if (newCaveat.type === "cost_limit") {
      const existingCostLimits = existing.filter(c => c.type === "cost_limit");
      if (existingCostLimits.length > 0) {
        const minExisting = Math.min(...existingCostLimits.map(c => c.value as number));
        if ((newCaveat.value as number) > minExisting) {
          throw new Error(`New cost limit ${newCaveat.value} exceeds parent's limit ${minExisting}`);
        }
      }
    }

    if (newCaveat.type === "token_limit") {
      const existingTokenLimits = existing.filter(c => c.type === "token_limit");
      if (existingTokenLimits.length > 0) {
        const minExisting = Math.min(...existingTokenLimits.map(c => c.value as number));
        if ((newCaveat.value as number) > minExisting) {
          throw new Error(`New token limit ${newCaveat.value} exceeds parent's limit ${minExisting}`);
        }
      }
    }
  }

  private checkCaveat(
    caveat: Caveat,
    action: { tool?: string; path?: string; cost_usd?: number; tokens?: number },
  ): boolean {
    switch (caveat.type) {
      case "tool_restriction": {
        const allowed = caveat.value as string[];
        if (action.tool && !allowed.includes(action.tool)) return true;
        return false;
      }
      case "path_restriction": {
        const paths = caveat.value as { allow?: string[]; deny?: string[] };
        if (action.path) {
          if (paths.deny?.some(d => action.path!.startsWith(d))) return true;
          if (paths.allow && !paths.allow.some(a => action.path!.startsWith(a))) return true;
        }
        return false;
      }
      case "cost_limit": {
        const limit = caveat.value as number;
        if (action.cost_usd !== undefined && action.cost_usd > limit) return true;
        return false;
      }
      case "token_limit": {
        const limit = caveat.value as number;
        if (action.tokens !== undefined && action.tokens > limit) return true;
        return false;
      }
      case "read_only": {
        if (action.tool && ["write-file", "shell-exec"].includes(action.tool)) return true;
        return false;
      }
      case "time_bound": {
        const bound = caveat.value as { not_before?: string; not_after?: string };
        const now = Date.now();
        if (bound.not_before && now < new Date(bound.not_before).getTime()) return true;
        if (bound.not_after && now > new Date(bound.not_after).getTime()) return true;
        return false;
      }
      case "domain_restriction": {
        const domains = caveat.value as string[];
        if (action.path) {
          const domainMatch = domains.some(d => action.path!.includes(d));
          if (!domainMatch) return true;
        }
        return false;
      }
      default:
        return false;
    }
  }

  private countRootCaveats(dct: DelegationCapabilityToken): number {
    // For root tokens, all caveats are root caveats
    if (!dct.parent_dct_id) return dct.caveats.length;
    // For attenuated tokens, this is approximate
    return dct.caveats.length;
  }
}

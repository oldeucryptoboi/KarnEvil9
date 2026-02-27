import { createHmac, randomUUID } from "node:crypto";
import type { PermissionGrant } from "@karnevil9/schemas";
import { PermissionEngine, type DCTEnforcer } from "./permission-engine.js";

export interface DelegationCapabilityToken {
  dct_id: string;
  parent_session_id: string;
  child_session_id: string;
  allowed_scopes: string[];
  created_at: string;
  expires_at: string;
  signature: string;
}

export interface DelegationBridgeConfig {
  signingSecret: string;
  defaultExpiryMs?: number;
}

export class DelegationBridge {
  private signingSecret: string;
  private defaultExpiryMs: number;

  constructor(config: DelegationBridgeConfig) {
    this.signingSecret = config.signingSecret;
    this.defaultExpiryMs = config.defaultExpiryMs ?? 3600000; // 1h
  }

  deriveChildToken(
    parentGrants: PermissionGrant[],
    childId: string,
    restrictions?: { tool_allowlist?: string[] },
  ): DelegationCapabilityToken {
    // Extract unique scopes from parent grants
    const parentScopes = [...new Set(parentGrants.map(g => g.scope))];

    // If tool_allowlist provided, intersect with parent scopes (monotonic restriction)
    let allowedScopes: string[];
    if (restrictions?.tool_allowlist && restrictions.tool_allowlist.length > 0) {
      const allowedSet = new Set(restrictions.tool_allowlist);
      allowedScopes = parentScopes.filter(scope => {
        const parts = scope.split(":");
        if (parts.length < 3) return false;
        // Check if any allowlist entry matches this scope's tool domain
        // Match on domain or on full scope
        return allowedSet.has(scope) || allowedSet.has(parts[0]!);
      });
      // If allowlist specifies scopes not in parent, they're silently dropped (monotonic)
    } else {
      allowedScopes = parentScopes;
    }

    const dctId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.defaultExpiryMs);

    const payload = JSON.stringify({ dct_id: dctId, child_id: childId, scopes: allowedScopes });
    const signature = createHmac("sha256", this.signingSecret)
      .update(payload)
      .digest("hex");

    return {
      dct_id: dctId,
      parent_session_id: "",  // Set by caller
      child_session_id: childId,
      allowed_scopes: allowedScopes,
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      signature,
    };
  }

  applyTokenAsGrants(
    engine: PermissionEngine,
    childSessionId: string,
    token: DelegationCapabilityToken,
  ): void {
    if (token.allowed_scopes.length > 0) {
      engine.preGrant(childSessionId, token.allowed_scopes, "delegation");
    }
  }

  createEnforcer(token: DelegationCapabilityToken): DCTEnforcer {
    const allowedScopes = token.allowed_scopes;
    return {
      validateScope(scope: string): boolean {
        // Check if the requested scope is allowed by any of the token's scopes
        for (const allowed of allowedScopes) {
          if (PermissionEngine.scopeMatchesGrant(allowed, scope)) return true;
        }
        return false;
      },
    };
  }

  verifySignature(token: DelegationCapabilityToken): boolean {
    const payload = JSON.stringify({
      dct_id: token.dct_id,
      child_id: token.child_session_id,
      scopes: token.allowed_scopes,
    });
    const expected = createHmac("sha256", this.signingSecret)
      .update(payload)
      .digest("hex");
    return token.signature === expected;
  }
}

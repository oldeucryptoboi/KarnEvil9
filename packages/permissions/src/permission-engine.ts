import type {
  Permission,
  PermissionGrant,
  PermissionRequest,
  ApprovalDecision,
  PermissionCheckResult,
  PermissionConstraints,
} from "@openvger/schemas";
import type { Journal } from "@openvger/journal";

export type ApprovalPromptFn = (
  request: PermissionRequest
) => Promise<ApprovalDecision>;

export class PermissionEngine {
  private sessionCaches = new Map<string, Map<string, PermissionGrant>>();
  private globalCache = new Map<string, PermissionGrant>();
  private constraintCache = new Map<string, PermissionConstraints>();
  private observedCache = new Set<string>();
  private journal: Journal;
  private promptFn: ApprovalPromptFn;

  constructor(journal: Journal, promptFn: ApprovalPromptFn) {
    this.journal = journal;
    this.promptFn = promptFn;
  }

  static parse(scope: string): Permission {
    const parts = scope.split(":");
    if (parts.length < 3) {
      throw new Error(`Invalid permission scope: "${scope}". Expected "domain:action:target".`);
    }
    return {
      scope,
      domain: parts[0]!,
      action: parts[1]!,
      target: parts.slice(2).join(":"),
    };
  }

  private getSessionCache(sessionId: string): Map<string, PermissionGrant> {
    let cache = this.sessionCaches.get(sessionId);
    if (!cache) {
      cache = new Map();
      this.sessionCaches.set(sessionId, cache);
    }
    return cache;
  }

  async check(request: PermissionRequest): Promise<PermissionCheckResult> {
    const sessionId = request.session_id;
    const missing: Permission[] = [];
    for (const perm of request.permissions) {
      if (!this.isGranted(perm.scope, sessionId)) missing.push(perm);
    }
    if (missing.length === 0) {
      // Check for cached constraints/observed flags (step-scoped key, fallback to tool-scoped)
      const stepKey = `${sessionId}:${request.tool_name}:${request.step_id}`;
      const toolKey = `${sessionId}:${request.tool_name}`;
      const constraints = this.constraintCache.get(stepKey) ?? this.constraintCache.get(toolKey);
      const observed = this.observedCache.has(stepKey) || this.observedCache.has(toolKey);
      return { allowed: true, ...(constraints ? { constraints } : {}), ...(observed ? { observed: true } : {}) };
    }

    await this.journal.emit(sessionId, "permission.requested", {
      request_id: request.request_id,
      step_id: request.step_id,
      tool_name: request.tool_name,
      scopes: missing.map((p) => p.scope),
    });

    const decision = await this.promptFn({ ...request, permissions: missing });
    const now = new Date().toISOString();

    // Handle legacy string decisions
    if (typeof decision === "string") {
      if (decision === "deny") {
        await this.journal.emit(sessionId, "permission.denied", {
          request_id: request.request_id,
          step_id: request.step_id,
          tool_name: request.tool_name,
          scopes: missing.map((p) => p.scope),
        });
        return { allowed: false };
      }

      const sessionCache = this.getSessionCache(sessionId);
      for (const perm of missing) {
        const grant: PermissionGrant = {
          scope: perm.scope,
          decision,
          granted_by: "user",
          granted_at: now,
          ttl: decision === "allow_once" ? "step" : decision === "allow_session" ? "session" : "global",
        };
        if (decision === "allow_always") this.globalCache.set(perm.scope, grant);
        if (decision === "allow_session" || decision === "allow_always") {
          sessionCache.set(perm.scope, grant);
        }
      }

      await this.journal.emit(sessionId, "permission.granted", {
        request_id: request.request_id,
        step_id: request.step_id,
        tool_name: request.tool_name,
        scopes: missing.map((p) => p.scope),
        decision,
      });

      return { allowed: true };
    }

    // Handle new object decisions
    if (decision.type === "allow_constrained") {
      const scopeStr = decision.scope;
      const sessionCache = this.getSessionCache(sessionId);
      for (const perm of missing) {
        const grant: PermissionGrant = {
          scope: perm.scope,
          decision: scopeStr === "once" ? "allow_once" : scopeStr === "session" ? "allow_session" : "allow_always",
          granted_by: "user",
          granted_at: now,
          ttl: scopeStr === "once" ? "step" : scopeStr === "session" ? "session" : "global",
        };
        if (scopeStr === "always") this.globalCache.set(perm.scope, grant);
        if (scopeStr === "session" || scopeStr === "always") {
          sessionCache.set(perm.scope, grant);
        }
      }
      // Cache constraints at both step-level and tool-level
      // Step-level takes priority for per-step constraint differentiation
      const stepCacheKey = `${sessionId}:${request.tool_name}:${request.step_id}`;
      const toolCacheKey = `${sessionId}:${request.tool_name}`;
      this.constraintCache.set(stepCacheKey, decision.constraints);
      this.constraintCache.set(toolCacheKey, decision.constraints);

      await this.journal.emit(sessionId, "permission.granted", {
        request_id: request.request_id,
        step_id: request.step_id,
        tool_name: request.tool_name,
        scopes: missing.map((p) => p.scope),
        decision: "allow_constrained",
        constraints: decision.constraints,
      });

      return { allowed: true, constraints: decision.constraints };
    }

    if (decision.type === "allow_observed") {
      const scopeStr = decision.scope;
      const sessionCache = this.getSessionCache(sessionId);
      for (const perm of missing) {
        const grant: PermissionGrant = {
          scope: perm.scope,
          decision: scopeStr === "once" ? "allow_once" : scopeStr === "session" ? "allow_session" : "allow_always",
          granted_by: "user",
          granted_at: now,
          ttl: scopeStr === "once" ? "step" : scopeStr === "session" ? "session" : "global",
        };
        if (scopeStr === "always") this.globalCache.set(perm.scope, grant);
        if (scopeStr === "session" || scopeStr === "always") {
          sessionCache.set(perm.scope, grant);
        }
      }
      // Cache at both step-level and tool-level
      const stepCacheKey = `${sessionId}:${request.tool_name}:${request.step_id}`;
      const toolCacheKey = `${sessionId}:${request.tool_name}`;
      this.observedCache.add(stepCacheKey);
      this.observedCache.add(toolCacheKey);

      await this.journal.emit(sessionId, "permission.granted", {
        request_id: request.request_id,
        step_id: request.step_id,
        tool_name: request.tool_name,
        scopes: missing.map((p) => p.scope),
        decision: "allow_observed",
        telemetry_level: decision.telemetry_level,
      });

      return { allowed: true, observed: true };
    }

    if (decision.type === "deny_with_alternative") {
      await this.journal.emit(sessionId, "permission.denied", {
        request_id: request.request_id,
        step_id: request.step_id,
        tool_name: request.tool_name,
        scopes: missing.map((p) => p.scope),
        reason: decision.reason,
        alternative: decision.alternative,
      });

      return { allowed: false, alternative: decision.alternative };
    }

    // Fallback — treat unknown decision types as deny
    return { allowed: false };
  }

  isGranted(scope: string, sessionId?: string): boolean {
    if (this.globalCache.has(scope)) return true;
    if (sessionId) {
      const sessionCache = this.sessionCaches.get(sessionId);
      if (sessionCache?.has(scope)) return true;
    }
    return false;
  }

  clearSession(sessionId?: string): void {
    if (sessionId) {
      this.sessionCaches.delete(sessionId);
      // Clear session-specific constraint/observed caches (collect keys first to avoid mutating during iteration)
      const constraintKeys = [...this.constraintCache.keys()].filter(k => k.startsWith(`${sessionId}:`));
      for (const key of constraintKeys) this.constraintCache.delete(key);
      const observedKeys = [...this.observedCache].filter(k => k.startsWith(`${sessionId}:`));
      for (const key of observedKeys) this.observedCache.delete(key);
    } else {
      this.sessionCaches.clear();
      this.constraintCache.clear();
      this.observedCache.clear();
    }
  }

  clearStep(sessionId?: string): void {
    if (sessionId) {
      const cache = this.sessionCaches.get(sessionId);
      if (cache) {
        const toDelete = [...cache.entries()].filter(([, g]) => g.ttl === "step").map(([s]) => s);
        for (const scope of toDelete) cache.delete(scope);
      }
    } else {
      for (const cache of this.sessionCaches.values()) {
        const toDelete = [...cache.entries()].filter(([, g]) => g.ttl === "step").map(([s]) => s);
        for (const scope of toDelete) cache.delete(scope);
      }
    }
  }

  listGrants(sessionId?: string): PermissionGrant[] {
    const grants = new Map<string, PermissionGrant>();
    for (const [scope, grant] of this.globalCache) grants.set(scope, grant);
    if (sessionId) {
      const sessionCache = this.sessionCaches.get(sessionId);
      if (sessionCache) {
        for (const [scope, grant] of sessionCache) grants.set(scope, grant);
      }
    }
    return [...grants.values()];
  }
}

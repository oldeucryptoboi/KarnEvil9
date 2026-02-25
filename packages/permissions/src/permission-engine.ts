import type {
  Permission,
  PermissionGrant,
  PermissionRequest,
  ApprovalDecision,
  PermissionCheckResult,
  PermissionConstraints,
} from "@karnevil9/schemas";
import type { Journal } from "@karnevil9/journal";

export type ApprovalPromptFn = (
  request: PermissionRequest
) => Promise<ApprovalDecision>;

const MAX_SESSION_CACHES = 10_000;

export class PermissionEngine {
  private sessionCaches = new Map<string, Map<string, PermissionGrant>>();
  private constraintCache = new Map<string, PermissionConstraints>();
  private observedCache = new Set<string>();
  private promptLocks = new Map<string, Promise<void>>();
  private journal: Journal;
  private promptFn: ApprovalPromptFn;

  constructor(journal: Journal, promptFn: ApprovalPromptFn) {
    this.journal = journal;
    this.promptFn = promptFn;
  }

  /**
   * Acquire a per-session prompt lock. Serializes approval prompts so that
   * a session-level grant from one prompt is visible to the next before it
   * decides whether to prompt the user again.
   */
  private async acquirePromptLock(sessionId: string): Promise<() => void> {
    while (this.promptLocks.has(sessionId)) {
      await this.promptLocks.get(sessionId);
    }
    let release!: () => void;
    this.promptLocks.set(sessionId, new Promise<void>((r) => { release = r; }));
    return () => {
      this.promptLocks.delete(sessionId);
      release();
    };
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
      // Evict oldest entry if at capacity
      if (this.sessionCaches.size >= MAX_SESSION_CACHES) {
        const oldest = this.sessionCaches.keys().next().value;
        if (oldest !== undefined) this.sessionCaches.delete(oldest);
      }
      cache = new Map();
      this.sessionCaches.set(sessionId, cache);
    }
    return cache;
  }

  async check(request: PermissionRequest): Promise<PermissionCheckResult> {
    const sessionId = request.session_id;
    let missing: Permission[] = [];
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

    // Serialize prompts per session: wait for any in-flight prompt to resolve
    // so that session-level grants are visible before we decide to prompt again.
    const releaseLock = await this.acquirePromptLock(sessionId);

    // Re-check grants — a concurrent prompt may have granted session-level access
    const stillMissing = missing.filter((p) => !this.isGranted(p.scope, sessionId));
    if (stillMissing.length === 0) {
      releaseLock();
      const stepKey = `${sessionId}:${request.tool_name}:${request.step_id}`;
      const toolKey = `${sessionId}:${request.tool_name}`;
      const constraints = this.constraintCache.get(stepKey) ?? this.constraintCache.get(toolKey);
      const observed = this.observedCache.has(stepKey) || this.observedCache.has(toolKey);
      return { allowed: true, ...(constraints ? { constraints } : {}), ...(observed ? { observed: true } : {}) };
    }
    missing = stillMissing;

    await this.journal.emit(sessionId, "permission.requested", {
      request_id: request.request_id,
      step_id: request.step_id,
      tool_name: request.tool_name,
      scopes: missing.map((p) => p.scope),
    });

    let decision: ApprovalDecision;
    try {
      decision = await this.promptFn({ ...request, permissions: missing });
    } catch (err) {
      releaseLock();
      throw err;
    }

    try {
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
          // allow_always is scoped to session lifetime (not process) for safety
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
          // allow_always is scoped to session lifetime (not process) for safety
          if (scopeStr === "session" || scopeStr === "always") {
            sessionCache.set(perm.scope, grant);
          }
        }
        // Cache constraints at step-level only (session-scoped, cleaned up with clearSession)
        const stepCacheKey = `${sessionId}:${request.tool_name}:${request.step_id}`;
        this.constraintCache.set(stepCacheKey, decision.constraints);

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
          // allow_always is scoped to session lifetime (not process) for safety
          if (scopeStr === "session" || scopeStr === "always") {
            sessionCache.set(perm.scope, grant);
          }
        }
        // Cache at step-level only (session-scoped, cleaned up with clearSession)
        const stepCacheKey = `${sessionId}:${request.tool_name}:${request.step_id}`;
        this.observedCache.add(stepCacheKey);

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
    } finally {
      releaseLock();
    }
  }

  preGrant(sessionId: string, scopes: string[], grantedBy = "plugin"): void {
    const now = new Date().toISOString();
    const sessionCache = this.getSessionCache(sessionId);
    for (const scope of scopes) {
      const grant: PermissionGrant = {
        scope,
        decision: "allow_session",
        granted_by: grantedBy,
        granted_at: now,
        ttl: "session",
      };
      sessionCache.set(scope, grant);
    }
  }

  isGranted(scope: string, sessionId?: string): boolean {
    if (sessionId) {
      const sessionCache = this.sessionCaches.get(sessionId);
      if (sessionCache?.has(scope)) return true;
    }
    return false;
  }

  clearSession(sessionId?: string): void {
    if (sessionId) {
      this.sessionCaches.delete(sessionId);
      this.promptLocks.delete(sessionId);
      // Clear session-specific constraint/observed caches (collect keys first to avoid mutating during iteration)
      const constraintKeys = [...this.constraintCache.keys()].filter(k => k.startsWith(`${sessionId}:`));
      for (const key of constraintKeys) this.constraintCache.delete(key);
      const observedKeys = [...this.observedCache].filter(k => k.startsWith(`${sessionId}:`));
      for (const key of observedKeys) this.observedCache.delete(key);
    } else {
      this.sessionCaches.clear();
      this.promptLocks.clear();
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
    if (!sessionId) return [];
    const sessionCache = this.sessionCaches.get(sessionId);
    if (!sessionCache) return [];
    return [...sessionCache.values()];
  }
}

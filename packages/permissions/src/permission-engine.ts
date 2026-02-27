import type {
  Permission,
  PermissionGrant,
  PermissionRequest,
  ApprovalDecision,
  PermissionCheckResult,
  PermissionConstraints,
} from "@karnevil9/schemas";
import type { Journal } from "@karnevil9/journal";
import cronParser from "cron-parser";
const { parseExpression } = cronParser;

export type ApprovalPromptFn = (
  request: PermissionRequest
) => Promise<ApprovalDecision>;

export type ExternalAuditHookFn = (event: {
  session_id: string; tool_name: string; input: Record<string, unknown>; timestamp: string;
}) => Promise<void>;

export interface PermissionEngineOptions {
  externalAuditHook?: ExternalAuditHookFn;
}

export interface DCTEnforcer {
  validateScope(scope: string): boolean;
}

export const MAX_SESSION_CACHES = 10_000;
export const MAX_CONSTRAINT_CACHE = 50_000;
export const MAX_OBSERVED_CACHE = 50_000;

export class PermissionEngine {
  private sessionCaches = new Map<string, Map<string, PermissionGrant>>();
  private constraintCache = new Map<string, PermissionConstraints>();
  private constraintCacheBySession = new Map<string, Set<string>>();
  private observedCache = new Set<string>();
  private observedCacheBySession = new Map<string, Set<string>>();
  private rateBuckets = new Map<string, { tokens: number; windowStart: number; maxCalls: number; windowMs: number }>();
  private rateBucketsBySession = new Map<string, Set<string>>();
  private timeBounds = new Map<string, { cronExpression: string; windowDurationMs: number; timezone?: string }>();
  private timeBoundsBySession = new Map<string, Set<string>>();
  private promptLocks = new Map<string, Promise<void>>();
  private journal: Journal;
  private promptFn: ApprovalPromptFn;
  private externalAuditHook?: ExternalAuditHookFn;
  private dctEnforcer?: DCTEnforcer;

  constructor(journal: Journal, promptFn: ApprovalPromptFn, opts?: PermissionEngineOptions) {
    this.journal = journal;
    this.promptFn = promptFn;
    this.externalAuditHook = opts?.externalAuditHook;
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

  static validateWildcardScope(scope: string): void {
    const parts = scope.split(":");
    if (parts.length < 3) throw new Error(`Invalid scope: "${scope}"`);
    if (parts[0] === "*") throw new Error(`Wildcard not allowed in domain position: "${scope}"`);
  }

  static scopeMatchesGrant(grantScope: string, requestScope: string): boolean {
    if (grantScope === requestScope) return true;
    const gParts = grantScope.split(":");
    const rParts = requestScope.split(":");
    if (gParts.length < 3 || rParts.length < 3) return false;
    if (gParts[0] !== rParts[0]) return false;                        // domain: exact only
    if (gParts[1] !== "*" && gParts[1] !== rParts[1]) return false;   // action: exact or *
    const gTarget = gParts.slice(2).join(":");
    const rTarget = rParts.slice(2).join(":");
    return gTarget === "*" || gTarget === rTarget;                     // target: exact or *
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

  /**
   * SECURITY NOTE — History-Poisoning Guard: Any future conditional/precondition grants
   * MUST evaluate against journal.readVerifiedSession(), never mutable in-process state.
   */
  async check(request: PermissionRequest): Promise<PermissionCheckResult> {
    const sessionId = request.session_id;

    // DCT boundary enforcement: reject scopes outside delegation token
    if (this.dctEnforcer) {
      for (const perm of request.permissions) {
        if (!this.dctEnforcer.validateScope(perm.scope)) {
          await this.journal.emit(sessionId, "permission.denied", {
            request_id: request.request_id,
            step_id: request.step_id,
            tool_name: request.tool_name,
            scopes: [perm.scope],
            reason: "outside DCT boundary",
          });
          return { allowed: false };
        }
      }
    }

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
          PermissionEngine.validateWildcardScope(perm.scope);
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
          PermissionEngine.validateWildcardScope(perm.scope);
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
        this.addConstraintCacheEntry(sessionId, stepCacheKey, decision.constraints);

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
          PermissionEngine.validateWildcardScope(perm.scope);
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
        this.addObservedCacheEntry(sessionId, stepCacheKey);

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

      if (decision.type === "allow_rate_limited") {
        const scopeStr = decision.scope;
        const sessionCache = this.getSessionCache(sessionId);
        for (const perm of missing) {
          PermissionEngine.validateWildcardScope(perm.scope);
          const grant: PermissionGrant = {
            scope: perm.scope,
            decision: scopeStr === "session" ? "allow_session" : "allow_always",
            granted_by: "user",
            granted_at: now,
            ttl: scopeStr === "session" ? "session" : "global",
          };
          sessionCache.set(perm.scope, grant);
          // Initialize rate bucket (consuming one token for this call)
          const bucketKey = `${sessionId}:${perm.scope}`;
          this.rateBuckets.set(bucketKey, {
            tokens: decision.max_calls_per_window - 1,
            windowStart: Date.now(),
            maxCalls: decision.max_calls_per_window,
            windowMs: decision.window_ms,
          });
          let sessionBuckets = this.rateBucketsBySession.get(sessionId);
          if (!sessionBuckets) {
            sessionBuckets = new Set();
            this.rateBucketsBySession.set(sessionId, sessionBuckets);
          }
          sessionBuckets.add(bucketKey);
        }

        await this.journal.emit(sessionId, "permission.granted", {
          request_id: request.request_id,
          step_id: request.step_id,
          tool_name: request.tool_name,
          scopes: missing.map((p) => p.scope),
          decision: "allow_rate_limited",
          max_calls_per_window: decision.max_calls_per_window,
          window_ms: decision.window_ms,
        });

        return { allowed: true };
      }

      if (decision.type === "allow_time_bounded") {
        const scopeStr = decision.scope;
        const sessionCache = this.getSessionCache(sessionId);
        for (const perm of missing) {
          PermissionEngine.validateWildcardScope(perm.scope);
          const grant: PermissionGrant = {
            scope: perm.scope,
            decision: scopeStr === "session" ? "allow_session" : "allow_always",
            granted_by: "user",
            granted_at: now,
            ttl: scopeStr === "session" ? "session" : "global",
          };
          sessionCache.set(perm.scope, grant);
          // Store time bound
          const boundKey = `${sessionId}:${perm.scope}`;
          this.timeBounds.set(boundKey, {
            cronExpression: decision.cron_expression,
            windowDurationMs: decision.window_duration_ms,
            timezone: decision.timezone,
          });
          let sessionBounds = this.timeBoundsBySession.get(sessionId);
          if (!sessionBounds) {
            sessionBounds = new Set();
            this.timeBoundsBySession.set(sessionId, sessionBounds);
          }
          sessionBounds.add(boundKey);
        }

        await this.journal.emit(sessionId, "permission.granted", {
          request_id: request.request_id,
          step_id: request.step_id,
          tool_name: request.tool_name,
          scopes: missing.map((p) => p.scope),
          decision: "allow_time_bounded",
          cron_expression: decision.cron_expression,
          window_duration_ms: decision.window_duration_ms,
          timezone: decision.timezone,
        });

        return { allowed: true };
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
      PermissionEngine.validateWildcardScope(scope);
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

  private addConstraintCacheEntry(sessionId: string, key: string, constraints: PermissionConstraints): void {
    if (this.constraintCache.size >= MAX_CONSTRAINT_CACHE) {
      const oldest = this.constraintCache.keys().next().value;
      if (oldest !== undefined) {
        this.constraintCache.delete(oldest);
        const oldSession = oldest.split(":")[0]!;
        this.constraintCacheBySession.get(oldSession)?.delete(oldest);
      }
    }
    this.constraintCache.set(key, constraints);
    let sessionKeys = this.constraintCacheBySession.get(sessionId);
    if (!sessionKeys) {
      sessionKeys = new Set();
      this.constraintCacheBySession.set(sessionId, sessionKeys);
    }
    sessionKeys.add(key);
  }

  private addObservedCacheEntry(sessionId: string, key: string): void {
    if (this.observedCache.size >= MAX_OBSERVED_CACHE) {
      const oldest = this.observedCache.values().next().value;
      if (oldest !== undefined) {
        this.observedCache.delete(oldest);
        const oldSession = oldest.split(":")[0]!;
        this.observedCacheBySession.get(oldSession)?.delete(oldest);
      }
    }
    this.observedCache.add(key);
    let sessionKeys = this.observedCacheBySession.get(sessionId);
    if (!sessionKeys) {
      sessionKeys = new Set();
      this.observedCacheBySession.set(sessionId, sessionKeys);
    }
    sessionKeys.add(key);
  }

  private consumeRateToken(sessionId: string, scope: string): boolean {
    const key = `${sessionId}:${scope}`;
    const bucket = this.rateBuckets.get(key);
    if (!bucket) return true;
    const now = Date.now();
    if (now - bucket.windowStart >= bucket.windowMs) {
      bucket.tokens = bucket.maxCalls - 1;
      bucket.windowStart = now;
      return true;
    }
    if (bucket.tokens > 0) {
      bucket.tokens--;
      return true;
    }
    return false;
  }

  private isWithinTimeBound(sessionId: string, scope: string): boolean {
    const key = `${sessionId}:${scope}`;
    const bound = this.timeBounds.get(key);
    if (!bound) return true;
    try {
      const opts: { currentDate?: Date; tz?: string } = { currentDate: new Date() };
      if (bound.timezone) opts.tz = bound.timezone;
      const interval = parseExpression(bound.cronExpression, opts);
      const prevTrigger = interval.prev().getTime();
      return (Date.now() - prevTrigger) < bound.windowDurationMs;
    } catch {
      return false; // Invalid cron — deny
    }
  }

  isGranted(scope: string, sessionId?: string): boolean {
    if (!sessionId) return false;
    const sessionCache = this.sessionCaches.get(sessionId);
    if (!sessionCache) return false;
    const hasExact = sessionCache.has(scope);
    let hasWildcard = false;
    if (!hasExact) {
      for (const grantScope of sessionCache.keys()) {
        if (grantScope.includes("*") && PermissionEngine.scopeMatchesGrant(grantScope, scope)) {
          hasWildcard = true;
          break;
        }
      }
    }
    if (!hasExact && !hasWildcard) return false;
    // Rate-limit check (consumes a token)
    if (!this.consumeRateToken(sessionId, scope)) return false;
    // Time-bound check
    if (!this.isWithinTimeBound(sessionId, scope)) return false;
    return true;
  }

  clearSession(sessionId?: string): void {
    if (sessionId) {
      this.sessionCaches.delete(sessionId);
      this.promptLocks.delete(sessionId);
      // O(1) cleanup using secondary indices
      const constraintKeys = this.constraintCacheBySession.get(sessionId);
      if (constraintKeys) {
        for (const key of constraintKeys) this.constraintCache.delete(key);
        this.constraintCacheBySession.delete(sessionId);
      }
      const observedKeys = this.observedCacheBySession.get(sessionId);
      if (observedKeys) {
        for (const key of observedKeys) this.observedCache.delete(key);
        this.observedCacheBySession.delete(sessionId);
      }
      const rateBucketKeys = this.rateBucketsBySession.get(sessionId);
      if (rateBucketKeys) {
        for (const key of rateBucketKeys) this.rateBuckets.delete(key);
        this.rateBucketsBySession.delete(sessionId);
      }
      const timeBoundKeys = this.timeBoundsBySession.get(sessionId);
      if (timeBoundKeys) {
        for (const key of timeBoundKeys) this.timeBounds.delete(key);
        this.timeBoundsBySession.delete(sessionId);
      }
    } else {
      this.sessionCaches.clear();
      this.promptLocks.clear();
      this.constraintCache.clear();
      this.constraintCacheBySession.clear();
      this.observedCache.clear();
      this.observedCacheBySession.clear();
      this.rateBuckets.clear();
      this.rateBucketsBySession.clear();
      this.timeBounds.clear();
      this.timeBoundsBySession.clear();
    }
  }

  clearStep(sessionId?: string): void {
    const caches = sessionId
      ? [this.sessionCaches.get(sessionId)].filter(Boolean) as Map<string, PermissionGrant>[]
      : [...this.sessionCaches.values()];
    for (const cache of caches) {
      for (const [scope, grant] of cache) {
        if (grant.ttl === "step") cache.delete(scope);
      }
    }
  }

  listGrants(sessionId?: string): PermissionGrant[] {
    if (!sessionId) return [];
    const sessionCache = this.sessionCaches.get(sessionId);
    if (!sessionCache) return [];
    return [...sessionCache.values()];
  }

  async notifyObservedExecution(sessionId: string, toolName: string, input: Record<string, unknown>): Promise<void> {
    if (!this.externalAuditHook) return;
    try {
      await this.externalAuditHook({ session_id: sessionId, tool_name: toolName, input, timestamp: new Date().toISOString() });
    } catch {
      /* swallow — hook failure must not block execution */
    }
  }

  setDCTEnforcer(enforcer: DCTEnforcer): void {
    this.dctEnforcer = enforcer;
  }

  getPromptFn(): ApprovalPromptFn {
    return this.promptFn;
  }
}

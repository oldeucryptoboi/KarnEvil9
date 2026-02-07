import type {
  Permission,
  PermissionGrant,
  PermissionRequest,
  ApprovalDecision,
} from "@openflaw/schemas";
import type { Journal } from "@openflaw/journal";

export type ApprovalPromptFn = (
  request: PermissionRequest
) => Promise<ApprovalDecision>;

export class PermissionEngine {
  private sessionCache = new Map<string, PermissionGrant>();
  private globalCache = new Map<string, PermissionGrant>();
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

  async check(request: PermissionRequest): Promise<boolean> {
    const missing: Permission[] = [];
    for (const perm of request.permissions) {
      if (!this.isGranted(perm.scope)) missing.push(perm);
    }
    if (missing.length === 0) return true;

    await this.journal.emit(request.session_id, "permission.requested", {
      request_id: request.request_id,
      step_id: request.step_id,
      tool_name: request.tool_name,
      scopes: missing.map((p) => p.scope),
    });

    const decision = await this.promptFn({ ...request, permissions: missing });
    const now = new Date().toISOString();

    if (decision === "deny") {
      await this.journal.emit(request.session_id, "permission.denied", {
        request_id: request.request_id,
        step_id: request.step_id,
        tool_name: request.tool_name,
        scopes: missing.map((p) => p.scope),
      });
      return false;
    }

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
        this.sessionCache.set(perm.scope, grant);
      }
    }

    await this.journal.emit(request.session_id, "permission.granted", {
      request_id: request.request_id,
      step_id: request.step_id,
      tool_name: request.tool_name,
      scopes: missing.map((p) => p.scope),
      decision,
    });

    return true;
  }

  isGranted(scope: string): boolean {
    return this.sessionCache.has(scope) || this.globalCache.has(scope);
  }

  clearSession(): void {
    this.sessionCache.clear();
  }

  clearStep(): void {
    for (const [scope, grant] of this.sessionCache) {
      if (grant.ttl === "step") this.sessionCache.delete(scope);
    }
  }

  listGrants(): PermissionGrant[] {
    const grants = new Map<string, PermissionGrant>();
    for (const [scope, grant] of this.globalCache) grants.set(scope, grant);
    for (const [scope, grant] of this.sessionCache) grants.set(scope, grant);
    return [...grants.values()];
  }
}

import type { DataAccessScope, SwarmTaskConstraints } from "./types.js";

export class DataAccessGuard {
  private scope: DataAccessScope;

  constructor(scope: DataAccessScope) {
    this.scope = scope;
  }

  validatePath(path: string): { allowed: boolean; reason?: string } {
    // Check denied paths first (takes precedence)
    if (this.scope.denied_paths) {
      for (const denied of this.scope.denied_paths) {
        if (this.pathMatches(path, denied)) {
          return { allowed: false, reason: `Path '${path}' matches denied pattern '${denied}'` };
        }
      }
    }

    // Check allowed paths (if specified, path must match at least one)
    if (this.scope.allowed_paths && this.scope.allowed_paths.length > 0) {
      const isAllowed = this.scope.allowed_paths.some((allowed) => this.pathMatches(path, allowed));
      if (!isAllowed) {
        return { allowed: false, reason: `Path '${path}' not in allowed paths` };
      }
    }

    return { allowed: true };
  }

  redactSensitiveFields(data: Record<string, unknown>): Record<string, unknown> {
    if (!this.scope.sensitive_fields || this.scope.sensitive_fields.length === 0) {
      return data;
    }

    const sensitiveSet = new Set(this.scope.sensitive_fields);
    return this.deepRedact(data, sensitiveSet);
  }

  checkDataSize(sizeBytes: number): { allowed: boolean; reason?: string } {
    if (this.scope.max_data_size_bytes === undefined) {
      return { allowed: true };
    }
    if (sizeBytes > this.scope.max_data_size_bytes) {
      return {
        allowed: false,
        reason: `Data size ${sizeBytes} bytes exceeds limit of ${this.scope.max_data_size_bytes} bytes`,
      };
    }
    return { allowed: true };
  }

  toConstraints(): Partial<SwarmTaskConstraints> {
    return {
      // Map allowed paths to tool allowlist (if path-based tools are involved)
      tool_allowlist: this.scope.allowed_paths ? ["read-file", "write-file"] : undefined,
    };
  }

  getScope(): DataAccessScope {
    return {
      ...this.scope,
      allowed_paths: this.scope.allowed_paths ? [...this.scope.allowed_paths] : undefined,
      denied_paths: this.scope.denied_paths ? [...this.scope.denied_paths] : undefined,
      sensitive_fields: this.scope.sensitive_fields ? [...this.scope.sensitive_fields] : undefined,
    };
  }

  // ─── Internal ────────────────────────────────────────────────────

  private pathMatches(path: string, pattern: string): boolean {
    // Support simple wildcard patterns
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return path.startsWith(prefix);
    }
    if (pattern.endsWith("/")) {
      return path.startsWith(pattern) || path === pattern.slice(0, -1);
    }
    return path === pattern;
  }

  private deepRedact(obj: Record<string, unknown>, sensitiveFields: Set<string>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (sensitiveFields.has(key)) {
        result[key] = "[REDACTED]";
      } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        result[key] = this.deepRedact(value as Record<string, unknown>, sensitiveFields);
      } else {
        result[key] = value;
      }
    }
    return result;
  }
}

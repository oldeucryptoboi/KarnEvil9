import { v4 as uuid } from "uuid";
import type {
  ToolManifest,
  ToolCategory,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolHandler,
  Permission,
  PermissionRequest,
  PolicyProfile,
  PermissionCheckResult,
} from "@karnevil9/schemas";
import { validateToolInput, validateToolOutput } from "@karnevil9/schemas";
import { PermissionEngine } from "@karnevil9/permissions";
import type { Journal } from "@karnevil9/journal";
import { ToolRegistry } from "./tool-registry.js";
import { PolicyViolationError } from "./policy-enforcer.js";

export type { ToolHandler } from "@karnevil9/schemas";

export type BreakerState = "closed" | "open" | "half_open";

export interface CategoryConfig {
  threshold: number;
  cooldownMs: number;
}

const DEFAULT_CATEGORY_CONFIGS: Record<string, CategoryConfig> = {
  llm: { threshold: 3, cooldownMs: 60000 },
  browser: { threshold: 5, cooldownMs: 30000 },
  shell: { threshold: 3, cooldownMs: 15000 },
  http: { threshold: 3, cooldownMs: 30000 },
  social: { threshold: 2, cooldownMs: 60000 },
  filesystem: { threshold: 5, cooldownMs: 30000 },
};

interface ToolBreakerEntry {
  count: number;
  trippedAt: number;
  state: BreakerState;
  category?: ToolCategory;
}

export class CircuitBreaker {
  private entries = new Map<string, ToolBreakerEntry>();
  private threshold: number;
  private cooldownMs: number;
  private categoryDefaults: Record<string, CategoryConfig>;

  constructor(threshold = 5, cooldownMs = 30000, categoryDefaults?: Record<string, CategoryConfig>) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.categoryDefaults = categoryDefaults ?? DEFAULT_CATEGORY_CONFIGS;
  }

  setCategory(toolName: string, category: ToolCategory): void {
    const entry = this.entries.get(toolName);
    if (entry) {
      entry.category = category;
    } else {
      this.entries.set(toolName, { count: 0, trippedAt: 0, state: "closed", category });
    }
  }

  private configFor(toolName: string): { threshold: number; cooldownMs: number } {
    const entry = this.entries.get(toolName);
    const cat = entry?.category;
    if (cat && this.categoryDefaults[cat]) {
      return this.categoryDefaults[cat];
    }
    return { threshold: this.threshold, cooldownMs: this.cooldownMs };
  }

  recordFailure(toolName: string, retriable = true): void {
    const entry = this.entries.get(toolName) ?? { count: 0, trippedAt: 0, state: "closed" as BreakerState };
    if (!this.entries.has(toolName)) this.entries.set(toolName, entry);

    if (!retriable) return;

    const { threshold } = this.configFor(toolName);

    if (entry.state === "half_open") {
      // Probe failed — back to open
      entry.state = "open";
      entry.trippedAt = Date.now();
      return;
    }

    entry.count++;
    if (entry.count >= threshold) {
      entry.trippedAt = Date.now();
      entry.state = "open";
    }
  }

  recordSuccess(toolName: string): void {
    this.entries.delete(toolName);
  }

  isOpen(toolName: string): boolean {
    const entry = this.entries.get(toolName);
    if (!entry || entry.state === "closed") return false;

    if (entry.state === "half_open") {
      // Already half-open, block until probe resolves
      return true;
    }

    // state === "open"
    const { cooldownMs } = this.configFor(toolName);
    const elapsed = Date.now() - entry.trippedAt;
    if (elapsed >= cooldownMs) {
      entry.state = "half_open";
      return false;
    }
    return true;
  }

  getState(toolName: string): BreakerState {
    const entry = this.entries.get(toolName);
    if (!entry) return "closed";
    return entry.state;
  }
}

export class ToolRuntime {
  private registry: ToolRegistry;
  private permissions: PermissionEngine;
  private journal: Journal;
  private policy: PolicyProfile;
  private handlers = new Map<string, ToolHandler>();
  private breaker = new CircuitBreaker();

  constructor(registry: ToolRegistry, permissions: PermissionEngine, journal: Journal, policy?: PolicyProfile) {
    this.registry = registry;
    this.permissions = permissions;
    this.journal = journal;
    this.policy = policy ?? { allowed_paths: [], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false };
  }

  registerHandler(toolName: string, handler: ToolHandler): void {
    if (this.handlers.has(toolName)) {
      throw new Error(`Handler already registered for tool "${toolName}". Unregister first.`);
    }
    this.handlers.set(toolName, handler);
  }

  unregisterHandler(toolName: string): void {
    this.handlers.delete(toolName);
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const manifest = this.registry.get(request.tool_name);
    if (!manifest) {
      return this.fail(request, startTime, "TOOL_NOT_FOUND", `Tool "${request.tool_name}" not registered`);
    }

    if (manifest.category) {
      this.breaker.setCategory(request.tool_name, manifest.category);
    }

    if (this.breaker.isOpen(request.tool_name)) {
      return this.fail(request, startTime, "CIRCUIT_BREAKER_OPEN", `Circuit breaker open for tool "${request.tool_name}"`);
    }

    const inputValidation = validateToolInput(request.input, manifest.input_schema);
    if (!inputValidation.valid) {
      return this.fail(request, startTime, "INVALID_INPUT", `Input validation failed: ${inputValidation.errors.join(", ")}`);
    }

    let permResult: PermissionCheckResult;
    try {
      permResult = await this.checkPermissions(request, manifest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.fail(request, startTime, "PERMISSION_DENIED", `Permission check failed: ${message}`);
    }
    if (!permResult.allowed) {
      const msg = permResult.alternative
        ? `Permission denied. Try "${permResult.alternative.tool_name}" instead.`
        : "Required permissions were denied";
      return this.fail(request, startTime, "PERMISSION_DENIED", msg);
    }

    // Apply constraints — input overrides
    if (permResult.constraints?.input_overrides) {
      request = { ...request, input: { ...request.input, ...permResult.constraints.input_overrides } };
      // Re-validate input after overrides to prevent constraint-based injection
      const revalidation = validateToolInput(request.input, manifest.input_schema);
      if (!revalidation.valid) {
        return this.fail(request, startTime, "INVALID_INPUT", `Input validation failed after constraint overrides: ${revalidation.errors.join(", ")}`);
      }
    }

    // Apply path constraints to effective policy
    let effectivePolicy = this.policy;
    if (permResult.constraints?.readonly_paths || permResult.constraints?.writable_paths) {
      effectivePolicy = {
        ...this.policy,
        readonly_paths: permResult.constraints.readonly_paths,
        writable_paths: permResult.constraints.writable_paths,
      };
    }

    // Observed execution telemetry
    if (permResult.observed) {
      await this.journal.emit(request.session_id, "permission.observed_execution", {
        tool_name: request.tool_name,
        input: request.input,
      });
      await this.permissions.notifyObservedExecution(request.session_id, request.tool_name, request.input);
    }

    await this.journal.emit(request.session_id, "tool.started", {
      request_id: request.request_id,
      tool_name: request.tool_name,
      mode: request.mode,
      step_id: request.step_id,
    });

    try {
      const timeoutOverride = permResult.constraints?.max_duration_ms;
      const output = await this.executeWithTimeout(request, manifest, effectivePolicy, timeoutOverride);

      const outputValidation = validateToolOutput(output, manifest.output_schema);
      if (!outputValidation.valid) {
        this.breaker.recordFailure(request.tool_name, false);
        return this.fail(request, startTime, "INVALID_OUTPUT", `Output validation failed: ${outputValidation.errors.join(", ")}`);
      }

      // Apply output allowlist first (maximally restrictive), then redact
      let finalOutput = output;
      if (permResult.constraints?.output_allow_fields && finalOutput && typeof finalOutput === "object") {
        const allowed = new Set(permResult.constraints.output_allow_fields);
        const filtered: Record<string, unknown> = {};
        for (const field of allowed) {
          if (field in (finalOutput as Record<string, unknown>))
            filtered[field] = (finalOutput as Record<string, unknown>)[field];
        }
        finalOutput = filtered;
      }

      // Apply output redaction if constraints specify fields to redact
      if (permResult.constraints?.output_redact_fields && finalOutput && typeof finalOutput === "object") {
        const redacted = { ...(finalOutput as Record<string, unknown>) };
        for (const field of permResult.constraints.output_redact_fields) {
          if (field in redacted) redacted[field] = "[REDACTED]";
        }
        finalOutput = redacted;
      }

      const result: ToolExecutionResult = {
        request_id: request.request_id,
        ok: true,
        result: finalOutput,
        duration_ms: Date.now() - startTime,
        mode: request.mode,
      };

      await this.journal.emit(request.session_id, "tool.succeeded", {
        request_id: request.request_id,
        tool_name: request.tool_name,
        duration_ms: result.duration_ms,
      });

      this.breaker.recordSuccess(request.tool_name);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.breaker.recordFailure(request.tool_name, !(err instanceof PolicyViolationError));
      if (err instanceof PolicyViolationError) {
        await this.journal.emit(request.session_id, "policy.violated", {
          request_id: request.request_id,
          tool_name: request.tool_name,
          violation_code: "POLICY_VIOLATION",
          violation_message: message,
        });
        return this.fail(request, startTime, "POLICY_VIOLATION", message);
      }
      return this.fail(request, startTime, "EXECUTION_ERROR", message);
    }
  }

  private async checkPermissions(request: ToolExecutionRequest, manifest: ToolManifest): Promise<PermissionCheckResult> {
    if (manifest.permissions.length === 0) return { allowed: true };
    const permissions: Permission[] = manifest.permissions.map((scope) => PermissionEngine.parse(scope));
    const permRequest: PermissionRequest = {
      request_id: uuid(),
      session_id: request.session_id,
      step_id: request.step_id,
      tool_name: request.tool_name,
      permissions,
    };
    return this.permissions.check(permRequest);
  }

  private async executeWithTimeout(request: ToolExecutionRequest, manifest: ToolManifest, effectivePolicy: PolicyProfile, timeoutOverride?: number): Promise<unknown> {
    if (request.mode === "mock") return this.executeMock(manifest);
    const handler = this.handlers.get(request.tool_name);
    if (!handler) throw new Error(`No handler registered for tool "${request.tool_name}"`);
    const timeout = timeoutOverride ?? manifest.timeout_ms ?? 60000;
    if (timeout <= 0) {
      return handler(request.input, request.mode, effectivePolicy);
    }
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        handler(request.input, request.mode, effectivePolicy),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Tool "${request.tool_name}" timed out after ${timeout}ms`)), timeout);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private executeMock(manifest: ToolManifest): unknown {
    if (manifest.mock_responses && manifest.mock_responses.length > 0) return manifest.mock_responses[0];
    return {};
  }

  private async fail(request: ToolExecutionRequest, startTime: number, code: string, message: string): Promise<ToolExecutionResult> {
    const result: ToolExecutionResult = {
      request_id: request.request_id,
      ok: false,
      error: { code, message },
      duration_ms: Date.now() - startTime,
      mode: request.mode,
    };
    await this.journal.emit(request.session_id, "tool.failed", {
      request_id: request.request_id,
      tool_name: request.tool_name,
      error_code: code,
      error_message: message,
      duration_ms: result.duration_ms,
    });
    return result;
  }
}

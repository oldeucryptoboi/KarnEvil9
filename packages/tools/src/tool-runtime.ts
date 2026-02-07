import { v4 as uuid } from "uuid";
import type {
  ToolManifest,
  ToolExecutionRequest,
  ToolExecutionResult,
  ExecutionMode,
  Permission,
  PermissionRequest,
} from "@openflaw/schemas";
import { validateToolInput, validateToolOutput } from "@openflaw/schemas";
import { PermissionEngine } from "@openflaw/permissions";
import type { Journal } from "@openflaw/journal";
import { ToolRegistry } from "./tool-registry.js";

export type ToolHandler = (
  input: Record<string, unknown>,
  mode: ExecutionMode
) => Promise<unknown>;

export class ToolRuntime {
  private registry: ToolRegistry;
  private permissions: PermissionEngine;
  private journal: Journal;
  private handlers = new Map<string, ToolHandler>();

  constructor(registry: ToolRegistry, permissions: PermissionEngine, journal: Journal) {
    this.registry = registry;
    this.permissions = permissions;
    this.journal = journal;
  }

  registerHandler(toolName: string, handler: ToolHandler): void {
    this.handlers.set(toolName, handler);
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const manifest = this.registry.get(request.tool_name);
    if (!manifest) {
      return this.fail(request, startTime, "TOOL_NOT_FOUND", `Tool "${request.tool_name}" not registered`);
    }

    const inputValidation = validateToolInput(request.input, manifest.input_schema);
    if (!inputValidation.valid) {
      return this.fail(request, startTime, "INVALID_INPUT", `Input validation failed: ${inputValidation.errors.join(", ")}`);
    }

    const permissionsOk = await this.checkPermissions(request, manifest);
    if (!permissionsOk) {
      return this.fail(request, startTime, "PERMISSION_DENIED", "Required permissions were denied");
    }

    await this.journal.emit(request.session_id, "tool.started", {
      request_id: request.request_id,
      tool_name: request.tool_name,
      mode: request.mode,
      step_id: request.step_id,
    });

    try {
      const output = await this.executeWithTimeout(request, manifest);

      const outputValidation = validateToolOutput(output, manifest.output_schema);
      if (!outputValidation.valid) {
        return this.fail(request, startTime, "INVALID_OUTPUT", `Output validation failed: ${outputValidation.errors.join(", ")}`);
      }

      const result: ToolExecutionResult = {
        request_id: request.request_id,
        ok: true,
        result: output,
        duration_ms: Date.now() - startTime,
        mode: request.mode,
      };

      await this.journal.emit(request.session_id, "tool.succeeded", {
        request_id: request.request_id,
        tool_name: request.tool_name,
        duration_ms: result.duration_ms,
      });

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.fail(request, startTime, "EXECUTION_ERROR", message);
    }
  }

  private async checkPermissions(request: ToolExecutionRequest, manifest: ToolManifest): Promise<boolean> {
    if (manifest.permissions.length === 0) return true;
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

  private async executeWithTimeout(request: ToolExecutionRequest, manifest: ToolManifest): Promise<unknown> {
    if (request.mode === "mock") return this.executeMock(manifest);
    const handler = this.handlers.get(request.tool_name);
    if (!handler) throw new Error(`No handler registered for tool "${request.tool_name}"`);
    return Promise.race([
      handler(request.input, request.mode),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool "${request.tool_name}" timed out after ${manifest.timeout_ms}ms`)), manifest.timeout_ms)
      ),
    ]);
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

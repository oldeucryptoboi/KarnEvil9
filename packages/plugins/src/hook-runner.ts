import type {
  HookName,
  HookContext,
  HookResult,
  HookRegistration,
} from "@jarvis/schemas";
import type { Journal } from "@jarvis/journal";
import { CircuitBreaker } from "@jarvis/tools";

const VALID_ACTIONS = new Set(["continue", "modify", "block", "observe"]);
const BLOCKABLE_HOOKS: Set<HookName> = new Set([
  "before_session_start", "before_plan", "before_step", "before_tool_call",
]);
const MAX_HOOK_DATA_SIZE = 64 * 1024; // 64KB max for hook data

function validateHookResult(result: unknown, hookName: HookName, pluginId: string): HookResult {
  if (!result || typeof result !== "object") {
    throw new Error(`Plugin "${pluginId}" hook "${hookName}" returned non-object result`);
  }
  const r = result as Record<string, unknown>;
  if (typeof r.action !== "string" || !VALID_ACTIONS.has(r.action)) {
    throw new Error(`Plugin "${pluginId}" hook "${hookName}" returned invalid action: "${r.action}"`);
  }
  if (r.action === "block" && !BLOCKABLE_HOOKS.has(hookName)) {
    throw new Error(`Plugin "${pluginId}" hook "${hookName}" cannot use "block" action (only before_* hooks can block)`);
  }
  if ((r.action === "modify" || r.action === "continue") && r.data != null) {
    if (typeof r.data !== "object") {
      throw new Error(`Plugin "${pluginId}" hook "${hookName}" returned non-object data`);
    }
    const serialized = JSON.stringify(r.data);
    if (serialized.length > MAX_HOOK_DATA_SIZE) {
      throw new Error(`Plugin "${pluginId}" hook "${hookName}" data exceeds ${MAX_HOOK_DATA_SIZE} bytes`);
    }
    // Deep clone to prevent reference sharing between plugins
    r.data = JSON.parse(serialized);
  }
  return result as HookResult;
}

export class HookRunner {
  private hooks = new Map<HookName, HookRegistration[]>();
  private breakers = new Map<string, CircuitBreaker>();
  private journal: Journal;

  constructor(journal: Journal) {
    this.journal = journal;
  }

  register(reg: HookRegistration): void {
    const list = this.hooks.get(reg.hook) ?? [];
    list.push(reg);
    list.sort((a, b) => a.priority - b.priority);
    this.hooks.set(reg.hook, list);
  }

  unregisterPlugin(pluginId: string): void {
    for (const [hookName, registrations] of this.hooks) {
      const filtered = registrations.filter((r) => r.plugin_id !== pluginId);
      if (filtered.length === 0) {
        this.hooks.delete(hookName);
      } else {
        this.hooks.set(hookName, filtered);
      }
    }
    this.breakers.delete(pluginId);
  }

  private getBreaker(pluginId: string): CircuitBreaker {
    let breaker = this.breakers.get(pluginId);
    if (!breaker) {
      breaker = new CircuitBreaker(5, 30000);
      this.breakers.set(pluginId, breaker);
    }
    return breaker;
  }

  async run(hookName: HookName, context: HookContext): Promise<HookResult> {
    const registrations = this.hooks.get(hookName);
    if (!registrations || registrations.length === 0) {
      return { action: "continue" };
    }

    let mergedData: Record<string, unknown> = {};

    for (const reg of registrations) {
      const breaker = this.getBreaker(reg.plugin_id);

      if (breaker.isOpen(reg.plugin_id)) {
        await this.journal.tryEmit(context.session_id, "plugin.hook_circuit_open", {
          plugin_id: reg.plugin_id,
          hook: hookName,
        });
        continue;
      }

      let result: HookResult;
      try {
        const hookTimeout = reg.timeout_ms && reg.timeout_ms > 0 ? reg.timeout_ms : 5000;
        const raw = await Promise.race([
          reg.handler({ ...context, ...mergedData }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Hook "${hookName}" from plugin "${reg.plugin_id}" timed out after ${hookTimeout}ms`)),
              hookTimeout
            )
          ),
        ]);
        result = validateHookResult(raw, hookName, reg.plugin_id);
      } catch (err) {
        breaker.recordFailure(reg.plugin_id);
        await this.journal.tryEmit(context.session_id, "plugin.hook_failed", {
          plugin_id: reg.plugin_id,
          hook: hookName,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      breaker.recordSuccess(reg.plugin_id);

      await this.journal.tryEmit(context.session_id, "plugin.hook_fired", {
        plugin_id: reg.plugin_id,
        hook: hookName,
        action: result.action,
      });

      if (result.action === "block") {
        return result;
      }

      if (result.action === "modify" && result.data) {
        mergedData = { ...mergedData, ...result.data };
      }

      if (result.action === "continue" && result.data) {
        mergedData = { ...mergedData, ...result.data };
      }
    }

    if (Object.keys(mergedData).length > 0) {
      return { action: "modify", data: mergedData };
    }
    return { action: "continue" };
  }
}

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { MockPlanner } from "@karnevil9/planner";
import { Kernel } from "@karnevil9/kernel";
import { PluginRegistry } from "@karnevil9/plugins";
import type { Task, PermissionRequest, ApprovalDecision } from "@karnevil9/schemas";

const ROOT = resolve(import.meta.dirname ?? ".", "../..");
const TOOLS_DIR = join(ROOT, "tools/examples");
const PLUGINS_DIR = join(ROOT, "plugins");

describe("Pre-Grant Smoke", () => {
  let testDir: string;
  let journal: Journal;
  let registry: ToolRegistry;

  beforeEach(async () => {
    testDir = join(tmpdir(), `karnevil9-e2e-pregrant-${uuid()}`);
    journal = new Journal(join(testDir, "journal.jsonl"), { fsync: false, redact: false });
    await journal.init();
    registry = new ToolRegistry();
    await registry.loadFromDirectory(TOOLS_DIR);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("pre-granted scopes allow tool execution without prompting", async () => {
    const promptCalls: PermissionRequest[] = [];
    const denyPrompt = async (request: PermissionRequest): Promise<ApprovalDecision> => {
      promptCalls.push(request);
      return "deny";
    };

    const permissions = new PermissionEngine(journal, denyPrompt);
    const runtime = new ToolRuntime(registry, permissions, journal);

    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      planner: new MockPlanner(),
      mode: "mock",
      limits: { max_steps: 20, max_duration_ms: 30000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
      // Pre-grant every scope the registered tools need, so MockPlanner's
      // chosen tool (whichever is first) will be covered.
      preGrantedScopes: registry.list().flatMap((t) => t.permissions),
    });

    const task: Task = {
      task_id: uuid(),
      text: "Pre-grant smoke: read a file without prompting",
      created_at: new Date().toISOString(),
    };

    await kernel.createSession(task);
    const session = await kernel.run();

    // Session should complete — the pre-grant bypasses the deny prompt
    expect(session.status).toBe("completed");

    // The deny prompt should never have been called
    expect(promptCalls).toHaveLength(0);

    // No permission.requested events should appear in the journal
    const events = await journal.readAll();
    const permissionRequested = events.filter((e) => e.type === "permission.requested");
    expect(permissionRequested).toHaveLength(0);
  });

  it("getPluginPermissions collects scopes from active plugins", async () => {
    const permissions = new PermissionEngine(journal, async () => "allow_always");
    const runtime = new ToolRuntime(registry, permissions, journal);

    const pluginRegistry = new PluginRegistry({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      pluginsDir: PLUGINS_DIR,
    });
    await pluginRegistry.discoverAndLoadAll();

    // Verify getPluginPermissions returns known Moltbook scopes
    const scopes = pluginRegistry.getPluginPermissions();
    expect(scopes).toContain("moltbook:send:posts");
    expect(scopes).toContain("moltbook:send:dm");
    expect(scopes).toContain("moltbook:read:dm");
    expect(scopes).toContain("moltbook:send:follows");
    expect(scopes).toContain("moltbook:read:notifications");

    // Use those scopes as preGrantedScopes in a kernel session
    const kernel = new Kernel({
      journal,
      toolRegistry: registry,
      toolRuntime: runtime,
      permissions,
      pluginRegistry,
      planner: new MockPlanner(),
      mode: "mock",
      limits: { max_steps: 20, max_duration_ms: 30000, max_cost_usd: 10, max_tokens: 100000 },
      policy: { allowed_paths: [process.cwd()], allowed_endpoints: [], allowed_commands: [], require_approval_for_writes: false },
      preGrantedScopes: scopes,
    });

    const task: Task = {
      task_id: uuid(),
      text: "Plugin pre-grant integration smoke test",
      created_at: new Date().toISOString(),
    };

    await kernel.createSession(task);
    const session = await kernel.run();

    expect(session.status).toBe("completed");
  });
});

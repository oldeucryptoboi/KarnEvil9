import { describe, it, expect } from "vitest";
import type { PluginManifest, ToolManifest } from "@openvger/schemas";
import { PluginApiImpl } from "./plugin-api-impl.js";
import { PluginLoggerImpl } from "./plugin-logger.js";

describe("PluginApiImpl", () => {
  function makeManifest(provides?: PluginManifest["provides"]): PluginManifest {
    return {
      id: "test-plugin",
      name: "Test Plugin",
      version: "1.0.0",
      description: "Test",
      entry: "index.js",
      permissions: [],
      provides: provides ?? {
        tools: ["my-tool"],
        hooks: ["before_step"],
        commands: ["my-cmd"],
      },
    };
  }

  function makeToolManifest(name = "my-tool"): ToolManifest {
    return {
      name,
      version: "1.0.0",
      description: "A tool",
      runner: "internal",
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      permissions: [],
      timeout_ms: 5000,
      supports: { mock: true, dry_run: false },
    };
  }

  it("validates tool registrations match provides", () => {
    const manifest = makeManifest();
    const api = new PluginApiImpl(manifest, {}, new PluginLoggerImpl("test-plugin"));

    // Should succeed — "my-tool" is declared
    api.registerTool(makeToolManifest("my-tool"), async () => ({}));
    expect(api._tools).toHaveLength(1);
  });

  it("rejects undeclared tool registrations", () => {
    const manifest = makeManifest();
    const api = new PluginApiImpl(manifest, {}, new PluginLoggerImpl("test-plugin"));

    expect(() => {
      api.registerTool(makeToolManifest("unknown-tool"), async () => ({}));
    }).toThrow("not declared in provides.tools");
  });

  it("validates hook registrations match provides", () => {
    const manifest = makeManifest();
    const api = new PluginApiImpl(manifest, {}, new PluginLoggerImpl("test-plugin"));

    api.registerHook("before_step", async () => ({ action: "observe" }));
    expect(api._hooks).toHaveLength(1);
  });

  it("rejects undeclared hook registrations", () => {
    const manifest = makeManifest();
    const api = new PluginApiImpl(manifest, {}, new PluginLoggerImpl("test-plugin"));

    expect(() => {
      api.registerHook("after_plan", async () => ({ action: "observe" }));
    }).toThrow("not declared in provides.hooks");
  });

  it("forces route path prefix", () => {
    const manifest = makeManifest({ routes: ["status"] });
    const api = new PluginApiImpl(manifest, {}, new PluginLoggerImpl("test-plugin"));

    api.registerRoute("GET", "status", async () => {});
    expect(api._routes[0]!.path).toBe("/api/plugins/test-plugin/status");
  });

  it("validates command registrations match provides", () => {
    const manifest = makeManifest();
    const api = new PluginApiImpl(manifest, {}, new PluginLoggerImpl("test-plugin"));

    api.registerCommand("my-cmd", { description: "test", action: async () => {} });
    expect(api._commands).toHaveLength(1);
  });

  it("rejects undeclared command registrations", () => {
    const manifest = makeManifest();
    const api = new PluginApiImpl(manifest, {}, new PluginLoggerImpl("test-plugin"));

    expect(() => {
      api.registerCommand("unknown-cmd", { description: "test", action: async () => {} });
    }).toThrow("not declared in provides.commands");
  });

  it("registers planners and services when declared", () => {
    const manifest = makeManifest({ planners: ["custom"], services: ["bg"] });
    const api = new PluginApiImpl(manifest, {}, new PluginLoggerImpl("test-plugin"));

    api.registerPlanner({
      generatePlan: async () => ({
        plan_id: "p1", schema_version: "1", goal: "test",
        assumptions: [], steps: [], created_at: new Date().toISOString(),
      }),
    });
    api.registerService({ name: "bg", start: async () => {}, stop: async () => {} });

    expect(api._planners).toHaveLength(1);
    expect(api._services).toHaveLength(1);
  });

  it("rejects undeclared planner registrations", () => {
    const manifest = makeManifest(); // no planners declared
    const api = new PluginApiImpl(manifest, {}, new PluginLoggerImpl("test-plugin"));

    expect(() => {
      api.registerPlanner({
        generatePlan: async () => ({
          plan_id: "p1", schema_version: "1", goal: "test",
          assumptions: [], steps: [], created_at: new Date().toISOString(),
        }),
      });
    }).toThrow("none declared in provides.planners");
  });

  it("rejects undeclared service registrations", () => {
    const manifest = makeManifest(); // no services declared
    const api = new PluginApiImpl(manifest, {}, new PluginLoggerImpl("test-plugin"));

    expect(() => {
      api.registerService({ name: "bg", start: async () => {}, stop: async () => {} });
    }).toThrow("none declared in provides.services");
  });

  it("rejects undeclared route registrations", () => {
    const manifest = makeManifest({ routes: ["allowed"] });
    const api = new PluginApiImpl(manifest, {}, new PluginLoggerImpl("test-plugin"));

    expect(() => {
      api.registerRoute("GET", "not-allowed", async () => {});
    }).toThrow("not declared in provides.routes");
  });

  it("exposes frozen config", () => {
    const manifest = makeManifest();
    const api = new PluginApiImpl(manifest, { key: "value" }, new PluginLoggerImpl("test-plugin"));

    expect(api.config.key).toBe("value");
    expect(() => { (api.config as any).key = "other"; }).toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import type { ToolManifest } from "@openvger/schemas";
import { ToolRegistry } from "./tool-registry.js";

const TOOLS_DIR = resolve(import.meta.dirname ?? ".", "../../../tools/examples");

const validManifest = (): ToolManifest => ({
  name: "test-tool",
  version: "1.0.0",
  description: "A test tool",
  runner: "internal",
  input_schema: { type: "object", properties: { msg: { type: "string" } }, additionalProperties: false },
  output_schema: { type: "object", properties: { echo: { type: "string" } }, additionalProperties: false },
  permissions: [],
  timeout_ms: 5000,
  supports: { mock: true, dry_run: false },
});

describe("ToolRegistry", () => {
  it("registers and retrieves a valid manifest", () => {
    const registry = new ToolRegistry();
    const manifest = validManifest();
    registry.register(manifest);
    expect(registry.get("test-tool")).toBe(manifest);
    expect(registry.list()).toHaveLength(1);
  });

  it("throws on registering an invalid manifest", () => {
    const registry = new ToolRegistry();
    const bad = { name: "Bad Name!" } as any;
    expect(() => registry.register(bad)).toThrow("Invalid tool manifest");
  });

  it("require() returns registered tool", () => {
    const registry = new ToolRegistry();
    registry.register(validManifest());
    expect(registry.require("test-tool").name).toBe("test-tool");
  });

  it("require() throws for missing tool", () => {
    const registry = new ToolRegistry();
    expect(() => registry.require("nonexistent")).toThrow('Tool not found: "nonexistent"');
  });

  it("get() returns undefined for missing tool", () => {
    const registry = new ToolRegistry();
    expect(registry.get("missing")).toBeUndefined();
  });

  it("getSchemasForPlanner returns sanitized schemas", () => {
    const registry = new ToolRegistry();
    registry.register(validManifest());
    const schemas = registry.getSchemasForPlanner();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.name).toBe("test-tool");
    expect(schemas[0]!.description).toBe("A test tool");
    expect(schemas[0]).not.toHaveProperty("permissions");
    expect(schemas[0]).not.toHaveProperty("runner");
  });

  it("loads tools from the examples directory", async () => {
    const registry = new ToolRegistry();
    const loaded = await registry.loadFromDirectory(TOOLS_DIR);
    expect(loaded.length).toBeGreaterThanOrEqual(4);
    const names = loaded.map((t) => t.name);
    expect(names).toContain("read-file");
    expect(names).toContain("write-file");
    expect(names).toContain("shell-exec");
    expect(names).toContain("http-request");
  });

  it("loadFromDirectory returns empty for nonexistent path", async () => {
    const registry = new ToolRegistry();
    const result = await registry.loadFromDirectory("/nonexistent/path");
    expect(result).toEqual([]);
  });

  it("loadFromFile throws for nonexistent file", async () => {
    const registry = new ToolRegistry();
    await expect(registry.loadFromFile("/nonexistent/tool.yaml")).rejects.toThrow("Tool manifest not found");
  });

  it("loads a single tool file", async () => {
    const registry = new ToolRegistry();
    const manifest = await registry.loadFromFile(resolve(TOOLS_DIR, "read-file/tool.yaml"));
    expect(manifest.name).toBe("read-file");
    expect(registry.get("read-file")).toBeDefined();
  });
});

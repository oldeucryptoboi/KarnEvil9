import { describe, it, expect } from "vitest";
import { v4 as uuid } from "uuid";
import type { Task, PlanResult, Planner, ToolSchemaForPlanner } from "@openvger/schemas";
import { RouterPlanner, classifyTask, filterToolsByDomain } from "./router-planner.js";

const toolSchemas: ToolSchemaForPlanner[] = [
  {
    name: "read-file", version: "1.0.0", description: "Read a file",
    input_schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    output_schema: { type: "object" },
  },
  {
    name: "write-file", version: "1.0.0", description: "Write a file",
    input_schema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
    output_schema: { type: "object" },
  },
  {
    name: "http-request", version: "1.0.0", description: "HTTP request",
    input_schema: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
    output_schema: { type: "object" },
  },
  {
    name: "shell-exec", version: "1.0.0", description: "Execute shell command",
    input_schema: { type: "object", required: ["command"], properties: { command: { type: "string" } } },
    output_schema: { type: "object" },
  },
];

const makeTask = (text: string): Task => ({
  task_id: uuid(),
  text,
  created_at: new Date().toISOString(),
});

describe("classifyTask", () => {
  const toolNames = toolSchemas.map(s => s.name);

  it("classifies file-related tasks as file_ops", () => {
    expect(classifyTask("read the file at /tmp/test.txt", toolNames)).toBe("file_ops");
    expect(classifyTask("write data to a new file", toolNames)).toBe("file_ops");
    expect(classifyTask("check the directory contents", toolNames)).toBe("file_ops");
  });

  it("classifies network tasks", () => {
    expect(classifyTask("fetch the API endpoint", toolNames)).toBe("network");
    expect(classifyTask("download from this URL", toolNames)).toBe("network");
    expect(classifyTask("make an http request", toolNames)).toBe("network");
  });

  it("classifies shell tasks", () => {
    expect(classifyTask("run the build command", toolNames)).toBe("shell");
    expect(classifyTask("install npm packages", toolNames)).toBe("shell");
    expect(classifyTask("execute the test script", toolNames)).toBe("shell");
  });

  it("classifies code generation tasks", () => {
    expect(classifyTask("generate a new function", toolNames)).toBe("code_gen");
    expect(classifyTask("implement the login feature", toolNames)).toBe("code_gen");
    expect(classifyTask("refactor this class", toolNames)).toBe("code_gen");
  });

  it("falls back to general for ambiguous tasks", () => {
    expect(classifyTask("do something", toolNames)).toBe("general");
    expect(classifyTask("hello world", toolNames)).toBe("general");
  });
});

describe("filterToolsByDomain", () => {
  it("returns file tools for file_ops domain", () => {
    const filtered = filterToolsByDomain(toolSchemas, "file_ops");
    expect(filtered.map(s => s.name)).toEqual(["read-file", "write-file"]);
  });

  it("returns http tools for network domain", () => {
    const filtered = filterToolsByDomain(toolSchemas, "network");
    expect(filtered.map(s => s.name)).toEqual(["http-request"]);
  });

  it("returns shell tools for shell domain", () => {
    const filtered = filterToolsByDomain(toolSchemas, "shell");
    expect(filtered.map(s => s.name)).toEqual(["shell-exec"]);
  });

  it("returns all tools for general domain", () => {
    const filtered = filterToolsByDomain(toolSchemas, "general");
    expect(filtered).toHaveLength(4);
  });

  it("returns all tools for code_gen (no matching patterns)", () => {
    const filtered = filterToolsByDomain(toolSchemas, "code_gen");
    expect(filtered).toHaveLength(4); // fallback to all
  });

  it("returns all tools when filtering leaves 0 results", () => {
    // Only tool is shell-exec, but domain is file_ops
    const singleTool: ToolSchemaForPlanner[] = [{
      name: "custom-tool", version: "1.0.0", description: "Custom",
      input_schema: { type: "object" }, output_schema: { type: "object" },
    }];
    const filtered = filterToolsByDomain(singleTool, "file_ops");
    expect(filtered).toHaveLength(1); // falls back to all
  });
});

describe("RouterPlanner", () => {
  it("delegates to underlying planner with domain hint", async () => {
    let receivedSnapshot: Record<string, unknown> = {};
    let receivedSchemas: ToolSchemaForPlanner[] = [];

    const mockDelegate: Planner = {
      async generatePlan(task, schemas, snapshot): Promise<PlanResult> {
        receivedSnapshot = snapshot;
        receivedSchemas = schemas;
        return {
          plan: {
            plan_id: uuid(), schema_version: "0.1", goal: task.text,
            assumptions: [], steps: [], created_at: new Date().toISOString(),
          },
        };
      },
    };

    const router = new RouterPlanner({ delegate: mockDelegate });
    const task = makeTask("read the file at /tmp/test.txt");
    await router.generatePlan(task, toolSchemas, {}, {});

    expect(receivedSnapshot.task_domain).toBe("file_ops");
    // Should have filtered to file tools
    expect(receivedSchemas.map(s => s.name)).toEqual(["read-file", "write-file"]);
  });

  it("passes all tools for general domain", async () => {
    let receivedSchemas: ToolSchemaForPlanner[] = [];

    const mockDelegate: Planner = {
      async generatePlan(_task, schemas, _snapshot): Promise<PlanResult> {
        receivedSchemas = schemas;
        return {
          plan: {
            plan_id: uuid(), schema_version: "0.1", goal: "test",
            assumptions: [], steps: [], created_at: new Date().toISOString(),
          },
        };
      },
    };

    const router = new RouterPlanner({ delegate: mockDelegate });
    await router.generatePlan(makeTask("do something vague"), toolSchemas, {}, {});
    expect(receivedSchemas).toHaveLength(4);
  });

  it("preserves existing state snapshot fields", async () => {
    let receivedSnapshot: Record<string, unknown> = {};

    const mockDelegate: Planner = {
      async generatePlan(_task, _schemas, snapshot): Promise<PlanResult> {
        receivedSnapshot = snapshot;
        return {
          plan: {
            plan_id: uuid(), schema_version: "0.1", goal: "test",
            assumptions: [], steps: [], created_at: new Date().toISOString(),
          },
        };
      },
    };

    const router = new RouterPlanner({ delegate: mockDelegate });
    await router.generatePlan(makeTask("read file"), toolSchemas, { existing: "value" }, {});
    expect(receivedSnapshot.existing).toBe("value");
    expect(receivedSnapshot.task_domain).toBe("file_ops");
  });
});

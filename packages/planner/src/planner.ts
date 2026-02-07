import { v4 as uuid } from "uuid";
import type { Task, Plan, Planner, ToolSchemaForPlanner } from "@openflaw/schemas";

function buildSystemPrompt(
  toolSchemas: ToolSchemaForPlanner[],
  constraints: Record<string, unknown>
): string {
  return `You are an execution planner for OpenFlaw, a deterministic agent runtime.

Your job: given a task, produce a structured JSON plan that uses ONLY the available tools.

## Rules
1. Output ONLY valid JSON. No markdown, no commentary, no explanation.
2. Reference ONLY tools from the available tools list.
3. Every step must have valid inputs matching the tool's input_schema.
4. Plans must be sequential (steps execute in order).
5. Each step must have at least one success criterion.
6. Choose appropriate failure_policy per step:
   - "abort": critical step, stop everything if it fails
   - "continue": non-critical, skip and move on
   - "replan": would benefit from a new plan (treated as abort in v0.1)
7. Set reasonable timeout_ms per step (default 30000).
8. Set max_retries (0 for idempotent steps, 1-2 for flaky ones).

## Available Tools
${JSON.stringify(toolSchemas, null, 2)}

## Constraints
${JSON.stringify(constraints, null, 2)}

## Output Schema
{
  "plan_id": "<generated uuid>",
  "schema_version": "0.1",
  "goal": "<what this plan achieves>",
  "assumptions": ["<assumption 1>", ...],
  "steps": [
    {
      "step_id": "<unique id>",
      "title": "<short description>",
      "description": "<optional longer description>",
      "tool_ref": { "name": "<tool name>" },
      "input": { <matching tool input_schema> },
      "success_criteria": ["<criterion>"],
      "failure_policy": "abort" | "continue" | "replan",
      "timeout_ms": 30000,
      "max_retries": 0
    }
  ],
  "artifacts": [
    { "name": "<artifact name>", "type": "file" | "patch" | "pr_url" | "report" | "other" }
  ]
}`;
}

function buildUserPrompt(task: Task, stateSnapshot: Record<string, unknown>): string {
  let prompt = `## Task\n${task.text}\n`;
  if (task.constraints) prompt += `\n## Task Constraints\n${JSON.stringify(task.constraints, null, 2)}\n`;
  if (stateSnapshot.has_plan) prompt += `\n## Current State (replanning context)\n${JSON.stringify(stateSnapshot, null, 2)}\n`;
  prompt += `\nProduce the plan JSON now.`;
  return prompt;
}

function generateMockInput(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const required = (schema.required ?? []) as string[];
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const key of required) {
    const prop = properties[key];
    if (!prop) continue;
    switch (prop.type) {
      case "string":
        result[key] = prop.enum && Array.isArray(prop.enum) ? prop.enum[0] : `mock_${key}`;
        break;
      case "number": case "integer": result[key] = 0; break;
      case "boolean": result[key] = false; break;
      case "array": result[key] = []; break;
      case "object": result[key] = {}; break;
      default: result[key] = null;
    }
  }
  return result;
}

export class MockPlanner implements Planner {
  async generatePlan(
    task: Task,
    toolSchemas: ToolSchemaForPlanner[],
    _stateSnapshot: Record<string, unknown>,
    _constraints: Record<string, unknown>
  ): Promise<Plan> {
    const tool = toolSchemas[0];
    if (!tool) throw new Error("No tools available for planning");
    return {
      plan_id: uuid(),
      schema_version: "0.1",
      goal: task.text,
      assumptions: ["Mock plan generated for testing"],
      steps: [{
        step_id: uuid(),
        title: `Execute ${tool.name}`,
        tool_ref: { name: tool.name },
        input: generateMockInput(tool.input_schema),
        success_criteria: ["Tool executes successfully"],
        failure_policy: "abort",
        timeout_ms: 30000,
        max_retries: 0,
      }],
      created_at: new Date().toISOString(),
    };
  }
}

export type ModelCallFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

export class LLMPlanner implements Planner {
  private callModel: ModelCallFn;
  constructor(callModel: ModelCallFn) { this.callModel = callModel; }

  async generatePlan(
    task: Task,
    toolSchemas: ToolSchemaForPlanner[],
    stateSnapshot: Record<string, unknown>,
    constraints: Record<string, unknown>
  ): Promise<Plan> {
    const raw = await this.callModel(
      buildSystemPrompt(toolSchemas, constraints),
      buildUserPrompt(task, stateSnapshot)
    );
    let jsonStr = raw.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    let plan: Plan;
    try { plan = JSON.parse(jsonStr) as Plan; }
    catch { throw new Error(`Planner returned invalid JSON: ${jsonStr.slice(0, 200)}...`); }
    if (!plan.created_at) plan.created_at = new Date().toISOString();
    return plan;
  }
}

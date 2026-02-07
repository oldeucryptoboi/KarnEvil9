export const StepSchema = {
  type: "object",
  required: [
    "step_id", "title", "tool_ref", "input", "success_criteria",
    "failure_policy", "timeout_ms", "max_retries",
  ],
  properties: {
    step_id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    tool_ref: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1 },
        version_range: { type: "string" },
      },
      additionalProperties: false,
    },
    input: { type: "object" },
    success_criteria: { type: "array", items: { type: "string" }, minItems: 1 },
    failure_policy: { type: "string", enum: ["abort", "replan", "continue"] },
    timeout_ms: { type: "number", minimum: 100 },
    max_retries: { type: "integer", minimum: 0, maximum: 10 },
  },
  additionalProperties: false,
} as const;

export const PlanSchema = {
  type: "object",
  required: ["plan_id", "schema_version", "goal", "assumptions", "steps"],
  properties: {
    plan_id: { type: "string", minLength: 1 },
    schema_version: { type: "string", const: "0.1" },
    goal: { type: "string", minLength: 1 },
    assumptions: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: StepSchema, minItems: 1 },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "type"],
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["file", "patch", "pr_url", "report", "other"] },
          description: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    created_at: { type: "string" },
  },
  additionalProperties: false,
} as const;

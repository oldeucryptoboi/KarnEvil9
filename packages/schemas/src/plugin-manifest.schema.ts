export const PluginManifestSchema = {
  type: "object",
  required: ["id", "name", "version", "description", "entry", "permissions", "provides"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9_-]+$" },
    name: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    description: { type: "string" },
    entry: { type: "string", minLength: 1 },
    permissions: {
      type: "array",
      items: { type: "string" },
    },
    config_schema: { type: "object" },
    provides: {
      type: "object",
      properties: {
        tools: { type: "array", items: { type: "string" } },
        hooks: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "before_session_start", "after_session_end",
              "before_plan", "after_plan",
              "before_step", "after_step",
              "before_tool_call", "after_tool_call",
              "on_error",
            ],
          },
        },
        routes: { type: "array", items: { type: "string" } },
        commands: { type: "array", items: { type: "string" } },
        planners: { type: "array", items: { type: "string" } },
        services: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

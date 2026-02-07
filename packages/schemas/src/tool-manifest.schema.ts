export const ToolManifestSchema = {
  type: "object",
  required: [
    "name", "version", "description", "runner", "input_schema",
    "output_schema", "permissions", "timeout_ms", "supports",
  ],
  properties: {
    name: { type: "string", pattern: "^[a-z][a-z0-9_-]*$", minLength: 1, maxLength: 64 },
    version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+" },
    description: { type: "string", minLength: 1 },
    runner: { type: "string", enum: ["shell", "http", "internal", "container"] },
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    permissions: {
      type: "array",
      items: { type: "string", pattern: "^[a-z]+:[a-z_]+:[a-zA-Z0-9_./-]+" },
    },
    timeout_ms: { type: "number", minimum: 100, maximum: 600000 },
    supports: {
      type: "object",
      required: ["mock"],
      properties: {
        mock: { type: "boolean", const: true },
        dry_run: { type: "boolean" },
      },
      additionalProperties: false,
    },
    mock_responses: { type: "array", items: { type: "object" } },
  },
  additionalProperties: false,
} as const;

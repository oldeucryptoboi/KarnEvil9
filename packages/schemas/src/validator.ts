import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { PlanSchema } from "./plan.schema.js";
import { ToolManifestSchema } from "./tool-manifest.schema.js";
import { JournalEventSchema } from "./journal-event.schema.js";
import { PluginManifestSchema } from "./plugin-manifest.schema.js";

const ajv = new (Ajv.default ?? Ajv)({ allErrors: true, strict: false });
// ajv-formats has a nested .default in ESM due to CJS interop — resolve it safely.
type FormatsFn = (instance: unknown) => void;
const applyFormats: FormatsFn = (addFormats as unknown as { default?: FormatsFn }).default ?? (addFormats as unknown as FormatsFn);
applyFormats(ajv);

const MAX_SCHEMA_CACHE = 500;
const schemaCache = new Map<string, ValidateFunction>();

function getOrCompile(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = schemaCache.get(key);
  if (!validate) {
    // Evict oldest entry when cache is full
    if (schemaCache.size >= MAX_SCHEMA_CACHE) {
      const oldest = schemaCache.keys().next().value;
      if (oldest !== undefined) schemaCache.delete(oldest);
    }
    validate = ajv.compile(schema);
    schemaCache.set(key, validate);
  }
  return validate;
}

export function clearSchemaCache(): void {
  schemaCache.clear();
}

const validatePlan = ajv.compile(PlanSchema);
const validateToolManifest = ajv.compile(ToolManifestSchema);
const validateJournalEvent = ajv.compile(JournalEventSchema);
const validatePluginManifest = ajv.compile(PluginManifestSchema);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function toResult(valid: boolean, errors: ErrorObject[] | null | undefined): ValidationResult {
  if (valid) return { valid: true, errors: [] };
  const msgs = (errors ?? []).map(
    (e: ErrorObject) => `${e.instancePath || "/"}: ${e.message ?? "unknown error"}`
  );
  return { valid: false, errors: msgs };
}

export function validatePlanData(data: unknown): ValidationResult {
  const valid = validatePlan(data);
  return toResult(valid, validatePlan.errors);
}

export function validateToolManifestData(data: unknown): ValidationResult {
  const valid = validateToolManifest(data);
  return toResult(valid, validateToolManifest.errors);
}

export function validateJournalEventData(data: unknown): ValidationResult {
  const valid = validateJournalEvent(data);
  return toResult(valid, validateJournalEvent.errors);
}

export function validatePluginManifestData(data: unknown): ValidationResult {
  const valid = validatePluginManifest(data);
  return toResult(valid, validatePluginManifest.errors);
}

export function validateToolInput(
  input: unknown,
  inputSchema: Record<string, unknown>
): ValidationResult {
  const validate = getOrCompile(inputSchema);
  const valid = validate(input);
  return toResult(valid, validate.errors);
}

export function validateToolOutput(
  output: unknown,
  outputSchema: Record<string, unknown>
): ValidationResult {
  const validate = getOrCompile(outputSchema);
  const valid = validate(output);
  return toResult(valid, validate.errors);
}

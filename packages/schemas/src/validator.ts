import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { PlanSchema } from "./plan.schema.js";
import { ToolManifestSchema } from "./tool-manifest.schema.js";
import { JournalEventSchema } from "./journal-event.schema.js";

const ajv = new (Ajv.default ?? Ajv)({ allErrors: true, strict: false });
((addFormats as any).default ?? addFormats)(ajv);

const validatePlan = ajv.compile(PlanSchema);
const validateToolManifest = ajv.compile(ToolManifestSchema);
const validateJournalEvent = ajv.compile(JournalEventSchema);

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

export function validateToolInput(
  input: unknown,
  inputSchema: Record<string, unknown>
): ValidationResult {
  const validate = ajv.compile(inputSchema);
  const valid = validate(input);
  return toResult(valid, validate.errors);
}

export function validateToolOutput(
  output: unknown,
  outputSchema: Record<string, unknown>
): ValidationResult {
  const validate = ajv.compile(outputSchema);
  const valid = validate(output);
  return toResult(valid, validate.errors);
}

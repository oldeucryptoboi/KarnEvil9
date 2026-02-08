import type { Plan, Session, ToolSchemaForPlanner } from "@openvger/schemas";

export interface CriticResult {
  passed: boolean;
  name: string;
  message?: string;
  severity: "error" | "warning" | "info";
}

export type CriticFn = (plan: Plan, context: CriticContext) => CriticResult;

export interface CriticContext {
  session: Session;
  toolSchemas: ToolSchemaForPlanner[];
}

/**
 * Checks that every step's input provides all required fields from the tool's input_schema.
 */
export const toolInputCritic: CriticFn = (plan, context) => {
  const schemaMap = new Map(context.toolSchemas.map(s => [s.name, s]));
  const missing: string[] = [];

  for (const step of plan.steps) {
    const schema = schemaMap.get(step.tool_ref.name);
    if (!schema) continue; // unknownToolCritic handles this
    const required = (schema.input_schema.required ?? []) as string[];
    const inputKeys = Object.keys(step.input);
    for (const field of required) {
      if (!inputKeys.includes(field)) {
        missing.push(`Step "${step.title}" missing required input "${field}" for tool "${step.tool_ref.name}"`);
      }
    }
  }

  if (missing.length > 0) {
    return { passed: false, name: "toolInputCritic", message: missing.join("; "), severity: "error" };
  }
  return { passed: true, name: "toolInputCritic", severity: "info" };
};

/**
 * Checks that plan step count doesn't exceed session limits.
 */
export const stepLimitCritic: CriticFn = (plan, context) => {
  const limit = context.session.limits.max_steps;
  if (plan.steps.length > limit) {
    return {
      passed: false, name: "stepLimitCritic",
      message: `Plan has ${plan.steps.length} steps, exceeds session limit of ${limit}`,
      severity: "error",
    };
  }
  return { passed: true, name: "stepLimitCritic", severity: "info" };
};

/**
 * Checks that no step depends on itself or creates circular dependencies.
 */
export const selfReferenceCritic: CriticFn = (plan) => {
  // Check self-references
  for (const step of plan.steps) {
    if (step.depends_on?.includes(step.step_id)) {
      return {
        passed: false, name: "selfReferenceCritic",
        message: `Step "${step.title}" (${step.step_id}) depends on itself`,
        severity: "error",
      };
    }
  }

  // Check circular dependencies using topological sort (DFS cycle detection)
  const adjList = new Map<string, string[]>();
  const stepIds = new Set(plan.steps.map(s => s.step_id));
  for (const step of plan.steps) {
    adjList.set(step.step_id, step.depends_on?.filter(d => stepIds.has(d)) ?? []);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(node: string): boolean {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    for (const dep of adjList.get(node) ?? []) {
      if (hasCycle(dep)) return true;
    }
    inStack.delete(node);
    return false;
  }

  for (const stepId of stepIds) {
    if (hasCycle(stepId)) {
      return {
        passed: false, name: "selfReferenceCritic",
        message: `Circular dependency detected involving step "${stepId}"`,
        severity: "error",
      };
    }
  }

  return { passed: true, name: "selfReferenceCritic", severity: "info" };
};

/**
 * Checks that all tool_ref.name values exist in the registry.
 */
export const unknownToolCritic: CriticFn = (plan, context) => {
  const known = new Set(context.toolSchemas.map(s => s.name));
  const unknown: string[] = [];
  for (const step of plan.steps) {
    if (!known.has(step.tool_ref.name)) {
      unknown.push(`Step "${step.title}" references unknown tool "${step.tool_ref.name}"`);
    }
  }
  if (unknown.length > 0) {
    return { passed: false, name: "unknownToolCritic", message: unknown.join("; "), severity: "error" };
  }
  return { passed: true, name: "unknownToolCritic", severity: "info" };
};

const DEFAULT_CRITICS: CriticFn[] = [
  toolInputCritic,
  stepLimitCritic,
  selfReferenceCritic,
  unknownToolCritic,
];

export function runCritics(plan: Plan, context: CriticContext, critics?: CriticFn[]): CriticResult[] {
  return (critics ?? DEFAULT_CRITICS).map(critic => critic(plan, context));
}

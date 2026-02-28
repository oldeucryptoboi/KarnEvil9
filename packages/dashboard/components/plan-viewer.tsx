"use client";

import { useState } from "react";

interface PlanStep {
  step_id: string;
  title: string;
  tool_ref?: { name: string };
  input?: Record<string, unknown>;
  success_criteria?: string;
}

interface Plan {
  plan_id?: string;
  goal?: string;
  steps?: PlanStep[];
}

export function PlanViewer({ plan }: { plan: Plan | null }) {
  const [expanded, setExpanded] = useState(true);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

  if (!plan) return null;

  const toggleStep = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--muted)]">{expanded ? "\u25BC" : "\u25B6"}</span>
          <h3 className="text-sm font-semibold">Plan</h3>
          {plan.steps && (
            <span className="text-xs text-[var(--muted)]">({plan.steps.length} steps)</span>
          )}
        </div>
        {plan.plan_id && (
          <span className="text-xs font-mono text-[var(--muted)]">{plan.plan_id.slice(0, 8)}</span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] p-4 pt-3">
          {plan.goal && (
            <p className="text-sm text-[var(--muted)] mb-3">{plan.goal}</p>
          )}

          {plan.steps && plan.steps.length > 0 ? (
            <div className="space-y-1">
              {plan.steps.map((step, i) => (
                <div key={step.step_id} className="rounded border border-[var(--border)]">
                  <button
                    onClick={() => toggleStep(step.step_id)}
                    className="w-full flex items-center gap-3 p-2 text-left text-sm hover:bg-white/[0.02]"
                  >
                    <span className="text-xs text-[var(--muted)] font-mono w-5">{i + 1}</span>
                    <span className="flex-1 truncate">{step.title}</span>
                    {step.tool_ref && (
                      <span className="text-xs bg-[var(--accent)]/10 text-[var(--accent)] px-1.5 py-0.5 rounded font-mono">
                        {step.tool_ref.name}
                      </span>
                    )}
                  </button>

                  {expandedSteps.has(step.step_id) && (
                    <div className="border-t border-[var(--border)] p-2 text-xs space-y-2">
                      {step.success_criteria && (
                        <div>
                          <span className="text-[var(--muted)]">Success: </span>
                          <span>{step.success_criteria}</span>
                        </div>
                      )}
                      {step.input && Object.keys(step.input).length > 0 && (
                        <div>
                          <span className="text-[var(--muted)]">Input: </span>
                          <pre className="mt-1 text-[var(--muted)] overflow-x-auto">
                            {JSON.stringify(step.input, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-[var(--muted)]">No steps in plan</p>
          )}
        </div>
      )}
    </div>
  );
}

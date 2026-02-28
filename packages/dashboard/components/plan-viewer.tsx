"use client";

import { useState } from "react";
import type { JournalEvent } from "@/lib/api";

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

type StepStatus = "succeeded" | "failed" | "running" | "pending";

function getStepStatusMap(events: JournalEvent[]): Map<string, StepStatus> {
  const map = new Map<string, StepStatus>();
  for (const evt of events) {
    const stepId = evt.payload.step_id as string | undefined;
    if (!stepId) continue;
    if (evt.type === "step.started" && !map.has(stepId)) {
      map.set(stepId, "running");
    } else if (evt.type === "step.succeeded") {
      map.set(stepId, "succeeded");
    } else if (evt.type === "step.failed") {
      map.set(stepId, "failed");
    }
  }
  return map;
}

const STATUS_ICON: Record<StepStatus, { symbol: string; color: string }> = {
  succeeded: { symbol: "\u2713", color: "text-green-400" },
  failed:    { symbol: "\u2717", color: "text-red-400" },
  running:   { symbol: "\u25CF", color: "text-yellow-400 animate-pulse" },
  pending:   { symbol: "\u25CB", color: "text-[var(--muted)]" },
};

export function PlanViewer({ plan, events = [] }: { plan: Plan | null; events?: JournalEvent[] }) {
  const [expanded, setExpanded] = useState(true);
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const statusMap = getStepStatusMap(events);

  if (!plan) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
        <h3 className="text-sm font-semibold text-[var(--muted)]">Plan</h3>
        <p className="text-xs text-[var(--muted)]/60 mt-1">Waiting for planner...</p>
      </div>
    );
  }

  const toggleStep = (stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  const totalSteps = plan.steps?.length ?? 0;
  const completedSteps = plan.steps?.filter((s) => statusMap.get(s.step_id) === "succeeded").length ?? 0;
  const failedSteps = plan.steps?.filter((s) => statusMap.get(s.step_id) === "failed").length ?? 0;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-white/[0.02]"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--muted)]">{expanded ? "\u25BC" : "\u25B6"}</span>
          <h3 className="text-sm font-semibold">Plan</h3>
          {totalSteps > 0 && (
            <span className="text-xs text-[var(--muted)]">
              <span className={completedSteps === totalSteps && totalSteps > 0 ? "text-green-400" : ""}>
                {completedSteps}/{totalSteps} completed
              </span>
              {failedSteps > 0 && (
                <span className="text-red-400 ml-1">({failedSteps} failed)</span>
              )}
            </span>
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

          {/* Completion progress bar */}
          {totalSteps > 0 && (
            <div className="flex h-1 rounded-full overflow-hidden bg-[var(--border)] mb-3">
              {completedSteps > 0 && (
                <div
                  className="bg-green-500 transition-all duration-500"
                  style={{ width: `${(completedSteps / totalSteps) * 100}%` }}
                />
              )}
              {failedSteps > 0 && (
                <div
                  className="bg-red-500 transition-all duration-500"
                  style={{ width: `${(failedSteps / totalSteps) * 100}%` }}
                />
              )}
            </div>
          )}

          {plan.steps && plan.steps.length > 0 ? (
            <div className="space-y-1">
              {plan.steps.map((step, i) => {
                const stepStatus = statusMap.get(step.step_id) ?? "pending";
                const icon = STATUS_ICON[stepStatus];
                return (
                  <div
                    key={step.step_id}
                    className={`rounded border border-[var(--border)] ${
                      stepStatus === "succeeded" ? "border-l-2 border-l-green-500/50" :
                      stepStatus === "failed" ? "border-l-2 border-l-red-500/50" :
                      stepStatus === "running" ? "border-l-2 border-l-yellow-500/50 bg-yellow-500/[0.03]" :
                      ""
                    }`}
                  >
                    <button
                      onClick={() => toggleStep(step.step_id)}
                      className="w-full flex items-center gap-3 p-2 text-left text-sm hover:bg-white/[0.02]"
                    >
                      <span className={`text-sm flex-shrink-0 w-5 text-center ${icon.color}`}>
                        {icon.symbol}
                      </span>
                      <span className="text-xs text-[var(--muted)] font-mono w-5">{i + 1}</span>
                      <span className={`flex-1 truncate ${stepStatus === "succeeded" ? "text-[var(--muted)] line-through decoration-green-500/30" : ""}`}>
                        {step.title}
                      </span>
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
                            <span className="text-[var(--muted)] font-semibold">Success criteria: </span>
                            <span>{step.success_criteria}</span>
                          </div>
                        )}
                        {step.input && Object.keys(step.input).length > 0 && (
                          <div>
                            <span className="text-[var(--muted)] font-semibold">Input: </span>
                            <pre className="mt-1 rounded bg-black/20 p-2 text-[var(--muted)] overflow-x-auto">
                              {JSON.stringify(step.input, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-[var(--muted)]">No steps in plan</p>
          )}
        </div>
      )}
    </div>
  );
}

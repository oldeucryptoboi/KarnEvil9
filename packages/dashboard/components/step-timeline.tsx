"use client";

import type { JournalEvent } from "@/lib/api";
import { StepCard, type StepData } from "./step-card";

/**
 * Builds step data from journal events by correlating step.started, step.succeeded,
 * and step.failed events via their step_id payloads.
 */
function buildStepsFromEvents(events: JournalEvent[]): StepData[] {
  const stepMap = new Map<string, StepData>();

  for (const evt of events) {
    const stepId = (evt.payload.step_id as string) ?? "";
    if (!stepId) continue;

    if (evt.type === "step.started") {
      stepMap.set(stepId, {
        step_id: stepId,
        title: (evt.payload.title as string) ?? stepId,
        tool: (evt.payload.tool_name as string) ?? (evt.payload.tool as string) ?? "unknown",
        status: "running",
        started_at: evt.timestamp,
        input: evt.payload.input as Record<string, unknown> | undefined,
      });
    } else if (evt.type === "step.succeeded") {
      const existing = stepMap.get(stepId);
      if (existing) {
        existing.status = "succeeded";
        existing.finished_at = evt.timestamp;
        existing.output = evt.payload.output as Record<string, unknown> | undefined;
      } else {
        stepMap.set(stepId, {
          step_id: stepId,
          title: (evt.payload.title as string) ?? stepId,
          tool: (evt.payload.tool_name as string) ?? "unknown",
          status: "succeeded",
          finished_at: evt.timestamp,
          output: evt.payload.output as Record<string, unknown> | undefined,
        });
      }
    } else if (evt.type === "step.failed") {
      const existing = stepMap.get(stepId);
      if (existing) {
        existing.status = "failed";
        existing.finished_at = evt.timestamp;
        existing.error = (evt.payload.error as string) ?? (evt.payload.message as string);
      } else {
        stepMap.set(stepId, {
          step_id: stepId,
          title: (evt.payload.title as string) ?? stepId,
          tool: (evt.payload.tool_name as string) ?? "unknown",
          status: "failed",
          finished_at: evt.timestamp,
          error: (evt.payload.error as string) ?? (evt.payload.message as string),
        });
      }
    }
  }

  return Array.from(stepMap.values());
}

export function StepTimeline({ events }: { events: JournalEvent[] }) {
  const steps = buildStepsFromEvents(events);

  if (steps.length === 0) {
    return (
      <div className="rounded-lg border border-[var(--border)] p-6 text-center text-[var(--muted)] text-sm">
        No steps executed yet
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {steps.map((step) => (
        <StepCard key={step.step_id} step={step} />
      ))}
    </div>
  );
}

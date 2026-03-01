"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  getSessions,
  getSession,
  getJournal,
  type SessionSummary,
  type SessionDetail,
  type JournalEvent,
} from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepInfo {
  step_id: string;
  title: string;
  tool: string;
  status: "pending" | "running" | "succeeded" | "failed";
  started_at?: string;
  finished_at?: string;
  duration_ms: number | null;
  error?: string;
}

interface PlanInfo {
  plan_id?: string;
  goal?: string;
  steps: Array<{ step_id: string; title: string; tool: string }>;
}

interface SessionAnalysis {
  session: SessionDetail;
  events: JournalEvent[];
  plan: PlanInfo | null;
  steps: StepInfo[];
  duration_ms: number | null;
  succeeded: number;
  failed: number;
  total_steps: number;
  tools_used: string[];
  total_tokens: number;
  total_cost: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildStepsFromEvents(events: JournalEvent[]): StepInfo[] {
  const stepMap = new Map<string, StepInfo>();
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
        duration_ms: null,
      });
    } else if (evt.type === "step.succeeded") {
      const existing = stepMap.get(stepId);
      if (existing) {
        existing.status = "succeeded";
        existing.finished_at = evt.timestamp;
        existing.duration_ms = existing.started_at
          ? new Date(evt.timestamp).getTime() - new Date(existing.started_at).getTime()
          : null;
      } else {
        stepMap.set(stepId, {
          step_id: stepId,
          title: (evt.payload.title as string) ?? stepId,
          tool: (evt.payload.tool_name as string) ?? "unknown",
          status: "succeeded",
          finished_at: evt.timestamp,
          duration_ms: null,
        });
      }
    } else if (evt.type === "step.failed") {
      const existing = stepMap.get(stepId);
      if (existing) {
        existing.status = "failed";
        existing.finished_at = evt.timestamp;
        existing.duration_ms = existing.started_at
          ? new Date(evt.timestamp).getTime() - new Date(existing.started_at).getTime()
          : null;
        existing.error = (evt.payload.error as string) ?? (evt.payload.message as string);
      } else {
        stepMap.set(stepId, {
          step_id: stepId,
          title: (evt.payload.title as string) ?? stepId,
          tool: (evt.payload.tool_name as string) ?? "unknown",
          status: "failed",
          finished_at: evt.timestamp,
          duration_ms: null,
          error: (evt.payload.error as string) ?? (evt.payload.message as string),
        });
      }
    }
  }
  return Array.from(stepMap.values());
}

function extractPlan(events: JournalEvent[]): PlanInfo | null {
  const planEvt = [...events].reverse().find((e) => e.type === "plan.accepted");
  if (!planEvt) return null;
  const plan = planEvt.payload.plan as Record<string, unknown> | undefined;
  if (!plan) return null;
  const rawSteps = (plan.steps as Array<Record<string, unknown>>) ?? [];
  return {
    plan_id: plan.plan_id as string | undefined,
    goal: plan.goal as string | undefined,
    steps: rawSteps.map((s) => ({
      step_id: (s.step_id as string) ?? "",
      title: (s.title as string) ?? "",
      tool: ((s.tool_ref as Record<string, unknown>)?.name as string) ?? "unknown",
    })),
  };
}

function computeSessionDuration(session: SessionDetail, events: JournalEvent[]): number | null {
  if (!session.created_at) return null;
  const start = new Date(session.created_at).getTime();
  const terminalEvt = [...events].reverse().find(
    (e) => e.type === "session.completed" || e.type === "session.failed" || e.type === "session.aborted",
  );
  if (!terminalEvt) return null;
  return new Date(terminalEvt.timestamp).getTime() - start;
}

function extractTokensAndCost(events: JournalEvent[]): { tokens: number; cost: number } {
  let tokens = 0;
  let cost = 0;
  for (const evt of events) {
    if (evt.payload.tokens_used != null) tokens += Number(evt.payload.tokens_used) || 0;
    if (evt.payload.input_tokens != null) tokens += Number(evt.payload.input_tokens) || 0;
    if (evt.payload.output_tokens != null) tokens += Number(evt.payload.output_tokens) || 0;
    if (evt.payload.cost_usd != null) cost += Number(evt.payload.cost_usd) || 0;
    if (evt.payload.cost != null) cost += Number(evt.payload.cost) || 0;
  }
  return { tokens, cost };
}

function analyzeSession(session: SessionDetail, events: JournalEvent[]): SessionAnalysis {
  const steps = buildStepsFromEvents(events);
  const plan = extractPlan(events);
  const duration_ms = computeSessionDuration(session, events);
  const { tokens, cost } = extractTokensAndCost(events);
  const tools_used = [...new Set(steps.map((s) => s.tool))].sort();

  return {
    session,
    events,
    plan,
    steps,
    duration_ms,
    succeeded: steps.filter((s) => s.status === "succeeded").length,
    failed: steps.filter((s) => s.status === "failed").length,
    total_steps: steps.length,
    tools_used,
    total_tokens: tokens,
    total_cost: cost,
  };
}

function formatMs(ms: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function diffClass(a: number, b: number, lowerIsBetter: boolean): string {
  if (a === b) return "text-[var(--muted)]";
  if (lowerIsBetter) return a < b ? "text-green-400" : "text-red-400";
  return a > b ? "text-green-400" : "text-red-400";
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SessionSelector({
  label,
  value,
  sessions,
  onChange,
  otherValue,
}: {
  label: string;
  value: string;
  sessions: SessionSummary[];
  onChange: (id: string) => void;
  otherValue: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-[var(--muted)] font-semibold uppercase tracking-wider">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-[var(--card)] border border-[var(--border)] rounded px-3 py-1.5 text-sm text-[var(--foreground)] min-w-[240px]"
      >
        <option value="">Select a session...</option>
        {sessions.map((s) => (
          <option key={s.session_id} value={s.session_id} disabled={s.session_id === otherValue}>
            {s.session_id.slice(0, 8)}... - {s.status}
            {s.task_text ? ` - ${s.task_text.slice(0, 40)}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

function MetricCard({
  label,
  valueA,
  valueB,
  formatFn,
  lowerIsBetter = false,
}: {
  label: string;
  valueA: number | null;
  valueB: number | null;
  formatFn?: (v: number | null) => string;
  lowerIsBetter?: boolean;
}) {
  const fmt = formatFn ?? ((v: number | null) => (v != null ? String(v) : "-"));
  const aNum = valueA ?? 0;
  const bNum = valueB ?? 0;
  const hasValues = valueA != null || valueB != null;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <p className="text-xs text-[var(--muted)] mb-2 uppercase tracking-wider font-semibold">{label}</p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-[var(--muted)] mb-0.5">Session A</p>
          <p className={`text-lg font-semibold tabular-nums ${hasValues ? diffClass(aNum, bNum, lowerIsBetter) : "text-[var(--foreground)]"}`}>
            {fmt(valueA)}
          </p>
        </div>
        <div>
          <p className="text-xs text-[var(--muted)] mb-0.5">Session B</p>
          <p className={`text-lg font-semibold tabular-nums ${hasValues ? diffClass(bNum, aNum, lowerIsBetter) : "text-[var(--foreground)]"}`}>
            {fmt(valueB)}
          </p>
        </div>
      </div>
    </div>
  );
}

function PlanComparison({ a, b }: { a: SessionAnalysis; b: SessionAnalysis }) {
  const goalA = a.plan?.goal ?? "(no goal)";
  const goalB = b.plan?.goal ?? "(no goal)";
  const goalsMatch = goalA === goalB;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
      <div className="p-4 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold">Plan Comparison</h3>
      </div>
      <div className="grid grid-cols-2 divide-x divide-[var(--border)]">
        {/* Goals */}
        <div className="p-4">
          <p className="text-xs text-[var(--muted)] mb-1 uppercase tracking-wider font-semibold">Goal</p>
          <p className={`text-sm ${goalsMatch ? "text-[var(--foreground)]" : "text-yellow-400"}`}>{goalA}</p>
        </div>
        <div className="p-4">
          <p className="text-xs text-[var(--muted)] mb-1 uppercase tracking-wider font-semibold">Goal</p>
          <p className={`text-sm ${goalsMatch ? "text-[var(--foreground)]" : "text-yellow-400"}`}>{goalB}</p>
        </div>

        {/* Step counts */}
        <div className="p-4 border-t border-[var(--border)]">
          <p className="text-xs text-[var(--muted)] mb-1 uppercase tracking-wider font-semibold">Planned Steps</p>
          <p className="text-sm font-semibold">{a.plan?.steps.length ?? 0}</p>
        </div>
        <div className="p-4 border-t border-[var(--border)]">
          <p className="text-xs text-[var(--muted)] mb-1 uppercase tracking-wider font-semibold">Planned Steps</p>
          <p className="text-sm font-semibold">{b.plan?.steps.length ?? 0}</p>
        </div>

        {/* Tools used */}
        <div className="p-4 border-t border-[var(--border)]">
          <p className="text-xs text-[var(--muted)] mb-1 uppercase tracking-wider font-semibold">Tools Used</p>
          <div className="flex flex-wrap gap-1 mt-1">
            {a.tools_used.length > 0
              ? a.tools_used.map((t) => (
                  <span
                    key={t}
                    className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                      b.tools_used.includes(t)
                        ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                        : "bg-yellow-500/10 text-yellow-400"
                    }`}
                  >
                    {t}
                  </span>
                ))
              : <span className="text-xs text-[var(--muted)]">-</span>}
          </div>
        </div>
        <div className="p-4 border-t border-[var(--border)]">
          <p className="text-xs text-[var(--muted)] mb-1 uppercase tracking-wider font-semibold">Tools Used</p>
          <div className="flex flex-wrap gap-1 mt-1">
            {b.tools_used.length > 0
              ? b.tools_used.map((t) => (
                  <span
                    key={t}
                    className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                      a.tools_used.includes(t)
                        ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                        : "bg-yellow-500/10 text-yellow-400"
                    }`}
                  >
                    {t}
                  </span>
                ))
              : <span className="text-xs text-[var(--muted)]">-</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepComparison({ a, b }: { a: SessionAnalysis; b: SessionAnalysis }) {
  // Align steps: first by matching tool name at same position, then by position
  const maxLen = Math.max(a.steps.length, b.steps.length);
  const rows: Array<{ stepA: StepInfo | null; stepB: StepInfo | null; index: number }> = [];

  for (let i = 0; i < maxLen; i++) {
    rows.push({
      stepA: i < a.steps.length ? a.steps[i]! : null,
      stepB: i < b.steps.length ? b.steps[i]! : null,
      index: i,
    });
  }

  const statusColor = (status: string) => {
    switch (status) {
      case "succeeded": return "text-green-400";
      case "failed": return "text-red-400";
      case "running": return "text-yellow-400";
      default: return "text-[var(--muted)]";
    }
  };

  const statusDot = (status: string) => {
    switch (status) {
      case "succeeded": return "bg-green-500";
      case "failed": return "bg-red-500";
      case "running": return "bg-yellow-500";
      default: return "bg-gray-500";
    }
  };

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
      <div className="p-4 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold">Step-by-Step Comparison</h3>
      </div>

      {rows.length === 0 ? (
        <div className="p-6 text-center text-[var(--muted)] text-sm">No steps to compare</div>
      ) : (
        <div className="divide-y divide-[var(--border)]">
          {/* Header row */}
          <div className="grid grid-cols-[40px_1fr_1fr] text-xs text-[var(--muted)] font-semibold uppercase tracking-wider">
            <div className="p-3 text-center">#</div>
            <div className="p-3 border-l border-[var(--border)]">Session A</div>
            <div className="p-3 border-l border-[var(--border)]">Session B</div>
          </div>

          {rows.map((row) => {
            const toolMatch = row.stepA && row.stepB && row.stepA.tool === row.stepB.tool;
            const durationDiff = (() => {
              if (!row.stepA?.duration_ms || !row.stepB?.duration_ms) return null;
              return row.stepA.duration_ms - row.stepB.duration_ms;
            })();

            return (
              <div key={row.index} className="grid grid-cols-[40px_1fr_1fr] hover:bg-white/[0.02] transition-colors">
                <div className="p-3 text-center text-xs font-mono text-[var(--muted)]">{row.index + 1}</div>

                {/* Step A */}
                <div className={`p-3 border-l border-[var(--border)] ${!row.stepA ? "bg-[var(--border)]/10" : ""}`}>
                  {row.stepA ? (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full flex-shrink-0 ${statusDot(row.stepA.status)}`} />
                        <span className={`text-xs capitalize ${statusColor(row.stepA.status)}`}>
                          {row.stepA.status}
                        </span>
                      </div>
                      <p className="text-sm truncate">{row.stepA.title}</p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                          toolMatch ? "bg-[var(--accent)]/10 text-[var(--accent)]" : "bg-yellow-500/10 text-yellow-400"
                        }`}>
                          {row.stepA.tool}
                        </span>
                        {row.stepA.duration_ms != null && (
                          <span className={`text-xs tabular-nums ${
                            durationDiff != null
                              ? durationDiff <= 0 ? "text-green-400" : "text-red-400"
                              : "text-[var(--muted)]"
                          }`}>
                            {formatMs(row.stepA.duration_ms)}
                          </span>
                        )}
                      </div>
                      {row.stepA.error && (
                        <p className="text-xs text-red-400 truncate">{row.stepA.error}</p>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-[var(--muted)]">-</span>
                  )}
                </div>

                {/* Step B */}
                <div className={`p-3 border-l border-[var(--border)] ${!row.stepB ? "bg-[var(--border)]/10" : ""}`}>
                  {row.stepB ? (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full flex-shrink-0 ${statusDot(row.stepB.status)}`} />
                        <span className={`text-xs capitalize ${statusColor(row.stepB.status)}`}>
                          {row.stepB.status}
                        </span>
                      </div>
                      <p className="text-sm truncate">{row.stepB.title}</p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                          toolMatch ? "bg-[var(--accent)]/10 text-[var(--accent)]" : "bg-yellow-500/10 text-yellow-400"
                        }`}>
                          {row.stepB.tool}
                        </span>
                        {row.stepB.duration_ms != null && (
                          <span className={`text-xs tabular-nums ${
                            durationDiff != null
                              ? durationDiff >= 0 ? "text-green-400" : "text-red-400"
                              : "text-[var(--muted)]"
                          }`}>
                            {formatMs(row.stepB.duration_ms)}
                          </span>
                        )}
                      </div>
                      {row.stepB.error && (
                        <p className="text-xs text-red-400 truncate">{row.stepB.error}</p>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-[var(--muted)]">-</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TimingComparison({ a, b }: { a: SessionAnalysis; b: SessionAnalysis }) {
  // Build timing rows — merge steps by position
  const maxLen = Math.max(a.steps.length, b.steps.length);
  const maxDuration = Math.max(
    ...a.steps.map((s) => s.duration_ms ?? 0),
    ...b.steps.map((s) => s.duration_ms ?? 0),
    1, // prevent division by zero
  );

  if (maxLen === 0) return null;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
      <div className="p-4 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold">Timing Comparison</h3>
      </div>
      <div className="p-4 space-y-3">
        {Array.from({ length: maxLen }, (_, i) => {
          const stepA = i < a.steps.length ? a.steps[i]! : null;
          const stepB = i < b.steps.length ? b.steps[i]! : null;
          const durA = stepA?.duration_ms ?? 0;
          const durB = stepB?.duration_ms ?? 0;
          const pctA = maxDuration > 0 ? (durA / maxDuration) * 100 : 0;
          const pctB = maxDuration > 0 ? (durB / maxDuration) * 100 : 0;
          const label = stepA?.title ?? stepB?.title ?? `Step ${i + 1}`;

          return (
            <div key={i}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-[var(--foreground)] truncate max-w-[60%]">
                  <span className="text-[var(--muted)] font-mono mr-1">{i + 1}.</span>
                  {label}
                </span>
                <span className="text-xs text-[var(--muted)] font-mono tabular-nums">
                  {formatMs(durA || null)} / {formatMs(durB || null)}
                </span>
              </div>
              <div className="space-y-1">
                {/* Bar A */}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-[var(--muted)] w-4 text-right">A</span>
                  <div className="flex-1 h-3 bg-[var(--border)]/50 rounded overflow-hidden">
                    <div
                      className={`h-full rounded transition-all duration-500 ${
                        durA <= durB ? "bg-green-500/70" : "bg-red-500/70"
                      }`}
                      style={{ width: `${Math.max(pctA, 1)}%` }}
                    />
                  </div>
                </div>
                {/* Bar B */}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-[var(--muted)] w-4 text-right">B</span>
                  <div className="flex-1 h-3 bg-[var(--border)]/50 rounded overflow-hidden">
                    <div
                      className={`h-full rounded transition-all duration-500 ${
                        durB <= durA ? "bg-green-500/70" : "bg-red-500/70"
                      }`}
                      style={{ width: `${Math.max(pctB, 1)}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ResultsSummary({ a, b }: { a: SessionAnalysis; b: SessionAnalysis }) {
  const successRateA = a.total_steps > 0 ? (a.succeeded / a.total_steps) * 100 : 0;
  const successRateB = b.total_steps > 0 ? (b.succeeded / b.total_steps) * 100 : 0;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
      <div className="p-4 border-b border-[var(--border)]">
        <h3 className="text-sm font-semibold">Results Summary</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left p-3 text-xs text-[var(--muted)] font-semibold uppercase tracking-wider">Metric</th>
              <th className="text-right p-3 text-xs text-[var(--muted)] font-semibold uppercase tracking-wider">Session A</th>
              <th className="text-right p-3 text-xs text-[var(--muted)] font-semibold uppercase tracking-wider">Session B</th>
              <th className="text-right p-3 text-xs text-[var(--muted)] font-semibold uppercase tracking-wider">Diff</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            <ResultRow label="Status" valA={a.session.status} valB={b.session.status} />
            <ResultRow
              label="Duration"
              valA={formatMs(a.duration_ms)}
              valB={formatMs(b.duration_ms)}
              diff={a.duration_ms != null && b.duration_ms != null ? b.duration_ms - a.duration_ms : null}
              diffFmt={(d) => `${d > 0 ? "+" : ""}${formatMs(Math.abs(d))}`}
              lowerIsBetter
            />
            <ResultRow
              label="Total Steps"
              valA={String(a.total_steps)}
              valB={String(b.total_steps)}
            />
            <ResultRow
              label="Succeeded"
              valA={String(a.succeeded)}
              valB={String(b.succeeded)}
              diff={b.succeeded - a.succeeded}
              higherIsBetter
            />
            <ResultRow
              label="Failed"
              valA={String(a.failed)}
              valB={String(b.failed)}
              diff={b.failed - a.failed}
              lowerIsBetter
            />
            <ResultRow
              label="Success Rate"
              valA={`${successRateA.toFixed(0)}%`}
              valB={`${successRateB.toFixed(0)}%`}
              diff={successRateB - successRateA}
              diffFmt={(d) => `${d > 0 ? "+" : ""}${d.toFixed(0)}%`}
              higherIsBetter
            />
            {(a.total_tokens > 0 || b.total_tokens > 0) && (
              <ResultRow
                label="Total Tokens"
                valA={a.total_tokens > 0 ? a.total_tokens.toLocaleString() : "-"}
                valB={b.total_tokens > 0 ? b.total_tokens.toLocaleString() : "-"}
                diff={a.total_tokens > 0 && b.total_tokens > 0 ? b.total_tokens - a.total_tokens : null}
                lowerIsBetter
              />
            )}
            {(a.total_cost > 0 || b.total_cost > 0) && (
              <ResultRow
                label="Cost"
                valA={a.total_cost > 0 ? `$${a.total_cost.toFixed(4)}` : "-"}
                valB={b.total_cost > 0 ? `$${b.total_cost.toFixed(4)}` : "-"}
                diff={a.total_cost > 0 && b.total_cost > 0 ? b.total_cost - a.total_cost : null}
                diffFmt={(d) => `${d > 0 ? "+" : "-"}$${Math.abs(d).toFixed(4)}`}
                lowerIsBetter
              />
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResultRow({
  label,
  valA,
  valB,
  diff,
  diffFmt,
  lowerIsBetter,
  higherIsBetter,
}: {
  label: string;
  valA: string;
  valB: string;
  diff?: number | null;
  diffFmt?: (d: number) => string;
  lowerIsBetter?: boolean;
  higherIsBetter?: boolean;
}) {
  let diffColor = "text-[var(--muted)]";
  let diffText = "-";

  if (diff != null && diff !== 0) {
    const formatter = diffFmt ?? ((d: number) => `${d > 0 ? "+" : ""}${d}`);
    diffText = formatter(diff);
    if (lowerIsBetter) {
      diffColor = diff < 0 ? "text-green-400" : "text-red-400";
    } else if (higherIsBetter) {
      diffColor = diff > 0 ? "text-green-400" : "text-red-400";
    }
  } else if (diff === 0) {
    diffText = "=";
  }

  return (
    <tr className="hover:bg-white/[0.02]">
      <td className="p-3 text-[var(--muted)]">{label}</td>
      <td className="p-3 text-right font-mono tabular-nums">{valA}</td>
      <td className="p-3 text-right font-mono tabular-nums">{valB}</td>
      <td className={`p-3 text-right font-mono tabular-nums ${diffColor}`}>{diffText}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function ComparePage() {
  return (
    <Suspense fallback={
      <div className="space-y-4 animate-pulse">
        <div className="h-10 rounded-lg bg-[var(--border)]/30 w-48" />
        <div className="h-20 rounded-lg bg-[var(--border)]/30" />
        <div className="h-64 rounded-lg bg-[var(--border)]/30" />
      </div>
    }>
      <ComparePageInner />
    </Suspense>
  );
}

function ComparePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const paramA = searchParams.get("a") ?? "";
  const paramB = searchParams.get("b") ?? "";

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [idA, setIdA] = useState(paramA);
  const [idB, setIdB] = useState(paramB);
  const [analysisA, setAnalysisA] = useState<SessionAnalysis | null>(null);
  const [analysisB, setAnalysisB] = useState<SessionAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync from URL params on mount
  useEffect(() => {
    const a = searchParams.get("a") ?? "";
    const b = searchParams.get("b") ?? "";
    if (a) setIdA(a);
    if (b) setIdB(b);
  }, [searchParams]);

  // Load sessions list
  useEffect(() => {
    getSessions().then(setSessions).catch((e) => setError(e.message));
  }, []);

  // Update URL when selections change
  const updateUrl = useCallback(
    (a: string, b: string) => {
      const params = new URLSearchParams();
      if (a) params.set("a", a);
      if (b) params.set("b", b);
      const qs = params.toString();
      router.replace(`/compare${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router],
  );

  const handleSelectA = useCallback(
    (id: string) => {
      setIdA(id);
      updateUrl(id, idB);
    },
    [idB, updateUrl],
  );

  const handleSelectB = useCallback(
    (id: string) => {
      setIdB(id);
      updateUrl(idA, id);
    },
    [idA, updateUrl],
  );

  // Fetch and analyze both sessions
  const runComparison = useCallback(async () => {
    if (!idA || !idB) return;
    setLoading(true);
    setError(null);
    setAnalysisA(null);
    setAnalysisB(null);

    try {
      const [sessionA, sessionB, eventsA, eventsB] = await Promise.all([
        getSession(idA),
        getSession(idB),
        getJournal(idA).catch(() => [] as JournalEvent[]),
        getJournal(idB).catch(() => [] as JournalEvent[]),
      ]);
      setAnalysisA(analyzeSession(sessionA, eventsA));
      setAnalysisB(analyzeSession(sessionB, eventsB));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [idA, idB]);

  // Auto-compare when both IDs are present from URL
  useEffect(() => {
    if (paramA && paramB) {
      runComparison();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap sessions
  const handleSwap = useCallback(() => {
    const tmpA = idA;
    const tmpB = idB;
    setIdA(tmpB);
    setIdB(tmpA);
    updateUrl(tmpB, tmpA);
    // Swap analysis too
    setAnalysisA((prev) => {
      const old = analysisB;
      setAnalysisB(prev);
      return old;
    });
  }, [idA, idB, analysisB, updateUrl]);

  const bothSelected = idA !== "" && idB !== "";

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/" className="text-[var(--muted)] hover:text-[var(--foreground)] text-sm">
          &larr; Sessions
        </Link>
        <span className="text-[var(--muted)]">/</span>
        <h2 className="text-xl font-semibold">Compare Sessions</h2>
      </div>

      {/* Session selectors */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 mb-6">
        <div className="flex flex-wrap items-end gap-4">
          <SessionSelector
            label="Session A"
            value={idA}
            sessions={sessions}
            onChange={handleSelectA}
            otherValue={idB}
          />
          <button
            onClick={handleSwap}
            disabled={!bothSelected}
            className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] border border-[var(--border)] rounded px-2 py-1.5 disabled:opacity-30 transition-colors"
            title="Swap sessions"
          >
            &harr;
          </button>
          <SessionSelector
            label="Session B"
            value={idB}
            sessions={sessions}
            onChange={handleSelectB}
            otherValue={idA}
          />
          <button
            onClick={runComparison}
            disabled={!bothSelected || loading}
            className="bg-[var(--accent)] text-white rounded px-4 py-1.5 text-sm hover:opacity-90 disabled:opacity-50 transition-opacity ml-auto"
          >
            {loading ? "Comparing..." : "Compare"}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="space-y-4 animate-pulse">
          <div className="grid grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-24 rounded-lg bg-[var(--border)]/30" />
            ))}
          </div>
          <div className="h-48 rounded-lg bg-[var(--border)]/30" />
          <div className="h-64 rounded-lg bg-[var(--border)]/30" />
        </div>
      )}

      {/* Comparison results */}
      {analysisA && analysisB && !loading && (
        <div className="space-y-6">
          {/* Session headers */}
          <div className="grid grid-cols-2 gap-4">
            <SessionHeader analysis={analysisA} label="Session A" />
            <SessionHeader analysis={analysisB} label="Session B" />
          </div>

          {/* Metric cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              label="Duration"
              valueA={analysisA.duration_ms}
              valueB={analysisB.duration_ms}
              formatFn={formatMs}
              lowerIsBetter
            />
            <MetricCard
              label="Steps Succeeded"
              valueA={analysisA.succeeded}
              valueB={analysisB.succeeded}
            />
            <MetricCard
              label="Steps Failed"
              valueA={analysisA.failed}
              valueB={analysisB.failed}
              lowerIsBetter
            />
            <MetricCard
              label="Total Steps"
              valueA={analysisA.total_steps}
              valueB={analysisB.total_steps}
            />
          </div>

          {/* Plan comparison */}
          <PlanComparison a={analysisA} b={analysisB} />

          {/* Step-by-step comparison */}
          <StepComparison a={analysisA} b={analysisB} />

          {/* Timing comparison */}
          <TimingComparison a={analysisA} b={analysisB} />

          {/* Results summary table */}
          <ResultsSummary a={analysisA} b={analysisB} />
        </div>
      )}

      {/* Empty state */}
      {!analysisA && !analysisB && !loading && !error && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-12 text-center">
          <p className="text-[var(--muted)] text-sm">
            Select two sessions above and click Compare to see a side-by-side analysis.
          </p>
        </div>
      )}
    </div>
  );
}

function SessionHeader({ analysis, label }: { analysis: SessionAnalysis; label: string }) {
  const s = analysis.session;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs text-[var(--muted)] font-semibold uppercase tracking-wider">{label}</span>
        <StatusBadge status={s.status} />
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Link
            href={`/sessions/${s.session_id}`}
            className="text-[var(--accent)] hover:underline font-mono text-xs"
          >
            {s.session_id.slice(0, 8)}...
          </Link>
          {s.mode && (
            <span className="text-[10px] text-[var(--muted)] bg-[var(--border)]/50 rounded px-1.5 py-0.5 uppercase">
              {s.mode}
            </span>
          )}
        </div>
        {(s.task_text ?? s.task?.text) && (
          <p className="text-xs text-[var(--muted)] truncate">{s.task_text ?? s.task?.text}</p>
        )}
        <div className="flex items-center gap-4 text-xs text-[var(--muted)]">
          <span>Created: {new Date(s.created_at).toLocaleString()}</span>
          <span>Duration: {formatMs(analysis.duration_ms)}</span>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";

export interface StepData {
  step_id: string;
  title: string;
  tool: string;
  status: "pending" | "running" | "succeeded" | "failed";
  started_at?: string;
  finished_at?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
}

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pending:   { bg: "bg-gray-500/10",    text: "text-gray-400",    label: "pending" },
  running:   { bg: "bg-yellow-500/10",  text: "text-yellow-400",  label: "running" },
  succeeded: { bg: "bg-green-500/10",   text: "text-green-400",   label: "success" },
  failed:    { bg: "bg-red-500/10",     text: "text-red-400",     label: "failed" },
};

function formatDuration(start?: string, end?: string): string | null {
  if (!start) return null;
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  const ms = endMs - startMs;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function StepCard({ step }: { step: StepData }) {
  const [expanded, setExpanded] = useState(false);
  const style = STATUS_STYLES[step.status] ?? STATUS_STYLES.pending!;
  const duration = formatDuration(step.started_at, step.finished_at);

  return (
    <div className={`rounded-lg border border-[var(--border)] ${step.status === "running" ? "border-yellow-500/30" : ""}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-white/[0.02]"
      >
        <span className={`h-2 w-2 rounded-full flex-shrink-0 ${
          step.status === "running" ? "bg-yellow-500 animate-pulse" :
          step.status === "succeeded" ? "bg-green-500" :
          step.status === "failed" ? "bg-red-500" :
          "bg-gray-500"
        }`} />

        <div className="flex-1 min-w-0">
          <p className="text-sm truncate">{step.title}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs font-mono text-[var(--accent)]">{step.tool}</span>
            {duration && <span className="text-xs text-[var(--muted)]">{duration}</span>}
          </div>
        </div>

        <span className={`text-xs px-2 py-0.5 rounded-full ${style.bg} ${style.text}`}>
          {style.label}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] p-3 text-xs space-y-2">
          {step.error && (
            <div className="rounded bg-red-500/10 p-2 text-red-400">{step.error}</div>
          )}
          {step.input && Object.keys(step.input).length > 0 && (
            <div>
              <p className="text-[var(--muted)] mb-1">Input</p>
              <pre className="text-[var(--muted)] overflow-x-auto">{JSON.stringify(step.input, null, 2)}</pre>
            </div>
          )}
          {step.output && Object.keys(step.output).length > 0 && (
            <div>
              <p className="text-[var(--muted)] mb-1">Output</p>
              <pre className="text-[var(--muted)] overflow-x-auto">{JSON.stringify(step.output, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

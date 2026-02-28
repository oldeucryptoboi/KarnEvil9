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

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string; border: string }> = {
  pending:   { bg: "bg-gray-500/10",    text: "text-gray-400",    label: "pending",  border: "border-l-gray-500/40" },
  running:   { bg: "bg-yellow-500/10",  text: "text-yellow-400",  label: "running",  border: "border-l-yellow-500" },
  succeeded: { bg: "bg-green-500/10",   text: "text-green-400",   label: "success",  border: "border-l-green-500" },
  failed:    { bg: "bg-red-500/10",     text: "text-red-400",     label: "failed",   border: "border-l-red-500" },
};

function formatDuration(start?: string, end?: string): string | null {
  if (!start) return null;
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  const ms = endMs - startMs;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function StepOutput({ output }: { output: Record<string, unknown> }) {
  const stdout = output.stdout as string | undefined;
  const stderr = output.stderr as string | undefined;
  const exitCode = output.exit_code as number | undefined;
  const content = output.content as string | undefined;
  const error = output.error as string | undefined;

  // Shell-exec output: show stdout/stderr as code blocks
  if (stdout !== undefined || stderr !== undefined || exitCode !== undefined) {
    return (
      <div className="space-y-1.5">
        {exitCode !== undefined && exitCode !== 0 && (
          <p className="text-red-400">Exit code: {exitCode}</p>
        )}
        {stdout && (
          <pre className="rounded bg-black/30 p-2 text-green-300/80 overflow-x-auto max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all">{stdout}</pre>
        )}
        {stderr && (
          <pre className="rounded bg-black/30 p-2 text-red-300/80 overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all">{stderr}</pre>
        )}
      </div>
    );
  }

  // Read-file output: show file content
  if (content !== undefined) {
    return (
      <div className="space-y-1.5">
        {"size_bytes" in output && (
          <p className="text-[var(--muted)]">{output.size_bytes as number} bytes</p>
        )}
        <pre className="rounded bg-black/30 p-2 text-[var(--foreground)]/80 overflow-x-auto max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all">{content}</pre>
      </div>
    );
  }

  // Error output
  if (error) {
    return <pre className="rounded bg-red-500/10 p-2 text-red-400 overflow-x-auto">{error}</pre>;
  }

  // Fallback: raw JSON
  return <pre className="text-[var(--muted)] overflow-x-auto">{JSON.stringify(output, null, 2)}</pre>;
}

export function StepCard({ step, index }: { step: StepData; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const style = STATUS_STYLES[step.status] ?? STATUS_STYLES.pending!;
  const duration = formatDuration(step.started_at, step.finished_at);

  return (
    <div className={`rounded-lg border border-[var(--border)] border-l-3 ${style.border} ${step.status === "running" ? "bg-yellow-500/[0.03]" : ""}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        {/* Step number */}
        <span className="text-xs font-mono text-[var(--muted)] w-5 text-right flex-shrink-0">
          {index + 1}
        </span>

        {/* Status indicator */}
        {step.status === "running" ? (
          <span className="relative flex h-3 w-3 flex-shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-yellow-500" />
          </span>
        ) : (
          <span className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${
            step.status === "succeeded" ? "bg-green-500" :
            step.status === "failed" ? "bg-red-500" :
            "bg-gray-500"
          }`} />
        )}

        <div className="flex-1 min-w-0">
          <p className="text-sm truncate">{step.title}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="inline-flex items-center text-xs font-mono bg-[var(--accent)]/10 text-[var(--accent)] px-1.5 py-0.5 rounded">
              {step.tool}
            </span>
            {duration && (
              <span className="text-xs text-[var(--muted)] tabular-nums">
                {step.status === "running" ? "\u23F1 " : ""}{duration}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`text-xs px-2 py-0.5 rounded-full ${style.bg} ${style.text}`}>
            {style.label}
          </span>
          <span className="text-xs text-[var(--muted)]">{expanded ? "\u25BC" : "\u25B6"}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] p-3 text-xs space-y-3">
          {/* Step ID */}
          <div className="flex items-center gap-2">
            <span className="text-[var(--muted)]">ID:</span>
            <code className="font-mono text-[var(--muted)]">{step.step_id}</code>
          </div>

          {/* Timestamps */}
          {step.started_at && (
            <div className="flex items-center gap-4">
              <span className="text-[var(--muted)]">
                Started: {new Date(step.started_at).toLocaleTimeString()}
              </span>
              {step.finished_at && (
                <span className="text-[var(--muted)]">
                  Finished: {new Date(step.finished_at).toLocaleTimeString()}
                </span>
              )}
              {duration && (
                <span className="text-[var(--muted)]">
                  Duration: <strong className="text-[var(--foreground)]">{duration}</strong>
                </span>
              )}
            </div>
          )}

          {/* Error */}
          {step.error && (
            <div className="rounded bg-red-500/10 border border-red-500/20 p-2 text-red-400">
              <p className="font-semibold mb-1">Error</p>
              {step.error}
            </div>
          )}

          {/* Input */}
          {step.input && Object.keys(step.input).length > 0 && (
            <div>
              <p className="text-[var(--muted)] mb-1 font-semibold">Input</p>
              <pre className="rounded bg-black/20 p-2 text-[var(--muted)] overflow-x-auto max-h-[200px] overflow-y-auto">
                {JSON.stringify(step.input, null, 2)}
              </pre>
            </div>
          )}

          {/* Output */}
          {step.output && Object.keys(step.output).length > 0 && (
            <div>
              <p className="text-[var(--muted)] mb-1 font-semibold">Output</p>
              <StepOutput output={step.output} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import { useApprovals, type PendingApproval, type ResolvedApproval } from "@/lib/approvals-context";
import { useWSContext } from "@/lib/ws-context";

/* ---------- Helpers ---------- */

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

function decisionLabel(decision: string): string {
  switch (decision) {
    case "allow_once": return "Allowed Once";
    case "allow_session": return "Allowed Session";
    case "allow_always": return "Allowed Always";
    case "allow_constrained": return "Allowed (Constrained)";
    case "allow_observed": return "Allowed (Observed)";
    case "deny": return "Denied";
    default: return decision;
  }
}

function decisionColor(decision: string): string {
  if (decision.startsWith("allow")) return "text-green-400";
  if (decision === "deny") return "text-red-400";
  return "text-gray-400";
}

function decisionBgColor(decision: string): string {
  if (decision.startsWith("allow")) return "bg-green-500/10 border-green-500/20";
  if (decision === "deny") return "bg-red-500/10 border-red-500/20";
  return "bg-gray-500/10 border-gray-500/20";
}

/* ---------- Pending Approval Card ---------- */

function PendingCard({
  approval,
  onDecide,
  submitting,
}: {
  approval: PendingApproval;
  onDecide: (requestId: string, decision: string) => void;
  submitting: boolean;
}) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 transition-all hover:border-amber-500/50">
      {/* Header row: tool name + pulse indicator */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
          </span>
          <h3 className="font-semibold text-sm text-amber-300">{approval.tool_name}</h3>
        </div>
        <span className="text-[10px] text-[var(--muted)] whitespace-nowrap">{timeAgo(approval.created_at)}</span>
      </div>

      {/* Session context */}
      <div className="mb-3 text-xs text-[var(--muted)]">
        <span>Session: </span>
        <span className="font-mono text-[var(--foreground)]">{approval.session_id.slice(0, 8)}</span>
        {approval.step_id && (
          <>
            <span className="mx-1.5">&middot;</span>
            <span>Step: </span>
            <span className="font-mono text-[var(--foreground)]">{approval.step_id}</span>
          </>
        )}
      </div>

      {/* Permission scopes */}
      {approval.permissions.length > 0 && (
        <div className="flex gap-1.5 flex-wrap mb-4">
          {approval.permissions.map((p, i) => (
            <span
              key={i}
              className="rounded bg-white/5 border border-[var(--border)] px-2 py-0.5 text-xs font-mono text-[var(--muted)]"
            >
              {p.scope}
            </span>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          disabled={submitting}
          onClick={() => onDecide(approval.request_id, "allow_once")}
          className="flex-1 rounded-md bg-green-500/10 border border-green-500/20 px-3 py-2 text-xs font-medium text-green-400 hover:bg-green-500/20 hover:border-green-500/30 disabled:opacity-40 transition-colors"
        >
          Allow Once
        </button>
        <button
          disabled={submitting}
          onClick={() => onDecide(approval.request_id, "allow_session")}
          className="flex-1 rounded-md bg-blue-500/10 border border-blue-500/20 px-3 py-2 text-xs font-medium text-blue-400 hover:bg-blue-500/20 hover:border-blue-500/30 disabled:opacity-40 transition-colors"
        >
          Allow Session
        </button>
        <button
          disabled={submitting}
          onClick={() => onDecide(approval.request_id, "deny")}
          className="flex-1 rounded-md bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs font-medium text-red-400 hover:bg-red-500/20 hover:border-red-500/30 disabled:opacity-40 transition-colors"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

/* ---------- History Row ---------- */

function HistoryRow({ item }: { item: ResolvedApproval }) {
  return (
    <div className={`rounded-lg border p-3 ${decisionBgColor(item.decision)}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm text-[var(--foreground)] truncate">{item.tool_name}</span>
          <span className="text-xs text-[var(--muted)] font-mono shrink-0">{item.session_id.slice(0, 8)}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className={`text-xs font-medium ${decisionColor(item.decision)}`}>
            {decisionLabel(item.decision)}
          </span>
          <span className="text-[10px] text-[var(--muted)]">{timeAgo(item.resolved_at)}</span>
        </div>
      </div>
      {item.permissions.length > 0 && (
        <div className="flex gap-1 flex-wrap mt-2">
          {item.permissions.map((p, i) => (
            <span key={i} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-mono text-[var(--muted)]">
              {p.scope}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Page ---------- */

export default function ApprovalsPage() {
  const { pending, history, decide, submittingId, error, clearError } = useApprovals();
  const { connected } = useWSContext();

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold">Approvals</h2>
          {pending.length > 0 && (
            <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-amber-500/20 px-2 text-xs font-semibold text-amber-400 tabular-nums">
              {pending.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
          <span className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
          {connected ? "Live" : "Polling"}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={clearError} className="text-red-400 hover:text-red-300 ml-3 text-xs">
            Dismiss
          </button>
        </div>
      )}

      {/* Pending Approvals */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-3">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">Pending</h3>
          <div className="flex-1 border-t border-[var(--border)]" />
        </div>
        <div className="space-y-3">
          {pending.map((approval) => (
            <PendingCard
              key={approval.request_id}
              approval={approval}
              onDecide={decide}
              submitting={submittingId === approval.request_id}
            />
          ))}
          {pending.length === 0 && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted)]">
              <p className="text-sm">No pending approvals</p>
              <p className="text-xs mt-1">New requests will appear here in real time</p>
            </div>
          )}
        </div>
      </div>

      {/* History */}
      <div>
        <div className="flex items-center gap-3 mb-3">
          <h3 className="text-sm font-semibold text-[var(--foreground)]">Recent Decisions</h3>
          <span className="text-xs text-[var(--muted)]">{history.length}</span>
          <div className="flex-1 border-t border-[var(--border)]" />
        </div>
        <div className="space-y-2">
          {history.map((item) => (
            <HistoryRow key={`${item.request_id}-${item.resolved_at}`} item={item} />
          ))}
          {history.length === 0 && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-6 text-center text-[var(--muted)]">
              <p className="text-xs">No decisions in this session yet</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

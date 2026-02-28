"use client";

import { useEffect, useState } from "react";
import { getApprovals, submitApproval, type ApprovalRequest } from "@/lib/api";

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);

  const load = () => getApprovals().then(setApprovals).catch((e) => setError(e.message));

  useEffect(() => {
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, []);

  const handleDecision = async (requestId: string, decision: string) => {
    setSubmitting(requestId);
    try {
      await submitApproval(requestId, decision);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit decision");
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div>
      <h2 className="text-xl font-semibold mb-6">Pending Approvals</h2>

      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">{error}</div>
      )}

      <div className="space-y-3">
        {approvals.map((req) => (
          <div key={req.request_id} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium text-sm">{req.tool_name}</p>
                <p className="text-xs text-[var(--muted)] mt-1">
                  Session: <span className="font-mono">{req.session_id.slice(0, 8)}</span> &middot;
                  Step: <span className="font-mono">{req.step_id}</span>
                </p>
                <div className="flex gap-1.5 mt-2 flex-wrap">
                  {req.permissions.map((p, i) => (
                    <span key={i} className="rounded bg-white/5 px-2 py-0.5 text-xs font-mono text-[var(--muted)]">
                      {p.scope}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  disabled={submitting === req.request_id}
                  onClick={() => handleDecision(req.request_id, "allow_session")}
                  className="rounded bg-green-500/10 px-3 py-1.5 text-xs text-green-400 hover:bg-green-500/20 disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  disabled={submitting === req.request_id}
                  onClick={() => handleDecision(req.request_id, "deny")}
                  className="rounded bg-red-500/10 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/20 disabled:opacity-50"
                >
                  Deny
                </button>
              </div>
            </div>
          </div>
        ))}
        {approvals.length === 0 && !error && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted)]">
            No pending approvals
          </div>
        )}
      </div>
    </div>
  );
}

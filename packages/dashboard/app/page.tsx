"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSessions, compactJournal, type SessionSummary } from "@/lib/api";
import { type SessionTemplate } from "@/lib/templates";
import { StatusBadge } from "@/components/status-badge";
import { CreateSessionDialog } from "@/components/create-session-dialog";
import { TemplatesPanel } from "@/components/templates-panel";
import { useWSContext } from "@/lib/ws-context";

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [activeTemplate, setActiveTemplate] = useState<SessionTemplate | null>(null);
  const { connected } = useWSContext();

  useEffect(() => {
    getSessions().then(setSessions).catch((e) => setError(e.message));
    const interval = setInterval(() => {
      getSessions().then(setSessions).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleUseTemplate = (template: SessionTemplate) => {
    setActiveTemplate(template);
    setShowCreateDialog(true);
  };

  const handleOpenNew = () => {
    setActiveTemplate(null);
    setShowCreateDialog(true);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold">Sessions</h2>
          <button
            onClick={handleOpenNew}
            className="bg-[var(--accent)] text-white rounded px-3 py-1.5 text-sm hover:opacity-90"
          >
            New Session
          </button>
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
          <span className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
          {connected ? "Connected" : "Disconnected"}
        </div>
      </div>

      <CreateSessionDialog
        open={showCreateDialog}
        onClose={() => {
          setShowCreateDialog(false);
          setActiveTemplate(null);
        }}
        onCreated={() => {
          getSessions().then(setSessions).catch(() => {});
        }}
        initialTemplate={activeTemplate}
      />

      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-[var(--border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--card)]">
            <tr>
              <th className="text-left p-3 font-medium text-[var(--muted)]">Session</th>
              <th className="text-left p-3 font-medium text-[var(--muted)]">Status</th>
              <th className="text-left p-3 font-medium text-[var(--muted)]">Progress</th>
              <th className="text-left p-3 font-medium text-[var(--muted)]">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {sessions.map((s) => (
              <tr key={s.session_id} className="hover:bg-white/[0.02] transition-colors">
                <td className="p-3">
                  <Link href={`/sessions/${s.session_id}`} className="text-[var(--accent)] hover:underline font-mono text-xs">
                    {s.session_id.slice(0, 8)}...
                  </Link>
                  {s.task_text && (
                    <p className="text-xs text-[var(--muted)] mt-0.5 truncate max-w-xs">{s.task_text}</p>
                  )}
                </td>
                <td className="p-3"><StatusBadge status={s.status} /></td>
                <td className="p-3 text-[var(--muted)]">
                  {s.total_steps != null ? `${s.completed_steps ?? 0}/${s.total_steps}` : "-"}
                </td>
                <td className="p-3 text-xs text-[var(--muted)]">{new Date(s.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {sessions.length === 0 && !error && (
              <tr>
                <td colSpan={4} className="p-6 text-center text-[var(--muted)]">
                  No sessions found. Start one via the CLI or API.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Templates Panel */}
      <div className="mt-6">
        <TemplatesPanel onUseTemplate={handleUseTemplate} />
      </div>

      {/* Journal Compaction */}
      {sessions.length > 0 && (
        <div className="mt-6 rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">Journal Compaction</h3>
              <p className="text-xs text-[var(--muted)] mt-0.5">
                Remove old session events from the journal to reclaim disk space.
              </p>
            </div>
            <button
              disabled={compacting}
              onClick={async () => {
                setCompacting(true);
                setCompactResult(null);
                try {
                  const activeSessions = sessions
                    .filter((s) => s.status === "running" || s.status === "planning")
                    .map((s) => s.session_id);
                  const result = await compactJournal(activeSessions.length > 0 ? activeSessions : undefined);
                  const removed = result.before - result.after;
                  setCompactResult(`Compacted: ${result.before} -> ${result.after} events (${removed} removed)`);
                  getSessions().then(setSessions).catch(() => {});
                } catch (e) {
                  setCompactResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
                } finally {
                  setCompacting(false);
                }
              }}
              className="rounded bg-[var(--accent)]/10 px-3 py-1.5 text-xs text-[var(--accent)] hover:bg-[var(--accent)]/20 disabled:opacity-50"
            >
              {compacting ? "Compacting..." : "Compact Journal"}
            </button>
          </div>
          {compactResult && (
            <p className={`text-xs mt-2 ${compactResult.startsWith("Error") ? "text-red-400" : "text-green-400"}`}>
              {compactResult}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

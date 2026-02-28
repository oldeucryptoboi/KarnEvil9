"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSessions, type SessionSummary } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";
import { useWSContext } from "@/lib/ws-context";

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { connected } = useWSContext();

  useEffect(() => {
    getSessions().then(setSessions).catch((e) => setError(e.message));
    const interval = setInterval(() => {
      getSessions().then(setSessions).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Sessions</h2>
        <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
          <span className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
          {connected ? "Connected" : "Disconnected"}
        </div>
      </div>

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
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getSession, getJournal, abortSession, type SessionDetail, type JournalEvent } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";
import { useWebSocket, type WSEvent } from "@/lib/use-websocket";

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [journal, setJournal] = useState<JournalEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { events, connected } = useWebSocket(id);

  useEffect(() => {
    if (!id) return;
    getSession(id).then(setSession).catch((e) => setError(e.message));
    getJournal(id).then(setJournal).catch(() => {});
  }, [id]);

  // Merge WebSocket events into journal
  const allEvents = [...journal];
  for (const wsEvt of events) {
    if (!allEvents.some((e) => e.event_id === wsEvt.event_id)) {
      allEvents.push(wsEvt);
    }
  }

  const handleAbort = async () => {
    if (!id) return;
    try {
      await abortSession(id);
      const updated = await getSession(id);
      setSession(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Abort failed");
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Link href="/" className="text-[var(--muted)] hover:text-[var(--foreground)] text-sm">&larr; Sessions</Link>
        <span className="text-[var(--muted)]">/</span>
        <span className="font-mono text-sm">{id?.slice(0, 8)}...</span>
        <div className="ml-auto flex items-center gap-3">
          <span className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
          {session && (session.status === "running" || session.status === "planning") && (
            <button onClick={handleAbort} className="rounded bg-red-500/10 px-3 py-1 text-xs text-red-400 hover:bg-red-500/20">
              Abort
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">{error}</div>
      )}

      {session && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
            <p className="text-xs text-[var(--muted)] mb-1">Status</p>
            <StatusBadge status={session.status} />
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
            <p className="text-xs text-[var(--muted)] mb-1">Progress</p>
            <p className="text-lg font-semibold">
              {session.total_steps != null ? `${session.completed_steps ?? 0} / ${session.total_steps}` : "-"}
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
            <p className="text-xs text-[var(--muted)] mb-1">Created</p>
            <p className="text-sm">{new Date(session.created_at).toLocaleString()}</p>
          </div>
        </div>
      )}

      <h3 className="text-lg font-semibold mb-3">Journal Events</h3>
      <div className="rounded-lg border border-[var(--border)] divide-y divide-[var(--border)] max-h-[600px] overflow-y-auto">
        {allEvents.map((evt) => (
          <div key={evt.event_id} className="p-3 hover:bg-white/[0.02]">
            <div className="flex items-center gap-3">
              <span className="text-xs text-[var(--muted)] font-mono w-20">
                {evt.timestamp.split("T")[1]?.slice(0, 12) ?? ""}
              </span>
              <span className={`text-sm font-medium ${
                evt.type.includes("failed") ? "text-red-400" :
                evt.type.includes("succeeded") ? "text-green-400" :
                "text-[var(--foreground)]"
              }`}>
                {evt.type}
              </span>
            </div>
            {Object.keys(evt.payload).length > 0 && (
              <pre className="text-xs text-[var(--muted)] mt-1 ml-[92px] overflow-x-auto">
                {JSON.stringify(evt.payload, null, 2)}
              </pre>
            )}
          </div>
        ))}
        {allEvents.length === 0 && (
          <div className="p-6 text-center text-[var(--muted)]">No events yet</div>
        )}
      </div>
    </div>
  );
}

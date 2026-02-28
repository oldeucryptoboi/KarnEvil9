"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getSession, getJournal, abortSession, type SessionDetail, type JournalEvent } from "@/lib/api";
import { useWebSocket } from "@/lib/use-websocket";
import { PhaseIndicator } from "@/components/phase-indicator";
import { PlanViewer } from "@/components/plan-viewer";
import { StepTimeline } from "@/components/step-timeline";

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [journal, setJournal] = useState<JournalEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showRawJournal, setShowRawJournal] = useState(false);
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("all");
  const [copied, setCopied] = useState(false);
  const { events, connected } = useWebSocket(id);
  const stepsEndRef = useRef<HTMLDivElement>(null);

  const copySessionId = useCallback(() => {
    if (!id) return;
    navigator.clipboard.writeText(id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!id) return;
    setLoading(true);

    // Fetch journal first — it persists on disk even after API restarts
    const journalP = getJournal(id).then((events) => {
      setJournal(events);
      return events;
    }).catch(() => [] as JournalEvent[]);

    getSession(id).then((s) => { setSession(s); setLoading(false); }).catch(async () => {
      // Session not in memory (API restarted). Reconstruct from journal.
      const events = await journalP;
      if (events.length === 0) {
        setError("Session not found");
        setLoading(false);
        return;
      }

      const createdEvt = events.find((e) => e.type === "session.created");
      const terminalEvt = [...events].reverse().find((e) =>
        e.type === "session.completed" || e.type === "session.failed" || e.type === "session.aborted"
      );
      const statusMap: Record<string, string> = {
        "session.completed": "completed",
        "session.failed": "failed",
        "session.aborted": "aborted",
      };
      const status = terminalEvt ? (statusMap[terminalEvt.type] ?? "unknown") : "unknown";
      const taskText = (createdEvt?.payload?.task_text as string)
        ?? (createdEvt?.payload?.task as string)
        ?? "";

      setSession({
        session_id: id,
        status,
        created_at: events[0]!.timestamp,
        task_text: taskText,
        completed_steps: events.filter((e) => e.type === "step.succeeded").length,
        total_steps: events.filter((e) => e.type === "step.started").length,
        mode: (createdEvt?.payload?.mode as string) ?? undefined,
      });
      setLoading(false);
    });
  }, [id]);

  // Update session status from WS events
  useEffect(() => {
    if (!session || events.length === 0) return;
    const latest = events[events.length - 1]!;
    if (latest.type === "session.completed") {
      setSession((s) => s ? { ...s, status: "completed" } : s);
    } else if (latest.type === "session.failed") {
      setSession((s) => s ? { ...s, status: "failed" } : s);
    } else if (latest.type === "session.aborted") {
      setSession((s) => s ? { ...s, status: "aborted" } : s);
    } else if (latest.type === "plan.accepted") {
      setSession((s) => s ? { ...s, status: "running" } : s);
    } else if (latest.type === "planner.requested") {
      setSession((s) => s ? { ...s, status: "planning" } : s);
    }
  }, [events, session]);

  // Auto-scroll to latest step when new events arrive
  useEffect(() => {
    if (events.length > 0) {
      stepsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [events.length]);

  // Merge WebSocket events into journal
  const allEvents = [...journal];
  for (const wsEvt of events) {
    if (!allEvents.some((e) => e.event_id === wsEvt.event_id)) {
      allEvents.push(wsEvt);
    }
  }

  // Extract plan from journal events
  const planEvent = [...allEvents].reverse().find((e) => e.type === "plan.accepted");
  const plan = (planEvent?.payload?.plan as Record<string, unknown> | undefined) ?? null;

  // Update step counts from events
  const stepStarted = allEvents.filter((e) => e.type === "step.started").length;
  const stepDone = allEvents.filter((e) => e.type === "step.succeeded" || e.type === "step.failed").length;
  const totalSteps = session?.total_steps ?? (stepStarted > 0 ? stepStarted : undefined);

  // Compute session duration
  const duration = (() => {
    if (!session?.created_at) return null;
    const start = new Date(session.created_at).getTime();
    const terminalEvt = [...allEvents].reverse().find(
      (e) => e.type === "session.completed" || e.type === "session.failed" || e.type === "session.aborted"
    );
    const end = terminalEvt ? new Date(terminalEvt.timestamp).getTime() : Date.now();
    const ms = end - start;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const min = Math.floor(ms / 60_000);
    const sec = Math.round((ms % 60_000) / 1000);
    return `${min}m ${sec}s`;
  })();

  // Unique event types for filter dropdown
  const eventTypes = [...new Set(allEvents.map((e) => e.type))].sort();
  const filteredEvents = eventTypeFilter === "all"
    ? allEvents
    : allEvents.filter((e) => e.type === eventTypeFilter);

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
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/" className="text-[var(--muted)] hover:text-[var(--foreground)] text-sm">&larr; Sessions</Link>
        <span className="text-[var(--muted)]">/</span>
        <span className="font-mono text-sm">{id?.slice(0, 8)}...</span>
        <button
          onClick={copySessionId}
          className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] border border-[var(--border)] rounded px-2 py-0.5 transition-colors"
          title="Copy full session ID"
        >
          {copied ? "Copied!" : "Copy ID"}
        </button>
        <div className="ml-auto flex items-center gap-3">
          <span className={`h-2 w-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} title={connected ? "Live" : "Disconnected"} />
          {session && (session.status === "running" || session.status === "planning") && (
            <button onClick={handleAbort} className="rounded bg-red-500/10 px-3 py-1 text-xs text-red-400 hover:bg-red-500/20">
              Abort
            </button>
          )}
        </div>
      </div>

      {session?.mode === "mock" && (
        <div className="rounded-md bg-yellow-500/10 border border-yellow-500/20 p-2 text-xs text-yellow-400 mb-4 flex items-center gap-2">
          <span className="rounded bg-yellow-500/20 px-1.5 py-0.5 font-semibold uppercase tracking-wider">Mock</span>
          <span>This session ran with a mock planner — tool outputs are simulated.</span>
        </div>
      )}

      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">{error}</div>
      )}

      {loading && !session && !error && (
        <div className="space-y-4 animate-pulse">
          <div className="h-14 rounded-lg bg-[var(--border)]/30" />
          <div className="grid grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <div key={i} className="h-20 rounded-lg bg-[var(--border)]/30" />)}
          </div>
          <div className="h-32 rounded-lg bg-[var(--border)]/30" />
        </div>
      )}

      {/* Phase Indicator */}
      {session && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 mb-4">
          <PhaseIndicator status={session.status} />
        </div>
      )}

      {/* Metadata Cards */}
      {session && (
        <div className="grid grid-cols-4 gap-4 mb-4">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
            <p className="text-xs text-[var(--muted)] mb-1">Status</p>
            <p className={`text-sm font-semibold capitalize ${
              session.status === "completed" ? "text-green-400" :
              session.status === "failed" ? "text-red-400" :
              session.status === "running" ? "text-yellow-400" :
              "text-[var(--foreground)]"
            }`}>{session.status}</p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
            <p className="text-xs text-[var(--muted)] mb-1">Progress</p>
            <p className="text-lg font-semibold">
              {totalSteps != null ? `${stepDone} / ${totalSteps}` : stepDone > 0 ? `${stepDone}` : "-"}
            </p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
            <p className="text-xs text-[var(--muted)] mb-1">Duration</p>
            <p className="text-sm font-semibold">{duration ?? "-"}</p>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
            <p className="text-xs text-[var(--muted)] mb-1">Created</p>
            <p className="text-sm">{new Date(session.created_at).toLocaleString()}</p>
          </div>
        </div>
      )}

      {/* Task Text */}
      {session && (session.task_text ?? session.task?.text) && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 mb-4">
          <div className="flex items-start gap-3">
            <span className="text-lg mt-0.5" aria-hidden="true">{"\u{1F4CB}"}</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-[var(--muted)] mb-1 uppercase tracking-wider font-semibold">Task</p>
              <p className="text-base leading-relaxed">{session.task_text ?? session.task?.text}</p>
            </div>
          </div>
        </div>
      )}

      {/* Error Details */}
      {session?.status === "failed" && (() => {
        const failedEvt = [...allEvents].reverse().find((e) => e.type === "session.failed");
        const errorMsg = (failedEvt?.payload?.error as string)
          ?? (failedEvt?.payload?.message as string)
          ?? (failedEvt?.payload?.reason as string);
        if (!errorMsg) return null;
        return (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 mb-4">
            <div className="flex items-start gap-3">
              <span className="text-lg mt-0.5 flex-shrink-0" aria-hidden="true">{"\u26A0"}</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-red-400 mb-1 uppercase tracking-wider font-semibold">Failure Reason</p>
                <p className="text-sm text-red-300">{errorMsg}</p>
                {typeof failedEvt?.payload?.code === "string" && (
                  <p className="text-xs font-mono text-red-400/70 mt-1">
                    Code: {failedEvt.payload.code}
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Plan Viewer */}
      <div className="mb-4">
        <PlanViewer plan={plan} events={allEvents} />
      </div>

      {/* Step Timeline */}
      <div className="mb-4">
        <h3 className="text-sm font-semibold mb-2">Steps</h3>
        <StepTimeline events={allEvents} />
        <div ref={stepsEndRef} />
      </div>

      {/* Raw Journal (collapsed) */}
      <div className="rounded-lg border border-[var(--border)]">
        <button
          onClick={() => setShowRawJournal(!showRawJournal)}
          className="w-full flex items-center gap-2 p-3 text-left text-sm text-[var(--muted)] hover:bg-white/[0.02]"
        >
          <span className="text-xs">{showRawJournal ? "\u25BC" : "\u25B6"}</span>
          Raw Journal ({allEvents.length} events)
        </button>

        {showRawJournal && (
          <>
            {/* Event type filter */}
            <div className="border-t border-[var(--border)] p-3 flex items-center gap-2">
              <label className="text-xs text-[var(--muted)]">Filter:</label>
              <select
                value={eventTypeFilter}
                onChange={(e) => setEventTypeFilter(e.target.value)}
                className="text-xs bg-[var(--background)] border border-[var(--border)] rounded px-2 py-1 text-[var(--foreground)]"
              >
                <option value="all">All types ({allEvents.length})</option>
                {eventTypes.map((t) => (
                  <option key={t} value={t}>
                    {t} ({allEvents.filter((e) => e.type === t).length})
                  </option>
                ))}
              </select>
              {eventTypeFilter !== "all" && (
                <span className="text-xs text-[var(--muted)]">
                  {filteredEvents.length} of {allEvents.length}
                </span>
              )}
            </div>

            <div className="border-t border-[var(--border)] divide-y divide-[var(--border)] max-h-[500px] overflow-y-auto">
              {filteredEvents.map((evt) => (
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
              {filteredEvents.length === 0 && (
                <div className="p-6 text-center text-[var(--muted)]">
                  {eventTypeFilter === "all" ? "No events yet" : `No ${eventTypeFilter} events`}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

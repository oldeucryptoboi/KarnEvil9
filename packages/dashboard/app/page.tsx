"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getSessions, compactJournal, importSession, type SessionSummary } from "@/lib/api";
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
  const [compareSelection, setCompareSelection] = useState<Set<string>>(new Set());
  const [importResult, setImportResult] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const { connected } = useWSContext();

  const toggleCompare = (sessionId: string) => {
    setCompareSelection((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else if (next.size < 2) {
        next.add(sessionId);
      } else {
        // Already have 2 selected — replace the oldest selection
        const first = next.values().next().value!;
        next.delete(first);
        next.add(sessionId);
      }
      return next;
    });
  };

  const compareIds = Array.from(compareSelection);
  const compareUrl = compareIds.length === 2
    ? `/compare?a=${encodeURIComponent(compareIds[0]!)}&b=${encodeURIComponent(compareIds[1]!)}`
    : null;

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

  const handleImportClick = () => {
    importInputRef.current?.click();
  };

  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const result = await importSession(bundle);
      setImportResult(`Imported session ${result.session_id.slice(0, 16)}... (${result.events_imported} events)`);
      getSessions().then(setSessions).catch(() => {});
    } catch (err) {
      setImportResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImporting(false);
      // Reset file input so the same file can be selected again
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }, []);

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
          <button
            onClick={handleImportClick}
            disabled={importing}
            className="rounded bg-[var(--accent)]/10 px-3 py-1.5 text-sm text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 10V2M5 5l3-3 3 3M3 12v1.5h10V12" />
            </svg>
            {importing ? "Importing..." : "Import"}
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImportFile}
          />
          {compareSelection.size > 0 && (
            <div className="flex items-center gap-2 ml-2">
              <span className="text-xs text-[var(--muted)]">
                {compareSelection.size}/2 selected
              </span>
              {compareUrl ? (
                <Link
                  href={compareUrl}
                  className="rounded bg-purple-500/10 px-3 py-1.5 text-xs text-purple-400 hover:bg-purple-500/20 transition-colors font-medium"
                >
                  Compare
                </Link>
              ) : (
                <span className="rounded bg-purple-500/5 px-3 py-1.5 text-xs text-purple-400/50 cursor-default">
                  Compare
                </span>
              )}
              <button
                onClick={() => setCompareSelection(new Set())}
                className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
                title="Clear selection"
              >
                Clear
              </button>
            </div>
          )}
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

      {importResult && (
        <div className={`rounded-md p-3 text-sm mb-4 flex items-center justify-between ${
          importResult.startsWith("Error")
            ? "bg-red-500/10 border border-red-500/20 text-red-400"
            : "bg-green-500/10 border border-green-500/20 text-green-400"
        }`}>
          <span>{importResult}</span>
          <button
            onClick={() => setImportResult(null)}
            className="text-xs opacity-60 hover:opacity-100 ml-3"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-[var(--border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--card)]">
            <tr>
              <th className="w-10 p-3">
                <span className="sr-only">Compare</span>
              </th>
              <th className="text-left p-3 font-medium text-[var(--muted)]">Session</th>
              <th className="text-left p-3 font-medium text-[var(--muted)]">Status</th>
              <th className="text-left p-3 font-medium text-[var(--muted)]">Progress</th>
              <th className="text-left p-3 font-medium text-[var(--muted)]">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {sessions.map((s) => {
              const isSelected = compareSelection.has(s.session_id);
              return (
                <tr key={s.session_id} className={`hover:bg-white/[0.02] transition-colors ${isSelected ? "bg-purple-500/[0.04]" : ""}`}>
                  <td className="p-3 text-center">
                    <button
                      onClick={() => toggleCompare(s.session_id)}
                      className={`h-4 w-4 rounded border transition-colors ${
                        isSelected
                          ? "bg-purple-500 border-purple-500"
                          : "border-[var(--border)] hover:border-purple-400"
                      }`}
                      title={isSelected ? "Deselect for comparison" : "Select for comparison"}
                    >
                      {isSelected && (
                        <svg className="h-4 w-4 text-white" viewBox="0 0 16 16" fill="none">
                          <path d="M4 8l3 3 5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                  </td>
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
              );
            })}
            {sessions.length === 0 && !error && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-[var(--muted)]">
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

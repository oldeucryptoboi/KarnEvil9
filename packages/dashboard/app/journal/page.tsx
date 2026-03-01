"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import Link from "next/link";
import {
  getSessions,
  getJournalAcrossSessions,
  type SessionSummary,
  type JournalEvent,
} from "@/lib/api";

// ── Event type badge colors ──────────────────────────────────────────────
const EVENT_TYPE_COLORS: Record<string, string> = {
  "session.created": "bg-blue-500/15 text-blue-400 border-blue-500/30",
  "session.started": "bg-blue-500/15 text-blue-400 border-blue-500/30",
  "session.completed": "bg-green-500/15 text-green-400 border-green-500/30",
  "session.failed": "bg-red-500/15 text-red-400 border-red-500/30",
  "session.aborted": "bg-orange-500/15 text-orange-400 border-orange-500/30",
  "planner.requested": "bg-violet-500/15 text-violet-400 border-violet-500/30",
  "planner.responded": "bg-violet-500/15 text-violet-400 border-violet-500/30",
  "plan.generated": "bg-purple-500/15 text-purple-400 border-purple-500/30",
  "plan.accepted": "bg-purple-500/15 text-purple-400 border-purple-500/30",
  "step.started": "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  "step.succeeded": "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  "step.failed": "bg-red-500/15 text-red-400 border-red-500/30",
  "step.skipped": "bg-gray-500/15 text-gray-400 border-gray-500/30",
  "permission.requested": "bg-amber-500/15 text-amber-400 border-amber-500/30",
  "permission.granted": "bg-teal-500/15 text-teal-400 border-teal-500/30",
  "permission.denied": "bg-rose-500/15 text-rose-400 border-rose-500/30",
  "tool.invoked": "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  "tool.result": "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  "journal.disk_warning": "bg-orange-500/15 text-orange-400 border-orange-500/30",
};

const DEFAULT_BADGE = "bg-white/5 text-[var(--muted)] border-white/10";

function badgeClass(type: string): string {
  return EVENT_TYPE_COLORS[type] ?? DEFAULT_BADGE;
}

// ── Relative time helper ─────────────────────────────────────────────────
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// ── JSON syntax highlighting (CSS-only, no libs) ─────────────────────────
function highlightJSON(json: string): string {
  // Escape HTML first
  const escaped = json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Apply syntax coloring via spans
  return escaped
    // Strings (including keys)
    .replace(
      /("(?:\\.|[^"\\])*")/g,
      (match) => {
        // Check if this is a key (followed by a colon)
        return `<span class="json-string">${match}</span>`;
      },
    )
    // Numbers
    .replace(
      /\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g,
      '<span class="json-number">$1</span>',
    )
    // Booleans and null
    .replace(
      /\b(true|false|null)\b/g,
      '<span class="json-boolean">$1</span>',
    );
}

// ── Payload preview (truncated) ──────────────────────────────────────────
function payloadPreview(payload: Record<string, unknown>, maxLen = 120): string {
  const str = JSON.stringify(payload);
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + "...";
}

// ── Pagination constants ─────────────────────────────────────────────────
const PAGE_SIZE = 50;

// ── Main component ───────────────────────────────────────────────────────
export default function JournalPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [allEvents, setAllEvents] = useState<JournalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [sessionFilter, setSessionFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Pagination
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Expanded event
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Session selector: "all" or specific session IDs
  const [selectedSessions, setSelectedSessions] = useState<string[]>([]);
  const [sessionSelectorOpen, setSessionSelectorOpen] = useState(false);

  // Load sessions on mount
  useEffect(() => {
    getSessions()
      .then((s) => {
        const sorted = [...s].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );
        setSessions(sorted);
        // Auto-select the 10 most recent sessions
        const initial = sorted.slice(0, 10).map((s) => s.session_id);
        setSelectedSessions(initial);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Fetch journal events when selected sessions change
  useEffect(() => {
    if (selectedSessions.length === 0) {
      setAllEvents([]);
      return;
    }
    setLoadingEvents(true);
    getJournalAcrossSessions(selectedSessions)
      .then((events) => {
        setAllEvents(events);
        setVisibleCount(PAGE_SIZE);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoadingEvents(false));
  }, [selectedSessions]);

  // Unique event types from loaded events
  const eventTypes = useMemo(() => {
    const types = new Set(allEvents.map((e) => e.type));
    return [...types].sort();
  }, [allEvents]);

  // Apply filters
  const filteredEvents = useMemo(() => {
    let events = allEvents;

    // Type filter
    if (selectedTypes.size > 0) {
      events = events.filter((e) => selectedTypes.has(e.type));
    }

    // Session ID filter
    if (sessionFilter.trim()) {
      const q = sessionFilter.trim().toLowerCase();
      events = events.filter((e) => e.session_id.toLowerCase().includes(q));
    }

    // Date range
    if (dateFrom) {
      const from = new Date(dateFrom).getTime();
      events = events.filter((e) => new Date(e.timestamp).getTime() >= from);
    }
    if (dateTo) {
      const to = new Date(dateTo + "T23:59:59.999Z").getTime();
      events = events.filter((e) => new Date(e.timestamp).getTime() <= to);
    }

    // Full-text search
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      events = events.filter((e) => {
        const payloadStr = JSON.stringify(e.payload).toLowerCase();
        return (
          e.type.toLowerCase().includes(q) ||
          e.session_id.toLowerCase().includes(q) ||
          e.event_id.toLowerCase().includes(q) ||
          payloadStr.includes(q)
        );
      });
    }

    return events;
  }, [allEvents, selectedTypes, sessionFilter, dateFrom, dateTo, searchQuery]);

  // Stats
  const stats = useMemo(() => {
    const byType: Record<string, number> = {};
    for (const e of filteredEvents) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
    }
    const timestamps = filteredEvents.map((e) => new Date(e.timestamp).getTime());
    const minTime = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : null;
    const maxTime = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null;
    return { total: filteredEvents.length, byType, minTime, maxTime };
  }, [filteredEvents]);

  // Visible events (paginated)
  const visibleEvents = filteredEvents.slice(0, visibleCount);
  const hasMore = visibleCount < filteredEvents.length;

  // Toggle event type filter
  const toggleType = useCallback((type: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
    setVisibleCount(PAGE_SIZE);
  }, []);

  // Clear all filters
  const clearFilters = useCallback(() => {
    setSelectedTypes(new Set());
    setSessionFilter("");
    setSearchQuery("");
    setDateFrom("");
    setDateTo("");
    setVisibleCount(PAGE_SIZE);
  }, []);

  // Toggle a session in the selector
  const toggleSession = useCallback((sid: string) => {
    setSelectedSessions((prev) => {
      if (prev.includes(sid)) return prev.filter((s) => s !== sid);
      return [...prev, sid];
    });
  }, []);

  const selectAllSessions = useCallback(() => {
    setSelectedSessions(sessions.map((s) => s.session_id));
  }, [sessions]);

  const selectRecentSessions = useCallback(
    (n: number) => {
      setSelectedSessions(sessions.slice(0, n).map((s) => s.session_id));
    },
    [sessions],
  );

  const hasActiveFilters =
    selectedTypes.size > 0 || sessionFilter || searchQuery || dateFrom || dateTo;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--muted)]">
        Loading journal...
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Journal Explorer</h2>
        <span className="text-xs text-[var(--muted)]">
          {allEvents.length} events from {selectedSessions.length} session
          {selectedSessions.length !== 1 ? "s" : ""}
        </span>
      </div>

      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">
          {error}
        </div>
      )}

      {/* Session Selector */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Sessions</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => selectRecentSessions(5)}
              className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
            >
              Last 5
            </button>
            <button
              onClick={() => selectRecentSessions(10)}
              className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
            >
              Last 10
            </button>
            <button
              onClick={selectAllSessions}
              className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
            >
              All ({sessions.length})
            </button>
            <button
              onClick={() => setSessionSelectorOpen(!sessionSelectorOpen)}
              className="text-xs text-[var(--accent)] hover:underline ml-2"
            >
              {sessionSelectorOpen ? "Hide" : "Pick"}
            </button>
          </div>
        </div>

        {sessionSelectorOpen && (
          <div className="max-h-48 overflow-y-auto border border-[var(--border)] rounded-md mt-2">
            {sessions.map((s) => {
              const checked = selectedSessions.includes(s.session_id);
              return (
                <label
                  key={s.session_id}
                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-white/[0.02] cursor-pointer text-xs"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSession(s.session_id)}
                    className="accent-[var(--accent)]"
                  />
                  <span className="font-mono text-[var(--muted)]">
                    {s.session_id.slice(0, 8)}
                  </span>
                  <span
                    className={`capitalize ${
                      s.status === "completed"
                        ? "text-green-400"
                        : s.status === "failed"
                          ? "text-red-400"
                          : s.status === "running"
                            ? "text-yellow-400"
                            : "text-[var(--muted)]"
                    }`}
                  >
                    {s.status}
                  </span>
                  {s.task_text && (
                    <span className="text-[var(--muted)] truncate max-w-xs">
                      {s.task_text.length > 60
                        ? s.task_text.substring(0, 57) + "..."
                        : s.task_text}
                    </span>
                  )}
                  <span className="ml-auto text-[var(--muted)]">
                    {new Date(s.created_at).toLocaleDateString()}
                  </span>
                </label>
              );
            })}
            {sessions.length === 0 && (
              <div className="p-4 text-center text-[var(--muted)] text-xs">No sessions found</div>
            )}
          </div>
        )}
      </div>

      {/* Stats Bar */}
      {allEvents.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
            <div className="text-xs text-[var(--muted)] mb-0.5">Total Events</div>
            <div className="text-xl font-semibold">{stats.total}</div>
            {hasActiveFilters && stats.total !== allEvents.length && (
              <div className="text-[10px] text-[var(--muted)]">of {allEvents.length}</div>
            )}
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
            <div className="text-xs text-[var(--muted)] mb-0.5">Event Types</div>
            <div className="text-xl font-semibold">{Object.keys(stats.byType).length}</div>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
            <div className="text-xs text-[var(--muted)] mb-0.5">Earliest</div>
            <div className="text-sm font-medium">
              {stats.minTime ? stats.minTime.toLocaleString() : "-"}
            </div>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
            <div className="text-xs text-[var(--muted)] mb-0.5">Latest</div>
            <div className="text-sm font-medium">
              {stats.maxTime ? stats.maxTime.toLocaleString() : "-"}
            </div>
          </div>
        </div>
      )}

      {/* Type breakdown bar */}
      {Object.keys(stats.byType).length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 mb-4">
          <h3 className="text-sm font-semibold mb-3">Events by Type</h3>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(stats.byType)
              .sort(([, a], [, b]) => b - a)
              .map(([type, count]) => (
                <button
                  key={type}
                  onClick={() => toggleType(type)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-all ${
                    selectedTypes.size === 0 || selectedTypes.has(type)
                      ? badgeClass(type)
                      : "bg-white/[0.02] text-[var(--muted)] border-[var(--border)] opacity-40"
                  }`}
                >
                  <span>{type}</span>
                  <span className="font-mono tabular-nums">{count}</span>
                </button>
              ))}
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-sm font-semibold">Filters</h3>
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="text-xs text-[var(--accent)] hover:underline"
            >
              Clear all
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Full-text search */}
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Search payloads</label>
            <input
              type="text"
              placeholder="Search events..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setVisibleCount(PAGE_SIZE);
              }}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>

          {/* Session ID filter */}
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">Session ID</label>
            <input
              type="text"
              placeholder="Filter by session ID..."
              value={sessionFilter}
              onChange={(e) => {
                setSessionFilter(e.target.value);
                setVisibleCount(PAGE_SIZE);
              }}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>

          {/* Date from */}
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">From date</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setVisibleCount(PAGE_SIZE);
              }}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>

          {/* Date to */}
          <div>
            <label className="block text-xs text-[var(--muted)] mb-1">To date</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setVisibleCount(PAGE_SIZE);
              }}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>
        </div>
      </div>

      {/* Loading indicator */}
      {loadingEvents && (
        <div className="flex items-center justify-center py-8 text-[var(--muted)] text-sm">
          Loading events...
        </div>
      )}

      {/* Event List */}
      {!loadingEvents && filteredEvents.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[4rem_1fr_10rem_9rem_1fr] gap-2 px-4 py-2 bg-white/[0.02] border-b border-[var(--border)] text-xs text-[var(--muted)] font-medium">
            <div>Seq</div>
            <div>Event Type</div>
            <div>Session</div>
            <div>Time</div>
            <div>Payload</div>
          </div>

          {/* Event rows */}
          <div className="divide-y divide-[var(--border)]">
            {visibleEvents.map((evt) => {
              const isExpanded = expandedId === evt.event_id;
              return (
                <div key={evt.event_id}>
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : evt.event_id)}
                    className="w-full grid grid-cols-[4rem_1fr_10rem_9rem_1fr] gap-2 px-4 py-2.5 text-left hover:bg-white/[0.02] transition-colors items-center"
                  >
                    {/* Sequence */}
                    <span className="text-xs font-mono text-[var(--muted)]">
                      {evt.seq !== undefined ? evt.seq : "-"}
                    </span>

                    {/* Event type badge */}
                    <span>
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${badgeClass(evt.type)}`}
                      >
                        {evt.type}
                      </span>
                    </span>

                    {/* Session ID */}
                    <span className="text-xs font-mono text-[var(--muted)]">
                      <Link
                        href={`/sessions/${evt.session_id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="hover:text-[var(--accent)] hover:underline transition-colors"
                      >
                        {evt.session_id.slice(0, 8)}
                      </Link>
                    </span>

                    {/* Timestamp */}
                    <span
                      className="text-xs text-[var(--muted)]"
                      title={new Date(evt.timestamp).toLocaleString()}
                    >
                      {relativeTime(evt.timestamp)}
                    </span>

                    {/* Payload preview */}
                    <span className="text-xs text-[var(--muted)] font-mono truncate">
                      {Object.keys(evt.payload).length > 0
                        ? payloadPreview(evt.payload)
                        : "{}"}
                    </span>
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="px-4 pb-4 bg-white/[0.01]">
                      <div className="rounded-md border border-[var(--border)] bg-[var(--background)] p-4 overflow-x-auto">
                        {/* Event metadata */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-xs">
                          <div>
                            <span className="text-[var(--muted)]">Event ID: </span>
                            <span className="font-mono">{evt.event_id}</span>
                          </div>
                          <div>
                            <span className="text-[var(--muted)]">Session: </span>
                            <Link
                              href={`/sessions/${evt.session_id}`}
                              className="font-mono text-[var(--accent)] hover:underline"
                            >
                              {evt.session_id}
                            </Link>
                          </div>
                          <div>
                            <span className="text-[var(--muted)]">Timestamp: </span>
                            <span>{new Date(evt.timestamp).toLocaleString()}</span>
                          </div>
                          {evt.seq !== undefined && (
                            <div>
                              <span className="text-[var(--muted)]">Sequence: </span>
                              <span className="font-mono">{evt.seq}</span>
                            </div>
                          )}
                          {evt.hash_prev && (
                            <div className="col-span-2 md:col-span-4">
                              <span className="text-[var(--muted)]">Hash Prev: </span>
                              <span className="font-mono text-[10px]">{evt.hash_prev}</span>
                            </div>
                          )}
                        </div>

                        {/* JSON payload with syntax highlighting */}
                        <div className="text-xs">
                          <div className="text-[var(--muted)] mb-1 font-medium">Payload</div>
                          <pre
                            className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words journal-json"
                            dangerouslySetInnerHTML={{
                              __html: highlightJSON(
                                JSON.stringify(evt.payload, null, 2),
                              ),
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--border)] bg-white/[0.02]">
            <span className="text-xs text-[var(--muted)]">
              Showing {visibleEvents.length} of {filteredEvents.length} events
            </span>
            {hasMore && (
              <button
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                className="rounded-md bg-[var(--accent)]/10 px-4 py-1.5 text-xs font-medium text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors"
              >
                Load more ({Math.min(PAGE_SIZE, filteredEvents.length - visibleCount)} more)
              </button>
            )}
          </div>
        </div>
      )}

      {/* Empty states */}
      {!loadingEvents && allEvents.length === 0 && selectedSessions.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted)]">
          No journal events found for the selected sessions.
        </div>
      )}

      {!loadingEvents && selectedSessions.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted)]">
          Select one or more sessions above to view journal events.
        </div>
      )}

      {!loadingEvents && filteredEvents.length === 0 && allEvents.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted)]">
          No events match the current filters.
          <button onClick={clearFilters} className="text-[var(--accent)] hover:underline ml-2">
            Clear filters
          </button>
        </div>
      )}

      {/* Inline styles for JSON syntax highlighting */}
      <style jsx global>{`
        .journal-json .json-string {
          color: #a5d6ff;
        }
        .journal-json .json-number {
          color: #79c0ff;
        }
        .journal-json .json-boolean {
          color: #ff7b72;
        }
      `}</style>
    </div>
  );
}

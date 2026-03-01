"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import {
  getSchedules,
  deleteSchedule,
  pauseSchedule,
  resumeSchedule,
  triggerSchedule,
  type Schedule,
} from "@/lib/api";
import { ScheduleDialog } from "@/components/schedule-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CountdownTimer } from "@/components/countdown-timer";

const GROUP_LABELS: Record<string, string> = {
  moltbook: "Moltbook",
  sigma: "Sigma",
  game: "Game",
  github: "GitHub",
  twitter: "Twitter",
  slack: "Slack",
  signal: "Signal",
  whatsapp: "WhatsApp",
  gmail: "Gmail",
  search: "Search",
  swarm: "Swarm",
  scheduler: "Scheduler",
};

function getGroup(schedule: Schedule): string {
  const prefix = schedule.name.split("-")[0] ?? "";
  return prefix || "other";
}

function getShortName(schedule: Schedule): string {
  const parts = schedule.name.split("-");
  return parts.slice(1).join("-") || schedule.name;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "active":
      return "bg-green-500/20 text-green-400";
    case "paused":
      return "bg-yellow-500/20 text-yellow-400";
    case "failed":
      return "bg-red-500/20 text-red-400";
    case "completed":
      return "bg-blue-500/20 text-blue-400";
    default:
      return "bg-gray-500/20 text-gray-400";
  }
}

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editSchedule, setEditSchedule] = useState<Schedule | null>(null);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<Schedule | null>(null);

  // Trigger feedback
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Filter
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    getSchedules()
      .then(setSchedules)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = window.setInterval(() => {
      getSchedules().then(setSchedules).catch(() => {});
    }, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteSchedule(deleteTarget.schedule_id);
      setDeleteTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete schedule");
      setDeleteTarget(null);
    }
  };

  const handleToggle = async (schedule: Schedule) => {
    setTogglingId(schedule.schedule_id);
    try {
      if (schedule.status === "active") {
        await pauseSchedule(schedule.schedule_id);
      } else if (schedule.status === "paused") {
        await resumeSchedule(schedule.schedule_id);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to toggle schedule");
    } finally {
      setTogglingId(null);
    }
  };

  const handleTrigger = async (schedule: Schedule) => {
    setTriggeringId(schedule.schedule_id);
    try {
      const result = await triggerSchedule(schedule.schedule_id);
      if (result.session_id) {
        setError(null);
      }
      // Reload to show updated run_count
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to trigger schedule");
    } finally {
      setTriggeringId(null);
    }
  };

  const handleEdit = (schedule: Schedule) => {
    setEditSchedule(schedule);
    setDialogOpen(true);
  };

  const handleCreate = () => {
    setEditSchedule(null);
    setDialogOpen(true);
  };

  // Filtered schedules
  const filteredSchedules = useMemo(() => {
    let result = schedules;
    if (statusFilter !== "all") {
      result = result.filter((s) => s.status === statusFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.action.task_text.toLowerCase().includes(q),
      );
    }
    return result;
  }, [schedules, statusFilter, searchQuery]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Schedule[]>();
    for (const s of filteredSchedules) {
      const key = getGroup(s);
      const list = groups.get(key) ?? [];
      list.push(s);
      groups.set(key, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filteredSchedules]);

  // Status counts
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: schedules.length };
    for (const s of schedules) {
      counts[s.status] = (counts[s.status] ?? 0) + 1;
    }
    return counts;
  }, [schedules]);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">Schedules</h2>
          {schedules.length > 0 && (
            <span className="text-xs text-[var(--muted)]">
              {schedules.length} schedule{schedules.length !== 1 ? "s" : ""} across{" "}
              {new Set(schedules.map(getGroup)).size} group{new Set(schedules.map(getGroup)).size !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <button
          onClick={handleCreate}
          data-testid="new-schedule-btn"
          className="bg-[var(--accent)] text-white rounded px-4 py-2 text-sm hover:opacity-90 transition-opacity flex items-center gap-2"
        >
          <span className="text-lg leading-none">+</span>
          New Schedule
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        {/* Status filter tabs */}
        <div className="flex rounded-lg border border-[var(--border)] overflow-hidden">
          {["all", "active", "paused", "failed", "completed"].map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-3 py-1.5 text-xs transition-colors ${
                statusFilter === status
                  ? "bg-white/10 text-[var(--foreground)]"
                  : "text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-white/5"
              }`}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
              {(statusCounts[status] ?? 0) > 0 && (
                <span className="ml-1.5 text-[10px] opacity-60">
                  {statusCounts[status]}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search schedules..."
          className="rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] w-64"
        />
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4 flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-300 ml-4 text-xs"
          >
            dismiss
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && schedules.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted)]">
          Loading schedules...
        </div>
      )}

      {/* Grouped schedule cards */}
      {grouped.map(([group, groupSchedules]) => (
        <div key={group} className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <h3 className="text-sm font-semibold text-[var(--foreground)]">
              {GROUP_LABELS[group] ?? group.charAt(0).toUpperCase() + group.slice(1)}
            </h3>
            <span className="text-xs text-[var(--muted)]">{groupSchedules.length}</span>
            <div className="flex-1 border-t border-[var(--border)]" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {groupSchedules.map((s) => (
              <div
                key={s.schedule_id}
                className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 hover:border-[var(--accent)]/30 transition-colors group"
              >
                {/* Card header: name + status */}
                <div className="flex items-center justify-between mb-2">
                  <h4
                    className="font-medium text-sm cursor-pointer hover:text-[var(--accent)] transition-colors truncate mr-2"
                    onClick={() => handleEdit(s)}
                    title="Click to edit"
                  >
                    {getShortName(s)}
                  </h4>
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs shrink-0 ${statusBadgeClass(s.status)}`}
                  >
                    {s.status}
                  </span>
                </div>

                {/* Task text */}
                <p className="text-xs text-[var(--muted)] mb-3 line-clamp-2" title={s.action.task_text}>
                  {s.action.task_text}
                </p>

                {/* Trigger info + run stats */}
                <div className="flex items-center gap-1.5 flex-wrap mb-3">
                  <span className="rounded bg-white/5 px-2 py-0.5 text-xs text-[var(--muted)]">
                    {s.trigger.cron ?? s.trigger.expression ?? s.trigger.interval ?? s.trigger.type}
                  </span>
                  {s.action.agentic && (
                    <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-400">
                      agentic
                    </span>
                  )}
                  <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-mono text-blue-400">
                    {s.run_count} run{s.run_count !== 1 ? "s" : ""}
                    {s.failure_count > 0 ? ` / ${s.failure_count} failed` : ""}
                  </span>
                </div>

                {/* Next run countdown */}
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[10px]">
                    {s.next_run_at ? (
                      <span className="flex items-center gap-1.5">
                        <span className="text-[var(--muted)]">Next:</span>
                        <CountdownTimer targetDate={s.next_run_at} className="text-[10px]" />
                      </span>
                    ) : (
                      <span className="text-[var(--muted)]">No upcoming run</span>
                    )}
                  </div>
                  {s.last_run_at && (
                    <span className="text-[10px] text-[var(--muted)]" title={`Last run: ${new Date(s.last_run_at).toLocaleString()}`}>
                      Last: {new Date(s.last_run_at).toLocaleTimeString()}
                    </span>
                  )}
                </div>

                {/* Last error */}
                {s.last_error && (
                  <div className="rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-400 mb-3 line-clamp-1" title={s.last_error}>
                    {s.last_error}
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex items-center gap-2 pt-2 border-t border-[var(--border)]">
                  {/* Toggle active/paused */}
                  {(s.status === "active" || s.status === "paused") && (
                    <button
                      onClick={() => handleToggle(s)}
                      disabled={togglingId === s.schedule_id}
                      className={`rounded px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
                        s.status === "active"
                          ? "bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20"
                          : "bg-green-500/10 text-green-400 hover:bg-green-500/20"
                      }`}
                      title={s.status === "active" ? "Pause schedule" : "Resume schedule"}
                    >
                      {togglingId === s.schedule_id
                        ? "..."
                        : s.status === "active"
                          ? "Pause"
                          : "Resume"}
                    </button>
                  )}

                  {/* Run Now */}
                  <button
                    onClick={() => handleTrigger(s)}
                    disabled={triggeringId === s.schedule_id}
                    className="rounded px-2 py-1 text-xs bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-colors disabled:opacity-50"
                    title="Execute this schedule immediately"
                  >
                    {triggeringId === s.schedule_id ? "Running..." : "Run Now"}
                  </button>

                  {/* Edit */}
                  <button
                    onClick={() => handleEdit(s)}
                    className="rounded px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-white/5 transition-colors"
                    title="Edit schedule"
                  >
                    Edit
                  </button>

                  {/* Spacer */}
                  <div className="flex-1" />

                  {/* Delete */}
                  <button
                    onClick={() => setDeleteTarget(s)}
                    className="rounded px-2 py-1 text-xs bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                    title="Delete schedule"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Empty state */}
      {!loading && filteredSchedules.length === 0 && !error && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center">
          <p className="text-[var(--muted)] mb-4">
            {schedules.length === 0
              ? "No schedules configured"
              : "No schedules match the current filters"}
          </p>
          {schedules.length === 0 && (
            <button
              onClick={handleCreate}
              className="bg-[var(--accent)] text-white rounded px-4 py-2 text-sm hover:opacity-90 transition-opacity"
            >
              Create your first schedule
            </button>
          )}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <ScheduleDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditSchedule(null);
        }}
        onSaved={load}
        schedule={editSchedule}
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Schedule"
        message={`Are you sure you want to delete "${deleteTarget?.name ?? ""}"? This action cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

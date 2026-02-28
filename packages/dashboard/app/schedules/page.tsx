"use client";

import { useEffect, useState, useMemo } from "react";
import { getSchedules, deleteSchedule, type Schedule } from "@/lib/api";

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

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () => getSchedules().then(setSchedules).catch((e) => setError(e.message));

  useEffect(() => { load(); }, []);

  const handleDelete = async (id: string) => {
    try {
      await deleteSchedule(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete schedule");
    }
  };

  const grouped = useMemo(() => {
    const groups = new Map<string, Schedule[]>();
    for (const s of schedules) {
      const key = getGroup(s);
      const list = groups.get(key) ?? [];
      list.push(s);
      groups.set(key, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [schedules]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Schedules</h2>
        {schedules.length > 0 && (
          <span className="text-xs text-[var(--muted)]">{schedules.length} schedules across {grouped.length} groups</span>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">{error}</div>
      )}

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
              <div key={s.schedule_id} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-medium text-sm">{getShortName(s)}</h4>
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${s.status === "active" ? "bg-green-500/20 text-green-400" : s.status === "failed" ? "bg-red-500/20 text-red-400" : "bg-gray-500/20 text-gray-400"}`}>
                    {s.status}
                  </span>
                </div>
                <p className="text-xs text-[var(--muted)] mb-3 line-clamp-2">
                  {s.action.task_text}
                </p>
                <div className="flex items-center gap-1.5 flex-wrap mb-3">
                  <span className="rounded bg-white/5 px-2 py-0.5 text-xs text-[var(--muted)]">
                    {s.trigger.cron ?? s.trigger.interval ?? s.trigger.type}
                  </span>
                  <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-mono text-blue-400">
                    {s.run_count} runs{s.failure_count > 0 ? ` · ${s.failure_count} failed` : ""}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-[var(--muted)]">
                    {s.next_run_at ? `Next: ${new Date(s.next_run_at).toLocaleString()}` : "No upcoming run"}
                  </span>
                  <button
                    onClick={() => handleDelete(s.schedule_id)}
                    className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {schedules.length === 0 && !error && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted)]">
          No schedules configured
        </div>
      )}
    </div>
  );
}

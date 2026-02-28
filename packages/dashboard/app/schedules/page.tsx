"use client";

import { useEffect, useState } from "react";
import { getSchedules, deleteSchedule, type Schedule } from "@/lib/api";

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

  return (
    <div>
      <h2 className="text-xl font-semibold mb-6">Schedules</h2>

      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">{error}</div>
      )}

      <div className="overflow-hidden rounded-lg border border-[var(--border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--card)]">
            <tr>
              <th className="text-left p-3 font-medium text-[var(--muted)]">Name</th>
              <th className="text-left p-3 font-medium text-[var(--muted)]">Trigger</th>
              <th className="text-left p-3 font-medium text-[var(--muted)]">Status</th>
              <th className="text-left p-3 font-medium text-[var(--muted)]">Runs</th>
              <th className="text-left p-3 font-medium text-[var(--muted)]">Next Run</th>
              <th className="text-right p-3 font-medium text-[var(--muted)]">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {schedules.map((s) => (
              <tr key={s.schedule_id} className="hover:bg-white/[0.02]">
                <td className="p-3 text-sm">{s.name}</td>
                <td className="p-3 font-mono text-xs text-[var(--muted)]">
                  {s.trigger.cron ?? s.trigger.interval ?? s.trigger.type}
                </td>
                <td className="p-3">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${s.status === "active" ? "bg-green-500/20 text-green-400" : "bg-gray-500/20 text-gray-400"}`}>
                    {s.status}
                  </span>
                </td>
                <td className="p-3 text-xs text-[var(--muted)]">
                  {s.run_count}{s.failure_count > 0 ? ` (${s.failure_count} failed)` : ""}
                </td>
                <td className="p-3 text-xs text-[var(--muted)]">
                  {s.next_run_at ? new Date(s.next_run_at).toLocaleString() : "-"}
                </td>
                <td className="p-3 text-right">
                  <button
                    onClick={() => handleDelete(s.schedule_id)}
                    className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 hover:bg-red-500/20"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {schedules.length === 0 && !error && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-[var(--muted)]">No schedules configured</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

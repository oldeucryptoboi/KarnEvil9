"use client";

import { useEffect, useRef, useState } from "react";
import {
  createScheduleApi,
  updateSchedule,
  type Schedule,
  type CreateScheduleInput,
  type UpdateScheduleInput,
  type ScheduleTrigger,
  type ScheduleAction,
} from "@/lib/api";

interface ScheduleDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** When provided, the dialog is in edit mode. */
  schedule?: Schedule | null;
}

type TriggerType = "every" | "cron" | "at";

const INTERVAL_PRESETS = [
  { label: "5 minutes", value: "5m" },
  { label: "15 minutes", value: "15m" },
  { label: "30 minutes", value: "30m" },
  { label: "1 hour", value: "1h" },
  { label: "2 hours", value: "2h" },
  { label: "6 hours", value: "6h" },
  { label: "12 hours", value: "12h" },
  { label: "1 day", value: "1d" },
  { label: "Custom", value: "" },
];

const INTERVAL_RE = /^\d+[smhd]$/;

function parseTriggerType(schedule: Schedule): TriggerType {
  if (schedule.trigger.type === "cron") return "cron";
  if (schedule.trigger.type === "at") return "at";
  return "every";
}

function parseTriggerInterval(schedule: Schedule): string {
  if (schedule.trigger.interval) return schedule.trigger.interval;
  return "";
}

function parseTriggerCron(schedule: Schedule): string {
  if (schedule.trigger.expression) return schedule.trigger.expression;
  if (schedule.trigger.cron) return schedule.trigger.cron;
  return "";
}

function parseTriggerAt(schedule: Schedule): string {
  if (schedule.trigger.at) return schedule.trigger.at;
  return "";
}

export function ScheduleDialog({ open, onClose, onSaved, schedule }: ScheduleDialogProps) {
  const isEdit = !!schedule;

  const [name, setName] = useState("");
  const [taskText, setTaskText] = useState("");
  const [triggerType, setTriggerType] = useState<TriggerType>("every");
  const [interval, setInterval] = useState("1h");
  const [customInterval, setCustomInterval] = useState("");
  const [cronExpression, setCronExpression] = useState("");
  const [atDatetime, setAtDatetime] = useState("");
  const [agentic, setAgentic] = useState(false);
  const [mode, setMode] = useState("live");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Initialize form when opening
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSuccess(false);
    setSubmitting(false);

    if (schedule) {
      setName(schedule.name);
      setTaskText(schedule.action.task_text);
      setTriggerType(parseTriggerType(schedule));
      const iv = parseTriggerInterval(schedule);
      const isPreset = INTERVAL_PRESETS.some((p) => p.value === iv);
      if (isPreset) {
        setInterval(iv);
        setCustomInterval("");
      } else if (iv) {
        setInterval("");
        setCustomInterval(iv);
      } else {
        setInterval("1h");
        setCustomInterval("");
      }
      setCronExpression(parseTriggerCron(schedule));
      setAtDatetime(parseTriggerAt(schedule));
      setAgentic(schedule.action.agentic ?? false);
      setMode(schedule.action.mode ?? "live");
    } else {
      setName("");
      setTaskText("");
      setTriggerType("every");
      setInterval("1h");
      setCustomInterval("");
      setCronExpression("");
      setAtDatetime("");
      setAgentic(false);
      setMode("live");
    }

    requestAnimationFrame(() => nameRef.current?.focus());
  }, [open, schedule]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  };

  const resolvedInterval = interval || customInterval;

  const validate = (): string | null => {
    if (!name.trim()) return "Name is required";
    if (name.length > 200) return "Name must be at most 200 characters";
    if (!taskText.trim()) return "Task text is required";

    if (triggerType === "every") {
      if (!resolvedInterval) return "Interval is required";
      if (!INTERVAL_RE.test(resolvedInterval)) return "Interval must be a number followed by s, m, h, or d (e.g. 30m, 1h, 1d)";
    }
    if (triggerType === "cron") {
      if (!cronExpression.trim()) return "Cron expression is required";
    }
    if (triggerType === "at") {
      if (!atDatetime.trim()) return "Date/time is required for one-time triggers";
    }

    return null;
  };

  const buildTrigger = (): ScheduleTrigger => {
    if (triggerType === "cron") {
      return { type: "cron", expression: cronExpression.trim() };
    }
    if (triggerType === "at") {
      return { type: "at", at: new Date(atDatetime).toISOString() };
    }
    return { type: "every", interval: resolvedInterval };
  };

  const buildAction = (): ScheduleAction => ({
    type: "createSession",
    task_text: taskText.trim(),
    agentic,
    mode,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      if (isEdit && schedule) {
        const input: UpdateScheduleInput = {
          name: name.trim(),
          trigger: buildTrigger(),
          action: buildAction(),
        };
        await updateSchedule(schedule.schedule_id, input);
      } else {
        const input: CreateScheduleInput = {
          name: name.trim(),
          trigger: buildTrigger(),
          action: buildAction(),
        };
        await createScheduleApi(input);
      }
      setSuccess(true);
      setTimeout(() => {
        onSaved();
        onClose();
      }, 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const inputClass =
    "w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]";

  return (
    <div
      ref={backdropRef}
      className="bg-black/50 fixed inset-0 z-50 flex items-center justify-center"
      onClick={handleBackdropClick}
    >
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {success ? (
          <div className="text-center py-4">
            <div className="text-green-400 text-sm font-semibold mb-1">
              {isEdit ? "Schedule Updated" : "Schedule Created"}
            </div>
            <div className="font-mono text-xs text-[var(--muted)]">{name}</div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <h3 className="text-lg font-semibold mb-4">
              {isEdit ? "Edit Schedule" : "New Schedule"}
            </h3>

            {/* Name */}
            <label className="block text-sm text-[var(--muted)] mb-1">Name</label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. gmail-digest"
              required
              maxLength={200}
              className={inputClass}
            />

            {/* Task Text */}
            <label className="block text-sm text-[var(--muted)] mb-1 mt-4">Task</label>
            <textarea
              value={taskText}
              onChange={(e) => setTaskText(e.target.value)}
              placeholder="Describe the task to execute..."
              required
              rows={3}
              className={`${inputClass} resize-y`}
            />

            {/* Trigger Type */}
            <label className="block text-sm text-[var(--muted)] mb-1 mt-4">Trigger Type</label>
            <div className="flex gap-2">
              {(["every", "cron", "at"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTriggerType(t)}
                  className={`px-3 py-1.5 rounded text-sm border transition-colors ${
                    triggerType === t
                      ? "bg-[var(--accent)] border-[var(--accent)] text-white"
                      : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-white/5"
                  }`}
                >
                  {t === "every" ? "Interval" : t === "cron" ? "Cron" : "One-time"}
                </button>
              ))}
            </div>

            {/* Trigger Config: Interval */}
            {triggerType === "every" && (
              <div className="mt-3">
                <label className="block text-sm text-[var(--muted)] mb-1">Interval</label>
                <select
                  value={interval}
                  onChange={(e) => {
                    setInterval(e.target.value);
                    if (e.target.value) setCustomInterval("");
                  }}
                  className={inputClass}
                >
                  {INTERVAL_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                {interval === "" && (
                  <input
                    type="text"
                    value={customInterval}
                    onChange={(e) => setCustomInterval(e.target.value)}
                    placeholder="e.g. 45m, 3h, 2d"
                    className={`${inputClass} mt-2`}
                  />
                )}
              </div>
            )}

            {/* Trigger Config: Cron */}
            {triggerType === "cron" && (
              <div className="mt-3">
                <label className="block text-sm text-[var(--muted)] mb-1">Cron Expression</label>
                <input
                  type="text"
                  value={cronExpression}
                  onChange={(e) => setCronExpression(e.target.value)}
                  placeholder="e.g. 0 */6 * * *"
                  className={`${inputClass} font-mono`}
                />
                <p className="text-[10px] text-[var(--muted)] mt-1">
                  5-field cron: minute hour day-of-month month day-of-week
                </p>
              </div>
            )}

            {/* Trigger Config: One-time */}
            {triggerType === "at" && (
              <div className="mt-3">
                <label className="block text-sm text-[var(--muted)] mb-1">Execute At</label>
                <input
                  type="datetime-local"
                  value={atDatetime}
                  onChange={(e) => setAtDatetime(e.target.value)}
                  className={inputClass}
                />
              </div>
            )}

            {/* Mode */}
            <label className="block text-sm text-[var(--muted)] mb-1 mt-4">Mode</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className={inputClass}
            >
              <option value="live">live</option>
              <option value="mock">mock</option>
            </select>

            {/* Agentic Toggle */}
            <div className="flex items-center gap-3 mt-4">
              <button
                type="button"
                role="switch"
                aria-checked={agentic}
                onClick={() => setAgentic(!agentic)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border border-[var(--border)] transition-colors ${
                  agentic ? "bg-[var(--accent)]" : "bg-[var(--background)]"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                    agentic ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
              <span className="text-sm text-[var(--foreground)]">Agentic mode</span>
            </div>

            {/* Error */}
            {error && (
              <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mt-4">
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2 mt-6">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="rounded px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)] border border-[var(--border)] hover:bg-white/5 disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !name.trim() || !taskText.trim()}
                className="bg-[var(--accent)] text-white rounded px-3 py-1.5 text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {submitting
                  ? isEdit
                    ? "Saving..."
                    : "Creating..."
                  : isEdit
                    ? "Save Changes"
                    : "Create Schedule"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

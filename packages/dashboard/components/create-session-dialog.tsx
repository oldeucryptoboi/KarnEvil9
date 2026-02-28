"use client";

import { useEffect, useRef, useState } from "react";
import { createSession } from "@/lib/api";

interface CreateSessionDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}

export function CreateSessionDialog({ open, onClose, onCreated }: CreateSessionDialogProps) {
  const [taskText, setTaskText] = useState("");
  const [mode, setMode] = useState<"mock" | "live">("mock");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Focus textarea when dialog opens
  useEffect(() => {
    if (open) {
      setTaskText("");
      setMode("mock");
      setError(null);
      setSuccessId(null);
      setSubmitting(false);
      // Delay focus slightly so the element is rendered
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [open]);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskText.trim() || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      const result = await createSession(taskText.trim(), mode);
      setSuccessId(result.session_id);
      // Brief delay to show the session ID, then close and notify parent
      setTimeout(() => {
        onCreated(result.session_id);
        onClose();
      }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={backdropRef}
      className="bg-black/50 fixed inset-0 z-50 flex items-center justify-center"
      onClick={handleBackdropClick}
    >
      <div className="bg-[var(--card)] border border-[var(--border)] rounded-lg p-6 w-full max-w-md">
        {successId ? (
          <div className="text-center py-4">
            <div className="text-green-400 text-sm font-semibold mb-1">Session Created</div>
            <div className="font-mono text-xs text-[var(--muted)]">{successId}</div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <h3 className="text-lg font-semibold mb-4">New Session</h3>

            <label className="block text-sm text-[var(--muted)] mb-1">Task</label>
            <textarea
              ref={textareaRef}
              value={taskText}
              onChange={(e) => setTaskText(e.target.value)}
              placeholder="Describe the task..."
              required
              rows={4}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] resize-y"
            />

            <label className="block text-sm text-[var(--muted)] mb-1 mt-4">Mode</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as "mock" | "live")}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            >
              <option value="mock">mock</option>
              <option value="live">live</option>
            </select>

            {error && (
              <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mt-4">
                {error}
              </div>
            )}

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
                disabled={submitting || !taskText.trim()}
                className="bg-[var(--accent)] text-white rounded px-3 py-1.5 text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                {submitting ? "Creating..." : "Create Session"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

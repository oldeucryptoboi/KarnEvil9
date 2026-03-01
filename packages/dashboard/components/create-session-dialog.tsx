"use client";

import { useEffect, useRef, useState } from "react";
import { createSession } from "@/lib/api";
import { getTemplates, saveTemplate, type SessionTemplate } from "@/lib/templates";
import { useToast } from "@/components/toast";

interface CreateSessionDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
  /** Pre-fill form from a template */
  initialTemplate?: SessionTemplate | null;
}

export function CreateSessionDialog({ open, onClose, onCreated, initialTemplate }: CreateSessionDialogProps) {
  const [taskText, setTaskText] = useState("");
  const [mode, setMode] = useState<"mock" | "live">("mock");
  const [agentic, setAgentic] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const templateNameRef = useRef<HTMLInputElement>(null);
  const { addToast } = useToast();

  // Load templates and reset state when dialog opens
  useEffect(() => {
    if (open) {
      setTemplates(getTemplates());
      setError(null);
      setSuccessId(null);
      setSubmitting(false);
      setShowSavePrompt(false);
      setTemplateName("");

      // Apply initial template if provided, otherwise reset
      if (initialTemplate) {
        setTaskText(initialTemplate.task);
        setMode(initialTemplate.mode as "mock" | "live");
        setAgentic(initialTemplate.agentic);
      } else {
        setTaskText("");
        setMode("mock");
        setAgentic(false);
      }

      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [open, initialTemplate]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showSavePrompt) {
          setShowSavePrompt(false);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose, showSavePrompt]);

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
      setTimeout(() => {
        onCreated(result.session_id);
        onClose();
      }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  const handleTemplateSelect = (templateId: string) => {
    if (!templateId) return;
    const tpl = templates.find((t) => t.id === templateId);
    if (!tpl) return;
    setTaskText(tpl.task);
    setMode(tpl.mode as "mock" | "live");
    setAgentic(tpl.agentic);
  };

  const handleSaveAsTemplate = () => {
    setShowSavePrompt(true);
    requestAnimationFrame(() => templateNameRef.current?.focus());
  };

  const handleConfirmSave = () => {
    const name = templateName.trim();
    if (!name) return;
    saveTemplate({
      name,
      task: taskText.trim(),
      mode,
      agentic,
    });
    setShowSavePrompt(false);
    setTemplateName("");
    setTemplates(getTemplates());
    addToast(`Template "${name}" saved`, "success");
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
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">New Session</h3>
              {/* Template picker */}
              <select
                value=""
                onChange={(e) => handleTemplateSelect(e.target.value)}
                className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-xs text-[var(--muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] max-w-[160px]"
              >
                <option value="">From Template...</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.builtin ? `* ${t.name}` : t.name}
                  </option>
                ))}
              </select>
            </div>

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

            {/* Agentic toggle */}
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

            {/* Save as template prompt */}
            {showSavePrompt && (
              <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
                <label className="block text-xs text-[var(--muted)] mb-1">Template name</label>
                <div className="flex gap-2">
                  <input
                    ref={templateNameRef}
                    type="text"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleConfirmSave();
                      }
                    }}
                    placeholder="My template..."
                    className="flex-1 rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                  />
                  <button
                    type="button"
                    onClick={handleConfirmSave}
                    disabled={!templateName.trim()}
                    className="rounded bg-[var(--accent)] px-2 py-1 text-xs text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowSavePrompt(false)}
                    className="rounded px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)] border border-[var(--border)] hover:bg-white/5 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mt-4">
                {error}
              </div>
            )}

            <div className="flex items-center mt-6">
              {/* Save as Template button on the left */}
              <button
                type="button"
                onClick={handleSaveAsTemplate}
                disabled={!taskText.trim() || showSavePrompt}
                className="rounded px-2 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)] border border-[var(--border)] hover:bg-white/5 disabled:opacity-50 transition-colors"
              >
                Save as Template
              </button>

              <div className="flex-1" />

              <div className="flex gap-2">
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
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

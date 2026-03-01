"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getTemplates,
  deleteTemplate,
  updateTemplateName,
  type SessionTemplate,
} from "@/lib/templates";
import { useToast } from "@/components/toast";

interface TemplatesPanelProps {
  onUseTemplate: (template: SessionTemplate) => void;
}

export function TemplatesPanel({ onUseTemplate }: TemplatesPanelProps) {
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const { addToast } = useToast();

  const refresh = useCallback(() => {
    setTemplates(getTemplates());
  }, []);

  useEffect(() => {
    refresh();
    // Re-read when localStorage changes from another tab
    const handler = (e: StorageEvent) => {
      if (e.key === "karnevil9_session_templates") refresh();
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [refresh]);

  const handleDelete = (tpl: SessionTemplate) => {
    if (tpl.builtin) return;
    const ok = deleteTemplate(tpl.id);
    if (ok) {
      addToast(`Template "${tpl.name}" deleted`, "info");
      refresh();
    }
  };

  const handleStartEdit = (tpl: SessionTemplate) => {
    if (tpl.builtin) return;
    setEditingId(tpl.id);
    setEditName(tpl.name);
    requestAnimationFrame(() => editInputRef.current?.focus());
  };

  const handleSaveEdit = () => {
    if (!editingId || !editName.trim()) return;
    const ok = updateTemplateName(editingId, editName.trim());
    if (ok) {
      addToast("Template renamed", "success");
      refresh();
    }
    setEditingId(null);
    setEditName("");
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditName("");
  };

  if (templates.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold">Session Templates</h3>
          <p className="text-xs text-[var(--muted)] mt-0.5">
            Saved task configurations for quick session creation.
          </p>
        </div>
        <span className="text-xs text-[var(--muted)] tabular-nums">{templates.length} template{templates.length === 1 ? "" : "s"}</span>
      </div>

      <div className="space-y-2">
        {templates.map((tpl) => (
          <div
            key={tpl.id}
            className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3 group"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                {editingId === tpl.id ? (
                  <div className="flex gap-2 items-center mb-1">
                    <input
                      ref={editInputRef}
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSaveEdit();
                        if (e.key === "Escape") handleCancelEdit();
                      }}
                      className="flex-1 rounded border border-[var(--border)] bg-[var(--card)] px-2 py-0.5 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                    />
                    <button
                      onClick={handleSaveEdit}
                      disabled={!editName.trim()}
                      className="text-xs text-green-400 hover:text-green-300 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={handleCancelEdit}
                      className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-[var(--foreground)]">
                      {tpl.name}
                    </span>
                    {tpl.builtin && (
                      <span className="rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                        built-in
                      </span>
                    )}
                  </div>
                )}
                <p className="text-xs text-[var(--muted)] truncate">{tpl.task}</p>
                <div className="flex items-center gap-3 mt-1.5">
                  <span className="text-[10px] text-[var(--muted)] uppercase tracking-wide">
                    {tpl.mode}
                  </span>
                  {tpl.agentic && (
                    <span className="text-[10px] text-[var(--accent)] uppercase tracking-wide">
                      agentic
                    </span>
                  )}
                  {!tpl.builtin && (
                    <span className="text-[10px] text-[var(--muted)]">
                      {new Date(tpl.createdAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => onUseTemplate(tpl)}
                  className="rounded px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--accent)]/10 border border-[var(--accent)]/30 transition-colors"
                  title="Use this template"
                >
                  Use
                </button>
                {!tpl.builtin && (
                  <>
                    <button
                      onClick={() => handleStartEdit(tpl)}
                      className="rounded px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-white/5 border border-[var(--border)] transition-colors"
                      title="Rename template"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(tpl)}
                      className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-colors"
                      title="Delete template"
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

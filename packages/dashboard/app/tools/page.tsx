"use client";

import { useEffect, useState } from "react";
import { getTools, type ToolInfo } from "@/lib/api";

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTools().then(setTools).catch((e) => setError(e.message));
  }, []);

  return (
    <div>
      <h2 className="text-xl font-semibold mb-6">Tools</h2>

      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">{error}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {tools.map((tool) => (
          <div key={tool.name} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              <span className="text-xs text-[var(--muted)]">v{tool.version}</span>
            </div>
            <p className="text-xs text-[var(--muted)] mb-3">{tool.description}</p>
            <div className="flex items-center gap-2">
              <span className="rounded bg-white/5 px-2 py-0.5 text-xs text-[var(--muted)]">{tool.runner}</span>
              {tool.permissions.map((p) => (
                <span key={p} className="rounded bg-blue-500/10 px-2 py-0.5 text-xs font-mono text-blue-400">{p}</span>
              ))}
            </div>
          </div>
        ))}
        {tools.length === 0 && !error && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted)] col-span-full">
            No tools registered
          </div>
        )}
      </div>
    </div>
  );
}

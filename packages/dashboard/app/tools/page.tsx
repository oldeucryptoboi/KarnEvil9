"use client";

import { useEffect, useState, useMemo } from "react";
import { getTools, type ToolInfo } from "@/lib/api";

const GROUP_LABELS: Record<string, string> = {
  core: "Core",
  game: "Game",
  agent: "Agents",
  github: "GitHub",
  gmail: "Gmail",
  moltbook: "Moltbook",
  search: "Search",
  scheduler: "Scheduler",
  signal: "Signal",
  slack: "Slack",
  swarm: "Swarm",
  twitter: "Twitter",
  vault: "Vault",
  whatsapp: "WhatsApp",
};

function getGroup(tool: ToolInfo): string {
  const perm = tool.permissions[0] ?? "";
  const domain = perm.split(":")[0] ?? "";
  if (["filesystem", "shell", "network"].includes(domain)) return "core";
  return domain || "core";
}

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTools().then(setTools).catch((e) => setError(e.message));
  }, []);

  const grouped = useMemo(() => {
    const groups = new Map<string, ToolInfo[]>();
    for (const tool of tools) {
      const key = getGroup(tool);
      const list = groups.get(key) ?? [];
      list.push(tool);
      groups.set(key, list);
    }
    // Sort groups: core first, then alphabetical
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === "core") return -1;
      if (b === "core") return 1;
      return a.localeCompare(b);
    });
  }, [tools]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Tools</h2>
        {tools.length > 0 && (
          <span className="text-xs text-[var(--muted)]">{tools.length} tools across {grouped.length} groups</span>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">{error}</div>
      )}

      {grouped.map(([group, groupTools]) => (
        <div key={group} className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <h3 className="text-sm font-semibold text-[var(--foreground)]">
              {GROUP_LABELS[group] ?? group}
            </h3>
            <span className="text-xs text-[var(--muted)]">{groupTools.length}</span>
            <div className="flex-1 border-t border-[var(--border)]" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {groupTools.map((tool) => (
              <div key={tool.name} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-medium text-sm">{tool.name}</h4>
                  <span className="text-xs text-[var(--muted)]">v{tool.version}</span>
                </div>
                <p className="text-xs text-[var(--muted)] mb-3 line-clamp-2">{tool.description}</p>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="rounded bg-white/5 px-2 py-0.5 text-xs text-[var(--muted)]">{tool.runner}</span>
                  {tool.permissions.map((p) => (
                    <span key={p} className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-mono text-blue-400">{p}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {tools.length === 0 && !error && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted)]">
          No tools registered
        </div>
      )}
    </div>
  );
}

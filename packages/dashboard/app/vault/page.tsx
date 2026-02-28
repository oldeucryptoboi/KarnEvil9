"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import {
  getVaultDashboard,
  getVaultObjects,
  searchVault,
  type VaultDashboard,
  type VaultObject,
} from "@/lib/api";

const CATEGORY_LABELS: Record<string, string> = {
  inbox: "Inbox",
  projects: "Projects",
  areas: "Areas",
  resources: "Resources",
  archive: "Archive",
};

const TYPE_COLORS: Record<string, string> = {
  Conversation: "bg-blue-500/10 text-blue-400",
  Document: "bg-green-500/10 text-green-400",
  Note: "bg-yellow-500/10 text-yellow-400",
  Email: "bg-purple-500/10 text-purple-400",
  Message: "bg-pink-500/10 text-pink-400",
};

/** Extract a meaningful short title from vault objects whose title is the full task prompt. */
function getDisplayTitle(title: string): string {
  if (!title.startsWith("You are E.D.D.I.E.")) return title;

  // "You're checking DMs on Moltbook" → "Checking DMs on Moltbook"
  const youreMatch = title.match(/You're\s+(.+?)(?:\.\s|\.$|$)/);
  if (youreMatch) {
    const task = youreMatch[1]!;
    return task.charAt(0).toUpperCase() + task.slice(1);
  }

  // "You are E.D.D.I.E. Post on Moltbook about..." → "Post on Moltbook about..."
  const postMatch = title.match(/E\.D\.D\.I\.E\.\s+(Post\s+.+?)(?:\.\s|\.$|$)/);
  if (postMatch) return postMatch[1]!;

  // "You are E.D.D.I.E. — an AI agent on Moltbook. Build karma..." → "Build karma..."
  // Find first action sentence after the preamble
  const sentences = title.split(/\.\s+/);
  for (const s of sentences) {
    const trimmed = s.replace(/^[-—–]\s*/, "").trim();
    if (
      trimmed.length > 10 &&
      !trimmed.startsWith("You are") &&
      !trimmed.startsWith("You're") &&
      !/autonomous agent|KarnEvil9|Crypto Boi|oldeucryptoboi|Emergent Deterministic/.test(trimmed)
    ) {
      return trimmed.length > 120 ? trimmed.substring(0, 117) + "..." : trimmed;
    }
  }

  return title.substring(0, 80) + "...";
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="text-xs text-[var(--muted)] mb-1">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}

function BreakdownBar({ data, colorFn }: { data: Record<string, number>; colorFn?: (key: string) => string }) {
  const total = Object.values(data).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const colors = ["bg-blue-500", "bg-green-500", "bg-yellow-500", "bg-purple-500", "bg-pink-500", "bg-cyan-500", "bg-orange-500"];
  const entries = Object.entries(data).sort(([, a], [, b]) => b - a);
  return (
    <div>
      <div className="flex rounded-full overflow-hidden h-2 mb-2">
        {entries.map(([key, count], i) => (
          <div
            key={key}
            className={colorFn?.(key) ?? colors[i % colors.length]}
            style={{ width: `${(count / total) * 100}%` }}
            title={`${key}: ${count}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {entries.map(([key, count], i) => (
          <div key={key} className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <span className={`inline-block w-2 h-2 rounded-full ${colorFn?.(key) ?? colors[i % colors.length]}`} />
            {key} ({count})
          </div>
        ))}
      </div>
    </div>
  );
}

export default function VaultPage() {
  const [dashboard, setDashboard] = useState<VaultDashboard | null>(null);
  const [objects, setObjects] = useState<VaultObject[]>([]);
  const [total, setTotal] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getVaultDashboard(),
      getVaultObjects({ limit: 100 }),
    ])
      .then(([dash, objs]) => {
        setDashboard(dash);
        setObjects(objs.results);
        setTotal(objs.total);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q) {
      setActiveSearch("");
      setLoading(true);
      try {
        const objs = await getVaultObjects({ limit: 100 });
        setObjects(objs.results);
        setTotal(objs.total);
      } catch (e: unknown) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
      return;
    }
    setActiveSearch(q);
    setLoading(true);
    try {
      const res = await searchVault(q, { limit: 100 });
      setObjects(res.results);
      setTotal(res.total);
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [searchQuery]);

  const grouped = useMemo(() => {
    const groups = new Map<string, VaultObject[]>();
    for (const obj of objects) {
      const key = obj.para_category || "inbox";
      const list = groups.get(key) ?? [];
      list.push(obj);
      groups.set(key, list);
    }
    const order = ["projects", "areas", "resources", "inbox", "archive"];
    return [...groups.entries()].sort(([a], [b]) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  }, [objects]);

  if (loading && !dashboard) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--muted)]">
        Loading vault...
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Vault</h2>
        {dashboard && (
          <span className="text-xs text-[var(--muted)]">
            {dashboard.total_objects} objects &middot; {dashboard.total_links} links
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">
          {error}
        </div>
      )}

      {/* Stats */}
      {dashboard && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard label="Total Objects" value={dashboard.total_objects} />
          <StatCard label="Links" value={dashboard.total_links} />
          <StatCard label="Unclassified" value={dashboard.unclassified_count} />
          <StatCard label="Embedding Coverage" value={`${Math.round(dashboard.embedding_coverage * 100)}%`} />
        </div>
      )}

      {/* Breakdowns */}
      {dashboard && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {Object.keys(dashboard.objects_by_type).length > 0 && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
              <h3 className="text-sm font-semibold mb-3">By Type</h3>
              <BreakdownBar data={dashboard.objects_by_type} />
            </div>
          )}
          {Object.keys(dashboard.objects_by_source).length > 0 && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
              <h3 className="text-sm font-semibold mb-3">By Source</h3>
              <BreakdownBar data={dashboard.objects_by_source} />
            </div>
          )}
        </div>
      )}

      {/* Search */}
      <div className="flex gap-2 mb-6">
        <input
          type="text"
          placeholder="Search vault..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          className="flex-1 rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
        />
        <button
          onClick={handleSearch}
          className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
        >
          Search
        </button>
        {activeSearch && (
          <button
            onClick={() => { setSearchQuery(""); setActiveSearch(""); getVaultObjects({ limit: 100 }).then((r) => { setObjects(r.results); setTotal(r.total); }); }}
            className="rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {activeSearch && (
        <div className="text-xs text-[var(--muted)] mb-4">
          {total} results for &ldquo;{activeSearch}&rdquo;
        </div>
      )}

      {/* Objects grouped by PARA category */}
      {grouped.map(([category, categoryObjects]) => (
        <div key={category} className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <h3 className="text-sm font-semibold text-[var(--foreground)]">
              {CATEGORY_LABELS[category] ?? category}
            </h3>
            <span className="text-xs text-[var(--muted)]">{categoryObjects.length}</span>
            <div className="flex-1 border-t border-[var(--border)]" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {categoryObjects.map((obj) => (
              <div key={obj.object_id} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-medium text-sm truncate flex-1 mr-2" title={obj.title}>{getDisplayTitle(obj.title)}</h4>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-mono whitespace-nowrap ${TYPE_COLORS[obj.object_type] ?? "bg-white/5 text-[var(--muted)]"}`}>
                    {obj.object_type}
                  </span>
                </div>
                <div className="text-xs text-[var(--muted)] mb-2 truncate" title={obj.file_path}>
                  {obj.file_path}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="rounded bg-white/5 px-2 py-0.5 text-xs text-[var(--muted)]">{obj.source}</span>
                  {obj.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-mono text-blue-400">
                      {tag}
                    </span>
                  ))}
                  {obj.tags.length > 3 && (
                    <span className="text-[10px] text-[var(--muted)]">+{obj.tags.length - 3}</span>
                  )}
                </div>
                {obj.entities.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap mt-2">
                    {obj.entities.slice(0, 3).map((ent) => (
                      <span key={ent} className="rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] font-mono text-green-400">
                        {ent}
                      </span>
                    ))}
                    {obj.entities.length > 3 && (
                      <span className="text-[10px] text-[var(--muted)]">+{obj.entities.length - 3}</span>
                    )}
                  </div>
                )}
                <div className="text-[10px] text-[var(--muted)] mt-2">
                  {new Date(obj.created_at).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {objects.length === 0 && !loading && !error && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted)]">
          {activeSearch ? "No results found" : "Vault is empty"}
        </div>
      )}
    </div>
  );
}

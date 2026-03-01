"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import {
  getPluginsCatalog,
  reloadPlugin,
  unloadPlugin,
  installPlugin,
  type PluginInfo,
  type PluginStatus,
} from "@/lib/api";

const STATUS_STYLES: Record<string, string> = {
  active: "bg-green-500/10 text-green-400",
  loading: "bg-yellow-500/10 text-yellow-400",
  failed: "bg-red-500/10 text-red-400",
  unloaded: "bg-gray-500/10 text-gray-400",
  discovered: "bg-blue-500/10 text-blue-400",
  available: "bg-gray-500/10 text-gray-400",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  loading: "Loading",
  failed: "Failed",
  unloaded: "Unloaded",
  discovered: "Discovered",
  available: "Available",
};

// ─── Toast Notification System ──────────────────────────────────

interface Toast {
  id: number;
  message: string;
  type: "success" | "error";
}

let toastId = 0;

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`rounded-lg border px-4 py-3 text-sm shadow-lg transition-all animate-in slide-in-from-right ${
            t.type === "success"
              ? "bg-green-500/10 border-green-500/20 text-green-400"
              : "bg-red-500/10 border-red-500/20 text-red-400"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <span>{t.message}</span>
            <button
              onClick={() => onDismiss(t.id)}
              className="text-[var(--muted)] hover:text-[var(--foreground)] shrink-0"
            >
              x
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Spinner ────────────────────────────────────────────────────

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="animate-spin"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
    >
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
    </svg>
  );
}

// ─── Sub-components ─────────────────────────────────────────────

function StatusBadge({ status }: { status: PluginStatus }) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_STYLES[status] ?? "bg-white/5 text-[var(--muted)]"}`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="text-xs text-[var(--muted)] mb-1">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}

function ProvidesList({
  label,
  items,
  colorClass,
}: {
  label: string;
  items: string[];
  colorClass: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="text-xs font-semibold text-[var(--muted)] mb-1.5">{label}</div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {items.map((item) => (
          <span
            key={item}
            className={`rounded px-2 py-0.5 text-[11px] font-mono ${colorClass}`}
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function ActionButton({
  label,
  colorClass,
  loading,
  onClick,
}: {
  label: string;
  colorClass: string;
  loading: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`rounded-md px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${colorClass}`}
    >
      {loading ? <Spinner size={12} /> : label}
    </button>
  );
}

// ─── Detail Panel ───────────────────────────────────────────────

function PluginDetailPanel({
  plugin,
  onClose,
  onAction,
  actionLoading,
}: {
  plugin: PluginInfo;
  onClose: () => void;
  onAction: (id: string, action: "reload" | "unload" | "install") => void;
  actionLoading: string | null;
}) {
  const { manifest } = plugin;
  const provides = manifest.provides;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-6 mb-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h3 className="text-lg font-semibold">{manifest.name}</h3>
            <StatusBadge status={plugin.status} />
          </div>
          <div className="text-xs text-[var(--muted)] font-mono">{manifest.id}</div>
        </div>
        <div className="flex items-center gap-2">
          {plugin.status === "active" && (
            <>
              <ActionButton
                label="Reload"
                colorClass="bg-blue-500/10 text-blue-400 hover:bg-blue-500/20"
                loading={actionLoading === `${plugin.id}:reload`}
                onClick={(e) => { e.stopPropagation(); onAction(plugin.id, "reload"); }}
              />
              <ActionButton
                label="Unload"
                colorClass="bg-red-500/10 text-red-400 hover:bg-red-500/20"
                loading={actionLoading === `${plugin.id}:unload`}
                onClick={(e) => { e.stopPropagation(); onAction(plugin.id, "unload"); }}
              />
            </>
          )}
          {plugin.status === "failed" && (
            <ActionButton
              label="Reload"
              colorClass="bg-blue-500/10 text-blue-400 hover:bg-blue-500/20"
              loading={actionLoading === `${plugin.id}:reload`}
              onClick={(e) => { e.stopPropagation(); onAction(plugin.id, "reload"); }}
            />
          )}
          {plugin.status === "available" && (
            <ActionButton
              label="Install"
              colorClass="bg-green-500/10 text-green-400 hover:bg-green-500/20"
              loading={actionLoading === `${plugin.id}:install`}
              onClick={(e) => { e.stopPropagation(); onAction(plugin.id, "install"); }}
            />
          )}
          <button
            onClick={onClose}
            className="rounded-md border border-[var(--border)] px-3 py-1 text-sm text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-white/5 transition-colors"
          >
            Close
          </button>
        </div>
      </div>

      {/* Manifest info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
        <div className="space-y-2">
          <div>
            <span className="text-xs text-[var(--muted)]">Version: </span>
            <span className="text-sm">{manifest.version}</span>
          </div>
          <div>
            <span className="text-xs text-[var(--muted)]">Entry: </span>
            <span className="text-sm font-mono">{manifest.entry}</span>
          </div>
          {plugin.loaded_at && (
            <div>
              <span className="text-xs text-[var(--muted)]">Loaded at: </span>
              <span className="text-sm">{new Date(plugin.loaded_at).toLocaleString()}</span>
            </div>
          )}
          {plugin.failed_at && (
            <div>
              <span className="text-xs text-[var(--muted)]">Failed at: </span>
              <span className="text-sm text-red-400">{new Date(plugin.failed_at).toLocaleString()}</span>
            </div>
          )}
        </div>
        <div>
          <div className="text-xs text-[var(--muted)] mb-1">Description</div>
          <p className="text-sm">{manifest.description}</p>
        </div>
      </div>

      {plugin.error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">
          {plugin.error}
        </div>
      )}

      {/* Permissions */}
      {manifest.permissions.length > 0 && (
        <div className="mb-4">
          <div className="text-xs font-semibold text-[var(--muted)] mb-1.5">Permissions</div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {manifest.permissions.map((perm) => (
              <span
                key={perm}
                className="rounded bg-amber-500/10 px-2 py-0.5 text-[11px] font-mono text-amber-400"
              >
                {perm}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Provides sections */}
      <div className="border-t border-[var(--border)] pt-4 mt-4">
        <h4 className="text-sm font-semibold mb-3">Provides</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
          <ProvidesList
            label="Tools"
            items={provides.tools ?? []}
            colorClass="bg-blue-500/10 text-blue-400"
          />
          <ProvidesList
            label="Hooks"
            items={provides.hooks ?? []}
            colorClass="bg-purple-500/10 text-purple-400"
          />
          <ProvidesList
            label="Routes"
            items={provides.routes ?? []}
            colorClass="bg-cyan-500/10 text-cyan-400"
          />
          <ProvidesList
            label="Commands"
            items={provides.commands ?? []}
            colorClass="bg-green-500/10 text-green-400"
          />
          <ProvidesList
            label="Planners"
            items={provides.planners ?? []}
            colorClass="bg-orange-500/10 text-orange-400"
          />
          <ProvidesList
            label="Services"
            items={provides.services ?? []}
            colorClass="bg-pink-500/10 text-pink-400"
          />
        </div>
      </div>

      {/* Config */}
      {Object.keys(plugin.config).length > 0 && (
        <div className="border-t border-[var(--border)] pt-4 mt-4">
          <h4 className="text-sm font-semibold mb-2">Configuration</h4>
          <pre className="text-xs text-[var(--muted)] bg-white/5 rounded-md p-3 overflow-x-auto">
            {JSON.stringify(plugin.config, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────

type FilterStatus = PluginStatus | "all";

export default function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<FilterStatus>("all");
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastTimeouts = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const addToast = useCallback((message: string, type: "success" | "error") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    const timeout = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      toastTimeouts.current.delete(id);
    }, 5000);
    toastTimeouts.current.set(id, timeout);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timeout = toastTimeouts.current.get(id);
    if (timeout) { clearTimeout(timeout); toastTimeouts.current.delete(id); }
  }, []);

  const fetchPlugins = useCallback(async () => {
    try {
      const res = await getPluginsCatalog();
      // Merge loaded and available into a single list for unified display
      const all: PluginInfo[] = [...res.plugins, ...res.available];
      setPlugins(all);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    fetchPlugins().finally(() => setLoading(false));
  }, [fetchPlugins]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchPlugins();
    setRefreshing(false);
  }, [fetchPlugins]);

  const handleAction = useCallback(async (pluginId: string, action: "reload" | "unload" | "install") => {
    const key = `${pluginId}:${action}`;
    setActionLoading(key);
    try {
      if (action === "reload") {
        await reloadPlugin(pluginId);
        addToast(`Plugin "${pluginId}" reloaded successfully`, "success");
      } else if (action === "unload") {
        await unloadPlugin(pluginId);
        addToast(`Plugin "${pluginId}" unloaded successfully`, "success");
      } else if (action === "install") {
        await installPlugin(pluginId);
        addToast(`Plugin "${pluginId}" installed successfully`, "success");
      }
      // Refresh the list after action
      await fetchPlugins();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast(`Failed to ${action} "${pluginId}": ${msg}`, "error");
    } finally {
      setActionLoading(null);
    }
  }, [fetchPlugins, addToast]);

  // Compute stats
  const stats = useMemo(() => {
    const totalPlugins = plugins.length;
    const activeCount = plugins.filter((p) => p.status === "active").length;
    const failedCount = plugins.filter((p) => p.status === "failed").length;
    const availableCount = plugins.filter((p) => p.status === "available").length;
    const totalTools = plugins.reduce(
      (sum, p) => sum + (p.manifest.provides.tools?.length ?? 0),
      0,
    );
    const totalHooks = plugins.reduce(
      (sum, p) => sum + (p.manifest.provides.hooks?.length ?? 0),
      0,
    );
    return { totalPlugins, activeCount, failedCount, availableCount, totalTools, totalHooks };
  }, [plugins]);

  // Filter plugins
  const filtered = useMemo(() => {
    let list = plugins;
    if (statusFilter !== "all") {
      list = list.filter((p) => p.status === statusFilter);
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.manifest.name.toLowerCase().includes(q) ||
          p.manifest.id.toLowerCase().includes(q) ||
          p.manifest.description.toLowerCase().includes(q),
      );
    }
    // Sort: active first, then available, then others
    const statusOrder: Record<string, number> = { active: 0, failed: 1, loading: 2, available: 3, unloaded: 4, discovered: 5 };
    return list.sort((a, b) => {
      const orderA = statusOrder[a.status] ?? 99;
      const orderB = statusOrder[b.status] ?? 99;
      if (orderA !== orderB) return orderA - orderB;
      return a.manifest.name.localeCompare(b.manifest.name);
    });
  }, [plugins, statusFilter, searchQuery]);

  const selectedPlugin = useMemo(
    () => plugins.find((p) => p.id === selectedPluginId) ?? null,
    [plugins, selectedPluginId],
  );

  const handleCardClick = useCallback(
    (pluginId: string) => {
      setSelectedPluginId(selectedPluginId === pluginId ? null : pluginId);
    },
    [selectedPluginId],
  );

  // Collect available statuses for the filter
  const availableStatuses = useMemo(() => {
    const set = new Set<PluginStatus>();
    for (const p of plugins) set.add(p.status);
    return [...set].sort();
  }, [plugins]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--muted)]">
        Loading plugins...
      </div>
    );
  }

  return (
    <div>
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Plugins</h2>
        <div className="flex items-center gap-3">
          {plugins.length > 0 && (
            <span className="text-xs text-[var(--muted)]">
              {stats.activeCount} active, {stats.availableCount} available of {stats.totalPlugins} total
            </span>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {refreshing ? <Spinner size={14} /> : null}
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">
          {error}
        </div>
      )}

      {/* Stats summary */}
      {plugins.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-6">
          <StatCard label="Total Plugins" value={stats.totalPlugins} />
          <StatCard label="Active" value={stats.activeCount} />
          <StatCard label="Available" value={stats.availableCount} />
          <StatCard label="Failed" value={stats.failedCount} />
          <StatCard label="Total Tools" value={stats.totalTools} />
          <StatCard label="Total Hooks" value={stats.totalHooks} />
        </div>
      )}

      {/* Search and filter */}
      {plugins.length > 0 && (
        <div className="flex gap-2 mb-6">
          <input
            type="text"
            placeholder="Search plugins by name, id, or description..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as FilterStatus)}
            className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          >
            <option value="all">All statuses</option>
            {availableStatuses.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s] ?? s}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Selected plugin detail */}
      {selectedPlugin && (
        <PluginDetailPanel
          plugin={selectedPlugin}
          onClose={() => setSelectedPluginId(null)}
          onAction={handleAction}
          actionLoading={actionLoading}
        />
      )}

      {/* Filtered count */}
      {(searchQuery || statusFilter !== "all") && filtered.length !== plugins.length && (
        <div className="text-xs text-[var(--muted)] mb-4">
          Showing {filtered.length} of {plugins.length} plugins
          {searchQuery && <> matching &ldquo;{searchQuery}&rdquo;</>}
          {statusFilter !== "all" && <> with status &ldquo;{statusFilter}&rdquo;</>}
        </div>
      )}

      {/* Plugin grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((plugin) => {
          const { manifest } = plugin;
          const provides = manifest.provides;
          const toolCount = provides.tools?.length ?? 0;
          const hookCount = provides.hooks?.length ?? 0;
          const routeCount = provides.routes?.length ?? 0;
          const serviceCount = provides.services?.length ?? 0;
          const isSelected = selectedPluginId === plugin.id;

          return (
            <div
              key={plugin.id}
              className={`rounded-lg border bg-[var(--card)] p-4 transition-colors ${
                isSelected
                  ? "border-[var(--accent)] ring-1 ring-[var(--accent)]"
                  : "border-[var(--border)] hover:border-[var(--accent)]/50"
              }`}
            >
              {/* Clickable header area */}
              <button
                onClick={() => handleCardClick(plugin.id)}
                className="w-full text-left"
              >
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-medium text-sm truncate flex-1 mr-2">
                    {manifest.name}
                  </h4>
                  <StatusBadge status={plugin.status} />
                </div>

                <div className="text-[11px] text-[var(--muted)] font-mono mb-1">
                  {manifest.id} v{manifest.version}
                </div>

                <p className="text-xs text-[var(--muted)] mb-3 line-clamp-2">
                  {manifest.description}
                </p>

                {/* Quick summary of what plugin provides */}
                <div className="flex items-center gap-2 flex-wrap">
                  {toolCount > 0 && (
                    <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-400">
                      {toolCount} {toolCount === 1 ? "tool" : "tools"}
                    </span>
                  )}
                  {hookCount > 0 && (
                    <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] text-purple-400">
                      {hookCount} {hookCount === 1 ? "hook" : "hooks"}
                    </span>
                  )}
                  {routeCount > 0 && (
                    <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] text-cyan-400">
                      {routeCount} {routeCount === 1 ? "route" : "routes"}
                    </span>
                  )}
                  {serviceCount > 0 && (
                    <span className="rounded bg-pink-500/10 px-1.5 py-0.5 text-[10px] text-pink-400">
                      {serviceCount} {serviceCount === 1 ? "service" : "services"}
                    </span>
                  )}
                  {manifest.permissions.length > 0 && (
                    <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">
                      {manifest.permissions.length} {manifest.permissions.length === 1 ? "perm" : "perms"}
                    </span>
                  )}
                </div>

                {plugin.error && (
                  <div className="text-[10px] text-red-400 mt-2 truncate" title={plugin.error}>
                    {plugin.error}
                  </div>
                )}
              </button>

              {/* Action buttons */}
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-[var(--border)]">
                {plugin.status === "active" && (
                  <>
                    <ActionButton
                      label="Reload"
                      colorClass="bg-blue-500/10 text-blue-400 hover:bg-blue-500/20"
                      loading={actionLoading === `${plugin.id}:reload`}
                      onClick={(e) => { e.stopPropagation(); handleAction(plugin.id, "reload"); }}
                    />
                    <ActionButton
                      label="Unload"
                      colorClass="bg-red-500/10 text-red-400 hover:bg-red-500/20"
                      loading={actionLoading === `${plugin.id}:unload`}
                      onClick={(e) => { e.stopPropagation(); handleAction(plugin.id, "unload"); }}
                    />
                  </>
                )}
                {plugin.status === "failed" && (
                  <>
                    <ActionButton
                      label="Reload"
                      colorClass="bg-blue-500/10 text-blue-400 hover:bg-blue-500/20"
                      loading={actionLoading === `${plugin.id}:reload`}
                      onClick={(e) => { e.stopPropagation(); handleAction(plugin.id, "reload"); }}
                    />
                    <ActionButton
                      label="Unload"
                      colorClass="bg-red-500/10 text-red-400 hover:bg-red-500/20"
                      loading={actionLoading === `${plugin.id}:unload`}
                      onClick={(e) => { e.stopPropagation(); handleAction(plugin.id, "unload"); }}
                    />
                  </>
                )}
                {plugin.status === "available" && (
                  <ActionButton
                    label="Install"
                    colorClass="bg-green-500/10 text-green-400 hover:bg-green-500/20"
                    loading={actionLoading === `${plugin.id}:install`}
                    onClick={(e) => { e.stopPropagation(); handleAction(plugin.id, "install"); }}
                  />
                )}
                {plugin.status === "unloaded" && (
                  <ActionButton
                    label="Install"
                    colorClass="bg-green-500/10 text-green-400 hover:bg-green-500/20"
                    loading={actionLoading === `${plugin.id}:install`}
                    onClick={(e) => { e.stopPropagation(); handleAction(plugin.id, "install"); }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Empty state */}
      {plugins.length === 0 && !error && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center">
          <div className="text-[var(--foreground)] font-medium mb-2">No plugins found</div>
          <p className="text-sm text-[var(--muted)] max-w-md mx-auto">
            Plugins are discovered from the <code className="text-xs bg-white/5 rounded px-1.5 py-0.5">plugins/</code> directory.
            Each plugin needs a <code className="text-xs bg-white/5 rounded px-1.5 py-0.5">plugin.yaml</code> manifest
            and a JavaScript entry module that exports a <code className="text-xs bg-white/5 rounded px-1.5 py-0.5">register(api)</code> function.
            See <code className="text-xs bg-white/5 rounded px-1.5 py-0.5">plugins/example-logger/</code> for a reference implementation.
          </p>
        </div>
      )}

      {/* Filtered empty state */}
      {plugins.length > 0 && filtered.length === 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted)]">
          No plugins match the current filter
        </div>
      )}
    </div>
  );
}

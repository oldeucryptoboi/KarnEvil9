"use client";

import { useEffect, useState, useCallback } from "react";
import { getHealth, getTools, getPlugins } from "@/lib/api";
import type { HealthStatus, ToolInfo, PluginInfo } from "@/lib/api";
import { useWSContext } from "@/lib/ws-context";
import {
  getNotificationPrefs,
  saveNotificationPrefs,
  resetToDefaults,
} from "@/lib/notification-prefs";
import type { NotificationPrefs } from "@/lib/notification-prefs";

/* ── Helpers ────────────────────────────────────────────────────────── */

function formatUptime(startTimestamp: string): string {
  const startMs = new Date(startTimestamp).getTime();
  const now = Date.now();
  const diffMs = now - startMs;
  if (diffMs < 0) return "just started";

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "ok" || status === "healthy"
      ? "bg-green-500"
      : status === "warning" || status === "stopped"
        ? "bg-yellow-500"
        : status === "unavailable"
          ? "bg-neutral-500"
          : "bg-red-500";
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${color}`}
      title={status}
    />
  );
}

/* ── Info Row ───────────────────────────────────────────────────────── */

function InfoRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between py-2 border-b border-[var(--border)] last:border-b-0">
      <span className="text-sm text-[var(--muted)] shrink-0 mr-4">{label}</span>
      <span
        className={`text-sm text-right ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

/* ── Card Section ──────────────────────────────────────────────────── */

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-6">
      <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wider mb-4">
        {title}
      </h3>
      {children}
    </div>
  );
}

/* ── Toggle Switch ─────────────────────────────────────────────────── */

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[var(--border)] last:border-b-0">
      <div className="flex flex-col mr-4">
        <span className="text-sm">{label}</span>
        {description && (
          <span className="text-xs text-[var(--muted)]">{description}</span>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border border-[var(--border)] transition-colors ${
          checked ? "bg-[var(--accent)]" : "bg-[var(--background)]"
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

/* ── Notification Settings ─────────────────────────────────────────── */

/** Human-readable labels and groupings for event types. */
const EVENT_GROUPS: Array<{
  title: string;
  events: Array<{ key: string; label: string; description: string }>;
}> = [
  {
    title: "Session Events",
    events: [
      {
        key: "session.completed",
        label: "Session Completed",
        description: "When a session finishes successfully",
      },
      {
        key: "session.failed",
        label: "Session Failed",
        description: "When a session ends with an error",
      },
      {
        key: "session.aborted",
        label: "Session Aborted",
        description: "When a session is manually aborted",
      },
    ],
  },
  {
    title: "Step Events",
    events: [
      {
        key: "step.failed",
        label: "Step Failed",
        description: "When an individual step fails during execution",
      },
      {
        key: "approval.needed",
        label: "Approval Needed",
        description: "When a step requires user approval to proceed",
      },
    ],
  },
  {
    title: "Connection Events",
    events: [
      {
        key: "connection.lost",
        label: "Connection Lost",
        description: "When the WebSocket connection drops",
      },
      {
        key: "connection.restored",
        label: "Connection Restored",
        description: "When the WebSocket connection is re-established",
      },
    ],
  },
];

function NotificationSettings() {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [browserPermission, setBrowserPermission] = useState<
    NotificationPermission | "unsupported"
  >("default");

  // Load prefs on mount (client only)
  useEffect(() => {
    setPrefs(getNotificationPrefs());

    if (typeof Notification !== "undefined") {
      setBrowserPermission(Notification.permission);
    } else {
      setBrowserPermission("unsupported");
    }
  }, []);

  if (!prefs) return null;

  const updatePrefs = (next: NotificationPrefs) => {
    setPrefs(next);
    saveNotificationPrefs(next);
  };

  const toggleEvent = (key: string, value: boolean) => {
    const next = {
      ...prefs,
      toastEvents: { ...prefs.toastEvents, [key]: value },
    };
    updatePrefs(next);
  };

  const handleBrowserToggle = async (value: boolean) => {
    if (value) {
      // Request permission if not yet granted
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "default"
      ) {
        const result = await Notification.requestPermission();
        setBrowserPermission(result);
        if (result !== "granted") {
          // Permission denied -- don't enable
          return;
        }
      } else if (
        typeof Notification !== "undefined" &&
        Notification.permission === "denied"
      ) {
        // Can't request again -- inform user
        return;
      }
    }
    updatePrefs({ ...prefs, browserNotifications: value });
  };

  const handleSoundToggle = (value: boolean) => {
    updatePrefs({ ...prefs, soundEnabled: value });
  };

  const handleReset = () => {
    const defaults = resetToDefaults();
    setPrefs(defaults);
  };

  return (
    <div className="space-y-5">
      <p className="text-xs text-[var(--muted)]">
        Control which events trigger toast notifications, browser alerts,
        and sounds. Changes are saved automatically.
      </p>

      {/* Event toggle groups */}
      {EVENT_GROUPS.map((group) => (
        <div key={group.title}>
          <span className="text-xs font-semibold text-[var(--muted)] block mb-2">
            {group.title}
          </span>
          <div>
            {group.events.map((evt) => (
              <Toggle
                key={evt.key}
                checked={prefs.toastEvents[evt.key] ?? false}
                onChange={(v) => toggleEvent(evt.key, v)}
                label={evt.label}
                description={evt.description}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Browser Notifications + Sound */}
      <div>
        <span className="text-xs font-semibold text-[var(--muted)] block mb-2">
          Delivery
        </span>
        <div>
          <div className="flex items-center justify-between py-2 border-b border-[var(--border)]">
            <div className="flex flex-col mr-4">
              <span className="text-sm">Browser Notifications</span>
              <span className="text-xs text-[var(--muted)]">
                {browserPermission === "granted"
                  ? "Permission granted -- notifications will appear even when this tab is in the background"
                  : browserPermission === "denied"
                    ? "Permission denied -- enable notifications in your browser settings"
                    : browserPermission === "unsupported"
                      ? "Not supported in this browser"
                      : "Will request permission when enabled"}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={prefs.browserNotifications}
              disabled={
                browserPermission === "denied" ||
                browserPermission === "unsupported"
              }
              onClick={() => handleBrowserToggle(!prefs.browserNotifications)}
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border border-[var(--border)] transition-colors ${
                browserPermission === "denied" ||
                browserPermission === "unsupported"
                  ? "cursor-not-allowed opacity-40"
                  : "cursor-pointer"
              } ${
                prefs.browserNotifications
                  ? "bg-[var(--accent)]"
                  : "bg-[var(--background)]"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  prefs.browserNotifications
                    ? "translate-x-4"
                    : "translate-x-0"
                }`}
              />
            </button>
          </div>
          <Toggle
            checked={prefs.soundEnabled}
            onChange={handleSoundToggle}
            label="Notification Sound"
            description="Play a subtle audio beep when a notification fires"
          />
        </div>
      </div>

      {/* Reset button */}
      <div className="pt-2">
        <button
          onClick={handleReset}
          className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors underline underline-offset-2"
        >
          Reset to Defaults
        </button>
      </div>
    </div>
  );
}

/* ── Subsystem Status Table ────────────────────────────────────────── */

function SubsystemTable({ health }: { health: HealthStatus }) {
  const checks = health.checks;
  const rows: Array<{ name: string; status: string; detail: string }> = [
    {
      name: "Journal",
      status: checks.journal.status,
      detail: checks.journal.detail ?? "",
    },
    {
      name: "Tools",
      status: checks.tools.status,
      detail: `${checks.tools.loaded ?? 0} loaded`,
    },
    {
      name: "Sessions",
      status: checks.sessions.status,
      detail: `${checks.sessions.active ?? 0} active`,
    },
    {
      name: "Planner",
      status: checks.planner.status,
      detail: checks.planner.status === "ok" ? "available" : "not configured",
    },
    {
      name: "Permissions",
      status: checks.permissions.status,
      detail:
        checks.permissions.status === "ok" ? "available" : "not configured",
    },
    {
      name: "Tool Runtime",
      status: checks.runtime.status,
      detail: checks.runtime.status === "ok" ? "available" : "not configured",
    },
    {
      name: "Plugins",
      status: checks.plugins.status,
      detail:
        checks.plugins.status === "unavailable"
          ? "not configured"
          : `${checks.plugins.loaded ?? 0} active, ${checks.plugins.failed ?? 0} failed`,
    },
    {
      name: "Scheduler",
      status: checks.scheduler.status,
      detail:
        checks.scheduler.status === "unavailable"
          ? "not configured"
          : `${checks.scheduler.schedules ?? 0} schedules`,
    },
    {
      name: "Swarm",
      status: checks.swarm.status,
      detail:
        checks.swarm.status === "unavailable"
          ? "not configured"
          : `${checks.swarm.active_peers ?? 0}/${checks.swarm.peers ?? 0} peers`,
    },
  ];

  return (
    <div className="space-y-0">
      {rows.map((row) => (
        <div
          key={row.name}
          className="flex items-center justify-between py-2 border-b border-[var(--border)] last:border-b-0"
        >
          <div className="flex items-center gap-2">
            <StatusDot status={row.status} />
            <span className="text-sm">{row.name}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-[var(--muted)]">{row.detail}</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
                row.status === "ok"
                  ? "bg-green-500/10 text-green-400"
                  : row.status === "warning" || row.status === "stopped"
                    ? "bg-yellow-500/10 text-yellow-400"
                    : row.status === "unavailable"
                      ? "bg-white/5 text-[var(--muted)]"
                      : "bg-red-500/10 text-red-400"
              }`}
            >
              {row.status}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Main Page ─────────────────────────────────────────────────────── */

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3100";

export default function SettingsPage() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const { connected } = useWSContext();

  const fetchData = useCallback(async () => {
    try {
      const [h, t, p] = await Promise.all([
        getHealth().catch(() => null),
        getTools().catch(() => []),
        getPlugins().catch(() => []),
      ]);
      setHealth(h);
      setTools(t);
      setPlugins(p);
      setError(null);
      setLastFetched(new Date());
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading && !health) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--muted)]">
        Loading settings...
      </div>
    );
  }

  const activePlugins = plugins.filter((p) => p.status === "active");

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Settings</h2>
        {lastFetched && (
          <span className="text-xs text-[var(--muted)]">
            Updated {lastFetched.toLocaleTimeString()}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Server Info ──────────────────────────────────────────── */}
        <Card title="Server Info">
          {health ? (
            <div>
              <InfoRow
                label="Status"
                value={
                  <span className="flex items-center gap-2">
                    <StatusDot status={health.status} />
                    <span
                      className={
                        health.status === "healthy"
                          ? "text-green-400"
                          : health.status === "warning"
                            ? "text-yellow-400"
                            : "text-red-400"
                      }
                    >
                      {health.status}
                    </span>
                  </span>
                }
              />
              <InfoRow label="Version" value={health.version} mono />
              <InfoRow
                label="Uptime"
                value={formatUptime(health.timestamp)}
                mono
              />
              <InfoRow label="API URL" value={API_URL} mono />
              <InfoRow
                label="Authentication"
                value={
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
                      API_URL.includes("localhost") || !process.env.NEXT_PUBLIC_API_TOKEN
                        ? "bg-yellow-500/10 text-yellow-400"
                        : "bg-green-500/10 text-green-400"
                    }`}
                  >
                    {process.env.NEXT_PUBLIC_API_TOKEN
                      ? "token configured"
                      : "insecure mode"}
                  </span>
                }
              />
              <InfoRow
                label="Active Sessions"
                value={health.checks.sessions.active ?? 0}
                mono
              />
              <InfoRow
                label="Registered Tools"
                value={tools.length}
                mono
              />
              <InfoRow
                label="Loaded Plugins"
                value={`${activePlugins.length} active / ${plugins.length} total`}
                mono
              />
              <InfoRow
                label="Server Time"
                value={new Date(health.timestamp).toLocaleString()}
              />
            </div>
          ) : (
            <div className="text-center text-[var(--muted)] py-4">
              <p>Unable to connect to the API server.</p>
              <p className="text-xs mt-1">
                Verify the server is running at{" "}
                <code className="bg-white/[0.06] px-1.5 py-0.5 rounded font-mono text-[var(--foreground)]">
                  {API_URL}
                </code>
              </p>
            </div>
          )}
        </Card>

        {/* ── Subsystem Health ──────────────────────────────────────── */}
        <Card title="Subsystem Health">
          {health ? (
            <SubsystemTable health={health} />
          ) : (
            <div className="text-center text-[var(--muted)] py-4">
              No health data available.
            </div>
          )}
        </Card>

        {/* ── Kernel Configuration ─────────────────────────────────── */}
        <Card title="Kernel Configuration">
          <p className="text-xs text-[var(--muted)] mb-4">
            Server-side kernel defaults. These are configured at server startup
            and apply to all new sessions.
          </p>
          <InfoRow label="Max Concurrent Steps" value="5" mono />
          <InfoRow label="Planner Timeout" value="120s" mono />
          <InfoRow label="Planner Retries" value="2" mono />
          <InfoRow
            label="Default Mode"
            value={
              <span className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-blue-500/10 text-blue-400">
                live
              </span>
            }
          />
          <div className="mt-4 mb-2">
            <span className="text-xs font-semibold text-[var(--muted)]">
              Session Limits (Defaults)
            </span>
          </div>
          <InfoRow label="Max Steps" value="30" mono />
          <InfoRow label="Max Duration" value="300s (5m)" mono />
          <InfoRow label="Max Cost" value="$5.00 USD" mono />
          <InfoRow label="Max Tokens" value="200,000" mono />
          <InfoRow label="Max Iterations (Agentic)" value="15" mono />
          <div className="mt-4 mb-2">
            <span className="text-xs font-semibold text-[var(--muted)]">
              Safety
            </span>
          </div>
          <InfoRow label="Max Concurrent Sessions" value="50" mono />
          <InfoRow label="Approval Timeout" value="300s (5m)" mono />
          <InfoRow
            label="Require Approval for Writes"
            value={
              <span className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-green-500/10 text-green-400">
                yes
              </span>
            }
          />
          <InfoRow
            label="Circuit Breaker"
            value="threshold=5, cooldown=30s"
            mono
          />
        </Card>

        {/* ── Connection Settings ──────────────────────────────────── */}
        <Card title="Connection Settings">
          <InfoRow label="API Base URL" value={API_URL} mono />
          <InfoRow
            label="WebSocket"
            value={
              <span className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${
                    connected ? "bg-green-500" : "bg-red-500"
                  }`}
                />
                <span
                  className={
                    connected ? "text-green-400" : "text-red-400"
                  }
                >
                  {connected ? "connected" : "disconnected"}
                </span>
              </span>
            }
          />
          <InfoRow
            label="WS URL"
            value={API_URL.replace(/^http/, "ws")}
            mono
          />
          <InfoRow label="Health Poll Interval" value="30s" mono />
          <InfoRow label="SSE Keepalive" value="15s" mono />
          <InfoRow label="SSE Max Lifetime" value="30m" mono />
          <InfoRow label="Rate Limit" value="100 req / 60s" mono />
          <div className="mt-4 mb-2">
            <span className="text-xs font-semibold text-[var(--muted)]">
              Environment Variables
            </span>
          </div>
          <InfoRow
            label="NEXT_PUBLIC_API_URL"
            value={
              process.env.NEXT_PUBLIC_API_URL ?? (
                <span className="text-[var(--muted)] italic">not set (default: http://localhost:3100)</span>
              )
            }
            mono
          />
          <InfoRow
            label="NEXT_PUBLIC_API_TOKEN"
            value={
              process.env.NEXT_PUBLIC_API_TOKEN ? (
                <span className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-green-500/10 text-green-400">
                  configured
                </span>
              ) : (
                <span className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-yellow-500/10 text-yellow-400">
                  not set
                </span>
              )
            }
          />
        </Card>

        {/* ── Notifications ──────────────────────────────────────── */}
        <Card title="Notifications">
          <NotificationSettings />
        </Card>

        {/* ── Active Tools ─────────────────────────────────────────── */}
        {tools.length > 0 && (
          <Card title={`Registered Tools (${tools.length})`}>
            <div className="space-y-0 max-h-64 overflow-y-auto">
              {tools.map((tool) => (
                <div
                  key={tool.name}
                  className="flex items-center justify-between py-2 border-b border-[var(--border)] last:border-b-0"
                >
                  <div>
                    <span className="text-sm font-mono">{tool.name}</span>
                    <span className="text-xs text-[var(--muted)] ml-2">
                      v{tool.version}
                    </span>
                  </div>
                  <span className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-white/5 text-[var(--muted)]">
                    {tool.runner}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* ── Active Plugins ───────────────────────────────────────── */}
        {plugins.length > 0 && (
          <Card title={`Loaded Plugins (${plugins.length})`}>
            <div className="space-y-0 max-h-64 overflow-y-auto">
              {plugins.map((plugin) => (
                <div
                  key={plugin.id}
                  className="flex items-center justify-between py-2 border-b border-[var(--border)] last:border-b-0"
                >
                  <div>
                    <span className="text-sm">{plugin.manifest.name}</span>
                    <span className="text-xs text-[var(--muted)] ml-2">
                      v{plugin.manifest.version}
                    </span>
                  </div>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
                      plugin.status === "active"
                        ? "bg-green-500/10 text-green-400"
                        : plugin.status === "failed"
                          ? "bg-red-500/10 text-red-400"
                          : "bg-white/5 text-[var(--muted)]"
                    }`}
                  >
                    {plugin.status}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* ── About ────────────────────────────────────────────────── */}
        <Card title="About KarnEvil9">
          <div className="space-y-4">
            <div>
              <p className="text-sm mb-2">
                <span className="font-semibold">KarnEvil9</span> is a
                deterministic agent runtime with explicit plans, typed tools,
                permissions, and replay. It orchestrates LLM-generated plans
                into structured step execution with permission gates, an
                immutable event journal, and cross-session learning.
              </p>
              <p className="text-xs text-[var(--muted)]">
                Version {health?.version ?? "0.1.0"} &middot; MIT License
              </p>
            </div>

            <div className="border-t border-[var(--border)] pt-4">
              <span className="text-xs font-semibold text-[var(--muted)] block mb-2">
                The Lore
              </span>
              <p className="text-sm text-[var(--muted)]">
                Named after Emerson, Lake &amp; Palmer&apos;s{" "}
                <span className="italic text-[var(--foreground)]">
                  &ldquo;Karn Evil 9&rdquo;
                </span>{" "}
                suite from <span className="italic">Brain Salad Surgery</span>{" "}
                (1973). In the Tron metaphor:{" "}
                <span className="text-[var(--foreground)] font-semibold">
                  KarnEvil9
                </span>{" "}
                is the Master Control Program (MCP),{" "}
                <span className="text-[var(--foreground)] font-semibold">
                  EDDIE
                </span>{" "}
                is the Program, and the associated{" "}
                <span className="text-[var(--foreground)] font-semibold">
                  User
                </span>{" "}
                is the human operator.
              </p>
              <p className="text-xs text-[var(--muted)] mt-2 italic">
                &ldquo;Welcome back my friends, to the show that never ends...&rdquo;
              </p>
            </div>

            <div className="border-t border-[var(--border)] pt-4">
              <span className="text-xs font-semibold text-[var(--muted)] block mb-2">
                Links
              </span>
              <div className="space-y-1">
                <a
                  href="https://github.com/oldeucryptoboi/KarnEvil9"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-sm text-[var(--accent)] hover:underline"
                >
                  GitHub Repository
                </a>
                <a
                  href="https://oldeucryptoboi.github.io/KarnEvil9"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-sm text-[var(--accent)] hover:underline"
                >
                  Documentation
                </a>
                <a
                  href={`${API_URL}/api/docs`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-sm text-[var(--accent)] hover:underline"
                >
                  API Documentation (Swagger UI)
                </a>
              </div>
            </div>

            <div className="border-t border-[var(--border)] pt-4">
              <span className="text-xs font-semibold text-[var(--muted)] block mb-2">
                Tech Stack
              </span>
              <div className="flex flex-wrap gap-1.5">
                {[
                  "TypeScript 5.7+",
                  "Node.js 20+",
                  "Express 5",
                  "Next.js 15",
                  "pnpm 9.15",
                  "Vitest 3.0",
                  "Tailwind CSS",
                ].map((tech) => (
                  <span
                    key={tech}
                    className="rounded px-2 py-0.5 text-[10px] font-mono bg-white/5 text-[var(--muted)]"
                  >
                    {tech}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

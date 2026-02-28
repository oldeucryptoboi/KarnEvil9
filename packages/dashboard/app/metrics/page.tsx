"use client";

import { useEffect, useState, useCallback } from "react";
import { getMetricsText } from "@/lib/api";

/* ── Prometheus text parser ─────────────────────────────────────────── */

interface ParsedMetric {
  name: string;
  help: string;
  type: string;
  samples: Array<{ labels: Record<string, string>; value: number }>;
}

function parsePrometheusText(text: string): ParsedMetric[] {
  const metrics: ParsedMetric[] = [];
  let current: ParsedMetric | null = null;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("# HELP ")) {
      const rest = trimmed.slice(7);
      const spaceIdx = rest.indexOf(" ");
      const name = spaceIdx > 0 ? rest.slice(0, spaceIdx) : rest;
      const help = spaceIdx > 0 ? rest.slice(spaceIdx + 1) : "";
      current = { name, help, type: "untyped", samples: [] };
      metrics.push(current);
    } else if (trimmed.startsWith("# TYPE ")) {
      const rest = trimmed.slice(7);
      const parts = rest.split(" ");
      if (current && parts[0] === current.name) {
        current.type = parts[1] ?? "untyped";
      }
    } else if (!trimmed.startsWith("#")) {
      // Sample line: metric_name{label="value"} 123
      const braceIdx = trimmed.indexOf("{");
      let name: string;
      let labels: Record<string, string> = {};
      let valueStr: string;

      if (braceIdx > 0) {
        name = trimmed.slice(0, braceIdx);
        const closeBrace = trimmed.indexOf("}");
        const labelsStr = trimmed.slice(braceIdx + 1, closeBrace);
        valueStr = trimmed.slice(closeBrace + 2).trim();
        // Parse labels
        for (const pair of labelsStr.split(",")) {
          const eqIdx = pair.indexOf("=");
          if (eqIdx > 0) {
            const key = pair.slice(0, eqIdx);
            const val = pair.slice(eqIdx + 1).replace(/"/g, "");
            labels[key] = val;
          }
        }
      } else {
        const spaceIdx = trimmed.indexOf(" ");
        name = trimmed.slice(0, spaceIdx);
        valueStr = trimmed.slice(spaceIdx + 1);
      }

      const value = parseFloat(valueStr);
      if (!isNaN(value)) {
        // Find or create metric entry
        let metric =
          current?.name === name ||
          (current && name.startsWith(current.name + "_"))
            ? current
            : metrics.find(
                (m) => m.name === name || name.startsWith(m.name + "_"),
              );
        if (!metric) {
          metric = { name, help: "", type: "untyped", samples: [] };
          metrics.push(metric);
        }
        metric.samples.push({ labels, value });
      }
    }
  }

  return metrics;
}

/* ── Helpers ────────────────────────────────────────────────────────── */

const METRIC_GROUPS: Record<string, { label: string; prefixes: string[] }> = {
  session: {
    label: "Session Metrics",
    prefixes: ["karnevil9_sessions"],
  },
  step: {
    label: "Step & Tool Metrics",
    prefixes: [
      "karnevil9_steps",
      "karnevil9_tool",
      "karnevil9_step",
      "karnevil9_circuit",
    ],
  },
  token: {
    label: "Token & Cost Metrics",
    prefixes: ["karnevil9_tokens", "karnevil9_cost"],
  },
  planner: {
    label: "Planner Metrics",
    prefixes: ["karnevil9_planner", "karnevil9_plan"],
  },
  permission: {
    label: "Permission Metrics",
    prefixes: ["karnevil9_permission", "karnevil9_approval"],
  },
  safety: {
    label: "Safety Metrics",
    prefixes: [
      "karnevil9_safety",
      "karnevil9_futility",
      "karnevil9_policy",
      "karnevil9_injection",
    ],
  },
};

function classifyMetric(name: string): string {
  for (const [group, { prefixes }] of Object.entries(METRIC_GROUPS)) {
    if (prefixes.some((p) => name.startsWith(p))) return group;
  }
  return "other";
}

function cleanMetricName(name: string): string {
  return name
    .replace(/^karnevil9_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString();
  if (value < 0.01 && value > 0) return value.toExponential(2);
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}="${v}"`).join(", ");
}

const TYPE_BADGE_COLORS: Record<string, string> = {
  counter: "bg-blue-500/10 text-blue-400",
  gauge: "bg-green-500/10 text-green-400",
  histogram: "bg-yellow-500/10 text-yellow-400",
  summary: "bg-purple-500/10 text-purple-400",
  untyped: "bg-white/5 text-[var(--muted)]",
};

/* ── Stat card for the hero row ─────────────────────────────────────── */

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="text-xs text-[var(--muted)] mb-1">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}

/* ── Collapsible metric group ───────────────────────────────────────── */

function MetricGroup({
  label,
  metrics,
}: {
  label: string;
  metrics: ParsedMetric[];
}) {
  const [open, setOpen] = useState(true);

  if (metrics.length === 0) return null;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] mb-4">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{label}</h3>
          <span className="text-xs text-[var(--muted)]">
            {metrics.length} metric{metrics.length !== 1 ? "s" : ""}
          </span>
        </div>
        <span className="text-[var(--muted)] text-xs">
          {open ? "collapse" : "expand"}
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--border)] divide-y divide-[var(--border)]">
          {metrics.map((m) => (
            <div key={m.name} className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono text-sm text-[var(--foreground)]">
                  {cleanMetricName(m.name)}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${TYPE_BADGE_COLORS[m.type] ?? TYPE_BADGE_COLORS.untyped}`}
                >
                  {m.type}
                </span>
              </div>
              {m.help && (
                <p className="text-xs text-[var(--muted)] mb-2">{m.help}</p>
              )}
              <div className="space-y-1">
                {m.samples.map((s, i) => {
                  const labelStr = formatLabels(s.labels);
                  return (
                    <div
                      key={`${m.name}-${i}`}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="text-xs text-[var(--muted)] font-mono truncate mr-4">
                        {labelStr || "(no labels)"}
                      </span>
                      <span className="font-mono font-medium whitespace-nowrap">
                        {formatValue(s.value)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main page ──────────────────────────────────────────────────────── */

export default function MetricsPage() {
  const [metricsText, setMetricsText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const text = await getMetricsText();
      setMetricsText(text);
      setError(null);
      setLastUpdated(new Date());
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 10000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  const parsed = metricsText ? parsePrometheusText(metricsText) : [];

  // Extract hero stat values
  const findMetricValue = (name: string): number | null => {
    const metric = parsed.find((m) => m.name === name);
    if (!metric || metric.samples.length === 0) return null;
    // Sum all samples for total counters, or take the first for gauges
    if (metric.samples.length === 1) return metric.samples[0]!.value;
    return metric.samples.reduce((sum, s) => sum + s.value, 0);
  };

  const sessionsTotal = findMetricValue("karnevil9_sessions_total");
  const sessionsActive = findMetricValue("karnevil9_sessions_active");
  const stepsTotal = findMetricValue("karnevil9_steps_total");
  const costTotal = findMetricValue("karnevil9_cost_usd_total");

  // Group metrics by category
  const grouped: Record<string, ParsedMetric[]> = {};
  for (const m of parsed) {
    const group = classifyMetric(m.name);
    if (!grouped[group]) grouped[group] = [];
    grouped[group]!.push(m);
  }

  if (loading && !metricsText) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--muted)]">
        Loading metrics...
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Metrics</h2>
        {lastUpdated && (
          <span className="text-xs text-[var(--muted)]">
            Updated {lastUpdated.toLocaleTimeString()}
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">
          {error}
        </div>
      )}

      {/* Hero stat cards */}
      {parsed.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard
            label="Sessions"
            value={sessionsTotal != null ? formatValue(sessionsTotal) : "-"}
          />
          <StatCard
            label="Active Sessions"
            value={sessionsActive != null ? formatValue(sessionsActive) : "-"}
          />
          <StatCard
            label="Steps Executed"
            value={stepsTotal != null ? formatValue(stepsTotal) : "-"}
          />
          <StatCard
            label="Total Cost"
            value={
              costTotal != null ? `$${formatValue(costTotal)}` : "-"
            }
          />
        </div>
      )}

      {/* Metric groups */}
      {Object.entries(METRIC_GROUPS).map(([key, { label }]) => {
        const groupMetrics = grouped[key];
        if (!groupMetrics || groupMetrics.length === 0) return null;
        return (
          <MetricGroup key={key} label={label} metrics={groupMetrics} />
        );
      })}

      {/* Uncategorised metrics */}
      {grouped["other"] && grouped["other"].length > 0 && (
        <MetricGroup label="Other Metrics" metrics={grouped["other"]} />
      )}

      {parsed.length === 0 && !loading && !error && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted)]">
          No metrics available. The API may not be exposing metrics yet.
        </div>
      )}
    </div>
  );
}

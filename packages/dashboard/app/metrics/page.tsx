"use client";

import { useEffect, useState, useCallback, useRef } from "react";
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

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatValue(value);
}

const TYPE_BADGE_COLORS: Record<string, string> = {
  counter: "bg-blue-500/10 text-blue-400",
  gauge: "bg-green-500/10 text-green-400",
  histogram: "bg-yellow-500/10 text-yellow-400",
  summary: "bg-purple-500/10 text-purple-400",
  untyped: "bg-white/5 text-[var(--muted)]",
};

/* ── Chart color palette ───────────────────────────────────────────── */

const STATUS_COLORS: Record<string, string> = {
  // Step/session statuses
  succeeded: "#22c55e",
  completed: "#22c55e",
  success: "#22c55e",
  created: "#3b82f6",
  running: "#3b82f6",
  planning: "#8b5cf6",
  failed: "#ef4444",
  error: "#ef4444",
  aborted: "#f97316",
  skipped: "#737373",
  // Permission decisions
  allow_always: "#22c55e",
  allow_session: "#4ade80",
  allow_once: "#86efac",
  allow_constrained: "#a3e635",
  allow_observed: "#facc15",
  deny: "#ef4444",
  // Token types
  input: "#3b82f6",
  output: "#8b5cf6",
  // Fallback
  default: "#6b7280",
};

function getBarColor(label: string): string {
  const lower = label.toLowerCase();
  return STATUS_COLORS[lower] ?? STATUS_COLORS.default!;
}

/* ── Horizontal Bar Chart ──────────────────────────────────────────── */

interface BarItem {
  label: string;
  value: number;
  color: string;
}

function HorizontalBarChart({
  title,
  items,
}: {
  title: string;
  items: BarItem[];
}) {
  if (items.length === 0) return null;
  const maxValue = Math.max(...items.map((i) => i.value), 1);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <h3 className="text-sm font-semibold mb-3">{title}</h3>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-3">
            <span className="text-xs text-[var(--muted)] font-mono w-28 truncate text-right shrink-0">
              {item.label}
            </span>
            <div className="flex-1 h-5 rounded bg-white/[0.04] overflow-hidden">
              <div
                className="h-full rounded transition-all duration-500 ease-out"
                style={{
                  width: `${Math.max((item.value / maxValue) * 100, 1)}%`,
                  backgroundColor: item.color,
                  opacity: 0.7,
                }}
              />
            </div>
            <span className="text-xs font-mono font-medium w-16 text-right shrink-0">
              {formatCompact(item.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Token Donut/Ring Chart ────────────────────────────────────────── */

function TokenRingChart({
  inputTokens,
  outputTokens,
}: {
  inputTokens: number;
  outputTokens: number;
}) {
  const total = inputTokens + outputTokens;
  if (total === 0) return null;

  const inputPct = (inputTokens / total) * 100;
  const inputDeg = (inputTokens / total) * 360;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <h3 className="text-sm font-semibold mb-3">Token Breakdown</h3>
      <div className="flex items-center gap-6">
        {/* Ring */}
        <div className="relative w-28 h-28 shrink-0">
          <div
            className="w-full h-full rounded-full transition-all duration-500"
            style={{
              background: `conic-gradient(#3b82f6 0deg ${inputDeg}deg, #8b5cf6 ${inputDeg}deg 360deg)`,
            }}
          />
          {/* Inner circle to create donut */}
          <div
            className="absolute rounded-full bg-[var(--card)] flex flex-col items-center justify-center"
            style={{
              top: "20%",
              left: "20%",
              width: "60%",
              height: "60%",
            }}
          >
            <span className="text-xs font-mono font-semibold leading-tight">
              {formatCompact(total)}
            </span>
            <span className="text-[10px] text-[var(--muted)]">total</span>
          </div>
        </div>

        {/* Legend */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: "#3b82f6" }} />
            <span className="text-xs text-[var(--muted)]">Input</span>
            <span className="text-xs font-mono font-medium ml-auto">
              {formatCompact(inputTokens)} ({inputPct.toFixed(1)}%)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: "#8b5cf6" }} />
            <span className="text-xs text-[var(--muted)]">Output</span>
            <span className="text-xs font-mono font-medium ml-auto">
              {formatCompact(outputTokens)} ({(100 - inputPct).toFixed(1)}%)
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Sparkline SVG ─────────────────────────────────────────────────── */

const SPARKLINE_MAX_POINTS = 30;

function Sparkline({ history }: { history: number[] }) {
  if (history.length < 2) return null;

  const width = 100;
  const height = 24;
  const padding = 2;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;

  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = max - min || 1;

  const points = history
    .map((v, i) => {
      const x = padding + (i / (history.length - 1)) * innerW;
      const y = padding + innerH - ((v - min) / range) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const lastValue = history[history.length - 1]!;
  const lastX = padding + innerW;
  const lastY = padding + innerH - ((lastValue - min) / range) * innerH;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="inline-block"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ transition: "all 0.3s ease" }}
      />
      <circle
        cx={lastX.toFixed(1)}
        cy={lastY.toFixed(1)}
        r="2"
        fill="var(--accent)"
      />
    </svg>
  );
}

/* ── Stat card with optional sparkline ─────────────────────────────── */

function StatCard({
  label,
  value,
  history,
}: {
  label: string;
  value: string | number;
  history?: number[];
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="text-xs text-[var(--muted)] mb-1">{label}</div>
      <div className="flex items-end justify-between gap-2">
        <div className="text-2xl font-semibold">{value}</div>
        {history && history.length >= 2 && (
          <Sparkline history={history} />
        )}
      </div>
    </div>
  );
}

/* ── Inline mini bars for metric samples ──────────────────────────── */

function SampleBars({
  samples,
}: {
  samples: Array<{ labels: Record<string, string>; value: number }>;
}) {
  if (samples.length <= 1) return null;
  const maxVal = Math.max(...samples.map((s) => s.value), 1);

  return (
    <div className="space-y-1.5 mt-2">
      {samples.map((s, i) => {
        const labelStr = formatLabels(s.labels);
        // Try to pick a color from the label values
        const firstLabelVal = Object.values(s.labels)[0] ?? "";
        const color = getBarColor(firstLabelVal);
        const pct = Math.max((s.value / maxVal) * 100, 1);

        return (
          <div key={i} className="flex items-center gap-2">
            <span className="text-[11px] text-[var(--muted)] font-mono w-36 truncate text-right shrink-0">
              {labelStr || "(no labels)"}
            </span>
            <div className="flex-1 h-3.5 rounded bg-white/[0.04] overflow-hidden">
              <div
                className="h-full rounded transition-all duration-500 ease-out"
                style={{
                  width: `${pct}%`,
                  backgroundColor: color,
                  opacity: 0.6,
                }}
              />
            </div>
            <span className="text-[11px] font-mono font-medium w-14 text-right shrink-0">
              {formatCompact(s.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Collapsible metric group with inline bars ─────────────────────── */

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
          {metrics.map((m) => {
            const hasMultipleSamples = m.samples.length > 1;
            const hasLabels = m.samples.some(
              (s) => Object.keys(s.labels).length > 0,
            );
            const showBars = hasMultipleSamples && hasLabels;

            return (
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

                {showBars ? (
                  <SampleBars samples={m.samples} />
                ) : (
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
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Chart data extraction helpers ─────────────────────────────────── */

function extractBarItems(
  parsed: ParsedMetric[],
  metricName: string,
  labelKey: string,
): BarItem[] {
  const metric = parsed.find((m) => m.name === metricName);
  if (!metric) return [];

  const items: BarItem[] = [];
  for (const sample of metric.samples) {
    const label = sample.labels[labelKey];
    if (!label) continue;
    // Aggregate by label value
    const existing = items.find((i) => i.label === label);
    if (existing) {
      existing.value += sample.value;
    } else {
      items.push({
        label,
        value: sample.value,
        color: getBarColor(label),
      });
    }
  }
  return items.sort((a, b) => b.value - a.value);
}

function extractTokenBreakdown(
  parsed: ParsedMetric[],
): { input: number; output: number } {
  const metric = parsed.find((m) => m.name === "karnevil9_tokens_total");
  if (!metric) return { input: 0, output: 0 };

  let input = 0;
  let output = 0;
  for (const sample of metric.samples) {
    const type = sample.labels["type"] ?? "";
    if (type === "input") input += sample.value;
    else if (type === "output") output += sample.value;
  }
  return { input, output };
}

/* ── Main page ──────────────────────────────────────────────────────── */

export default function MetricsPage() {
  const [metricsText, setMetricsText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Sparkline history buffers
  const activeSessionsHistory = useRef<number[]>([]);
  const stepsHistory = useRef<number[]>([]);
  const costHistory = useRef<number[]>([]);
  const sessionsHistory = useRef<number[]>([]);
  // Force re-render on history update
  const [historyTick, setHistoryTick] = useState(0);

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

  // Update sparkline history when parsed data changes
  useEffect(() => {
    if (parsed.length === 0) return;

    const pushHistory = (buf: number[], val: number | null) => {
      if (val == null) return;
      buf.push(val);
      if (buf.length > SPARKLINE_MAX_POINTS) buf.shift();
    };

    pushHistory(activeSessionsHistory.current, sessionsActive);
    pushHistory(stepsHistory.current, stepsTotal);
    pushHistory(costHistory.current, costTotal);
    pushHistory(sessionsHistory.current, sessionsTotal);
    setHistoryTick((t) => t + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metricsText]);

  // Extract chart data
  const sessionsByStatus = extractBarItems(
    parsed,
    "karnevil9_sessions_total",
    "status",
  );
  const stepsByStatus = extractBarItems(
    parsed,
    "karnevil9_steps_total",
    "status",
  );
  // Aggregate steps by tool name (ignoring status)
  const toolUsageMap = new Map<string, number>();
  const stepsMetric = parsed.find((m) => m.name === "karnevil9_steps_total");
  if (stepsMetric) {
    for (const s of stepsMetric.samples) {
      const tool = s.labels["tool_name"];
      if (tool) {
        toolUsageMap.set(tool, (toolUsageMap.get(tool) ?? 0) + s.value);
      }
    }
  }
  // Also check tool_executions_total
  const toolExecMetric = parsed.find(
    (m) => m.name === "karnevil9_tool_executions_total",
  );
  if (toolExecMetric) {
    for (const s of toolExecMetric.samples) {
      const tool = s.labels["tool_name"];
      if (tool && !toolUsageMap.has(tool)) {
        toolUsageMap.set(tool, (toolUsageMap.get(tool) ?? 0) + s.value);
      }
    }
  }
  const toolsByUsage: BarItem[] = Array.from(toolUsageMap.entries())
    .map(([label, value]) => ({
      label,
      value,
      color: "#3b82f6",
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  // Assign distinct colors to top tools
  const toolColors = ["#3b82f6", "#8b5cf6", "#22c55e", "#f59e0b", "#ec4899"];
  toolsByUsage.forEach((t, i) => {
    t.color = toolColors[i] ?? toolColors[0]!;
  });

  const tokenBreakdown = extractTokenBreakdown(parsed);

  // Group metrics by category
  const grouped: Record<string, ParsedMetric[]> = {};
  for (const m of parsed) {
    const group = classifyMetric(m.name);
    if (!grouped[group]) grouped[group] = [];
    grouped[group]!.push(m);
  }

  // Prevent unused variable warning
  void historyTick;

  if (loading && !metricsText) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--muted)]">
        Loading metrics...
      </div>
    );
  }

  const hasChartData =
    sessionsByStatus.length > 0 ||
    stepsByStatus.length > 0 ||
    toolsByUsage.length > 0 ||
    tokenBreakdown.input + tokenBreakdown.output > 0;

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

      {/* Hero stat cards with sparklines */}
      {parsed.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard
            label="Sessions"
            value={sessionsTotal != null ? formatValue(sessionsTotal) : "-"}
            history={sessionsHistory.current}
          />
          <StatCard
            label="Active Sessions"
            value={sessionsActive != null ? formatValue(sessionsActive) : "-"}
            history={activeSessionsHistory.current}
          />
          <StatCard
            label="Steps Executed"
            value={stepsTotal != null ? formatValue(stepsTotal) : "-"}
            history={stepsHistory.current}
          />
          <StatCard
            label="Total Cost"
            value={
              costTotal != null ? `$${formatValue(costTotal)}` : "-"
            }
            history={costHistory.current}
          />
        </div>
      )}

      {/* Visual charts section */}
      {hasChartData && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wider mb-3">
            Visual Overview
          </h3>

          {/* Top row: bar charts */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
            {stepsByStatus.length > 0 && (
              <HorizontalBarChart
                title="Steps by Status"
                items={stepsByStatus}
              />
            )}
            {sessionsByStatus.length > 0 && (
              <HorizontalBarChart
                title="Sessions by Status"
                items={sessionsByStatus}
              />
            )}
            {toolsByUsage.length > 0 && (
              <HorizontalBarChart
                title="Top Tools by Usage"
                items={toolsByUsage}
              />
            )}
          </div>

          {/* Token ring chart */}
          {tokenBreakdown.input + tokenBreakdown.output > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              <TokenRingChart
                inputTokens={tokenBreakdown.input}
                outputTokens={tokenBreakdown.output}
              />
            </div>
          )}
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

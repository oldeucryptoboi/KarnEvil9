"use client";

/**
 * Live metrics panel that subscribes to WebSocket events and updates charts
 * in real-time. Shows step duration histogram, tool usage distribution,
 * success/failure rate donut, and session throughput line chart.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useWSContext } from "@/lib/ws-context";
import type { WSEvent } from "@/lib/use-websocket";
import {
  BarChart,
  HBarChart,
  DonutChart,
  LineChart,
  type DataPoint,
  type DonutSegment,
} from "@/components/metrics-chart";

/* ── Configuration ─────────────────────────────────────────────────── */

const MAX_STEP_HISTORY = 50;
const THROUGHPUT_WINDOW_MINUTES = 10;
const THROUGHPUT_BUCKET_SECONDS = 60; // 1-minute buckets

/* ── Internal state types ──────────────────────────────────────────── */

interface StepRecord {
  stepId: string;
  toolName: string;
  startedAt: number;
  duration?: number;
  outcome?: "succeeded" | "failed";
}

interface ThroughputBucket {
  /** Minute label, e.g. "12:34" */
  label: string;
  /** Timestamp of the bucket start */
  ts: number;
  /** Number of steps completed in this bucket */
  count: number;
}

/* ── Helper: format milliseconds ───────────────────────────────────── */

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/* ── LiveMetricsPanel component ────────────────────────────────────── */

export function LiveMetricsPanel() {
  const { events, connected } = useWSContext();
  const processedCountRef = useRef(0);

  // --- Accumulated state ---

  // Step duration records (last MAX_STEP_HISTORY)
  const [stepRecords, setStepRecords] = useState<StepRecord[]>([]);

  // Tool usage counts
  const [toolCounts, setToolCounts] = useState<Map<string, number>>(
    () => new Map(),
  );

  // Success / failure counters
  const [successCount, setSuccessCount] = useState(0);
  const [failureCount, setFailureCount] = useState(0);

  // Throughput buckets (1-minute resolution)
  const [throughputBuckets, setThroughputBuckets] = useState<
    ThroughputBucket[]
  >([]);

  // Sessions completed count (for display)
  const [sessionsCompleted, setSessionsCompleted] = useState(0);

  // Force re-render ticker
  const [, setTick] = useState(0);

  /* ── Throughput bucket management ──────────────────────────────── */

  const getOrCreateBucket = useCallback(
    (buckets: ThroughputBucket[], ts: number): ThroughputBucket[] => {
      const bucketTs =
        Math.floor(ts / (THROUGHPUT_BUCKET_SECONDS * 1000)) *
        (THROUGHPUT_BUCKET_SECONDS * 1000);
      const existing = buckets.find((b) => b.ts === bucketTs);
      if (existing) {
        existing.count++;
        return [...buckets];
      }

      const date = new Date(bucketTs);
      const label = `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
      const newBuckets = [...buckets, { label, ts: bucketTs, count: 1 }];

      // Trim to window
      const cutoff =
        Date.now() - THROUGHPUT_WINDOW_MINUTES * 60 * 1000;
      return newBuckets.filter((b) => b.ts >= cutoff);
    },
    [],
  );

  /* ── Process new WebSocket events ────────────────────────────── */

  useEffect(() => {
    const newEvents = events.slice(processedCountRef.current);
    processedCountRef.current = events.length;
    if (newEvents.length === 0) return;

    let addedSteps = false;
    let toolCountsChanged = false;
    let successDelta = 0;
    let failureDelta = 0;
    let sessionsDelta = 0;
    let throughputUpdated = false;

    // Mutable copies for batching
    const pendingStepUpdates: Array<{
      type: "start" | "succeed" | "fail";
      event: WSEvent;
    }> = [];

    for (const evt of newEvents) {
      switch (evt.type) {
        case "step.started": {
          pendingStepUpdates.push({ type: "start", event: evt });
          addedSteps = true;

          // Track tool usage
          const toolName =
            (evt.payload.tool_name as string) ??
            (evt.payload.tool as string) ??
            "unknown";
          if (toolName !== "unknown") {
            toolCountsChanged = true;
            setToolCounts((prev) => {
              const next = new Map(prev);
              next.set(toolName, (next.get(toolName) ?? 0) + 1);
              return next;
            });
          }
          break;
        }
        case "step.succeeded": {
          pendingStepUpdates.push({ type: "succeed", event: evt });
          addedSteps = true;
          successDelta++;
          throughputUpdated = true;
          break;
        }
        case "step.failed": {
          pendingStepUpdates.push({ type: "fail", event: evt });
          addedSteps = true;
          failureDelta++;
          throughputUpdated = true;
          break;
        }
        case "session.completed": {
          sessionsDelta++;
          break;
        }
        default:
          break;
      }
    }

    // Batch step record updates
    if (addedSteps) {
      setStepRecords((prev) => {
        const records = [...prev];

        for (const update of pendingStepUpdates) {
          const evt = update.event;
          const stepId =
            (evt.payload.step_id as string) ??
            (evt.payload.stepId as string) ??
            evt.event_id;

          if (update.type === "start") {
            const toolName =
              (evt.payload.tool_name as string) ??
              (evt.payload.tool as string) ??
              "unknown";
            records.push({
              stepId,
              toolName,
              startedAt: new Date(evt.timestamp).getTime(),
            });
          } else {
            // Find the matching started record and compute duration
            const outcome =
              update.type === "succeed" ? "succeeded" : "failed";
            const existing = records.find(
              (r) => r.stepId === stepId && r.duration == null,
            );
            if (existing) {
              existing.duration =
                new Date(evt.timestamp).getTime() - existing.startedAt;
              existing.outcome = outcome;
            } else {
              // No matching start — record with synthetic duration
              const duration =
                (evt.payload.duration_ms as number) ??
                (evt.payload.duration as number) ??
                0;
              records.push({
                stepId,
                toolName:
                  (evt.payload.tool_name as string) ??
                  (evt.payload.tool as string) ??
                  "unknown",
                startedAt:
                  new Date(evt.timestamp).getTime() - duration,
                duration,
                outcome,
              });
            }
          }
        }

        // Trim to last MAX_STEP_HISTORY
        return records.slice(-MAX_STEP_HISTORY);
      });
    }

    if (successDelta > 0) {
      setSuccessCount((c) => c + successDelta);
    }
    if (failureDelta > 0) {
      setFailureCount((c) => c + failureDelta);
    }
    if (sessionsDelta > 0) {
      setSessionsCompleted((c) => c + sessionsDelta);
    }

    if (throughputUpdated) {
      const now = Date.now();
      setThroughputBuckets((prev) => {
        let buckets = [...prev];
        // Add a count for each completed/failed step
        for (let i = 0; i < successDelta + failureDelta; i++) {
          buckets = getOrCreateBucket(buckets, now);
        }
        return buckets;
      });
    }

    // Suppress unused variable warning
    void toolCountsChanged;
    setTick((t) => t + 1);
  }, [events, getOrCreateBucket]);

  /* ── Derive chart data ───────────────────────────────────────── */

  // Step duration histogram (vertical bars)
  const completedSteps = stepRecords.filter((r) => r.duration != null);
  const durationData: DataPoint[] = completedSteps.slice(-MAX_STEP_HISTORY).map((r, i) => ({
    label: `#${i + 1}`,
    value: r.duration!,
  }));

  // Tool usage distribution (horizontal bars)
  const toolUsageData: DataPoint[] = Array.from(toolCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ label: name, value: count }));

  // Success/failure donut
  const donutSegments: DonutSegment[] = [
    { label: "Succeeded", value: successCount, color: "#22c55e" },
    { label: "Failed", value: failureCount, color: "#ef4444" },
  ];

  // Session throughput line chart
  // Fill empty buckets for the last THROUGHPUT_WINDOW_MINUTES minutes
  const throughputData: DataPoint[] = (() => {
    const now = Date.now();
    const bucketMs = THROUGHPUT_BUCKET_SECONDS * 1000;
    const windowMs = THROUGHPUT_WINDOW_MINUTES * 60 * 1000;
    const startTs = Math.floor((now - windowMs) / bucketMs) * bucketMs;
    const points: DataPoint[] = [];

    for (let ts = startTs; ts <= now; ts += bucketMs) {
      const bucketTs = Math.floor(ts / bucketMs) * bucketMs;
      const bucket = throughputBuckets.find((b) => b.ts === bucketTs);
      const date = new Date(bucketTs);
      const label = `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
      points.push({ label, value: bucket?.count ?? 0 });
    }

    return points;
  })();

  /* ── Stats summary ────────────────────────────────────────────── */

  const totalSteps = successCount + failureCount;
  const avgDuration =
    completedSteps.length > 0
      ? completedSteps.reduce((sum, r) => sum + (r.duration ?? 0), 0) /
        completedSteps.length
      : 0;
  const successRate =
    totalSteps > 0 ? ((successCount / totalSteps) * 100).toFixed(1) : "0.0";

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wider">
            Live Metrics
          </h3>
          <span
            className={`h-2 w-2 rounded-full ${connected ? "bg-green-500 animate-pulse" : "bg-red-500"}`}
            title={connected ? "WebSocket connected" : "WebSocket disconnected"}
          />
        </div>
        <div className="flex items-center gap-4 text-xs text-[var(--muted)]">
          <span>
            Steps: <strong className="text-[var(--foreground)]">{totalSteps}</strong>
          </span>
          <span>
            Avg:{" "}
            <strong className="text-[var(--foreground)]">
              {avgDuration > 0 ? formatMs(avgDuration) : "-"}
            </strong>
          </span>
          <span>
            Rate:{" "}
            <strong className="text-[var(--foreground)]">
              {successRate}%
            </strong>
          </span>
          <span>
            Sessions:{" "}
            <strong className="text-[var(--foreground)]">
              {sessionsCompleted}
            </strong>
          </span>
        </div>
      </div>

      {/* Charts grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Step Duration Histogram */}
        <BarChart
          data={durationData}
          label="Step Duration (last 50 steps)"
          color="#8b5cf6"
          maxHeight={180}
        />

        {/* Tool Usage Distribution */}
        <HBarChart
          data={toolUsageData}
          label="Tool Usage Distribution"
        />

        {/* Success/Failure Rate */}
        <DonutChart
          segments={donutSegments}
          label="Success / Failure Rate"
          size={120}
        />

        {/* Session Throughput */}
        <LineChart
          data={throughputData}
          label={`Throughput (steps/min, last ${THROUGHPUT_WINDOW_MINUTES} min)`}
          color="#22c55e"
          maxHeight={180}
          unit="/min"
        />
      </div>
    </div>
  );
}

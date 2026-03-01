"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getJournal, type JournalEvent } from "@/lib/api";
import { PhaseIndicator } from "@/components/phase-indicator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReplayState {
  phase: string;
  plan: Record<string, unknown> | null;
  steps: Map<string, StepSnapshot>;
  errors: Array<{ timestamp: string; message: string; stepId?: string }>;
  currentStepId: string | null;
}

interface StepSnapshot {
  step_id: string;
  title: string;
  tool: string;
  status: "pending" | "running" | "succeeded" | "failed";
  started_at?: string;
  finished_at?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVENT_TYPE_COLORS: Record<string, string> = {
  "session.created": "text-blue-400",
  "session.completed": "text-emerald-400",
  "session.failed": "text-red-400",
  "session.aborted": "text-gray-400",
  "planner.requested": "text-yellow-400",
  "plan.generated": "text-purple-400",
  "plan.accepted": "text-purple-300",
  "step.started": "text-cyan-400",
  "step.succeeded": "text-green-400",
  "step.failed": "text-red-400",
  "permission.requested": "text-amber-400",
  "permission.granted": "text-amber-300",
  "permission.denied": "text-red-300",
};

const SPEED_OPTIONS = [
  { label: "1x", value: 1 },
  { label: "2x", value: 2 },
  { label: "5x", value: 5 },
  { label: "10x", value: 10 },
];

// All event types available for filtering
const ALL_EVENT_CATEGORIES: Array<{ prefix: string; label: string }> = [
  { prefix: "session.", label: "Session" },
  { prefix: "plan", label: "Plan" },
  { prefix: "planner", label: "Planner" },
  { prefix: "step.", label: "Step" },
  { prefix: "permission.", label: "Permission" },
  { prefix: "tool.", label: "Tool" },
  { prefix: "context.", label: "Context" },
  { prefix: "iteration.", label: "Iteration" },
];

// ---------------------------------------------------------------------------
// State reconstruction: given events[0..index], compute the replay state
// ---------------------------------------------------------------------------

function reconstructState(events: JournalEvent[], upToIndex: number): ReplayState {
  const state: ReplayState = {
    phase: "created",
    plan: null,
    steps: new Map(),
    errors: [],
    currentStepId: null,
  };

  for (let i = 0; i <= upToIndex && i < events.length; i++) {
    const evt = events[i]!;
    applyEvent(state, evt);
  }

  return state;
}

function applyEvent(state: ReplayState, evt: JournalEvent): void {
  const { type, payload, timestamp } = evt;

  // Phase transitions
  if (type === "session.created") {
    state.phase = "created";
  } else if (type === "planner.requested") {
    state.phase = "planning";
  } else if (type === "plan.accepted" || type === "step.started") {
    state.phase = "running";
  } else if (type === "session.completed") {
    state.phase = "completed";
  } else if (type === "session.failed") {
    state.phase = "failed";
  } else if (type === "session.aborted") {
    state.phase = "aborted";
  }

  // Plan
  if (type === "plan.accepted" && payload.plan) {
    state.plan = payload.plan as Record<string, unknown>;
  }

  // Steps
  const stepId = payload.step_id as string | undefined;
  if (stepId) {
    if (type === "step.started") {
      state.steps.set(stepId, {
        step_id: stepId,
        title: (payload.title as string) ?? stepId,
        tool: (payload.tool_name as string) ?? (payload.tool as string) ?? "unknown",
        status: "running",
        started_at: timestamp,
        input: payload.input as Record<string, unknown> | undefined,
      });
      state.currentStepId = stepId;
    } else if (type === "step.succeeded") {
      const existing = state.steps.get(stepId);
      if (existing) {
        existing.status = "succeeded";
        existing.finished_at = timestamp;
        existing.output = payload.output as Record<string, unknown> | undefined;
      }
      if (state.currentStepId === stepId) state.currentStepId = null;
    } else if (type === "step.failed") {
      const existing = state.steps.get(stepId);
      const errorMsg = (payload.error as string) ?? (payload.message as string) ?? "Unknown error";
      if (existing) {
        existing.status = "failed";
        existing.finished_at = timestamp;
        existing.error = errorMsg;
      }
      state.errors.push({ timestamp, message: errorMsg, stepId });
      if (state.currentStepId === stepId) state.currentStepId = null;
    }
  }

  // Session-level errors
  if (type === "session.failed") {
    const msg = (payload.error as string) ?? (payload.message as string) ?? (payload.reason as string);
    if (msg) state.errors.push({ timestamp, message: msg });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(ts: string): string {
  return ts.split("T")[1]?.slice(0, 12) ?? "";
}

function formatStepDuration(start?: string, end?: string): string | null {
  if (!start) return null;
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const ms = e - s;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

// ---------------------------------------------------------------------------
// Component: Timeline marker (the colored dots at the top scrubber)
// ---------------------------------------------------------------------------

function TimelineMarker({ event, index, total, isActive, onClick }: {
  event: JournalEvent;
  index: number;
  total: number;
  isActive: boolean;
  onClick: () => void;
}) {
  const left = total <= 1 ? 50 : (index / (total - 1)) * 100;
  const color = event.type.includes("failed") ? "bg-red-500"
    : event.type.includes("succeeded") || event.type.includes("completed") ? "bg-green-500"
    : event.type.includes("started") ? "bg-cyan-500"
    : event.type.includes("plan") ? "bg-purple-500"
    : event.type.includes("session") ? "bg-blue-500"
    : "bg-gray-500";

  return (
    <button
      onClick={onClick}
      className={`absolute top-1/2 -translate-y-1/2 rounded-full transition-all ${color} ${
        isActive ? "w-3.5 h-3.5 z-10 ring-2 ring-white/30" : "w-2 h-2 opacity-60 hover:opacity-100 hover:w-3 hover:h-3"
      }`}
      style={{ left: `${left}%`, transform: `translateX(-50%) translateY(-50%)` }}
      title={`${event.type} @ ${formatTime(event.timestamp)}`}
    />
  );
}

// ---------------------------------------------------------------------------
// Component: Step list item (in the right-side state panel)
// ---------------------------------------------------------------------------

function ReplayStepItem({ step, isActive }: { step: StepSnapshot; isActive: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const duration = formatStepDuration(step.started_at, step.finished_at);

  const statusColor = step.status === "succeeded" ? "text-green-400"
    : step.status === "failed" ? "text-red-400"
    : step.status === "running" ? "text-yellow-400"
    : "text-gray-400";

  const statusIcon = step.status === "succeeded" ? "\u2713"
    : step.status === "failed" ? "\u2717"
    : step.status === "running" ? "\u25CF"
    : "\u25CB";

  const borderClass = isActive ? "border-yellow-500/60 bg-yellow-500/[0.05]"
    : step.status === "succeeded" ? "border-green-500/20"
    : step.status === "failed" ? "border-red-500/20"
    : "border-[var(--border)]";

  return (
    <div className={`rounded border ${borderClass} transition-colors`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 p-2 text-left text-xs hover:bg-white/[0.02]"
      >
        <span className={`flex-shrink-0 ${statusColor}`}>{statusIcon}</span>
        <span className={`flex-1 truncate ${step.status === "succeeded" ? "text-[var(--muted)]" : ""}`}>
          {step.title}
        </span>
        <span className="font-mono text-[10px] bg-[var(--accent)]/10 text-[var(--accent)] px-1 rounded">
          {step.tool}
        </span>
        {duration && <span className="text-[10px] text-[var(--muted)] tabular-nums">{duration}</span>}
        <span className="text-[10px] text-[var(--muted)]">{expanded ? "\u25BC" : "\u25B6"}</span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] p-2 text-xs space-y-2">
          {step.error && (
            <div className="rounded bg-red-500/10 border border-red-500/20 p-2 text-red-400">
              {step.error}
            </div>
          )}
          {step.input && Object.keys(step.input).length > 0 && (
            <div>
              <p className="text-[var(--muted)] font-semibold mb-1">Input</p>
              <pre className="rounded bg-black/20 p-2 text-[var(--muted)] overflow-x-auto max-h-[150px] overflow-y-auto whitespace-pre-wrap break-all">
                {JSON.stringify(step.input, null, 2)}
              </pre>
            </div>
          )}
          {step.output && Object.keys(step.output).length > 0 && (
            <div>
              <p className="text-[var(--muted)] font-semibold mb-1">Output</p>
              <pre className="rounded bg-black/20 p-2 text-[var(--muted)] overflow-x-auto max-h-[150px] overflow-y-auto whitespace-pre-wrap break-all">
                {JSON.stringify(step.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main replay page
// ---------------------------------------------------------------------------

export default function SessionReplayPage() {
  const { id } = useParams<{ id: string }>();

  // Data
  const [allEvents, setAllEvents] = useState<JournalEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Playback state
  const [currentIndex, setCurrentIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const playTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Filter state
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);

  // ---------------------------------------------------------------------------
  // Fetch journal events
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!id) return;
    setLoading(true);

    // Use the journal endpoint with a high limit to get all events.
    // The endpoint paginates at 500, so we may need multiple fetches.
    (async () => {
      try {
        let allEvts: JournalEvent[] = [];
        let offset = 0;
        const pageSize = 500;
        let total = Infinity;

        while (offset < total) {
          const res = await fetch(
            `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3100"}/api/sessions/${encodeURIComponent(id)}/journal?offset=${offset}&limit=${pageSize}`,
            {
              headers: {
                "Content-Type": "application/json",
                ...(process.env.NEXT_PUBLIC_API_TOKEN ? { Authorization: `Bearer ${process.env.NEXT_PUBLIC_API_TOKEN}` } : {}),
              },
            }
          );
          if (!res.ok) {
            if (res.status === 404) { setError("Session not found"); setLoading(false); return; }
            throw new Error(`API ${res.status}`);
          }
          const data = await res.json() as { events: JournalEvent[]; total: number; offset: number; limit: number };
          total = data.total;
          allEvts = allEvts.concat(data.events);
          offset += data.events.length;
          if (data.events.length === 0) break; // safety
        }

        setAllEvents(allEvts);
        setCurrentIndex(0);
        setLoading(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load journal");
        setLoading(false);
      }
    })();
  }, [id]);

  // ---------------------------------------------------------------------------
  // Filter events for display (but state reconstruction always uses all)
  // ---------------------------------------------------------------------------
  const filteredIndices = useMemo(() => {
    if (hiddenCategories.size === 0) return allEvents.map((_, i) => i);
    return allEvents
      .map((evt, i) => ({ evt, i }))
      .filter(({ evt }) => {
        for (const cat of hiddenCategories) {
          if (evt.type.startsWith(cat)) return false;
        }
        return true;
      })
      .map(({ i }) => i);
  }, [allEvents, hiddenCategories]);

  // ---------------------------------------------------------------------------
  // Reconstruct state at current index
  // ---------------------------------------------------------------------------
  const replayState = useMemo(() => {
    if (allEvents.length === 0) return null;
    return reconstructState(allEvents, currentIndex);
  }, [allEvents, currentIndex]);

  // Current event
  const currentEvent = allEvents[currentIndex] ?? null;

  // ---------------------------------------------------------------------------
  // Playback timer
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!playing) {
      clearTimeout(playTimerRef.current);
      return;
    }

    if (currentIndex >= allEvents.length - 1) {
      setPlaying(false);
      return;
    }

    // Compute delay from timestamps for natural pacing
    const curr = allEvents[currentIndex];
    const next = allEvents[currentIndex + 1];
    let delayMs = 500; // default 500ms
    if (curr && next) {
      const diff = new Date(next.timestamp).getTime() - new Date(curr.timestamp).getTime();
      // Clamp: min 50ms, max 2000ms (before speed)
      delayMs = Math.max(50, Math.min(diff, 2000));
    }
    delayMs = delayMs / speed;

    playTimerRef.current = setTimeout(() => {
      setCurrentIndex((prev) => Math.min(prev + 1, allEvents.length - 1));
    }, delayMs);

    return () => clearTimeout(playTimerRef.current);
  }, [playing, currentIndex, speed, allEvents]);

  // ---------------------------------------------------------------------------
  // Jump-to helpers
  // ---------------------------------------------------------------------------
  const jumpPoints = useMemo(() => {
    const points: Array<{ label: string; index: number }> = [];

    const planIdx = allEvents.findIndex((e) => e.type === "plan.accepted");
    if (planIdx >= 0) points.push({ label: "Plan generated", index: planIdx });

    const firstStepIdx = allEvents.findIndex((e) => e.type === "step.started");
    if (firstStepIdx >= 0) points.push({ label: "First step", index: firstStepIdx });

    const firstErrorIdx = allEvents.findIndex((e) => e.type === "step.failed" || e.type === "session.failed");
    if (firstErrorIdx >= 0) points.push({ label: "First error", index: firstErrorIdx });

    const completedIdx = allEvents.findIndex((e) => e.type === "session.completed");
    if (completedIdx >= 0) points.push({ label: "Completed", index: completedIdx });

    const failedIdx = allEvents.findIndex((e) => e.type === "session.failed");
    if (failedIdx >= 0) points.push({ label: "Failed", index: failedIdx });

    // End
    if (allEvents.length > 0) points.push({ label: "End", index: allEvents.length - 1 });

    return points;
  }, [allEvents]);

  const jumpTo = useCallback((index: number) => {
    setPlaying(false);
    setCurrentIndex(index);
  }, []);

  // ---------------------------------------------------------------------------
  // Toggle category filter
  // ---------------------------------------------------------------------------
  const toggleCategory = useCallback((prefix: string) => {
    setHiddenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });
  }, []);

  // Present event types
  const presentCategories = useMemo(() => {
    const prefixes = new Set<string>();
    for (const evt of allEvents) {
      for (const cat of ALL_EVENT_CATEGORIES) {
        if (evt.type.startsWith(cat.prefix)) {
          prefixes.add(cat.prefix);
          break;
        }
      }
    }
    return ALL_EVENT_CATEGORIES.filter((c) => prefixes.has(c.prefix));
  }, [allEvents]);

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "ArrowRight" || e.key === "l") {
        e.preventDefault();
        setPlaying(false);
        setCurrentIndex((prev) => Math.min(prev + 1, allEvents.length - 1));
      } else if (e.key === "ArrowLeft" || e.key === "j") {
        e.preventDefault();
        setPlaying(false);
        setCurrentIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Home") {
        e.preventDefault();
        setPlaying(false);
        setCurrentIndex(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setPlaying(false);
        setCurrentIndex(allEvents.length - 1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [allEvents.length]);

  // ---------------------------------------------------------------------------
  // Auto-scroll event list to keep current event visible
  // ---------------------------------------------------------------------------
  const eventListRef = useRef<HTMLDivElement>(null);
  const activeEventRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeEventRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentIndex]);

  // ---------------------------------------------------------------------------
  // Plan steps from state
  // ---------------------------------------------------------------------------
  const planSteps = useMemo(() => {
    if (!replayState?.plan) return [];
    const steps = (replayState.plan as { steps?: Array<{ step_id: string; title: string; tool_ref?: { name: string } }> }).steps;
    return steps ?? [];
  }, [replayState?.plan]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-10 rounded-lg bg-[var(--border)]/30" />
        <div className="h-16 rounded-lg bg-[var(--border)]/30" />
        <div className="grid grid-cols-2 gap-4">
          <div className="h-96 rounded-lg bg-[var(--border)]/30" />
          <div className="h-96 rounded-lg bg-[var(--border)]/30" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <div className="flex items-center gap-3 mb-6">
          <Link href={`/sessions/${id}`} className="text-[var(--muted)] hover:text-[var(--foreground)] text-sm">&larr; Session</Link>
          <span className="text-[var(--muted)]">/</span>
          <span className="text-sm font-medium">Replay</span>
        </div>
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">{error}</div>
      </div>
    );
  }

  if (allEvents.length === 0) {
    return (
      <div>
        <div className="flex items-center gap-3 mb-6">
          <Link href={`/sessions/${id}`} className="text-[var(--muted)] hover:text-[var(--foreground)] text-sm">&larr; Session</Link>
          <span className="text-[var(--muted)]">/</span>
          <span className="text-sm font-medium">Replay</span>
        </div>
        <div className="rounded-lg border border-[var(--border)] p-8 text-center text-[var(--muted)]">
          No journal events found for this session.
        </div>
      </div>
    );
  }

  const stepsArray = Array.from(replayState?.steps.values() ?? []);

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      {/* ------------------------------------------------------------------- */}
      {/* Header                                                              */}
      {/* ------------------------------------------------------------------- */}
      <div className="flex items-center gap-3 mb-4 flex-shrink-0">
        <Link href={`/sessions/${id}`} className="text-[var(--muted)] hover:text-[var(--foreground)] text-sm">&larr; Session</Link>
        <span className="text-[var(--muted)]">/</span>
        <span className="text-sm font-medium">Replay</span>
        <span className="font-mono text-xs text-[var(--muted)]">{id?.slice(0, 8)}...</span>
        <div className="ml-auto flex items-center gap-2 text-xs text-[var(--muted)]">
          <span>Event {currentIndex + 1} / {allEvents.length}</span>
          {replayState && (
            <PhaseIndicator status={replayState.phase} />
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------- */}
      {/* Transport controls + scrubber                                       */}
      {/* ------------------------------------------------------------------- */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 mb-4 flex-shrink-0">
        {/* Controls row */}
        <div className="flex items-center gap-3 mb-3">
          {/* Play / Pause */}
          <button
            onClick={() => {
              if (currentIndex >= allEvents.length - 1) {
                setCurrentIndex(0);
                setPlaying(true);
              } else {
                setPlaying(!playing);
              }
            }}
            className="flex items-center justify-center w-8 h-8 rounded-md bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors text-sm font-bold"
            title={playing ? "Pause (Space)" : "Play (Space)"}
          >
            {playing ? "\u23F8" : "\u25B6"}
          </button>

          {/* Step backward */}
          <button
            onClick={() => { setPlaying(false); setCurrentIndex((p) => Math.max(p - 1, 0)); }}
            disabled={currentIndex <= 0}
            className="flex items-center justify-center w-8 h-8 rounded-md bg-white/5 text-[var(--foreground)] hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm"
            title="Previous event (Left arrow)"
          >
            \u23EE
          </button>

          {/* Step forward */}
          <button
            onClick={() => { setPlaying(false); setCurrentIndex((p) => Math.min(p + 1, allEvents.length - 1)); }}
            disabled={currentIndex >= allEvents.length - 1}
            className="flex items-center justify-center w-8 h-8 rounded-md bg-white/5 text-[var(--foreground)] hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm"
            title="Next event (Right arrow)"
          >
            \u23ED
          </button>

          {/* Speed selector */}
          <div className="flex items-center gap-1 ml-2">
            {SPEED_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setSpeed(opt.value)}
                className={`px-2 py-1 rounded text-xs font-mono transition-colors ${
                  speed === opt.value
                    ? "bg-[var(--accent)]/20 text-[var(--accent)]"
                    : "bg-white/5 text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Jump-to buttons */}
          <div className="ml-auto flex items-center gap-1">
            {jumpPoints.map((jp) => (
              <button
                key={jp.label}
                onClick={() => jumpTo(jp.index)}
                className={`px-2 py-1 rounded text-xs transition-colors ${
                  jp.label === "First error" || jp.label === "Failed"
                    ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
                    : jp.label === "Completed"
                    ? "bg-green-500/10 text-green-400 hover:bg-green-500/20"
                    : "bg-white/5 text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-white/10"
                }`}
              >
                {jp.label}
              </button>
            ))}
          </div>
        </div>

        {/* Scrubber bar */}
        <div className="relative">
          {/* Track background */}
          <div className="h-6 relative">
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-[var(--border)] rounded-full" />

            {/* Progress fill */}
            <div
              className="absolute top-1/2 -translate-y-1/2 left-0 h-1 bg-[var(--accent)]/40 rounded-full transition-all duration-100"
              style={{ width: allEvents.length <= 1 ? "100%" : `${(currentIndex / (allEvents.length - 1)) * 100}%` }}
            />

            {/* Event markers (only render if <200 events, otherwise too dense) */}
            {allEvents.length <= 200 && allEvents.map((evt, i) => (
              <TimelineMarker
                key={evt.event_id}
                event={evt}
                index={i}
                total={allEvents.length}
                isActive={i === currentIndex}
                onClick={() => jumpTo(i)}
              />
            ))}
          </div>

          {/* Range input overlay */}
          <input
            type="range"
            min={0}
            max={allEvents.length - 1}
            value={currentIndex}
            onChange={(e) => { setPlaying(false); setCurrentIndex(Number(e.target.value)); }}
            className="absolute inset-0 w-full h-6 opacity-0 cursor-pointer"
            style={{ zIndex: 20 }}
          />
        </div>

        {/* Timestamp indicators */}
        <div className="flex justify-between mt-1 text-[10px] text-[var(--muted)] font-mono">
          <span>{allEvents[0] ? formatTime(allEvents[0].timestamp) : ""}</span>
          <span>{currentEvent ? formatTime(currentEvent.timestamp) : ""}</span>
          <span>{allEvents[allEvents.length - 1] ? formatTime(allEvents[allEvents.length - 1]!.timestamp) : ""}</span>
        </div>
      </div>

      {/* ------------------------------------------------------------------- */}
      {/* Filters                                                             */}
      {/* ------------------------------------------------------------------- */}
      <div className="flex-shrink-0 mb-3">
        <button
          onClick={() => setShowFilters(!showFilters)}
          className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] flex items-center gap-1"
        >
          <span>{showFilters ? "\u25BC" : "\u25B6"}</span>
          Event filters
          {hiddenCategories.size > 0 && (
            <span className="bg-amber-500/20 text-amber-400 px-1.5 rounded text-[10px]">
              {hiddenCategories.size} hidden
            </span>
          )}
        </button>
        {showFilters && (
          <div className="flex flex-wrap gap-2 mt-2">
            {presentCategories.map((cat) => {
              const hidden = hiddenCategories.has(cat.prefix);
              const count = allEvents.filter((e) => e.type.startsWith(cat.prefix)).length;
              return (
                <button
                  key={cat.prefix}
                  onClick={() => toggleCategory(cat.prefix)}
                  className={`px-2 py-1 rounded text-xs transition-colors ${
                    hidden
                      ? "bg-white/5 text-[var(--muted)] line-through opacity-50"
                      : "bg-white/10 text-[var(--foreground)]"
                  }`}
                >
                  {cat.label} ({count})
                </button>
              );
            })}
            {hiddenCategories.size > 0 && (
              <button
                onClick={() => setHiddenCategories(new Set())}
                className="px-2 py-1 rounded text-xs bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
              >
                Show all
              </button>
            )}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------- */}
      {/* Split view: event list (left) | state panel (right)                 */}
      {/* ------------------------------------------------------------------- */}
      <div className="flex-1 grid grid-cols-2 gap-4 min-h-0">
        {/* Left: Event timeline list */}
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] flex flex-col min-h-0">
          <div className="p-3 border-b border-[var(--border)] flex-shrink-0">
            <h3 className="text-sm font-semibold">Event Timeline</h3>
            <p className="text-xs text-[var(--muted)] mt-0.5">
              {filteredIndices.length} events{filteredIndices.length !== allEvents.length ? ` (${allEvents.length} total)` : ""}
            </p>
          </div>
          <div ref={eventListRef} className="flex-1 overflow-y-auto divide-y divide-[var(--border)]">
            {filteredIndices.map((idx) => {
              const evt = allEvents[idx]!;
              const isActive = idx === currentIndex;
              const isPast = idx < currentIndex;
              const typeColor = EVENT_TYPE_COLORS[evt.type] ?? "text-[var(--foreground)]";

              return (
                <div
                  key={evt.event_id}
                  ref={isActive ? activeEventRef : undefined}
                  onClick={() => jumpTo(idx)}
                  className={`p-2 cursor-pointer transition-colors ${
                    isActive
                      ? "bg-[var(--accent)]/10 border-l-2 border-l-[var(--accent)]"
                      : isPast
                      ? "opacity-60 hover:opacity-80 hover:bg-white/[0.02]"
                      : "hover:bg-white/[0.02]"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-[var(--muted)] font-mono w-6 text-right flex-shrink-0">
                      {idx + 1}
                    </span>
                    <span className="text-[10px] text-[var(--muted)] font-mono w-20 flex-shrink-0">
                      {formatTime(evt.timestamp)}
                    </span>
                    <span className={`text-xs font-medium truncate ${typeColor}`}>
                      {evt.type}
                    </span>
                  </div>
                  {isActive && Object.keys(evt.payload).length > 0 && (
                    <pre className="text-[10px] text-[var(--muted)] mt-1 ml-[108px] overflow-x-auto max-h-24 overflow-y-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(evt.payload, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: State at current point */}
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] flex flex-col min-h-0">
          <div className="p-3 border-b border-[var(--border)] flex-shrink-0">
            <h3 className="text-sm font-semibold">State at Event #{currentIndex + 1}</h3>
            {currentEvent && (
              <p className="text-xs text-[var(--muted)] mt-0.5 font-mono">{currentEvent.type}</p>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-4">
            {/* Phase */}
            {replayState && (
              <div>
                <p className="text-xs text-[var(--muted)] uppercase tracking-wider font-semibold mb-1">Phase</p>
                <PhaseIndicator status={replayState.phase} />
              </div>
            )}

            {/* Plan */}
            <div>
              <p className="text-xs text-[var(--muted)] uppercase tracking-wider font-semibold mb-1">Plan</p>
              {replayState?.plan ? (
                <div className="rounded border border-[var(--border)] p-2 space-y-1">
                  {(replayState.plan as { goal?: string }).goal && (
                    <p className="text-xs text-[var(--muted)] mb-2">
                      {(replayState.plan as { goal?: string }).goal}
                    </p>
                  )}
                  {planSteps.length > 0 ? (
                    <div className="space-y-0.5">
                      {planSteps.map((ps, i) => {
                        const stepState = replayState.steps.get(ps.step_id);
                        const status = stepState?.status ?? "pending";
                        const statusIcon = status === "succeeded" ? "\u2713"
                          : status === "failed" ? "\u2717"
                          : status === "running" ? "\u25CF"
                          : "\u25CB";
                        const statusColor = status === "succeeded" ? "text-green-400"
                          : status === "failed" ? "text-red-400"
                          : status === "running" ? "text-yellow-400"
                          : "text-gray-500";
                        const isActiveStep = replayState.currentStepId === ps.step_id;

                        return (
                          <div
                            key={ps.step_id}
                            className={`flex items-center gap-2 text-xs p-1 rounded ${
                              isActiveStep ? "bg-yellow-500/10" : ""
                            }`}
                          >
                            <span className={`flex-shrink-0 ${statusColor}`}>{statusIcon}</span>
                            <span className="text-[var(--muted)] font-mono w-4">{i + 1}</span>
                            <span className={`truncate ${status === "succeeded" ? "text-[var(--muted)] line-through decoration-green-500/30" : ""}`}>
                              {ps.title}
                            </span>
                            {ps.tool_ref && (
                              <span className="font-mono text-[10px] bg-[var(--accent)]/10 text-[var(--accent)] px-1 rounded ml-auto flex-shrink-0">
                                {ps.tool_ref.name}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-[var(--muted)]">No steps in plan</p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-[var(--muted)]/60">Waiting for planner...</p>
              )}
            </div>

            {/* Steps (execution results) */}
            {stepsArray.length > 0 && (
              <div>
                <p className="text-xs text-[var(--muted)] uppercase tracking-wider font-semibold mb-1">
                  Steps ({stepsArray.filter((s) => s.status === "succeeded").length}/{stepsArray.length} done)
                </p>
                <div className="space-y-1">
                  {stepsArray.map((step) => (
                    <ReplayStepItem
                      key={step.step_id}
                      step={step}
                      isActive={replayState?.currentStepId === step.step_id}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Errors */}
            {replayState && replayState.errors.length > 0 && (
              <div>
                <p className="text-xs text-red-400 uppercase tracking-wider font-semibold mb-1">
                  Errors ({replayState.errors.length})
                </p>
                <div className="space-y-1">
                  {replayState.errors.map((err, i) => (
                    <div key={i} className="rounded bg-red-500/10 border border-red-500/20 p-2 text-xs text-red-400">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-mono text-[10px] text-red-400/60">{formatTime(err.timestamp)}</span>
                        {err.stepId && (
                          <span className="font-mono text-[10px] text-red-400/60">step:{err.stepId.slice(0, 8)}</span>
                        )}
                      </div>
                      <p>{err.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Current event detail */}
            {currentEvent && (
              <div>
                <p className="text-xs text-[var(--muted)] uppercase tracking-wider font-semibold mb-1">Current Event</p>
                <div className="rounded border border-[var(--border)] p-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs font-medium ${EVENT_TYPE_COLORS[currentEvent.type] ?? "text-[var(--foreground)]"}`}>
                      {currentEvent.type}
                    </span>
                    <span className="text-[10px] text-[var(--muted)] font-mono">{formatTime(currentEvent.timestamp)}</span>
                  </div>
                  {Object.keys(currentEvent.payload).length > 0 && (
                    <pre className="text-[10px] text-[var(--muted)] overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(currentEvent.payload, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------- */}
      {/* Keyboard shortcut hints                                              */}
      {/* ------------------------------------------------------------------- */}
      <div className="flex-shrink-0 mt-2 flex items-center gap-4 text-[10px] text-[var(--muted)]">
        <span><kbd className="px-1 py-0.5 rounded bg-white/10 font-mono">Space</kbd> Play/Pause</span>
        <span><kbd className="px-1 py-0.5 rounded bg-white/10 font-mono">&larr;</kbd><kbd className="px-1 py-0.5 rounded bg-white/10 font-mono">&rarr;</kbd> Step</span>
        <span><kbd className="px-1 py-0.5 rounded bg-white/10 font-mono">Home</kbd> Start</span>
        <span><kbd className="px-1 py-0.5 rounded bg-white/10 font-mono">End</kbd> End</span>
      </div>
    </div>
  );
}

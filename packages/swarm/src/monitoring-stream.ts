import type { MonitoringEvent, MonitoringEventType, MonitoringLevel, LeveledMonitoringEvent } from "./types.js";

export interface MonitoringStreamConfig {
  max_connections?: number;     // max concurrent SSE clients (default 10)
  heartbeat_interval_ms?: number; // SSE keepalive (default 15000)
}

interface Subscriber {
  id: string;
  write: (data: string) => void;
  filter?: {
    task_id?: string;
    peer_node_id?: string;
    event_types?: MonitoringEventType[];
    level?: MonitoringLevel;
  };
  cleanup: () => void;
}

export const MONITORING_LEVEL_ORDINAL: Record<MonitoringLevel, number> = {
  L0_IS_OPERATIONAL: 0,
  L1_HIGH_LEVEL_PLAN: 1,
  L2_COT_TRACE: 2,
  L3_FULL_STATE: 3,
};

let subscriberCounter = 0;

export class MonitoringStream {
  private config: Required<MonitoringStreamConfig>;
  private subscribers = new Map<string, Subscriber>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(config?: MonitoringStreamConfig) {
    this.config = {
      max_connections: config?.max_connections ?? 10,
      heartbeat_interval_ms: config?.heartbeat_interval_ms ?? 15000,
    };
  }

  subscribe(
    res: { write: (data: string) => void; on: (event: string, cb: () => void) => void },
    filter?: { task_id?: string; peer_node_id?: string; event_types?: MonitoringEventType[]; level?: MonitoringLevel },
  ): () => void {
    if (this.subscribers.size >= this.config.max_connections) {
      res.write("event: error\ndata: {\"error\":\"Max connections reached\"}\n\n");
      return () => {};
    }

    const id = `sub-${++subscriberCounter}`;

    const cleanup = () => {
      this.subscribers.delete(id);
      if (this.subscribers.size === 0 && this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
      }
    };

    const subscriber: Subscriber = {
      id,
      write: (data: string) => res.write(data),
      filter,
      cleanup,
    };

    this.subscribers.set(id, subscriber);

    // Start heartbeat timer if first subscriber
    if (this.subscribers.size === 1 && !this.heartbeatTimer) {
      this.startHeartbeat();
    }

    // Handle client disconnect
    res.on("close", cleanup);

    return cleanup;
  }

  publish(event: MonitoringEvent): void {
    for (const subscriber of this.subscribers.values()) {
      if (this.matchesFilter(event, subscriber.filter)) {
        const sseData = `event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`;
        subscriber.write(sseData);
      }
    }
  }

  publishLeveled(event: LeveledMonitoringEvent): void {
    for (const subscriber of this.subscribers.values()) {
      if (!this.matchesFilter(event, subscriber.filter)) continue;

      // Level filtering: only send if subscriber level >= event level
      if (subscriber.filter?.level) {
        const subscriberOrd = MONITORING_LEVEL_ORDINAL[subscriber.filter.level];
        const eventOrd = MONITORING_LEVEL_ORDINAL[event.level];
        if (subscriberOrd < eventOrd) continue;
      }

      const filtered = filterEventForLevel(event, subscriber.filter?.level ?? "L3_FULL_STATE");
      const sseData = `event: ${filtered.event_type}\ndata: ${JSON.stringify(filtered)}\n\n`;
      subscriber.write(sseData);
    }
  }

  get connectionCount(): number {
    return this.subscribers.size;
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    // Copy to avoid mutation during iteration
    const subs = [...this.subscribers.values()];
    for (const sub of subs) {
      sub.cleanup();
    }
    this.subscribers.clear();
  }

  // ─── Internal ────────────────────────────────────────────────────

  private matchesFilter(event: MonitoringEvent, filter?: Subscriber["filter"]): boolean {
    if (!filter) return true;
    if (filter.task_id && event.task_id !== filter.task_id) return false;
    if (filter.peer_node_id && event.peer_node_id !== filter.peer_node_id) return false;
    if (filter.event_types && filter.event_types.length > 0 && !filter.event_types.includes(event.event_type)) return false;
    return true;
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const heartbeatData = "event: heartbeat\ndata: {}\n\n";
      for (const subscriber of this.subscribers.values()) {
        subscriber.write(heartbeatData);
      }
    }, this.config.heartbeat_interval_ms);
    this.heartbeatTimer.unref();
  }
}

export function classifyEventLevel(eventType: MonitoringEventType): MonitoringLevel {
  switch (eventType) {
    case "checkpoint":
      return "L0_IS_OPERATIONAL";
    case "progress":
    case "completed":
    case "failed":
      return "L1_HIGH_LEVEL_PLAN";
    case "warning":
    case "error":
      return "L2_COT_TRACE";
    default:
      return "L3_FULL_STATE";
  }
}

export function filterEventForLevel(
  event: LeveledMonitoringEvent,
  subscriberLevel: MonitoringLevel,
): LeveledMonitoringEvent {
  const subscriberOrd = MONITORING_LEVEL_ORDINAL[subscriberLevel];
  const eventOrd = MONITORING_LEVEL_ORDINAL[event.level];

  if (subscriberOrd >= eventOrd) {
    return event; // Full detail
  }

  // Strip detail for lower subscriber levels
  const { detail, ...rest } = event;
  return rest;
}

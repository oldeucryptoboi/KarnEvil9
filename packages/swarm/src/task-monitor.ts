import type { JournalEventType } from "@karnevil9/schemas";
import type { PeerTransport } from "./transport.js";
import type { TaskMonitorConfig, TaskCheckpointStatus, MonitoringLevel } from "./types.js";
import { DEFAULT_TASK_MONITOR_CONFIG } from "./types.js";

interface MonitoredTask {
  task_id: string;
  peer_node_id: string;
  peer_api_url: string;
  contract_id?: string;
  missed_checkpoints: number;
  last_checkpoint_at: string;
  timer: ReturnType<typeof setInterval>;
  monitoring_level?: MonitoringLevel;
}

export interface TaskMonitorConstructorConfig {
  transport: PeerTransport;
  monitorConfig?: Partial<TaskMonitorConfig>;
  emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;
  onCheckpointsMissed?: (taskId: string, peerNodeId: string) => void;
  getPeerApiUrl: (peerNodeId: string) => string | undefined;
}

export class TaskMonitor {
  private transport: PeerTransport;
  private config: TaskMonitorConfig;
  private monitoredTasks = new Map<string, MonitoredTask>();
  private emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;
  private onCheckpointsMissed?: (taskId: string, peerNodeId: string) => void;
  private getPeerApiUrl: (peerNodeId: string) => string | undefined;

  constructor(config: TaskMonitorConstructorConfig) {
    this.transport = config.transport;
    this.config = { ...DEFAULT_TASK_MONITOR_CONFIG, ...config.monitorConfig };
    this.emitEvent = config.emitEvent;
    this.onCheckpointsMissed = config.onCheckpointsMissed;
    this.getPeerApiUrl = config.getPeerApiUrl;
  }

  startMonitoring(params: {
    task_id: string;
    peer_node_id: string;
    contract_id?: string;
    report_interval_ms?: number;
    monitoring_level?: MonitoringLevel;
  }): void {
    if (this.monitoredTasks.has(params.task_id)) return;

    const apiUrl = this.getPeerApiUrl(params.peer_node_id);
    if (!apiUrl) return;

    const intervalMs = params.report_interval_ms ?? this.config.poll_interval_ms;

    const timer = setInterval(() => {
      void this.pollCheckpoint(params.task_id);
    }, intervalMs);
    timer.unref();

    const monitored: MonitoredTask = {
      task_id: params.task_id,
      peer_node_id: params.peer_node_id,
      peer_api_url: apiUrl,
      contract_id: params.contract_id,
      missed_checkpoints: 0,
      last_checkpoint_at: new Date().toISOString(),
      timer,
      monitoring_level: params.monitoring_level,
    };

    this.monitoredTasks.set(params.task_id, monitored);
    this.emitEvent?.("swarm.task_monitoring_started" as JournalEventType, {
      task_id: params.task_id,
      peer_node_id: params.peer_node_id,
      poll_interval_ms: intervalMs,
      monitoring_level: params.monitoring_level,
    });
  }

  stopMonitoring(taskId: string): void {
    const monitored = this.monitoredTasks.get(taskId);
    if (!monitored) return;

    clearInterval(monitored.timer);
    this.monitoredTasks.delete(taskId);
    this.emitEvent?.("swarm.task_monitoring_stopped" as JournalEventType, {
      task_id: taskId,
      peer_node_id: monitored.peer_node_id,
    });
  }

  stopAll(): void {
    for (const [taskId] of this.monitoredTasks) {
      this.stopMonitoring(taskId);
    }
  }

  getMonitoredTasks(): Array<{
    task_id: string;
    peer_node_id: string;
    missed_checkpoints: number;
    last_checkpoint_at: string;
  }> {
    return [...this.monitoredTasks.values()].map((m) => ({
      task_id: m.task_id,
      peer_node_id: m.peer_node_id,
      missed_checkpoints: m.missed_checkpoints,
      last_checkpoint_at: m.last_checkpoint_at,
    }));
  }

  get size(): number {
    return this.monitoredTasks.size;
  }

  private async pollCheckpoint(taskId: string): Promise<void> {
    const monitored = this.monitoredTasks.get(taskId);
    if (!monitored) return;

    try {
      const response = await this.transport.sendCheckpointRequest(
        monitored.peer_api_url,
        taskId,
      );

      if (response.ok && response.data) {
        monitored.missed_checkpoints = 0;
        monitored.last_checkpoint_at = new Date().toISOString();
        this.emitEvent?.("swarm.task_checkpoint_received" as JournalEventType, {
          task_id: taskId,
          peer_node_id: monitored.peer_node_id,
          status: response.data.status,
          progress_pct: response.data.progress_pct,
        });

        // Auto-stop if task has finished
        if (response.data.status === "completed" || response.data.status === "failed") {
          this.stopMonitoring(taskId);
        }
      } else {
        this.handleMissedCheckpoint(monitored);
      }
    } catch {
      this.handleMissedCheckpoint(monitored);
    }
  }

  private handleMissedCheckpoint(monitored: MonitoredTask): void {
    monitored.missed_checkpoints++;
    this.emitEvent?.("swarm.task_checkpoint_missed" as JournalEventType, {
      task_id: monitored.task_id,
      peer_node_id: monitored.peer_node_id,
      missed_count: monitored.missed_checkpoints,
      max_missed: this.config.max_missed_checkpoints,
    });

    if (monitored.missed_checkpoints >= this.config.max_missed_checkpoints) {
      this.stopMonitoring(monitored.task_id);
      this.onCheckpointsMissed?.(monitored.task_id, monitored.peer_node_id);
    }
  }
}

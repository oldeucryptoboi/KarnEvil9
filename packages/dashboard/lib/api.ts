const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3100";
const TOKEN = process.env.NEXT_PUBLIC_API_TOKEN ?? "";

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    ...(opts?.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${BASE_URL}${path}`, { ...opts, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export interface SessionSummary {
  session_id: string;
  status: string;
  created_at: string;
  task_text?: string;
  completed_steps?: number;
  total_steps?: number;
  mode?: string;
}

export interface SessionDetail extends SessionSummary {
  task?: { task_id: string; text: string; created_at: string };
  plan?: unknown;
  events?: JournalEvent[];
}

export interface JournalEvent {
  event_id: string;
  session_id: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
  seq?: number;
  hash_prev?: string;
}

export interface ApprovalRequest {
  request_id: string;
  session_id: string;
  step_id: string;
  tool_name: string;
  permissions: Array<{ scope: string }>;
  created_at: string;
}

export interface ToolInfo {
  name: string;
  version: string;
  description: string;
  runner: string;
  permissions: string[];
}

export interface ScheduleTrigger {
  type: "at" | "every" | "cron";
  interval?: string;
  cron?: string;
  expression?: string;
  at?: string;
  start_at?: string;
  timezone?: string;
}

export interface ScheduleAction {
  type: "createSession" | "emitEvent";
  task_text: string;
  agentic?: boolean;
  mode?: string;
  planner?: string;
  model?: string;
}

export interface ScheduleOptions {
  delete_after_run?: boolean;
  max_failures?: number;
  description?: string;
  tags?: string[];
}

export interface Schedule {
  schedule_id: string;
  name: string;
  trigger: ScheduleTrigger;
  action: ScheduleAction;
  options?: ScheduleOptions;
  status: string;
  run_count: number;
  failure_count: number;
  next_run_at?: string;
  last_run_at?: string;
  last_session_id?: string;
  last_error?: string;
  created_at: string;
  updated_at?: string;
}

export interface CreateScheduleInput {
  name: string;
  trigger: ScheduleTrigger;
  action: ScheduleAction;
  options?: ScheduleOptions;
}

export interface UpdateScheduleInput {
  name?: string;
  trigger?: ScheduleTrigger;
  action?: ScheduleAction;
  options?: ScheduleOptions;
}

export interface HealthCheck {
  status: string;
  detail?: string;
  loaded?: number;
  failed?: number;
  disk_usage?: { usage_pct: number };
  active?: number;
  schedules?: number;
  peers?: number;
  active_peers?: number;
}

export interface HealthStatus {
  status: string;
  version: string;
  timestamp: string;
  checks: {
    journal: HealthCheck;
    tools: HealthCheck;
    sessions: HealthCheck;
    planner: HealthCheck;
    permissions: HealthCheck;
    runtime: HealthCheck;
    plugins: HealthCheck;
    scheduler: HealthCheck;
    swarm: HealthCheck;
  };
}

// Sessions
export const getSessions = async (): Promise<SessionSummary[]> => {
  const res = await apiFetch<{ sessions: SessionSummary[] }>("/api/sessions");
  return res.sessions;
};
export const getSession = (id: string) => apiFetch<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);
export const createSession = (task: string, mode = "mock") =>
  apiFetch<{ session_id: string; status: string }>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ task, mode }),
  });
export const abortSession = (id: string) =>
  apiFetch<{ status: string }>(`/api/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" });

// Session Export / Import
export interface SessionExportBundle {
  version: number;
  exported_at: string;
  session: Record<string, unknown>;
  events: JournalEvent[];
  plan: Record<string, unknown> | null;
}

export const exportSession = async (id: string): Promise<Blob> => {
  const headers: Record<string, string> = {
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
  };
  const res = await fetch(`${BASE_URL}/api/sessions/${encodeURIComponent(id)}/export`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.blob();
};

export const importSession = (bundle: unknown) =>
  apiFetch<{ session_id: string; events_imported: number }>("/api/sessions/import", {
    method: "POST",
    body: JSON.stringify(bundle),
  });

// Journal
export const getJournal = async (sessionId: string): Promise<JournalEvent[]> => {
  const res = await apiFetch<JournalEvent[] | { events: JournalEvent[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/journal`);
  return Array.isArray(res) ? res : res.events;
};

export interface JournalPage {
  events: JournalEvent[];
  total: number;
  offset: number;
  limit: number;
}

export const getJournalPage = async (
  sessionId: string,
  offset = 0,
  limit = 100,
): Promise<JournalPage> => {
  const res = await apiFetch<JournalPage>(
    `/api/sessions/${encodeURIComponent(sessionId)}/journal?offset=${offset}&limit=${limit}`,
  );
  return res;
};

/** Fetch journal events from multiple sessions and merge them sorted by timestamp descending. */
export const getJournalAcrossSessions = async (
  sessionIds: string[],
): Promise<JournalEvent[]> => {
  const pages = await Promise.all(
    sessionIds.map((sid) => getJournal(sid).catch(() => [] as JournalEvent[])),
  );
  const all = pages.flat();
  all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return all;
};

// Approvals
export const getApprovals = async (): Promise<ApprovalRequest[]> => {
  const res = await apiFetch<{ pending: Array<{ request_id: string; request: ApprovalRequest }> }>("/api/approvals");
  return res.pending.map((item) => ({ ...item.request, request_id: item.request_id }));
};
export const submitApproval = (id: string, decision: string) =>
  apiFetch<{ status: string }>(`/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });

// Tools — API returns { tools: [...] }
export const getTools = async (): Promise<ToolInfo[]> => {
  const res = await apiFetch<{ tools: ToolInfo[] }>("/api/tools");
  return res.tools;
};

// Plugins
export interface PluginProvides {
  tools?: string[];
  hooks?: string[];
  routes?: string[];
  commands?: string[];
  planners?: string[];
  services?: string[];
}

export interface PluginManifestInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  entry: string;
  permissions: string[];
  config_schema?: Record<string, unknown>;
  provides: PluginProvides;
}

export type PluginStatus = "discovered" | "loading" | "active" | "failed" | "unloaded" | "available";

export interface PluginInfo {
  id: string;
  manifest: PluginManifestInfo;
  status: PluginStatus;
  loaded_at?: string;
  failed_at?: string;
  error?: string;
  config: Record<string, unknown>;
}

export interface PluginListResponse {
  plugins: PluginInfo[];
  available: PluginInfo[];
}

export const getPluginsCatalog = async (): Promise<PluginListResponse> => {
  return apiFetch<PluginListResponse>("/api/plugins");
};

export const getPlugins = async (): Promise<PluginInfo[]> => {
  const res = await apiFetch<PluginListResponse>("/api/plugins");
  return res.plugins;
};

export const getPlugin = async (id: string): Promise<PluginInfo> => {
  return apiFetch<PluginInfo>(`/api/plugins/${encodeURIComponent(id)}`);
};

export const reloadPlugin = async (id: string): Promise<PluginInfo> => {
  return apiFetch<PluginInfo>(`/api/plugins/${encodeURIComponent(id)}/reload`, { method: "POST" });
};

export const unloadPlugin = async (id: string): Promise<{ status: string; id: string }> => {
  return apiFetch<{ status: string; id: string }>(`/api/plugins/${encodeURIComponent(id)}/unload`, { method: "POST" });
};

export const installPlugin = async (id: string): Promise<PluginInfo> => {
  return apiFetch<PluginInfo>(`/api/plugins/${encodeURIComponent(id)}/install`, { method: "POST" });
};

// Schedules — API returns { schedules: [...], total: N }
export const getSchedules = async (): Promise<Schedule[]> => {
  const res = await apiFetch<{ schedules: Schedule[] }>("/api/schedules");
  return res.schedules;
};
export const getSchedule = (id: string) =>
  apiFetch<Schedule>(`/api/schedules/${encodeURIComponent(id)}`);
export const createScheduleApi = (input: CreateScheduleInput) =>
  apiFetch<Schedule>("/api/schedules", { method: "POST", body: JSON.stringify(input) });
export const updateSchedule = (id: string, input: UpdateScheduleInput) =>
  apiFetch<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
export const deleteSchedule = (id: string) =>
  apiFetch<{ deleted: boolean; schedule_id: string }>(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
export const pauseSchedule = (id: string) =>
  apiFetch<Schedule>(`/api/schedules/${encodeURIComponent(id)}/pause`, { method: "POST" });
export const resumeSchedule = (id: string) =>
  apiFetch<Schedule>(`/api/schedules/${encodeURIComponent(id)}/resume`, { method: "POST" });
export const triggerSchedule = (id: string) =>
  apiFetch<{ triggered: boolean; schedule_id: string; session_id?: string }>(
    `/api/schedules/${encodeURIComponent(id)}/trigger`,
    { method: "POST" },
  );

// Health
export const getHealth = () => apiFetch<HealthStatus>("/api/health");

// Metrics (raw Prometheus text)
export const getMetricsText = async (): Promise<string> => {
  const headers: Record<string, string> = {
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
  };
  const res = await fetch(`${BASE_URL}/api/metrics`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.text();
};

// Journal compaction
export interface CompactResult {
  before: number;
  after: number;
}
export const compactJournal = (retainSessionIds?: string[]) =>
  apiFetch<CompactResult>("/api/journal/compact", {
    method: "POST",
    body: JSON.stringify({ retain_sessions: retainSessionIds }),
  });

// Vault
export interface VaultObject {
  object_id: string;
  object_type: string;
  source: string;
  source_id: string;
  title: string;
  tags: string[];
  entities: string[];
  para_category: string;
  file_path: string;
  created_at: string;
  ingested_at: string;
}

export interface VaultDashboard {
  generated_at: string;
  total_objects: number;
  total_links: number;
  unclassified_count: number;
  embedding_coverage: number;
  objects_by_type: Record<string, number>;
  objects_by_category: Record<string, number>;
  objects_by_source: Record<string, number>;
  top_entities: Array<{ entity: string; count: number }>;
  recent_activity: Array<{ object_id: string; title: string; ingested_at: string }>;
}

export const getVaultDashboard = () => apiFetch<VaultDashboard>("/api/plugins/vault/vault/dashboard");

export const getVaultObjects = async (params?: { limit?: number; object_type?: string; para_category?: string; source?: string }): Promise<{ results: VaultObject[]; total: number }> => {
  const query = new URLSearchParams();
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.object_type) query.set("object_type", params.object_type);
  if (params?.para_category) query.set("para_category", params.para_category);
  if (params?.source) query.set("source", params.source);
  const qs = query.toString();
  return apiFetch<{ results: VaultObject[]; total: number }>(`/api/plugins/vault/vault/objects${qs ? `?${qs}` : ""}`);
};

export const searchVault = async (q: string, params?: { limit?: number; type?: string; category?: string }): Promise<{ results: VaultObject[]; total: number }> => {
  const query = new URLSearchParams({ q });
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.type) query.set("type", params.type);
  if (params?.category) query.set("category", params.category);
  return apiFetch<{ results: VaultObject[]; total: number }>(`/api/plugins/vault/vault/search?${query.toString()}`);
};

// Coverage
export interface CoverageMetric {
  total: number;
  covered: number;
  pct: number;
}

export interface CoverageTotal {
  statements: CoverageMetric;
  branches: CoverageMetric;
  functions: CoverageMetric;
  lines: CoverageMetric;
}

export interface CoverageReport {
  total: CoverageTotal;
  packages: Record<string, CoverageTotal>;
  generated_at: string;
}

export const getCoverage = () => apiFetch<CoverageReport>("/api/coverage");

// Swarm
export type PeerStatus = "active" | "suspected" | "unreachable" | "left";

export interface SwarmPeer {
  node_id: string;
  display_name: string;
  api_url: string;
  capabilities: string[];
  status: PeerStatus;
  last_heartbeat_at: string;
  last_latency_ms: number;
  joined_at: string;
}

export interface SwarmIdentity {
  node_id: string;
  display_name: string;
  api_url: string;
  capabilities: string[];
  version: string;
}

export interface SwarmStatusResponse {
  running: boolean;
  node_id: string;
  display_name: string;
  peer_count: number;
  active_peers: number;
  active_delegations: number;
}

export interface SwarmPeersResponse {
  self: SwarmIdentity;
  peers: SwarmPeer[];
  total: number;
}

export interface PeerReputation {
  node_id: string;
  tasks_completed: number;
  tasks_failed: number;
  tasks_aborted: number;
  total_duration_ms: number;
  total_tokens_used: number;
  total_cost_usd: number;
  avg_latency_ms: number;
  consecutive_successes: number;
  consecutive_failures: number;
  last_outcome_at: string;
  trust_score: number;
}

export interface DelegationContract {
  contract_id: string;
  delegator_node_id: string;
  delegatee_node_id: string;
  task_id: string;
  task_text: string;
  status: "active" | "completed" | "violated" | "cancelled";
  created_at: string;
  completed_at?: string;
  violation_reason?: string;
}

export interface AnomalyReport {
  anomaly_id: string;
  task_id: string;
  peer_node_id: string;
  type: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  timestamp: string;
}

export const getSwarmStatus = () =>
  apiFetch<SwarmStatusResponse>("/api/plugins/swarm/status");

export const getSwarmPeers = () =>
  apiFetch<SwarmPeersResponse>("/api/plugins/swarm/peers");

export const getSwarmReputations = () =>
  apiFetch<{ reputations: PeerReputation[]; total: number }>("/api/plugins/swarm/reputation");

export const getSwarmContracts = () =>
  apiFetch<{ contracts: DelegationContract[]; total: number }>("/api/plugins/swarm/contracts");

export const getSwarmAnomalies = () =>
  apiFetch<{ anomalies: AnomalyReport[]; total: number }>("/api/plugins/swarm/anomalies");

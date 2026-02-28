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

export interface Schedule {
  schedule_id: string;
  name: string;
  trigger: { type: string; interval?: string; cron?: string };
  action: { type: string; task_text: string; agentic?: boolean };
  status: string;
  run_count: number;
  failure_count: number;
  next_run_at?: string;
  last_run_at?: string;
  created_at: string;
}

export interface HealthStatus {
  status: string;
  uptime_ms: number;
  sessions_active: number;
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

// Journal
export const getJournal = async (sessionId: string): Promise<JournalEvent[]> => {
  const res = await apiFetch<JournalEvent[] | { events: JournalEvent[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/journal`);
  return Array.isArray(res) ? res : res.events;
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
export const getPlugins = () => apiFetch<Array<{ id: string; status: string; manifest: Record<string, unknown> }>>("/api/plugins");

// Schedules — API returns { schedules: [...], total: N }
export const getSchedules = async (): Promise<Schedule[]> => {
  const res = await apiFetch<{ schedules: Schedule[] }>("/api/schedules");
  return res.schedules;
};
export const createSchedule = (schedule: Partial<Schedule>) =>
  apiFetch<Schedule>("/api/schedules", { method: "POST", body: JSON.stringify(schedule) });
export const deleteSchedule = (id: string) =>
  apiFetch<void>(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });

// Health
export const getHealth = () => apiFetch<HealthStatus>("/api/health");

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

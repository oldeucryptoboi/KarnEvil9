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
}

export interface SessionDetail extends SessionSummary {
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
  id: string;
  cron?: string;
  interval_ms?: number;
  task_text: string;
  enabled: boolean;
  next_run?: string;
  last_run?: string;
}

export interface HealthStatus {
  status: string;
  uptime_ms: number;
  sessions_active: number;
}

// Sessions
export const getSessions = () => apiFetch<SessionSummary[]>("/api/sessions");
export const getSession = (id: string) => apiFetch<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);
export const createSession = (task: string, mode = "mock") =>
  apiFetch<{ session_id: string; status: string }>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ task, mode }),
  });
export const abortSession = (id: string) =>
  apiFetch<{ status: string }>(`/api/sessions/${encodeURIComponent(id)}/abort`, { method: "POST" });

// Journal
export const getJournal = (sessionId: string) =>
  apiFetch<JournalEvent[]>(`/api/sessions/${encodeURIComponent(sessionId)}/journal`);

// Approvals
export const getApprovals = () => apiFetch<ApprovalRequest[]>("/api/approvals");
export const submitApproval = (id: string, decision: string) =>
  apiFetch<{ status: string }>(`/api/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });

// Tools
export const getTools = () => apiFetch<ToolInfo[]>("/api/tools");

// Plugins
export const getPlugins = () => apiFetch<Array<{ id: string; status: string; manifest: Record<string, unknown> }>>("/api/plugins");

// Schedules
export const getSchedules = () => apiFetch<Schedule[]>("/api/schedules");
export const createSchedule = (schedule: Partial<Schedule>) =>
  apiFetch<Schedule>("/api/schedules", { method: "POST", body: JSON.stringify(schedule) });
export const deleteSchedule = (id: string) =>
  apiFetch<void>(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });

// Health
export const getHealth = () => apiFetch<HealthStatus>("/api/health");

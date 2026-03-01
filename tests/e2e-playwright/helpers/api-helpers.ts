/**
 * REST helper wrappers for creating test data against the API server.
 */

const API_BASE = "http://localhost:3199";
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 1000;

export class ApiHelper {
  private base: string;

  constructor(base = API_BASE) {
    this.base = base;
  }

  private async fetch<T>(path: string, opts?: RequestInit): Promise<T> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const res = await fetch(`${this.base}${path}`, {
        headers: { "Content-Type": "application/json", ...opts?.headers },
        ...opts,
      });
      if (res.status === 429) {
        // Rate limited — back off and retry
        await new Promise((r) =>
          setTimeout(r, RETRY_DELAY_MS * (attempt + 1)),
        );
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${body}`);
      }
      return res.json() as Promise<T>;
    }
    throw new Error(`API rate limited after ${MAX_RETRIES} retries on ${path}`);
  }

  /** Create a session and wait for it to finish. Returns session_id. */
  async createSession(taskText = "Playwright test task"): Promise<string> {
    const { session_id } = await this.fetch<{ session_id: string }>(
      "/api/sessions",
      {
        method: "POST",
        body: JSON.stringify({ text: taskText }),
      },
    );

    // Poll until session completes (MockPlanner is fast)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const { status } = await this.fetch<{ status: string }>(
          `/api/sessions/${session_id}`,
        );
        if (status === "completed" || status === "failed") break;
      } catch {
        // Session might not be queryable yet
      }
    }

    return session_id;
  }

  /** Get list of sessions. */
  async getSessions(): Promise<
    Array<{ session_id: string; status: string; task_text?: string }>
  > {
    const res = await this.fetch<{
      sessions: Array<{
        session_id: string;
        status: string;
        task_text?: string;
      }>;
    }>("/api/sessions");
    return res.sessions;
  }

  /** Create a schedule. Returns schedule_id. */
  async createSchedule(opts?: {
    name?: string;
    taskText?: string;
    interval?: string;
  }): Promise<string> {
    const name = opts?.name ?? `pw-test-${Date.now()}`;
    const taskText = opts?.taskText ?? "Playwright schedule test";
    const interval = opts?.interval ?? "1h";

    const schedule = await this.fetch<{ schedule_id: string }>(
      "/api/schedules",
      {
        method: "POST",
        body: JSON.stringify({
          name,
          trigger: { type: "every", interval },
          action: { type: "createSession", task_text: taskText },
        }),
      },
    );
    return schedule.schedule_id;
  }

  /** Delete a schedule. */
  async deleteSchedule(id: string): Promise<void> {
    await this.fetch(`/api/schedules/${id}`, { method: "DELETE" });
  }

  /** Get list of schedules. */
  async getSchedules(): Promise<
    Array<{ schedule_id: string; name: string; status: string }>
  > {
    const res = await this.fetch<{
      schedules: Array<{ schedule_id: string; name: string; status: string }>;
    }>("/api/schedules");
    return res.schedules;
  }

  /** Get health. */
  async getHealth(): Promise<{ status: string }> {
    return this.fetch<{ status: string }>("/api/health");
  }

  /** Get tools. */
  async getTools(): Promise<Array<{ name: string }>> {
    const res = await this.fetch<{ tools: Array<{ name: string }> }>(
      "/api/tools",
    );
    return res.tools;
  }

  /** Get plugins. */
  async getPlugins(): Promise<{
    plugins: Array<{ id: string; status: string }>;
    available: Array<{ id: string; status: string }>;
  }> {
    return this.fetch("/api/plugins");
  }
}

// Pure formatting functions for the chat CLI — zero dependencies, zero side effects.

// ANSI color helpers
export const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
export const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
export const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
export const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
export const cyan = (s: string): string => `\x1b[36m${s}\x1b[0m`;
export const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;

export const MAX_OUTPUT_LEN = 4000;

export const TERMINAL_EVENTS = new Set([
  "session.completed",
  "session.failed",
  "session.aborted",
]);

// Events that are noisy/internal — suppress from chat output
const QUIET_EVENTS = new Set([
  "usage.recorded",
  "session.checkpoint",
  "tool.requested",
]);

export function chatPrompt(running: boolean): string {
  return running ? `${dim("[running]")} karnevil9> ` : "karnevil9> ";
}

export function colorForType(type: string): (s: string) => string {
  if (type.includes("completed") || type.includes("succeeded")) return green;
  if (type.includes("failed") || type.includes("error")) return red;
  if (type.includes("warning") || type.includes("abort") || type.includes("permission")) return yellow;
  return cyan;
}

export function truncate(s: string, max: number): string {
  return s.length > max
    ? s.slice(0, max) + `\n${dim(`... (${s.length} chars total)`)}`
    : s;
}

/** Extract human-readable output from a step result. */
function formatStepOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (typeof output !== "object" || output === null) return JSON.stringify(output, null, 2);
  const obj = output as Record<string, unknown>;

  // Shell exec result: { exit_code, stdout, stderr }
  if ("stdout" in obj) {
    const stdout = String(obj.stdout ?? "").trim();
    const stderr = String(obj.stderr ?? "").trim();
    let result = "";
    if (stdout) result += stdout;
    if (stderr) result += (result ? "\n" : "") + red(stderr);
    return result || dim("(no output)");
  }

  // File read result: { content, exists, size }
  if ("content" in obj && !("success" in obj)) {
    return String(obj.content ?? "");
  }

  // Browser result: { success, url?, title?, snapshot?, result?, error? }
  if ("success" in obj) {
    if (obj.success === false) {
      return red(`Error: ${String(obj.error ?? "unknown")}`);
    }
    const parts: string[] = [];
    if (obj.url) parts.push(`${dim("URL:")} ${String(obj.url)}`);
    if (obj.title) parts.push(`${dim("Title:")} ${String(obj.title)}`);
    if (obj.text) parts.push(String(obj.text));
    if (typeof obj.snapshot === "string") {
      const snap = obj.snapshot.length > 800
        ? obj.snapshot.slice(0, 800) + dim(`\n... (${obj.snapshot.length} chars)`)
        : obj.snapshot;
      parts.push(`${dim("Snapshot:")}\n${snap}`);
    }
    // Array result (e.g. extracted data)
    if (Array.isArray(obj.result)) {
      const items = obj.result as Record<string, unknown>[];
      const lines = items.map((item, i) => {
        if (item.title) {
          const rank = item.rank != null ? `${item.rank}. ` : `${i + 1}. `;
          const pts = item.points ? dim(` (${item.points})`) : "";
          return `  ${bold(rank + String(item.title))}${pts}`;
        }
        return `  ${JSON.stringify(item)}`;
      });
      parts.push(lines.join("\n"));
    } else if (obj.result != null && !Array.isArray(obj.result)) {
      parts.push(String(obj.result));
    }
    if (parts.length > 0) return parts.join("\n");
  }

  return JSON.stringify(output, null, 2);
}

export function formatEvent(_sessionId: string, event: Record<string, unknown>): string | null {
  const type = String(event.type ?? "unknown");
  const ts = typeof event.timestamp === "string"
    ? event.timestamp.split("T")[1]?.slice(0, 8) ?? ""
    : "";
  const color = colorForType(type);
  const prefix = `${dim(ts)} ${color(type)}`;
  const payload = event.payload as Record<string, unknown> | undefined;

  // Suppress noisy internal events
  if (QUIET_EVENTS.has(type)) return null;

  // ─── Session lifecycle ──────────────────────────────────────────

  if (type === "session.created" && payload) {
    const task = String(payload.task_text ?? "");
    const mode = String(payload.mode ?? "");
    return `${prefix} ${bold(task)} ${dim(`(${mode})`)}`;
  }

  if (type === "session.started") {
    return null; // redundant with session.created
  }

  if (type === "session.completed") {
    return `\n${green(bold("Session completed"))}`;
  }

  if (type === "session.failed" && payload) {
    const err = payload.error as Record<string, unknown> | undefined;
    const msg = err ? `${err.code ?? "ERROR"}: ${err.message ?? ""}` : "unknown error";
    return `\n${red(bold(`Session failed — ${msg}`))}`;
  }

  if (type === "session.aborted") {
    return `\n${yellow(bold("Session aborted"))}`;
  }

  // ─── Planner ────────────────────────────────────────────────────

  if (type === "planner.requested") {
    const iteration = payload?.iteration;
    return iteration && Number(iteration) > 1
      ? `${prefix} ${dim(`iteration ${iteration}`)}`
      : null; // first iteration is implied
  }

  if (type === "planner.plan_received" && payload) {
    const goal = String(payload.goal ?? "");
    const stepCount = payload.step_count ?? 0;
    return `${prefix} ${cyan(goal)} ${dim(`(${stepCount} steps)`)}`;
  }

  if (type === "plan.accepted" && payload) {
    const plan = payload.plan as Record<string, unknown> | undefined;
    if (plan) {
      const steps = Array.isArray(plan.steps) ? plan.steps : [];
      if (steps.length === 0) return null; // empty plan = task done
      const stepList = steps
        .map((s: unknown, i: number) => {
          const step = s as Record<string, unknown>;
          const toolRef = step.tool_ref as Record<string, unknown> | undefined;
          const toolName = String(toolRef?.name ?? step.tool ?? "?");
          const title = String(step.title ?? step.description ?? "");
          return `  ${dim(`${i + 1}.`)} ${bold(toolName)} ${dim(title)}`;
        })
        .join("\n");
      return `${prefix}\n${stepList}`;
    }
    return prefix;
  }

  if (type === "plan.replaced") {
    return null; // plan.accepted already shows the new plan
  }

  // ─── Steps ──────────────────────────────────────────────────────

  if (type === "step.started" && payload) {
    const title = String(payload.title ?? "");
    const tool = String(payload.tool ?? "");
    return `${prefix} ${bold(tool)} ${dim(title)}`;
  }

  if (type === "step.succeeded" && payload?.output != null) {
    const out = formatStepOutput(payload.output);
    return `${prefix}\n${truncate(out, MAX_OUTPUT_LEN)}`;
  }

  if (type === "step.failed" && payload?.error != null) {
    const err = payload.error as Record<string, unknown>;
    return `${prefix} ${red(`[${err.code ?? "ERROR"}]: ${err.message ?? ""}`)}`;
  }

  // ─── Tools ──────────────────────────────────────────────────────

  if (type === "tool.started" && payload) {
    const tool = String(payload.tool_name ?? "");
    const mode = String(payload.mode ?? "");
    return `${prefix} ${tool} ${dim(mode)}`;
  }

  if (type === "tool.succeeded" && payload) {
    const tool = String(payload.tool_name ?? "");
    const durationMs = payload.duration_ms;
    const dur = typeof durationMs === "number" ? `${(durationMs / 1000).toFixed(1)}s` : "";
    return `${prefix} ${tool} ${dim(dur)}`;
  }

  if (type === "tool.failed" && payload) {
    const tool = String(payload.tool_name ?? "");
    return `${prefix} ${red(tool)}`;
  }

  // ─── Permissions ────────────────────────────────────────────────

  if (type === "permission.requested" && payload) {
    const tool = String(payload.tool_name ?? "?");
    const perms = payload.permissions;
    const scopes = Array.isArray(perms)
      ? perms.map((p: unknown) => String((p as Record<string, unknown>).scope ?? "")).join(", ")
      : "";
    return `${prefix}\n${yellow(`  Tool: ${tool}`)}\n${yellow(`  Scopes: ${scopes}`)}`;
  }

  if (type === "permission.granted") {
    return null; // approval flow already shows this
  }

  // ─── Generic fallback ──────────────────────────────────────────

  if (payload && Object.keys(payload).length > 0) {
    const summary = JSON.stringify(payload);
    return `${prefix} ${dim(truncate(summary, 120))}`;
  }

  return prefix;
}

export function helpText(): string {
  return [
    bold("Commands:"),
    "  /help   — Show this help",
    "  /abort  — Abort the current session",
    "  /quit   — Exit chat",
    "",
    dim("Type any text to create a new session."),
  ].join("\n");
}

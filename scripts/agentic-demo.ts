/**
 * Full Agentic Loop Demo: showcases the KarnEvil9 kernel orchestrating
 * task → planner → permission check → tool execution → re-planning → done.
 *
 * No API key required — uses a scripted planner for deterministic, instant execution.
 *
 * Usage: npx tsx scripts/agentic-demo.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime, readFileHandler, writeFileHandler, shellExecHandler } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { Kernel } from "@karnevil9/kernel";
import type { Task, Plan, PlanResult, Planner, ToolSchemaForPlanner, JournalEvent } from "@karnevil9/schemas";
import { resolve } from "node:path";

// ─── Colors ──────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  red: "\x1b[31m",
};

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`);
}

function ts(event: JournalEvent): string {
  return event.timestamp.split("T")[1]!.slice(0, 12);
}

// ─── Color-coded journal event stream ────────────────────────────────
function colorForType(type: string): string {
  if (type.startsWith("session")) return C.cyan;
  if (type.startsWith("step")) return C.green;
  if (type.startsWith("tool")) return C.blue;
  if (type.startsWith("planner")) return C.magenta;
  if (type.startsWith("permission")) return C.yellow;
  if (type.startsWith("plan")) return C.white;
  return C.dim;
}

function formatEvent(event: JournalEvent): string {
  const color = colorForType(event.type);
  const time = `${C.dim}[${ts(event)}]${C.reset}`;
  let detail = "";
  const p = event.payload;
  if (typeof p.tool === "string" || typeof p.tool_name === "string")
    detail += ` tool=${p.tool ?? p.tool_name}`;
  if (typeof p.step_count === "number") detail += ` steps=${p.step_count}`;
  if (typeof p.iteration === "number") detail += ` iter=${p.iteration}`;
  if (typeof p.decision === "string") detail += ` decision=${p.decision}`;
  if (typeof p.status === "string" && event.type.includes("step"))
    detail += ` status=${p.status}`;
  return `  ${time} ${color}${event.type}${C.reset}${C.dim}${detail}${C.reset}`;
}

// ─── Workspace files ─────────────────────────────────────────────────
const PACKAGE_JSON = JSON.stringify({
  name: "demo-project",
  version: "1.0.0",
  description: "A sample Node.js project for code quality analysis",
  main: "index.js",
  scripts: { start: "node index.js" },
}, null, 2);

const INDEX_JS = `const http = require("http");
const { greet, add } = require("./utils");

const unusedVar = 42; // lint: unused variable

const server = http.createServer((req, res) => {
  const name = req.url.slice(1) || "world";
  res.end(greet(name));
});

server.listen(3000);
console.log("Server running on port 3000");
`;

const UTILS_JS = `function greet(name) {
  return "Hello, " + name + "!";
}

function add(a, b) {
  return a + b;
}

module.exports = { greet, add };
`;

const REPORT_CONTENT = `# Code Quality Report

## Project: demo-project v1.0.0

### Findings

1. **Unused variable** (index.js:4)
   \`const unusedVar = 42\` is declared but never used.
   Severity: warning

2. **No error handling** (index.js:7)
   The HTTP request handler does not handle errors or validate input.
   Severity: warning

3. **Missing strict mode** (index.js, utils.js)
   Neither file uses \`"use strict"\` — relying on sloppy mode.
   Severity: info

### Syntax Check
- index.js: OK (no syntax errors)
- utils.js: OK (no syntax errors)

### Summary
- Files analyzed: 3
- Issues found: 3 (0 errors, 2 warnings, 1 info)
- Overall: PASS with warnings
`;

// ─── ScriptedPlanner ─────────────────────────────────────────────────
function createScriptedPlanner(workDir: string): Planner {
  let callCount = 0;

  return {
    async generatePlan(
      _task: Task,
      _toolSchemas: ToolSchemaForPlanner[],
      _stateSnapshot: Record<string, unknown>,
      _constraints: Record<string, unknown>,
    ): Promise<PlanResult> {
      callCount++;
      const now = new Date().toISOString();

      if (callCount === 1) {
        // Iteration 1 — Discovery: read project files
        return {
          plan: {
            plan_id: uuid(),
            schema_version: "0.1",
            goal: "Read all project files to understand the codebase",
            assumptions: ["Files exist in the workspace"],
            created_at: now,
            steps: [
              {
                step_id: "read-pkg",
                title: "Read package.json",
                tool_ref: { name: "read-file" },
                input: { path: join(workDir, "package.json") },
                success_criteria: ["File content returned"],
                failure_policy: "abort",
                timeout_ms: 5000,
                max_retries: 0,
              },
              {
                step_id: "read-index",
                title: "Read index.js",
                tool_ref: { name: "read-file" },
                input: { path: join(workDir, "index.js") },
                success_criteria: ["File content returned"],
                failure_policy: "abort",
                timeout_ms: 5000,
                max_retries: 0,
                depends_on: ["read-pkg"],
              },
              {
                step_id: "read-utils",
                title: "Read utils.js",
                tool_ref: { name: "read-file" },
                input: { path: join(workDir, "utils.js") },
                success_criteria: ["File content returned"],
                failure_policy: "abort",
                timeout_ms: 5000,
                max_retries: 0,
                depends_on: ["read-pkg"],
              },
            ],
          },
        };
      }

      if (callCount === 2) {
        // Iteration 2 — Analysis: syntax check source files
        return {
          plan: {
            plan_id: uuid(),
            schema_version: "0.1",
            goal: "Syntax-check source files with node --check",
            assumptions: ["Node.js is available"],
            created_at: now,
            steps: [
              {
                step_id: "check-index",
                title: "Syntax check index.js",
                tool_ref: { name: "shell-exec" },
                input: { command: "node --check index.js", cwd: workDir },
                success_criteria: ["Exit code 0"],
                failure_policy: "continue",
                timeout_ms: 10000,
                max_retries: 0,
              },
              {
                step_id: "check-utils",
                title: "Syntax check utils.js",
                tool_ref: { name: "shell-exec" },
                input: { command: "node --check utils.js", cwd: workDir },
                success_criteria: ["Exit code 0"],
                failure_policy: "continue",
                timeout_ms: 10000,
                max_retries: 0,
              },
            ],
          },
        };
      }

      if (callCount === 3) {
        // Iteration 3 — Report: write findings
        return {
          plan: {
            plan_id: uuid(),
            schema_version: "0.1",
            goal: "Write code quality report",
            assumptions: ["Analysis is complete"],
            created_at: now,
            steps: [
              {
                step_id: "write-report",
                title: "Write report.md",
                tool_ref: { name: "write-file" },
                input: { path: join(workDir, "report.md"), content: REPORT_CONTENT },
                success_criteria: ["File written successfully"],
                failure_policy: "abort",
                timeout_ms: 5000,
                max_retries: 0,
              },
            ],
          },
        };
      }

      // Iteration 4+ — Done signal (empty steps)
      return {
        plan: {
          plan_id: uuid(),
          schema_version: "0.1",
          goal: "Analysis complete",
          assumptions: [],
          steps: [],
          created_at: now,
        },
      };
    },
  };
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}\u{1f504} KARNEVIL9 AGENTIC LOOP DEMO${C.reset}`);
  console.log(`${C.dim}${"━".repeat(50)}${C.reset}`);

  // ── Phase 1: Set up workspace ─────────────────────────────────────
  console.log(`\n${C.bold}\u{1f4c1} Setting up workspace...${C.reset}`);
  const workDir = join(tmpdir(), `karnevil9-agentic-demo-${uuid().slice(0, 8)}`);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, "package.json"), PACKAGE_JSON);
  writeFileSync(join(workDir, "index.js"), INDEX_JS);
  writeFileSync(join(workDir, "utils.js"), UTILS_JS);
  log("+", "package.json");
  log("+", "index.js  (has unused var + no error handling)");
  log("+", "utils.js");
  log(`${C.dim}*${C.reset}`, `${C.dim}${workDir}${C.reset}`);

  // ── Phase 2: Boot kernel ──────────────────────────────────────────
  console.log(`\n${C.bold}\u{2699}\u{fe0f}  Booting kernel...${C.reset}`);

  const journalPath = join(workDir, "journal.jsonl");
  const journal = new Journal(journalPath, { fsync: false, redact: false, lock: false });
  await journal.init();

  const registry = new ToolRegistry();
  await registry.loadFromDirectory(resolve("tools/examples"));

  // Permission promptFn: auto-approve with colorized output
  const permissions = new PermissionEngine(journal, async (request) => {
    for (const perm of request.permissions) {
      const scope = `${perm.domain}:${perm.action}:${perm.target}`;
      console.log(
        `  ${C.yellow}\u{1f513} PERMISSION${C.reset} ${request.tool_name} ${C.dim}${scope}${C.reset} ${C.green}→ allow_session${C.reset}`,
      );
    }
    return "allow_session";
  });

  const policy = {
    allowed_paths: [workDir],
    allowed_endpoints: [],
    allowed_commands: ["node"],
    require_approval_for_writes: false,
  };

  const runtime = new ToolRuntime(registry, permissions, journal, policy);
  runtime.registerHandler("read-file", readFileHandler);
  runtime.registerHandler("write-file", writeFileHandler);
  runtime.registerHandler("shell-exec", shellExecHandler);

  const planner = createScriptedPlanner(workDir);

  const kernel = new Kernel({
    journal,
    toolRegistry: registry,
    toolRuntime: runtime,
    permissions,
    planner,
    mode: "live",
    limits: {
      max_steps: 20,
      max_duration_ms: 30000,
      max_cost_usd: 1,
      max_tokens: 100000,
      max_iterations: 5,
    },
    policy,
    agentic: true,
    disableCritics: true,
  });

  log("*", `Mode: ${C.bold}real${C.reset} | Agentic: ${C.bold}true${C.reset} | Max iterations: ${C.bold}5${C.reset}`);

  // ── Phase 3: Run agentic loop ─────────────────────────────────────
  console.log(`\n${C.bold}\u{1f504} Running agentic loop...${C.reset}`);

  const task: Task = {
    task_id: uuid(),
    text: "Analyze this Node.js project for code quality issues",
    created_at: new Date().toISOString(),
  };

  await kernel.createSession(task);
  const session = kernel.getSession()!;
  log("*", `Session: ${C.dim}${session.session_id}${C.reset}`);
  log("*", `Task: ${C.dim}${task.text}${C.reset}`);
  console.log();

  // Subscribe to journal for live event stream
  const unsub = journal.on((event: JournalEvent) => {
    console.log(formatEvent(event));
  });

  const finalSession = await kernel.run();
  unsub();

  // ── Phase 4: Results ──────────────────────────────────────────────
  console.log(`\n${C.bold}${C.green}\u{2705} Results${C.reset}`);

  const taskState = kernel.getTaskState()!;
  const allResults = taskState.getAllStepResults();
  const succeeded = allResults.filter((r) => r.status === "succeeded").length;
  const failedCount = allResults.filter((r) => r.status === "failed").length;

  log(
    finalSession.status === "completed" ? `${C.green}OK${C.reset}` : `${C.red}!!${C.reset}`,
    `Session status: ${C.bold}${finalSession.status}${C.reset}`,
  );
  log("*", `Steps: ${C.bold}${allResults.length}${C.reset} (${succeeded} succeeded, ${failedCount} failed)`);
  log("*", `Planner iterations: ${C.bold}4${C.reset} (3 with steps, 1 done signal)`);

  // Print the generated report
  try {
    const report = readFileSync(join(workDir, "report.md"), "utf-8");
    console.log(`\n  ${C.bold}\u{1f4c4} Generated Report:${C.reset}`);
    for (const line of report.split("\n")) {
      console.log(`     ${C.dim}${line}${C.reset}`);
    }
  } catch {
    log(`${C.red}!${C.reset}`, "report.md not found");
  }

  // ── Phase 5: Cleanup ──────────────────────────────────────────────
  console.log(`${C.bold}\u{1f6d1} Cleanup${C.reset}`);
  await journal.close();
  rmSync(workDir, { recursive: true, force: true });
  log("+", "Removed temp workspace");

  console.log(`\n${C.bold}${C.green}Done!${C.reset}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n${C.red}Fatal:${C.reset}`, err);
  process.exit(1);
});

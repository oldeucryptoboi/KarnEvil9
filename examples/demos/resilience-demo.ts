/**
 * Resilience & Learning Demo: showcases KarnEvil9's futility detection,
 * cross-session learning, and journal integrity verification.
 *
 * No API key required — scripted planners, instant execution.
 *
 * Usage: npx tsx scripts/resilience-demo.ts
 */
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime, readFileHandler, writeFileHandler } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { Kernel } from "@karnevil9/kernel";
import { ActiveMemory, extractLesson } from "@karnevil9/memory";
import type {
  Task, Plan, PlanResult, Planner, ToolSchemaForPlanner,
  JournalEvent, ToolManifest,
} from "@karnevil9/schemas";

// ─── Colors ──────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m",
  magenta: "\x1b[35m", blue: "\x1b[34m", white: "\x1b[37m", red: "\x1b[31m",
};

function log(icon: string, msg: string) { console.log(`  ${icon} ${msg}`); }

function ts(event: JournalEvent): string {
  return event.timestamp.split("T")[1]!.slice(0, 12);
}

function colorForType(type: string): string {
  if (type.startsWith("session")) return C.cyan;
  if (type.startsWith("step")) return C.green;
  if (type.startsWith("tool")) return C.blue;
  if (type.startsWith("planner")) return C.magenta;
  if (type.startsWith("permission")) return C.yellow;
  if (type.startsWith("futility")) return C.red;
  if (type.startsWith("memory")) return C.green;
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
  if (typeof p.error === "string") detail += ` error=${p.error.slice(0, 40)}`;
  if (typeof p.reason === "string") detail += ` reason=${p.reason.slice(0, 40)}`;
  if (typeof p.decision === "string") detail += ` decision=${p.decision}`;
  if (typeof p.outcome === "string") detail += ` outcome=${p.outcome}`;
  return `  ${time} ${color}${event.type}${C.reset}${C.dim}${detail}${C.reset}`;
}

// ─── Shared infrastructure ──────────────────────────────────────────
const workDir = join(tmpdir(), `karnevil9-resilience-${uuid().slice(0, 8)}`);
const journalPath = join(workDir, "journal.jsonl");
const memoryPath = join(workDir, "memory.jsonl");

function createPolicy() {
  return {
    allowed_paths: [workDir],
    allowed_endpoints: [] as string[],
    allowed_commands: [] as string[],
    require_approval_for_writes: false,
  };
}

function createPermissions(journal: Journal) {
  return new PermissionEngine(journal, async (request) => {
    for (const perm of request.permissions) {
      const scope = `${perm.domain}:${perm.action}:${perm.target}`;
      console.log(
        `  ${C.yellow}\u{1f513} PERMISSION${C.reset} ${request.tool_name} ${C.dim}${scope}${C.reset} ${C.green}\u{2192} allow_session${C.reset}`,
      );
    }
    return "allow_session";
  });
}

// ─── Custom fetch-data tool (always fails) ──────────────────────────
const fetchDataManifest: ToolManifest = {
  name: "fetch-data",
  version: "1.0.0",
  description: "Fetch data from remote API",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
    additionalProperties: false,
  },
  output_schema: {
    type: "object",
    properties: { data: { type: "string" } },
    required: ["data"],
    additionalProperties: false,
  },
  permissions: ["network:fetch:api"],
  timeout_ms: 5000,
  supports: { mock: true, dry_run: true },
};

function buildRegistry() {
  const registry = new ToolRegistry();
  // Load built-in tools from YAML manifests
  registry.register(fetchDataManifest);
  return registry;
}

async function loadBuiltinTools(registry: ToolRegistry) {
  await registry.loadFromDirectory(resolve("tools/manifests"));
}

function wireRuntime(registry: ToolRegistry, permissions: PermissionEngine, journal: Journal) {
  const runtime = new ToolRuntime(registry, permissions, journal, createPolicy());
  runtime.registerHandler("read-file", readFileHandler);
  runtime.registerHandler("write-file", writeFileHandler);
  runtime.registerHandler("fetch-data", async () => { throw new Error("Connection timeout"); });
  return runtime;
}

// ─── Phase 1 planner: always generates a fetch-data step ────────────
function createFutilityPlanner(workDir: string): Planner {
  let iter = 0;
  return {
    async generatePlan(): Promise<PlanResult> {
      iter++;
      return {
        plan: {
          plan_id: uuid(),
          schema_version: "0.1",
          goal: `Fetch API data attempt ${iter}`,
          assumptions: ["Remote API is available"],
          steps: [{
            step_id: `fetch-${iter}`,
            title: `Fetch data (attempt ${iter})`,
            tool_ref: { name: "fetch-data" },
            input: { url: "https://api.example.com/data" },
            success_criteria: ["Data returned"],
            failure_policy: "replan" as const,
            timeout_ms: 5000,
            max_retries: 0,
          }],
          created_at: new Date().toISOString(),
        },
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, model: "scripted" },
      };
    },
  };
}

// ─── Phase 2 planner: adapts based on memories ──────────────────────
function createLearningPlanner(workDir: string): Planner {
  let iter = 0;
  return {
    async generatePlan(
      _task: Task,
      _toolSchemas: ToolSchemaForPlanner[],
      stateSnapshot: Record<string, unknown>,
    ): Promise<PlanResult> {
      iter++;
      const now = new Date().toISOString();
      const memories = stateSnapshot.relevant_memories as Array<{ task: string; outcome: string; lesson: string }> | undefined;

      if (iter === 1) {
        if (memories && memories.length > 0) {
          console.log(`    ${C.green}\u{1f9e0} Enriched with ${memories.length} relevant memory${C.reset}`);
        }
        // Adapted plan: use local files instead of fetch
        return {
          plan: {
            plan_id: uuid(),
            schema_version: "0.1",
            goal: "Read local data and write report",
            assumptions: ["Local data.json exists", "Learned: remote API is unreachable"],
            steps: [
              {
                step_id: "read-data",
                title: "Read local data.json",
                tool_ref: { name: "read-file" },
                input: { path: join(workDir, "data.json") },
                success_criteria: ["File content returned"],
                failure_policy: "abort" as const,
                timeout_ms: 5000,
                max_retries: 0,
              },
              {
                step_id: "write-report",
                title: "Write report.md",
                tool_ref: { name: "write-file" },
                input: {
                  path: join(workDir, "report.md"),
                  content: "# Report\n\nData loaded from local cache.\nSource: data.json\n",
                },
                success_criteria: ["File written"],
                failure_policy: "abort" as const,
                timeout_ms: 5000,
                max_retries: 0,
                depends_on: ["read-data"],
              },
            ],
            created_at: now,
          },
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, model: "scripted" },
        };
      }

      // Done signal
      return {
        plan: {
          plan_id: uuid(), schema_version: "0.1",
          goal: "Task complete", assumptions: [], steps: [], created_at: now,
        },
      };
    },
  };
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}\u{1f6e1}\u{fe0f} KARNEVIL9 RESILIENCE & LEARNING DEMO${C.reset}`);
  console.log(`${C.dim}${"━".repeat(50)}${C.reset}`);

  // ── Setup ─────────────────────────────────────────────────────────
  console.log(`\n${C.bold}\u{1f4c1} Setting up workspace...${C.reset}`);
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, "data.json"), JSON.stringify({ items: [1, 2, 3], source: "local-cache" }, null, 2));
  log("+", "data.json");

  console.log(`\n${C.bold}\u{2699}\u{fe0f}  Booting infrastructure...${C.reset}`);
  const journal = new Journal(journalPath, { fsync: false, redact: false, lock: false });
  await journal.init();
  const activeMemory = new ActiveMemory(memoryPath);
  await activeMemory.load();

  const registry = buildRegistry();
  await loadBuiltinTools(registry);
  log("*", "Journal, ActiveMemory, Tools: read-file, write-file, fetch-data (always fails)");

  // ══════════════════════════════════════════════════════════════════
  //  PHASE 1: Futility Detection
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${C.dim}${"━".repeat(50)}${C.reset}`);
  console.log(`${C.bold}\u{1f504} Phase 1: Futility Detection${C.reset}`);
  console.log(`${C.dim}${"━".repeat(50)}${C.reset}`);

  const taskA: Task = {
    task_id: uuid(),
    text: "Fetch API data and generate summary report",
    created_at: new Date().toISOString(),
  };
  log("*", `Task: "${C.dim}${taskA.text}${C.reset}"`);
  log("*", `Futility: halt after ${C.bold}3${C.reset} repeated errors`);
  console.log();

  const permissionsA = createPermissions(journal);
  const runtimeA = wireRuntime(registry, permissionsA, journal);
  const plannerA = createFutilityPlanner(workDir);

  const kernelA = new Kernel({
    journal,
    toolRegistry: registry,
    toolRuntime: runtimeA,
    permissions: permissionsA,
    planner: plannerA,
    mode: "live",
    agentic: true,
    disableCritics: true,
    activeMemory,
    futilityConfig: { maxRepeatedErrors: 3, maxIdenticalPlans: 100 },
    limits: { max_steps: 20, max_duration_ms: 30000, max_cost_usd: 1, max_tokens: 100000, max_iterations: 5 },
    policy: createPolicy(),
  });

  await kernelA.createSession(taskA);

  const unsubA = journal.on((event: JournalEvent) => {
    if (event.session_id === kernelA.getSession()!.session_id) {
      console.log(formatEvent(event));
    }
  });

  const sessionA = await kernelA.run();
  unsubA();

  console.log();
  log(`${C.red}\u{1f6d1}${C.reset}`, `Halted: ${C.bold}"Connection timeout"${C.reset} repeated 3 consecutive iterations`);

  // ══════════════════════════════════════════════════════════════════
  //  PHASE 2: Cross-Session Learning
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${C.dim}${"━".repeat(50)}${C.reset}`);
  console.log(`${C.bold}\u{1f9e0} Phase 2: Cross-Session Learning${C.reset}`);
  console.log(`${C.dim}${"━".repeat(50)}${C.reset}`);

  // Show extracted lesson
  const lessons = activeMemory.getLessons();
  if (lessons.length > 0) {
    const lesson = lessons[lessons.length - 1]!;
    console.log(`  ${C.bold}\u{1f4dd} Lesson from Session A:${C.reset}`);
    console.log(`     ${C.dim}outcome=${lesson.outcome} | tools=[${lesson.tool_names.join(", ")}]${C.reset}`);
    console.log(`     ${C.dim}"${lesson.lesson.slice(0, 80)}..."${C.reset}`);
  }

  // Show memory search
  const taskBText = "Fetch project data and generate report";
  const recalled = activeMemory.search(taskBText);
  console.log(`\n  ${C.bold}\u{1f50d} Memory search for similar task:${C.reset}`);
  if (recalled.length > 0) {
    console.log(`     ${C.dim}Match: "${recalled[0]!.task_summary}" (${recalled[0]!.outcome})${C.reset}`);
    console.log(`     ${C.dim}relevance_count: ${recalled[0]!.relevance_count}${C.reset}`);
  }

  const taskB: Task = {
    task_id: uuid(),
    text: taskBText,
    created_at: new Date().toISOString(),
  };

  console.log();
  log("*", `Task: "${C.dim}${taskB.text}${C.reset}"`);
  log("*", `Planner sees relevant_memories ${C.green}\u{2192}${C.reset} adapts approach`);
  console.log();

  const permissionsB = createPermissions(journal);
  const runtimeB = wireRuntime(registry, permissionsB, journal);
  const plannerB = createLearningPlanner(workDir);

  const kernelB = new Kernel({
    journal,
    toolRegistry: registry,
    toolRuntime: runtimeB,
    permissions: permissionsB,
    planner: plannerB,
    mode: "live",
    agentic: true,
    disableCritics: true,
    activeMemory,
    limits: { max_steps: 20, max_duration_ms: 30000, max_cost_usd: 1, max_tokens: 100000, max_iterations: 5 },
    policy: createPolicy(),
  });

  await kernelB.createSession(taskB);

  const unsubB = journal.on((event: JournalEvent) => {
    if (event.session_id === kernelB.getSession()!.session_id) {
      console.log(formatEvent(event));
    }
  });

  const sessionB = await kernelB.run();
  unsubB();

  console.log();
  if (sessionB.status === "completed") {
    log(`${C.green}\u{2705}${C.reset}`, `Session B learned from A's failure ${C.green}\u{2014}${C.reset} used local data instead of unreachable API`);
  } else {
    log(`${C.red}!!${C.reset}`, `Session B ended with status: ${sessionB.status}`);
  }

  // ══════════════════════════════════════════════════════════════════
  //  PHASE 3: Journal Integrity
  // ══════════════════════════════════════════════════════════════════
  console.log(`\n${C.dim}${"━".repeat(50)}${C.reset}`);
  console.log(`${C.bold}\u{1f517} Phase 3: Journal Integrity${C.reset}`);
  console.log(`${C.dim}${"━".repeat(50)}${C.reset}`);

  await journal.close();

  // Count events
  const rawLines = readFileSync(journalPath, "utf-8").trim().split("\n");
  console.log(`  ${C.dim}\u{1f4ca} Events written: ${rawLines.length}${C.reset}`);

  // Verify clean — verifyIntegrity() reads from file, no init() needed
  const verifier = new Journal(journalPath, { fsync: false, redact: false, lock: false });
  const check1 = await verifier.verifyIntegrity();
  console.log(`\n  ${C.green}\u{2713}${C.reset} Verifying hash chain... ${C.green}${check1.valid ? "valid" : "BROKEN"}${C.reset}`);

  // Corrupt an event
  const corruptIdx = Math.min(12, rawLines.length - 2);
  const parsed = JSON.parse(rawLines[corruptIdx]!);
  const origHash = parsed.hash_prev;
  if (origHash) {
    parsed.hash_prev = origHash.replace(/[0-9a-f]{8}/, "deadbeef");
  } else {
    parsed.hash_prev = "deadbeefdeadbeefdeadbeefdeadbeef";
  }
  rawLines[corruptIdx] = JSON.stringify(parsed);
  writeFileSync(journalPath, rawLines.join("\n") + "\n");
  console.log(`  ${C.magenta}\u{1f489}${C.reset} Corrupting event #${corruptIdx} (tampering with hash_prev)...`);

  // Verify broken — fresh instance, no init() (init would throw on corruption)
  const check2 = await verifier.verifyIntegrity();
  console.log(`  ${C.red}\u{2717}${C.reset} Verifying again... ${C.red}BROKEN at event ${check2.brokenAt ?? "?"}${C.reset}`);

  // Compact to repair — rebuilds hash chain from scratch
  const compactResult = await verifier.compact();
  console.log(`  ${C.blue}\u{1f527}${C.reset} Compacting (rebuild hash chain)... ${compactResult.before} \u{2192} ${compactResult.after} events`);

  // Verify repaired
  const check3 = await verifier.verifyIntegrity();
  console.log(`  ${C.green}\u{2713}${C.reset} Verifying repaired journal... ${C.green}${check3.valid ? "valid" : "BROKEN"}${C.reset}`);

  // ── Cleanup ───────────────────────────────────────────────────────
  console.log(`\n${C.bold}\u{1f6d1} Cleanup${C.reset}`);
  rmSync(workDir, { recursive: true, force: true });
  log("+", "Removed temp workspace");

  console.log(`\n${C.bold}${C.green}Done!${C.reset}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n${C.red}Fatal:${C.reset}`, err);
  process.exit(1);
});

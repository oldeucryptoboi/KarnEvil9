/**
 * Metrics demo: runs a real Claude session with auto-approval,
 * then prints the live metrics.
 */
import { config } from "dotenv";
config();
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v4 as uuid } from "uuid";
import Anthropic from "@anthropic-ai/sdk";
import { Journal } from "@karnevil9/journal";
import { ToolRegistry, ToolRuntime, readFileHandler } from "@karnevil9/tools";
import { PermissionEngine } from "@karnevil9/permissions";
import { Kernel } from "@karnevil9/kernel";
import { MetricsCollector } from "@karnevil9/metrics";
import { LLMPlanner } from "@karnevil9/planner";
import type { Task, UsageMetrics } from "@karnevil9/schemas";

async function main() {
  // 1. Setup infrastructure
  const journalPath = join(tmpdir(), `karnevil9-demo-${uuid().slice(0, 8)}.jsonl`);
  const journal = new Journal(journalPath, { fsync: false, redact: false });
  await journal.init();

  const registry = new ToolRegistry();
  await registry.loadFromDirectory(resolve("tools/manifests"));

  const permissions = new PermissionEngine(journal, async () => "allow_session");

  const policy = {
    allowed_paths: [process.cwd()],
    allowed_endpoints: [],
    allowed_commands: [],
    require_approval_for_writes: false,
  };
  const runtime = new ToolRuntime(registry, permissions, journal, policy);
  runtime.registerHandler("read-file", readFileHandler);

  // 2. Setup metrics collector
  const metrics = new MetricsCollector({ collectDefault: false });
  metrics.attach(journal);

  // 3. Setup Claude planner
  const model = "claude-sonnet-4-5-20250929";
  const client = new Anthropic.default();

  const callModel = async (systemPrompt: string, userPrompt: string) => {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    // Compute cost from Anthropic pricing (Sonnet: $3/MTok input, $15/MTok output)
    const inputCost = (response.usage.input_tokens / 1_000_000) * 3;
    const outputCost = (response.usage.output_tokens / 1_000_000) * 15;
    return {
      text,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
        model,
        cost_usd: inputCost + outputCost,
      } satisfies UsageMetrics,
    };
  };

  const planner = new LLMPlanner(callModel);

  // 4. Create and run
  const task: Task = {
    task_id: uuid(),
    text: "Read the file package.json in the current directory and tell me the project name",
    created_at: new Date().toISOString(),
  };

  console.log("Creating session with Claude planner...\n");

  const kernel = new Kernel({
    journal,
    toolRuntime: runtime,
    toolRegistry: registry,
    permissions,
    planner,
    mode: "live",
    limits: { max_steps: 5, max_duration_ms: 60000, max_cost_usd: 1, max_tokens: 50000 },
    policy,
  });

  const session = await kernel.createSession(task);
  console.log(`Session: ${session.session_id}`);
  console.log(`Status:  ${session.status}\n`);

  await kernel.run();

  const finalSession = kernel.getSession();
  console.log(`\nFinal status: ${finalSession.status}\n`);

  // 5. Print journal timeline
  const events = await journal.readSession(session.session_id);
  console.log("=== EVENT TIMELINE ===\n");
  for (const e of events) {
    const ts = e.timestamp.split("T")[1]?.slice(0, 12) ?? "";
    let extra = "";
    const p = e.payload;
    if (typeof p.tool_name === "string") extra = ` tool=${p.tool_name}`;
    else if (p.tool_ref && typeof (p.tool_ref as Record<string,unknown>).name === "string") extra = ` tool=${(p.tool_ref as Record<string,unknown>).name}`;
    if (e.type === "usage.recorded") extra = ` model=${p.model ?? "?"} in=${p.input_tokens} out=${p.output_tokens}`;
    if (typeof p.duration_ms === "number") extra += ` ${p.duration_ms}ms`;
    console.log(`  [${ts}] ${e.type}${extra}`);
  }

  // 6. Print metrics
  console.log("\n=== PROMETHEUS METRICS ===\n");
  const output = await metrics.getMetrics();
  const lines = output.split("\n").filter(l =>
    l.startsWith("karnevil9_") &&
    !l.startsWith("# ") &&
    !l.includes("_bucket{") &&
    !l.includes("_created ")
  );
  for (const line of lines) {
    console.log(`  ${line}`);
  }

  metrics.detach();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

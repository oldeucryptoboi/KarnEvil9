/**
 * Swarm Demo: spins up 3 in-process KarnEvil9 nodes, demonstrates
 * peer discovery, task delegation across the mesh, and result aggregation.
 *
 * Usage: npx tsx scripts/swarm-demo.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import express from "express";
import { v4 as uuid } from "uuid";
import { Journal } from "@karnevil9/journal";
import {
  MeshManager,
  WorkDistributor,
  ResultAggregator,
  createSwarmRoutes,
  DEFAULT_SWARM_CONFIG,
  type SwarmConfig,
  type SwarmTaskRequest,
  type SwarmRoute,
} from "@karnevil9/swarm";

// ─── Helpers ──────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
};

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`);
}

function header(title: string) {
  console.log(`\n${C.bold}${C.cyan}${title}${C.reset}`);
  console.log(`${C.dim}${"━".repeat(50)}${C.reset}`);
}

function ts(): string {
  return new Date().toISOString().split("T")[1]!.slice(0, 12);
}

// ─── Bridge: SwarmRoute RouteHandler → Express ────────────────────────
function mountSwarmRoutes(app: express.Express, routes: SwarmRoute[]) {
  for (const route of routes) {
    const method = route.method.toLowerCase() as "get" | "post";
    app[method](`/api${route.path}`, async (req: express.Request, res: express.Response) => {
      try {
        await route.handler(
          {
            method: req.method,
            path: req.path,
            params: (req.params ?? {}) as Record<string, string>,
            query: (req.query ?? {}) as Record<string, string>,
            body: req.body,
          },
          {
            json: (data: unknown) => { res.json(data); },
            text: (data: string, ct?: string) => {
              if (ct) res.type(ct);
              res.send(data);
            },
            status: (code: number) => ({
              json: (data: unknown) => { res.status(code).json(data); },
              text: (data: string, ct?: string) => {
                if (ct) res.type(ct);
                res.status(code).send(data);
              },
            }),
          },
        );
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });
  }
}

// ─── Node Setup ───────────────────────────────────────────────────────
interface DemoNode {
  name: string;
  port: number;
  color: string;
  journal: Journal;
  journalEvents: import("@karnevil9/schemas").JournalEvent[];
  mesh: MeshManager;
  distributor?: WorkDistributor;
  aggregator?: ResultAggregator;
  app: express.Express;
  server: http.Server;
}

async function createNode(
  name: string,
  port: number,
  color: string,
  opts: { isCoordinator?: boolean } = {},
): Promise<DemoNode> {
  const journalPath = join(tmpdir(), `karnevil9-swarm-demo-${name.toLowerCase()}-${uuid().slice(0, 8)}.jsonl`);
  const journal = new Journal(journalPath, { fsync: false, redact: false, lock: false });
  await journal.init();

  // Capture events in memory via listener (more reliable than file reads for demo timing)
  const capturedEvents: import("@karnevil9/schemas").JournalEvent[] = [];
  journal.on((event) => capturedEvents.push(event));

  const config: SwarmConfig = {
    ...DEFAULT_SWARM_CONFIG,
    enabled: true,
    api_url: `http://localhost:${port}`,
    capabilities: ["analysis", "security-review", "code-audit"],
    node_name: name,
    mdns: false,
    gossip: false,
    seeds: [],
    heartbeat_interval_ms: 2000,
    sweep_interval_ms: 5000,
    suspected_after_ms: 10000,
    unreachable_after_ms: 20000,
    evict_after_ms: 60000,
    delegation_timeout_ms: 15000,
  };

  const mesh = new MeshManager({
    config,
    journal,
    onTaskRequest: async (request: SwarmTaskRequest) => {
      // Accept immediately, do work asynchronously (so the HTTP response
      // returns before the result is posted — giving the originator time
      // to register the ActiveDelegation).
      const doWork = async () => {
        const delay = 200 + Math.random() * 300;
        const startTime = Date.now();

        log(
          `${color}⚙${C.reset}`,
          `${color}[${name}]${C.reset} ${C.dim}working on "${request.task_text.slice(0, 45)}..."${C.reset}`,
        );

        await sleep(delay);

        const tokens = 150 + Math.floor(Math.random() * 400);
        const duration = Date.now() - startTime;

        // POST result back to the originator
        const transport = mesh.getTransport();
        const originPeer = mesh.getPeers().find(
          (p) => p.identity.node_id === request.originator_node_id,
        );
        if (originPeer) {
          await transport.sendTaskResult(originPeer.identity.api_url, {
            task_id: request.task_id,
            peer_node_id: mesh.getIdentity().node_id,
            peer_session_id: `sim-${uuid().slice(0, 8)}`,
            status: "completed",
            findings: [
              {
                step_title: `Analyzed: ${request.task_text.slice(0, 50)}`,
                tool_name: "security-analysis",
                status: "succeeded",
                summary: `${name} completed subtask in ${duration}ms`,
              },
            ],
            tokens_used: tokens,
            cost_usd: +(tokens * 0.000015).toFixed(6),
            duration_ms: duration,
          });
        }

        log(
          `${color}✓${C.reset}`,
          `${color}[${name}]${C.reset} done in ${C.bold}${duration}ms${C.reset} (${tokens} tokens)`,
        );
      };

      // Fire-and-forget the async work
      void doWork();
      return { accepted: true };
    },
  });

  let distributor: WorkDistributor | undefined;
  let aggregator: ResultAggregator | undefined;

  if (opts.isCoordinator) {
    distributor = new WorkDistributor({
      meshManager: mesh,
      strategy: "round_robin",
      delegation_timeout_ms: config.delegation_timeout_ms,
      max_retries: 2,
    });
    aggregator = new ResultAggregator();
  }

  const app = express();
  app.use(express.json());
  mountSwarmRoutes(app, createSwarmRoutes(mesh, distributor));

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });

  return { name, port, color, journal, journalEvents: capturedEvents, mesh, distributor, aggregator, app, server };
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}🌐 KARNEVIL9 SWARM DEMO${C.reset}`);
  console.log(`${C.dim}${"━".repeat(50)}${C.reset}`);

  // ── Phase 1: Boot Nodes ────────────────────────────────────────────
  header("📡 Booting nodes...");

  const alpha = await createNode("Alpha", 3200, C.green, { isCoordinator: true });
  const beta = await createNode("Beta", 3201, C.yellow);
  const gamma = await createNode("Gamma", 3202, C.magenta);
  const nodes = [alpha, beta, gamma];

  for (const n of nodes) {
    const id = n.mesh.getIdentity().node_id.slice(0, 6);
    log(`${n.color}✓${C.reset}`, `${n.color}${n.name}${C.reset} (port ${n.port}) — ${C.dim}${id}${C.reset}`);
  }

  // ── Phase 2: Form Mesh ─────────────────────────────────────────────
  header("🔗 Forming mesh...");

  // Start all mesh managers (disables mDNS/gossip/seeds so start() is fast)
  await Promise.all(nodes.map((n) => n.mesh.start()));

  // Bidirectional joins
  const pairs: [DemoNode, DemoNode][] = [
    [alpha, beta],
    [alpha, gamma],
    [beta, gamma],
  ];
  for (const [a, b] of pairs) {
    a.mesh.handleJoin(b.mesh.getIdentity());
    b.mesh.handleJoin(a.mesh.getIdentity());
    log(
      `${C.blue}↔${C.reset}`,
      `${a.color}${a.name}${C.reset} ←→ ${b.color}${b.name}${C.reset}`,
    );
  }

  await sleep(200);

  for (const n of nodes) {
    const active = n.mesh.getActivePeers().length;
    log(
      `${C.dim}•${C.reset}`,
      `${n.color}${n.name}${C.reset}: ${active} active peers`,
    );
  }
  log(`${C.green}✓${C.reset}`, `${C.bold}Mesh formed: ${nodes.length} nodes, all connected${C.reset}`);

  // ── Phase 3: Distribute Tasks ──────────────────────────────────────
  header("📋 Distributing subtasks across mesh...");

  const tasks = [
    "Analyze authentication flow and identify security risks in login handlers",
    "Review database queries for N+1 problems and SQL injection vulnerabilities",
    "Audit error handling for information leakage and stack trace exposure",
  ];

  const sessionId = `demo-${uuid().slice(0, 8)}`;
  log(`${C.dim}•${C.reset}`, `Session: ${C.dim}${sessionId}${C.reset}`);
  console.log();

  const distributor = alpha.distributor!;
  const startTime = Date.now();
  const promises = tasks.map((t) => distributor.distribute(t, sessionId));
  const results = await Promise.all(promises);
  const totalTime = Date.now() - startTime;

  // Let any in-flight async worker logs flush before showing results
  await sleep(100);

  // ── Phase 4: Show Results ──────────────────────────────────────────
  header("✅ Results");

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const peerName = nodes.find(
      (n) => n.mesh.getIdentity().node_id === r.peer_node_id,
    )?.name ?? r.peer_node_id.slice(0, 6);
    const peerColor = nodes.find(
      (n) => n.mesh.getIdentity().node_id === r.peer_node_id,
    )?.color ?? C.white;
    const finding = r.findings[0];
    log(
      `${C.green}${i + 1}.${C.reset}`,
      `${peerColor}[${peerName}]${C.reset} ${finding?.summary ?? "done"} ${C.dim}(${r.duration_ms}ms, ${r.tokens_used} tokens, $${r.cost_usd.toFixed(4)})${C.reset}`,
    );
  }

  const totalTokens = results.reduce((s, r) => s + r.tokens_used, 0);
  const totalCost = results.reduce((s, r) => s + r.cost_usd, 0);
  console.log();
  log(
    `${C.bold}📊${C.reset}`,
    `${C.bold}${results.length} subtasks completed in ${totalTime}ms${C.reset} — ${totalTokens} tokens, $${totalCost.toFixed(4)} total`,
  );

  // ── Phase 5: Journal Timeline ──────────────────────────────────────
  header("📜 Journal Events (Alpha)");

  // Small delay to let fire-and-forget journal writes complete
  await sleep(200);

  const events = alpha.journalEvents;
  for (const e of events) {
    let detail = "";
    const p = e.payload;
    if (typeof p.peer_name === "string") detail = ` peer=${p.peer_name}`;
    else if (typeof p.peer_node_id === "string") {
      const name = nodes.find(
        (n) => n.mesh.getIdentity().node_id === p.peer_node_id,
      )?.name;
      if (name) detail = ` peer=${name}`;
    }
    if (typeof p.task_id === "string") detail += ` task=${(p.task_id as string).slice(0, 8)}`;
    if (typeof p.duration_ms === "number") detail += ` ${p.duration_ms}ms`;
    if (typeof p.tokens_used === "number") detail += ` ${p.tokens_used}tok`;
    log(
      `${C.dim}${ts()}${C.reset}`,
      `${C.cyan}${e.type}${C.reset}${C.dim}${detail}${C.reset}`,
    );
  }

  // ── Phase 6: Shutdown ──────────────────────────────────────────────
  header("🛑 Shutting down...");

  for (const n of nodes) {
    distributor?.cancelAll?.();
    await n.mesh.stop();
    await new Promise<void>((resolve) => n.server.close(() => resolve()));
    await n.journal.close();
    log(`${n.color}✓${C.reset}`, `${n.color}${n.name}${C.reset} stopped`);
  }

  console.log(`\n${C.bold}${C.green}Done!${C.reset}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n${C.red}Fatal:${C.reset}`, err);
  process.exit(1);
});

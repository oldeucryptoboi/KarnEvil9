/**
 * Seven Dwarfs Debate: 7 KarnEvil9 swarm nodes — each embodying a Disney
 * dwarf personality — debate a topic autonomously. An 8th "moderator" node
 * drives the conversation by selecting who speaks next and detecting when
 * the debate reaches a natural conclusion.  Real Claude API calls power
 * every response.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/seven-dwarfs.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/seven-dwarfs.ts --model claude-haiku-4-5-20251001
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/seven-dwarfs.ts --topic "Should we go on strike?"
 */
import "dotenv/config";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import http from "node:http";
import express from "express";
import { v4 as uuid } from "uuid";
import Anthropic from "@anthropic-ai/sdk";
import { Journal } from "@karnevil9/journal";
import {
  MeshManager,
  createSwarmRoutes,
  DEFAULT_SWARM_CONFIG,
  type SwarmConfig,
  type SwarmTaskRequest,
  type SwarmTaskResult,
  type SwarmRoute,
} from "@karnevil9/swarm";

// ─── CLI Args ────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    model: { type: "string", default: "claude-sonnet-4-5-20250929" },
    topic: {
      type: "string",
      default: "Snow White has just arrived at our cottage. Should we let her stay?",
    },
  },
});
const MODEL = args.model!;
const TOPIC = args.topic!;

// ─── Anthropic Client ────────────────────────────────────────────────
const anthropic = new Anthropic();

async function callClaude(system: string, user: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 256,
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = response.content[0];
  return block?.type === "text" ? block.text : "";
}

// ─── Colors / Helpers ────────────────────────────────────────────────
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
  dimWhite: "\x1b[2;37m",
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Dwarf Definitions ──────────────────────────────────────────────
interface Dwarf {
  name: string;
  emoji: string;
  color: string;
  port: number;
  systemPrompt: string;
}

const DWARFS: Dwarf[] = [
  {
    name: "Doc",
    emoji: "🤓",
    color: C.cyan,
    port: 3201,
    systemPrompt:
      "You are Doc, the leader of the seven dwarfs. You try to keep order and sound knowledgeable, but you sometimes fumble your words or mix up phrases. You speak with authority but occasionally stumble over big words. Keep your response to 2-3 sentences max.",
  },
  {
    name: "Grumpy",
    emoji: "😠",
    color: C.red,
    port: 3202,
    systemPrompt:
      "You are Grumpy, the cantankerous dwarf. You are cynical, contrarian, and love to complain — but occasionally you make sharp, valid points that no one else considers. You grumble and protest but deep down you care. Keep your response to 2-3 sentences max.",
  },
  {
    name: "Happy",
    emoji: "😊",
    color: C.green,
    port: 3203,
    systemPrompt:
      "You are Happy, the relentlessly cheerful dwarf. You see the bright side of absolutely everything and are wildly enthusiastic about every idea. You laugh often and use exclamation marks generously. Keep your response to 2-3 sentences max.",
  },
  {
    name: "Sleepy",
    emoji: "😴",
    color: C.dimWhite,
    port: 3204,
    systemPrompt:
      "You are Sleepy, the perpetually drowsy dwarf. You *yawn* mid-sentence, sometimes trail off or lose your train of thought, and occasionally doze off before finishing a point. Despite this, when awake you're reasonable. Keep your response to 2-3 sentences max.",
  },
  {
    name: "Bashful",
    emoji: "😳",
    color: C.magenta,
    port: 3205,
    systemPrompt:
      "You are Bashful, the shy and hesitant dwarf. You blush easily, agree with others too readily, and are very self-deprecating. You often start sentences with 'Well, um...' or 'I guess maybe...' and trail off nervously. Keep your response to 2-3 sentences max.",
  },
  {
    name: "Sneezy",
    emoji: "🤧",
    color: C.yellow,
    port: 3206,
    systemPrompt:
      "You are Sneezy, the allergy-plagued dwarf. You get interrupted by sneezes mid-word (written as ACHOO!), but between sneezes you actually have solid, well-reasoned opinions. Your sneezes break up your sentences in comical ways. Keep your response to 2-3 sentences max.",
  },
  {
    name: "Dopey",
    emoji: "🤪",
    color: C.blue,
    port: 3207,
    systemPrompt:
      "You are Dopey, the youngest and simplest dwarf. You speak in very short, simple sentences. Your observations are innocent and childlike but occasionally accidentally profound. You don't use big words. Keep your response to 1-2 sentences max.",
  },
];

const MODERATOR_PORT = 3200;
const MAX_TURNS = 30;
const SESSION_ID = `debate-${uuid().slice(0, 8)}`;

// ─── Bridge: SwarmRoute → Express ────────────────────────────────────
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

// ─── Node Creation ───────────────────────────────────────────────────
interface DwarfNode {
  name: string;
  mesh: MeshManager;
  server: http.Server;
  journal: Journal;
}

function makeSwarmConfig(name: string, port: number): SwarmConfig {
  return {
    ...DEFAULT_SWARM_CONFIG,
    enabled: true,
    api_url: `http://localhost:${port}`,
    capabilities: ["conversation"],
    node_name: name,
    mdns: false,
    gossip: false,
    seeds: [],
    heartbeat_interval_ms: 5000,
    sweep_interval_ms: 10000,
    suspected_after_ms: 30000,
    unreachable_after_ms: 60000,
    evict_after_ms: 120000,
    delegation_timeout_ms: 60000,
  };
}

async function createDwarfNode(dwarf: Dwarf, journal: Journal): Promise<DwarfNode> {
  const config = makeSwarmConfig(dwarf.name, dwarf.port);
  const mesh = new MeshManager({
    config,
    journal,
    onTaskRequest: async (request: SwarmTaskRequest) => {
      void (async () => {
        try {
          const response = await callClaude(dwarf.systemPrompt, request.task_text);
          const originPeer = mesh.getPeers().find(
            (p) => p.identity.node_id === request.originator_node_id,
          );
          if (originPeer) {
            const transport = mesh.getTransport();
            await transport.sendTaskResult(originPeer.identity.api_url, {
              task_id: request.task_id,
              peer_node_id: mesh.getIdentity().node_id,
              peer_session_id: SESSION_ID,
              status: "completed",
              findings: [{
                step_title: dwarf.name,
                tool_name: "speak",
                status: "succeeded",
                summary: response,
              }],
              tokens_used: 0,
              cost_usd: 0,
              duration_ms: 0,
            });
          }
        } catch (err) {
          console.error(`  ${C.red}✗${C.reset} ${dwarf.name} error: ${err}`);
        }
      })();
      return { accepted: true };
    },
  });

  const app = express();
  app.use(express.json());
  mountSwarmRoutes(app, createSwarmRoutes(mesh));

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(dwarf.port, () => resolve(s));
  });

  return { name: dwarf.name, mesh, server, journal };
}

interface ModeratorNode {
  mesh: MeshManager;
  server: http.Server;
  journal: Journal;
  askDwarf: (nodeId: string, prompt: string) => Promise<string>;
}

async function createModeratorNode(journal: Journal): Promise<ModeratorNode> {
  const pending = new Map<string, (r: SwarmTaskResult) => void>();
  const config = makeSwarmConfig("Moderator", MODERATOR_PORT);

  const mesh = new MeshManager({
    config,
    journal,
    onTaskResult: (result) => {
      const resolver = pending.get(result.task_id);
      if (resolver) {
        resolver(result);
        pending.delete(result.task_id);
      }
    },
  });

  const app = express();
  app.use(express.json());
  mountSwarmRoutes(app, createSwarmRoutes(mesh));

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(MODERATOR_PORT, () => resolve(s));
  });

  async function askDwarf(nodeId: string, prompt: string): Promise<string> {
    const { accepted, taskId, reason } = await mesh.delegateTask(nodeId, prompt, SESSION_ID);
    if (!accepted) {
      throw new Error(`Delegation rejected: ${reason}`);
    }
    const result = await new Promise<SwarmTaskResult>((resolve, reject) => {
      pending.set(taskId, resolve);
      setTimeout(() => {
        if (pending.has(taskId)) {
          pending.delete(taskId);
          reject(new Error(`Timeout waiting for ${taskId}`));
        }
      }, 60000);
    });
    return result.findings[0]?.summary ?? "";
  }

  return { mesh, server, journal, askDwarf };
}

// ─── Moderator Logic ─────────────────────────────────────────────────
const MODERATOR_SYSTEM = `You are moderating a lively debate among the seven dwarfs: Doc, Grumpy, Happy, Sleepy, Bashful, Sneezy, Dopey. They are debating a topic in character.

Your job:
1. Pick who should respond next based on what was just said. Consider who would naturally react to the last statement.
2. Avoid having the same dwarf speak twice in a row.
3. When the conversation has reached a natural conclusion (consensus, impasse, or the topic is exhausted after at least 8 exchanges), set done to true.

Output ONLY valid JSON, no markdown fences: { "next": "Name", "done": false }`;

interface ModeratorDecision {
  next: string;
  done: boolean;
}

async function getNextSpeaker(transcript: string): Promise<ModeratorDecision> {
  const raw = await callClaude(MODERATOR_SYSTEM, transcript);
  try {
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned) as ModeratorDecision;
  } catch {
    return { next: "Doc", done: false };
  }
}

// ─── Display Helpers ─────────────────────────────────────────────────
function printResponse(dwarf: Dwarf, text: string) {
  const nameCol = `${dwarf.color}${dwarf.emoji} ${dwarf.name}:${C.reset}`;
  const padded = text.replace(/\n/g, `\n${" ".repeat(14)}`);
  console.log(`  ${nameCol.padEnd(24)} ${padded}`);
  console.log();
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  // Validate API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(`${C.red}Error:${C.reset} ANTHROPIC_API_KEY environment variable is required.`);
    process.exit(1);
  }

  console.log(`\n${C.bold}⛏️  THE SEVEN DWARFS DEBATE${C.reset}`);
  console.log(`${C.dim}${"━".repeat(50)}${C.reset}`);

  // ── Boot nodes ─────────────────────────────────────────────────────
  console.log(`\n${C.bold}🌐 Starting 8 swarm nodes (7 dwarfs + moderator)...${C.reset}`);

  const journalPath = join(tmpdir(), `karnevil9-dwarfs-${uuid().slice(0, 8)}.jsonl`);
  const journal = new Journal(journalPath, { fsync: false, redact: false, lock: false });
  await journal.init();

  const moderator = await createModeratorNode(journal);
  const dwarfNodes: DwarfNode[] = [];
  for (const dwarf of DWARFS) {
    dwarfNodes.push(await createDwarfNode(dwarf, journal));
  }

  const dwarfList = DWARFS.map((d) => `${d.name} (${d.port})`).join(", ");
  console.log(`  ✓ ${dwarfList}, Moderator (${MODERATOR_PORT})`);

  // ── Form mesh ──────────────────────────────────────────────────────
  await moderator.mesh.start();
  await Promise.all(dwarfNodes.map((n) => n.mesh.start()));

  // Bidirectional joins: moderator ↔ each dwarf, and dwarfs ↔ dwarfs
  for (const node of dwarfNodes) {
    moderator.mesh.handleJoin(node.mesh.getIdentity());
    node.mesh.handleJoin(moderator.mesh.getIdentity());
  }
  for (let i = 0; i < dwarfNodes.length; i++) {
    for (let j = i + 1; j < dwarfNodes.length; j++) {
      dwarfNodes[i]!.mesh.handleJoin(dwarfNodes[j]!.mesh.getIdentity());
      dwarfNodes[j]!.mesh.handleJoin(dwarfNodes[i]!.mesh.getIdentity());
    }
  }

  await sleep(200);
  const peerCount = moderator.mesh.getActivePeers().length + 1;
  console.log(`  ✓ Mesh formed: ${peerCount} peers connected`);

  // ── Build nodeId→dwarf map ─────────────────────────────────────────
  const nodeIdToDwarf = new Map<string, Dwarf>();
  const nameToNodeId = new Map<string, string>();
  for (let i = 0; i < DWARFS.length; i++) {
    const dwarf = DWARFS[i]!;
    const nodeId = dwarfNodes[i]!.mesh.getIdentity().node_id;
    nodeIdToDwarf.set(nodeId, dwarf);
    nameToNodeId.set(dwarf.name, nodeId);
  }

  // ── Print topic ────────────────────────────────────────────────────
  console.log(`\n${C.bold}📋 Topic:${C.reset} "${TOPIC}"`);
  console.log(`${C.dim}${"━".repeat(50)}${C.reset}\n`);

  // ── Conversation loop ──────────────────────────────────────────────
  const history: Array<{ name: string; text: string }> = [];
  let turns = 0;

  function buildTranscript(): string {
    let t = `Topic: "${TOPIC}"\n\n`;
    for (const entry of history) {
      t += `${entry.name}: ${entry.text}\n\n`;
    }
    return t;
  }

  function buildDwarfPrompt(dwarfName: string): string {
    let prompt = `The dwarfs are debating: "${TOPIC}"\n\nConversation so far:\n`;
    for (const entry of history) {
      prompt += `${entry.name}: ${entry.text}\n`;
    }
    prompt += `\nNow respond in character as ${dwarfName}. Stay in character, react to what others have said, and keep it to 2-3 sentences.`;
    return prompt;
  }

  // Doc always opens
  const docNodeId = nameToNodeId.get("Doc")!;
  const docDwarf = DWARFS.find((d) => d.name === "Doc")!;
  const openingPrompt = `The dwarfs are debating: "${TOPIC}"\n\nYou are opening the discussion. Set the stage and share your initial thoughts as Doc. Stay in character and keep it to 2-3 sentences.`;
  const openingResponse = await moderator.askDwarf(docNodeId, openingPrompt);
  history.push({ name: "Doc", text: openingResponse });
  printResponse(docDwarf, openingResponse);
  turns++;

  // Main loop
  while (turns < MAX_TURNS) {
    const decision = await getNextSpeaker(buildTranscript());

    if (decision.done) {
      break;
    }

    const nextName = decision.next;
    const nextNodeId = nameToNodeId.get(nextName);
    const nextDwarf = DWARFS.find((d) => d.name === nextName);

    if (!nextNodeId || !nextDwarf) {
      // If moderator hallucinated a name, default to a random dwarf
      const fallback = DWARFS[Math.floor(Math.random() * DWARFS.length)]!;
      const fbNodeId = nameToNodeId.get(fallback.name)!;
      const response = await moderator.askDwarf(fbNodeId, buildDwarfPrompt(fallback.name));
      history.push({ name: fallback.name, text: response });
      printResponse(fallback, response);
      turns++;
      continue;
    }

    const response = await moderator.askDwarf(nextNodeId, buildDwarfPrompt(nextName));
    history.push({ name: nextName, text: response });
    printResponse(nextDwarf, response);
    turns++;
  }

  // ── Conclusion ─────────────────────────────────────────────────────
  console.log(`${C.dim}${"━".repeat(50)}${C.reset}`);
  console.log(`\n${C.bold}🏁 Debate concluded after ${turns} turns.${C.reset}`);

  // ── Shutdown ───────────────────────────────────────────────────────
  console.log(`\n${C.dim}🛑 Shutting down swarm mesh...${C.reset}`);

  for (const node of dwarfNodes) {
    await node.mesh.stop();
    await new Promise<void>((resolve) => node.server.close(() => resolve()));
  }
  await moderator.mesh.stop();
  await new Promise<void>((resolve) => moderator.server.close(() => resolve()));
  await journal.close();

  console.log(`${C.bold}${C.green}Done!${C.reset}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n${C.red}Fatal:${C.reset}`, err);
  process.exit(1);
});

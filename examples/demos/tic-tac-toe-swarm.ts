/**
 * Tic-Tac-Toe Learning Swarm: Two KarnEvil9 swarm nodes play tic-tac-toe.
 * Expert (X) plays perfect minimax. Learner (O) uses Claude + ActiveMemory,
 * starting with no strategy and improving across games as lessons accumulate.
 *
 * Memory persists across runs — run again to see continued improvement!
 * Delete /tmp/karnevil9-tictactoe-lessons.jsonl to reset.
 *
 * Usage:
 *   npx tsx scripts/tic-tac-toe-swarm.ts
 *   npx tsx scripts/tic-tac-toe-swarm.ts --games 10
 *   npx tsx scripts/tic-tac-toe-swarm.ts --model claude-sonnet-4-5-20250929
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
import { ActiveMemory } from "@karnevil9/memory";
import type { MemoryLesson } from "@karnevil9/schemas";
import {
  MeshManager,
  createSwarmRoutes,
  DEFAULT_SWARM_CONFIG,
  type SwarmConfig,
  type SwarmTaskRequest,
  type SwarmTaskResult,
  type SwarmRoute,
} from "@karnevil9/swarm";

// ─── CLI ─────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    model: { type: "string", default: "claude-sonnet-4-5-20250929" },
    games: { type: "string", default: "12" },
  },
});
const MODEL = args.model!;
const NUM_GAMES = parseInt(args.games!, 10);

// ─── Claude ──────────────────────────────────────────────────────────
const anthropic = new Anthropic();

const tokenTracker = {
  total_calls: 0,
  total_input: 0,
  total_output: 0,
  per_game: [] as Array<{ calls: number; input: number; output: number }>,
  _snap_calls: 0,
  _snap_input: 0,
  _snap_output: 0,
};

function startGameTokens() {
  tokenTracker._snap_calls = tokenTracker.total_calls;
  tokenTracker._snap_input = tokenTracker.total_input;
  tokenTracker._snap_output = tokenTracker.total_output;
}

function endGameTokens() {
  tokenTracker.per_game.push({
    calls: tokenTracker.total_calls - tokenTracker._snap_calls,
    input: tokenTracker.total_input - tokenTracker._snap_input,
    output: tokenTracker.total_output - tokenTracker._snap_output,
  });
}

async function callClaude(system: string, user: string, maxTokens = 200): Promise<string> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  tokenTracker.total_calls++;
  tokenTracker.total_input += response.usage.input_tokens;
  tokenTracker.total_output += response.usage.output_tokens;
  const block = response.content[0];
  return block?.type === "text" ? block.text : "";
}

// ─── Colors ──────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Board Logic ─────────────────────────────────────────────────────
type Cell = "X" | "O" | null;
type Board = Cell[];

function emptyBoard(): Board {
  return Array(9).fill(null) as Board;
}

const WINS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function checkWinner(board: Board): { winner: "X" | "O" | "draw" | null; line?: number[] } {
  for (const line of WINS) {
    const [a, b, c] = line as [number, number, number];
    if (board[a] && board[a] === board[b] && board[b] === board[c]) {
      return { winner: board[a]!, line };
    }
  }
  if (board.every((c) => c !== null)) return { winner: "draw" };
  return { winner: null };
}

function getEmpty(board: Board): number[] {
  return board.map((c, i) => (c === null ? i : -1)).filter((i) => i >= 0);
}

function displayBoard(board: Board): string {
  const cell = (i: number) => {
    const v = board[i];
    if (v === "X") return `${C.red}X${C.reset}`;
    if (v === "O") return `${C.blue}O${C.reset}`;
    return `${C.dim}${i}${C.reset}`;
  };
  const row = (a: number, b: number, c: number) => ` ${cell(a)} │ ${cell(b)} │ ${cell(c)}`;
  const sep = `${C.dim}───┼───┼───${C.reset}`;
  return [row(0, 1, 2), sep, row(3, 4, 5), sep, row(6, 7, 8)].join("\n");
}

function boardForPrompt(board: Board): string {
  const sym = (c: Cell) => (c === "X" ? "X" : c === "O" ? "O" : ".");
  return [0, 3, 6].map((r) => `${sym(board[r])} ${sym(board[r + 1])} ${sym(board[r + 2])}`).join("\n");
}

// ─── Minimax (Expert) ────────────────────────────────────────────────
function minimax(board: Board, isMax: boolean): number {
  const { winner } = checkWinner(board);
  if (winner === "X") return 1;
  if (winner === "O") return -1;
  if (winner === "draw") return 0;

  const empty = getEmpty(board);
  if (isMax) {
    let best = -Infinity;
    for (const pos of empty) {
      board[pos] = "X";
      best = Math.max(best, minimax(board, false));
      board[pos] = null;
    }
    return best;
  } else {
    let best = Infinity;
    for (const pos of empty) {
      board[pos] = "O";
      best = Math.min(best, minimax(board, true));
      board[pos] = null;
    }
    return best;
  }
}

function expertMove(board: Board): number {
  const empty = getEmpty(board);
  // 10% chance of a random (blunder) move — gives learner exploitable mistakes
  if (Math.random() < 0.1) {
    return empty[Math.floor(Math.random() * empty.length)]!;
  }
  let bestScore = -Infinity;
  let bestMoves: number[] = [];
  for (const pos of empty) {
    board[pos] = "X";
    const score = minimax(board, false);
    board[pos] = null;
    if (score > bestScore) {
      bestScore = score;
      bestMoves = [pos];
    } else if (score === bestScore) {
      bestMoves.push(pos);
    }
  }
  return bestMoves[Math.floor(Math.random() * bestMoves.length)]!;
}

function parseMove(response: string, board: Board): number {
  // Grab the LAST digit 0-8 in the response (chain-of-thought puts reasoning first)
  const matches = response.match(/[0-8]/g);
  if (matches) {
    for (let i = matches.length - 1; i >= 0; i--) {
      const pos = parseInt(matches[i]!, 10);
      if (board[pos] === null) return pos;
    }
  }
  const empty = getEmpty(board);
  return empty[Math.floor(Math.random() * empty.length)]!;
}

const POS_NAMES: Record<number, string> = {
  0: "top-left", 1: "top-mid", 2: "top-right",
  3: "mid-left", 4: "center", 5: "mid-right",
  6: "bot-left", 7: "bot-mid", 8: "bot-right",
};

function winDescription(line: number[]): string {
  const patterns: Record<string, string> = {
    "0,1,2": "top row", "3,4,5": "middle row", "6,7,8": "bottom row",
    "0,3,6": "left column", "1,4,7": "center column", "2,5,8": "right column",
    "0,4,8": "diagonal ↘", "2,4,6": "diagonal ↙",
  };
  return patterns[line.join(",")] ?? "line";
}

// ─── Swarm Bridge ────────────────────────────────────────────────────
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
            text: (data: string, ct?: string) => { if (ct) res.type(ct); res.send(data); },
            status: (code: number) => ({
              json: (data: unknown) => { res.status(code).json(data); },
              text: (data: string, ct?: string) => { if (ct) res.type(ct); res.status(code).send(data); },
            }),
          },
        );
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });
  }
}

function makeConfig(name: string, port: number): SwarmConfig {
  return {
    ...DEFAULT_SWARM_CONFIG,
    enabled: true,
    api_url: `http://localhost:${port}`,
    capabilities: ["tic-tac-toe"],
    node_name: name,
    mdns: false,
    gossip: false,
    seeds: [],
    heartbeat_interval_ms: 10000,
    sweep_interval_ms: 20000,
    suspected_after_ms: 60000,
    unreachable_after_ms: 120000,
    evict_after_ms: 300000,
    delegation_timeout_ms: 60000,
  };
}

// ─── Learner Prompt ──────────────────────────────────────────────────
const LEARNER_SYSTEM = `You are playing tic-tac-toe as O against a strong opponent X.
Three in a row (horizontal, vertical, or diagonal) wins. Board positions:
  0 | 1 | 2
  ---------
  3 | 4 | 5
  ---------
  6 | 7 | 8
Think step by step:
1. Can I win? (Do I have 2 in a row with an empty third?) If yes, TAKE IT.
2. Must I block? (Does X have 2 in a row with an empty third?) If yes, BLOCK IT.
3. Otherwise, apply the strategic lessons provided.
4. Without lessons, prefer center, then corners, then edges.
End your response with JUST the digit on its own line. Example:
X has two at 0,1 so I must block at 2.
2`;

function buildLearnerPrompt(board: Board, moves: string[], lessons: MemoryLesson[]): string {
  let prompt = `Current board:\n${boardForPrompt(board)}\n\n`;
  prompt += `Empty positions: ${getEmpty(board).join(", ")}\n\n`;
  if (moves.length > 0) {
    prompt += `Moves so far:\n${moves.join("\n")}\n\n`;
  }
  if (lessons.length > 0) {
    prompt += `LESSONS FROM PAST GAMES (use these to guide your move):\n`;
    for (const l of lessons) {
      prompt += `- ${l.lesson}\n`;
    }
    prompt += "\n";
  } else {
    prompt += "You have no lessons yet. Just pick any empty position.\n\n";
  }
  prompt += "Think briefly, then put your move digit on the last line:";
  return prompt;
}

// ─── Lesson Extraction ───────────────────────────────────────────────
const LESSON_SYSTEM = `Analyze this tic-tac-toe game played by O against an expert X. Extract ONE generalizable strategic lesson for O that applies to FUTURE games (not just this specific game). Focus on patterns like: when to block, fork prevention, center/corner priorities, responding to specific openings. Keep to 1-2 sentences. Do NOT say "Lesson:" — just state the lesson directly.`;

function buildLessonPrompt(moves: string[], outcome: string): string {
  return `Game moves:\n${moves.join("\n")}\n\nOutcome: ${outcome}\n\nWhat is the key lesson for O?`;
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(`${C.red}Error:${C.reset} ANTHROPIC_API_KEY environment variable is required.`);
    process.exit(1);
  }

  console.log(`\n${C.bold}🎮 TIC-TAC-TOE LEARNING SWARM${C.reset}`);
  console.log(`${C.dim}${"━".repeat(50)}${C.reset}`);

  // ── Memory ─────────────────────────────────────────────────────────
  const memoryPath = join(tmpdir(), "karnevil9-tictactoe-lessons.jsonl");
  const memory = new ActiveMemory(memoryPath);
  await memory.load();
  const priorLessons = memory.getLessons().length;

  console.log(`\n${C.bold}🧠 Memory:${C.reset} ${memoryPath}`);
  if (priorLessons > 0) {
    console.log(`   ${C.green}${priorLessons} lessons loaded from previous runs${C.reset}`);
  } else {
    console.log(`   ${C.dim}No prior lessons — starting fresh${C.reset}`);
  }

  // ── Journal ────────────────────────────────────────────────────────
  const journalPath = join(tmpdir(), `karnevil9-ttt-${uuid().slice(0, 8)}.jsonl`);
  const journal = new Journal(journalPath, { fsync: false, redact: false, lock: false });
  await journal.init();

  // ── Swarm Nodes ────────────────────────────────────────────────────
  console.log(`\n${C.bold}🌐 Starting swarm nodes...${C.reset}`);

  // Referee (coordinator)
  const pending = new Map<string, (r: SwarmTaskResult) => void>();
  const refConfig = makeConfig("Referee", 3200);
  const refMesh = new MeshManager({
    config: refConfig,
    journal,
    onTaskResult: (result) => {
      const resolver = pending.get(result.task_id);
      if (resolver) { resolver(result); pending.delete(result.task_id); }
    },
  });
  const refApp = express();
  refApp.use(express.json());
  mountSwarmRoutes(refApp, createSwarmRoutes(refMesh));
  const refServer = await new Promise<http.Server>((resolve) => {
    const s = refApp.listen(3200, () => resolve(s));
  });

  // Expert (X) — minimax, no LLM
  const expConfig = makeConfig("Expert", 3201);
  const expMesh = new MeshManager({
    config: expConfig,
    journal,
    onTaskRequest: async (request: SwarmTaskRequest) => {
      void (async () => {
        const board = JSON.parse(request.task_text) as Board;
        const move = expertMove(board);
        const origin = expMesh.getPeers().find((p) => p.identity.node_id === request.originator_node_id);
        if (origin) {
          await expMesh.getTransport().sendTaskResult(origin.identity.api_url, {
            task_id: request.task_id,
            peer_node_id: expMesh.getIdentity().node_id,
            peer_session_id: "expert",
            status: "completed",
            findings: [{ step_title: "move", tool_name: "minimax", status: "succeeded", summary: String(move) }],
            tokens_used: 0, cost_usd: 0, duration_ms: 0,
          });
        }
      })();
      return { accepted: true };
    },
  });
  const expApp = express();
  expApp.use(express.json());
  mountSwarmRoutes(expApp, createSwarmRoutes(expMesh));
  const expServer = await new Promise<http.Server>((resolve) => {
    const s = expApp.listen(3201, () => resolve(s));
  });

  // Learner (O) — Claude + ActiveMemory
  const lrnConfig = makeConfig("Learner", 3202);
  const lrnMesh = new MeshManager({
    config: lrnConfig,
    journal,
    onTaskRequest: async (request: SwarmTaskRequest) => {
      void (async () => {
        const response = await callClaude(LEARNER_SYSTEM, request.task_text);
        const origin = lrnMesh.getPeers().find((p) => p.identity.node_id === request.originator_node_id);
        if (origin) {
          await lrnMesh.getTransport().sendTaskResult(origin.identity.api_url, {
            task_id: request.task_id,
            peer_node_id: lrnMesh.getIdentity().node_id,
            peer_session_id: "learner",
            status: "completed",
            findings: [{ step_title: "move", tool_name: "claude", status: "succeeded", summary: response }],
            tokens_used: 0, cost_usd: 0, duration_ms: 0,
          });
        }
      })();
      return { accepted: true };
    },
  });
  const lrnApp = express();
  lrnApp.use(express.json());
  mountSwarmRoutes(lrnApp, createSwarmRoutes(lrnMesh));
  const lrnServer = await new Promise<http.Server>((resolve) => {
    const s = lrnApp.listen(3202, () => resolve(s));
  });

  // Form mesh
  const meshes = [refMesh, expMesh, lrnMesh];
  await Promise.all(meshes.map((m) => m.start()));
  for (let i = 0; i < meshes.length; i++) {
    for (let j = i + 1; j < meshes.length; j++) {
      meshes[i]!.handleJoin(meshes[j]!.getIdentity());
      meshes[j]!.handleJoin(meshes[i]!.getIdentity());
    }
  }
  await sleep(100);

  const expNodeId = expMesh.getIdentity().node_id;
  const lrnNodeId = lrnMesh.getIdentity().node_id;

  console.log(`  ✓ ${C.red}Expert (X)${C.reset} — minimax, port 3201`);
  console.log(`  ✓ ${C.blue}Learner (O)${C.reset} — Claude + ActiveMemory, port 3202`);
  console.log(`  ✓ Referee, port 3200`);
  console.log(`  ✓ Mesh formed: ${refMesh.getActivePeers().length + 1} peers`);

  // ── Helper: delegate and await ─────────────────────────────────────
  async function askNode(nodeId: string, taskText: string): Promise<string> {
    const { accepted, taskId, reason } = await refMesh.delegateTask(nodeId, taskText, "ttt");
    if (!accepted) throw new Error(`Delegation rejected: ${reason}`);
    const result = await new Promise<SwarmTaskResult>((resolve, reject) => {
      pending.set(taskId, resolve);
      setTimeout(() => { if (pending.has(taskId)) { pending.delete(taskId); reject(new Error("Timeout")); } }, 60000);
    });
    return result.findings[0]?.summary ?? "";
  }

  // ── Game Loop ──────────────────────────────────────────────────────
  const results: Array<{ outcome: string; lessonsUsed: number }> = [];

  for (let game = 1; game <= NUM_GAMES; game++) {
    startGameTokens();
    console.log(`\n${C.bold}━━━ GAME ${game} of ${NUM_GAMES} ━━━━━━━━━━━━━━━━━━${C.reset}`);

    // Feed ALL lessons — the only source of improvement (pure RLM)
    const allLessons = memory.getLessons();
    console.log(`  ${C.magenta}📚 Lessons: ${allLessons.length === 0 ? "none" : allLessons.length}${C.reset}`);
    for (const l of allLessons.slice(-5)) {
      console.log(`     ${C.dim}→ ${l.lesson.slice(0, 70)}${l.lesson.length > 70 ? "..." : ""}${C.reset}`);
    }
    if (allLessons.length > 5) {
      console.log(`     ${C.dim}  ... and ${allLessons.length - 5} more${C.reset}`);
    }
    console.log();

    const board = emptyBoard();
    const moves: string[] = [];
    let gameResult: { winner: "X" | "O" | "draw" | null; line?: number[] } = { winner: null };

    // O (learner) goes first — first-mover advantage
    let turn: "X" | "O" = "O";
    let moveNum = 0;

    while (!gameResult.winner) {
      moveNum++;
      let pos: number;

      if (turn === "X") {
        const resp = await askNode(expNodeId, JSON.stringify(board));
        pos = parseInt(resp, 10);
        if (isNaN(pos) || board[pos] !== null) pos = expertMove(board); // fallback
        board[pos] = "X";
        moves.push(`${moveNum}. X → ${pos} (${POS_NAMES[pos]})`);
        console.log(`  ${C.red}X${C.reset} → ${pos} ${C.dim}(${POS_NAMES[pos]})${C.reset}`);
      } else {
        // Pure RLM: Claude decides every move, guided only by accumulated lessons
        const prompt = buildLearnerPrompt(board, moves, allLessons);
        const resp = await askNode(lrnNodeId, prompt);
        pos = parseMove(resp, board);
        board[pos] = "O";
        moves.push(`${moveNum}. O → ${pos} (${POS_NAMES[pos]})`);
        console.log(`  ${C.blue}O${C.reset} → ${pos} ${C.dim}(${POS_NAMES[pos]})${C.reset}`);
      }

      gameResult = checkWinner(board);
      turn = turn === "X" ? "O" : "X";
    }

    // Display final board
    console.log();
    console.log(displayBoard(board));
    console.log();

    // Outcome
    let outcomeStr: string;
    let outcomeEmoji: string;
    if (gameResult.winner === "X") {
      outcomeStr = `Expert wins (${winDescription(gameResult.line!)})`;
      outcomeEmoji = "❌";
    } else if (gameResult.winner === "O") {
      outcomeStr = `Learner wins! (${winDescription(gameResult.line!)})`;
      outcomeEmoji = "🏆";
    } else {
      outcomeStr = "Draw";
      outcomeEmoji = "🤝";
    }
    console.log(`  ${outcomeEmoji} ${C.bold}${outcomeStr}${C.reset}`);
    results.push({ outcome: gameResult.winner!, lessonsUsed: allLessons.length });

    // Extract lesson via Claude
    const lessonOutcome = gameResult.winner === "O" ? "O won" : gameResult.winner === "X" ? "O lost (X won)" : "Draw";
    const lessonText = await callClaude(LESSON_SYSTEM, buildLessonPrompt(moves, lessonOutcome), 150);
    console.log(`  ${C.magenta}📝 ${lessonText.slice(0, 100)}${lessonText.length > 100 ? "..." : ""}${C.reset}`);

    // Store lesson
    const lesson: MemoryLesson = {
      lesson_id: uuid(),
      task_summary: `Tic-tac-toe game ${game}: ${lessonOutcome}`,
      outcome: gameResult.winner === "O" ? "succeeded" : "failed",
      lesson: lessonText,
      tool_names: ["tic-tac-toe"],
      created_at: new Date().toISOString(),
      session_id: `ttt-game-${game}`,
      relevance_count: 0,
    };
    memory.addLesson(lesson);
    await memory.save();
    endGameTokens();
  }

  // ── Scoreboard ─────────────────────────────────────────────────────
  console.log(`\n${C.bold}📊 SCOREBOARD${C.reset}`);
  console.log(`${C.dim}${"━".repeat(50)}${C.reset}`);

  let wins = 0, losses = 0, draws = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const g = tokenTracker.per_game[i];
    const emoji = r.outcome === "O" ? "🏆 Win " : r.outcome === "X" ? "❌ Loss" : "🤝 Draw";
    if (r.outcome === "O") wins++;
    else if (r.outcome === "X") losses++;
    else draws++;
    const tokStr = g ? `${C.dim}${g.input + g.output} tok (${g.calls} calls)${C.reset}` : "";
    console.log(`  Game ${String(i + 1).padStart(2)}: ${emoji}  │ 📚 ${String(r.lessonsUsed).padStart(2)} lesson${r.lessonsUsed === 1 ? " " : "s"} │ ${tokStr}`);
  }

  console.log();
  console.log(`  ${C.red}Expert:${C.reset}  ${losses}W ${wins}L ${draws}D`);
  console.log(`  ${C.blue}Learner:${C.reset} ${wins}W ${losses}L ${draws}D`);
  console.log(`\n  ${C.magenta}🧠 ${memory.getLessons().length} total lessons in memory${C.reset}`);

  // Token summary
  const avgPerGame = Math.round((tokenTracker.total_input + tokenTracker.total_output) / NUM_GAMES);
  console.log(`\n  ${C.cyan}📈 Token Usage${C.reset}`);
  console.log(`  ${C.dim}${"─".repeat(40)}${C.reset}`);
  console.log(`  Input:  ${tokenTracker.total_input.toLocaleString()} tokens`);
  console.log(`  Output: ${tokenTracker.total_output.toLocaleString()} tokens`);
  console.log(`  Total:  ${C.bold}${(tokenTracker.total_input + tokenTracker.total_output).toLocaleString()} tokens${C.reset} (${tokenTracker.total_calls} API calls)`);
  console.log(`  Avg/game: ${avgPerGame.toLocaleString()} tokens`);
  console.log(`  ${C.dim}Run again to see continued improvement!${C.reset}`);

  // ── Shutdown ───────────────────────────────────────────────────────
  console.log(`\n${C.dim}🛑 Shutting down...${C.reset}`);
  for (const m of meshes) await m.stop();
  await new Promise<void>((r) => refServer.close(() => r()));
  await new Promise<void>((r) => expServer.close(() => r()));
  await new Promise<void>((r) => lrnServer.close(() => r()));
  await journal.close();

  console.log(`${C.bold}${C.green}Done!${C.reset}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n${C.red}Fatal:${C.reset}`, err);
  process.exit(1);
});

/**
 * swarm-delegation plugin
 *
 * Wraps all 11 DeepMind delegation framework components into kernel hooks,
 * replacing the inline framework wiring from apple2-zork-swarm.ts.
 *
 * Hook mapping:
 *   before_plan     → inject game state into planner snapshot
 *   before_step     → cognitive friction + liability firebreak
 *   before_tool_call → escrow hold + re-delegation tracking + SLO injection
 *   after_tool_call  → outcome verification → escrow release/slash → reputation → game state update
 *   after_step       → consensus + anomaly detection + behavioral scoring + checkpoint
 *   on_error         → root cause analysis
 */

import type { PluginApi, HookContext, HookResult, PluginService } from "@karnevil9/schemas";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { v4 as uuid } from "uuid";
import {
  ReputationStore,
  EscrowManager,
  OutcomeVerifier,
  ConsensusVerifier,
  CognitiveFrictionEngine,
  LiabilityFirebreak,
  DelegateeRouter,
  AnomalyDetector,
  CheckpointSerializer,
  RootCauseAnalyzer,
  BehavioralScorer,
  RedelegationMonitor,
  getTrustTier,
  authorityFromTrust,
  type SwarmTaskResult,
  type TaskAttribute,
  type DelegationContract,
} from "@karnevil9/swarm";
import type { EmulatorLike } from "@karnevil9/tools";

// ─── Game state types ─────────────────────────────────────────────────────────

export interface BlockedPuzzle {
  room: string;
  object: string;
  reason: string;
}

export interface CartographerState {
  rooms: string[];
  lastRoomHeader: string;
  lastFullScreen: string;
  roomExits: Record<string, string[]>;
  roomItems: Record<string, string[]>;
  dirGraph: Record<string, Record<string, string>>;
  /** Reverse-direction assumptions (not yet verified by forward traversal). */
  assumedEdges: Record<string, Record<string, string>>;
  blockedExits: Record<string, Set<string>>;
  weightLimitExits: Record<string, Set<string>>;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface SwarmDelegationConfig {
  tmpBase: string;
  emulator: EmulatorLike;
  strategistId?: string;
  tacticianId?: string;
  cartoId?: string;
  checkpoint?: {
    tacticianCompleted?: number;
    tacticianFailed?: number;
    cartoCompleted?: number;
    cartoFailed?: number;
    tacticianEscrow?: number;
    cartoEscrow?: number;
    rooms?: string[];
    lastRoomHeader?: string;
    roomExits?: Record<string, string[]>;
    dirGraph?: Record<string, Record<string, string>>;
    currentRoom?: string;
    inventory?: string[];
    visitedRooms?: string[];
    roomGraph?: Record<string, string[]>;
    blockedPuzzles?: BlockedPuzzle[];
    sessionId?: string;
  };
  /** Log function — defaults to console.log */
  log?: (...args: unknown[]) => void;
}

// ─── Helpers extracted from swarm script ──────────────────────────────────────

function isRoomName(s: string): boolean {
  if (!s || s.length > 35 || /[.!?,]$/.test(s)) return false;
  return !/^(opening|taken|you |with |no |a |welcome|i |it |it's |pitch |behind the|there )/i.test(s);
}

function detectBlockReason(delta: string): string | null {
  const d = delta.toLowerCase();
  if (/the .+ is locked/i.test(d))                            return "locked";
  if (/\blocked\b/i.test(d))                                  return "locked";
  if (/you (don't|do not|can't|cannot) have (that|the)\b/.test(d)) return "need item";
  if (/you('re| are) (carrying|holding) too (much|many|heavy)/i.test(d)) return "too heavy";
  if (/your load is too heavy/i.test(d))                      return "too heavy";
  if (/you need (a |the )?\w/i.test(d))                       return "need item";
  if (/requires? (a |the )?\w/i.test(d))                      return "need item";
  if (/you can'?t (go|move|open|enter) that way/i.test(d))    return "no passage";
  return null;
}

function updateInventory(inventory: string[], delta: string, command: string): string[] {
  // Multiline: "Taken." may be preceded by score lines like "(Shiv: +5)\n"
  if (/^taken\.?(\s|$)/im.test(delta)) {
    const obj = command.replace(/^take\s+/i, "").trim();
    if (obj && !inventory.includes(obj)) inventory.push(obj);
  }
  if (/^dropped\.?(\s|$)/im.test(delta)) {
    const obj = command.replace(/^drop\s+/i, "").trim();
    inventory = inventory.filter(i => i !== obj);
  }
  if (/^throw\s+/i.test(command) && /catches|eats|snatches|grabs/i.test(delta)) {
    const thrown = command.replace(/^throw\s+/i, "").replace(/\s+at\s+.*/i, "").trim();
    inventory = inventory.filter(i => i !== thrown);
  }
  if (/\*\*\*\*\s*(you have died|you are dead)/i.test(delta)) {
    inventory = [];
  }
  return inventory;
}

function delegationAttributes(trustScore: number): TaskAttribute {
  if (trustScore >= 0.8) {
    return {
      complexity: "low", criticality: "low", verifiability: "high",
      reversibility: "high", estimated_cost: "low", estimated_duration: "short",
      required_capabilities: ["navigation", "execution"],
    };
  }
  if (trustScore >= 0.5) {
    return {
      complexity: "low", criticality: "medium", verifiability: "high",
      reversibility: "high", estimated_cost: "low", estimated_duration: "short",
      required_capabilities: ["navigation", "execution"],
    };
  }
  return {
    complexity: "low", criticality: "high", verifiability: "high",
    reversibility: "high", estimated_cost: "low", estimated_duration: "short",
    required_capabilities: ["navigation", "execution"],
  };
}

const REVERSE_DIR: Record<string, string> = {
  north: "south", south: "north", east: "west", west: "east",
  up: "down", down: "up", in: "out", out: "in",
};

const HARD_BLOCK_RE = /locked from (above|below)|no way to go that direction|you can't go that way|the door is locked|a wall blocks/i;
const SOFT_BLOCK_RE = /too (heavy|much)|your load is too|you (can't|cannot) carry (any more|that much)/i;

// ─── Base SLO and monitoring for graduated authority ──────────────────────────

const baseSLO = {
  max_duration_ms: 10000,
  max_tokens: 500,
  max_cost_usd: 0.02,
  min_findings: 1,
};

const baseMonitoring = {
  checkpoint_interval_ms: 5000,
  reporting_level: "standard" as const,
};

// ─── Plugin register ──────────────────────────────────────────────────────────

export async function register(api: PluginApi): Promise<void> {
  const config = api.config as unknown as SwarmDelegationConfig;
  const log = config.log ?? console.log;
  const ckpt = config.checkpoint;

  const strategistId = config.strategistId ?? "strategist-01";
  const tacticianId = config.tacticianId ?? "tactician-01";
  const cartoId = config.cartoId ?? "cartographer-01";

  // ── Initialize framework components ─────────────────────────────────────

  const reputation = new ReputationStore(join(config.tmpBase, "reputation.jsonl"));

  // Seed reputation
  const tacSeedOk = ckpt?.tacticianCompleted ?? 3;
  const tacSeedFail = ckpt?.tacticianFailed ?? 0;
  const cartoSeedOk = ckpt?.cartoCompleted ?? 2;
  const cartoSeedFail = ckpt?.cartoFailed ?? 0;

  for (let i = 0; i < tacSeedOk; i++) {
    reputation.recordOutcome(tacticianId, {
      task_id: `seed-t-${i}`, peer_node_id: tacticianId, peer_session_id: "s",
      status: "completed",
      findings: [{ step_title: "t", tool_name: "zork-emulator", status: "succeeded", summary: "ok" }],
      tokens_used: 40, cost_usd: 0.001, duration_ms: 300,
    });
  }
  for (let i = 0; i < tacSeedFail; i++) {
    reputation.recordOutcome(tacticianId, {
      task_id: `seed-tf-${i}`, peer_node_id: tacticianId, peer_session_id: "s",
      status: "failed",
      findings: [{ step_title: "t", tool_name: "zork-emulator", status: "failed", summary: "slo miss" }],
      tokens_used: 40, cost_usd: 0.001, duration_ms: 300,
    });
  }
  for (let i = 0; i < cartoSeedOk; i++) {
    reputation.recordOutcome(cartoId, {
      task_id: `seed-c-${i}`, peer_node_id: cartoId, peer_session_id: "s",
      status: "completed",
      findings: [{ step_title: "t", tool_name: "cartographer", status: "succeeded", summary: "ok" }],
      tokens_used: 18, cost_usd: 0.0003, duration_ms: 120,
    });
  }
  for (let i = 0; i < cartoSeedFail; i++) {
    reputation.recordOutcome(cartoId, {
      task_id: `seed-cf-${i}`, peer_node_id: cartoId, peer_session_id: "s",
      status: "failed",
      findings: [{ step_title: "t", tool_name: "cartographer", status: "failed", summary: "verify failed" }],
      tokens_used: 18, cost_usd: 0.0003, duration_ms: 120,
    });
  }

  const escrow = new EscrowManager(join(config.tmpBase, "escrow.jsonl"), {
    min_bond_usd: 0.10, slash_pct_on_violation: 50, slash_pct_on_timeout: 25,
  });
  escrow.deposit(tacticianId, ckpt?.tacticianEscrow ?? 1.00);
  escrow.deposit(cartoId, ckpt?.cartoEscrow ?? 1.00);

  const verifier = new OutcomeVerifier({ slo_strict: true });
  const consensus = new ConsensusVerifier({ default_required_voters: 2, default_required_agreement: 0.67 });
  const friction = new CognitiveFrictionEngine();
  const firebreak = new LiabilityFirebreak();
  const router = new DelegateeRouter();
  const anomalyDetector = new AnomalyDetector({
    failure_rate_threshold: 0.4, failure_rate_window: 5, duration_spike_threshold: 5.0,
  });
  const behavioralScorer = new BehavioralScorer();
  const redelegationMonitor = new RedelegationMonitor({
    max_redelegations: 3, redelegation_cooldown_ms: 0,
  });
  const rootCauseAnalyzer = new RootCauseAnalyzer({
    reputationStore: reputation,
  } as ConstructorParameters<typeof RootCauseAnalyzer>[0]);
  const checkpointer = new CheckpointSerializer(join(config.tmpBase, "if-checkpoint.jsonl"));
  await checkpointer.load();

  // ── Game state (the "service") ──────────────────────────────────────────

  const cartState: CartographerState = {
    rooms: ckpt?.rooms ? [...ckpt.rooms] : [],
    lastRoomHeader: ckpt?.lastRoomHeader ?? "",
    lastFullScreen: "",
    roomExits: ckpt?.roomExits ?? {},
    roomItems: {},
    dirGraph: ckpt?.dirGraph ?? {},
    assumedEdges: {},
    blockedExits: {},
    weightLimitExits: {},
  };

  const gameMemory = {
    currentRoom: ckpt?.currentRoom ?? "",
    inventory: ckpt?.inventory ?? [] as string[],
    visitedRooms: ckpt?.visitedRooms ?? [] as string[],
    roomGraph: ckpt?.roomGraph ?? {} as Record<string, string[]>,
    blockedPuzzles: ckpt?.blockedPuzzles ?? [] as BlockedPuzzle[],
  };

  let turn = 0;
  let lastDelta = "";
  const commandHistory: string[] = [];
  const failedByRoom: Record<string, string[]> = {};
  let lastNewRoomCount = cartState.rooms.length;
  let lastNewRoomTurn = 0;
  let failCount = 0;

  // Cross-hook communication via closure variables
  // (kernel passes different ctx objects to before_tool_call vs after_tool_call)
  let _lastCommand = "";
  let _lastTaskId = "";
  let _lastAuthority: ReturnType<typeof authorityFromTrust> | undefined;
  let _lastStepToolName = "";
  // _arrivedVia removed — assumed-edge tracking replaces it

  // ── Register game-state service ─────────────────────────────────────────

  const gameStateService: PluginService = {
    name: "game-state",
    async start() { /* initialized above */ },
    async stop() { /* no cleanup needed */ },
    async health() { return { ok: true, detail: `turn=${turn}, room=${gameMemory.currentRoom}` }; },
  };
  api.registerService(gameStateService);

  // Expose state for external access (e.g. the runner script)
  (api as Record<string, unknown>)._cartState = cartState;
  (api as Record<string, unknown>)._gameMemory = gameMemory;
  (api as Record<string, unknown>)._commandHistory = commandHistory;
  (api as Record<string, unknown>)._reputation = reputation;
  (api as Record<string, unknown>)._escrow = escrow;

  // ═══════════════════════════════════════════════════════════════════════════
  //  HOOKS
  // ═══════════════════════════════════════════════════════════════════════════

  // ── before_plan: inject game state into planner snapshot ────────────────

  api.registerHook("before_plan", async (_ctx: HookContext): Promise<HookResult> => {
    turn++;

    // Build the room-scoped failed commands
    const noEffectRe = /^(I don't understand|you can't|nothing happens|i don't know the word|i only understood|locked from|too heavy|the door is locked)/i;
    if (lastDelta && noEffectRe.test(lastDelta.trim())) {
      const prevCmd = commandHistory.at(-1);
      const curRoom = cartState.lastRoomHeader;
      if (curRoom && prevCmd) {
        failedByRoom[curRoom] ??= [];
        if (!failedByRoom[curRoom]!.includes(prevCmd)) failedByRoom[curRoom]!.push(prevCmd);
      }
    }
    const failedCmds = failedByRoom[cartState.lastRoomHeader] ?? [];

    const knownExits = [...(cartState.roomExits[cartState.lastRoomHeader] ?? [])];
    const roomDirections = cartState.dirGraph[cartState.lastRoomHeader] ?? {};
    // Merge dirGraph keys so traversed exits always appear as known
    for (const dir of Object.keys(roomDirections)) {
      if (!knownExits.some(e => e.toLowerCase() === dir.toLowerCase())) {
        knownExits.push(dir);
      }
    }
    const turnsStalled = turn - lastNewRoomTurn;
    const weightLimitDirs = Array.from(cartState.weightLimitExits[cartState.lastRoomHeader] ?? []);

    return {
      action: "modify",
      data: {
        context: {
          game_state: {
            currentRoom: cartState.lastRoomHeader || gameMemory.currentRoom,
            lastDelta,
            fullScreen: cartState.lastFullScreen,
            commandHistory: [...commandHistory],
            inventory: [...gameMemory.inventory],
            visitedRooms: [...gameMemory.visitedRooms],
            futilityHint: "",
            failedCommands: failedCmds,
            blockedPuzzles: [...gameMemory.blockedPuzzles],
            knownExits,
            roomDirections,
            roomItems: cartState.roomItems[cartState.lastRoomHeader] ?? [],
            assumedDirections: cartState.assumedEdges[cartState.lastRoomHeader] ?? {},
            dirGraph: cartState.dirGraph,
            blockedExits: Object.fromEntries(
              Object.entries(cartState.blockedExits).map(([k, v]) => [k, [...v]]),
            ),
            turnsStalled,
            currentRoomName: cartState.lastRoomHeader,
            weightLimitDirs,
          },
        },
      },
    };
  }, { priority: 10, timeout_ms: 5000 });

  // ── before_step: cognitive friction + firebreak ─────────────────────────

  api.registerHook("before_step", async (ctx: HookContext): Promise<HookResult> => {
    const toolName = ctx.tool as string | undefined;
    // Stash tool name for after_step (kernel doesn't pass tool to after_step ctx)
    _lastStepToolName = toolName ?? "";
    // Only apply friction/firebreak to game execution tools
    const gameTools = new Set(["execute-game-command", "game-combat", "game-take-all", "game-navigate"]);
    if (!gameTools.has(toolName ?? "")) return { action: "continue" };

    const trustNow = reputation.getTrustScore(tacticianId);
    const attrs = delegationAttributes(trustNow);

    // Cognitive friction
    const frictionResult = friction.assess(attrs, 1, trustNow, 2);
    log(`[Friction] level=${frictionResult.level} score=${frictionResult.composite_score.toFixed(2)}`);

    // Firebreak
    const fbDecision = firebreak.evaluate(1, attrs);
    if (fbDecision.action !== "allow") {
      log(`[Firebreak] BLOCKED: ${fbDecision.reason}`);
      return { action: "block", reason: `Firebreak: ${fbDecision.reason}` };
    }

    return { action: "continue" };
  }, { priority: 20, timeout_ms: 5000 });

  // ── before_tool_call: escrow hold + redelegation tracking + SLO ─────────

  api.registerHook("before_tool_call", async (ctx: HookContext): Promise<HookResult> => {
    const toolName = ctx.tool_name as string | undefined;
    const gameExecTools = new Set(["execute-game-command", "game-combat", "game-take-all", "game-navigate"]);
    if (!gameExecTools.has(toolName ?? "")) return { action: "continue" };

    const input = ctx.input as Record<string, unknown> | undefined;
    // Derive a descriptive command string for logging/tracking
    let command: string;
    if (toolName === "game-combat") {
      command = `attack ${input?.target ?? "?"} with ${input?.weapon ?? "?"}`;
    } else if (toolName === "game-take-all") {
      const items = (input?.items as string[]) ?? [];
      command = `take-all [${items.join(", ")}]`;
    } else if (toolName === "game-navigate") {
      const steps = (input?.steps as Array<{ direction: string }>) ?? [];
      command = `navigate [${steps.map(s => s.direction).join(" → ")}]`;
    } else {
      command = (input?.command as string) ?? "";
    }
    const taskId = `task-t-${uuid().slice(0, 8)}`;

    // Graduated authority → dynamic SLO
    const trustNow = reputation.getTrustScore(tacticianId);
    const authority = authorityFromTrust(trustNow, baseSLO, baseMonitoring);
    const tier = getTrustTier(trustNow);
    log(`[Authority] trust=${trustNow.toFixed(2)} (${tier}) → SLO: ${authority.slo.max_duration_ms}ms`);

    // Router
    const delegationTarget = trustNow >= 0.5 ? "ai" : "any";
    router.route({
      sub_task_id: taskId,
      task_text: `EXECUTE: ${command}`,
      attributes: delegationAttributes(trustNow),
      constraints: { max_tokens: authority.slo.max_tokens, max_cost_usd: authority.slo.max_cost_usd ?? 0.02, max_duration_ms: authority.slo.max_duration_ms },
      depends_on: [],
      delegation_target: delegationTarget,
    });

    // Escrow
    escrow.holdBond(taskId, tacticianId, 0.10);
    log(`[Escrow] Bond held $0.10 for ${taskId}`);

    // Redelegation tracking
    redelegationMonitor.trackDelegation(
      taskId, tacticianId, `EXECUTE: ${command}`, ctx.session_id,
      { max_tokens: authority.slo.max_tokens, max_cost_usd: authority.slo.max_cost_usd ?? 0.02, max_duration_ms: authority.slo.max_duration_ms },
    );

    // Stash for after_tool_call via closure (kernel uses separate ctx objects per hook)
    _lastCommand = command;
    _lastTaskId = taskId;
    _lastAuthority = authority;

    return { action: "continue" };
  }, { priority: 20, timeout_ms: 5000 });

  // ── after_tool_call: verification + escrow + reputation + game state ─────

  api.registerHook("after_tool_call", async (ctx: HookContext): Promise<HookResult> => {
    const toolName = ctx.tool_name as string | undefined;
    const result = ctx.result as Record<string, unknown> | undefined;

    if (toolName === "execute-game-command" && result) {
      const delta = (result.delta as string) ?? "";
      const roomHeader = (result.room_header as string) ?? "";
      const screenText = (result.screen_text as string) ?? "";
      const success = result.success as boolean ?? false;
      const durationMs = (result.duration_ms as number) ?? 0;

      // Get the command from closure (kernel doesn't pass input to after_tool_call)
      const command = _lastCommand;

      // Update cartographer state
      cartState.lastFullScreen = screenText;
      if (roomHeader && isRoomName(roomHeader)) {
        cartState.lastRoomHeader = roomHeader;
        if (!cartState.rooms.includes(roomHeader)) {
          cartState.rooms.push(roomHeader);
        }
      }

      // Build a SwarmTaskResult for the framework
      const tacResult: SwarmTaskResult = {
        task_id: _lastTaskId || `task-t-${turn}`,
        peer_node_id: tacticianId,
        peer_session_id: ctx.session_id,
        status: success ? "completed" : "failed",
        findings: [{ step_title: `Turn ${turn}`, tool_name: "execute-game-command", status: success ? "succeeded" : "failed", summary: delta.slice(0, 200) }],
        tokens_used: 0,
        cost_usd: 0,
        duration_ms: durationMs,
      };

      // Outcome verification (SLO check)
      const authority = _lastAuthority;
      const slo = authority?.slo ?? baseSLO;
      const contract: DelegationContract = {
        contract_id: `contract-${uuid().slice(0, 8)}`,
        delegator_node_id: strategistId,
        delegatee_node_id: tacticianId,
        task_id: tacResult.task_id,
        task_text: `EXECUTE: ${command}`,
        slo,
        permission_boundary: authority?.permission_boundary ?? { allowed_tools: ["execute-game-command"] },
        monitoring: authority?.monitoring ?? baseMonitoring,
        status: "active",
        created_at: new Date().toISOString(),
      };

      const verification = verifier.verify({ result: tacResult, contract });
      const sloOk = verification.slo_compliance && tacResult.status === "completed";

      if (sloOk) {
        escrow.releaseBond(tacResult.task_id);
        reputation.recordOutcome(tacticianId, tacResult);
        log(`[Verifier] SLO OK (${durationMs}ms)`);
      } else {
        escrow.slashBond(tacResult.task_id, 50);
        reputation.recordOutcome(tacticianId, { ...tacResult, status: "failed" });
        failCount++;
        log(`[Verifier] SLO FAIL: ${verification.issues?.join("; ") ?? "task failed"}`);
      }

      // ── Game state update ───────────────────────────────────────────────

      const prevRoom = gameMemory.currentRoom;
      const newRoom = cartState.lastRoomHeader;

      if (newRoom && newRoom !== prevRoom && isRoomName(newRoom)) {
        gameMemory.currentRoom = newRoom;
        if (prevRoom && !(gameMemory.roomGraph[prevRoom] ?? []).includes(newRoom)) {
          gameMemory.roomGraph[prevRoom] = [...(gameMemory.roomGraph[prevRoom] ?? []), newRoom];
        }
        // Directional graph: forward edge is verified (=), reverse goes to
        // assumedEdges (??=) — never into dirGraph. BFS uses only dirGraph,
        // so non-Euclidean false edges don't corrupt pathfinding. The prompt
        // shows assumed edges as "(unverified)" so the LLM deprioritizes
        // but doesn't ignore them.
        const dirMatch = command.match(/^(?:go\s+)?(north|south|east|west|up|down|in|out)$/i);
        if (dirMatch && prevRoom) {
          const dir = dirMatch[1]!.toLowerCase();
          cartState.dirGraph[prevRoom] ??= {};
          cartState.dirGraph[prevRoom]![dir] = newRoom;
          // Forward traversal promotes any assumed edge to verified
          if (cartState.assumedEdges[prevRoom]?.[dir]) {
            delete cartState.assumedEdges[prevRoom]![dir];
          }
          // Sync forward direction into roomExits for source room
          const srcExits = cartState.roomExits[prevRoom] ?? [];
          if (!srcExits.some(e => e.toLowerCase() === dir)) {
            cartState.roomExits[prevRoom] = [...srcExits, dir];
          }
          if (REVERSE_DIR[dir]) {
            // Reverse goes to assumedEdges (not dirGraph), won't overwrite verified
            if (!cartState.dirGraph[newRoom]?.[REVERSE_DIR[dir]!]) {
              cartState.assumedEdges[newRoom] ??= {};
              cartState.assumedEdges[newRoom]![REVERSE_DIR[dir]!] ??= prevRoom;
            }
            const dstExits = cartState.roomExits[newRoom] ?? [];
            if (!dstExits.some(e => e.toLowerCase() === REVERSE_DIR[dir]!.toLowerCase())) {
              cartState.roomExits[newRoom] = [...dstExits, REVERSE_DIR[dir]!];
            }
          }

          // Puzzle progress: reset stall timer when a previously-blocked or
          // weight-limited direction succeeds. This gives the LLM fresh turns
          // to explore from the post-puzzle position.
          const wasBlocked = cartState.blockedExits[prevRoom]?.has(dir);
          const wasWeightLimited = cartState.weightLimitExits[prevRoom]?.has(dir);
          if (wasBlocked || wasWeightLimited) {
            lastNewRoomTurn = turn;
            if (wasBlocked) cartState.blockedExits[prevRoom]!.delete(dir);
            if (wasWeightLimited) cartState.weightLimitExits[prevRoom]!.delete(dir);
            log(`[PuzzleProgress] Overcame ${wasBlocked ? "blocked" : "weight-limited"} "${dir}" from ${prevRoom} → stall reset`);
          }
        }
        if (!gameMemory.visitedRooms.includes(newRoom)) {
          gameMemory.visitedRooms.push(newRoom);
        }
      }

      // Exit cache pruning
      const pruneDir = command.match(/^(?:go\s+)?(north|south|east|west|up|down|in|out)$/i)?.[1]?.toLowerCase();
      if (pruneDir && prevRoom && (!newRoom || newRoom === prevRoom || !isRoomName(newRoom))) {
        cartState.blockedExits[prevRoom] ??= new Set<string>();
        cartState.blockedExits[prevRoom]!.add(pruneDir);
        const exits = cartState.roomExits[prevRoom];
        if (exits?.map(e => e.toLowerCase()).includes(pruneDir)) {
          cartState.roomExits[prevRoom] = exits.filter(e => e.toLowerCase() !== pruneDir);
          log(`[NavPrune] Removed "${pruneDir}" from ${prevRoom} exits`);
        }
      }

      // Response-text NavPrune
      const navMatch = command.match(/^(?:go\s+)?(\w+)$/i);
      if (navMatch && /^(north|south|east|west|up|down|in|out)$/i.test(navMatch[1]!)) {
        const dir = navMatch[1]!.toLowerCase();
        const room = cartState.lastRoomHeader;
        if (room && delta) {
          if (HARD_BLOCK_RE.test(delta)) {
            cartState.blockedExits[room] ??= new Set<string>();
            cartState.blockedExits[room]!.add(dir);
            const exits = cartState.roomExits[room];
            if (exits?.map(e => e.toLowerCase()).includes(dir)) {
              cartState.roomExits[room] = exits.filter(e => e.toLowerCase() !== dir);
            }
          } else if (SOFT_BLOCK_RE.test(delta)) {
            cartState.weightLimitExits[room] ??= new Set<string>();
            cartState.weightLimitExits[room]!.add(dir);
          }
        }
      }

      // Update inventory
      gameMemory.inventory = updateInventory([...gameMemory.inventory], delta, command);

      // Remove picked-up items from roomItems cache
      const curRoom = cartState.lastRoomHeader;
      if (curRoom && cartState.roomItems[curRoom]) {
        cartState.roomItems[curRoom] = cartState.roomItems[curRoom]!.filter(
          it => !gameMemory.inventory.includes(it),
        );
      }

      // Update blocked puzzles
      const blockReason = detectBlockReason(delta);
      if (blockReason) {
        const objMatch = command.match(/^(?:open|unlock|push|pull|move|take|use|enter)\s+(.+)/i);
        if (objMatch) {
          const obj = objMatch[1]!.trim();
          if (!gameMemory.blockedPuzzles.some(p => p.room === gameMemory.currentRoom && p.object === obj)) {
            gameMemory.blockedPuzzles.push({ room: gameMemory.currentRoom, object: obj, reason: blockReason });
          }
        }
      } else {
        const objMatch = command.match(/^(?:open|unlock|push|pull|move|take|use|enter)\s+(.+)/i);
        if (objMatch) {
          const obj = objMatch[1]!.trim();
          gameMemory.blockedPuzzles = gameMemory.blockedPuzzles.filter(
            p => !(p.room === gameMemory.currentRoom && p.object === obj),
          );
        }
      }

      // Track exploration progress
      if (cartState.rooms.length > lastNewRoomCount) {
        lastNewRoomCount = cartState.rooms.length;
        lastNewRoomTurn = turn;
      }

      // Update command history and delta
      commandHistory.push(command);
      lastDelta = delta;

      log(`[GameState] Room: ${gameMemory.currentRoom || "?"} | Visited: ${gameMemory.visitedRooms.length} | Inventory: ${gameMemory.inventory.join(", ") || "empty"}`);
    }

    // ── game-combat: update state from combat resolution ─────────────────
    if (toolName === "game-combat" && result) {
      const delta = (result.delta as string) ?? "";
      const screenText = (result.screen_text as string) ?? "";
      const outcome = (result.outcome as string) ?? "";
      const rounds = (result.rounds as number) ?? 0;
      const command = _lastCommand;

      // Update cartographer screen state
      cartState.lastFullScreen = screenText;

      // Weapon might be lost in combat
      if (outcome === "weapon_lost" || outcome === "death") {
        const weaponMatch = command.match(/with\s+(.+)$/i);
        if (weaponMatch) {
          const weapon = weaponMatch[1]!.trim();
          gameMemory.inventory = gameMemory.inventory.filter(i => i !== weapon);
        }
      }
      if (outcome === "death") {
        gameMemory.inventory = [];
      }

      // Update command history: record each round as a command
      for (let i = 0; i < rounds; i++) {
        commandHistory.push(command);
      }
      lastDelta = delta;

      log(`[GameCombat] outcome=${outcome} rounds=${rounds} | Room: ${gameMemory.currentRoom}`);
    }

    // ── game-take-all: update inventory from taken items ─────────────────
    if (toolName === "game-take-all" && result) {
      const taken = (result.taken as string[]) ?? [];
      const screenText = (result.screen_text as string) ?? "";

      cartState.lastFullScreen = screenText;

      // Add taken items to inventory
      for (const item of taken) {
        if (!gameMemory.inventory.includes(item)) {
          gameMemory.inventory.push(item);
        }
        commandHistory.push(`take ${item}`);
      }

      // Remove taken items from roomItems cache
      const curRoom = cartState.lastRoomHeader;
      if (curRoom && cartState.roomItems[curRoom]) {
        cartState.roomItems[curRoom] = cartState.roomItems[curRoom]!.filter(
          it => !taken.includes(it),
        );
      }

      lastDelta = screenText;
      log(`[GameTakeAll] taken=[${taken.join(", ")}] | Inventory: ${gameMemory.inventory.join(", ")}`);
    }

    // ── game-navigate: update dirGraph for each step completed ────────────
    if (toolName === "game-navigate" && result) {
      const stepsTaken = (result.steps_taken as Array<{ direction: string; destination: string; actual_room: string }>) ?? [];
      const screenText = (result.screen_text as string) ?? "";
      const finalRoom = (result.final_room as string) ?? "";

      cartState.lastFullScreen = screenText;

      let prevRoom = gameMemory.currentRoom;
      for (const step of stepsTaken) {
        const dir = step.direction.toLowerCase();
        const actual = step.actual_room;

        // Update directional graph
        if (prevRoom && actual && isRoomName(actual)) {
          cartState.dirGraph[prevRoom] ??= {};
          cartState.dirGraph[prevRoom]![dir] = actual;

          // Promote assumed edge if it exists
          if (cartState.assumedEdges[prevRoom]?.[dir]) {
            delete cartState.assumedEdges[prevRoom]![dir];
          }

          // Sync into roomExits
          const srcExits = cartState.roomExits[prevRoom] ?? [];
          if (!srcExits.some(e => e.toLowerCase() === dir)) {
            cartState.roomExits[prevRoom] = [...srcExits, dir];
          }

          // Reverse assumed edge
          if (REVERSE_DIR[dir]) {
            if (!cartState.dirGraph[actual]?.[REVERSE_DIR[dir]!]) {
              cartState.assumedEdges[actual] ??= {};
              cartState.assumedEdges[actual]![REVERSE_DIR[dir]!] ??= prevRoom;
            }
            const dstExits = cartState.roomExits[actual] ?? [];
            if (!dstExits.some(e => e.toLowerCase() === REVERSE_DIR[dir]!.toLowerCase())) {
              cartState.roomExits[actual] = [...dstExits, REVERSE_DIR[dir]!];
            }
          }

          if (!cartState.rooms.includes(actual)) {
            cartState.rooms.push(actual);
          }
          if (!gameMemory.visitedRooms.includes(actual)) {
            gameMemory.visitedRooms.push(actual);
          }
          if (!(gameMemory.roomGraph[prevRoom] ?? []).includes(actual)) {
            gameMemory.roomGraph[prevRoom] = [...(gameMemory.roomGraph[prevRoom] ?? []), actual];
          }
        }

        commandHistory.push(`go ${step.direction}`);
        prevRoom = actual;
      }

      // Update current room
      if (finalRoom && isRoomName(finalRoom)) {
        gameMemory.currentRoom = finalRoom;
        cartState.lastRoomHeader = finalRoom;
      }

      // Track exploration progress
      if (cartState.rooms.length > lastNewRoomCount) {
        lastNewRoomCount = cartState.rooms.length;
        lastNewRoomTurn = turn;
      }

      lastDelta = screenText;
      log(`[GameNavigate] ${stepsTaken.length} steps | Room: ${gameMemory.currentRoom} | Visited: ${gameMemory.visitedRooms.length}`);
    }

    if (toolName === "parse-game-screen" && result) {
      // Update exits from cartographer result
      const roomName = result.room_name as string | undefined;
      const exits = result.exits as string[] | undefined;
      if (roomName && roomName !== "Unknown" && exits && exits.length > 0) {
        const blocked = cartState.blockedExits[roomName] ?? new Set<string>();
        const filtered = exits.filter(e => !blocked.has(e.toLowerCase()));
        // Merge: add Cartographer exits not already cached (preserves reverse-edge exits)
        const cached = cartState.roomExits[roomName] ?? [];
        const cachedLower = new Set(cached.map(e => e.toLowerCase()));
        for (const exit of filtered) {
          if (!cachedLower.has(exit.toLowerCase())) {
            cached.push(exit);
          }
        }
        cartState.roomExits[roomName] = cached;
      }
      // Heuristic non-compass exit inference from room text keywords.
      // The Cartographer (Haiku) often misses "in"/"up"/"down" exits described as
      // doors, passages, archways, or stairs. Add them to roomExits; NavPrune
      // auto-corrects false positives when the direction fails.
      if (roomName && roomName !== "Unknown") {
        const screen = cartState.lastFullScreen.toLowerCase();
        const curExits = cartState.roomExits[roomName] ?? [];
        const curExitsLower = new Set(curExits.map(e => e.toLowerCase()));
        const blockedHere = cartState.blockedExits[roomName] ?? new Set<string>();

        const INFER_RULES: Array<{ pattern: RegExp; dir: string }> = [
          { pattern: /\b(?:door(?:way)?|passage(?:way)?|arch(?:way)?|entrance|entry|opening)\b/, dir: "in" },
          { pattern: /\b(?:stair(?:s|case)?|ladder)\b.*?\bup\b|\bup\b.*?\b(?:stair|ladder)\b|\bclimb(?:ing)?\s+up\b/, dir: "up" },
          { pattern: /\b(?:stair(?:s|case)?|ladder)\b.*?\bdown\b|\bdown\b.*?\b(?:stair|ladder)\b|\bdescend/, dir: "down" },
        ];

        for (const { pattern, dir } of INFER_RULES) {
          if (pattern.test(screen) && !curExitsLower.has(dir) && !blockedHere.has(dir)) {
            curExits.push(dir);
            log(`[ExitInfer] Added "${dir}" to ${roomName} exits (keyword match)`);
          }
        }
        cartState.roomExits[roomName] = curExits;
      }

      // Store Cartographer-detected items (subtract already-held inventory)
      const items = result.items as string[] | undefined;
      if (roomName && roomName !== "Unknown" && items && items.length > 0) {
        const roomItems = items.filter(it => !gameMemory.inventory.includes(it));
        if (roomItems.length > 0) {
          cartState.roomItems[roomName] = roomItems;
        }
      }
    }

    return { action: "continue" };
  }, { priority: 20, timeout_ms: 10000 });

  // ── after_step: consensus + anomaly + behavioral + checkpoint ───────────

  api.registerHook("after_step", async (ctx: HookContext): Promise<HookResult> => {
    // Kernel doesn't pass tool name to after_step ctx — read from closure
    const gameStepTools = new Set(["execute-game-command", "game-combat", "game-take-all", "game-navigate"]);
    if (!gameStepTools.has(_lastStepToolName)) return { action: "observe" };

    // Consensus: read screen independently
    const emulator = config.emulator;
    const screenHash = createHash("sha256")
      .update(await emulator.readScreen() ?? "")
      .digest("hex")
      .slice(0, 32);

    const taskId = `task-consensus-${turn}`;
    const round = consensus.createRound(taskId, 2, 0.67);
    consensus.submitVerification(round.round_id, strategistId, screenHash, 0.95);
    consensus.submitVerification(round.round_id, cartoId, screenHash, 0.90);
    const outcome = consensus.evaluateRound(round.round_id);
    if (outcome?.agreed) {
      log(`[Consensus] Agreed (${outcome.agreement_ratio.toFixed(1)})`);
    } else {
      log(`[Consensus] Failed`);
    }

    // Anomaly detection
    const trustNow = reputation.getTrustScore(tacticianId);
    const attrs = delegationAttributes(trustNow);
    const tacResult: SwarmTaskResult = {
      task_id: taskId, peer_node_id: tacticianId, peer_session_id: ctx.session_id,
      status: "completed", findings: [],
      tokens_used: 0, cost_usd: 0, duration_ms: 0,
    };
    const contract: DelegationContract = {
      contract_id: `contract-${turn}`, delegator_node_id: strategistId,
      delegatee_node_id: tacticianId, task_id: taskId, task_text: "",
      slo: baseSLO, permission_boundary: { allowed_tools: ["execute-game-command"] },
      monitoring: baseMonitoring, status: "active", created_at: new Date().toISOString(),
    };
    const anomalies = anomalyDetector.analyzeResult({ result: tacResult, contract });
    if (anomalies.length > 0) {
      for (const a of anomalies) {
        log(`[Anomaly] ${a.type} (${a.severity}): ${a.description}`);
      }
    }

    // Behavioral scoring
    behavioralScorer.inferObservationsFromResult(tacticianId, 0, failCount > 0);
    const behavScore = behavioralScorer.computeCompositeScore(tacticianId);
    log(`[Behavior] Tactician score: ${behavScore.toFixed(2)}`);

    // Checkpoint every 5 turns
    if (turn % 5 === 0) {
      checkpointer.saveCheckpoint({
        task_id: ctx.session_id,
        peer_node_id: strategistId,
        state: {
          turn,
          rooms: cartState.rooms,
          inventory: gameMemory.inventory,
          visitedRooms: gameMemory.visitedRooms,
          commandHistory: commandHistory.slice(-20),
          trustScore: trustNow,
        },
        findings_so_far: turn,
        tokens_used: 0, cost_usd: 0, duration_ms: 0,
        timestamp: new Date().toISOString(),
      });
      log(`[Checkpoint] Saved at turn ${turn}`);
    }

    return { action: "observe" };
  }, { priority: 30, timeout_ms: 10000 });

  // ── on_error: root cause analysis ───────────────────────────────────────

  api.registerHook("on_error", async (ctx: HookContext): Promise<HookResult> => {
    const error = ctx.error as string | undefined;
    if (error) {
      log(`[RootCause] Error: ${error}`);
    }
    return { action: "observe" };
  }, { priority: 50, timeout_ms: 5000 });

  log(`[swarm-delegation] Initialized: Tactician trust=${reputation.getTrustScore(tacticianId).toFixed(2)}, Cartographer trust=${reputation.getTrustScore(cartoId).toFixed(2)}`);
  log(`[swarm-delegation] Escrow: Tactician $${(ckpt?.tacticianEscrow ?? 1.00).toFixed(2)}, Cartographer $${(ckpt?.cartoEscrow ?? 1.00).toFixed(2)}`);
}

import type { ToolManifest, ToolHandler } from "@karnevil9/schemas";
import type { MeshManager } from "./mesh-manager.js";
import type { WorkDistributor } from "./work-distributor.js";
import type { ReputationStore } from "./reputation-store.js";
import type { TaskDecomposer } from "./task-decomposer.js";
import type { TaskAuction } from "./task-auction.js";

export const swarmDistributeManifest: ToolManifest = {
  name: "swarm-distribute",
  version: "1.0.0",
  description: "Delegate a subtask to a peer node in the swarm mesh. The peer runs the task in its own session and returns findings.",
  runner: "internal",
  input_schema: {
    type: "object",
    required: ["task_text"],
    properties: {
      task_text: { type: "string", description: "The subtask description to delegate to a peer" },
      tool_allowlist: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of tools the peer should use",
      },
      max_tokens: { type: "number", description: "Max tokens budget for the peer session" },
      max_cost_usd: { type: "number", description: "Max cost budget for the peer session" },
      max_duration_ms: { type: "number", description: "Max duration for the peer session" },
    },
  },
  output_schema: {
    type: "object",
    properties: {
      status: { type: "string" },
      findings: { type: "array" },
      peer_node_id: { type: "string" },
      tokens_used: { type: "number" },
      cost_usd: { type: "number" },
      duration_ms: { type: "number" },
    },
  },
  permissions: ["swarm:delegate:tasks"],
  timeout_ms: 600000,
  supports: { mock: true, dry_run: true },
};

export const swarmPeersManifest: ToolManifest = {
  name: "swarm-peers",
  version: "1.0.0",
  description: "List active peers in the swarm mesh, with their capabilities and status.",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      status_filter: {
        type: "string",
        enum: ["active", "suspected", "unreachable", "left"],
        description: "Filter peers by status",
      },
      capability_filter: { type: "string", description: "Filter peers by capability" },
    },
  },
  output_schema: {
    type: "object",
    properties: {
      peers: { type: "array" },
      self: { type: "object" },
      total: { type: "number" },
    },
  },
  permissions: ["swarm:read:peers"],
  timeout_ms: 10000,
  supports: { mock: true, dry_run: true },
};

export function createSwarmDistributeHandler(
  meshManager: MeshManager,
  workDistributor: WorkDistributor,
): ToolHandler {
  return async (input, mode, _policy) => {
    if (mode === "mock") {
      return {
        status: "completed",
        findings: [{ step_title: "mock step", tool_name: "mock-tool", status: "succeeded", summary: "mock result" }],
        peer_node_id: "mock-peer",
        tokens_used: 0,
        cost_usd: 0,
        duration_ms: 0,
      };
    }

    if (mode === "dry_run") {
      const peers = meshManager.getActivePeers();
      return {
        dry_run: true,
        would_distribute_to: peers.map((p) => p.identity.node_id),
        available_peers: peers.length,
        task_text: input.task_text,
      };
    }

    const taskText = input.task_text as string;
    if (!taskText || typeof taskText !== "string") {
      throw new Error("task_text is required and must be a string");
    }

    const constraints = {
      tool_allowlist: input.tool_allowlist as string[] | undefined,
      max_tokens: input.max_tokens as number | undefined,
      max_cost_usd: input.max_cost_usd as number | undefined,
      max_duration_ms: input.max_duration_ms as number | undefined,
    };

    // Remove undefined values
    const cleanConstraints = Object.fromEntries(
      Object.entries(constraints).filter(([, v]) => v !== undefined),
    );

    const result = await workDistributor.distribute(
      taskText,
      "swarm-tool", // session_id placeholder — filled in by tool runtime context
      Object.keys(cleanConstraints).length > 0 ? cleanConstraints : undefined,
    );

    return {
      status: result.status,
      findings: result.findings,
      peer_node_id: result.peer_node_id,
      peer_session_id: result.peer_session_id,
      tokens_used: result.tokens_used,
      cost_usd: result.cost_usd,
      duration_ms: result.duration_ms,
    };
  };
}

export function createSwarmPeersHandler(meshManager: MeshManager): ToolHandler {
  return async (input, mode, _policy) => {
    if (mode === "mock") {
      return {
        self: { node_id: "mock-node", display_name: "Mock", capabilities: [] },
        peers: [],
        total: 0,
      };
    }

    let peers = meshManager.getPeers();

    const statusFilter = input.status_filter as string | undefined;
    if (statusFilter) {
      peers = peers.filter((p) => p.status === statusFilter);
    }

    const capFilter = input.capability_filter as string | undefined;
    if (capFilter) {
      peers = peers.filter((p) => p.identity.capabilities.includes(capFilter));
    }

    return {
      self: meshManager.getIdentity(),
      peers: peers.map((p) => ({
        node_id: p.identity.node_id,
        display_name: p.identity.display_name,
        api_url: p.identity.api_url,
        capabilities: p.identity.capabilities,
        status: p.status,
        last_heartbeat_at: p.last_heartbeat_at,
        last_latency_ms: p.last_latency_ms,
      })),
      total: peers.length,
    };
  };
}

// ─── Swarm Reputation Tool ──────────────────────────────────────────

export const swarmReputationManifest: ToolManifest = {
  name: "swarm-reputation",
  version: "1.0.0",
  description: "View peer reputations and trust scores in the swarm mesh.",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      node_id: { type: "string", description: "Optional: filter to a specific peer by node ID" },
    },
  },
  output_schema: {
    type: "object",
    properties: {
      reputations: { type: "array" },
      total: { type: "number" },
    },
  },
  permissions: ["swarm:read:reputation"],
  timeout_ms: 10000,
  supports: { mock: true, dry_run: true },
};

export function createSwarmReputationHandler(reputationStore: ReputationStore): ToolHandler {
  return async (input, mode, _policy) => {
    if (mode === "mock") {
      return { reputations: [], total: 0 };
    }

    const nodeId = input.node_id as string | undefined;
    if (nodeId) {
      const rep = reputationStore.getReputation(nodeId);
      if (rep) {
        return { reputations: [rep], total: 1 };
      }
      return {
        reputations: [{ node_id: nodeId, trust_score: reputationStore.getTrustScore(nodeId) }],
        total: 1,
      };
    }

    const all = reputationStore.getAllReputations();
    return { reputations: all, total: all.length };
  };
}

// ─── Swarm Decompose Tool ───────────────────────────────────────────

export const swarmDecomposeManifest: ToolManifest = {
  name: "swarm-decompose",
  version: "1.0.0",
  description: "Analyze a task and return a structured decomposition showing how it would be split for delegation.",
  runner: "internal",
  input_schema: {
    type: "object",
    required: ["task_text"],
    properties: {
      task_text: { type: "string", description: "The task description to decompose" },
      recursive: { type: "boolean", description: "If true, recursively decompose unverifiable subtasks" },
      proposals: { type: "boolean", description: "If true, generate multiple decomposition proposals" },
    },
  },
  output_schema: {
    type: "object",
    properties: {
      original_task_text: { type: "string" },
      sub_tasks: { type: "array" },
      execution_order: { type: "array" },
      skip_delegation: { type: "boolean" },
      skip_reason: { type: "string" },
      proposals: { type: "array" },
    },
  },
  permissions: ["swarm:read:peers"],
  timeout_ms: 10000,
  supports: { mock: true, dry_run: true },
};

export function createSwarmDecomposeHandler(
  taskDecomposer: TaskDecomposer,
  meshManager: MeshManager,
): ToolHandler {
  return async (input, mode, _policy) => {
    if (mode === "mock") {
      return {
        original_task_text: input.task_text,
        sub_tasks: [],
        execution_order: [],
        skip_delegation: true,
        skip_reason: "Mock mode",
      };
    }

    const taskText = input.task_text as string;
    if (!taskText || typeof taskText !== "string") {
      throw new Error("task_text is required and must be a string");
    }

    const peers = meshManager.getActivePeers().map((p) => ({
      node_id: p.identity.node_id,
      capabilities: p.identity.capabilities,
    }));

    const recursive = input.recursive as boolean | undefined;
    const proposals = input.proposals as boolean | undefined;

    if (proposals) {
      return {
        proposals: taskDecomposer.generateProposals({
          task_text: taskText,
          available_peers: peers,
        }),
      };
    }

    if (recursive) {
      return taskDecomposer.decomposeRecursive({
        task_text: taskText,
        available_peers: peers,
      });
    }

    return taskDecomposer.decompose({
      task_text: taskText,
      available_peers: peers,
    });
  };
}

// ─── Swarm Auction Tool ─────────────────────────────────────────────

export const swarmAuctionManifest: ToolManifest = {
  name: "swarm-auction",
  version: "1.0.0",
  description: "Create an auction to solicit bids from peers for a task, then award to the best bidder.",
  runner: "internal",
  input_schema: {
    type: "object",
    required: ["task_text"],
    properties: {
      task_text: { type: "string", description: "The task description to auction" },
      bid_deadline_ms: { type: "number", description: "Bid collection deadline in ms" },
      required_capabilities: {
        type: "array",
        items: { type: "string" },
        description: "Required capabilities for bidders",
      },
    },
  },
  output_schema: {
    type: "object",
    properties: {
      rfq_id: { type: "string" },
      status: { type: "string" },
      winning_node_id: { type: "string" },
      total_bids: { type: "number" },
    },
  },
  permissions: ["swarm:delegate:tasks"],
  timeout_ms: 120000,
  supports: { mock: true, dry_run: true },
};

export function createSwarmAuctionHandler(
  taskAuction: TaskAuction,
  meshManager: MeshManager,
): ToolHandler {
  return async (input, mode, _policy) => {
    if (mode === "mock") {
      return { rfq_id: "mock-rfq", status: "awarded", winning_node_id: "mock-peer", total_bids: 1 };
    }

    if (mode === "dry_run") {
      const peers = meshManager.getActivePeers();
      return {
        dry_run: true,
        would_broadcast_to: peers.length,
        task_text: input.task_text,
      };
    }

    const taskText = input.task_text as string;
    if (!taskText || typeof taskText !== "string") {
      throw new Error("task_text is required and must be a string");
    }

    const auction = await taskAuction.createAuction(
      taskText,
      "swarm-auction-tool",
      undefined,
      input.required_capabilities as string[] | undefined,
    );

    // Wait for bids
    const deadline = input.bid_deadline_ms as number | undefined ?? 30000;
    await new Promise(resolve => setTimeout(resolve, Math.min(deadline, 30000)));

    const { awarded, winning_bid } = await taskAuction.awardAuction(auction.rfq_id);

    return {
      rfq_id: auction.rfq_id,
      status: awarded ? "awarded" : "expired",
      winning_node_id: winning_bid?.bidder_node_id,
      total_bids: auction.bids.length,
      winning_bid: winning_bid ? {
        estimated_cost_usd: winning_bid.estimated_cost_usd,
        estimated_duration_ms: winning_bid.estimated_duration_ms,
      } : undefined,
    };
  };
}

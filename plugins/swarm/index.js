/**
 * Swarm Plugin — P2P mesh for distributing tasks across KarnEvil9 instances.
 *
 * Enables peer discovery, task delegation, and result aggregation across a
 * network of KarnEvil9 nodes.
 */

/**
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
export async function register(api) {
  const config = api.config;

  const meshManager = config.meshManager;
  const workDistributor = config.workDistributor;
  const sessionFactory = config.sessionFactory;
  const swarmToken = process.env.KARNEVIL9_SWARM_TOKEN ?? config.swarmToken;

  if (!meshManager) {
    api.logger.warn("No meshManager provided — Swarm plugin will register stubs (graceful degradation)");
    _registerStubs(api);
    return;
  }

  // ── Import swarm tool and route creators ──
  const {
    swarmDistributeManifest,
    swarmPeersManifest,
    createSwarmDistributeHandler,
    createSwarmPeersHandler,
    createSwarmRoutes,
  } = await import("@karnevil9/swarm");

  // ── Register tools ──
  if (workDistributor) {
    api.registerTool(swarmDistributeManifest, createSwarmDistributeHandler(meshManager, workDistributor));
  } else {
    api.registerTool(swarmDistributeManifest, async (input, mode) => {
      if (mode === "mock") {
        return { status: "completed", findings: [], peer_node_id: "mock-peer", tokens_used: 0, cost_usd: 0, duration_ms: 0 };
      }
      return { status: "failed", error: "WorkDistributor not configured" };
    });
  }

  api.registerTool(swarmPeersManifest, createSwarmPeersHandler(meshManager));

  // ── Register hooks ──

  // after_session_end: send results back to originator if this was a delegated task
  api.registerHook("after_session_end", async (context) => {
    // If this session was started by a swarm delegation, notify the originator
    // The mesh manager handles result delivery via its onTaskResult callback
    return { action: "observe" };
  });

  // before_plan: inject peer findings into planner context
  api.registerHook("before_plan", async (context) => {
    const peerCount = meshManager.getActivePeers().length;
    if (peerCount > 0) {
      return {
        action: "modify",
        data: {
          swarm_context: {
            available_peers: peerCount,
            peer_capabilities: meshManager.getActivePeers().map((p) => ({
              node_id: p.identity.node_id,
              capabilities: p.identity.capabilities,
            })),
            hint: "You can use the swarm-distribute tool to delegate subtasks to peer nodes.",
          },
        },
      };
    }
    return { action: "continue" };
  });

  // ── Register routes ──
  const routes = createSwarmRoutes(meshManager, workDistributor, swarmToken);
  for (const route of routes) {
    // Strip /plugins/swarm/ prefix — plugin system adds it automatically
    const routePath = route.path.replace("/plugins/swarm/", "");
    api.registerRoute(route.method, routePath, route.handler);
  }

  // ── Register service: swarm-mesh ──
  api.registerService({
    name: "swarm-mesh",
    async start() {
      await meshManager.start();
      api.logger.info("Swarm mesh started", {
        node_id: meshManager.getIdentity().node_id,
        display_name: meshManager.getIdentity().display_name,
      });
    },
    async stop() {
      await meshManager.stop();
      api.logger.info("Swarm mesh stopped");
    },
    async health() {
      return {
        ok: meshManager.isRunning,
        detail: meshManager.isRunning
          ? `${meshManager.peerCount} peers (${meshManager.getActivePeers().length} active)`
          : "Not running",
      };
    },
  });

  api.logger.info("Swarm plugin registered");
}

/**
 * Register stubs when meshManager is not provided (so plugin manifest validates).
 * @param {import("@karnevil9/schemas").PluginApi} api
 */
function _registerStubs(api) {
  // Lazy import — only load if needed for manifest constants
  const distributeManifest = {
    name: "swarm-distribute",
    version: "1.0.0",
    description: "Delegate a subtask to a peer node in the swarm mesh (disabled)",
    runner: "internal",
    input_schema: { type: "object", required: ["task_text"], properties: { task_text: { type: "string" } } },
    output_schema: { type: "object" },
    permissions: ["swarm:delegate:tasks"],
    timeout_ms: 10000,
    supports: { mock: true, dry_run: true },
  };
  const peersManifest = {
    name: "swarm-peers",
    version: "1.0.0",
    description: "List active peers in the swarm mesh (disabled)",
    runner: "internal",
    input_schema: { type: "object", properties: {} },
    output_schema: { type: "object" },
    permissions: ["swarm:read:peers"],
    timeout_ms: 10000,
    supports: { mock: true, dry_run: true },
  };

  api.registerTool(distributeManifest, async (input, mode) => {
    if (mode === "mock") return { status: "completed", findings: [], peer_node_id: "mock-peer", tokens_used: 0, cost_usd: 0, duration_ms: 0 };
    return { status: "failed", error: "Swarm not configured" };
  });

  api.registerTool(peersManifest, async () => {
    return { self: null, peers: [], total: 0 };
  });

  api.registerHook("after_session_end", async () => ({ action: "observe" }));
  api.registerHook("before_plan", async () => ({ action: "continue" }));

  api.registerRoute("GET", "identity", async (_req, res) => {
    res.json({ error: "Swarm not configured" });
  });

  api.registerRoute("GET", "peers", async (_req, res) => {
    res.json({ peers: [], total: 0 });
  });

  api.registerRoute("GET", "status", async (_req, res) => {
    res.json({ running: false, error: "Swarm not configured" });
  });

  api.registerService({
    name: "swarm-mesh",
    async start() { api.logger.info("Swarm service stub — not configured"); },
    async stop() {},
    async health() { return { ok: false, detail: "Not configured" }; },
  });
}

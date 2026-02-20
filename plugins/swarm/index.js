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
    swarmReputationManifest,
    swarmDecomposeManifest,
    swarmAuctionManifest,
    createSwarmDistributeHandler,
    createSwarmPeersHandler,
    createSwarmReputationHandler,
    createSwarmDecomposeHandler,
    createSwarmAuctionHandler,
    createSwarmRoutes,
    ReputationStore,
    ContractStore,
    TaskMonitor,
    ExternalTriggerHandler,
    authorityFromTrust,
    // Phase 3
    OutcomeVerifier,
    TaskDecomposer,
    OptimizationLoop,
    AnomalyDetector,
    MonitoringStream,
    DisputeStore,
    // Phase 4
    AntiGamingDetector,
    CredentialVerifier,
    RootCauseAnalyzer,
    SybilDetector,
    CollusionDetector,
    DCTManager,
    TaskAuction,
    ProposalCache,
    // Phase 5
    LiabilityFirebreak,
    CognitiveFrictionEngine,
    DelegateeRouter,
    BehavioralScorer,
    SabotageDetector,
    CheckpointSerializer,
    EscrowManager,
    AuctionGuard,
    ConsensusVerifier,
  } = await import("@karnevil9/swarm");

  // ── Initialize stores ──
  const reputationPath = process.env.KARNEVIL9_SWARM_REPUTATION_PATH
    ?? config.reputationStorePath
    ?? "sessions/swarm-reputations.jsonl";
  const contractsPath = process.env.KARNEVIL9_SWARM_CONTRACTS_PATH
    ?? config.contractStorePath
    ?? "sessions/swarm-contracts.jsonl";
  const disputesPath = process.env.KARNEVIL9_SWARM_DISPUTES_PATH
    ?? config.disputeStorePath
    ?? "sessions/swarm-disputes.jsonl";

  const reputationStore = new ReputationStore(reputationPath);
  const contractStore = new ContractStore(contractsPath);
  const disputeStore = new DisputeStore(disputesPath);

  // ── Phase 3: Initialize new components ──
  const outcomeVerifier = new OutcomeVerifier({
    slo_strict: config.sloStrict ?? true,
  });

  const anomalyDetector = new AnomalyDetector(config.anomalyConfig);

  const monitoringStream = config.enableSse !== false
    ? new MonitoringStream(config.monitoringStreamConfig)
    : null;

  const taskDecomposer = new TaskDecomposer(config.decomposerConfig);

  // ── Phase 4: Initialize new components ──
  const antiGamingDetector = new AntiGamingDetector(config.antiGamingConfig);
  if (reputationStore.setAntiGaming) {
    reputationStore.setAntiGaming(antiGamingDetector);
  }

  const credentialVerifier = config.enableCredentials !== false
    ? new CredentialVerifier({
        localIdentity: meshManager.getIdentity(),
        localKeyPair: config.localKeyPair,
        trustedIssuers: config.trustedIssuers,
        requireCredentials: config.requireCredentials ?? false,
        minEndorsements: config.minEndorsements ?? 0,
      })
    : null;

  const rootCauseAnalyzer = new RootCauseAnalyzer({
    meshManager,
    anomalyDetector,
    reputationStore,
  });

  const sybilDetector = new SybilDetector(config.sybilConfig);

  const collusionDetector = new CollusionDetector(config.collusionConfig);

  const dctManager = swarmToken
    ? new DCTManager({
        swarmToken,
        nodeId: meshManager.getIdentity().node_id,
        dctConfig: config.dctConfig,
      })
    : null;

  const proposalCache = new ProposalCache(config.proposalCacheConfig);

  // ── Phase 5: Initialize new components ──
  const checkpointsPath = process.env.KARNEVIL9_SWARM_CHECKPOINTS_PATH
    ?? config.checkpointStorePath
    ?? "sessions/swarm-checkpoints.jsonl";
  const escrowPath = process.env.KARNEVIL9_SWARM_ESCROW_PATH
    ?? config.escrowStorePath
    ?? "sessions/swarm-escrow.jsonl";

  const liabilityFirebreak = new LiabilityFirebreak(config.firebreakPolicy, config.emitEvent);
  const cognitiveFriction = new CognitiveFrictionEngine(config.frictionConfig, config.emitEvent);
  const delegateeRouter = new DelegateeRouter(config.emitEvent);
  const behavioralScorer = new BehavioralScorer(config.emitEvent);
  const sabotageDetector = new SabotageDetector(config.sabotageConfig, config.emitEvent);
  const checkpointSerializer = new CheckpointSerializer(checkpointsPath, config.emitEvent);
  const escrowManager = new EscrowManager(escrowPath, config.bondRequirement, config.emitEvent);
  const auctionGuard = new AuctionGuard(config.auctionGuardConfig, config.emitEvent);
  const consensusVerifier = new ConsensusVerifier(config.consensusConfig, config.emitEvent);

  // Wire Phase 5 into existing components (auction wiring deferred until taskAuction init)
  sabotageDetector.setCollusionDetector(collusionDetector);
  reputationStore.setBehavioralScorer(behavioralScorer);
  reputationStore.setSabotageDetector(sabotageDetector);
  meshManager.setLiabilityFirebreak(liabilityFirebreak);
  meshManager.setCognitiveFriction(cognitiveFriction);
  if (taskDecomposer.setRouter) {
    taskDecomposer.setRouter(delegateeRouter);
  }

  // ── Initialize TaskMonitor ──
  let taskMonitor = null;
  if (workDistributor) {
    taskMonitor = new TaskMonitor({
      transport: meshManager.getTransport(),
      monitorConfig: config.monitorConfig,
      emitEvent: config.emitEvent,
      onCheckpointsMissed: (taskId, peerNodeId) => {
        api.logger.warn(`Task ${taskId} missed max checkpoints from peer ${peerNodeId}, triggering degradation`);
        void workDistributor.handlePeerDegradation([peerNodeId]);
      },
      getPeerApiUrl: (nodeId) => meshManager.getPeer(nodeId)?.identity.api_url,
    });
  }

  // ── Initialize ExternalTriggerHandler ──
  let externalTriggerHandler = null;
  if (workDistributor) {
    externalTriggerHandler = new ExternalTriggerHandler({
      workDistributor,
      meshManager,
      contractStore,
      emitEvent: config.emitEvent,
      budgetAlertThreshold: config.budgetAlertThreshold ?? 0.8,
    });
  }

  // ── Phase 4: Initialize TaskAuction ──
  let taskAuction = null;
  if (workDistributor) {
    taskAuction = new TaskAuction({
      meshManager,
      transport: meshManager.getTransport(),
      reputationStore,
      auctionConfig: config.auctionConfig,
    });
  }

  // Wire Phase 5 auction components
  if (taskAuction) {
    taskAuction.setEscrowManager(escrowManager);
    taskAuction.setAuctionGuard(auctionGuard);
  }

  // ── Phase 3: Initialize OptimizationLoop ──
  let optimizationLoop = null;
  if (workDistributor) {
    optimizationLoop = new OptimizationLoop({
      workDistributor,
      reputationStore,
      meshManager,
      selectionWeights: config.selectionWeights,
      loopConfig: config.optimizationConfig,
      emitEvent: config.emitEvent,
    });
  }

  // ── Task status provider for checkpoint polling ──
  const taskStatusProvider = async (taskId) => {
    // Delegatee-side: check if we're running this task locally
    // This is a stub — real implementation would check active sessions
    return null;
  };

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
  api.registerTool(swarmReputationManifest, createSwarmReputationHandler(reputationStore));
  api.registerTool(swarmDecomposeManifest, createSwarmDecomposeHandler(taskDecomposer, meshManager));

  if (taskAuction) {
    api.registerTool(swarmAuctionManifest, createSwarmAuctionHandler(taskAuction, meshManager));
  } else {
    api.registerTool(swarmAuctionManifest, async (input, mode) => {
      if (mode === "mock") return { rfq_id: "mock-rfq", status: "awarded", winning_node_id: "mock-peer", total_bids: 1 };
      return { status: "failed", error: "TaskAuction not configured" };
    });
  }

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
            hint: "You can use the swarm-distribute tool to delegate subtasks to peer nodes, or swarm-decompose to analyze task decomposition.",
          },
        },
      };
    }
    return { action: "continue" };
  });

  // ── Register routes ──
  const routes = createSwarmRoutes(
    meshManager,
    workDistributor,
    swarmToken,
    reputationStore,
    contractStore,
    taskStatusProvider,
    externalTriggerHandler,
    monitoringStream,
    anomalyDetector,
    disputeStore,
    credentialVerifier,
    dctManager,
    sybilDetector,
    taskAuction,
    escrowManager,
    consensusVerifier,
    checkpointSerializer,
  );
  for (const route of routes) {
    // Strip /plugins/swarm/ prefix — plugin system adds it automatically
    const routePath = route.path.replace("/plugins/swarm/", "");
    api.registerRoute(route.method, routePath, route.handler);
  }

  // ── Register service: swarm-mesh ──
  api.registerService({
    name: "swarm-mesh",
    async start() {
      await reputationStore.load();
      await contractStore.load();
      await disputeStore.load();
      await checkpointSerializer.load();
      await escrowManager.load();
      await meshManager.start();
      if (optimizationLoop) {
        optimizationLoop.start();
      }
      api.logger.info("Swarm mesh started", {
        node_id: meshManager.getIdentity().node_id,
        display_name: meshManager.getIdentity().display_name,
        reputations_loaded: reputationStore.size,
        contracts_loaded: contractStore.size,
        disputes_loaded: disputeStore.size,
        optimization_loop: !!optimizationLoop,
        sse_enabled: !!monitoringStream,
      });
    },
    async stop() {
      if (optimizationLoop) {
        optimizationLoop.stop();
      }
      if (taskMonitor) {
        taskMonitor.stopAll();
      }
      if (monitoringStream) {
        monitoringStream.close();
      }
      if (taskAuction) {
        taskAuction.cleanup();
      }
      if (dctManager) {
        dctManager.cleanup();
      }
      proposalCache.clear();
      await meshManager.stop();
      await reputationStore.save();
      await contractStore.save();
      await disputeStore.save();
      await checkpointSerializer.save();
      await escrowManager.save();
      api.logger.info("Swarm mesh stopped");
    },
    async health() {
      return {
        ok: meshManager.isRunning,
        detail: meshManager.isRunning
          ? `${meshManager.peerCount} peers (${meshManager.getActivePeers().length} active), ` +
            `${anomalyDetector.getQuarantinedPeers().size} quarantined, ` +
            `${monitoringStream ? monitoringStream.connectionCount : 0} SSE connections, ` +
            `${sybilDetector.getReports().length} sybil reports, ` +
            `${dctManager ? dctManager.getActiveTokens().length : 0} active DCTs, ` +
            `${taskAuction ? taskAuction.getActiveAuctions().length : 0} active auctions`
          : "Not running",
      };
    },
  });

  api.logger.info("Swarm plugin registered (Phase 5 features enabled)");
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
  const reputationManifest = {
    name: "swarm-reputation",
    version: "1.0.0",
    description: "View peer reputations and trust scores (disabled)",
    runner: "internal",
    input_schema: { type: "object", properties: {} },
    output_schema: { type: "object" },
    permissions: ["swarm:read:reputation"],
    timeout_ms: 10000,
    supports: { mock: true, dry_run: true },
  };
  const decomposeManifest = {
    name: "swarm-decompose",
    version: "1.0.0",
    description: "Analyze task decomposition for delegation (disabled)",
    runner: "internal",
    input_schema: { type: "object", required: ["task_text"], properties: { task_text: { type: "string" } } },
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

  api.registerTool(reputationManifest, async () => {
    return { reputations: [], total: 0 };
  });

  api.registerTool(decomposeManifest, async () => {
    return { original_task_text: "", sub_tasks: [], execution_order: [], skip_delegation: true, skip_reason: "Swarm not configured" };
  });

  const auctionManifest = {
    name: "swarm-auction",
    version: "1.0.0",
    description: "Create an auction to solicit bids from peers (disabled)",
    runner: "internal",
    input_schema: { type: "object", required: ["task_text"], properties: { task_text: { type: "string" } } },
    output_schema: { type: "object" },
    permissions: ["swarm:delegate:tasks"],
    timeout_ms: 10000,
    supports: { mock: true, dry_run: true },
  };
  api.registerTool(auctionManifest, async (input, mode) => {
    if (mode === "mock") return { rfq_id: "mock-rfq", status: "awarded", winning_node_id: "mock-peer", total_bids: 1 };
    return { status: "failed", error: "Swarm not configured" };
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

  api.registerRoute("GET", "reputation", async (_req, res) => {
    res.json({ reputations: [], total: 0 });
  });

  api.registerRoute("GET", "contracts", async (_req, res) => {
    res.json({ contracts: [], total: 0 });
  });

  // Stub new routes for graceful degradation
  api.registerRoute("GET", "task/:taskId/status", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  api.registerRoute("POST", "task/:taskId/cancel", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  api.registerRoute("POST", "trigger", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  api.registerRoute("GET", "events", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  api.registerRoute("GET", "anomalies", async (_req, res) => {
    res.json({ anomalies: [], total: 0 });
  });

  api.registerRoute("POST", "quarantine/:nodeId", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  api.registerRoute("DELETE", "quarantine/:nodeId", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  // Phase 4 stub routes
  api.registerRoute("GET", "credentials/:nodeId", async (_req, res) => {
    res.json({ credentials: [], total: 0 });
  });

  api.registerRoute("GET", "tokens", async (_req, res) => {
    res.json({ tokens: [], total: 0 });
  });

  api.registerRoute("POST", "tokens/:dctId/revoke", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  api.registerRoute("GET", "sybil-reports", async (_req, res) => {
    res.json({ reports: [], total: 0 });
  });

  api.registerRoute("POST", "pow-verify", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  api.registerRoute("POST", "rfq", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  api.registerRoute("POST", "bid", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  api.registerRoute("GET", "auctions", async (_req, res) => {
    res.json({ auctions: [], total: 0 });
  });

  // Phase 5 stub routes
  api.registerRoute("GET", "escrow/:nodeId", async (_req, res) => {
    res.json({ balance: 0, held: 0, free: 0 });
  });

  api.registerRoute("POST", "escrow/deposit", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  api.registerRoute("POST", "verify/:taskId/consensus", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  api.registerRoute("POST", "verify/:taskId/vote", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  api.registerRoute("GET", "verify/:taskId/consensus", async (_req, res) => {
    res.json({ round: null });
  });

  api.registerRoute("POST", "contracts/:contractId/renegotiate", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  api.registerRoute("POST", "contracts/:contractId/renegotiations/:requestId/accept", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  api.registerRoute("POST", "contracts/:contractId/renegotiations/:requestId/reject", async (_req, res) => {
    res.status(501).json({ error: "Swarm not configured" });
  });

  api.registerRoute("GET", "contracts/:contractId/renegotiations", async (_req, res) => {
    res.json({ renegotiations: [], total: 0 });
  });

  api.registerRoute("GET", "task/:taskId/checkpoints", async (_req, res) => {
    res.json({ checkpoints: [], total: 0 });
  });

  api.registerService({
    name: "swarm-mesh",
    async start() { api.logger.info("Swarm service stub — not configured"); },
    async stop() {},
    async health() { return { ok: false, detail: "Not configured" }; },
  });
}

export type {
  SwarmNodeIdentity,
  PeerStatus,
  PeerEntry,
  SwarmTaskConstraints,
  SwarmTaskRequest,
  SwarmTaskResult,
  HeartbeatMessage,
  GossipMessage,
  JoinMessage,
  LeaveMessage,
  DistributionStrategy,
  SwarmConfig,
  SessionFactory,
  ActiveDelegation,
  PeerReputation,
  DelegationContract,
  ContractPermissionBoundary,
  ContractSLO,
  ContractMonitoring,
  ContractStatus,
  TaskAttestation,
  RedelegationConfig,
  SelectionWeights,
  TaskCheckpointStatus,
  TaskMonitorConfig,
  TriggerType,
  TaskCancelTrigger,
  BudgetAlertTrigger,
  PriorityPreemptTrigger,
  ExternalTrigger,
  AttestationChainLink,
  AttestationChain,
  // Phase 3 types
  Ed25519KeyPair,
  VerificationResult,
  DisputeRecord,
  TaskAttribute,
  SubTaskSpec,
  TaskDecomposition,
  PeerPerformanceSnapshot,
  ReoptimizationDecision,
  AnomalyType,
  AnomalyReport,
  DataAccessScope,
  MonitoringEventType,
  MonitoringEvent,
} from "./types.js";
export { DEFAULT_SWARM_CONFIG, DEFAULT_SELECTION_WEIGHTS, DEFAULT_TASK_MONITOR_CONFIG } from "./types.js";
export { PeerTable } from "./peer-table.js";
export type { SweepThresholds } from "./peer-table.js";
export { PeerTransport } from "./transport.js";
export type { TransportResponse, PeerTransportConfig } from "./transport.js";
export { PeerDiscovery } from "./discovery.js";
export type { DiscoveryConfig } from "./discovery.js";
export { MeshManager } from "./mesh-manager.js";
export type { MeshManagerConfig } from "./mesh-manager.js";
export { WorkDistributor } from "./work-distributor.js";
export type { WorkDistributorConfig } from "./work-distributor.js";
export { ResultAggregator } from "./result-aggregator.js";
export {
  swarmDistributeManifest,
  swarmPeersManifest,
  swarmReputationManifest,
  swarmDecomposeManifest,
  createSwarmDistributeHandler,
  createSwarmPeersHandler,
  createSwarmReputationHandler,
  createSwarmDecomposeHandler,
} from "./swarm-tool.js";
export { createSwarmRoutes } from "./swarm-routes.js";
export type { SwarmRoute } from "./swarm-routes.js";
export { ReputationStore } from "./reputation-store.js";
export { ContractStore } from "./delegation-contract.js";
export type { CreateContractParams } from "./delegation-contract.js";
export { RedelegationMonitor } from "./redelegation-monitor.js";
export { createAttestation, verifyAttestation, createChainLink, appendToChain, verifyChain, getChainDepth } from "./attestation.js";
export { attenuateConstraints, validateTaskRequest } from "./permission-attenuator.js";
export { getTrustTier, authorityFromTrust, DEFAULT_GRADUATED_AUTHORITY_CONFIG } from "./graduated-authority.js";
export type { TrustTier, GraduatedAuthorityConfig } from "./graduated-authority.js";
export { TaskMonitor } from "./task-monitor.js";
export type { TaskMonitorConstructorConfig } from "./task-monitor.js";
export { ExternalTriggerHandler } from "./external-trigger-handler.js";
export type { ExternalTriggerHandlerConfig, TriggerListener } from "./external-trigger-handler.js";

// ─── Phase 3: Intelligent Delegation Gaps ──────────────────────────

// Gap 1: Verifiable Task Completion
export { generateEd25519KeyPair, signResult, verifyResultSignature, signAttestation, verifyAttestationSignature } from "./ed25519-signer.js";
export { OutcomeVerifier } from "./outcome-verifier.js";
export type { VerifierConfig } from "./outcome-verifier.js";
export { DisputeStore } from "./dispute-store.js";

// Gap 2: Swarm-Aware Decomposition
export { TaskDecomposer } from "./task-decomposer.js";
export type { DecomposerConfig } from "./task-decomposer.js";

// Gap 3: Continuous Re-optimization
export { OptimizationLoop } from "./optimization-loop.js";
export type { OptimizationLoopConfig } from "./optimization-loop.js";

// Gap 4: Security Hardening
export { AnomalyDetector } from "./anomaly-detector.js";
export type { AnomalyDetectorConfig } from "./anomaly-detector.js";
export { DataAccessGuard } from "./data-access-guard.js";

// Gap 5: Push-Based Monitoring
export { MonitoringStream, MONITORING_LEVEL_ORDINAL, classifyEventLevel, filterEventForLevel } from "./monitoring-stream.js";
export type { MonitoringStreamConfig } from "./monitoring-stream.js";

// ─── Phase 4: Intelligent Delegation Paper Gaps ─────────────────────

// Gap 1: Pareto-Optimal Selection
export { dominates, computeParetoFront, crowdingDistance, selectFromFront, paretoSelect, scorePeersForPareto } from "./pareto-selector.js";

// Gap 2: Anti-Reputation-Gaming
export { AntiGamingDetector } from "./anti-gaming.js";
export type { AntiGamingConfig } from "./anti-gaming.js";

// Gap 4: Reversibility-Aware Response
export { getReversibilityPolicy, getMaxRedelegations, shouldAutoRedelegate, getResponseForFailure, DEFAULT_REVERSIBILITY_POLICY_CONFIG } from "./reversibility-policy.js";

// Gap 5: Root Cause Diagnosis
export { RootCauseAnalyzer } from "./root-cause-analyzer.js";
export type { RootCauseAnalyzerConfig } from "./root-cause-analyzer.js";

// Gap 6: Verifiable Credentials
export { CredentialVerifier } from "./credential-verifier.js";
export type { CredentialVerifierConfig } from "./credential-verifier.js";

// Gap 7: Contract-First Decomposition
export { ProposalCache } from "./proposal-cache.js";
export type { ProposalCacheConfig } from "./proposal-cache.js";

// Gap 8: Delegation Capability Tokens
export { DCTManager } from "./delegation-capability-token.js";
export type { DCTConfig } from "./delegation-capability-token.js";

// Gap 9: Sybil/Collusion Detection
export { SybilDetector } from "./sybil-detector.js";
export type { SybilDetectorConfig } from "./sybil-detector.js";
export { CollusionDetector } from "./collusion-detector.js";
export type { CollusionDetectorConfig } from "./collusion-detector.js";

// Gap 10: Market-Based Bidding/RFQ
export { TaskAuction } from "./task-auction.js";
export type { TaskAuctionConfig } from "./task-auction.js";
export {
  swarmAuctionManifest,
  createSwarmAuctionHandler,
} from "./swarm-tool.js";

// Phase 4 types
export type {
  PeerObjectiveScores,
  ParetoFrontResult,
  TaskComplexityRecord,
  GamingFlagType,
  GamingFlag,
  PeerTaskProfile,
  MonitoringLevel,
  LeveledMonitoringEvent,
  ReversibilityPolicy,
  ReversibilityPolicyConfig,
  RootCause,
  DiagnosedResponse,
  RootCauseDiagnosis,
  PeerCredential,
  CredentialEndorsement,
  CredentialVerificationResult,
  DecompositionProposal,
  VerifiabilityLevel,
  VerifiabilityAssessment,
  CaveatType,
  Caveat,
  DelegationCapabilityToken,
  SybilIndicator,
  SybilReport,
  CollusionIndicator,
  CollusionReport,
  ProofOfWork,
  AuctionStatus,
  TaskRFQ,
  BidObject,
  AuctionRecord,
} from "./types.js";
export { attenuateFromDCT } from "./permission-attenuator.js";

// ─── Phase 5: Intelligent Delegation Paper Gaps ─────────────────────

// Gap 1: Escrow Bonds
export { EscrowManager } from "./escrow-manager.js";
export { DEFAULT_BOND_REQUIREMENT } from "./escrow-manager.js";

// Gap 2: Consensus Verification
export { ConsensusVerifier, DEFAULT_CONSENSUS_CONFIG } from "./consensus-verifier.js";
export type { ConsensusVerifierConfig } from "./consensus-verifier.js";

// Gap 3: Liability Firebreaks
export { LiabilityFirebreak } from "./liability-firebreak.js";

// Gap 4: Human-vs-AI Routing
export { DelegateeRouter } from "./delegatee-router.js";

// Gap 5: Behavioral Reputation
export { BehavioralScorer } from "./behavioral-scorer.js";

// Gap 6: Contract Renegotiation (extends ContractStore — already exported)

// Gap 7: Cognitive Friction
export { CognitiveFrictionEngine } from "./cognitive-friction.js";

// Gap 8: Sabotage Detection
export { SabotageDetector } from "./sabotage-detector.js";
export type { SabotageDetectorConfig } from "./sabotage-detector.js";

// Gap 9: Checkpoint Serialization
export { CheckpointSerializer } from "./checkpoint-serializer.js";

// Gap 10: Auction Guard
export { AuctionGuard } from "./auction-guard.js";

// Phase 5 types
export type {
  EscrowTransactionType,
  EscrowTransaction,
  EscrowAccount,
  BondRequirement,
  ConsensusRoundStatus,
  ConsensusRound,
  ConsensusOutcome,
  FirebreakAction,
  FirebreakLiabilityMode,
  FirebreakPolicy,
  FirebreakDecision,
  RoutingFactors,
  RoutingDecision,
  BehavioralObservationType,
  BehavioralObservation,
  BehavioralMetrics,
  RenegotiationStatus,
  RenegotiationRequest,
  RenegotiationOutcome,
  FrictionLevel,
  FrictionFactors,
  FrictionAssessment,
  FrictionConfig,
  SabotageIndicatorType,
  FeedbackRecord,
  SabotageReport,
  TaskCheckpoint,
  AuctionGuardConfig,
  SealedBid,
  BidCommitment,
} from "./types.js";
export { DEFAULT_FIREBREAK_POLICY, DEFAULT_FRICTION_CONFIG, DEFAULT_AUCTION_GUARD_CONFIG } from "./types.js";

import type { CheckpointFinding } from "@karnevil9/schemas";

// ─── Node Identity ──────────────────────────────────────────────────

export interface SwarmNodeIdentity {
  node_id: string;
  display_name: string;
  api_url: string;
  capabilities: string[];
  version: string;
  ed25519_public_key?: string;
  credentials?: PeerCredential[];
}

// ─── Peer Status ────────────────────────────────────────────────────

export type PeerStatus = "active" | "suspected" | "unreachable" | "left";

export interface PeerEntry {
  identity: SwarmNodeIdentity;
  status: PeerStatus;
  last_heartbeat_at: string;
  last_latency_ms: number;
  consecutive_failures: number;
  joined_at: string;
}

// ─── Task Delegation ────────────────────────────────────────────────

export interface SwarmTaskConstraints {
  tool_allowlist?: string[];
  max_tokens?: number;
  max_cost_usd?: number;
  max_duration_ms?: number;
}

export interface ContractPermissionBoundary {
  tool_allowlist?: string[];
  readonly_paths?: string[];
  max_permissions?: number;
}

export interface SwarmTaskRequest {
  task_id: string;
  originator_node_id: string;
  originator_session_id: string;
  task_text: string;
  constraints?: SwarmTaskConstraints;
  permission_boundary?: ContractPermissionBoundary;
  correlation_id: string;
  nonce: string;
  parent_attestation_chain?: AttestationChain;
  delegation_depth?: number;
  priority?: number;
  data_access_scope?: DataAccessScope;
  task_attributes?: TaskAttribute;
  dct?: DelegationCapabilityToken;
  resume_from_checkpoint?: string; // checkpoint_id to resume from
}

export interface TaskAttestation {
  task_id: string;
  peer_node_id: string;
  status: string;
  findings_hash: string;
  timestamp: string;
  hmac: string;
  ed25519_signature?: string;
}

export interface SwarmTaskResult {
  task_id: string;
  peer_node_id: string;
  peer_session_id: string;
  status: "completed" | "failed" | "aborted";
  findings: CheckpointFinding[];
  tokens_used: number;
  cost_usd: number;
  duration_ms: number;
  attestation?: TaskAttestation;
  attestation_chain?: AttestationChain;
  verification_result?: VerificationResult;
}

// ─── Messages ───────────────────────────────────────────────────────

export interface HeartbeatMessage {
  node_id: string;
  timestamp: string;
  active_sessions: number;
  load: number;
}

export interface GossipMessage {
  sender_node_id: string;
  peers: Array<{ node_id: string; api_url: string; status: PeerStatus }>;
}

export interface JoinMessage {
  identity: SwarmNodeIdentity;
}

export interface LeaveMessage {
  node_id: string;
  reason?: string;
}

// ─── Configuration ──────────────────────────────────────────────────

export type DistributionStrategy = "round_robin" | "capability_match" | "reputation" | "multi_objective" | "pareto" | "auction";

export interface SwarmConfig {
  enabled: boolean;
  token?: string;
  node_name: string;
  api_url: string;
  seeds: string[];
  mdns: boolean;
  gossip: boolean;
  max_peers: number;
  heartbeat_interval_ms: number;
  sweep_interval_ms: number;
  suspected_after_ms: number;
  unreachable_after_ms: number;
  evict_after_ms: number;
  delegation_timeout_ms: number;
  nonce_window_ms: number;
  version: string;
  capabilities: string[];
  reputation_store_path?: string;
  redelegation?: RedelegationConfig;
  selection_weights?: SelectionWeights;
  max_delegation_depth?: number;
  ed25519_keypair?: Ed25519KeyPair;
  data_access_scope?: DataAccessScope;
  enable_sse?: boolean;
}

export const DEFAULT_SWARM_CONFIG: Omit<SwarmConfig, "api_url" | "capabilities"> = {
  enabled: false,
  node_name: "karnevil9-node",
  seeds: [],
  mdns: true,
  gossip: true,
  max_peers: 50,
  heartbeat_interval_ms: 5000,
  sweep_interval_ms: 10000,
  suspected_after_ms: 15000,
  unreachable_after_ms: 30000,
  evict_after_ms: 120000,
  delegation_timeout_ms: 300000,
  nonce_window_ms: 300000,
  version: "0.1.0",
  max_delegation_depth: 3,
};

// ─── Session Factory ────────────────────────────────────────────────

export type SessionFactory = (task: { task_id: string; text: string; created_at: string }) => Promise<{
  session_id: string;
  status: string;
}>;

// ─── Active Delegation ──────────────────────────────────────────────

export interface ActiveDelegation {
  task_id: string;
  peer_node_id: string;
  correlation_id: string;
  sent_at: number;
  timeout_ms: number;
  resolve: (result: SwarmTaskResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  contract_id?: string;
  priority?: number;
}

// ─── Reputation ──────────────────────────────────────────────────────

export interface PeerReputation {
  node_id: string;
  tasks_completed: number;
  tasks_failed: number;
  tasks_aborted: number;
  total_duration_ms: number;
  total_tokens_used: number;
  total_cost_usd: number;
  avg_latency_ms: number;
  consecutive_successes: number;
  consecutive_failures: number;
  last_outcome_at: string;
  trust_score: number;
  task_complexity_distribution?: { low: number; medium: number; high: number };
  task_diversity_score?: number;
  gaming_flags?: GamingFlag[];
  behavioral_metrics?: BehavioralMetrics;
}

// ─── Delegation Contract ─────────────────────────────────────────────

export interface ContractSLO {
  max_duration_ms: number;
  max_tokens: number;
  max_cost_usd: number;
  deadline?: string;  // ISO timestamp
}

export interface ContractMonitoring {
  require_checkpoints: boolean;
  report_interval_ms?: number;
  monitoring_level?: MonitoringLevel;
}

export type ContractStatus = "active" | "completed" | "violated" | "cancelled";

export interface DelegationContract {
  contract_id: string;
  delegator_node_id: string;
  delegatee_node_id: string;
  task_id: string;
  task_text: string;
  slo: ContractSLO;
  permission_boundary: ContractPermissionBoundary;
  monitoring: ContractMonitoring;
  status: ContractStatus;
  created_at: string;
  completed_at?: string;
  violation_reason?: string;
  data_access_scope?: DataAccessScope;
  dispute_window_ms?: number;
  task_attributes?: TaskAttribute;
  original_slo?: ContractSLO;
  renegotiation_history?: RenegotiationRequest[];
  pending_renegotiation?: RenegotiationRequest;
}

// ─── Redelegation ────────────────────────────────────────────────────

export interface RedelegationConfig {
  max_redelegations: number;
  redelegation_cooldown_ms: number;
}

// ─── Multi-Objective Selection ──────────────────────────────────────

export interface SelectionWeights {
  trust: number;
  latency: number;
  cost: number;
  capability: number;
}

export const DEFAULT_SELECTION_WEIGHTS: SelectionWeights = {
  trust: 0.25,
  latency: 0.25,
  cost: 0.25,
  capability: 0.25,
};

// ─── Process-Level Monitoring ───────────────────────────────────────

export interface TaskCheckpointStatus {
  task_id: string;
  status: "running" | "completed" | "failed";
  progress_pct?: number;
  checkpoint?: CheckpointFinding[];
  last_activity_at: string;
}

export interface TaskMonitorConfig {
  poll_interval_ms: number;
  max_missed_checkpoints: number;
  checkpoint_timeout_ms: number;
}

export const DEFAULT_TASK_MONITOR_CONFIG: TaskMonitorConfig = {
  poll_interval_ms: 15000,
  max_missed_checkpoints: 3,
  checkpoint_timeout_ms: 10000,
};

// ─── External Triggers ──────────────────────────────────────────────

export type TriggerType = "task_cancel" | "budget_alert" | "priority_preempt";

export interface TaskCancelTrigger {
  type: "task_cancel";
  task_id: string;
  reason?: string;
  timestamp: string;
}

export interface BudgetAlertTrigger {
  type: "budget_alert";
  task_id: string;
  metric: "cost_usd" | "tokens" | "duration_ms";
  current_value: number;
  limit_value: number;
  percentage: number;
  timestamp: string;
}

export interface PriorityPreemptTrigger {
  type: "priority_preempt";
  new_task_text: string;
  new_task_priority: number;
  min_priority_to_preempt: number;
  constraints?: SwarmTaskConstraints;
  timestamp: string;
}

export type ExternalTrigger = TaskCancelTrigger | BudgetAlertTrigger | PriorityPreemptTrigger;

// ─── Transitive Attestation ─────────────────────────────────────────

export interface AttestationChainLink {
  attestation: TaskAttestation;
  delegator_node_id: string;
  delegatee_node_id: string;
  depth: number;
}

export interface AttestationChain {
  root_task_id: string;
  links: AttestationChainLink[];
  depth: number;
}

// ─── Ed25519 Key Pair ──────────────────────────────────────────────

export interface Ed25519KeyPair {
  publicKey: string;  // hex-encoded
  privateKey: string; // hex-encoded
}

// ─── Verifiable Task Completion ────────────────────────────────────

export interface VerificationResult {
  verified: boolean;
  outcome_score?: number;       // 0-1 quality score
  slo_compliance: boolean;
  findings_verified: boolean;
  verification_method: "direct" | "attestation" | "threshold" | "consensus";
  consensus_round_id?: string;
  issues?: string[];
}

export interface DisputeRecord {
  dispute_id: string;
  task_id: string;
  contract_id: string;
  challenger_node_id: string;
  respondent_node_id: string;
  reason: string;
  status: "open" | "resolved_for_challenger" | "resolved_for_respondent" | "expired";
  evidence?: Record<string, unknown>;
  created_at: string;
  resolved_at?: string;
  resolution_reason?: string;
}

// ─── Swarm-Aware Decomposition ─────────────────────────────────────

export interface TaskAttribute {
  complexity: "low" | "medium" | "high";
  criticality: "low" | "medium" | "high";
  verifiability: "low" | "medium" | "high";
  reversibility: "low" | "medium" | "high";
  estimated_cost: "low" | "medium" | "high";
  estimated_duration: "short" | "medium" | "long";
  required_capabilities: string[];
}

export interface SubTaskSpec {
  sub_task_id: string;
  task_text: string;
  attributes: TaskAttribute;
  constraints: SwarmTaskConstraints;
  depends_on: string[];            // sub_task_ids that must complete first
  delegation_target?: "ai" | "human" | "any";
  parallel_group?: string;         // subtasks in same group can run in parallel
}

export interface TaskDecomposition {
  original_task_text: string;
  sub_tasks: SubTaskSpec[];
  execution_order: string[][];     // array of parallel groups (each is array of sub_task_ids)
  delegation_overhead_ms?: number;
  skip_delegation?: boolean;
  skip_reason?: string;
}

// ─── Continuous Re-optimization ────────────────────────────────────

export interface PeerPerformanceSnapshot {
  node_id: string;
  current_task_id?: string;
  trust_score: number;
  recent_latency_ms: number;
  recent_cost_usd: number;
  checkpoint_success_rate: number;  // 0-1
  last_checkpoint_at?: string;
}

export interface ReoptimizationDecision {
  action: "keep" | "redelegate" | "escalate";
  reason: string;
  current_peer_score: number;
  best_alternative_score?: number;
  best_alternative_node_id?: string;
}

// ─── Security Hardening ────────────────────────────────────────────

export type AnomalyType = "cost_spike" | "duration_spike" | "suspicious_findings"
  | "capability_mismatch" | "repeated_failures" | "data_access_violation";

export interface AnomalyReport {
  anomaly_id: string;
  task_id: string;
  peer_node_id: string;
  type: AnomalyType;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  evidence: Record<string, unknown>;
  timestamp: string;
  auto_action?: "none" | "flag" | "quarantine" | "terminate";
}

export interface DataAccessScope {
  allowed_paths?: string[];
  denied_paths?: string[];
  max_data_size_bytes?: number;
  sensitive_fields?: string[];      // fields to redact from delegated context
  require_encryption?: boolean;
}

// ─── Push-Based Monitoring ─────────────────────────────────────────

export type MonitoringEventType = "checkpoint" | "progress" | "warning" | "error" | "completed" | "failed";

export interface MonitoringEvent {
  task_id: string;
  peer_node_id: string;
  event_type: MonitoringEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

// ─── Gap 1: Pareto Selection ──────────────────────────────────────

export interface PeerObjectiveScores {
  node_id: string;
  trust: number;
  latency: number;
  cost: number;
  capability: number;
}

export interface ParetoFrontResult {
  pareto_front: PeerObjectiveScores[];
  dominated: PeerObjectiveScores[];
  selected: PeerObjectiveScores;
  selection_method: "pareto_crowding" | "pareto_weighted" | "single_solution";
}

// ─── Gap 2: Anti-Gaming ──────────────────────────────────────────

export interface TaskComplexityRecord {
  task_id: string;
  complexity: "low" | "medium" | "high";
  completed_at: string;
}

export type GamingFlagType = "cherry_picking" | "complexity_avoidance" | "inflated_capabilities" | "collusion_suspected";

export interface GamingFlag {
  type: GamingFlagType;
  severity: "low" | "medium" | "high";
  evidence: string;
  flagged_at: string;
}

export interface PeerTaskProfile {
  node_id: string;
  tasks_by_complexity: { low: number; medium: number; high: number };
  tasks_rejected_by_complexity: { low: number; medium: number; high: number };
  task_diversity_score: number;
  gaming_flags: GamingFlag[];
  last_evaluated_at: string;
}

// ─── Gap 3: Monitoring Levels ────────────────────────────────────

export type MonitoringLevel = "L0_IS_OPERATIONAL" | "L1_HIGH_LEVEL_PLAN" | "L2_COT_TRACE" | "L3_FULL_STATE";

export interface LeveledMonitoringEvent extends MonitoringEvent {
  level: MonitoringLevel;
  detail?: Record<string, unknown>;
}

// ─── Gap 4: Reversibility Policy ────────────────────────────────

export type ReversibilityPolicy = "auto_redelegate" | "cautious_redelegate" | "escalate_only";

export interface ReversibilityPolicyConfig {
  low_reversibility_policy: ReversibilityPolicy;
  medium_reversibility_policy: ReversibilityPolicy;
  high_reversibility_policy: ReversibilityPolicy;
  max_auto_redelegations_low: number;
  max_auto_redelegations_medium: number;
  max_auto_redelegations_high: number;
  require_human_approval_low: boolean;
}

// ─── Gap 5: Root Cause Diagnosis ────────────────────────────────

export type RootCause = "peer_overload" | "network_partition" | "malicious_behavior"
  | "task_complexity_mismatch" | "transient_failure" | "resource_exhaustion" | "unknown";

export type DiagnosedResponse = "redelegate_to_alternative" | "wait_and_retry"
  | "quarantine_and_redelegate" | "decompose_and_redelegate" | "escalate_to_human" | "abort_task";

export interface RootCauseDiagnosis {
  task_id: string;
  peer_node_id: string;
  root_cause: RootCause;
  confidence: number;
  evidence: string[];
  recommended_response: DiagnosedResponse;
  alternative_responses: DiagnosedResponse[];
  diagnosed_at: string;
}

// ─── Gap 6: Verifiable Credentials ──────────────────────────────

export interface PeerCredential {
  credential_id: string;
  issuer_node_id: string;
  subject_node_id: string;
  capability_claims: string[];
  issued_at: string;
  expires_at: string;
  signature: string;
  endorsements?: CredentialEndorsement[];
}

export interface CredentialEndorsement {
  endorser_node_id: string;
  endorser_public_key: string;
  endorsed_at: string;
  signature: string;
}

export interface CredentialVerificationResult {
  valid: boolean;
  expired: boolean;
  signature_valid: boolean;
  endorsement_count: number;
  endorsements_valid: number;
  issues: string[];
}

// ─── Gap 7: Contract-First Decomposition ────────────────────────

export interface DecompositionProposal {
  proposal_id: string;
  original_task_text: string;
  decomposition: TaskDecomposition;
  estimated_total_cost_usd: number;
  estimated_total_duration_ms: number;
  verifiability_score: number;
  confidence: number;
  generation_strategy: string;
  timestamp: string;
}

export type VerifiabilityLevel = "verifiable" | "partially_verifiable" | "unverifiable";

export interface VerifiabilityAssessment {
  level: VerifiabilityLevel;
  reason: string;
  suggested_decomposition?: string[];
}

// ─── Gap 8: Delegation Capability Tokens ────────────────────────

export type CaveatType = "tool_restriction" | "path_restriction" | "time_bound"
  | "cost_limit" | "token_limit" | "read_only" | "domain_restriction" | "custom";

export interface Caveat {
  type: CaveatType;
  value: unknown;
  added_by: string;
  added_at: string;
}

export interface DelegationCapabilityToken {
  dct_id: string;
  root_delegator_node_id: string;
  current_holder_node_id: string;
  parent_dct_id?: string;
  caveats: Caveat[];
  created_at: string;
  expires_at: string;
  signature_chain: string[];
  revoked: boolean;
}

// ─── Gap 9: Sybil/Collusion Detection ──────────────────────────

export type SybilIndicator = "same_ip_range" | "coordinated_join" | "similar_capabilities"
  | "low_proof_of_work" | "rapid_identity_cycling";

export interface SybilReport {
  report_id: string;
  suspect_node_ids: string[];
  indicator: SybilIndicator;
  confidence: number;
  evidence: Record<string, unknown>;
  timestamp: string;
  action: "flag" | "challenge" | "quarantine";
}

export type CollusionIndicator = "bid_coordination" | "reputation_gaming" | "price_fixing"
  | "blacklist_coordination" | "reciprocal_boosting";

export interface CollusionReport {
  report_id: string;
  suspect_node_ids: string[];
  indicator: CollusionIndicator;
  confidence: number;
  evidence: Record<string, unknown>;
  timestamp: string;
  action: "flag" | "quarantine";
}

export interface ProofOfWork {
  node_id: string;
  challenge: string;
  difficulty: number;
  solution: string;
  timestamp: string;
}

// ─── Gap 10: Market-Based Bidding ───────────────────────────────

export type AuctionStatus = "open" | "collecting" | "evaluating" | "awarded" | "expired" | "cancelled";

export interface TaskRFQ {
  rfq_id: string;
  originator_node_id: string;
  originator_session_id: string;
  task_text: string;
  constraints?: SwarmTaskConstraints;
  required_capabilities?: string[];
  bid_deadline_ms: number;
  max_rounds?: number;
  current_round: number;
  selection_criteria?: SelectionWeights;
  timestamp: string;
  nonce: string;
}

export interface BidObject {
  bid_id: string;
  rfq_id: string;
  bidder_node_id: string;
  estimated_cost_usd: number;
  estimated_duration_ms: number;
  estimated_tokens: number;
  privacy_guarantee?: "none" | "redacted" | "encrypted";
  reputation_bond?: number;
  capabilities_offered: string[];
  expiry: string;
  round: number;
  timestamp: string;
  nonce: string;
}

export interface AuctionRecord {
  rfq_id: string;
  status: AuctionStatus;
  rfq: TaskRFQ;
  bids: BidObject[];
  winning_bid_id?: string;
  winning_node_id?: string;
  rounds_completed: number;
  created_at: string;
  awarded_at?: string;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 5: Intelligent Delegation Paper Gaps
// ═══════════════════════════════════════════════════════════════════

// ─── Gap 1: Escrow Bonds ─────────────────────────────────────────

export type EscrowTransactionType = "deposit" | "hold" | "release" | "slash";

export interface EscrowTransaction {
  transaction_id: string;
  node_id: string;
  task_id?: string;
  type: EscrowTransactionType;
  amount: number;
  timestamp: string;
}

export interface EscrowAccount {
  node_id: string;
  balance: number;
  held: number;
  transactions: EscrowTransaction[];
}

export interface BondRequirement {
  min_bond_usd: number;
  slash_pct_on_violation: number;
  slash_pct_on_timeout: number;
}

// ─── Gap 2: Consensus Verification ──────────────────────────────

export type ConsensusRoundStatus = "open" | "evaluating" | "agreed" | "disagreed" | "expired";

export interface ConsensusRound {
  round_id: string;
  task_id: string;
  required_voters: number;
  required_agreement: number; // 0-1, e.g. 0.667
  votes: Map<string, { result_hash: string; outcome_score: number; timestamp: string }>;
  status: ConsensusRoundStatus;
  created_at: string;
  expires_at: string;
  outcome?: ConsensusOutcome;
}

export interface ConsensusOutcome {
  agreed: boolean;
  agreement_ratio: number;
  majority_result_hash: string;
  majority_count: number;
  dissenting_node_ids: string[];
}

// ─── Gap 3: Liability Firebreaks ─────────────────────────────────

export type FirebreakAction = "allow" | "halt" | "request_authority";

export type FirebreakLiabilityMode = "strict" | "permissive";

export interface FirebreakPolicy {
  base_max_depth: number;
  criticality_reduction: number;  // reduce max depth for high criticality
  reversibility_reduction: number; // reduce max depth for low reversibility
  mode: FirebreakLiabilityMode;   // strict = halt, permissive = request_authority
  min_depth: number;              // floor clamp (default 1)
}

export interface FirebreakDecision {
  action: FirebreakAction;
  effective_max_depth: number;
  current_depth: number;
  reason: string;
}

export const DEFAULT_FIREBREAK_POLICY: FirebreakPolicy = {
  base_max_depth: 3,
  criticality_reduction: 1,
  reversibility_reduction: 1,
  mode: "strict",
  min_depth: 1,
};

// ─── Gap 4: Human-vs-AI Routing ─────────────────────────────────

export interface RoutingFactors {
  criticality_score: number;   // 0-1
  reversibility_score: number; // 0-1 (1=highly reversible)
  verifiability_score: number; // 0-1 (1=highly verifiable)
  subjectivity_score: number;  // 0-1 (1=highly subjective)
  cost_benefit_score: number;  // 0-1 (1=high benefit)
}

export interface RoutingDecision {
  sub_task_id: string;
  target: "ai" | "human" | "any";
  confidence: number;
  factors: RoutingFactors;
  reason: string;
}

// ─── Gap 5: Behavioral Reputation ────────────────────────────────

export type BehavioralObservationType =
  | "transparency_high" | "transparency_low"
  | "safety_compliant" | "safety_violation"
  | "protocol_followed" | "protocol_violated"
  | "reasoning_clear" | "reasoning_opaque";

export interface BehavioralObservation {
  type: BehavioralObservationType;
  timestamp: string;
  evidence?: string;
}

export interface BehavioralMetrics {
  transparency: number;        // 0-1
  safety: number;              // 0-1
  protocol_compliance: number; // 0-1
  reasoning_clarity: number;   // 0-1
  composite_score: number;     // 0-1 weighted average
  observation_count: number;
}

// ─── Gap 6: Contract Renegotiation ───────────────────────────────

export type RenegotiationStatus = "pending" | "accepted" | "rejected";

export interface RenegotiationRequest {
  request_id: string;
  contract_id: string;
  requester_node_id: string;
  proposed_slo: Partial<ContractSLO>;
  reason: string;
  status: RenegotiationStatus;
  created_at: string;
  resolved_at?: string;
}

export interface RenegotiationOutcome {
  request_id: string;
  accepted: boolean;
  reason?: string;
  new_slo?: ContractSLO;
}

// ─── Gap 7: Cognitive Friction ───────────────────────────────────

export type FrictionLevel = "none" | "info" | "confirm" | "mandatory_human";

export interface FrictionFactors {
  criticality: number;    // 0-1
  irreversibility: number; // 0-1
  uncertainty: number;     // 0-1
  depth_ratio: number;     // 0-1
  trust_deficit: number;   // 0-1
}

export interface FrictionAssessment {
  level: FrictionLevel;
  composite_score: number;
  factors: FrictionFactors;
  reason: string;
}

export interface FrictionConfig {
  weights: {
    criticality: number;
    irreversibility: number;
    uncertainty: number;
    depth_ratio: number;
    trust_deficit: number;
  };
  thresholds: {
    info: number;
    confirm: number;
    mandatory_human: number;
  };
  anti_fatigue_window_ms: number;
  anti_fatigue_max_escalations: number;
}

export const DEFAULT_FRICTION_CONFIG: FrictionConfig = {
  weights: {
    criticality: 0.3,
    irreversibility: 0.25,
    uncertainty: 0.2,
    depth_ratio: 0.15,
    trust_deficit: 0.1,
  },
  thresholds: {
    info: 0.3,
    confirm: 0.6,
    mandatory_human: 0.85,
  },
  anti_fatigue_window_ms: 300000, // 5 minutes
  anti_fatigue_max_escalations: 5,
};

// ─── Gap 8: Sabotage Detection ───────────────────────────────────

export type SabotageIndicatorType =
  | "disproportionate_negative"
  | "review_bombing"
  | "collusion_cross_ref";

export interface FeedbackRecord {
  feedback_id: string;
  from_node_id: string;
  target_node_id: string;
  task_id: string;
  positive: boolean;
  comment?: string;
  timestamp: string;
}

export interface SabotageReport {
  report_id: string;
  indicator: SabotageIndicatorType;
  suspect_node_id: string;
  target_node_id: string;
  confidence: number;
  evidence: Record<string, unknown>;
  timestamp: string;
}

// ─── Gap 9: Checkpoint Serialization ─────────────────────────────

export interface TaskCheckpoint {
  checkpoint_id: string;
  task_id: string;
  peer_node_id: string;
  state: Record<string, unknown>;
  findings_so_far: number;
  tokens_used: number;
  cost_usd: number;
  duration_ms: number;
  timestamp: string;
}

// ─── Gap 10: Auction Guard ───────────────────────────────────────

export interface AuctionGuardConfig {
  max_bids_per_node_per_minute: number;
  commit_reveal_required: boolean;
  front_running_window_ms: number;
  front_running_threshold: number;  // 0-1, fraction of bids that follow pattern
}

export interface SealedBid {
  bid_id: string;
  rfq_id: string;
  bidder_node_id: string;
  commitment_hash: string;
  timestamp: string;
}

export interface BidCommitment {
  sealed_bid: SealedBid;
  revealed: boolean;
  reveal_timestamp?: string;
  revealed_bid?: BidObject;
}

export const DEFAULT_AUCTION_GUARD_CONFIG: AuctionGuardConfig = {
  max_bids_per_node_per_minute: 10,
  commit_reveal_required: false,
  front_running_window_ms: 2000,
  front_running_threshold: 0.7,
};

/**
 * Additional branch coverage tests for MetricsCollector.
 * Covers uncovered swarm event branches, edge cases in usage.recorded,
 * tool events, planner events, and the attach/detach lifecycle.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Registry } from "prom-client";
import { MetricsCollector } from "./metrics-collector.js";
import type { JournalEvent } from "@karnevil9/schemas";

function makeEvent(
  type: JournalEvent["type"],
  payload: Record<string, unknown> = {},
  overrides: Partial<JournalEvent> = {}
): JournalEvent {
  return {
    event_id: "evt-1",
    timestamp: new Date().toISOString(),
    session_id: "sess-1",
    type,
    payload,
    ...overrides,
  };
}

describe("MetricsCollector — additional branch coverage", () => {
  let collector: MetricsCollector;
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
    collector = new MetricsCollector({ registry, collectDefault: false });
  });

  // ─── Constructor branches ──────────────────────────────────────────

  describe("constructor options", () => {
    it("uses default registry and prefix when no config", () => {
      const c = new MetricsCollector();
      // Default prefix is "karnevil9_" — the registry should have metrics
      expect(c.getContentType()).toContain("text/plain");
    });

    it("uses custom prefix", async () => {
      const r = new Registry();
      const c = new MetricsCollector({ registry: r, prefix: "custom_", collectDefault: false });
      c.handleEvent(makeEvent("session.created"));
      const metrics = await r.getSingleMetricAsString("custom_sessions_total");
      expect(metrics).toContain('status="created"');
    });

    it("collects default metrics when collectDefault is not false", async () => {
      const r = new Registry();
      // collectDefault defaults to true; should not throw
      const c = new MetricsCollector({ registry: r });
      expect(c.getContentType()).toContain("text/plain");
    });
  });

  // ─── Attach / Detach ─────────────────────────────────────────────

  describe("attach and detach", () => {
    it("subscribes to journal events on attach", () => {
      const onFn = vi.fn().mockReturnValue(() => {});
      const mockJournal = { on: onFn } as any;
      collector.attach(mockJournal);
      expect(onFn).toHaveBeenCalledOnce();
    });

    it("unsubscribes on detach", () => {
      const unsubFn = vi.fn();
      const onFn = vi.fn().mockReturnValue(unsubFn);
      const mockJournal = { on: onFn } as any;
      collector.attach(mockJournal);
      collector.detach();
      expect(unsubFn).toHaveBeenCalledOnce();
    });

    it("detach is safe when not attached", () => {
      // Should not throw
      collector.detach();
    });

    it("re-attach detaches previous subscription first", () => {
      const unsub1 = vi.fn();
      const unsub2 = vi.fn();
      const journal1 = { on: vi.fn().mockReturnValue(unsub1) } as any;
      const journal2 = { on: vi.fn().mockReturnValue(unsub2) } as any;
      collector.attach(journal1);
      collector.attach(journal2);
      expect(unsub1).toHaveBeenCalledOnce();
    });
  });

  // ─── Swarm Delegation Events ─────────────────────────────────────

  describe("swarm delegation events", () => {
    it("tracks swarm.reputation_updated with trust_score", async () => {
      collector.handleEvent(
        makeEvent("swarm.reputation_updated", { peer_node_id: "peer-1", trust_score: 0.85 })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_trust_score");
      expect(metrics).toContain('peer_node_id="peer-1"');
      expect(metrics).toContain("0.85");
    });

    it("handles swarm.reputation_updated without trust_score", async () => {
      collector.handleEvent(
        makeEvent("swarm.reputation_updated", { peer_node_id: "peer-1" })
      );
      // Should not throw; gauge should not be updated
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_trust_score");
      expect(metrics).not.toContain("0.85");
    });

    it("tracks swarm.contract_created", async () => {
      collector.handleEvent(makeEvent("swarm.contract_created"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_contracts_total");
      expect(metrics).toContain('status="created"');
    });

    it("tracks swarm.contract_completed", async () => {
      collector.handleEvent(makeEvent("swarm.contract_completed"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_contracts_total");
      expect(metrics).toContain('status="completed"');
    });

    it("tracks swarm.contract_violated", async () => {
      collector.handleEvent(makeEvent("swarm.contract_violated"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_contracts_total");
      expect(metrics).toContain('status="violated"');
    });

    it("tracks swarm.task_redelegated", async () => {
      collector.handleEvent(makeEvent("swarm.task_redelegated"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_redelegations_total");
      expect(metrics).toContain(" 1");
    });

    it("tracks swarm.task_checkpoint_received", async () => {
      collector.handleEvent(makeEvent("swarm.task_checkpoint_received"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_checkpoints_total");
      expect(metrics).toContain('status="received"');
    });

    it("tracks swarm.task_checkpoint_missed", async () => {
      collector.handleEvent(makeEvent("swarm.task_checkpoint_missed"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_checkpoints_total");
      expect(metrics).toContain('status="missed"');
    });

    it("tracks swarm.budget_alert", async () => {
      collector.handleEvent(
        makeEvent("swarm.budget_alert", { metric: "tokens" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_budget_alerts_total");
      expect(metrics).toContain('metric="tokens"');
    });

    it("tracks swarm.task_cancelled", async () => {
      collector.handleEvent(makeEvent("swarm.task_cancelled"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_task_cancellations_total");
      expect(metrics).toContain(" 1");
    });

    it("tracks swarm.task_preempted", async () => {
      collector.handleEvent(makeEvent("swarm.task_preempted"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_preemptions_total");
      expect(metrics).toContain(" 1");
    });

    it("tracks swarm.attestation_chain_invalid with depth", async () => {
      collector.handleEvent(
        makeEvent("swarm.attestation_chain_invalid", { invalid_at_depth: 3 })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_delegation_depth");
      expect(metrics).toContain('le="3"');
    });

    it("handles swarm.attestation_chain_invalid without depth", async () => {
      collector.handleEvent(
        makeEvent("swarm.attestation_chain_invalid", {})
      );
      // Should not throw
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_delegation_depth");
      expect(metrics).toContain("karnevil9_swarm_delegation_depth_count 0");
    });

    it("tracks swarm.task_result_received with chain_depth", async () => {
      collector.handleEvent(
        makeEvent("swarm.task_result_received", { chain_depth: 2 })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_delegation_depth");
      expect(metrics).toContain('le="2"');
    });

    it("handles swarm.task_result_received without chain_depth", async () => {
      collector.handleEvent(
        makeEvent("swarm.task_result_received", {})
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_delegation_depth");
      expect(metrics).toContain("karnevil9_swarm_delegation_depth_count 0");
    });
  });

  // ─── Phase 3 Swarm Events ─────────────────────────────────────────

  describe("phase 3 swarm events", () => {
    it("tracks swarm.task_verified", async () => {
      collector.handleEvent(makeEvent("swarm.task_verified"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_verifications_total");
      expect(metrics).toContain('result="passed"');
    });

    it("tracks swarm.task_verification_failed", async () => {
      collector.handleEvent(makeEvent("swarm.task_verification_failed"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_verifications_total");
      expect(metrics).toContain('result="failed"');
    });

    it("tracks swarm.dispute_opened", async () => {
      collector.handleEvent(makeEvent("swarm.dispute_opened"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_disputes_total");
      expect(metrics).toContain('status="opened"');
    });

    it("tracks swarm.dispute_resolved", async () => {
      collector.handleEvent(
        makeEvent("swarm.dispute_resolved", { resolved_for: "delegator" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_disputes_total");
      expect(metrics).toContain('status="resolved_delegator"');
    });

    it("tracks swarm.task_decomposed with subtask_count", async () => {
      collector.handleEvent(
        makeEvent("swarm.task_decomposed", { subtask_count: 3, skip_delegation: false })
      );
      const decompMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_decompositions_total");
      expect(decompMetrics).toContain('skipped="false"');
      const subtaskMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_subtasks_per_decomposition");
      expect(subtaskMetrics).toContain('le="3"');
    });

    it("tracks swarm.task_decomposed with skip_delegation=true", async () => {
      collector.handleEvent(
        makeEvent("swarm.task_decomposed", { skip_delegation: true })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_decompositions_total");
      expect(metrics).toContain('skipped="true"');
    });

    it("tracks swarm.task_decomposed without subtask_count", async () => {
      collector.handleEvent(
        makeEvent("swarm.task_decomposed", {})
      );
      const subtaskMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_subtasks_per_decomposition");
      expect(subtaskMetrics).toContain("karnevil9_swarm_subtasks_per_decomposition_count 0");
    });

    it("tracks swarm.peer_redelegate_on_drift", async () => {
      collector.handleEvent(makeEvent("swarm.peer_redelegate_on_drift"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_reoptimizations_total");
      expect(metrics).toContain('action="redelegate"');
    });

    it("tracks swarm.anomaly_detected with quarantined_count", async () => {
      collector.handleEvent(
        makeEvent("swarm.anomaly_detected", { type: "timeout", severity: "high", quarantined_count: 2 })
      );
      const anomalyMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_anomalies_total");
      expect(anomalyMetrics).toContain('type="timeout"');
      expect(anomalyMetrics).toContain('severity="high"');
      const quarantineMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_quarantined_peers");
      expect(quarantineMetrics).toContain("2");
    });

    it("tracks swarm.anomaly_detected without quarantined_count", async () => {
      collector.handleEvent(
        makeEvent("swarm.anomaly_detected", { type: "latency", severity: "low" })
      );
      const anomalyMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_anomalies_total");
      expect(anomalyMetrics).toContain('type="latency"');
    });

    it("tracks swarm.data_access_violation", async () => {
      collector.handleEvent(makeEvent("swarm.data_access_violation"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_anomalies_total");
      expect(metrics).toContain('type="data_access_violation"');
      expect(metrics).toContain('severity="high"');
    });

    it("tracks swarm.monitoring_event_pushed with sse_connections", async () => {
      collector.handleEvent(
        makeEvent("swarm.monitoring_event_pushed", { event_type: "task_update", sse_connections: 5 })
      );
      const eventMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_monitoring_events_pushed");
      expect(eventMetrics).toContain('event_type="task_update"');
      const sseMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_sse_connections");
      expect(sseMetrics).toContain("5");
    });

    it("tracks swarm.monitoring_event_pushed without sse_connections", async () => {
      collector.handleEvent(
        makeEvent("swarm.monitoring_event_pushed", { event_type: "status" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_monitoring_events_pushed");
      expect(metrics).toContain('event_type="status"');
    });
  });

  // ─── Phase 4 Swarm Events ─────────────────────────────────────────

  describe("phase 4 swarm events", () => {
    it("tracks swarm.pareto_selection_completed", async () => {
      collector.handleEvent(
        makeEvent("swarm.pareto_selection_completed", { front_size: 5 })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_pareto_front_size");
      expect(metrics).toContain('le="5"');
    });

    it("handles swarm.pareto_selection_completed without front_size", async () => {
      collector.handleEvent(
        makeEvent("swarm.pareto_selection_completed", {})
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_pareto_front_size");
      expect(metrics).toContain("karnevil9_swarm_pareto_front_size_count 0");
    });

    it("tracks swarm.gaming_detected", async () => {
      collector.handleEvent(
        makeEvent("swarm.gaming_detected", { flag_type: "metric_inflation", severity: "medium" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_gaming_detected_total");
      expect(metrics).toContain('flag_type="metric_inflation"');
      expect(metrics).toContain('severity="medium"');
    });

    it("tracks swarm.monitoring_level_negotiated", async () => {
      collector.handleEvent(
        makeEvent("swarm.monitoring_level_negotiated", { level: "detailed" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_monitoring_level_negotiated_total");
      expect(metrics).toContain('level="detailed"');
    });

    it("tracks swarm.reversibility_escalation", async () => {
      collector.handleEvent(makeEvent("swarm.reversibility_escalation"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_reversibility_escalations_total");
      expect(metrics).toContain(" 1");
    });

    it("tracks swarm.root_cause_diagnosed", async () => {
      collector.handleEvent(
        makeEvent("swarm.root_cause_diagnosed", { root_cause: "network_partition", recommended_response: "retry" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_root_cause_diagnoses_total");
      expect(metrics).toContain('root_cause="network_partition"');
      expect(metrics).toContain('response="retry"');
    });

    it("tracks swarm.peer_credential_verified", async () => {
      collector.handleEvent(makeEvent("swarm.peer_credential_verified"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_credential_verifications_total");
      expect(metrics).toContain('result="verified"');
    });

    it("tracks swarm.peer_credential_rejected", async () => {
      collector.handleEvent(makeEvent("swarm.peer_credential_rejected"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_credential_verifications_total");
      expect(metrics).toContain('result="rejected"');
    });

    it("tracks swarm.credential_issued", async () => {
      collector.handleEvent(makeEvent("swarm.credential_issued"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_credential_verifications_total");
      expect(metrics).toContain('result="issued"');
    });

    it("tracks swarm.task_decomposed_recursive", async () => {
      collector.handleEvent(makeEvent("swarm.task_decomposed_recursive"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_proposals_generated_total");
      expect(metrics).toContain(" 1");
    });

    it("tracks swarm.proposals_generated", async () => {
      collector.handleEvent(makeEvent("swarm.proposals_generated"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_proposals_generated_total");
      expect(metrics).toContain(" 1");
    });

    it("tracks swarm.dct_created", async () => {
      collector.handleEvent(makeEvent("swarm.dct_created"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_dct_operations_total");
      expect(metrics).toContain('operation="created"');
    });

    it("tracks swarm.dct_attenuated", async () => {
      collector.handleEvent(makeEvent("swarm.dct_attenuated"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_dct_operations_total");
      expect(metrics).toContain('operation="attenuated"');
    });

    it("tracks swarm.dct_validated", async () => {
      collector.handleEvent(makeEvent("swarm.dct_validated"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_dct_operations_total");
      expect(metrics).toContain('operation="validated"');
    });

    it("tracks swarm.dct_validation_failed", async () => {
      collector.handleEvent(makeEvent("swarm.dct_validation_failed"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_dct_operations_total");
      expect(metrics).toContain('operation="validation_failed"');
    });

    it("tracks swarm.dct_revoked", async () => {
      collector.handleEvent(makeEvent("swarm.dct_revoked"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_dct_operations_total");
      expect(metrics).toContain('operation="revoked"');
    });

    it("tracks swarm.sybil_detected", async () => {
      collector.handleEvent(
        makeEvent("swarm.sybil_detected", { indicator: "ip_clustering" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_sybil_reports_total");
      expect(metrics).toContain('indicator="ip_clustering"');
    });

    it("tracks swarm.collusion_detected", async () => {
      collector.handleEvent(
        makeEvent("swarm.collusion_detected", { indicator: "vote_pattern" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_collusion_reports_total");
      expect(metrics).toContain('indicator="vote_pattern"');
    });

    it("handles swarm.proof_of_work_required silently", () => {
      // Should not throw
      collector.handleEvent(makeEvent("swarm.proof_of_work_required"));
    });

    it("handles swarm.proof_of_work_verified silently", () => {
      collector.handleEvent(makeEvent("swarm.proof_of_work_verified"));
    });

    it("tracks swarm.auction_created", async () => {
      collector.handleEvent(makeEvent("swarm.auction_created"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_auctions_total");
      expect(metrics).toContain('status="created"');
    });

    it("tracks swarm.bid_received", async () => {
      collector.handleEvent(makeEvent("swarm.bid_received"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_bids_received_total");
      expect(metrics).toContain(" 1");
    });

    it("tracks swarm.auction_awarded", async () => {
      collector.handleEvent(makeEvent("swarm.auction_awarded"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_auctions_total");
      expect(metrics).toContain('status="awarded"');
    });
  });

  // ─── Phase 5 Swarm Events ─────────────────────────────────────────

  describe("phase 5 swarm events", () => {
    it("tracks swarm.bond_held with amount", async () => {
      collector.handleEvent(
        makeEvent("swarm.bond_held", { amount: 1.5 })
      );
      const bondsMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_bonds_total");
      expect(bondsMetrics).toContain('type="held"');
      const amountMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_bond_amount_usd");
      expect(amountMetrics).toContain("1.5");
    });

    it("tracks swarm.bond_held without amount", async () => {
      collector.handleEvent(makeEvent("swarm.bond_held", {}));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_bonds_total");
      expect(metrics).toContain('type="held"');
    });

    it("tracks swarm.bond_released with amount", async () => {
      collector.handleEvent(
        makeEvent("swarm.bond_released", { amount: 2.0 })
      );
      const bondsMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_bonds_total");
      expect(bondsMetrics).toContain('type="released"');
      const amountMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_bond_amount_usd");
      expect(amountMetrics).toContain("2");
    });

    it("tracks swarm.bond_released without amount", async () => {
      collector.handleEvent(makeEvent("swarm.bond_released", {}));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_bonds_total");
      expect(metrics).toContain('type="released"');
    });

    it("tracks swarm.bond_slashed with slashed_amount", async () => {
      collector.handleEvent(
        makeEvent("swarm.bond_slashed", { slashed_amount: 0.5 })
      );
      const bondsMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_bonds_total");
      expect(bondsMetrics).toContain('type="slashed"');
      const amountMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_bond_amount_usd");
      expect(amountMetrics).toContain("0.5");
    });

    it("tracks swarm.bond_slashed without slashed_amount", async () => {
      collector.handleEvent(makeEvent("swarm.bond_slashed", {}));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_bonds_total");
      expect(metrics).toContain('type="slashed"');
    });

    it("tracks swarm.consensus_round_created", async () => {
      collector.handleEvent(makeEvent("swarm.consensus_round_created"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_consensus_rounds_total");
      expect(metrics).toContain('outcome="created"');
    });

    it("handles swarm.consensus_vote_received silently", () => {
      collector.handleEvent(makeEvent("swarm.consensus_vote_received"));
      // No counter incremented, should not throw
    });

    it("tracks swarm.consensus_reached with agreement_ratio", async () => {
      collector.handleEvent(
        makeEvent("swarm.consensus_reached", { agreement_ratio: 0.85 })
      );
      const roundsMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_consensus_rounds_total");
      expect(roundsMetrics).toContain('outcome="agreed"');
      const ratioMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_consensus_agreement_ratio");
      expect(ratioMetrics).toContain('le="0.9"');
    });

    it("tracks swarm.consensus_reached without agreement_ratio", async () => {
      collector.handleEvent(
        makeEvent("swarm.consensus_reached", {})
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_consensus_rounds_total");
      expect(metrics).toContain('outcome="agreed"');
    });

    it("tracks swarm.consensus_failed with agreement_ratio", async () => {
      collector.handleEvent(
        makeEvent("swarm.consensus_failed", { agreement_ratio: 0.3 })
      );
      const roundsMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_consensus_rounds_total");
      expect(roundsMetrics).toContain('outcome="disagreed"');
      const ratioMetrics = await registry.getSingleMetricAsString("karnevil9_swarm_consensus_agreement_ratio");
      expect(ratioMetrics).toContain('le="0.3"');
    });

    it("tracks swarm.consensus_failed without agreement_ratio", async () => {
      collector.handleEvent(
        makeEvent("swarm.consensus_failed", {})
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_consensus_rounds_total");
      expect(metrics).toContain('outcome="disagreed"');
    });

    it("tracks swarm.firebreak_triggered", async () => {
      collector.handleEvent(makeEvent("swarm.firebreak_triggered"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_firebreaks_total");
      expect(metrics).toContain('action="halt"');
    });

    it("tracks swarm.firebreak_authority_requested", async () => {
      collector.handleEvent(makeEvent("swarm.firebreak_authority_requested"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_firebreaks_total");
      expect(metrics).toContain('action="request_authority"');
    });

    it("tracks swarm.delegatee_routed", async () => {
      collector.handleEvent(
        makeEvent("swarm.delegatee_routed", { target: "preferred_peer" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_delegatee_routing_total");
      expect(metrics).toContain('target="preferred_peer"');
    });

    it("tracks swarm.human_delegation_requested", async () => {
      collector.handleEvent(makeEvent("swarm.human_delegation_requested"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_delegatee_routing_total");
      expect(metrics).toContain('target="human_requested"');
    });

    it("handles swarm.behavioral_observation_recorded silently", () => {
      collector.handleEvent(makeEvent("swarm.behavioral_observation_recorded"));
      // No direct metric; tracked via behavioral_score_updated
    });

    it("tracks swarm.behavioral_score_updated with score", async () => {
      collector.handleEvent(
        makeEvent("swarm.behavioral_score_updated", { node_id: "node-1", new_score: 0.92 })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_behavioral_score");
      expect(metrics).toContain('peer_node_id="node-1"');
      expect(metrics).toContain("0.92");
    });

    it("handles swarm.behavioral_score_updated without new_score", async () => {
      collector.handleEvent(
        makeEvent("swarm.behavioral_score_updated", { node_id: "node-1" })
      );
      // Should not throw; gauge not set
    });

    it("tracks swarm.contract_renegotiation_requested", async () => {
      collector.handleEvent(makeEvent("swarm.contract_renegotiation_requested"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_renegotiations_total");
      expect(metrics).toContain('outcome="requested"');
    });

    it("tracks swarm.contract_renegotiation_accepted", async () => {
      collector.handleEvent(makeEvent("swarm.contract_renegotiation_accepted"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_renegotiations_total");
      expect(metrics).toContain('outcome="accepted"');
    });

    it("tracks swarm.contract_renegotiation_rejected", async () => {
      collector.handleEvent(makeEvent("swarm.contract_renegotiation_rejected"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_renegotiations_total");
      expect(metrics).toContain('outcome="rejected"');
    });

    it("tracks swarm.friction_assessed", async () => {
      collector.handleEvent(
        makeEvent("swarm.friction_assessed", { level: "high" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_friction_assessments_total");
      expect(metrics).toContain('level="high"');
    });

    it("handles swarm.friction_escalation_triggered silently", () => {
      collector.handleEvent(makeEvent("swarm.friction_escalation_triggered"));
      // Already tracked by friction_assessed
    });

    it("tracks swarm.friction_approval_received", async () => {
      collector.handleEvent(makeEvent("swarm.friction_approval_received"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_friction_assessments_total");
      expect(metrics).toContain('level="approved"');
    });

    it("tracks swarm.sabotage_detected", async () => {
      collector.handleEvent(
        makeEvent("swarm.sabotage_detected", { indicator: "result_tampering" })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_sabotage_reports_total");
      expect(metrics).toContain('indicator="result_tampering"');
    });

    it("tracks swarm.feedback_discounted", async () => {
      collector.handleEvent(makeEvent("swarm.feedback_discounted"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_sabotage_reports_total");
      expect(metrics).toContain('indicator="discounted"');
    });

    it("tracks swarm.checkpoint_saved", async () => {
      collector.handleEvent(makeEvent("swarm.checkpoint_saved"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_checkpoints_saved_total");
      expect(metrics).toContain(" 1");
    });

    it("tracks swarm.task_resumed_from_checkpoint", async () => {
      collector.handleEvent(makeEvent("swarm.task_resumed_from_checkpoint"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_checkpoints_saved_total");
      expect(metrics).toContain(" 1");
    });

    it("handles swarm.bid_committed silently", () => {
      collector.handleEvent(makeEvent("swarm.bid_committed"));
      // Tracked via existing bid metrics
    });

    it("handles swarm.bid_revealed silently", () => {
      collector.handleEvent(makeEvent("swarm.bid_revealed"));
      // Tracked via existing bid metrics
    });

    it("tracks swarm.front_running_detected", async () => {
      collector.handleEvent(makeEvent("swarm.front_running_detected"));
      const metrics = await registry.getSingleMetricAsString("karnevil9_swarm_front_running_total");
      expect(metrics).toContain(" 1");
    });
  });

  // ─── Usage.recorded branch edge cases ──────────────────────────────

  describe("usage.recorded edge cases", () => {
    it("handles missing output_tokens", async () => {
      collector.handleEvent(
        makeEvent("usage.recorded", { model: "test", input_tokens: 100 })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_tokens_total");
      expect(metrics).toContain('type="input"');
    });

    it("handles missing input_tokens", async () => {
      collector.handleEvent(
        makeEvent("usage.recorded", { model: "test", output_tokens: 50 })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_tokens_total");
      expect(metrics).toContain('type="output"');
    });

    it("handles missing cost_usd", async () => {
      collector.handleEvent(
        makeEvent("usage.recorded", { model: "test", input_tokens: 100, output_tokens: 50 })
      );
      // Should not crash — cost counter not incremented
      const tokenMetrics = await registry.getSingleMetricAsString("karnevil9_tokens_total");
      expect(tokenMetrics).toBeDefined();
    });
  });

  // ─── Step tracking map eviction ────────────────────────────────────

  describe("tracking map bounds", () => {
    it("evicts oldest step tool name when max entries reached", () => {
      // This tests the MAX_TRACKING_ENTRIES eviction logic
      // We can't hit 10000, but we can verify the path is safe
      for (let i = 0; i < 5; i++) {
        collector.handleEvent(
          makeEvent("step.started", { step_id: `step-${i}`, tool_name: `tool-${i}` })
        );
      }
      // Complete some steps
      for (let i = 0; i < 3; i++) {
        collector.handleEvent(
          makeEvent("step.succeeded", { step_id: `step-${i}` })
        );
      }
    });

    it("handles step.succeeded without step_id", async () => {
      collector.handleEvent(makeEvent("step.succeeded", {}));
      const metrics = await registry.getSingleMetricAsString("karnevil9_steps_total");
      expect(metrics).toContain('tool_name="unknown"');
    });

    it("handles step.failed without step_id", async () => {
      collector.handleEvent(makeEvent("step.failed", {}));
      const metrics = await registry.getSingleMetricAsString("karnevil9_steps_total");
      expect(metrics).toContain('tool_name="unknown"');
    });
  });

  // ─── getRegistry ────────────────────────────────────────────────

  describe("getRegistry", () => {
    it("returns the internal registry", () => {
      expect(collector.getRegistry()).toBe(registry);
    });
  });

  // ─── extractToolName branches ──────────────────────────────────────

  describe("extractToolName edge cases", () => {
    it("falls back to step.tool_name when other fields missing", async () => {
      collector.handleEvent(
        makeEvent("step.started", {
          step_id: "s-nested",
          step: { tool_name: "nested-tool" },
        })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_steps_total");
      expect(metrics).toContain('tool_name="nested-tool"');
    });

    it("falls back to step.tool when step.tool_name is missing", async () => {
      collector.handleEvent(
        makeEvent("step.started", {
          step_id: "s-nested2",
          step: { tool: "bare-tool" },
        })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_steps_total");
      expect(metrics).toContain('tool_name="bare-tool"');
    });

    it("falls back to step.tool_ref.name when other step fields missing", async () => {
      collector.handleEvent(
        makeEvent("step.started", {
          step_id: "s-nested3",
          step: { tool_ref: { name: "ref-tool" } },
        })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_steps_total");
      expect(metrics).toContain('tool_name="ref-tool"');
    });

    it("returns unknown when step object has no tool info", async () => {
      collector.handleEvent(
        makeEvent("step.started", {
          step_id: "s-empty-step",
          step: {},
        })
      );
      const metrics = await registry.getSingleMetricAsString("karnevil9_steps_total");
      expect(metrics).toContain('tool_name="unknown"');
    });

    it("returns unknown when step_id is missing for step.started", async () => {
      collector.handleEvent(
        makeEvent("step.started", { tool_name: "test-tool" })
      );
      // tool_name is set but no step_id to track — should still record metric
      const metrics = await registry.getSingleMetricAsString("karnevil9_steps_total");
      expect(metrics).toContain('tool_name="test-tool"');
    });
  });

  // ─── journal.disk_warning without usage_pct ──────────────────────

  describe("journal.disk_warning edge cases", () => {
    it("increments warning counter even without usage_pct", async () => {
      collector.handleEvent(makeEvent("journal.disk_warning", {}));
      const metrics = await registry.getSingleMetricAsString("karnevil9_journal_disk_warnings_total");
      expect(metrics).toContain(" 1");
    });
  });
});

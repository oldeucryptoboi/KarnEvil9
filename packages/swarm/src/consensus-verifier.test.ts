import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConsensusVerifier, DEFAULT_CONSENSUS_CONFIG } from "./consensus-verifier.js";

// ─── Tests ────────────────────────────────────────────────────────────

describe("ConsensusVerifier", () => {
  let verifier: ConsensusVerifier;
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitEvent = vi.fn();
    verifier = new ConsensusVerifier(undefined, emitEvent);
  });

  // ─── createRound ──────────────────────────────────────────────────

  describe("createRound", () => {
    it("should create a round with correct defaults", () => {
      const round = verifier.createRound("task-1");

      expect(round.round_id).toBeDefined();
      expect(round.task_id).toBe("task-1");
      expect(round.required_voters).toBe(DEFAULT_CONSENSUS_CONFIG.default_required_voters);
      expect(round.required_agreement).toBe(DEFAULT_CONSENSUS_CONFIG.default_required_agreement);
      expect(round.status).toBe("open");
      expect(round.votes.size).toBe(0);
      expect(round.created_at).toBeDefined();
      expect(round.expires_at).toBeDefined();
    });

    it("should accept custom voters and agreement", () => {
      const round = verifier.createRound("task-2", 5, 0.8);

      expect(round.required_voters).toBe(5);
      expect(round.required_agreement).toBe(0.8);
    });

    it("should clamp requiredVoters to integer between 1 and 100", () => {
      // Fractional value should be floored
      const round1 = verifier.createRound("task-frac", 3.9);
      expect(round1.required_voters).toBe(3);

      // Value above 100 should be clamped to 100
      const round2 = verifier.createRound("task-huge", 500);
      expect(round2.required_voters).toBe(100);

      // Value of 0 should fall back to default
      const round3 = verifier.createRound("task-zero", 0);
      expect(round3.required_voters).toBe(DEFAULT_CONSENSUS_CONFIG.default_required_voters);

      // Negative value should fall back to default
      const round4 = verifier.createRound("task-neg", -5);
      expect(round4.required_voters).toBe(DEFAULT_CONSENSUS_CONFIG.default_required_voters);
    });

    it("should clamp requiredAgreement to 0-1 range", () => {
      // Value above 1 should be clamped to 1
      const round1 = verifier.createRound("task-over", 3, 1.5);
      expect(round1.required_agreement).toBe(1);

      // Negative value should be clamped to 0
      const round2 = verifier.createRound("task-under", 3, -0.5);
      expect(round2.required_agreement).toBe(0);

      // NaN should fall back to default
      const round3 = verifier.createRound("task-nan", 3, NaN);
      expect(round3.required_agreement).toBe(DEFAULT_CONSENSUS_CONFIG.default_required_agreement);

      // Infinity is not finite, so should fall back to default
      const round4 = verifier.createRound("task-inf", 3, Infinity);
      expect(round4.required_agreement).toBe(DEFAULT_CONSENSUS_CONFIG.default_required_agreement);
    });

    it("should use defaults for NaN requiredVoters", () => {
      const round = verifier.createRound("task-nan-voters", NaN);
      expect(round.required_voters).toBe(DEFAULT_CONSENSUS_CONFIG.default_required_voters);
    });
  });

  // ─── submitVerification ───────────────────────────────────────────

  describe("submitVerification", () => {
    it("should accept a valid vote", () => {
      const round = verifier.createRound("task-1");
      const result = verifier.submitVerification(round.round_id, "node-a", "hash-abc", 0.9);

      expect(result.accepted).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(round.votes.size).toBe(1);
    });

    it("should reject when round not found", () => {
      const result = verifier.submitVerification("nonexistent-round", "node-a", "hash-abc", 0.9);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("Round not found");
    });

    it("should reject duplicate node vote", () => {
      const round = verifier.createRound("task-1");
      verifier.submitVerification(round.round_id, "node-a", "hash-abc", 0.9);

      const result = verifier.submitVerification(round.round_id, "node-a", "hash-abc", 0.9);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("Node already voted in this round");
    });

    it("should reject vote on expired round", () => {
      // Create verifier with very short expiry
      verifier = new ConsensusVerifier({ round_expiry_ms: 1 }, emitEvent);
      const round = verifier.createRound("task-expired");

      // Force expiry by setting expires_at to the past
      (round as any).expires_at = new Date(Date.now() - 1000).toISOString();

      const result = verifier.submitVerification(round.round_id, "node-a", "hash-abc", 0.9);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("Round has expired");
      expect(round.status).toBe("expired");
    });

    it("should auto-evaluate when required_voters reached", () => {
      const round = verifier.createRound("task-auto", 3);

      verifier.submitVerification(round.round_id, "node-a", "hash-same", 0.9);
      verifier.submitVerification(round.round_id, "node-b", "hash-same", 0.85);
      const result = verifier.submitVerification(round.round_id, "node-c", "hash-same", 0.88);

      expect(result.accepted).toBe(true);
      expect(result.auto_evaluated).toBe(true);
      expect(round.status).not.toBe("open");
      expect(round.outcome).toBeDefined();
    });
  });

  // ─── evaluateRound ────────────────────────────────────────────────

  describe("evaluateRound", () => {
    it("should agree when 3/3 have same hash (ratio 1.0)", () => {
      const round = verifier.createRound("task-unanimous", 3);

      verifier.submitVerification(round.round_id, "node-a", "hash-same", 0.9);
      verifier.submitVerification(round.round_id, "node-b", "hash-same", 0.8);
      verifier.submitVerification(round.round_id, "node-c", "hash-same", 0.85);

      // Already auto-evaluated, but we check the outcome
      expect(round.outcome).toBeDefined();
      expect(round.outcome!.agreed).toBe(true);
      expect(round.outcome!.agreement_ratio).toBe(1.0);
      expect(round.outcome!.majority_count).toBe(3);
      expect(round.outcome!.dissenting_node_ids).toHaveLength(0);
    });

    it("should agree when 2/3 have same hash (0.667 meets threshold)", () => {
      // Use explicit required_agreement of 2/3 to avoid floating point mismatch
      const round = verifier.createRound("task-majority", 3, 2 / 3);

      verifier.submitVerification(round.round_id, "node-a", "hash-majority", 0.9);
      verifier.submitVerification(round.round_id, "node-b", "hash-majority", 0.8);
      verifier.submitVerification(round.round_id, "node-c", "hash-dissent", 0.5);

      expect(round.outcome).toBeDefined();
      expect(round.outcome!.agreed).toBe(true);
      const ratio = round.outcome!.agreement_ratio;
      expect(ratio).toBeCloseTo(0.667, 2);
      expect(round.outcome!.majority_count).toBe(2);
    });

    it("should disagree when 1/3 each have different hash", () => {
      const round = verifier.createRound("task-disagree", 3);

      verifier.submitVerification(round.round_id, "node-a", "hash-a", 0.9);
      verifier.submitVerification(round.round_id, "node-b", "hash-b", 0.8);
      verifier.submitVerification(round.round_id, "node-c", "hash-c", 0.7);

      expect(round.outcome).toBeDefined();
      expect(round.outcome!.agreed).toBe(false);
      expect(round.outcome!.agreement_ratio).toBeCloseTo(0.333, 2);
      expect(round.status).toBe("disagreed");
    });

    it("should correctly identify dissenting_node_ids", () => {
      const round = verifier.createRound("task-dissent", 3);

      verifier.submitVerification(round.round_id, "node-a", "hash-majority", 0.9);
      verifier.submitVerification(round.round_id, "node-b", "hash-majority", 0.8);
      verifier.submitVerification(round.round_id, "node-c", "hash-dissent", 0.5);

      expect(round.outcome!.dissenting_node_ids).toEqual(["node-c"]);
    });

    it("should return the most common hash as majority_result_hash", () => {
      const round = verifier.createRound("task-majority-hash", 4, 0.4);

      verifier.submitVerification(round.round_id, "node-a", "hash-common", 0.9);
      verifier.submitVerification(round.round_id, "node-b", "hash-common", 0.8);
      verifier.submitVerification(round.round_id, "node-c", "hash-rare-1", 0.7);
      verifier.submitVerification(round.round_id, "node-d", "hash-rare-2", 0.6);

      expect(round.outcome!.majority_result_hash).toBe("hash-common");
    });

    it("should not pass with 50% when required agreement is 2/3", () => {
      const round = verifier.createRound("task-50pct", 4, 0.667);

      verifier.submitVerification(round.round_id, "node-a", "hash-alpha", 0.9);
      verifier.submitVerification(round.round_id, "node-b", "hash-alpha", 0.85);
      verifier.submitVerification(round.round_id, "node-c", "hash-beta", 0.8);
      verifier.submitVerification(round.round_id, "node-d", "hash-beta", 0.75);

      expect(round.outcome!.agreed).toBe(false);
      expect(round.outcome!.agreement_ratio).toBe(0.5);
    });

    it("should evaluate with partial votes before all required are in", () => {
      const round = verifier.createRound("task-partial", 5, 0.5);

      verifier.submitVerification(round.round_id, "node-a", "hash-x", 0.9);
      verifier.submitVerification(round.round_id, "node-b", "hash-x", 0.8);

      // Manually evaluate before all 5 votes
      const outcome = verifier.evaluateRound(round.round_id);

      expect(outcome).toBeDefined();
      expect(outcome!.agreement_ratio).toBe(1.0);
      expect(outcome!.majority_count).toBe(2);
    });

    it("should handle round with 0 votes", () => {
      const round = verifier.createRound("task-empty", 3, 0.667);

      const outcome = verifier.evaluateRound(round.round_id);

      expect(outcome).toBeDefined();
      expect(outcome!.agreement_ratio).toBe(0);
      expect(outcome!.agreed).toBe(false);
      expect(outcome!.majority_result_hash).toBe("");
      expect(outcome!.majority_count).toBe(0);
      expect(outcome!.dissenting_node_ids).toHaveLength(0);
    });

    it("should return undefined for nonexistent round", () => {
      const outcome = verifier.evaluateRound("nonexistent");
      expect(outcome).toBeUndefined();
    });
  });

  // ─── sweepExpiredRounds ───────────────────────────────────────────

  describe("sweepExpiredRounds", () => {
    it("should mark open rounds past expiry", () => {
      verifier = new ConsensusVerifier({ round_expiry_ms: 1 }, emitEvent);
      const round = verifier.createRound("task-sweep");

      // Force expiry
      (round as any).expires_at = new Date(Date.now() - 1000).toISOString();

      const swept = verifier.sweepExpiredRounds();

      expect(swept).toBe(1);
      expect(round.status).toBe("expired");
    });

    it("should not touch already-evaluated rounds", () => {
      const round = verifier.createRound("task-evaluated", 1, 0.5);

      // Submit a vote to auto-evaluate
      verifier.submitVerification(round.round_id, "node-a", "hash-abc", 0.9);
      expect(round.status).not.toBe("open");

      // Force expires_at to past
      (round as any).expires_at = new Date(Date.now() - 1000).toISOString();

      const swept = verifier.sweepExpiredRounds();
      expect(swept).toBe(0);
    });
  });

  // ─── getRound & getRoundByTaskId ──────────────────────────────────

  describe("getRound", () => {
    it("should return created round", () => {
      const round = verifier.createRound("task-get");
      const fetched = verifier.getRound(round.round_id);

      expect(fetched).toBe(round);
    });

    it("should return undefined for unknown round", () => {
      expect(verifier.getRound("nonexistent")).toBeUndefined();
    });
  });

  describe("getRoundByTaskId", () => {
    it("should find round by task_id", () => {
      const round = verifier.createRound("task-find-me");
      const found = verifier.getRoundByTaskId("task-find-me");

      expect(found).toBe(round);
    });

    it("should return undefined when no round matches task_id", () => {
      verifier.createRound("task-other");
      expect(verifier.getRoundByTaskId("task-nonexistent")).toBeUndefined();
    });
  });

  // ─── Events ───────────────────────────────────────────────────────

  describe("events", () => {
    it("should emit consensus_round_created on createRound", () => {
      verifier.createRound("task-evt-create");

      expect(emitEvent).toHaveBeenCalledWith(
        "swarm.consensus_round_created",
        expect.objectContaining({
          task_id: "task-evt-create",
          required_voters: DEFAULT_CONSENSUS_CONFIG.default_required_voters,
          required_agreement: DEFAULT_CONSENSUS_CONFIG.default_required_agreement,
        }),
      );
    });

    it("should emit consensus_vote_received per vote", () => {
      const round = verifier.createRound("task-evt-vote");
      emitEvent.mockClear();

      verifier.submitVerification(round.round_id, "node-a", "hash-abc", 0.9);

      expect(emitEvent).toHaveBeenCalledWith(
        "swarm.consensus_vote_received",
        expect.objectContaining({
          round_id: round.round_id,
          node_id: "node-a",
          task_id: "task-evt-vote",
          votes_received: 1,
          required: 3,
        }),
      );
    });

    it("should emit consensus_reached when agreed", () => {
      const round = verifier.createRound("task-evt-agree", 2, 0.5);
      emitEvent.mockClear();

      verifier.submitVerification(round.round_id, "node-a", "hash-same", 0.9);
      verifier.submitVerification(round.round_id, "node-b", "hash-same", 0.8);

      expect(emitEvent).toHaveBeenCalledWith(
        "swarm.consensus_reached",
        expect.objectContaining({
          round_id: round.round_id,
          task_id: "task-evt-agree",
          agreement_ratio: 1.0,
          majority_count: 2,
          total_votes: 2,
        }),
      );
    });

    it("should emit consensus_failed when not agreed", () => {
      const round = verifier.createRound("task-evt-fail", 3, 0.8);
      emitEvent.mockClear();

      verifier.submitVerification(round.round_id, "node-a", "hash-a", 0.9);
      verifier.submitVerification(round.round_id, "node-b", "hash-b", 0.8);
      verifier.submitVerification(round.round_id, "node-c", "hash-c", 0.7);

      expect(emitEvent).toHaveBeenCalledWith(
        "swarm.consensus_failed",
        expect.objectContaining({
          round_id: round.round_id,
          task_id: "task-evt-fail",
          total_votes: 3,
        }),
      );
    });
  });

  // ─── roundCount ───────────────────────────────────────────────────

  describe("roundCount", () => {
    it("should track the number of rounds", () => {
      expect(verifier.roundCount).toBe(0);

      verifier.createRound("task-1");
      expect(verifier.roundCount).toBe(1);

      verifier.createRound("task-2");
      expect(verifier.roundCount).toBe(2);
    });
  });

  // ─── Partial votes ────────────────────────────────────────────────

  describe("partial votes", () => {
    it("should keep round open when fewer than required votes submitted", () => {
      const round = verifier.createRound("task-partial-open", 5);

      verifier.submitVerification(round.round_id, "node-a", "hash-abc", 0.9);
      verifier.submitVerification(round.round_id, "node-b", "hash-abc", 0.85);

      expect(round.status).toBe("open");
      expect(round.votes.size).toBe(2);
      expect(round.outcome).toBeUndefined();
    });
  });
});

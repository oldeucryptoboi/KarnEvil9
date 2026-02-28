import { randomUUID, } from "node:crypto";
import type { JournalEventType } from "@karnevil9/schemas";
import type { ConsensusRound, ConsensusOutcome } from "./types.js";

export interface ConsensusVerifierConfig {
  default_required_voters: number;
  default_required_agreement: number; // 0-1, e.g. 0.667
  round_expiry_ms: number;
}

export const DEFAULT_CONSENSUS_CONFIG: ConsensusVerifierConfig = {
  default_required_voters: 3,
  default_required_agreement: 0.667,
  round_expiry_ms: 300000, // 5 minutes
};

export class ConsensusVerifier {
  private config: ConsensusVerifierConfig;
  private rounds = new Map<string, ConsensusRound>();
  private emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;

  constructor(config?: Partial<ConsensusVerifierConfig>, emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void) {
    this.config = { ...DEFAULT_CONSENSUS_CONFIG, ...config };
    this.emitEvent = emitEvent;
  }

  createRound(taskId: string, requiredVoters?: number, requiredAgreement?: number): ConsensusRound {
    const roundId = randomUUID();
    const now = new Date();
    const round: ConsensusRound = {
      round_id: roundId,
      task_id: taskId,
      required_voters: requiredVoters ?? this.config.default_required_voters,
      required_agreement: requiredAgreement ?? this.config.default_required_agreement,
      votes: new Map(),
      status: "open",
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.config.round_expiry_ms).toISOString(),
    };

    this.rounds.set(roundId, round);

    this.emitEvent?.("swarm.consensus_round_created" as JournalEventType, {
      round_id: roundId,
      task_id: taskId,
      required_voters: round.required_voters,
      required_agreement: round.required_agreement,
    });

    return round;
  }

  submitVerification(roundId: string, nodeId: string, resultHash: string, outcomeScore: number): { accepted: boolean; reason?: string; auto_evaluated?: boolean } {
    const round = this.rounds.get(roundId);
    if (!round) return { accepted: false, reason: "Round not found" };
    if (round.status !== "open") return { accepted: false, reason: `Round status is ${round.status}` };

    // Check expiry
    if (Date.now() > new Date(round.expires_at).getTime()) {
      round.status = "expired";
      return { accepted: false, reason: "Round has expired" };
    }

    // Check duplicate
    if (round.votes.has(nodeId)) {
      return { accepted: false, reason: "Node already voted in this round" };
    }

    round.votes.set(nodeId, {
      result_hash: resultHash,
      outcome_score: outcomeScore,
      timestamp: new Date().toISOString(),
    });

    this.emitEvent?.("swarm.consensus_vote_received" as JournalEventType, {
      round_id: roundId,
      node_id: nodeId,
      task_id: round.task_id,
      votes_received: round.votes.size,
      required: round.required_voters,
    });

    // Auto-evaluate when all votes in
    if (round.votes.size >= round.required_voters) {
      this.evaluateRound(roundId);
      return { accepted: true, auto_evaluated: true };
    }

    return { accepted: true };
  }

  evaluateRound(roundId: string): ConsensusOutcome | undefined {
    const round = this.rounds.get(roundId);
    if (!round) return undefined;
    if (round.status !== "open" && round.status !== "evaluating") return round.outcome;

    round.status = "evaluating";

    // Count votes by result_hash
    const hashCounts = new Map<string, { count: number; voters: string[] }>();
    for (const [nodeId, vote] of round.votes) {
      if (!hashCounts.has(vote.result_hash)) {
        hashCounts.set(vote.result_hash, { count: 0, voters: [] });
      }
      const entry = hashCounts.get(vote.result_hash)!;
      entry.count++;
      entry.voters.push(nodeId);
    }

    // Find majority
    let majorityHash = "";
    let majorityCount = 0;
    let _majorityVoters: string[] = [];
    for (const [hash, entry] of hashCounts) {
      if (entry.count > majorityCount) {
        majorityHash = hash;
        majorityCount = entry.count;
        _majorityVoters = entry.voters;
      }
    }

    const total = round.votes.size;
    const agreementRatio = total > 0 ? majorityCount / total : 0;
    const agreed = agreementRatio >= round.required_agreement;

    // Find dissenters
    const dissentingNodeIds: string[] = [];
    for (const [nodeId, vote] of round.votes) {
      if (vote.result_hash !== majorityHash) {
        dissentingNodeIds.push(nodeId);
      }
    }

    const outcome: ConsensusOutcome = {
      agreed,
      agreement_ratio: agreementRatio,
      majority_result_hash: majorityHash,
      majority_count: majorityCount,
      dissenting_node_ids: dissentingNodeIds,
    };

    round.outcome = outcome;
    round.status = agreed ? "agreed" : "disagreed";

    if (agreed) {
      this.emitEvent?.("swarm.consensus_reached" as JournalEventType, {
        round_id: roundId,
        task_id: round.task_id,
        agreement_ratio: agreementRatio,
        majority_count: majorityCount,
        total_votes: total,
      });
    } else {
      this.emitEvent?.("swarm.consensus_failed" as JournalEventType, {
        round_id: roundId,
        task_id: round.task_id,
        agreement_ratio: agreementRatio,
        dissenting_count: dissentingNodeIds.length,
        total_votes: total,
      });
    }

    return outcome;
  }

  sweepExpiredRounds(): number {
    const now = Date.now();
    let swept = 0;
    for (const [roundId, round] of this.rounds) {
      if (round.status === "open" && now > new Date(round.expires_at).getTime()) {
        round.status = "expired";
        swept++;
      }
      // Delete terminal rounds older than 2x expiry window
      if (round.status !== "open" && round.status !== "evaluating") {
        const age = now - new Date(round.expires_at).getTime();
        if (age > this.config.round_expiry_ms) {
          this.rounds.delete(roundId);
        }
      }
    }
    return swept;
  }

  getRound(roundId: string): ConsensusRound | undefined {
    return this.rounds.get(roundId);
  }

  getRoundByTaskId(taskId: string): ConsensusRound | undefined {
    for (const round of this.rounds.values()) {
      if (round.task_id === taskId) return round;
    }
    return undefined;
  }

  get roundCount(): number {
    return this.rounds.size;
  }
}

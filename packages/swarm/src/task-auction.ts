import { randomUUID } from "node:crypto";
import type { JournalEventType } from "@karnevil9/schemas";
import type {
  TaskRFQ,
  BidObject,
  AuctionRecord,
  AuctionStatus,
  SwarmTaskConstraints,
  SelectionWeights,
} from "./types.js";
import { DEFAULT_SELECTION_WEIGHTS } from "./types.js";
import type { MeshManager } from "./mesh-manager.js";
import type { PeerTransport } from "./transport.js";
import type { ReputationStore } from "./reputation-store.js";
import type { EscrowManager } from "./escrow-manager.js";
import type { AuctionGuard } from "./auction-guard.js";

export interface TaskAuctionConfig {
  default_bid_deadline_ms: number;
  max_rounds: number;
  min_bids_to_award: number;
  bid_score_weights: SelectionWeights;
}

export const DEFAULT_AUCTION_CONFIG: TaskAuctionConfig = {
  default_bid_deadline_ms: 30000,
  max_rounds: 1,
  min_bids_to_award: 1,
  bid_score_weights: DEFAULT_SELECTION_WEIGHTS,
};

export class TaskAuction {
  private meshManager: MeshManager;
  private transport: PeerTransport;
  private reputationStore?: ReputationStore;
  private escrowManager?: EscrowManager;
  private auctionGuard?: AuctionGuard;
  private config: TaskAuctionConfig;
  private emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;
  private auctions = new Map<string, AuctionRecord>();

  constructor(params: {
    meshManager: MeshManager;
    transport: PeerTransport;
    reputationStore?: ReputationStore;
    auctionConfig?: Partial<TaskAuctionConfig>;
    emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;
  }) {
    this.meshManager = params.meshManager;
    this.transport = params.transport;
    this.reputationStore = params.reputationStore;
    this.config = { ...DEFAULT_AUCTION_CONFIG, ...params.auctionConfig };
    this.emitEvent = params.emitEvent;
  }

  setEscrowManager(mgr: EscrowManager): void {
    this.escrowManager = mgr;
  }

  setAuctionGuard(guard: AuctionGuard): void {
    this.auctionGuard = guard;
  }

  async createAuction(
    taskText: string,
    sessionId: string,
    constraints?: SwarmTaskConstraints,
    requiredCapabilities?: string[],
  ): Promise<AuctionRecord> {
    const rfqId = randomUUID();
    const identity = this.meshManager.getIdentity();

    const rfq: TaskRFQ = {
      rfq_id: rfqId,
      originator_node_id: identity.node_id,
      originator_session_id: sessionId,
      task_text: taskText,
      constraints,
      required_capabilities: requiredCapabilities,
      bid_deadline_ms: this.config.default_bid_deadline_ms,
      max_rounds: this.config.max_rounds,
      current_round: 1,
      selection_criteria: this.config.bid_score_weights,
      timestamp: new Date().toISOString(),
      nonce: randomUUID(),
    };

    const record: AuctionRecord = {
      rfq_id: rfqId,
      status: "open",
      rfq,
      bids: [],
      rounds_completed: 0,
      created_at: new Date().toISOString(),
    };

    this.auctions.set(rfqId, record);

    this.emitEvent?.("swarm.auction_created" as JournalEventType, {
      rfq_id: rfqId,
      task_text: taskText.slice(0, 200),
      bid_deadline_ms: rfq.bid_deadline_ms,
    });

    // Broadcast RFQ to all active peers
    await this.broadcastRFQ(rfq);

    // Update status to collecting
    record.status = "collecting";

    return record;
  }

  async broadcastRFQ(rfq: TaskRFQ): Promise<void> {
    const peers = this.meshManager.getActivePeers();
    await Promise.allSettled(
      peers.map((peer) =>
        this.transport.sendRFQ(peer.identity.api_url, rfq)
      ),
    );
  }

  receiveBid(bid: BidObject): { accepted: boolean; reason?: string } {
    const auction = this.auctions.get(bid.rfq_id);
    if (!auction) {
      return { accepted: false, reason: "Auction not found" };
    }

    if (auction.status !== "open" && auction.status !== "collecting") {
      return { accepted: false, reason: `Auction status is ${auction.status}, not accepting bids` };
    }

    // Check deadline
    const rfqTimestamp = new Date(auction.rfq.timestamp).getTime();
    if (Date.now() - rfqTimestamp > auction.rfq.bid_deadline_ms) {
      return { accepted: false, reason: "Bid deadline has passed" };
    }

    // Check for duplicate bidder
    if (auction.bids.some(b => b.bidder_node_id === bid.bidder_node_id && b.round === bid.round)) {
      return { accepted: false, reason: "Duplicate bid from same node in same round" };
    }

    // Auction guard: rate limit check
    if (this.auctionGuard) {
      const rateCheck = this.auctionGuard.checkBidRate(bid.bidder_node_id);
      if (!rateCheck.allowed) {
        return { accepted: false, reason: rateCheck.reason };
      }
    }

    // Escrow: hold bond if bid includes reputation_bond
    if (this.escrowManager && bid.reputation_bond && bid.reputation_bond > 0) {
      const holdResult = this.escrowManager.holdBond(
        `auction-${bid.rfq_id}-${bid.bidder_node_id}`,
        bid.bidder_node_id,
        bid.reputation_bond,
      );
      if (!holdResult.held) {
        return { accepted: false, reason: `Bond hold failed: ${holdResult.reason}` };
      }
    }

    auction.bids.push(bid);

    this.emitEvent?.("swarm.bid_received" as JournalEventType, {
      rfq_id: bid.rfq_id,
      bidder_node_id: bid.bidder_node_id,
      estimated_cost_usd: bid.estimated_cost_usd,
      estimated_duration_ms: bid.estimated_duration_ms,
      round: bid.round,
    });

    return { accepted: true };
  }

  evaluateBids(rfqId: string): BidObject | null {
    const auction = this.auctions.get(rfqId);
    if (!auction || auction.bids.length === 0) return null;

    auction.status = "evaluating";

    // Score each bid
    const scored = auction.bids.map(bid => ({
      bid,
      score: this.scoreBid(bid, auction.rfq),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.bid ?? null;
  }

  scoreBid(bid: BidObject, rfq: TaskRFQ): number {
    const w = rfq.selection_criteria ?? this.config.bid_score_weights;
    const maxCost = rfq.constraints?.max_cost_usd ?? 1.0;
    const maxDuration = rfq.constraints?.max_duration_ms ?? 300000;

    // Trust score from reputation store
    const trustScore = this.reputationStore
      ? this.reputationStore.getTrustScore(bid.bidder_node_id)
      : 0.5;

    // Cost score: lower is better
    const costScore = 1 - Math.min(Math.max(bid.estimated_cost_usd / maxCost, 0), 1);

    // Duration/latency score: lower is better
    const latencyScore = 1 - Math.min(Math.max(bid.estimated_duration_ms / maxDuration, 0), 1);

    // Capability score: intersection / required
    let capabilityScore = 1.0;
    const required = rfq.required_capabilities ?? [];
    if (required.length > 0) {
      const offered = new Set(bid.capabilities_offered);
      const intersection = required.filter(r => offered.has(r)).length;
      capabilityScore = intersection / required.length;
    }

    return (
      w.trust * trustScore +
      w.latency * latencyScore +
      w.cost * costScore +
      w.capability * capabilityScore
    );
  }

  async awardAuction(rfqId: string): Promise<{ awarded: boolean; winning_bid?: BidObject }> {
    const auction = this.auctions.get(rfqId);
    if (!auction) return { awarded: false };

    if (auction.bids.length < this.config.min_bids_to_award) {
      auction.status = "expired";
      return { awarded: false };
    }

    const winningBid = this.evaluateBids(rfqId);
    if (!winningBid) {
      auction.status = "expired";
      return { awarded: false };
    }

    auction.status = "awarded";
    auction.winning_bid_id = winningBid.bid_id;
    auction.winning_node_id = winningBid.bidder_node_id;
    auction.awarded_at = new Date().toISOString();
    auction.rounds_completed = auction.rfq.current_round;

    // Release bonds for non-winning bidders
    if (this.escrowManager) {
      for (const bid of auction.bids) {
        if (bid.bidder_node_id !== winningBid.bidder_node_id && bid.reputation_bond && bid.reputation_bond > 0) {
          this.escrowManager.releaseBond(`auction-${rfqId}-${bid.bidder_node_id}`);
        }
      }
    }

    this.emitEvent?.("swarm.auction_awarded" as JournalEventType, {
      rfq_id: rfqId,
      winning_bid_id: winningBid.bid_id,
      winning_node_id: winningBid.bidder_node_id,
      estimated_cost_usd: winningBid.estimated_cost_usd,
      total_bids: auction.bids.length,
    });

    return { awarded: true, winning_bid: winningBid };
  }

  cancelAuction(rfqId: string): boolean {
    const auction = this.auctions.get(rfqId);
    if (!auction) return false;
    if (auction.status === "awarded") return false;
    auction.status = "cancelled";
    return true;
  }

  getAuction(rfqId: string): AuctionRecord | undefined {
    return this.auctions.get(rfqId);
  }

  getActiveAuctions(): AuctionRecord[] {
    return [...this.auctions.values()].filter(
      a => a.status === "open" || a.status === "collecting" || a.status === "evaluating"
    );
  }

  cleanup(): number {
    let removed = 0;
    for (const [id, auction] of this.auctions) {
      if (auction.status === "awarded" || auction.status === "expired" || auction.status === "cancelled") {
        // Keep for 1 hour after completion
        const completedAt = auction.awarded_at ?? auction.created_at;
        if (Date.now() - new Date(completedAt).getTime() > 3600000) {
          this.auctions.delete(id);
          removed++;
        }
      }
    }
    return removed;
  }

  get size(): number {
    return this.auctions.size;
  }
}

import { createHash } from "node:crypto";
import type { JournalEventType } from "@karnevil9/schemas";
import type { AuctionGuardConfig, SealedBid, BidCommitment, BidObject } from "./types.js";
import { DEFAULT_AUCTION_GUARD_CONFIG } from "./types.js";

export class AuctionGuard {
  private config: AuctionGuardConfig;
  private commitments = new Map<string, BidCommitment>(); // bid_id -> commitment
  private bidTimestamps = new Map<string, number[]>(); // node_id -> timestamps
  private nodeTimelines = new Map<string, number[]>(); // node_id -> ordered bid timestamps for front-running
  private emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void;

  constructor(config?: Partial<AuctionGuardConfig>, emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => void) {
    this.config = { ...DEFAULT_AUCTION_GUARD_CONFIG, ...config };
    this.emitEvent = emitEvent;
  }

  static hashBid(bid: { rfq_id: string; bidder_node_id: string; estimated_cost_usd: number; estimated_duration_ms: number; nonce: string }): string {
    const canonical = JSON.stringify({
      rfq_id: bid.rfq_id,
      bidder_node_id: bid.bidder_node_id,
      estimated_cost_usd: bid.estimated_cost_usd,
      estimated_duration_ms: bid.estimated_duration_ms,
      nonce: bid.nonce,
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  commitBid(sealedBid: SealedBid): { accepted: boolean; reason?: string } {
    // Rate limit check
    const rateCheck = this.checkBidRate(sealedBid.bidder_node_id);
    if (!rateCheck.allowed) {
      return { accepted: false, reason: rateCheck.reason };
    }

    if (this.commitments.has(sealedBid.bid_id)) {
      return { accepted: false, reason: "Bid already committed" };
    }

    this.commitments.set(sealedBid.bid_id, {
      sealed_bid: sealedBid,
      revealed: false,
    });

    // Track timestamps for front-running detection
    const ts = new Date(sealedBid.timestamp).getTime();
    if (!this.nodeTimelines.has(sealedBid.bidder_node_id)) {
      this.nodeTimelines.set(sealedBid.bidder_node_id, []);
    }
    this.nodeTimelines.get(sealedBid.bidder_node_id)!.push(ts);

    this.emitEvent?.("swarm.bid_committed" as JournalEventType, {
      bid_id: sealedBid.bid_id,
      rfq_id: sealedBid.rfq_id,
      bidder_node_id: sealedBid.bidder_node_id,
    });

    return { accepted: true };
  }

  revealBid(bidId: string, bid: BidObject): { valid: boolean; reason?: string } {
    const commitment = this.commitments.get(bidId);
    if (!commitment) {
      return { valid: false, reason: "No commitment found for bid" };
    }
    if (commitment.revealed) {
      return { valid: false, reason: "Bid already revealed" };
    }

    // Verify hash
    const expectedHash = AuctionGuard.hashBid({
      rfq_id: bid.rfq_id,
      bidder_node_id: bid.bidder_node_id,
      estimated_cost_usd: bid.estimated_cost_usd,
      estimated_duration_ms: bid.estimated_duration_ms,
      nonce: bid.nonce,
    });

    if (expectedHash !== commitment.sealed_bid.commitment_hash) {
      return { valid: false, reason: "Hash mismatch — bid does not match commitment" };
    }

    commitment.revealed = true;
    commitment.reveal_timestamp = new Date().toISOString();
    commitment.revealed_bid = bid;

    this.emitEvent?.("swarm.bid_revealed" as JournalEventType, {
      bid_id: bidId,
      rfq_id: bid.rfq_id,
      bidder_node_id: bid.bidder_node_id,
    });

    return { valid: true };
  }

  checkBidRate(nodeId: string): { allowed: boolean; reason?: string } {
    const now = Date.now();
    if (!this.bidTimestamps.has(nodeId)) {
      this.bidTimestamps.set(nodeId, []);
    }
    const timestamps = this.bidTimestamps.get(nodeId)!;

    // Clean old entries (older than 1 minute)
    const cutoff = now - 60000;
    const recent = timestamps.filter(t => t > cutoff);
    this.bidTimestamps.set(nodeId, recent);

    if (recent.length >= this.config.max_bids_per_node_per_minute) {
      return { allowed: false, reason: `Rate limit: ${recent.length} bids in last minute (max ${this.config.max_bids_per_node_per_minute})` };
    }

    recent.push(now);
    return { allowed: true };
  }

  detectFrontRunning(rfqId: string): { detected: boolean; suspects: string[] } {
    // Collect all bid timestamps for this RFQ
    const rfqBids: Array<{ node_id: string; timestamp: number }> = [];
    for (const commitment of this.commitments.values()) {
      if (commitment.sealed_bid.rfq_id === rfqId) {
        rfqBids.push({
          node_id: commitment.sealed_bid.bidder_node_id,
          timestamp: new Date(commitment.sealed_bid.timestamp).getTime(),
        });
      }
    }

    if (rfqBids.length < 3) return { detected: false, suspects: [] };

    // Sort by timestamp
    rfqBids.sort((a, b) => a.timestamp - b.timestamp);

    // Check each node: what fraction of its bids arrive within window_ms after another node's bid?
    const suspects: string[] = [];
    const nodeIds = [...new Set(rfqBids.map(b => b.node_id))];

    for (const nodeId of nodeIds) {
      const nodeBids = rfqBids.filter(b => b.node_id === nodeId);
      const otherBids = rfqBids.filter(b => b.node_id !== nodeId);

      if (nodeBids.length === 0 || otherBids.length === 0) continue;

      let followCount = 0;
      for (const nb of nodeBids) {
        const followsOther = otherBids.some(ob =>
          nb.timestamp > ob.timestamp &&
          nb.timestamp - ob.timestamp <= this.config.front_running_window_ms
        );
        if (followsOther) followCount++;
      }

      const fraction = followCount / nodeBids.length;
      if (fraction >= this.config.front_running_threshold) {
        suspects.push(nodeId);
      }
    }

    if (suspects.length > 0) {
      this.emitEvent?.("swarm.front_running_detected" as JournalEventType, {
        rfq_id: rfqId,
        suspects,
        total_bids: rfqBids.length,
      });
    }

    return { detected: suspects.length > 0, suspects };
  }

  getCommitment(bidId: string): BidCommitment | undefined {
    return this.commitments.get(bidId);
  }

  get commitmentCount(): number {
    return this.commitments.size;
  }
}

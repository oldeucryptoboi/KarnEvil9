import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuctionGuard } from "./auction-guard.js";
import type { SealedBid, BidObject } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────

function makeSealedBid(overrides: Partial<SealedBid> = {}): SealedBid {
  return {
    bid_id: `bid-${Math.random().toString(36).slice(2, 8)}`,
    rfq_id: "rfq-1",
    bidder_node_id: "peer-1",
    commitment_hash: "abc123",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeBidObject(overrides: Partial<BidObject> = {}): BidObject {
  return {
    bid_id: `bid-${Math.random().toString(36).slice(2, 8)}`,
    rfq_id: "rfq-1",
    bidder_node_id: "peer-1",
    estimated_cost_usd: 0.05,
    estimated_duration_ms: 10000,
    estimated_tokens: 500,
    capabilities_offered: ["read-file"],
    expiry: new Date(Date.now() + 60000).toISOString(),
    round: 1,
    timestamp: new Date().toISOString(),
    nonce: "nonce-abc",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("AuctionGuard", () => {
  let guard: AuctionGuard;
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitEvent = vi.fn();
    guard = new AuctionGuard(undefined, emitEvent);
  });

  // ─── hashBid ──────────────────────────────────────────────────────

  describe("hashBid", () => {
    it("should be deterministic: same input produces same hash", () => {
      const input = {
        rfq_id: "rfq-1",
        bidder_node_id: "peer-1",
        estimated_cost_usd: 0.05,
        estimated_duration_ms: 10000,
        nonce: "nonce-abc",
      };

      const hash1 = AuctionGuard.hashBid(input);
      const hash2 = AuctionGuard.hashBid(input);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should produce different hash for different input", () => {
      const input1 = {
        rfq_id: "rfq-1",
        bidder_node_id: "peer-1",
        estimated_cost_usd: 0.05,
        estimated_duration_ms: 10000,
        nonce: "nonce-abc",
      };

      const input2 = {
        rfq_id: "rfq-1",
        bidder_node_id: "peer-1",
        estimated_cost_usd: 0.06,
        estimated_duration_ms: 10000,
        nonce: "nonce-abc",
      };

      expect(AuctionGuard.hashBid(input1)).not.toBe(AuctionGuard.hashBid(input2));
    });
  });

  // ─── commitBid ────────────────────────────────────────────────────

  describe("commitBid", () => {
    it("should accept a valid sealed bid", () => {
      const sealed = makeSealedBid();
      const result = guard.commitBid(sealed);

      expect(result.accepted).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("should reject duplicate bid_id", () => {
      const sealed = makeSealedBid({ bid_id: "bid-dup" });
      guard.commitBid(sealed);

      const result = guard.commitBid(sealed);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("Bid already committed");
    });
  });

  // ─── revealBid ────────────────────────────────────────────────────

  describe("revealBid", () => {
    it("should validate matching hash as valid", () => {
      const bid = makeBidObject({
        rfq_id: "rfq-1",
        bidder_node_id: "peer-1",
        estimated_cost_usd: 0.05,
        estimated_duration_ms: 10000,
        nonce: "nonce-abc",
      });

      const hash = AuctionGuard.hashBid({
        rfq_id: bid.rfq_id,
        bidder_node_id: bid.bidder_node_id,
        estimated_cost_usd: bid.estimated_cost_usd,
        estimated_duration_ms: bid.estimated_duration_ms,
        nonce: bid.nonce,
      });

      const sealed = makeSealedBid({
        bid_id: "bid-reveal",
        rfq_id: "rfq-1",
        bidder_node_id: "peer-1",
        commitment_hash: hash,
      });

      guard.commitBid(sealed);
      const result = guard.revealBid("bid-reveal", bid);

      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("should reject mismatched hash", () => {
      const sealed = makeSealedBid({
        bid_id: "bid-bad",
        commitment_hash: "wrong-hash-value",
      });

      guard.commitBid(sealed);

      const bid = makeBidObject({ nonce: "different-nonce" });
      const result = guard.revealBid("bid-bad", bid);

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Hash mismatch");
    });

    it("should reject when no commitment exists", () => {
      const bid = makeBidObject();
      const result = guard.revealBid("nonexistent-bid", bid);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("No commitment found for bid");
    });

    it("should reject already revealed bid", () => {
      const bid = makeBidObject({
        rfq_id: "rfq-1",
        bidder_node_id: "peer-1",
        estimated_cost_usd: 0.05,
        estimated_duration_ms: 10000,
        nonce: "nonce-abc",
      });

      const hash = AuctionGuard.hashBid({
        rfq_id: bid.rfq_id,
        bidder_node_id: bid.bidder_node_id,
        estimated_cost_usd: bid.estimated_cost_usd,
        estimated_duration_ms: bid.estimated_duration_ms,
        nonce: bid.nonce,
      });

      const sealed = makeSealedBid({
        bid_id: "bid-double-reveal",
        rfq_id: "rfq-1",
        bidder_node_id: "peer-1",
        commitment_hash: hash,
      });

      guard.commitBid(sealed);
      guard.revealBid("bid-double-reveal", bid);

      const result = guard.revealBid("bid-double-reveal", bid);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("Bid already revealed");
    });
  });

  // ─── checkBidRate ─────────────────────────────────────────────────

  describe("checkBidRate", () => {
    it("should allow bids under the rate limit", () => {
      const result = guard.checkBidRate("peer-1");
      expect(result.allowed).toBe(true);
    });

    it("should reject bids at the rate limit", () => {
      // Default is 10 bids per minute
      for (let i = 0; i < 10; i++) {
        guard.checkBidRate("peer-flood");
      }

      const result = guard.checkBidRate("peer-flood");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Rate limit");
    });

    it("should clean timestamps older than 1 minute", () => {
      // Set up guard with a low limit to make the test clear
      guard = new AuctionGuard({ max_bids_per_node_per_minute: 2 }, emitEvent);

      // Manually place old timestamps
      const oldTimestamp = Date.now() - 70000; // 70 seconds ago
      (guard as any).bidTimestamps.set("peer-old", [oldTimestamp, oldTimestamp]);

      // Should be allowed because old timestamps are cleaned
      const result = guard.checkBidRate("peer-old");
      expect(result.allowed).toBe(true);
    });
  });

  // ─── detectFrontRunning ───────────────────────────────────────────

  describe("detectFrontRunning", () => {
    it("should detect node whose bids consistently follow another within the window", () => {
      const baseTime = new Date("2026-02-19T12:00:00.000Z").getTime();

      // Node A bids first at regular intervals
      for (let i = 0; i < 4; i++) {
        guard.commitBid(makeSealedBid({
          bid_id: `bid-a-${i}`,
          rfq_id: "rfq-front",
          bidder_node_id: "node-a",
          timestamp: new Date(baseTime + i * 5000).toISOString(),
        }));
      }

      // Node B always bids 500ms after Node A (within 2s window)
      for (let i = 0; i < 4; i++) {
        guard.commitBid(makeSealedBid({
          bid_id: `bid-b-${i}`,
          rfq_id: "rfq-front",
          bidder_node_id: "node-b",
          timestamp: new Date(baseTime + i * 5000 + 500).toISOString(),
        }));
      }

      const result = guard.detectFrontRunning("rfq-front");

      expect(result.detected).toBe(true);
      expect(result.suspects).toContain("node-b");
    });

    it("should not detect front-running when bids are well-spaced", () => {
      const baseTime = new Date("2026-02-19T12:00:00.000Z").getTime();

      // Node A bids
      for (let i = 0; i < 3; i++) {
        guard.commitBid(makeSealedBid({
          bid_id: `bid-a-${i}`,
          rfq_id: "rfq-spaced",
          bidder_node_id: "node-a",
          timestamp: new Date(baseTime + i * 10000).toISOString(),
        }));
      }

      // Node B bids at completely different times (>2s apart from A)
      for (let i = 0; i < 3; i++) {
        guard.commitBid(makeSealedBid({
          bid_id: `bid-b-${i}`,
          rfq_id: "rfq-spaced",
          bidder_node_id: "node-b",
          timestamp: new Date(baseTime + i * 10000 + 5000).toISOString(),
        }));
      }

      const result = guard.detectFrontRunning("rfq-spaced");

      expect(result.detected).toBe(false);
      expect(result.suspects).toHaveLength(0);
    });

    it("should not detect front-running with fewer than 3 bids", () => {
      guard.commitBid(makeSealedBid({
        bid_id: "bid-lone-1",
        rfq_id: "rfq-small",
        bidder_node_id: "node-a",
      }));

      guard.commitBid(makeSealedBid({
        bid_id: "bid-lone-2",
        rfq_id: "rfq-small",
        bidder_node_id: "node-b",
      }));

      const result = guard.detectFrontRunning("rfq-small");

      expect(result.detected).toBe(false);
      expect(result.suspects).toHaveLength(0);
    });
  });

  // ─── Events ───────────────────────────────────────────────────────

  describe("events", () => {
    it("should emit bid_committed on commit", () => {
      const sealed = makeSealedBid({ bid_id: "bid-evt-1", rfq_id: "rfq-1", bidder_node_id: "peer-1" });
      guard.commitBid(sealed);

      expect(emitEvent).toHaveBeenCalledWith(
        "swarm.bid_committed",
        expect.objectContaining({
          bid_id: "bid-evt-1",
          rfq_id: "rfq-1",
          bidder_node_id: "peer-1",
        }),
      );
    });

    it("should emit bid_revealed on valid reveal", () => {
      const bid = makeBidObject({
        rfq_id: "rfq-1",
        bidder_node_id: "peer-1",
        estimated_cost_usd: 0.05,
        estimated_duration_ms: 10000,
        nonce: "nonce-evt",
      });

      const hash = AuctionGuard.hashBid({
        rfq_id: bid.rfq_id,
        bidder_node_id: bid.bidder_node_id,
        estimated_cost_usd: bid.estimated_cost_usd,
        estimated_duration_ms: bid.estimated_duration_ms,
        nonce: bid.nonce,
      });

      const sealed = makeSealedBid({
        bid_id: "bid-evt-reveal",
        rfq_id: "rfq-1",
        bidder_node_id: "peer-1",
        commitment_hash: hash,
      });

      guard.commitBid(sealed);
      emitEvent.mockClear();
      guard.revealBid("bid-evt-reveal", bid);

      expect(emitEvent).toHaveBeenCalledWith(
        "swarm.bid_revealed",
        expect.objectContaining({
          bid_id: "bid-evt-reveal",
          rfq_id: "rfq-1",
          bidder_node_id: "peer-1",
        }),
      );
    });

    it("should emit front_running_detected when suspects found", () => {
      const baseTime = new Date("2026-02-19T12:00:00.000Z").getTime();

      // Node A bids first
      for (let i = 0; i < 4; i++) {
        guard.commitBid(makeSealedBid({
          bid_id: `bid-fr-a-${i}`,
          rfq_id: "rfq-fr-evt",
          bidder_node_id: "node-a",
          timestamp: new Date(baseTime + i * 5000).toISOString(),
        }));
      }

      // Node B follows closely
      for (let i = 0; i < 4; i++) {
        guard.commitBid(makeSealedBid({
          bid_id: `bid-fr-b-${i}`,
          rfq_id: "rfq-fr-evt",
          bidder_node_id: "node-b",
          timestamp: new Date(baseTime + i * 5000 + 500).toISOString(),
        }));
      }

      emitEvent.mockClear();
      guard.detectFrontRunning("rfq-fr-evt");

      expect(emitEvent).toHaveBeenCalledWith(
        "swarm.front_running_detected",
        expect.objectContaining({
          rfq_id: "rfq-fr-evt",
          suspects: expect.arrayContaining(["node-b"]),
        }),
      );
    });
  });

  // ─── getCommitment & commitmentCount ──────────────────────────────

  describe("getCommitment", () => {
    it("should return stored commitment", () => {
      const sealed = makeSealedBid({ bid_id: "bid-get" });
      guard.commitBid(sealed);

      const commitment = guard.getCommitment("bid-get");

      expect(commitment).toBeDefined();
      expect(commitment!.sealed_bid.bid_id).toBe("bid-get");
      expect(commitment!.revealed).toBe(false);
    });
  });

  describe("commitmentCount", () => {
    it("should track the number of commitments", () => {
      expect(guard.commitmentCount).toBe(0);

      guard.commitBid(makeSealedBid({ bid_id: "bid-cnt-1" }));
      expect(guard.commitmentCount).toBe(1);

      guard.commitBid(makeSealedBid({ bid_id: "bid-cnt-2" }));
      expect(guard.commitmentCount).toBe(2);
    });
  });

  // ─── Custom config ────────────────────────────────────────────────

  describe("custom config", () => {
    it("should respect custom max_bids_per_node_per_minute", () => {
      guard = new AuctionGuard({ max_bids_per_node_per_minute: 2 }, emitEvent);

      guard.checkBidRate("peer-custom");
      guard.checkBidRate("peer-custom");
      const result = guard.checkBidRate("peer-custom");

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Rate limit");
    });
  });
});

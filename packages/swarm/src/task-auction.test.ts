import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskAuction, DEFAULT_AUCTION_CONFIG } from "./task-auction.js";
import type { MeshManager } from "./mesh-manager.js";
import type { PeerTransport } from "./transport.js";
import type { ReputationStore } from "./reputation-store.js";
import type { BidObject, PeerEntry } from "./types.js";

// ─── Helpers ──────────────────────────────────────────────────────────

function makeMockMeshManager(peers: PeerEntry[] = []): MeshManager {
  return {
    getIdentity: vi.fn().mockReturnValue({
      node_id: "local-node",
      display_name: "Local",
      api_url: "http://localhost:3100",
      capabilities: [],
      version: "0.1.0",
    }),
    getActivePeers: vi.fn().mockReturnValue(peers),
  } as unknown as MeshManager;
}

function makeMockTransport(): PeerTransport {
  return {
    sendRFQ: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
  } as unknown as PeerTransport;
}

function makeMockReputationStore(scores: Record<string, number> = {}): ReputationStore {
  return {
    getTrustScore: vi.fn((nodeId: string) => scores[nodeId] ?? 0.5),
  } as unknown as ReputationStore;
}

function makePeer(id: string, apiUrl?: string): PeerEntry {
  return {
    identity: {
      node_id: id,
      display_name: `Node ${id}`,
      api_url: apiUrl ?? `http://${id}:3100`,
      capabilities: ["read-file"],
      version: "0.1.0",
    },
    status: "active",
    last_heartbeat_at: new Date().toISOString(),
    last_latency_ms: 50,
    consecutive_failures: 0,
    joined_at: new Date().toISOString(),
  };
}

function makeBid(overrides: Partial<BidObject> = {}): BidObject {
  return {
    bid_id: `bid-${Math.random().toString(36).slice(2, 8)}`,
    rfq_id: "rfq-placeholder",
    bidder_node_id: "peer-1",
    estimated_cost_usd: 0.05,
    estimated_duration_ms: 10000,
    estimated_tokens: 500,
    capabilities_offered: ["read-file"],
    expiry: new Date(Date.now() + 60000).toISOString(),
    round: 1,
    timestamp: new Date().toISOString(),
    nonce: `nonce-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("TaskAuction", () => {
  let mockMeshManager: MeshManager;
  let mockTransport: PeerTransport;
  let mockReputationStore: ReputationStore;
  let emitEvent: ReturnType<typeof vi.fn>;
  let auction: TaskAuction;

  beforeEach(() => {
    mockMeshManager = makeMockMeshManager([]);
    mockTransport = makeMockTransport();
    mockReputationStore = makeMockReputationStore();
    emitEvent = vi.fn();

    auction = new TaskAuction({
      meshManager: mockMeshManager,
      transport: mockTransport,
      reputationStore: mockReputationStore,
      emitEvent,
    });
  });

  // ─── createAuction ──────────────────────────────────────────────────

  describe("createAuction", () => {
    it("should create an auction record with collecting status", async () => {
      const record = await auction.createAuction("Analyze data", "session-1");

      expect(record.rfq_id).toBeDefined();
      expect(record.status).toBe("collecting");
      expect(record.rfq.task_text).toBe("Analyze data");
      expect(record.rfq.originator_node_id).toBe("local-node");
      expect(record.rfq.originator_session_id).toBe("session-1");
      expect(record.bids).toHaveLength(0);
      expect(record.rounds_completed).toBe(0);
    });

    it("should use default bid deadline from config", async () => {
      const record = await auction.createAuction("Task", "session-1");
      expect(record.rfq.bid_deadline_ms).toBe(DEFAULT_AUCTION_CONFIG.default_bid_deadline_ms);
    });

    it("should pass constraints and required capabilities to the RFQ", async () => {
      const constraints = { max_cost_usd: 0.5, max_duration_ms: 60000 };
      const caps = ["shell-exec", "read-file"];

      const record = await auction.createAuction("Task", "session-1", constraints, caps);

      expect(record.rfq.constraints).toEqual(constraints);
      expect(record.rfq.required_capabilities).toEqual(caps);
    });

    it("should broadcast RFQ to all active peers", async () => {
      const peers = [makePeer("peer-1"), makePeer("peer-2")];
      mockMeshManager = makeMockMeshManager(peers);
      auction = new TaskAuction({
        meshManager: mockMeshManager,
        transport: mockTransport,
        emitEvent,
      });

      await auction.createAuction("Task", "session-1");

      expect(mockTransport.sendRFQ).toHaveBeenCalledTimes(2);
      expect(mockTransport.sendRFQ).toHaveBeenCalledWith(
        "http://peer-1:3100",
        expect.objectContaining({ task_text: "Task" }),
      );
      expect(mockTransport.sendRFQ).toHaveBeenCalledWith(
        "http://peer-2:3100",
        expect.objectContaining({ task_text: "Task" }),
      );
    });

    it("should emit auction_created event", async () => {
      await auction.createAuction("Analyze data", "session-1");

      expect(emitEvent).toHaveBeenCalledWith(
        "swarm.auction_created",
        expect.objectContaining({
          rfq_id: expect.any(String),
          task_text: "Analyze data",
          bid_deadline_ms: DEFAULT_AUCTION_CONFIG.default_bid_deadline_ms,
        }),
      );
    });

    it("should increment size after creating an auction", async () => {
      expect(auction.size).toBe(0);
      await auction.createAuction("Task 1", "session-1");
      expect(auction.size).toBe(1);
      await auction.createAuction("Task 2", "session-2");
      expect(auction.size).toBe(2);
    });
  });

  // ─── broadcastRFQ ───────────────────────────────────────────────────

  describe("broadcastRFQ", () => {
    it("should send RFQ to all active peers via transport", async () => {
      const peers = [makePeer("peer-a"), makePeer("peer-b"), makePeer("peer-c")];
      mockMeshManager = makeMockMeshManager(peers);
      auction = new TaskAuction({
        meshManager: mockMeshManager,
        transport: mockTransport,
      });

      const record = await auction.createAuction("Task", "session-1");

      // createAuction calls broadcastRFQ internally
      expect(mockTransport.sendRFQ).toHaveBeenCalledTimes(3);
    });

    it("should handle zero peers gracefully", async () => {
      await auction.createAuction("Task", "session-1");
      // No peers, no calls
      expect(mockTransport.sendRFQ).not.toHaveBeenCalled();
    });
  });

  // ─── receiveBid ─────────────────────────────────────────────────────

  describe("receiveBid", () => {
    it("should accept a valid bid for a collecting auction", async () => {
      const record = await auction.createAuction("Task", "session-1");
      const bid = makeBid({ rfq_id: record.rfq_id, bidder_node_id: "peer-1" });

      const result = auction.receiveBid(bid);

      expect(result.accepted).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(record.bids).toHaveLength(1);
      expect(record.bids[0]).toBe(bid);
    });

    it("should reject bid for unknown auction", () => {
      const bid = makeBid({ rfq_id: "nonexistent-rfq" });
      const result = auction.receiveBid(bid);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("Auction not found");
    });

    it("should reject bid past deadline", async () => {
      auction = new TaskAuction({
        meshManager: mockMeshManager,
        transport: mockTransport,
        auctionConfig: { default_bid_deadline_ms: 1 },
      });

      const record = await auction.createAuction("Task", "session-1");

      // Wait for deadline to pass
      await new Promise((r) => setTimeout(r, 10));

      const bid = makeBid({ rfq_id: record.rfq_id });
      const result = auction.receiveBid(bid);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("Bid deadline has passed");
    });

    it("should reject duplicate bidder in same round", async () => {
      const record = await auction.createAuction("Task", "session-1");

      const bid1 = makeBid({ rfq_id: record.rfq_id, bidder_node_id: "peer-1", round: 1 });
      const bid2 = makeBid({ rfq_id: record.rfq_id, bidder_node_id: "peer-1", round: 1 });

      auction.receiveBid(bid1);
      const result = auction.receiveBid(bid2);

      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("Duplicate bid from same node in same round");
    });

    it("should allow same bidder in different rounds", async () => {
      const record = await auction.createAuction("Task", "session-1");

      const bid1 = makeBid({ rfq_id: record.rfq_id, bidder_node_id: "peer-1", round: 1 });
      const bid2 = makeBid({ rfq_id: record.rfq_id, bidder_node_id: "peer-1", round: 2 });

      const r1 = auction.receiveBid(bid1);
      const r2 = auction.receiveBid(bid2);

      expect(r1.accepted).toBe(true);
      expect(r2.accepted).toBe(true);
      expect(record.bids).toHaveLength(2);
    });

    it("should reject bid when auction status is not open or collecting", async () => {
      const record = await auction.createAuction("Task", "session-1");
      const bid1 = makeBid({ rfq_id: record.rfq_id, bidder_node_id: "peer-1" });
      auction.receiveBid(bid1);

      // Award the auction (transitions status to awarded)
      await auction.awardAuction(record.rfq_id);

      const bid2 = makeBid({ rfq_id: record.rfq_id, bidder_node_id: "peer-2" });
      const result = auction.receiveBid(bid2);

      expect(result.accepted).toBe(false);
      expect(result.reason).toContain("not accepting bids");
    });

    it("should emit bid_received event on accepted bid", async () => {
      const record = await auction.createAuction("Task", "session-1");
      const bid = makeBid({ rfq_id: record.rfq_id, bidder_node_id: "peer-1" });

      auction.receiveBid(bid);

      expect(emitEvent).toHaveBeenCalledWith(
        "swarm.bid_received",
        expect.objectContaining({
          rfq_id: record.rfq_id,
          bidder_node_id: "peer-1",
          estimated_cost_usd: bid.estimated_cost_usd,
          estimated_duration_ms: bid.estimated_duration_ms,
          round: bid.round,
        }),
      );
    });
  });

  // ─── evaluateBids ───────────────────────────────────────────────────

  describe("evaluateBids", () => {
    it("should return null when no bids exist", async () => {
      const record = await auction.createAuction("Task", "session-1");
      const best = auction.evaluateBids(record.rfq_id);
      expect(best).toBeNull();
    });

    it("should return null for unknown auction", () => {
      const best = auction.evaluateBids("nonexistent-rfq");
      expect(best).toBeNull();
    });

    it("should return the highest-scored bid", async () => {
      mockReputationStore = makeMockReputationStore({
        "peer-cheap": 0.8,
        "peer-expensive": 0.3,
      });
      auction = new TaskAuction({
        meshManager: mockMeshManager,
        transport: mockTransport,
        reputationStore: mockReputationStore,
        emitEvent,
      });

      const record = await auction.createAuction("Task", "session-1", {
        max_cost_usd: 1.0,
        max_duration_ms: 60000,
      });

      // Cheap + high trust peer
      auction.receiveBid(makeBid({
        rfq_id: record.rfq_id,
        bidder_node_id: "peer-cheap",
        estimated_cost_usd: 0.1,
        estimated_duration_ms: 5000,
      }));

      // Expensive + low trust peer
      auction.receiveBid(makeBid({
        rfq_id: record.rfq_id,
        bidder_node_id: "peer-expensive",
        estimated_cost_usd: 0.9,
        estimated_duration_ms: 50000,
      }));

      const best = auction.evaluateBids(record.rfq_id);

      expect(best).toBeDefined();
      expect(best!.bidder_node_id).toBe("peer-cheap");
    });

    it("should transition auction status to evaluating", async () => {
      const record = await auction.createAuction("Task", "session-1");
      auction.receiveBid(makeBid({ rfq_id: record.rfq_id, bidder_node_id: "peer-1" }));

      auction.evaluateBids(record.rfq_id);

      expect(record.status).toBe("evaluating");
    });
  });

  // ─── scoreBid ───────────────────────────────────────────────────────

  describe("scoreBid", () => {
    it("should produce higher score for lower cost", async () => {
      const record = await auction.createAuction("Task", "session-1", {
        max_cost_usd: 1.0,
        max_duration_ms: 60000,
      });

      const cheapBid = makeBid({ estimated_cost_usd: 0.1, estimated_duration_ms: 10000 });
      const expensiveBid = makeBid({ estimated_cost_usd: 0.9, estimated_duration_ms: 10000 });

      const cheapScore = auction.scoreBid(cheapBid, record.rfq);
      const expensiveScore = auction.scoreBid(expensiveBid, record.rfq);

      expect(cheapScore).toBeGreaterThan(expensiveScore);
    });

    it("should produce higher score for lower duration", async () => {
      const record = await auction.createAuction("Task", "session-1", {
        max_cost_usd: 1.0,
        max_duration_ms: 60000,
      });

      const fastBid = makeBid({ estimated_cost_usd: 0.5, estimated_duration_ms: 5000 });
      const slowBid = makeBid({ estimated_cost_usd: 0.5, estimated_duration_ms: 55000 });

      const fastScore = auction.scoreBid(fastBid, record.rfq);
      const slowScore = auction.scoreBid(slowBid, record.rfq);

      expect(fastScore).toBeGreaterThan(slowScore);
    });

    it("should incorporate trust score from reputation store", async () => {
      mockReputationStore = makeMockReputationStore({
        "trusted-peer": 0.95,
        "untrusted-peer": 0.1,
      });
      auction = new TaskAuction({
        meshManager: mockMeshManager,
        transport: mockTransport,
        reputationStore: mockReputationStore,
      });

      const record = await auction.createAuction("Task", "session-1", {
        max_cost_usd: 1.0,
        max_duration_ms: 60000,
      });

      const trustedBid = makeBid({ bidder_node_id: "trusted-peer", estimated_cost_usd: 0.5, estimated_duration_ms: 30000 });
      const untrustedBid = makeBid({ bidder_node_id: "untrusted-peer", estimated_cost_usd: 0.5, estimated_duration_ms: 30000 });

      const trustedScore = auction.scoreBid(trustedBid, record.rfq);
      const untrustedScore = auction.scoreBid(untrustedBid, record.rfq);

      expect(trustedScore).toBeGreaterThan(untrustedScore);
    });

    it("should score capability match correctly", async () => {
      const record = await auction.createAuction(
        "Task", "session-1",
        { max_cost_usd: 1.0, max_duration_ms: 60000 },
        ["shell-exec", "read-file", "http-request"],
      );

      const fullMatchBid = makeBid({
        bidder_node_id: "peer-full",
        capabilities_offered: ["shell-exec", "read-file", "http-request"],
        estimated_cost_usd: 0.5,
        estimated_duration_ms: 30000,
      });

      const partialMatchBid = makeBid({
        bidder_node_id: "peer-partial",
        capabilities_offered: ["read-file"],
        estimated_cost_usd: 0.5,
        estimated_duration_ms: 30000,
      });

      const fullScore = auction.scoreBid(fullMatchBid, record.rfq);
      const partialScore = auction.scoreBid(partialMatchBid, record.rfq);

      expect(fullScore).toBeGreaterThan(partialScore);
    });

    it("should default trust to 0.5 when no reputation store is provided", async () => {
      auction = new TaskAuction({
        meshManager: mockMeshManager,
        transport: mockTransport,
        // No reputationStore
      });

      const record = await auction.createAuction("Task", "session-1", {
        max_cost_usd: 1.0,
        max_duration_ms: 60000,
      });

      const bid = makeBid({ estimated_cost_usd: 0.5, estimated_duration_ms: 30000 });
      const score = auction.scoreBid(bid, record.rfq);

      // With default 0.5 trust, 0.5 cost ratio, 0.5 latency ratio, 1.0 capability (no reqs)
      // trust=0.4*0.5=0.2, latency=0.2*0.5=0.1, cost=0.2*0.5=0.1, capability=0.2*1.0=0.2 => 0.6
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  // ─── awardAuction ───────────────────────────────────────────────────

  describe("awardAuction", () => {
    it("should award to best bidder and update status", async () => {
      const record = await auction.createAuction("Task", "session-1");
      auction.receiveBid(makeBid({
        rfq_id: record.rfq_id,
        bidder_node_id: "peer-1",
        bid_id: "bid-winner",
      }));

      const result = await auction.awardAuction(record.rfq_id);

      expect(result.awarded).toBe(true);
      expect(result.winning_bid).toBeDefined();
      expect(result.winning_bid!.bidder_node_id).toBe("peer-1");
      expect(record.status).toBe("awarded");
      expect(record.winning_bid_id).toBe("bid-winner");
      expect(record.winning_node_id).toBe("peer-1");
      expect(record.awarded_at).toBeDefined();
    });

    it("should fail when min_bids_to_award is not met", async () => {
      auction = new TaskAuction({
        meshManager: mockMeshManager,
        transport: mockTransport,
        auctionConfig: { min_bids_to_award: 3 },
        emitEvent,
      });

      const record = await auction.createAuction("Task", "session-1");
      auction.receiveBid(makeBid({ rfq_id: record.rfq_id, bidder_node_id: "peer-1" }));

      const result = await auction.awardAuction(record.rfq_id);

      expect(result.awarded).toBe(false);
      expect(result.winning_bid).toBeUndefined();
      expect(record.status).toBe("expired");
    });

    it("should return awarded false for unknown auction", async () => {
      const result = await auction.awardAuction("nonexistent-rfq");
      expect(result.awarded).toBe(false);
    });

    it("should emit auction_awarded event", async () => {
      const record = await auction.createAuction("Task", "session-1");
      auction.receiveBid(makeBid({
        rfq_id: record.rfq_id,
        bidder_node_id: "peer-1",
        estimated_cost_usd: 0.03,
      }));

      await auction.awardAuction(record.rfq_id);

      expect(emitEvent).toHaveBeenCalledWith(
        "swarm.auction_awarded",
        expect.objectContaining({
          rfq_id: record.rfq_id,
          winning_node_id: "peer-1",
          total_bids: 1,
        }),
      );
    });
  });

  // ─── cancelAuction ──────────────────────────────────────────────────

  describe("cancelAuction", () => {
    it("should cancel an open auction", async () => {
      const record = await auction.createAuction("Task", "session-1");
      const result = auction.cancelAuction(record.rfq_id);

      expect(result).toBe(true);
      expect(record.status).toBe("cancelled");
    });

    it("should not cancel an awarded auction", async () => {
      const record = await auction.createAuction("Task", "session-1");
      auction.receiveBid(makeBid({ rfq_id: record.rfq_id, bidder_node_id: "peer-1" }));
      await auction.awardAuction(record.rfq_id);

      const result = auction.cancelAuction(record.rfq_id);

      expect(result).toBe(false);
      expect(record.status).toBe("awarded");
    });

    it("should return false for unknown auction", () => {
      expect(auction.cancelAuction("nonexistent-rfq")).toBe(false);
    });
  });

  // ─── getAuction ─────────────────────────────────────────────────────

  describe("getAuction", () => {
    it("should return auction by rfq_id", async () => {
      const record = await auction.createAuction("Task", "session-1");
      const fetched = auction.getAuction(record.rfq_id);

      expect(fetched).toBe(record);
    });

    it("should return undefined for unknown rfq_id", () => {
      expect(auction.getAuction("nonexistent")).toBeUndefined();
    });
  });

  // ─── getActiveAuctions ──────────────────────────────────────────────

  describe("getActiveAuctions", () => {
    it("should return auctions with status open, collecting, or evaluating", async () => {
      // Create three auctions: one will stay collecting, one awarded, one cancelled
      const record1 = await auction.createAuction("Task 1", "session-1");
      const record2 = await auction.createAuction("Task 2", "session-2");
      const record3 = await auction.createAuction("Task 3", "session-3");

      // Award record2
      auction.receiveBid(makeBid({ rfq_id: record2.rfq_id, bidder_node_id: "peer-1" }));
      await auction.awardAuction(record2.rfq_id);

      // Cancel record3
      auction.cancelAuction(record3.rfq_id);

      const active = auction.getActiveAuctions();

      expect(active).toHaveLength(1);
      expect(active[0]!.rfq_id).toBe(record1.rfq_id);
    });

    it("should include evaluating auctions as active", async () => {
      const record = await auction.createAuction("Task", "session-1");
      auction.receiveBid(makeBid({ rfq_id: record.rfq_id, bidder_node_id: "peer-1" }));
      auction.evaluateBids(record.rfq_id);

      expect(record.status).toBe("evaluating");
      const active = auction.getActiveAuctions();
      expect(active).toHaveLength(1);
    });
  });

  // ─── cleanup ────────────────────────────────────────────────────────

  describe("cleanup", () => {
    it("should remove completed auctions older than 1 hour", async () => {
      const record = await auction.createAuction("Task", "session-1");
      auction.receiveBid(makeBid({ rfq_id: record.rfq_id, bidder_node_id: "peer-1" }));
      await auction.awardAuction(record.rfq_id);

      expect(auction.size).toBe(1);

      // Manually set awarded_at to >1 hour ago
      record.awarded_at = new Date(Date.now() - 3700000).toISOString();

      const removed = auction.cleanup();

      expect(removed).toBe(1);
      expect(auction.size).toBe(0);
    });

    it("should not remove recently completed auctions", async () => {
      const record = await auction.createAuction("Task", "session-1");
      auction.receiveBid(makeBid({ rfq_id: record.rfq_id, bidder_node_id: "peer-1" }));
      await auction.awardAuction(record.rfq_id);

      const removed = auction.cleanup();

      expect(removed).toBe(0);
      expect(auction.size).toBe(1);
    });

    it("should not remove active auctions", async () => {
      await auction.createAuction("Task", "session-1");

      const removed = auction.cleanup();

      expect(removed).toBe(0);
      expect(auction.size).toBe(1);
    });

    it("should remove cancelled and expired auctions older than 1 hour", async () => {
      const record1 = await auction.createAuction("Task 1", "session-1");
      const record2 = await auction.createAuction("Task 2", "session-2");

      // Cancel one
      auction.cancelAuction(record1.rfq_id);

      // Manually set record2 to expired
      record2.status = "expired";

      // Set created_at to >1 hour ago for both
      record1.created_at = new Date(Date.now() - 3700000).toISOString();
      record2.created_at = new Date(Date.now() - 3700000).toISOString();

      expect(auction.size).toBe(2);

      const removed = auction.cleanup();

      expect(removed).toBe(2);
      expect(auction.size).toBe(0);
    });
  });

  // ─── Integration: Full Lifecycle ────────────────────────────────────

  describe("integration: full lifecycle", () => {
    it("should complete create -> bid -> evaluate -> award lifecycle", async () => {
      const peers = [makePeer("peer-1"), makePeer("peer-2")];
      mockMeshManager = makeMockMeshManager(peers);
      mockReputationStore = makeMockReputationStore({
        "peer-1": 0.9,
        "peer-2": 0.6,
      });
      emitEvent = vi.fn();

      auction = new TaskAuction({
        meshManager: mockMeshManager,
        transport: mockTransport,
        reputationStore: mockReputationStore,
        emitEvent,
      });

      // Step 1: Create auction
      const record = await auction.createAuction(
        "Analyze project dependencies",
        "session-42",
        { max_cost_usd: 0.5, max_duration_ms: 120000 },
        ["read-file"],
      );

      expect(record.status).toBe("collecting");
      expect(mockTransport.sendRFQ).toHaveBeenCalledTimes(2);
      expect(emitEvent).toHaveBeenCalledWith("swarm.auction_created", expect.any(Object));

      // Step 2: Receive bids
      const bid1 = makeBid({
        rfq_id: record.rfq_id,
        bidder_node_id: "peer-1",
        bid_id: "bid-1",
        estimated_cost_usd: 0.1,
        estimated_duration_ms: 15000,
        capabilities_offered: ["read-file"],
      });

      const bid2 = makeBid({
        rfq_id: record.rfq_id,
        bidder_node_id: "peer-2",
        bid_id: "bid-2",
        estimated_cost_usd: 0.3,
        estimated_duration_ms: 45000,
        capabilities_offered: ["read-file"],
      });

      expect(auction.receiveBid(bid1).accepted).toBe(true);
      expect(auction.receiveBid(bid2).accepted).toBe(true);
      expect(record.bids).toHaveLength(2);

      // Step 3: Evaluate bids
      const best = auction.evaluateBids(record.rfq_id);
      expect(best).toBeDefined();
      expect(best!.bidder_node_id).toBe("peer-1"); // Higher trust + lower cost + lower duration

      // Step 4: Award auction
      const awardResult = await auction.awardAuction(record.rfq_id);

      expect(awardResult.awarded).toBe(true);
      expect(awardResult.winning_bid!.bidder_node_id).toBe("peer-1");
      expect(record.status).toBe("awarded");
      expect(record.winning_node_id).toBe("peer-1");

      expect(emitEvent).toHaveBeenCalledWith("swarm.auction_awarded", expect.objectContaining({
        rfq_id: record.rfq_id,
        winning_node_id: "peer-1",
        total_bids: 2,
      }));

      // Verify no further bids accepted
      const lateBid = makeBid({ rfq_id: record.rfq_id, bidder_node_id: "peer-3" });
      expect(auction.receiveBid(lateBid).accepted).toBe(false);
    });
  });
});

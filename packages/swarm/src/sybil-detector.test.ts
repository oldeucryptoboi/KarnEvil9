import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { SybilDetector } from "./sybil-detector.js";
import type { SwarmNodeIdentity, ProofOfWork } from "./types.js";

function makeIdentity(overrides: Partial<SwarmNodeIdentity> = {}): SwarmNodeIdentity {
  return {
    node_id: "node-1",
    display_name: "Node 1",
    api_url: "http://host-a.local:3000",
    capabilities: ["read-file", "shell-exec"],
    version: "0.1.0",
    ...overrides,
  };
}

describe("SybilDetector", () => {
  let detector: SybilDetector;

  beforeEach(() => {
    detector = new SybilDetector();
  });

  // ─── Clean Joins (No Sybil) ─────────────────────────────────────

  it("should return no reports for a single clean join", () => {
    const identity = makeIdentity();
    detector.recordJoin(identity);
    const reports = detector.analyzeJoin(identity);
    expect(reports).toHaveLength(0);
  });

  it("should return no reports for a few joins from different hosts", () => {
    for (let i = 0; i < 3; i++) {
      const id = makeIdentity({
        node_id: `node-${i}`,
        api_url: `http://host-${i}.local:3000`,
        capabilities: i % 2 === 0 ? ["read-file"] : ["shell-exec", "browser"],
      });
      detector.recordJoin(id);
    }
    const newcomer = makeIdentity({
      node_id: "node-new",
      api_url: "http://host-unique.local:3000",
      capabilities: ["write-file"],
    });
    detector.recordJoin(newcomer);
    const reports = detector.analyzeJoin(newcomer);
    expect(reports).toHaveLength(0);
  });

  // ─── Coordinated Join Detection ─────────────────────────────────

  it("should detect coordinated joins when max_joins_in_window exceeded", () => {
    // Record 5 joins (the default threshold)
    for (let i = 0; i < 5; i++) {
      const id = makeIdentity({
        node_id: `node-${i}`,
        api_url: `http://host-${i}.local:3000`,
        capabilities: i % 2 === 0 ? ["read-file"] : ["browser"],
      });
      detector.recordJoin(id);
    }
    // The 6th join triggers coordinated_join
    const newcomer = makeIdentity({
      node_id: "node-trigger",
      api_url: "http://host-trigger.local:3000",
      capabilities: ["write-file"],
    });
    detector.recordJoin(newcomer);
    const reports = detector.analyzeJoin(newcomer);
    const coordinated = reports.filter(r => r.indicator === "coordinated_join");
    expect(coordinated).toHaveLength(1);
    expect(coordinated[0]!.suspect_node_ids).toContain("node-trigger");
    expect(coordinated[0]!.action).toBe("flag");
    expect(coordinated[0]!.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("should not detect coordinated joins under threshold", () => {
    // Record 3 joins (below 5 threshold)
    for (let i = 0; i < 3; i++) {
      detector.recordJoin(makeIdentity({
        node_id: `node-${i}`,
        api_url: `http://host-${i}.local:3000`,
      }));
    }
    const newcomer = makeIdentity({ node_id: "node-new", api_url: "http://unique.local:3000" });
    detector.recordJoin(newcomer);
    const reports = detector.analyzeJoin(newcomer);
    const coordinated = reports.filter(r => r.indicator === "coordinated_join");
    expect(coordinated).toHaveLength(0);
  });

  // ─── IP Clustering Detection ────────────────────────────────────

  it("should detect IP clustering with 3+ nodes on same hostname", () => {
    const host = "shared-host.local";
    for (let i = 0; i < 3; i++) {
      detector.recordJoin(makeIdentity({
        node_id: `sybil-${i}`,
        api_url: `http://${host}:${3000 + i}`,
        capabilities: i % 2 === 0 ? ["read-file"] : ["browser"],
      }));
    }
    const newcomer = makeIdentity({
      node_id: "sybil-new",
      api_url: `http://${host}:4000`,
      capabilities: ["write-file"],
    });
    detector.recordJoin(newcomer);
    const reports = detector.analyzeJoin(newcomer);
    const ipReports = reports.filter(r => r.indicator === "same_ip_range");
    expect(ipReports).toHaveLength(1);
    expect(ipReports[0]!.action).toBe("flag");
    expect(ipReports[0]!.evidence).toHaveProperty("host", host);
  });

  it("should escalate IP clustering to challenge action with 5+ nodes", () => {
    const host = "mega-host.local";
    for (let i = 0; i < 5; i++) {
      detector.recordJoin(makeIdentity({
        node_id: `sybil-${i}`,
        api_url: `http://${host}:${3000 + i}`,
        capabilities: i % 2 === 0 ? ["read-file"] : ["browser"],
      }));
    }
    const newcomer = makeIdentity({
      node_id: "sybil-new",
      api_url: `http://${host}:9000`,
      capabilities: ["write-file"],
    });
    detector.recordJoin(newcomer);
    const reports = detector.analyzeJoin(newcomer);
    const ipReports = reports.filter(r => r.indicator === "same_ip_range");
    expect(ipReports).toHaveLength(1);
    expect(ipReports[0]!.action).toBe("challenge");
  });

  it("should not flag IP clustering with fewer than 3 same-host nodes", () => {
    const host = "shared-host.local";
    for (let i = 0; i < 2; i++) {
      detector.recordJoin(makeIdentity({
        node_id: `node-${i}`,
        api_url: `http://${host}:${3000 + i}`,
      }));
    }
    const newcomer = makeIdentity({
      node_id: "node-new",
      api_url: `http://${host}:4000`,
    });
    detector.recordJoin(newcomer);
    const reports = detector.analyzeJoin(newcomer);
    const ipReports = reports.filter(r => r.indicator === "same_ip_range");
    expect(ipReports).toHaveLength(0);
  });

  // ─── Capability Overlap Detection ───────────────────────────────

  it("should detect similar capabilities when overlap exceeds threshold", () => {
    const caps = ["read-file", "write-file", "shell-exec", "browser"];
    for (let i = 0; i < 3; i++) {
      detector.recordJoin(makeIdentity({
        node_id: `clone-${i}`,
        api_url: `http://host-${i}.local:3000`,
        capabilities: caps,
      }));
    }
    const newcomer = makeIdentity({
      node_id: "clone-new",
      api_url: "http://host-new.local:3000",
      capabilities: caps, // identical capabilities
    });
    detector.recordJoin(newcomer);
    const reports = detector.analyzeJoin(newcomer);
    const capReports = reports.filter(r => r.indicator === "similar_capabilities");
    expect(capReports).toHaveLength(1);
    expect(capReports[0]!.suspect_node_ids).toContain("clone-new");
    expect(capReports[0]!.action).toBe("flag");
  });

  it("should not flag capabilities with low overlap", () => {
    detector.recordJoin(makeIdentity({
      node_id: "peer-a",
      api_url: "http://a.local:3000",
      capabilities: ["read-file"],
    }));
    detector.recordJoin(makeIdentity({
      node_id: "peer-b",
      api_url: "http://b.local:3000",
      capabilities: ["browser", "http-request"],
    }));
    detector.recordJoin(makeIdentity({
      node_id: "peer-c",
      api_url: "http://c.local:3000",
      capabilities: ["shell-exec", "write-file"],
    }));
    const newcomer = makeIdentity({
      node_id: "peer-d",
      api_url: "http://d.local:3000",
      capabilities: ["vault-ingest"],
    });
    detector.recordJoin(newcomer);
    const reports = detector.analyzeJoin(newcomer);
    const capReports = reports.filter(r => r.indicator === "similar_capabilities");
    expect(capReports).toHaveLength(0);
  });

  // ─── Proof of Work ─────────────────────────────────────────────

  it("should generate a challenge with hex string and difficulty", () => {
    const { challenge, difficulty } = detector.generateChallenge("node-1");
    expect(challenge).toHaveLength(64); // 32 bytes hex
    expect(difficulty).toBe(4); // default pow_difficulty
  });

  it("should verify valid proof of work", () => {
    // Verify the challenge is generated (vars unused — we use lowDiffDetector below)
    detector.generateChallenge("node-1");
    // Brute force a valid solution (with low difficulty for test speed)
    const lowDiffDetector = new SybilDetector({ pow_difficulty: 1 });
    const lowChallenge = lowDiffDetector.generateChallenge("node-1");
    let solution = 0;
    while (true) {
      const hash = createHash("sha256")
        .update(lowChallenge.challenge + String(solution))
        .digest("hex");
      if (hash.startsWith("0")) break;
      solution++;
    }
    const pow: ProofOfWork = {
      node_id: "node-1",
      challenge: lowChallenge.challenge,
      difficulty: lowChallenge.difficulty,
      solution: String(solution),
      timestamp: new Date().toISOString(),
    };
    expect(lowDiffDetector.verifyProofOfWork(pow)).toBe(true);
  });

  it("should reject invalid proof of work", () => {
    const { challenge } = detector.generateChallenge("node-1");
    const pow: ProofOfWork = {
      node_id: "node-1",
      challenge,
      difficulty: 4,
      solution: "definitely-not-valid",
      timestamp: new Date().toISOString(),
    };
    expect(detector.verifyProofOfWork(pow)).toBe(false);
  });

  // ─── isProofRequired ───────────────────────────────────────────

  it("should return false for default config", () => {
    expect(detector.isProofRequired()).toBe(false);
  });

  it("should return true when require_proof_of_work is enabled", () => {
    const d = new SybilDetector({ require_proof_of_work: true });
    expect(d.isProofRequired()).toBe(true);
  });

  // ─── isSuspect / getSuspectNodes ────────────────────────────────

  it("should mark nodes as suspect after sybil detection", () => {
    const caps = ["read-file", "write-file", "shell-exec", "browser"];
    for (let i = 0; i < 3; i++) {
      detector.recordJoin(makeIdentity({
        node_id: `clone-${i}`,
        api_url: `http://host-${i}.local:3000`,
        capabilities: caps,
      }));
    }
    const newcomer = makeIdentity({
      node_id: "clone-trigger",
      api_url: "http://host-trigger.local:3000",
      capabilities: caps,
    });
    detector.recordJoin(newcomer);
    detector.analyzeJoin(newcomer);

    expect(detector.isSuspect("clone-trigger")).toBe(true);
    expect(detector.isSuspect("clone-0")).toBe(true);
    const suspects = detector.getSuspectNodes();
    expect(suspects.size).toBeGreaterThanOrEqual(2);
  });

  it("should not mark clean nodes as suspect", () => {
    const id = makeIdentity({ node_id: "clean-node" });
    detector.recordJoin(id);
    detector.analyzeJoin(id);
    expect(detector.isSuspect("clean-node")).toBe(false);
    expect(detector.getSuspectNodes().size).toBe(0);
  });

  // ─── getReports ────────────────────────────────────────────────

  it("should accumulate reports across multiple analyzeJoin calls", () => {
    const host = "shared.local";
    for (let i = 0; i < 3; i++) {
      detector.recordJoin(makeIdentity({
        node_id: `same-ip-${i}`,
        api_url: `http://${host}:${3000 + i}`,
        capabilities: i % 2 === 0 ? ["read-file"] : ["browser"],
      }));
    }
    const newcomer1 = makeIdentity({ node_id: "trigger-1", api_url: `http://${host}:4000`, capabilities: ["write-file"] });
    detector.recordJoin(newcomer1);
    detector.analyzeJoin(newcomer1);

    const newcomer2 = makeIdentity({ node_id: "trigger-2", api_url: `http://${host}:5000`, capabilities: ["http-request"] });
    detector.recordJoin(newcomer2);
    detector.analyzeJoin(newcomer2);

    expect(detector.getReports().length).toBeGreaterThanOrEqual(2);
  });

  // ─── Custom Config ─────────────────────────────────────────────

  it("should respect custom join window and max joins config", () => {
    const d = new SybilDetector({ max_joins_in_window: 2 });
    // Only 2 joins needed to trigger
    d.recordJoin(makeIdentity({ node_id: "a", api_url: "http://a.local:3000", capabilities: ["x"] }));
    d.recordJoin(makeIdentity({ node_id: "b", api_url: "http://b.local:3000", capabilities: ["y"] }));
    const newcomer = makeIdentity({ node_id: "c", api_url: "http://c.local:3000", capabilities: ["z"] });
    d.recordJoin(newcomer);
    const reports = d.analyzeJoin(newcomer);
    const coordinated = reports.filter(r => r.indicator === "coordinated_join");
    expect(coordinated).toHaveLength(1);
  });

  // ─── Edge Cases ────────────────────────────────────────────────

  it("should handle identity with empty capabilities", () => {
    for (let i = 0; i < 3; i++) {
      detector.recordJoin(makeIdentity({
        node_id: `empty-${i}`,
        api_url: `http://host-${i}.local:3000`,
        capabilities: [],
      }));
    }
    const newcomer = makeIdentity({
      node_id: "empty-new",
      api_url: "http://host-new.local:3000",
      capabilities: [],
    });
    detector.recordJoin(newcomer);
    // Empty capabilities with Jaccard = 1.0 (both empty), threshold = 0.9 => should trigger
    const reports = detector.analyzeJoin(newcomer);
    const capReports = reports.filter(r => r.indicator === "similar_capabilities");
    expect(capReports).toHaveLength(1);
  });

  it("should handle invalid api_url gracefully for IP clustering", () => {
    detector.recordJoin(makeIdentity({ node_id: "bad-url-1", api_url: "not-a-url" }));
    detector.recordJoin(makeIdentity({ node_id: "bad-url-2", api_url: "not-a-url" }));
    detector.recordJoin(makeIdentity({ node_id: "bad-url-3", api_url: "not-a-url" }));
    const newcomer = makeIdentity({ node_id: "bad-url-4", api_url: "not-a-url" });
    detector.recordJoin(newcomer);
    // Should not throw
    const reports = detector.analyzeJoin(newcomer);
    const ipReports = reports.filter(r => r.indicator === "same_ip_range");
    expect(ipReports).toHaveLength(0);
  });
});

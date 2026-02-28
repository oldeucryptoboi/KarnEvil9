import { createHash, randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { SwarmNodeIdentity, SybilReport, ProofOfWork, } from "./types.js";

export interface SybilDetectorConfig {
  join_window_ms: number;
  max_joins_in_window: number;
  require_proof_of_work: boolean;
  pow_difficulty: number;
  capability_overlap_threshold: number;
}

export const DEFAULT_SYBIL_CONFIG: SybilDetectorConfig = {
  join_window_ms: 5000,
  max_joins_in_window: 5,
  require_proof_of_work: false,
  pow_difficulty: 4,
  capability_overlap_threshold: 0.9,
};

interface JoinRecord {
  node_id: string;
  api_url: string;
  capabilities: string[];
  timestamp: number;
}

export class SybilDetector {
  private config: SybilDetectorConfig;
  private joinRecords: JoinRecord[] = [];
  private reports: SybilReport[] = [];
  private suspectNodes = new Set<string>();

  constructor(config?: Partial<SybilDetectorConfig>) {
    this.config = { ...DEFAULT_SYBIL_CONFIG, ...config };
  }

  recordJoin(identity: SwarmNodeIdentity): void {
    this.joinRecords.push({
      node_id: identity.node_id,
      api_url: identity.api_url,
      capabilities: identity.capabilities,
      timestamp: Date.now(),
    });

    // Cleanup old records (keep last 1000)
    if (this.joinRecords.length > 1000) {
      this.joinRecords = this.joinRecords.slice(-500);
    }
  }

  analyzeJoin(identity: SwarmNodeIdentity): SybilReport[] {
    const newReports: SybilReport[] = [];
    const now = Date.now();

    // 1. Coordinated join timing
    const recentJoins = this.joinRecords.filter(
      r => now - r.timestamp < this.config.join_window_ms && r.node_id !== identity.node_id
    );
    if (recentJoins.length >= this.config.max_joins_in_window) {
      const suspectIds = [identity.node_id, ...recentJoins.map(r => r.node_id)];
      const report: SybilReport = {
        report_id: randomUUID(),
        suspect_node_ids: [...new Set(suspectIds)],
        indicator: "coordinated_join",
        confidence: Math.min(0.5 + recentJoins.length * 0.1, 0.9),
        evidence: {
          join_count: recentJoins.length + 1,
          window_ms: this.config.join_window_ms,
        },
        timestamp: new Date().toISOString(),
        action: "flag",
      };
      newReports.push(report);
    }

    // 2. IP range clustering (extract host from api_url)
    const newHost = this.extractHost(identity.api_url);
    if (newHost) {
      const sameHostJoins = this.joinRecords.filter(r => {
        const host = this.extractHost(r.api_url);
        return host === newHost && r.node_id !== identity.node_id;
      });
      if (sameHostJoins.length >= 3) {
        const suspectIds = [identity.node_id, ...sameHostJoins.map(r => r.node_id)];
        const report: SybilReport = {
          report_id: randomUUID(),
          suspect_node_ids: [...new Set(suspectIds)],
          indicator: "same_ip_range",
          confidence: 0.6 + Math.min(sameHostJoins.length * 0.05, 0.3),
          evidence: {
            host: newHost,
            node_count: sameHostJoins.length + 1,
          },
          timestamp: new Date().toISOString(),
          action: sameHostJoins.length >= 5 ? "challenge" : "flag",
        };
        newReports.push(report);
      }
    }

    // 3. Capability fingerprint overlap
    const similarCapPeers = this.joinRecords.filter(r => {
      if (r.node_id === identity.node_id) return false;
      const overlap = this.computeCapabilityOverlap(identity.capabilities, r.capabilities);
      return overlap >= this.config.capability_overlap_threshold;
    });
    if (similarCapPeers.length >= 3) {
      const suspectIds = [identity.node_id, ...similarCapPeers.map(r => r.node_id)];
      const report: SybilReport = {
        report_id: randomUUID(),
        suspect_node_ids: [...new Set(suspectIds)],
        indicator: "similar_capabilities",
        confidence: 0.5,
        evidence: {
          overlap_threshold: this.config.capability_overlap_threshold,
          similar_count: similarCapPeers.length,
        },
        timestamp: new Date().toISOString(),
        action: "flag",
      };
      newReports.push(report);
    }

    // Store reports and mark suspects
    for (const report of newReports) {
      this.reports.push(report);
      for (const nodeId of report.suspect_node_ids) {
        this.suspectNodes.add(nodeId);
      }
    }

    return newReports;
  }

  generateChallenge(_nodeId: string): { challenge: string; difficulty: number } {
    const challenge = randomBytes(32).toString("hex");
    return { challenge, difficulty: this.config.pow_difficulty };
  }

  verifyProofOfWork(pow: ProofOfWork): boolean {
    const hash = createHash("sha256")
      .update(pow.challenge + pow.solution)
      .digest("hex");
    const requiredPrefix = "0".repeat(pow.difficulty);
    return hash.startsWith(requiredPrefix);
  }

  isProofRequired(): boolean {
    return this.config.require_proof_of_work;
  }

  getReports(): SybilReport[] {
    return [...this.reports];
  }

  getSuspectNodes(): Set<string> {
    return new Set(this.suspectNodes);
  }

  isSuspect(nodeId: string): boolean {
    return this.suspectNodes.has(nodeId);
  }

  private extractHost(apiUrl: string): string | undefined {
    try {
      const url = new URL(apiUrl);
      return url.hostname;
    } catch {
      return undefined;
    }
  }

  private computeCapabilityOverlap(a: string[], b: string[]): number {
    if (a.length === 0 && b.length === 0) return 1.0;
    if (a.length === 0 || b.length === 0) return 0;
    const setA = new Set(a);
    const setB = new Set(b);
    const intersection = [...setA].filter(x => setB.has(x)).length;
    const union = new Set([...a, ...b]).size;
    return union > 0 ? intersection / union : 0;
  }
}

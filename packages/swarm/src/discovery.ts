import type { SwarmNodeIdentity } from "./types.js";
import type { PeerTransport } from "./transport.js";

export interface DiscoveryConfig {
  mdns: boolean;
  seeds: string[];
  gossip: boolean;
  localIdentity: SwarmNodeIdentity;
  transport: PeerTransport;
  onPeerDiscovered: (identity: SwarmNodeIdentity) => void;
}

export class PeerDiscovery {
  private config: DiscoveryConfig;
  private mdnsInstance: MdnsLike | null = null;
  private discoveredNodes = new Set<string>();
  private started = false;

  constructor(config: DiscoveryConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.discoveredNodes.add(this.config.localIdentity.node_id);

    // Start seed discovery
    if (this.config.seeds.length > 0) {
      await this.discoverFromSeeds();
    }

    // Start mDNS
    if (this.config.mdns) {
      await this.startMdns();
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.mdnsInstance) {
      this.mdnsInstance.destroy();
      this.mdnsInstance = null;
    }

    this.discoveredNodes.clear();
  }

  /** Discover peers from seed URLs by fetching their identity endpoints. */
  async discoverFromSeeds(): Promise<SwarmNodeIdentity[]> {
    const discovered: SwarmNodeIdentity[] = [];
    const results = await Promise.allSettled(
      this.config.seeds.map(async (seedUrl) => {
        const response = await this.config.transport.fetchIdentity(seedUrl);
        if (response.ok && response.data) {
          return response.data;
        }
        return null;
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        const identity = result.value;
        if (!this.discoveredNodes.has(identity.node_id)) {
          this.discoveredNodes.add(identity.node_id);
          discovered.push(identity);
          this.config.onPeerDiscovered(identity);
        }
      }
    }

    return discovered;
  }

  /** Process a gossip message and discover new peers. */
  async processGossip(peers: Array<{ node_id: string; api_url: string }>): Promise<SwarmNodeIdentity[]> {
    if (!this.config.gossip) return [];

    const newPeers = peers.filter((p) => !this.discoveredNodes.has(p.node_id));
    const discovered: SwarmNodeIdentity[] = [];

    const results = await Promise.allSettled(
      newPeers.map(async (peer) => {
        const response = await this.config.transport.fetchIdentity(peer.api_url);
        if (response.ok && response.data) {
          return response.data;
        }
        return null;
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        const identity = result.value;
        if (!this.discoveredNodes.has(identity.node_id)) {
          this.discoveredNodes.add(identity.node_id);
          discovered.push(identity);
          this.config.onPeerDiscovered(identity);
        }
      }
    }

    return discovered;
  }

  /** Mark a node as known (for reconnect dedup). */
  markKnown(nodeId: string): void {
    this.discoveredNodes.add(nodeId);
  }

  /** Remove a node from discovered set (allows rediscovery). */
  forget(nodeId: string): void {
    this.discoveredNodes.delete(nodeId);
  }

  get knownNodeCount(): number {
    return this.discoveredNodes.size;
  }

  get isStarted(): boolean {
    return this.started;
  }

  // ─── mDNS ──────────────────────────────────────────────────────────

  private async startMdns(): Promise<void> {
    try {
      const mdnsModule = await import("multicast-dns");
      const mdns = mdnsModule.default() as unknown as MdnsLike;
      this.mdnsInstance = mdns;

      mdns.on("response", (response: MdnsResponse) => {
        for (const answer of response.answers) {
          if (answer.type === "TXT" && answer.name === "_karnevil9._tcp.local") {
            const data = this.parseTxtRecord(answer.data);
            if (data?.node_id && data.api_url && data.node_id !== this.config.localIdentity.node_id) {
              if (!this.discoveredNodes.has(data.node_id)) {
                // Fetch full identity from discovered peer
                void this.config.transport.fetchIdentity(data.api_url).then((response) => {
                  if (response.ok && response.data && !this.discoveredNodes.has(response.data.node_id)) {
                    this.discoveredNodes.add(response.data.node_id);
                    this.config.onPeerDiscovered(response.data);
                  }
                }).catch(() => {});
              }
            }
          }
        }
      });

      // Announce our presence
      this.announceMdns(mdns);
      // Query for peers
      mdns.query({ questions: [{ name: "_karnevil9._tcp.local", type: "TXT" }] });
    } catch {
      // mDNS not available — non-fatal
    }
  }

  private announceMdns(mdns: MdnsLike): void {
    const identity = this.config.localIdentity;
    mdns.respond({
      answers: [{
        type: "TXT",
        name: "_karnevil9._tcp.local",
        ttl: 120,
        data: Buffer.from(JSON.stringify({
          node_id: identity.node_id,
          api_url: identity.api_url,
          version: identity.version,
        })),
      }],
    });
  }

  private parseTxtRecord(data: unknown): Record<string, string> | null {
    try {
      if (Buffer.isBuffer(data)) {
        return JSON.parse(data.toString("utf-8"));
      }
      if (typeof data === "string") {
        return JSON.parse(data);
      }
      if (Array.isArray(data) && data.length > 0) {
        const first = data[0];
        if (Buffer.isBuffer(first)) {
          return JSON.parse(first.toString("utf-8"));
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

// ─── mDNS type stubs (avoid full @types/multicast-dns dep) ────────

interface MdnsLike {
  on(event: string, handler: (response: MdnsResponse) => void): void;
  query(query: { questions: Array<{ name: string; type: string }> }): void;
  respond(response: { answers: MdnsAnswer[] }): void;
  destroy(): void;
}

interface MdnsResponse {
  answers: MdnsAnswer[];
}

interface MdnsAnswer {
  type: string;
  name: string;
  ttl?: number;
  data: unknown;
}

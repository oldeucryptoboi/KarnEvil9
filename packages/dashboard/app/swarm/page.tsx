"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  getSwarmStatus,
  getSwarmPeers,
  getSwarmReputations,
  getSwarmContracts,
  getSwarmAnomalies,
  type SwarmStatusResponse,
  type SwarmPeersResponse,
  type SwarmPeer,
  type PeerReputation,
  type DelegationContract,
  type AnomalyReport,
} from "@/lib/api";

/* ── Constants & Helpers ──────────────────────────────────────────── */

const POLL_INTERVAL_MS = 8000;

const STATUS_COLORS: Record<string, string> = {
  active: "#22c55e",
  suspected: "#eab308",
  unreachable: "#6b7280",
  left: "#6b7280",
};

const STATUS_BG: Record<string, string> = {
  active: "bg-green-500/10 text-green-400",
  suspected: "bg-yellow-500/10 text-yellow-400",
  unreachable: "bg-white/5 text-[var(--muted)]",
  left: "bg-white/5 text-[var(--muted)]",
};

const CONTRACT_STATUS_BG: Record<string, string> = {
  active: "bg-blue-500/10 text-blue-400",
  completed: "bg-green-500/10 text-green-400",
  violated: "bg-red-500/10 text-red-400",
  cancelled: "bg-white/5 text-[var(--muted)]",
};

const SEVERITY_BG: Record<string, string> = {
  low: "bg-white/5 text-[var(--muted)]",
  medium: "bg-yellow-500/10 text-yellow-400",
  high: "bg-orange-500/10 text-orange-400",
  critical: "bg-red-500/10 text-red-400",
};

function truncateId(id: string, len = 8): string {
  if (id.length <= len) return id;
  return id.slice(0, len) + "...";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  if (diff < 60000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

/* ── Mock Data ────────────────────────────────────────────────────── */

function generateMockData() {
  const mockPeers: SwarmPeer[] = [
    {
      node_id: "node-alpha-7f3a2c",
      display_name: "Alpha",
      api_url: "https://alpha.swarm.local:3100",
      capabilities: ["read-file", "shell-exec", "http-request"],
      status: "active",
      last_heartbeat_at: new Date(Date.now() - 2000).toISOString(),
      last_latency_ms: 12,
      joined_at: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      node_id: "node-beta-9e1b4d",
      display_name: "Beta",
      api_url: "https://beta.swarm.local:3100",
      capabilities: ["read-file", "write-file", "browser"],
      status: "active",
      last_heartbeat_at: new Date(Date.now() - 3000).toISOString(),
      last_latency_ms: 28,
      joined_at: new Date(Date.now() - 7200000).toISOString(),
    },
    {
      node_id: "node-gamma-2d5e8f",
      display_name: "Gamma",
      api_url: "https://gamma.swarm.local:3100",
      capabilities: ["shell-exec", "http-request"],
      status: "suspected",
      last_heartbeat_at: new Date(Date.now() - 18000).toISOString(),
      last_latency_ms: 340,
      joined_at: new Date(Date.now() - 14400000).toISOString(),
    },
    {
      node_id: "node-delta-6a0c3b",
      display_name: "Delta",
      api_url: "https://delta.swarm.local:3100",
      capabilities: ["read-file", "write-file", "shell-exec", "http-request"],
      status: "active",
      last_heartbeat_at: new Date(Date.now() - 1500).toISOString(),
      last_latency_ms: 8,
      joined_at: new Date(Date.now() - 28800000).toISOString(),
    },
    {
      node_id: "node-epsilon-4f7d1e",
      display_name: "Epsilon",
      api_url: "https://epsilon.swarm.local:3100",
      capabilities: ["browser", "http-request"],
      status: "unreachable",
      last_heartbeat_at: new Date(Date.now() - 45000).toISOString(),
      last_latency_ms: 0,
      joined_at: new Date(Date.now() - 86400000).toISOString(),
    },
  ];

  const mockSelf = {
    node_id: "node-local-0a1b2c",
    display_name: "Local (MCP)",
    api_url: "http://localhost:3100",
    capabilities: ["read-file", "write-file", "shell-exec", "http-request", "browser"],
    version: "0.1.0",
  };

  const mockReputations: PeerReputation[] = mockPeers.map((p) => ({
    node_id: p.node_id,
    tasks_completed: Math.floor(Math.random() * 50) + 5,
    tasks_failed: Math.floor(Math.random() * 5),
    tasks_aborted: Math.floor(Math.random() * 2),
    total_duration_ms: Math.floor(Math.random() * 500000) + 10000,
    total_tokens_used: Math.floor(Math.random() * 100000) + 5000,
    total_cost_usd: Math.random() * 5,
    avg_latency_ms: p.last_latency_ms + Math.floor(Math.random() * 100),
    consecutive_successes: p.status === "active" ? Math.floor(Math.random() * 10) + 1 : 0,
    consecutive_failures: p.status === "unreachable" ? Math.floor(Math.random() * 3) + 1 : 0,
    last_outcome_at: new Date(Date.now() - Math.floor(Math.random() * 600000)).toISOString(),
    trust_score: p.status === "active" ? 0.7 + Math.random() * 0.3 : 0.2 + Math.random() * 0.3,
  }));

  const mockContracts: DelegationContract[] = [
    {
      contract_id: "ctr-001",
      delegator_node_id: mockSelf.node_id,
      delegatee_node_id: mockPeers[0]!.node_id,
      task_id: "task-abc-123",
      task_text: "Analyze repository structure and generate dependency graph",
      status: "completed",
      created_at: new Date(Date.now() - 300000).toISOString(),
      completed_at: new Date(Date.now() - 120000).toISOString(),
    },
    {
      contract_id: "ctr-002",
      delegator_node_id: mockSelf.node_id,
      delegatee_node_id: mockPeers[1]!.node_id,
      task_id: "task-def-456",
      task_text: "Run end-to-end test suite and collect coverage reports",
      status: "active",
      created_at: new Date(Date.now() - 60000).toISOString(),
    },
    {
      contract_id: "ctr-003",
      delegator_node_id: mockPeers[3]!.node_id,
      delegatee_node_id: mockPeers[2]!.node_id,
      task_id: "task-ghi-789",
      task_text: "Deploy staging environment with new configuration",
      status: "violated",
      created_at: new Date(Date.now() - 600000).toISOString(),
      completed_at: new Date(Date.now() - 450000).toISOString(),
      violation_reason: "SLO exceeded: duration 320s > max 300s",
    },
    {
      contract_id: "ctr-004",
      delegator_node_id: mockSelf.node_id,
      delegatee_node_id: mockPeers[3]!.node_id,
      task_id: "task-jkl-012",
      task_text: "Scan codebase for security vulnerabilities",
      status: "active",
      created_at: new Date(Date.now() - 30000).toISOString(),
    },
    {
      contract_id: "ctr-005",
      delegator_node_id: mockPeers[1]!.node_id,
      delegatee_node_id: mockSelf.node_id,
      task_id: "task-mno-345",
      task_text: "Review and validate test coverage for core modules",
      status: "completed",
      created_at: new Date(Date.now() - 900000).toISOString(),
      completed_at: new Date(Date.now() - 700000).toISOString(),
    },
  ];

  const mockAnomalies: AnomalyReport[] = [
    {
      anomaly_id: "anom-001",
      task_id: "task-ghi-789",
      peer_node_id: mockPeers[2]!.node_id,
      type: "duration_spike",
      severity: "medium",
      description: "Task duration 3.2x above peer average",
      timestamp: new Date(Date.now() - 450000).toISOString(),
    },
    {
      anomaly_id: "anom-002",
      task_id: "task-xyz-999",
      peer_node_id: mockPeers[4]!.node_id,
      type: "repeated_failures",
      severity: "high",
      description: "3 consecutive task failures from this peer",
      timestamp: new Date(Date.now() - 60000).toISOString(),
    },
  ];

  return {
    status: {
      running: true,
      node_id: mockSelf.node_id,
      display_name: mockSelf.display_name,
      peer_count: mockPeers.length,
      active_peers: mockPeers.filter((p) => p.status === "active").length,
      active_delegations: mockContracts.filter((c) => c.status === "active").length,
    } as SwarmStatusResponse,
    peers: {
      self: mockSelf,
      peers: mockPeers,
      total: mockPeers.length,
    } as SwarmPeersResponse,
    reputations: mockReputations,
    contracts: mockContracts,
    anomalies: mockAnomalies,
  };
}

/* ── Stat Card ────────────────────────────────────────────────────── */

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="text-xs text-[var(--muted)] mb-1">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {sub && <div className="text-[10px] text-[var(--muted)] mt-1">{sub}</div>}
    </div>
  );
}

/* ── Topology Visualization ───────────────────────────────────────── */

interface TopoNode {
  id: string;
  label: string;
  status: string;
  isSelf: boolean;
  x: number;
  y: number;
}

function TopologyView({
  selfNode,
  peers,
}: {
  selfNode: { node_id: string; display_name: string } | null;
  peers: SwarmPeer[];
}) {
  const allNodes: TopoNode[] = [];

  // Center: self node
  if (selfNode) {
    allNodes.push({
      id: selfNode.node_id,
      label: selfNode.display_name,
      status: "active",
      isSelf: true,
      x: 200,
      y: 150,
    });
  }

  // Ring: peer nodes arranged in a circle around center
  const radius = 110;
  const cx = 200;
  const cy = 150;
  peers.forEach((peer, i) => {
    const angle = (2 * Math.PI * i) / Math.max(peers.length, 1) - Math.PI / 2;
    allNodes.push({
      id: peer.node_id,
      label: peer.display_name || truncateId(peer.node_id),
      status: peer.status,
      isSelf: false,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  });

  const selfIdx = allNodes.findIndex((n) => n.isSelf);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <h3 className="text-sm font-semibold mb-3">Mesh Topology</h3>
      <svg
        viewBox="0 0 400 300"
        className="w-full max-w-lg mx-auto"
        style={{ height: "auto" }}
      >
        {/* Connection lines from self to each peer */}
        {selfIdx >= 0 &&
          allNodes.map((node, i) => {
            if (i === selfIdx) return null;
            const self = allNodes[selfIdx]!;
            return (
              <line
                key={`line-${node.id}`}
                x1={self.x}
                y1={self.y}
                x2={node.x}
                y2={node.y}
                stroke={STATUS_COLORS[node.status] ?? "#6b7280"}
                strokeWidth="1"
                strokeOpacity="0.3"
                strokeDasharray={node.status === "unreachable" ? "4 3" : undefined}
              />
            );
          })}

        {/* Peer-to-peer connections (mesh) */}
        {allNodes
          .filter((n) => !n.isSelf && n.status === "active")
          .map((a, i, arr) => {
            const b = arr[(i + 1) % arr.length];
            if (!b || a.id === b.id) return null;
            return (
              <line
                key={`mesh-${a.id}-${b.id}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#22c55e"
                strokeWidth="0.5"
                strokeOpacity="0.15"
              />
            );
          })}

        {/* Nodes */}
        {allNodes.map((node) => {
          const color = STATUS_COLORS[node.status] ?? "#6b7280";
          const nodeRadius = node.isSelf ? 22 : 16;
          return (
            <g key={node.id}>
              {/* Glow for self */}
              {node.isSelf && (
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={nodeRadius + 4}
                  fill={color}
                  opacity="0.1"
                />
              )}
              {/* Pulse ring for active nodes */}
              {node.status === "active" && (
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={nodeRadius}
                  fill="none"
                  stroke={color}
                  strokeWidth="1"
                  opacity="0.3"
                >
                  <animate
                    attributeName="r"
                    from={String(nodeRadius)}
                    to={String(nodeRadius + 6)}
                    dur="2s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    from="0.3"
                    to="0"
                    dur="2s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
              <circle
                cx={node.x}
                cy={node.y}
                r={nodeRadius}
                fill={`${color}20`}
                stroke={color}
                strokeWidth="1.5"
              />
              <text
                x={node.x}
                y={node.y + 1}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={color}
                fontSize={node.isSelf ? "9" : "8"}
                fontFamily="monospace"
                fontWeight={node.isSelf ? "bold" : "normal"}
              >
                {node.label.length > 8 ? node.label.slice(0, 7) + ".." : node.label}
              </text>
              {/* Status dot */}
              <circle
                cx={node.x + nodeRadius * 0.7}
                cy={node.y - nodeRadius * 0.7}
                r="3"
                fill={color}
              />
              {/* Role label underneath */}
              <text
                x={node.x}
                y={node.y + nodeRadius + 12}
                textAnchor="middle"
                fill="#6b7280"
                fontSize="7"
                fontFamily="monospace"
              >
                {node.isSelf ? "coordinator" : node.status}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="flex items-center justify-center gap-4 mt-3">
        {["active", "suspected", "unreachable"].map((s) => (
          <div key={s} className="flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: STATUS_COLORS[s] }}
            />
            <span className="text-[10px] text-[var(--muted)] capitalize">{s}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Node Stats Cards ─────────────────────────────────────────────── */

function NodeStatsGrid({
  peers,
  reputations,
}: {
  peers: SwarmPeer[];
  reputations: PeerReputation[];
}) {
  const repMap = new Map(reputations.map((r) => [r.node_id, r]));

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <h3 className="text-sm font-semibold mb-3">Node Stats</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[var(--muted)] border-b border-[var(--border)]">
              <th className="pb-2 pr-3 font-medium">Node</th>
              <th className="pb-2 pr-3 font-medium">Status</th>
              <th className="pb-2 pr-3 font-medium text-right">Trust</th>
              <th className="pb-2 pr-3 font-medium text-right">Completed</th>
              <th className="pb-2 pr-3 font-medium text-right">Failed</th>
              <th className="pb-2 pr-3 font-medium text-right">Latency</th>
              <th className="pb-2 font-medium text-right">Uptime</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {peers.map((peer) => {
              const rep = repMap.get(peer.node_id);
              const uptime = Date.now() - new Date(peer.joined_at).getTime();
              return (
                <tr key={peer.node_id} className="hover:bg-white/[0.02] transition-colors">
                  <td className="py-2 pr-3">
                    <div className="font-mono font-medium text-[var(--foreground)]">
                      {peer.display_name || truncateId(peer.node_id)}
                    </div>
                    <div className="text-[var(--muted)] text-[10px]">{truncateId(peer.node_id, 16)}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-mono ${STATUS_BG[peer.status] ?? "bg-white/5 text-[var(--muted)]"}`}>
                      {peer.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right font-mono">
                    {rep ? (
                      <span style={{ color: rep.trust_score >= 0.7 ? "#22c55e" : rep.trust_score >= 0.4 ? "#eab308" : "#ef4444" }}>
                        {(rep.trust_score * 100).toFixed(0)}%
                      </span>
                    ) : (
                      <span className="text-[var(--muted)]">-</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-green-400">
                    {rep?.tasks_completed ?? 0}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-red-400">
                    {rep?.tasks_failed ?? 0}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono">
                    {peer.last_latency_ms > 0 ? `${peer.last_latency_ms}ms` : "-"}
                  </td>
                  <td className="py-2 text-right font-mono text-[var(--muted)]">
                    {formatDuration(uptime)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {peers.length === 0 && (
        <div className="text-center text-[var(--muted)] py-4">No peers connected</div>
      )}
    </div>
  );
}

/* ── Delegation Flow ──────────────────────────────────────────────── */

function DelegationFlow({ contracts }: { contracts: DelegationContract[] }) {
  const sorted = [...contracts].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <h3 className="text-sm font-semibold mb-3">Delegation Flow</h3>
      <div className="space-y-2 max-h-80 overflow-y-auto">
        {sorted.map((contract) => (
          <div
            key={contract.contract_id}
            className="rounded border border-[var(--border)] bg-white/[0.02] p-3"
          >
            <div className="flex items-center gap-2 mb-1.5">
              {/* Source node */}
              <span className="font-mono text-xs text-blue-400 shrink-0">
                {truncateId(contract.delegator_node_id, 12)}
              </span>
              {/* Arrow */}
              <svg width="24" height="10" viewBox="0 0 24 10" className="shrink-0">
                <line x1="0" y1="5" x2="18" y2="5" stroke="#6b7280" strokeWidth="1" />
                <polygon points="18,2 24,5 18,8" fill="#6b7280" />
              </svg>
              {/* Target node */}
              <span className="font-mono text-xs text-purple-400 shrink-0">
                {truncateId(contract.delegatee_node_id, 12)}
              </span>
              {/* Status badge */}
              <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-mono shrink-0 ${CONTRACT_STATUS_BG[contract.status] ?? "bg-white/5 text-[var(--muted)]"}`}>
                {contract.status}
              </span>
            </div>
            <div className="text-xs text-[var(--foreground)] truncate mb-1" title={contract.task_text}>
              {contract.task_text}
            </div>
            <div className="flex items-center gap-3 text-[10px] text-[var(--muted)]">
              <span>{timeAgo(contract.created_at)}</span>
              {contract.violation_reason && (
                <span className="text-red-400 truncate">{contract.violation_reason}</span>
              )}
            </div>
          </div>
        ))}
      </div>
      {contracts.length === 0 && (
        <div className="text-center text-[var(--muted)] py-4">No delegation events</div>
      )}
    </div>
  );
}

/* ── Message Stats ────────────────────────────────────────────────── */

function MessageStats({
  peers,
  reputations,
  anomalies,
}: {
  peers: SwarmPeer[];
  reputations: PeerReputation[];
  anomalies: AnomalyReport[];
}) {
  const totalTasks = reputations.reduce((sum, r) => sum + r.tasks_completed + r.tasks_failed + r.tasks_aborted, 0);
  const totalCompleted = reputations.reduce((sum, r) => sum + r.tasks_completed, 0);
  const totalFailed = reputations.reduce((sum, r) => sum + r.tasks_failed, 0);
  const totalAborted = reputations.reduce((sum, r) => sum + r.tasks_aborted, 0);
  const totalCost = reputations.reduce((sum, r) => sum + r.total_cost_usd, 0);
  const totalTokens = reputations.reduce((sum, r) => sum + r.total_tokens_used, 0);
  const errorRate = totalTasks > 0 ? ((totalFailed + totalAborted) / totalTasks) * 100 : 0;

  // Estimate message counts from peer activity
  const heartbeatEstimate = peers.length * 12; // ~12 heartbeats/min with 5s interval
  const delegateEstimate = totalTasks;
  const resultEstimate = totalCompleted + totalFailed + totalAborted;
  const totalMessages = heartbeatEstimate + delegateEstimate + resultEstimate;

  const bars = [
    { label: "heartbeat", value: heartbeatEstimate, color: "#3b82f6" },
    { label: "delegate", value: delegateEstimate, color: "#8b5cf6" },
    { label: "result", value: resultEstimate, color: "#22c55e" },
  ];
  const maxBar = Math.max(...bars.map((b) => b.value), 1);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <h3 className="text-sm font-semibold mb-3">Aggregate Stats</h3>

      {/* Top numbers */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <div className="text-[10px] text-[var(--muted)]">Total Messages</div>
          <div className="text-lg font-semibold font-mono">{totalMessages.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-[10px] text-[var(--muted)]">Error Rate</div>
          <div className="text-lg font-semibold font-mono" style={{ color: errorRate > 10 ? "#ef4444" : errorRate > 5 ? "#eab308" : "#22c55e" }}>
            {errorRate.toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="text-[10px] text-[var(--muted)]">Total Cost</div>
          <div className="text-lg font-semibold font-mono">${totalCost.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-[10px] text-[var(--muted)]">Total Tokens</div>
          <div className="text-lg font-semibold font-mono">
            {totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : totalTokens}
          </div>
        </div>
      </div>

      {/* Message type breakdown bars */}
      <div className="text-[10px] text-[var(--muted)] mb-2">Messages by Type</div>
      <div className="space-y-1.5">
        {bars.map((bar) => (
          <div key={bar.label} className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--muted)] font-mono w-16 text-right shrink-0">
              {bar.label}
            </span>
            <div className="flex-1 h-4 rounded bg-white/[0.04] overflow-hidden">
              <div
                className="h-full rounded transition-all duration-500 ease-out"
                style={{
                  width: `${Math.max((bar.value / maxBar) * 100, 2)}%`,
                  backgroundColor: bar.color,
                  opacity: 0.6,
                }}
              />
            </div>
            <span className="text-[10px] font-mono w-10 text-right shrink-0">
              {bar.value}
            </span>
          </div>
        ))}
      </div>

      {/* Anomalies section */}
      {anomalies.length > 0 && (
        <div className="mt-4 pt-3 border-t border-[var(--border)]">
          <div className="text-[10px] text-[var(--muted)] mb-2">Recent Anomalies ({anomalies.length})</div>
          <div className="space-y-1.5">
            {anomalies.slice(0, 5).map((a) => (
              <div key={a.anomaly_id} className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-mono shrink-0 ${SEVERITY_BG[a.severity] ?? SEVERITY_BG.low}`}>
                  {a.severity}
                </span>
                <span className="text-[10px] text-[var(--foreground)] truncate flex-1">
                  {a.description}
                </span>
                <span className="text-[10px] text-[var(--muted)] shrink-0">
                  {timeAgo(a.timestamp)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Main Page ────────────────────────────────────────────────────── */

export default function SwarmPage() {
  const [status, setStatus] = useState<SwarmStatusResponse | null>(null);
  const [peersData, setPeersData] = useState<SwarmPeersResponse | null>(null);
  const [reputations, setReputations] = useState<PeerReputation[]>([]);
  const [contracts, setContracts] = useState<DelegationContract[]>([]);
  const [anomalies, setAnomalies] = useState<AnomalyReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [useMock, setUseMock] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const mockRef = useRef(useMock);
  mockRef.current = useMock;

  const fetchData = useCallback(async () => {
    if (mockRef.current) return;
    try {
      const [statusRes, peersRes, repRes, contractsRes, anomaliesRes] = await Promise.all([
        getSwarmStatus(),
        getSwarmPeers(),
        getSwarmReputations(),
        getSwarmContracts(),
        getSwarmAnomalies(),
      ]);
      setStatus(statusRes);
      setPeersData(peersRes);
      setReputations(repRes.reputations);
      setContracts(contractsRes.contracts);
      setAnomalies(anomaliesRes.anomalies);
      setError(null);
      setLastUpdated(new Date());
    } catch (e: unknown) {
      const msg = (e as Error).message;
      // If swarm not available, switch to mock
      if (loading) {
        setUseMock(true);
        mockRef.current = true;
        const mock = generateMockData();
        setStatus(mock.status);
        setPeersData(mock.peers);
        setReputations(mock.reputations);
        setContracts(mock.contracts);
        setAnomalies(mock.anomalies);
        setError(null);
        setLastUpdated(new Date());
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [loading]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--muted)]">
        Loading swarm...
      </div>
    );
  }

  const peers = peersData?.peers ?? [];
  const selfNode = peersData?.self ?? null;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold">Swarm</h2>
          {status && (
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${status.running ? "bg-green-500" : "bg-red-500"}`}
              title={status.running ? "Swarm running" : "Swarm stopped"}
            />
          )}
        </div>
        <div className="flex items-center gap-3">
          {useMock && (
            <span className="rounded bg-yellow-500/10 px-2 py-1 text-[10px] font-mono text-yellow-400">
              MOCK DATA -- Connect to a running swarm to see live data
            </span>
          )}
          {lastUpdated && (
            <span className="text-xs text-[var(--muted)]">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 mb-4">
          {error}
        </div>
      )}

      {/* Hero stat cards */}
      {status && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <StatCard
            label="Node ID"
            value={truncateId(status.node_id, 12)}
            sub={status.display_name}
          />
          <StatCard
            label="Total Peers"
            value={status.peer_count}
            sub={`${status.active_peers} active`}
          />
          <StatCard
            label="Active Delegations"
            value={status.active_delegations}
          />
          <StatCard
            label="Swarm Status"
            value={status.running ? "Running" : "Stopped"}
          />
        </div>
      )}

      {/* Topology + Message Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <TopologyView selfNode={selfNode} peers={peers} />
        <MessageStats peers={peers} reputations={reputations} anomalies={anomalies} />
      </div>

      {/* Node Stats + Delegation Flow */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <NodeStatsGrid peers={peers} reputations={reputations} />
        <DelegationFlow contracts={contracts} />
      </div>

      {/* Trust Score Distribution */}
      {reputations.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 mb-4">
          <h3 className="text-sm font-semibold mb-3">Trust Score Distribution</h3>
          <div className="flex items-end gap-1 h-20">
            {reputations
              .sort((a, b) => b.trust_score - a.trust_score)
              .map((rep) => {
                const pct = rep.trust_score * 100;
                const color = rep.trust_score >= 0.7 ? "#22c55e" : rep.trust_score >= 0.4 ? "#eab308" : "#ef4444";
                const peer = peers.find((p) => p.node_id === rep.node_id);
                const name = peer?.display_name || truncateId(rep.node_id);
                return (
                  <div key={rep.node_id} className="flex-1 flex flex-col items-center gap-1">
                    <div
                      className="w-full rounded-t transition-all duration-500"
                      style={{
                        height: `${Math.max(pct * 0.7, 2)}px`,
                        backgroundColor: color,
                        opacity: 0.6,
                      }}
                    />
                    <span className="text-[9px] font-mono text-[var(--muted)] truncate w-full text-center">
                      {name}
                    </span>
                    <span className="text-[9px] font-mono" style={{ color }}>
                      {pct.toFixed(0)}%
                    </span>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {!status && !loading && !error && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-8 text-center text-[var(--muted)]">
          Swarm is not configured. Enable swarm in the API server configuration to see live data.
        </div>
      )}
    </div>
  );
}

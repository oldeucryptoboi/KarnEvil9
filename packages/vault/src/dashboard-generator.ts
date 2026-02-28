import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JournalEventType } from "@karnevil9/schemas";
import type { ObjectStore } from "./object-store.js";
import type { LinkStore } from "./link-store.js";
import type { VectorStore } from "./vector-store.js";
import type { DashboardData, InsightsFn, ClusterResult } from "./types.js";

export class DashboardGenerator {
  private objectStore: ObjectStore;
  private linkStore: LinkStore;
  private vectorStore: VectorStore | null;
  private vaultRoot: string;
  private emitEvent: (type: JournalEventType, payload: Record<string, unknown>) => Promise<void>;

  constructor(options: {
    objectStore: ObjectStore;
    linkStore: LinkStore;
    vectorStore?: VectorStore;
    vaultRoot: string;
    emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => Promise<void>;
  }) {
    this.objectStore = options.objectStore;
    this.linkStore = options.linkStore;
    this.vectorStore = options.vectorStore ?? null;
    this.vaultRoot = options.vaultRoot;
    this.emitEvent = options.emitEvent ?? (async () => {});
  }

  buildDashboardData(clusters?: ClusterResult[]): DashboardData {
    const now = new Date().toISOString();
    const storeStats = this.objectStore.getStats();
    const allEntries = this.objectStore.search({});

    // Objects by source
    const bySource: Record<string, number> = {};
    for (const entry of allEntries) {
      const src = entry.source || "unknown";
      bySource[src] = (bySource[src] ?? 0) + 1;
    }

    // Embedding coverage
    const totalObjects = storeStats.total;
    const embeddedCount = this.vectorStore
      ? allEntries.filter((e) => this.vectorStore!.hasEmbedding(e.object_id)).length
      : 0;
    const embeddingCoverage = totalObjects > 0 ? embeddedCount / totalObjects : 0;

    // Top entities by link count
    const entityMentions = new Map<string, { name: string; type: string; count: number }>();
    for (const entry of allEntries) {
      const links = this.linkStore.getLinksForObject(entry.object_id);
      if (links.length > 0) {
        entityMentions.set(entry.object_id, {
          name: entry.title,
          type: entry.object_type,
          count: links.length,
        });
      }
    }
    const topEntities = Array.from(entityMentions.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
      .map((e) => ({ name: e.name, type: e.type, mention_count: e.count }));

    // Recent activity (last 7 days)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentActivity = allEntries
      .filter((e) => new Date(e.ingested_at).getTime() > sevenDaysAgo)
      .sort((a, b) => new Date(b.ingested_at).getTime() - new Date(a.ingested_at).getTime())
      .slice(0, 20)
      .map((e) => ({
        title: e.title,
        source: e.source,
        ingested_at: e.ingested_at,
      }));

    return {
      generated_at: now,
      total_objects: totalObjects,
      total_links: this.linkStore.size(),
      unclassified_count: storeStats.by_category.inbox ?? 0,
      embedding_coverage: embeddingCoverage,
      objects_by_type: storeStats.by_type,
      objects_by_category: storeStats.by_category,
      objects_by_source: bySource,
      top_entities: topEntities,
      recent_activity: recentActivity,
      topic_clusters: clusters ?? [],
    };
  }

  async generateDashboard(clusters?: ClusterResult[]): Promise<string> {
    const data = this.buildDashboardData(clusters);
    const filePath = join(this.vaultRoot, "Dashboard.md");

    const lines: string[] = [
      "---",
      `generated_at: "${data.generated_at}"`,
      `total_objects: ${data.total_objects}`,
      `total_links: ${data.total_links}`,
      "---",
      "",
      "# Vault Dashboard",
      "",
      `> Auto-generated. Last updated: ${data.generated_at}`,
      "",
      "## Health",
      "",
      "| Metric | Value |",
      "|--------|-------|",
      `| Total Objects | ${data.total_objects} |`,
      `| Total Links | ${data.total_links} |`,
      `| Unclassified | ${data.unclassified_count} |`,
      `| Embedding Coverage | ${(data.embedding_coverage * 100).toFixed(1)}% |`,
      "",
    ];

    // Objects by type
    if (Object.keys(data.objects_by_type).length > 0) {
      lines.push("## Objects by Type", "");
      lines.push("| Type | Count |");
      lines.push("|------|-------|");
      for (const [type, count] of Object.entries(data.objects_by_type).sort((a, b) => b[1] - a[1])) {
        lines.push(`| ${type} | ${count} |`);
      }
      lines.push("");
    }

    // Objects by category
    if (Object.keys(data.objects_by_category).length > 0) {
      lines.push("## Objects by Category", "");
      lines.push("| Category | Count |");
      lines.push("|----------|-------|");
      for (const [cat, count] of Object.entries(data.objects_by_category).sort((a, b) => b[1] - a[1])) {
        lines.push(`| ${cat} | ${count} |`);
      }
      lines.push("");
    }

    // Objects by source
    if (Object.keys(data.objects_by_source).length > 0) {
      lines.push("## Objects by Source", "");
      lines.push("| Source | Count |");
      lines.push("|--------|-------|");
      for (const [src, count] of Object.entries(data.objects_by_source).sort((a, b) => b[1] - a[1])) {
        lines.push(`| ${src} | ${count} |`);
      }
      lines.push("");
    }

    // Top entities
    if (data.top_entities.length > 0) {
      lines.push("## Top Entities", "");
      lines.push("| Entity | Type | Mentions |");
      lines.push("|--------|------|----------|");
      for (const ent of data.top_entities) {
        lines.push(`| [[${ent.name}]] | ${ent.type} | ${ent.mention_count} |`);
      }
      lines.push("");
    }

    // Recent activity
    if (data.recent_activity.length > 0) {
      lines.push("## Recent Activity", "");
      for (const act of data.recent_activity) {
        lines.push(`- **${act.title}** — ${act.source} — ${act.ingested_at.split("T")[0]}`);
      }
      lines.push("");
    }

    // Topic clusters
    if (data.topic_clusters.length > 0) {
      lines.push("## Topic Clusters", "");
      for (const cluster of data.topic_clusters) {
        const label = cluster.label ?? `Cluster ${cluster.cluster_id}`;
        lines.push(`### ${label}`, "");
        lines.push(`Representative: \`${cluster.representative_id}\``, "");
        for (const member of cluster.members) {
          lines.push(`- \`${member.object_id}\` (${member.classification})`);
        }
        lines.push("");
      }
    }

    // Dataview queries for Obsidian
    lines.push("## Dynamic Queries", "");
    lines.push("```dataview");
    lines.push("TABLE object_type, para_category, length(file.inlinks) AS Links");
    lines.push("FROM \"\"");
    lines.push("WHERE object_id");
    lines.push("SORT file.mtime DESC");
    lines.push("LIMIT 20");
    lines.push("```");
    lines.push("");

    const content = lines.join("\n");
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, filePath);

    await this.emitEvent("vault.dashboard_generated" as JournalEventType, {
      total_objects: data.total_objects,
      total_links: data.total_links,
      embedding_coverage: data.embedding_coverage,
    });

    return filePath;
  }

  async generateInsights(insightsFn?: InsightsFn, clusters?: ClusterResult[]): Promise<string> {
    const data = this.buildDashboardData(clusters);
    const filePath = join(this.vaultRoot, "Insights.md");

    let insightsText: string;
    if (insightsFn) {
      try {
        insightsText = await insightsFn(data);
      } catch {
        insightsText = this.buildFallbackInsights(data);
      }
    } else {
      insightsText = this.buildFallbackInsights(data);
    }

    const lines: string[] = [
      "---",
      `generated_at: "${data.generated_at}"`,
      "---",
      "",
      "# Vault Insights",
      "",
      `> Auto-generated. Last updated: ${data.generated_at}`,
      "",
      insightsText,
      "",
    ];

    const content = lines.join("\n");
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, filePath);

    await this.emitEvent("vault.insights_generated" as JournalEventType, {
      has_llm_insights: !!insightsFn,
      total_objects: data.total_objects,
    });

    return filePath;
  }

  private buildFallbackInsights(data: DashboardData): string {
    const lines: string[] = [];
    lines.push("## Summary");
    lines.push("");
    lines.push(`The vault contains **${data.total_objects} objects** connected by **${data.total_links} links**.`);

    if (data.unclassified_count > 0) {
      lines.push(`There are **${data.unclassified_count} unclassified objects** in the inbox.`);
    }

    const coverage = (data.embedding_coverage * 100).toFixed(1);
    lines.push(`Embedding coverage is at **${coverage}%**.`);
    lines.push("");

    if (data.top_entities.length > 0) {
      lines.push("## Most Connected Entities");
      lines.push("");
      for (const ent of data.top_entities.slice(0, 5)) {
        lines.push(`- **${ent.name}** (${ent.type}) — ${ent.mention_count} connections`);
      }
      lines.push("");
    }

    if (data.topic_clusters.length > 0) {
      lines.push(`## Topic Clusters`);
      lines.push("");
      lines.push(`Found **${data.topic_clusters.length} topic clusters** in the vault.`);
      lines.push("");
    }

    return lines.join("\n");
  }
}

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { existsSync } from "node:fs";
import { DashboardGenerator } from "./dashboard-generator.js";
import { ObjectStore } from "./object-store.js";
import { LinkStore } from "./link-store.js";
import { VectorStore } from "./vector-store.js";
import { getDefaultSchema } from "./ontology-schema.js";
import type { DashboardData, InsightsFn } from "./types.js";

describe("DashboardGenerator", () => {
  let tmpDir: string;
  let objectStore: ObjectStore;
  let linkStore: LinkStore;
  let vectorStore: VectorStore;
  let generator: DashboardGenerator;
  const schema = getDefaultSchema();

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vault-dashboard-test-${uuid()}`);
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(tmpDir, "_Ontology", "Links"), { recursive: true });

    objectStore = new ObjectStore(tmpDir);
    await objectStore.init();

    linkStore = new LinkStore(join(tmpDir, "_Ontology", "Links", "links.jsonl"));
    await linkStore.init();

    vectorStore = new VectorStore(join(tmpDir, "_Ontology", "Links", "embeddings.jsonl"));
    await vectorStore.init();

    generator = new DashboardGenerator({
      objectStore,
      linkStore,
      vectorStore,
      vaultRoot: tmpDir,
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("buildDashboardData", () => {
    it("returns correct structure for empty vault", () => {
      const data = generator.buildDashboardData();
      expect(data.generated_at).toBeTruthy();
      expect(data.total_objects).toBe(0);
      expect(data.total_links).toBe(0);
      expect(data.unclassified_count).toBe(0);
      expect(data.embedding_coverage).toBe(0);
      expect(data.objects_by_type).toEqual({});
      expect(data.objects_by_category).toEqual({});
      expect(data.objects_by_source).toEqual({});
      expect(data.top_entities).toEqual([]);
      expect(data.recent_activity).toEqual([]);
      expect(data.topic_clusters).toEqual([]);
    });

    it("counts objects by source", async () => {
      await objectStore.create("A", "Content", { source: "chatgpt", source_id: "1" }, schema);
      await objectStore.create("B", "Content", { source: "chatgpt", source_id: "2" }, schema);
      await objectStore.create("C", "Content", { source: "claude", source_id: "3" }, schema);

      const data = generator.buildDashboardData();
      expect(data.objects_by_source["chatgpt"]).toBe(2);
      expect(data.objects_by_source["claude"]).toBe(1);
    });

    it("computes embedding coverage", async () => {
      const obj1 = await objectStore.create("A", "C", { source: "test", source_id: "1" }, schema);
      await objectStore.create("B", "C", { source: "test", source_id: "2" }, schema);

      vectorStore.setEmbedding(obj1.frontmatter.object_id, new Float32Array([1, 0]));

      const data = generator.buildDashboardData();
      expect(data.embedding_coverage).toBeCloseTo(0.5, 2);
    });

    it("includes top entities by link count", async () => {
      const obj1 = await objectStore.create("TypeScript", "TS", {
        source: "test", source_id: "1", object_type: "Tool",
      }, schema);
      const obj2 = await objectStore.create("Doc", "Doc", { source: "test", source_id: "2" }, schema);

      await linkStore.addLink({
        source_id: obj2.frontmatter.object_id,
        target_id: obj1.frontmatter.object_id,
        link_type: "discusses",
        confidence: 0.9,
      });

      const data = generator.buildDashboardData();
      expect(data.top_entities.length).toBeGreaterThanOrEqual(1);
    });

    it("includes recent activity from last 7 days", async () => {
      await objectStore.create("Recent Doc", "Content", {
        source: "test",
        source_id: "recent",
        created_at: new Date().toISOString(),
      }, schema);

      const data = generator.buildDashboardData();
      expect(data.recent_activity.length).toBe(1);
      expect(data.recent_activity[0]!.title).toBe("Recent Doc");
    });

    it("includes topic clusters when provided", () => {
      const clusters = [{
        cluster_id: 0,
        members: [
          { object_id: "a", classification: "core" as const },
          { object_id: "b", classification: "core" as const },
        ],
        representative_id: "a",
      }];

      const data = generator.buildDashboardData(clusters);
      expect(data.topic_clusters.length).toBe(1);
      expect(data.topic_clusters[0]!.members.length).toBe(2);
    });
  });

  describe("generateDashboard", () => {
    it("writes Dashboard.md to vault root", async () => {
      const filePath = await generator.generateDashboard();
      expect(filePath).toBe(join(tmpDir, "Dashboard.md"));
      expect(existsSync(filePath)).toBe(true);
    });

    it("contains expected sections", async () => {
      await objectStore.create("Test Doc", "Content", { source: "test", source_id: "1" }, schema);

      const filePath = await generator.generateDashboard();
      const content = await readFile(filePath, "utf-8");

      expect(content).toContain("# Vault Dashboard");
      expect(content).toContain("## Health");
      expect(content).toContain("Total Objects");
      expect(content).toContain("Embedding Coverage");
      expect(content).toContain("## Dynamic Queries");
      expect(content).toContain("```dataview");
    });

    it("includes cluster section when clusters provided", async () => {
      const clusters = [{
        cluster_id: 0,
        members: [{ object_id: "a", classification: "core" as const }],
        representative_id: "a",
        label: "TypeScript Cluster",
      }];

      const filePath = await generator.generateDashboard(clusters);
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("## Topic Clusters");
      expect(content).toContain("TypeScript Cluster");
    });

    it("emits vault.dashboard_generated event", async () => {
      const events: Array<{ type: string }> = [];
      const gen = new DashboardGenerator({
        objectStore,
        linkStore,
        vaultRoot: tmpDir,
        emitEvent: async (type) => { events.push({ type }); },
      });

      await gen.generateDashboard();
      expect(events.some((e) => e.type === "vault.dashboard_generated")).toBe(true);
    });
  });

  describe("generateDashboard rendering", () => {
    it("renders recent activity section when objects exist", async () => {
      await objectStore.create("Fresh Doc", "Content", {
        source: "test",
        source_id: "fresh-1",
        created_at: new Date().toISOString(),
      }, schema);

      const filePath = await generator.generateDashboard();
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("## Recent Activity");
      expect(content).toContain("Fresh Doc");
    });

    it("renders topic clusters section when clusters provided", async () => {
      const clusters = [
        {
          cluster_id: 0,
          members: [
            { object_id: "a", classification: "core" as const },
            { object_id: "b", classification: "border" as const },
          ],
          representative_id: "a",
          label: "TypeScript Docs",
        },
        {
          cluster_id: 1,
          members: [
            { object_id: "c", classification: "core" as const },
          ],
          representative_id: "c",
        },
      ];

      const filePath = await generator.generateDashboard(clusters);
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("## Topic Clusters");
      expect(content).toContain("### TypeScript Docs");
      expect(content).toContain("### Cluster 1"); // fallback label
      expect(content).toContain("Representative: `a`");
      expect(content).toContain("`a` (core)");
      expect(content).toContain("`b` (border)");
    });
  });

  describe("fallback insights rendering", () => {
    it("includes top entities section when objects have links", async () => {
      const obj1 = await objectStore.create("TypeScript", "TS", {
        source: "test", source_id: "fi-1", object_type: "Tool",
      }, schema);
      const obj2 = await objectStore.create("Doc about TS", "Uses TypeScript", {
        source: "test", source_id: "fi-2",
      }, schema);

      await linkStore.addLink({
        source_id: obj2.frontmatter.object_id,
        target_id: obj1.frontmatter.object_id,
        link_type: "discusses",
        confidence: 0.9,
      });

      const filePath = await generator.generateInsights();
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("## Most Connected Entities");
      expect(content).toContain("TypeScript");
    });

    it("includes topic clusters section in fallback insights when clusters provided", async () => {
      const clusters = [{
        cluster_id: 0,
        members: [
          { object_id: "a", classification: "core" as const },
          { object_id: "b", classification: "core" as const },
        ],
        representative_id: "a",
      }];

      // Create generator that can pass clusters to buildDashboardData
      const gen = new DashboardGenerator({
        objectStore,
        linkStore,
        vaultRoot: tmpDir,
      });

      // Generate insights with clusters — no insightsFn so fallback is used
      const filePath = await gen.generateInsights(undefined, clusters);
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("## Topic Clusters");
      expect(content).toContain("1 topic clusters");
    });
  });

  describe("generateDashboard top entities", () => {
    it("renders Top Entities section in Dashboard.md when entities have links", async () => {
      const person = await objectStore.create("Alice", "A person", {
        source: "entity", source_id: "alice", object_type: "Person",
      }, schema);
      const conv = await objectStore.create("Chat with Alice", "Discussion", {
        source: "test", source_id: "te-1",
      }, schema);

      await linkStore.addLink({
        source_id: conv.frontmatter.object_id,
        target_id: person.frontmatter.object_id,
        link_type: "mentions",
        confidence: 0.9,
      });

      const filePath = await generator.generateDashboard();
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("## Top Entities");
      expect(content).toContain("Alice");
      expect(content).toContain("Person");
    });
  });

  describe("generateInsights", () => {
    it("writes Insights.md with fallback when no InsightsFn", async () => {
      await objectStore.create("Doc", "Content", { source: "test", source_id: "1" }, schema);

      const filePath = await generator.generateInsights();
      expect(existsSync(filePath)).toBe(true);

      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("# Vault Insights");
      expect(content).toContain("## Summary");
      expect(content).toContain("1 objects");
    });

    it("uses InsightsFn when provided", async () => {
      const insightsFn: InsightsFn = async (data) => {
        return `## AI Analysis\n\nThe vault has ${data.total_objects} objects. This is a custom insight.`;
      };

      const filePath = await generator.generateInsights(insightsFn);
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("AI Analysis");
      expect(content).toContain("custom insight");
    });

    it("falls back gracefully when InsightsFn throws", async () => {
      const failingFn: InsightsFn = async () => {
        throw new Error("LLM unavailable");
      };

      const filePath = await generator.generateInsights(failingFn);
      const content = await readFile(filePath, "utf-8");
      expect(content).toContain("## Summary"); // fallback content
    });

    it("emits vault.insights_generated event", async () => {
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const gen = new DashboardGenerator({
        objectStore,
        linkStore,
        vaultRoot: tmpDir,
        emitEvent: async (type, payload) => { events.push({ type, payload }); },
      });

      await gen.generateInsights();
      const event = events.find((e) => e.type === "vault.insights_generated");
      expect(event).toBeTruthy();
      expect(event!.payload.has_llm_insights).toBe(false);
    });
  });
});

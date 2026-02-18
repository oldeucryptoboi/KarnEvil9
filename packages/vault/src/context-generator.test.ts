import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { existsSync } from "node:fs";
import { ContextGenerator } from "./context-generator.js";
import { ObjectStore } from "./object-store.js";
import { LinkStore } from "./link-store.js";
import { getDefaultSchema } from "./ontology-schema.js";

describe("ContextGenerator", () => {
  let tmpDir: string;
  let objectStore: ObjectStore;
  let linkStore: LinkStore;
  let generator: ContextGenerator;
  const schema = getDefaultSchema();

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vault-context-test-${uuid()}`);
    await mkdir(tmpDir, { recursive: true });

    objectStore = new ObjectStore(tmpDir);
    await objectStore.init();

    linkStore = new LinkStore(join(tmpDir, "links.jsonl"));
    await linkStore.init();

    generator = new ContextGenerator(objectStore, linkStore, tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("generates a briefing with empty vault", async () => {
    const briefing = await generator.generate();
    expect(briefing.generated_at).toBeTruthy();
    expect(briefing.recent_conversations).toEqual([]);
    expect(briefing.active_projects).toEqual([]);
    expect(briefing.key_entities).toEqual([]);
  });

  it("includes recent conversations in briefing", async () => {
    await objectStore.create("Chat about TypeScript", "Content", {
      source: "chatgpt",
      source_id: "conv-1",
      object_type: "Conversation",
      para_category: "resources",
      entities: ["TypeScript"],
      created_at: new Date().toISOString(),
    }, schema);

    const briefing = await generator.generate();
    expect(briefing.recent_conversations.length).toBe(1);
    expect(briefing.recent_conversations[0]!.title).toBe("Chat about TypeScript");
  });

  it("includes active projects in briefing", async () => {
    await objectStore.create("Project Alpha", "Active project", {
      source: "manual",
      source_id: "proj-1",
      object_type: "Project",
      para_category: "projects",
    }, schema);

    const briefing = await generator.generate();
    expect(briefing.active_projects.length).toBe(1);
    expect(briefing.active_projects[0]!.title).toBe("Project Alpha");
  });

  it("writes context file to _Meta/current-context.md", async () => {
    const filePath = await generator.writeContextFile();
    expect(filePath).toBe(join(tmpDir, "_Meta", "current-context.md"));
    expect(existsSync(filePath)).toBe(true);

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("# Current Context");
    expect(content).toContain("generated_at:");
    expect(content).toContain("## Recent Conversations");
    expect(content).toContain("## Active Projects");
    expect(content).toContain("## Key Entities");
    expect(content).toContain("*Generated:");
  });

  it("writes context with populated data", async () => {
    await objectStore.create("My Project", "Details", {
      source: "manual",
      source_id: "p1",
      object_type: "Project",
      para_category: "projects",
    }, schema);

    const filePath = await generator.writeContextFile();
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("My Project");
  });

  it("includes open threads from last 48h", async () => {
    await objectStore.create("Recent Chat", "Content", {
      source: "chatgpt",
      source_id: "thread-1",
      object_type: "Conversation",
      para_category: "resources",
      entities: [],
      created_at: new Date().toISOString(),
    }, schema);

    const briefing = await generator.generate();
    expect(briefing.open_threads).toBeDefined();
    expect(briefing.open_threads!.length).toBe(1);
    expect(briefing.open_threads![0]!.title).toBe("Recent Chat");
    expect(briefing.open_threads![0]!.source).toBe("chatgpt");
  });

  it("includes lessons from provider", async () => {
    const lessonsGen = new ContextGenerator(
      objectStore,
      linkStore,
      tmpDir,
      () => ["Always write tests", "Use TypeScript strict mode"],
    );

    const briefing = await lessonsGen.generate();
    expect(briefing.recent_lessons).toEqual(["Always write tests", "Use TypeScript strict mode"]);

    const filePath = await lessonsGen.writeContextFile(briefing);
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("## Recent Lessons");
    expect(content).toContain("Always write tests");
  });

  it("includes open threads section in context file", async () => {
    await objectStore.create("Active Thread", "Ongoing discussion", {
      source: "claude",
      source_id: "t-1",
      object_type: "Conversation",
      para_category: "resources",
      entities: [],
      created_at: new Date().toISOString(),
    }, schema);

    const filePath = await generator.writeContextFile();
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("## Open Threads");
    expect(content).toContain("Active Thread");
  });

  it("includes key_entities with top_linked when objects have links", async () => {
    // Create a Person entity
    const person = await objectStore.create("Alice", "A developer", {
      source: "entity",
      source_id: "alice",
      object_type: "Person",
      para_category: "resources",
    }, schema);

    // Create conversation objects that link to the person
    const conv1 = await objectStore.create("Chat about TypeScript", "TS discussion with Alice", {
      source: "chatgpt",
      source_id: "conv-link-1",
      object_type: "Conversation",
      para_category: "resources",
      entities: ["Alice"],
      created_at: new Date().toISOString(),
    }, schema);

    const conv2 = await objectStore.create("Project Review", "Review with Alice", {
      source: "chatgpt",
      source_id: "conv-link-2",
      object_type: "Conversation",
      para_category: "resources",
      entities: ["Alice"],
      created_at: new Date().toISOString(),
    }, schema);

    // Create links from conversations to person
    await linkStore.addLink({
      source_id: conv1.frontmatter.object_id,
      target_id: person.frontmatter.object_id,
      link_type: "mentions",
      confidence: 0.9,
    });
    await linkStore.addLink({
      source_id: conv2.frontmatter.object_id,
      target_id: person.frontmatter.object_id,
      link_type: "mentions",
      confidence: 0.85,
    });

    const briefing = await generator.generate();
    expect(briefing.key_entities.length).toBeGreaterThanOrEqual(1);

    // The entity with links should have top_linked
    const personEntity = briefing.key_entities.find((e) => e.mention_count >= 2);
    expect(personEntity).toBeDefined();
    expect(personEntity!.top_linked).toBeDefined();
    expect(personEntity!.top_linked!.length).toBeGreaterThanOrEqual(1);
  });

  it("writes context file with key_entities including top_linked arrows", async () => {
    // Create a Person entity
    const person = await objectStore.create("Bob", "An engineer", {
      source: "entity",
      source_id: "bob",
      object_type: "Person",
      para_category: "resources",
    }, schema);

    // Create a linked object
    const note = await objectStore.create("Meeting with Bob", "Discussed project", {
      source: "test",
      source_id: "note-bob-1",
      object_type: "Note",
      para_category: "resources",
    }, schema);

    // Create link
    await linkStore.addLink({
      source_id: note.frontmatter.object_id,
      target_id: person.frontmatter.object_id,
      link_type: "mentions",
      confidence: 0.9,
    });

    const filePath = await generator.writeContextFile();
    const content = await readFile(filePath, "utf-8");

    // Should have key entities section with actual entries
    expect(content).toContain("## Key Entities");
    // Should not have "_No key entities yet._" since we have entities with links
    expect(content).not.toContain("_No key entities yet._");
  });

  describe("briefing archival", () => {
    it("archives current context file before overwriting", async () => {
      // Write first context
      await generator.writeContextFile();

      // Write second context — first should be archived
      await generator.writeContextFile();

      const archiveDir = join(tmpDir, "_Meta", "archive");
      expect(existsSync(archiveDir)).toBe(true);

      const files = await readdir(archiveDir);
      const contextFiles = files.filter((f) => f.startsWith("context-") && f.endsWith(".md"));
      expect(contextFiles.length).toBe(1);
    });

    it("creates _Meta/archive directory if missing", async () => {
      const archiveDir = join(tmpDir, "_Meta", "archive");
      expect(existsSync(archiveDir)).toBe(false);

      await generator.writeContextFile();
      // First write has nothing to archive, but second write should create dir
      await generator.writeContextFile();
      expect(existsSync(archiveDir)).toBe(true);
    });

    it("archive file name contains ISO-derived timestamp", async () => {
      await generator.writeContextFile();
      await generator.writeContextFile();

      const files = await readdir(join(tmpDir, "_Meta", "archive"));
      const contextFiles = files.filter((f) => f.startsWith("context-"));
      expect(contextFiles.length).toBe(1);
      // ISO format: context-2026-02-17T... with colons replaced by dashes
      expect(contextFiles[0]).toMatch(/^context-\d{4}-\d{2}-\d{2}T/);
    });

    it("prunes oldest files when exceeding maxFiles", async () => {
      // Create generator with maxFiles=2
      const smallGen = new ContextGenerator(objectStore, linkStore, tmpDir, undefined, 2);

      // Seed archive with 5 files with distinct timestamps to avoid collision
      const archiveDir = join(tmpDir, "_Meta", "archive");
      await mkdir(archiveDir, { recursive: true });
      for (let i = 0; i < 5; i++) {
        const name = `context-2020-01-0${i + 1}T00-00-00-000Z.md`;
        await writeFile(join(archiveDir, name), `briefing ${i}`, "utf-8");
      }

      // Write a context file first so archiveCurrentBriefing has something to copy
      await smallGen.writeContextFile();
      // Write again — archives current, adding a 6th file, then pruneArchive removes 4
      await smallGen.writeContextFile();

      const files = await readdir(archiveDir);
      const contextFiles = files.filter((f) => f.startsWith("context-") && f.endsWith(".md"));
      expect(contextFiles.length).toBe(2);
    });

    it("works on first run with no existing context file", async () => {
      // Should not throw when there's nothing to archive
      const filePath = await generator.writeContextFile();
      expect(existsSync(filePath)).toBe(true);
    });
  });
});

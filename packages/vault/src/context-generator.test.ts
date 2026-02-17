import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, readFile } from "node:fs/promises";
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

  it("writes context file to disk", async () => {
    const filePath = await generator.writeContextFile();
    expect(existsSync(filePath)).toBe(true);

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("# Current Context");
    expect(content).toContain("generated_at:");
    expect(content).toContain("## Recent Conversations");
    expect(content).toContain("## Active Projects");
    expect(content).toContain("## Key Entities");
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
});

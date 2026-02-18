import { describe, it, expect } from "vitest";
import { ClassificationPipeline } from "./classification-pipeline.js";
import { getDefaultSchema } from "./ontology-schema.js";
import type { ClassifierFn, ClassificationResult } from "./types.js";

function mockClassifier(): ClassifierFn {
  return async (title, content, availableTypes) => ({
    object_type: "Conversation",
    para_category: "resources",
    tags: ["test"],
    entities: [{ name: "TypeScript", type: "Tool", link_type: "discusses" }],
    confidence: 0.85,
  });
}

function failingClassifier(): ClassifierFn {
  return async () => {
    throw new Error("Classification failed");
  };
}

describe("ClassificationPipeline", () => {
  const schema = getDefaultSchema();

  it("classifies a single item", async () => {
    const pipeline = new ClassificationPipeline({
      classifier: mockClassifier(),
      schema,
    });

    const result = await pipeline.classifyOne("Test Title", "Test content");
    expect(result.object_type).toBe("Conversation");
    expect(result.confidence).toBe(0.85);
    expect(result.tags).toContain("test");
    expect(result.entities.length).toBe(1);
  });

  it("classifies a batch of items", async () => {
    const pipeline = new ClassificationPipeline({
      classifier: mockClassifier(),
      schema,
    });

    const items = [
      { objectId: "obj-1", title: "First", content: "Content 1" },
      { objectId: "obj-2", title: "Second", content: "Content 2" },
      { objectId: "obj-3", title: "Third", content: "Content 3" },
    ];

    const results = await pipeline.classifyBatch(items);
    expect(results.size).toBe(3);
    expect(results.get("obj-1")!.object_type).toBe("Conversation");
  });

  it("handles errors in batch classification", async () => {
    const pipeline = new ClassificationPipeline({
      classifier: failingClassifier(),
      schema,
    });

    const items = [
      { objectId: "obj-1", title: "Fail", content: "Content" },
    ];

    const errors: string[] = [];
    const results = await pipeline.classifyBatch(
      items,
      undefined,
      (objectId) => { errors.push(objectId); },
    );

    expect(results.size).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]).toBe("obj-1");
  });

  it("calls onResult callback for each success", async () => {
    const pipeline = new ClassificationPipeline({
      classifier: mockClassifier(),
      schema,
    });

    const items = [
      { objectId: "obj-1", title: "A", content: "B" },
      { objectId: "obj-2", title: "C", content: "D" },
    ];

    const successes: string[] = [];
    await pipeline.classifyBatch(items, (id) => { successes.push(id); });
    expect(successes).toEqual(["obj-1", "obj-2"]);
  });

  it("classifyUnclassified filters and classifies only unclassified objects", async () => {
    const pipeline = new ClassificationPipeline({
      classifier: mockClassifier(),
      schema,
    });

    const objects = [
      {
        frontmatter: {
          object_id: "obj-1",
          object_type: "Note",
          source: "test",
          source_id: "s1",
          created_at: new Date().toISOString(),
          ingested_at: new Date().toISOString(),
          tags: [],
          entities: [],
          para_category: "inbox" as const,
          confidence: 0,
          classified_by: "unclassified",
        },
        title: "Unclassified Item",
        content: "Needs classification",
        file_path: "_Inbox/Unclassified Item.md",
        links: [],
      },
      {
        frontmatter: {
          object_id: "obj-2",
          object_type: "Conversation",
          source: "test",
          source_id: "s2",
          created_at: new Date().toISOString(),
          ingested_at: new Date().toISOString(),
          tags: ["classified"],
          entities: [],
          para_category: "resources" as const,
          confidence: 0.9,
          classified_by: "claude-classifier",
        },
        title: "Already Classified",
        content: "Already done",
        file_path: "03-Resources/Already Classified.md",
        links: [],
      },
      {
        frontmatter: {
          object_id: "obj-3",
          object_type: "Note",
          source: "test",
          source_id: "s3",
          created_at: new Date().toISOString(),
          ingested_at: new Date().toISOString(),
          tags: [],
          entities: [],
          para_category: "inbox" as const,
          confidence: 0,
          classified_by: "some-other",
        },
        title: "Zero Confidence",
        content: "Needs reclassification",
        file_path: "_Inbox/Zero Confidence.md",
        links: [],
      },
    ];

    const successes: string[] = [];
    const results = await pipeline.classifyUnclassified(
      objects,
      (id) => { successes.push(id); },
    );

    // obj-1 (classified_by=unclassified) and obj-3 (confidence=0) should be classified
    // obj-2 (confidence=0.9, classified_by=claude-classifier) should be skipped
    expect(results.size).toBe(2);
    expect(results.has("obj-1")).toBe(true);
    expect(results.has("obj-3")).toBe(true);
    expect(results.has("obj-2")).toBe(false);
    expect(successes).toEqual(["obj-1", "obj-3"]);
  });

  it("classifyUnclassified with error callback", async () => {
    const pipeline = new ClassificationPipeline({
      classifier: failingClassifier(),
      schema,
    });

    const objects = [
      {
        frontmatter: {
          object_id: "obj-err",
          object_type: "Note",
          source: "test",
          source_id: "e1",
          created_at: new Date().toISOString(),
          ingested_at: new Date().toISOString(),
          tags: [],
          entities: [],
          para_category: "inbox" as const,
          confidence: 0,
          classified_by: "unclassified",
        },
        title: "Will Fail",
        content: "Error content",
        file_path: "_Inbox/Will Fail.md",
        links: [],
      },
    ];

    const errors: string[] = [];
    const results = await pipeline.classifyUnclassified(
      objects,
      undefined,
      (id) => { errors.push(id); },
    );

    expect(results.size).toBe(0);
    expect(errors).toEqual(["obj-err"]);
  });

  it("respects concurrency setting", async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const slowClassifier: ClassifierFn = async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((r) => setTimeout(r, 10));
      concurrentCount--;
      return {
        object_type: "Note",
        para_category: "inbox",
        tags: [],
        entities: [],
        confidence: 0.5,
      };
    };

    const pipeline = new ClassificationPipeline({
      classifier: slowClassifier,
      schema,
      concurrency: 2,
    });

    const items = Array.from({ length: 6 }, (_, i) => ({
      objectId: `obj-${i}`,
      title: `Item ${i}`,
      content: `Content ${i}`,
    }));

    await pipeline.classifyBatch(items);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});

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

import type { ClassifierFn, ClassificationResult, VaultObject } from "./types.js";
import type { OntologySchema } from "./types.js";
import { getObjectTypeNames } from "./ontology-schema.js";

export interface ClassificationPipelineOptions {
  classifier: ClassifierFn;
  schema: OntologySchema;
  concurrency?: number;
}

export class ClassificationPipeline {
  private classifier: ClassifierFn;
  private schema: OntologySchema;
  private concurrency: number;

  constructor(options: ClassificationPipelineOptions) {
    this.classifier = options.classifier;
    this.schema = options.schema;
    this.concurrency = options.concurrency ?? 3;
  }

  async classifyOne(title: string, content: string): Promise<ClassificationResult> {
    const availableTypes = getObjectTypeNames(this.schema);
    return this.classifier(title, content, availableTypes);
  }

  async classifyBatch(
    items: Array<{ objectId: string; title: string; content: string }>,
    onResult?: (objectId: string, result: ClassificationResult) => void | Promise<void>,
    onError?: (objectId: string, error: Error) => void | Promise<void>,
  ): Promise<Map<string, ClassificationResult>> {
    const results = new Map<string, ClassificationResult>();
    const queue = [...items];
    const active: Promise<void>[] = [];

    const processNext = async (): Promise<void> => {
      while (queue.length > 0) {
        const item = queue.shift()!;
        try {
          const result = await this.classifyOne(item.title, item.content);
          results.set(item.objectId, result);
          try { await onResult?.(item.objectId, result); } catch { /* callback error must not halt batch */ }
        } catch (err) {
          try { await onError?.(item.objectId, err instanceof Error ? err : new Error(String(err))); } catch { /* callback error must not halt batch */ }
        }
      }
    };

    for (let i = 0; i < Math.min(this.concurrency, items.length); i++) {
      active.push(processNext());
    }

    await Promise.all(active);
    return results;
  }

  async classifyUnclassified(
    objects: VaultObject[],
    onResult?: (objectId: string, result: ClassificationResult) => void | Promise<void>,
    onError?: (objectId: string, error: Error) => void | Promise<void>,
  ): Promise<Map<string, ClassificationResult>> {
    const unclassified = objects.filter(
      (obj) => obj.frontmatter.classified_by === "unclassified" || obj.frontmatter.confidence === 0,
    );

    const items = unclassified.map((obj) => ({
      objectId: obj.frontmatter.object_id,
      title: obj.title,
      content: obj.content,
    }));

    return this.classifyBatch(items, onResult, onError);
  }
}

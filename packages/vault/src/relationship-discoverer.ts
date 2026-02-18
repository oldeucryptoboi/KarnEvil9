import type { JournalEventType } from "@karnevil9/schemas";
import type { VectorStore } from "./vector-store.js";
import type { OPTICSClusterer } from "./clusterer.js";
import type { ObjectStore } from "./object-store.js";
import type { LinkStore } from "./link-store.js";
import type {
  ClassifierFn,
  DiscoverRelationshipsOptions,
  DiscoverRelationshipsResult,
  ClusterResult,
} from "./types.js";

export interface RelationshipDiscovererOptions {
  vectorStore: VectorStore;
  clusterer: OPTICSClusterer;
  objectStore: ObjectStore;
  linkStore: LinkStore;
  classifier?: ClassifierFn;
  emitEvent?: (type: JournalEventType, payload: Record<string, unknown>) => Promise<void>;
}

export class RelationshipDiscoverer {
  private vectorStore: VectorStore;
  private clusterer: OPTICSClusterer;
  private objectStore: ObjectStore;
  private linkStore: LinkStore;
  private classifier: ClassifierFn | null;
  private emitEvent: (type: JournalEventType, payload: Record<string, unknown>) => Promise<void>;

  constructor(options: RelationshipDiscovererOptions) {
    this.vectorStore = options.vectorStore;
    this.clusterer = options.clusterer;
    this.objectStore = options.objectStore;
    this.linkStore = options.linkStore;
    this.classifier = options.classifier ?? null;
    this.emitEvent = options.emitEvent ?? (async () => {});
  }

  async discover(options?: DiscoverRelationshipsOptions): Promise<{
    result: DiscoverRelationshipsResult;
    clusters: ClusterResult[];
  }> {
    const threshold = options?.cosine_threshold ?? 0.85;
    const maxCandidates = options?.max_candidates ?? 2000;
    const labelViaLlm = options?.label_via_llm ?? true;
    const labelBatchSize = options?.label_batch_size ?? 10;

    // Step 1: Embed unembedded objects
    const allEntries = this.objectStore.search({ limit: maxCandidates });
    const unembeddedIds = allEntries
      .filter((e) => !this.vectorStore.hasEmbedding(e.object_id))
      .map((e) => e.object_id);

    const embeddingsCreated = await this.vectorStore.embed(
      unembeddedIds,
      async (id) => {
        const obj = await this.objectStore.get(id);
        if (!obj) return null;
        return `${obj.title}\n\n${obj.content}`;
      },
    );

    // Step 2: Cluster via OPTICS
    const clusterInput = allEntries
      .filter((e) => this.vectorStore.hasEmbedding(e.object_id))
      .map((e) => ({
        id: e.object_id,
        vector: this.vectorStore.getEmbedding(e.object_id)!,
      }));

    const clusters = this.clusterer.cluster(clusterInput);

    // Step 3: Find strong similar pairs
    const pairs = this.vectorStore.findSimilarPairs(threshold);

    // Step 4: Deduplicate against existing links
    const newPairs = pairs.filter((pair) => {
      const existing = this.linkStore.getLinksForObject(pair.id_a)
        .find((l) =>
          (l.source_id === pair.id_a && l.target_id === pair.id_b) ||
          (l.source_id === pair.id_b && l.target_id === pair.id_a),
        );
      return !existing;
    });

    // Step 5: Label relationships — LLM batch when requested + available, heuristic otherwise
    const linkTypes: string[] = new Array(newPairs.length).fill("related_to");

    if (labelViaLlm && this.classifier && newPairs.length > 0) {
      // LLM batch labeling
      for (let i = 0; i < newPairs.length; i += labelBatchSize) {
        const batch = newPairs.slice(i, i + labelBatchSize);
        try {
          const labels = await this.labelBatch(batch);
          for (let j = 0; j < labels.length; j++) {
            linkTypes[i + j] = labels[j]!;
          }
        } catch {
          // Fallback: all pairs in this batch keep "related_to"
        }
      }
    } else {
      // Heuristic labeling — free, instant
      for (let i = 0; i < newPairs.length; i++) {
        linkTypes[i] = await this.labelHeuristic(newPairs[i]!);
      }
    }

    // Step 6: Create links
    let linksCreated = 0;
    for (let i = 0; i < newPairs.length; i++) {
      const pair = newPairs[i]!;
      await this.linkStore.addLink({
        source_id: pair.id_a,
        target_id: pair.id_b,
        link_type: linkTypes[i]!,
        confidence: pair.score,
      });
      linksCreated++;
    }

    const result: DiscoverRelationshipsResult = {
      embeddings_created: embeddingsCreated,
      clusters_found: clusters.length,
      relationships_discovered: newPairs.length,
      links_created: linksCreated,
    };

    // Step 7: Emit event
    await this.emitEvent("vault.relationships_discovered" as JournalEventType, {
      ...result,
    });

    return { result, clusters };
  }

  /**
   * Label a pair heuristically using object type metadata, tags, entities,
   * and content cross-references. Zero cost, instant speed.
   */
  private async labelHeuristic(
    pair: { id_a: string; id_b: string; score: number },
  ): Promise<string> {
    const objA = await this.objectStore.get(pair.id_a);
    const objB = await this.objectStore.get(pair.id_b);
    if (!objA || !objB) return "related_to";

    const typeA = objA.frontmatter.object_type;
    const typeB = objB.frontmatter.object_type;
    const tagsA = new Set(objA.frontmatter.tags);
    const tagsB = new Set(objB.frontmatter.tags);
    const entitiesA = new Set(objA.frontmatter.entities);
    const entitiesB = new Set(objB.frontmatter.entities);

    // Rule 1: Conversation → Conversation = preceded_by
    if (typeA === "Conversation" && typeB === "Conversation") return "preceded_by";

    // Rule 2: Anything → Person/Organization = mentions
    if (["Person", "Organization"].includes(typeB)) return "mentions";
    if (["Person", "Organization"].includes(typeA)) return "mentions";

    // Rule 3: Project/Conversation → Tool = uses
    if (["Project", "Conversation"].includes(typeA) && typeB === "Tool") return "uses";
    if (["Project", "Conversation"].includes(typeB) && typeA === "Tool") return "uses";

    // Rule 4: Conversation/Note → Concept/Tool/Project = discusses
    if (["Conversation", "Note"].includes(typeA) && ["Concept", "Tool", "Project"].includes(typeB)) return "discusses";
    if (["Conversation", "Note"].includes(typeB) && ["Concept", "Tool", "Project"].includes(typeA)) return "discusses";

    // Rule 5: Document/Note → Person = authored_by (already caught by Rule 2)

    // Rule 6: Anything → Project/Organization = part_of (if one mentions the other's title)
    if (typeB === "Project" || typeB === "Organization") {
      if (objA.content.toLowerCase().includes(objB.title.toLowerCase())) return "part_of";
    }
    if (typeA === "Project" || typeA === "Organization") {
      if (objB.content.toLowerCase().includes(objA.title.toLowerCase())) return "part_of";
    }

    // Rule 7: Project → Project/Tool with shared tags = depends_on
    if (typeA === "Project" && ["Project", "Tool"].includes(typeB)) {
      const overlap = [...tagsA].filter(t => tagsB.has(t));
      if (overlap.length > 0) return "depends_on";
    }
    if (typeB === "Project" && ["Project", "Tool"].includes(typeA)) {
      const overlap = [...tagsB].filter(t => tagsA.has(t));
      if (overlap.length > 0) return "depends_on";
    }

    // Rule 8: Title/entity cross-reference = mentions
    if (entitiesA.has(objB.title) || entitiesB.has(objA.title)) return "mentions";

    // Default
    return "related_to";
  }

  /**
   * Label a batch of pairs via a single classifier call.
   * Returns an array of link types, one per pair.
   */
  private async labelBatch(
    batch: Array<{ id_a: string; id_b: string; score: number }>,
  ): Promise<string[]> {
    const VALID_TYPES = ["discusses", "uses", "related_to", "depends_on", "mentions", "part_of"];
    const lines: string[] = [];

    for (let i = 0; i < batch.length; i++) {
      const pair = batch[i]!;
      const objA = await this.objectStore.get(pair.id_a);
      const objB = await this.objectStore.get(pair.id_b);
      if (!objA || !objB) {
        lines.push(`${i + 1}. [unknown] <-> [unknown]`);
        continue;
      }
      lines.push(`${i + 1}. "${objA.title}" (${objA.content.slice(0, 200)}) <-> "${objB.title}" (${objB.content.slice(0, 200)})`);
    }

    const batchPrompt = `Classify the relationship type for each numbered pair below.
Available types: ${VALID_TYPES.join(", ")}

${lines.join("\n")}

Respond with ONLY a JSON array of objects, one per pair, in order:
[{"index":1,"link_type":"..."}, ...]`;

    const result = await this.classifier!(
      "Batch relationship classification",
      batchPrompt,
      VALID_TYPES,
    );

    // The classifier returns entities — try to extract batch labels from the response
    // If the classifier returns structured entities, use those
    if (result.entities.length >= batch.length) {
      return batch.map((_, i) => {
        const entity = result.entities[i];
        if (entity && VALID_TYPES.includes(entity.link_type)) {
          return entity.link_type;
        }
        return "related_to";
      });
    }

    // If the classifier returned fewer entities, map what we can
    return batch.map((_, i) => {
      const entity = result.entities[i];
      if (entity && VALID_TYPES.includes(entity.link_type)) {
        return entity.link_type;
      }
      return "related_to";
    });
  }
}

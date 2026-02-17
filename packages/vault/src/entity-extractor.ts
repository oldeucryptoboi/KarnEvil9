import type { ClassificationResult, VaultLink, OntologySchema } from "./types.js";
import type { ObjectStore } from "./object-store.js";
import type { LinkStore } from "./link-store.js";
import type { Deduplicator } from "./deduplicator.js";
import { getObjectType } from "./ontology-schema.js";

export interface ExtractedEntity {
  name: string;
  canonical_name: string;
  type: string;
  link_type: string;
  object_id?: string;
  is_new: boolean;
}

export interface EntityExtractionResult {
  entities: ExtractedEntity[];
  links_created: VaultLink[];
}

export class EntityExtractor {
  private objectStore: ObjectStore;
  private linkStore: LinkStore;
  private deduplicator: Deduplicator;
  private schema: OntologySchema;

  constructor(
    objectStore: ObjectStore,
    linkStore: LinkStore,
    deduplicator: Deduplicator,
    schema: OntologySchema,
  ) {
    this.objectStore = objectStore;
    this.linkStore = linkStore;
    this.deduplicator = deduplicator;
    this.schema = schema;
  }

  async extractAndLink(
    sourceObjectId: string,
    classification: ClassificationResult,
  ): Promise<EntityExtractionResult> {
    const entities: ExtractedEntity[] = [];
    const links: VaultLink[] = [];

    for (const entity of classification.entities) {
      const canonicalName = this.deduplicator.resolve(entity.name);
      const typeDef = getObjectType(this.schema, entity.type);

      // Check if entity object already exists
      let entityObjectId = this.objectStore.getBySourceId("entity", canonicalName);
      let isNew = false;

      if (!entityObjectId && typeDef) {
        // Create new entity object
        const entityObj = await this.objectStore.create(
          canonicalName,
          `Auto-extracted entity: ${canonicalName}`,
          {
            object_type: entity.type,
            source: "entity",
            source_id: canonicalName,
            tags: [],
            entities: [],
            para_category: "resources",
            confidence: classification.confidence,
            classified_by: "entity-extractor",
          },
          this.schema,
        );
        entityObjectId = entityObj.frontmatter.object_id;
        isNew = true;
      }

      if (entityObjectId) {
        // Create link from source to entity
        const link = await this.linkStore.addLink({
          source_id: sourceObjectId,
          target_id: entityObjectId,
          link_type: entity.link_type,
          confidence: classification.confidence,
        });
        links.push(link);

        // Register alias for future deduplication
        if (entity.name.toLowerCase() !== canonicalName) {
          this.deduplicator.addAlias(canonicalName, entity.name);
        }
      }

      entities.push({
        name: entity.name,
        canonical_name: canonicalName,
        type: entity.type,
        link_type: entity.link_type,
        object_id: entityObjectId,
        is_new: isNew,
      });
    }

    return { entities, links_created: links };
  }
}

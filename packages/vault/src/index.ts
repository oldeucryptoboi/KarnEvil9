export type {
  PropertyType,
  ParaCategory,
  PropertyDefinition,
  ObjectTypeDefinition,
  LinkTypeDefinition,
  OntologySchema,
  VaultObjectFrontmatter,
  VaultObject,
  VaultLink,
  IngestItem,
  ClassificationResult,
  ClassifierFn,
  VaultAdapter,
  IngestionRecord,
  VaultStats,
  ContextBriefing,
  JanitorResult,
  EmbedderFn,
  VectorSearchResult,
  ClusterMember,
  ClusterResult,
  DiscoverRelationshipsOptions,
  DiscoverRelationshipsResult,
  DashboardData,
  InsightsFn,
  DropZoneResult,
} from "./types.js";

export { PARA_FOLDERS } from "./types.js";

export {
  getDefaultSchema,
  loadSchemaFromFile,
  validateSchema,
  getObjectType,
  getObjectTypeNames,
  getLinkType,
  serializeSchemaToYaml,
} from "./ontology-schema.js";

export {
  serializeVaultObject,
  deserializeVaultObject,
  sanitizeFileName,
} from "./markdown-serializer.js";

export { ObjectStore } from "./object-store.js";
export type { IndexEntry } from "./object-store.js";
export { LinkStore } from "./link-store.js";
export { IngestionTracker } from "./ingestion-tracker.js";
export { Deduplicator, levenshtein } from "./deduplicator.js";
export { ClassificationPipeline } from "./classification-pipeline.js";
export type { ClassificationPipelineOptions } from "./classification-pipeline.js";
export { EntityExtractor } from "./entity-extractor.js";
export type { ExtractedEntity, EntityExtractionResult } from "./entity-extractor.js";
export { ContextGenerator } from "./context-generator.js";
export { VectorStore, cosineSimilarity } from "./vector-store.js";
export type { SimilarPair } from "./vector-store.js";
export { OPTICSClusterer } from "./clusterer.js";
export type { ClusterInput, OPTICSOptions } from "./clusterer.js";
export { RelationshipDiscoverer } from "./relationship-discoverer.js";
export type { RelationshipDiscovererOptions } from "./relationship-discoverer.js";
export { DashboardGenerator } from "./dashboard-generator.js";
export { DropZoneWatcher } from "./dropzone-watcher.js";
export type { DropZoneFile } from "./dropzone-watcher.js";
export { VaultManager } from "./vault-manager.js";
export type { VaultManagerOptions } from "./vault-manager.js";

// Adapters
export { BaseAdapter } from "./adapters/adapter.js";
export { JournalAdapter } from "./adapters/journal-adapter.js";
export type { JournalAdapterOptions } from "./adapters/journal-adapter.js";
export { ChatGPTAdapter } from "./adapters/chatgpt-adapter.js";
export { ClaudeAdapter } from "./adapters/claude-adapter.js";
export { WhatsAppAdapter } from "./adapters/whatsapp-adapter.js";
export { AppleNotesAdapter } from "./adapters/apple-notes-adapter.js";
export { GmailAdapter } from "./adapters/gmail-adapter.js";
export type { GmailAdapterOptions } from "./adapters/gmail-adapter.js";
export { GoogleDriveAdapter } from "./adapters/google-drive-adapter.js";
export type { GoogleDriveAdapterOptions } from "./adapters/google-drive-adapter.js";

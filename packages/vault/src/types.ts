export type PropertyType = "text" | "number" | "date" | "boolean" | "array" | "url" | "reference";
export type ParaCategory = "projects" | "areas" | "resources" | "archive" | "inbox";

export interface PropertyDefinition {
  name: string;
  type: PropertyType;
  required?: boolean;
  description?: string;
}

export interface ObjectTypeDefinition {
  name: string;
  plural: string;
  description: string;
  properties: PropertyDefinition[];
  folder: string;
}

export interface LinkTypeDefinition {
  name: string;
  source_types: string[];
  target_types: string[];
  bidirectional: boolean;
  inverse_name?: string;
}

export interface OntologySchema {
  version: string;
  object_types: ObjectTypeDefinition[];
  link_types: LinkTypeDefinition[];
  shared_properties: PropertyDefinition[];
}

export interface VaultObjectFrontmatter {
  object_id: string;
  object_type: string;
  source: string;
  source_id: string;
  created_at: string;
  ingested_at: string;
  tags: string[];
  entities: string[];
  para_category: ParaCategory;
  confidence: number;
  classified_by: string;
  [key: string]: unknown;
}

export interface VaultObject {
  frontmatter: VaultObjectFrontmatter;
  title: string;
  content: string;
  file_path: string;
  links: VaultLink[];
}

export interface VaultLink {
  link_id: string;
  source_id: string;
  target_id: string;
  link_type: string;
  confidence: number;
  created_at: string;
}

export interface IngestItem {
  source: string;
  source_id: string;
  title: string;
  content: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface ClassificationResult {
  object_type: string;
  para_category: ParaCategory;
  tags: string[];
  entities: Array<{ name: string; type: string; link_type: string }>;
  confidence: number;
}

export type ClassifierFn = (
  title: string,
  content: string,
  availableTypes: string[],
) => Promise<ClassificationResult>;

export interface VaultAdapter {
  readonly name: string;
  readonly source: string;
  extract(options?: Record<string, unknown>): AsyncGenerator<IngestItem, void, undefined>;
}

export interface IngestionRecord {
  source: string;
  source_id: string;
  content_hash: string;
  object_id: string;
  ingested_at: string;
}

export interface VaultStats {
  total_objects: number;
  total_links: number;
  objects_by_type: Record<string, number>;
  objects_by_category: Record<string, number>;
  unclassified_count: number;
}

export interface ContextBriefing {
  generated_at: string;
  recent_conversations: Array<{ title: string; date: string; entities: string[] }>;
  active_projects: Array<{ title: string; status: string }>;
  key_entities: Array<{ name: string; type: string; mention_count: number; top_linked?: string[] }>;
  recent_lessons: string[];
  open_threads?: Array<{ title: string; date: string; source: string }>;
}

// ─── Janitor ──────────────────────────────────────────────────────────

export interface JanitorResult {
  orphaned_links_removed: number;
  frontmatter_fixed: number;
  duplicates_merged: number;
  stale_archived: number;
  tracker_compacted: boolean;
  wikilink_stubs_created: number;
}

// ─── Vector Pipeline ──────────────────────────────────────────────────

export type EmbedderFn = (texts: string[]) => Promise<number[][]>;

export interface VectorSearchResult {
  object_id: string;
  score: number;
  title: string;
  object_type: string;
}

export interface ClusterMember {
  object_id: string;
  classification: "core" | "border" | "noise";
}

export interface ClusterResult {
  cluster_id: number;
  members: ClusterMember[];
  representative_id: string;
  label?: string;
}

export interface DiscoverRelationshipsOptions {
  cosine_threshold?: number;
  max_candidates?: number;
  label_via_llm?: boolean;
  label_batch_size?: number;
}

export interface DiscoverRelationshipsResult {
  embeddings_created: number;
  clusters_found: number;
  relationships_discovered: number;
  links_created: number;
}

// ─── Dashboard & Insights ─────────────────────────────────────────────

export interface DashboardData {
  generated_at: string;
  total_objects: number;
  total_links: number;
  unclassified_count: number;
  embedding_coverage: number;
  objects_by_type: Record<string, number>;
  objects_by_category: Record<string, number>;
  objects_by_source: Record<string, number>;
  top_entities: Array<{ name: string; type: string; mention_count: number }>;
  recent_activity: Array<{ title: string; source: string; ingested_at: string }>;
  topic_clusters: ClusterResult[];
}

export type InsightsFn = (stats: DashboardData) => Promise<string>;

// ─── DropZone ────────────────────────────────────────────────────────

export interface DropZoneResult {
  files_processed: number;
  files_failed: number;
  items_created: number;
  items_updated: number;
  items_skipped: number;
}

export const PARA_FOLDERS: Record<ParaCategory, string> = {
  projects: "01-Projects",
  areas: "02-Areas",
  resources: "03-Resources",
  archive: "04-Archive",
  inbox: "_Inbox",
};

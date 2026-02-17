import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import yaml from "js-yaml";
import type { OntologySchema, ObjectTypeDefinition, LinkTypeDefinition, PropertyDefinition } from "./types.js";

const DEFAULT_SHARED_PROPERTIES: PropertyDefinition[] = [
  { name: "created_at", type: "date", required: true },
  { name: "updated_at", type: "date" },
  { name: "tags", type: "array" },
  { name: "source", type: "text", required: true },
  { name: "confidence", type: "number" },
  { name: "para_category", type: "text" },
];

const DEFAULT_OBJECT_TYPES: ObjectTypeDefinition[] = [
  {
    name: "Person",
    plural: "People",
    description: "A person referenced in conversations or documents",
    properties: [
      { name: "role", type: "text" },
      { name: "organization", type: "reference" },
      { name: "email", type: "text" },
    ],
    folder: "People",
  },
  {
    name: "Project",
    plural: "Projects",
    description: "A project or initiative",
    properties: [
      { name: "status", type: "text" },
      { name: "priority", type: "text" },
      { name: "deadline", type: "date" },
    ],
    folder: "Projects",
  },
  {
    name: "Tool",
    plural: "Tools",
    description: "A software tool, framework, or technology",
    properties: [
      { name: "category", type: "text" },
      { name: "url", type: "url" },
      { name: "version", type: "text" },
    ],
    folder: "Tools",
  },
  {
    name: "Concept",
    plural: "Concepts",
    description: "An idea, pattern, or abstract concept",
    properties: [
      { name: "domain", type: "text" },
      { name: "definition", type: "text" },
    ],
    folder: "Concepts",
  },
  {
    name: "Organization",
    plural: "Organizations",
    description: "A company, team, or organizational entity",
    properties: [
      { name: "type", type: "text" },
      { name: "url", type: "url" },
    ],
    folder: "Organizations",
  },
  {
    name: "Conversation",
    plural: "Conversations",
    description: "A conversation from ChatGPT, Claude, or other sources",
    properties: [
      { name: "participants", type: "array" },
      { name: "message_count", type: "number" },
    ],
    folder: "Conversations",
  },
  {
    name: "Note",
    plural: "Notes",
    description: "A note from Apple Notes, WhatsApp, or manual entry",
    properties: [
      { name: "notebook", type: "text" },
    ],
    folder: "Notes",
  },
  {
    name: "Document",
    plural: "Documents",
    description: "A document from Google Drive, Gmail, or other sources",
    properties: [
      { name: "format", type: "text" },
      { name: "author", type: "reference" },
    ],
    folder: "Documents",
  },
];

const DEFAULT_LINK_TYPES: LinkTypeDefinition[] = [
  { name: "discusses", source_types: ["Conversation", "Note"], target_types: ["Concept", "Tool", "Project"], bidirectional: false },
  { name: "uses", source_types: ["Project", "Conversation"], target_types: ["Tool"], bidirectional: false },
  { name: "authored_by", source_types: ["Document", "Note", "Conversation"], target_types: ["Person"], bidirectional: false, inverse_name: "authored" },
  { name: "collaborates_with", source_types: ["Person"], target_types: ["Person"], bidirectional: true },
  { name: "depends_on", source_types: ["Project"], target_types: ["Project", "Tool"], bidirectional: false },
  { name: "related_to", source_types: ["*"], target_types: ["*"], bidirectional: true },
  { name: "mentions", source_types: ["Conversation", "Note", "Document"], target_types: ["Person", "Organization"], bidirectional: false },
  { name: "part_of", source_types: ["*"], target_types: ["Project", "Organization"], bidirectional: false, inverse_name: "contains" },
  { name: "preceded_by", source_types: ["Conversation"], target_types: ["Conversation"], bidirectional: false, inverse_name: "followed_by" },
];

export function getDefaultSchema(): OntologySchema {
  return {
    version: "1.0.0",
    object_types: DEFAULT_OBJECT_TYPES.map((ot) => ({ ...ot, properties: [...ot.properties] })),
    link_types: DEFAULT_LINK_TYPES.map((lt) => ({ ...lt, source_types: [...lt.source_types], target_types: [...lt.target_types] })),
    shared_properties: DEFAULT_SHARED_PROPERTIES.map((p) => ({ ...p })),
  };
}

export async function loadSchemaFromFile(filePath: string): Promise<OntologySchema> {
  if (!existsSync(filePath)) {
    throw new Error(`Ontology schema file not found: ${filePath}`);
  }
  const content = await readFile(filePath, "utf-8");
  const parsed = yaml.load(content) as OntologySchema;
  validateSchema(parsed);
  return parsed;
}

export function validateSchema(schema: OntologySchema): void {
  if (!schema.version || typeof schema.version !== "string") {
    throw new Error("Ontology schema must have a version string");
  }
  if (!Array.isArray(schema.object_types) || schema.object_types.length === 0) {
    throw new Error("Ontology schema must have at least one object type");
  }
  if (!Array.isArray(schema.link_types)) {
    throw new Error("Ontology schema must have a link_types array");
  }

  const typeNames = new Set<string>();
  for (const ot of schema.object_types) {
    if (!ot.name || !ot.plural || !ot.folder) {
      throw new Error(`Object type missing required fields: name=${ot.name}, plural=${ot.plural}, folder=${ot.folder}`);
    }
    if (typeNames.has(ot.name)) {
      throw new Error(`Duplicate object type: ${ot.name}`);
    }
    typeNames.add(ot.name);
  }

  const linkNames = new Set<string>();
  for (const lt of schema.link_types) {
    if (!lt.name || !Array.isArray(lt.source_types) || !Array.isArray(lt.target_types)) {
      throw new Error(`Link type missing required fields: name=${lt.name}`);
    }
    if (linkNames.has(lt.name)) {
      throw new Error(`Duplicate link type: ${lt.name}`);
    }
    linkNames.add(lt.name);
  }
}

export function getObjectType(schema: OntologySchema, name: string): ObjectTypeDefinition | undefined {
  return schema.object_types.find((ot) => ot.name === name);
}

export function getObjectTypeNames(schema: OntologySchema): string[] {
  return schema.object_types.map((ot) => ot.name);
}

export function getLinkType(schema: OntologySchema, name: string): LinkTypeDefinition | undefined {
  return schema.link_types.find((lt) => lt.name === name);
}

export function serializeSchemaToYaml(schema: OntologySchema): string {
  // Deep clone to avoid yaml.dump reference issues
  const clone = JSON.parse(JSON.stringify(schema));
  return yaml.dump(clone, { lineWidth: 120, noRefs: true });
}

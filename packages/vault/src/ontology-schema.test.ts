import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import {
  getDefaultSchema,
  loadSchemaFromFile,
  validateSchema,
  getObjectType,
  getObjectTypeNames,
  getLinkType,
  serializeSchemaToYaml,
} from "./ontology-schema.js";

describe("OntologySchema", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vault-schema-test-${uuid()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("getDefaultSchema", () => {
    it("returns a valid schema with all required fields", () => {
      const schema = getDefaultSchema();
      expect(schema.version).toBe("1.0.0");
      expect(schema.object_types.length).toBeGreaterThanOrEqual(8);
      expect(schema.link_types.length).toBeGreaterThanOrEqual(9);
      expect(schema.shared_properties.length).toBeGreaterThanOrEqual(5);
    });

    it("includes all expected object types", () => {
      const schema = getDefaultSchema();
      const names = schema.object_types.map((ot) => ot.name);
      expect(names).toContain("Person");
      expect(names).toContain("Project");
      expect(names).toContain("Tool");
      expect(names).toContain("Concept");
      expect(names).toContain("Organization");
      expect(names).toContain("Conversation");
      expect(names).toContain("Note");
      expect(names).toContain("Document");
    });

    it("includes all expected link types", () => {
      const schema = getDefaultSchema();
      const names = schema.link_types.map((lt) => lt.name);
      expect(names).toContain("discusses");
      expect(names).toContain("uses");
      expect(names).toContain("authored_by");
      expect(names).toContain("collaborates_with");
      expect(names).toContain("depends_on");
      expect(names).toContain("related_to");
      expect(names).toContain("mentions");
      expect(names).toContain("part_of");
      expect(names).toContain("preceded_by");
    });
  });

  describe("validateSchema", () => {
    it("passes for default schema", () => {
      expect(() => validateSchema(getDefaultSchema())).not.toThrow();
    });

    it("throws if version is missing", () => {
      const schema = { ...getDefaultSchema(), version: "" };
      expect(() => validateSchema(schema)).toThrow("version");
    });

    it("throws if object_types is empty", () => {
      const schema = { ...getDefaultSchema(), object_types: [] };
      expect(() => validateSchema(schema)).toThrow("at least one");
    });

    it("throws on duplicate object type names", () => {
      const schema = getDefaultSchema();
      schema.object_types.push(schema.object_types[0]!);
      expect(() => validateSchema(schema)).toThrow("Duplicate object type");
    });

    it("throws when link_types is not an array", () => {
      const schema = {
        version: "1.0.0",
        object_types: [{ name: "Note", plural: "Notes", description: "A note", properties: [], folder: "Notes" }],
        link_types: "not-an-array" as any,
        shared_properties: [],
      };
      expect(() => validateSchema(schema)).toThrow("link_types array");
    });

    it("throws when link type is missing required fields", () => {
      const schema = {
        version: "1.0.0",
        object_types: [{ name: "Note", plural: "Notes", description: "A note", properties: [], folder: "Notes" }],
        link_types: [
          { name: "discusses", source_types: ["Note"], target_types: ["Note"], bidirectional: false },
          { name: "", source_types: ["Note"], target_types: ["Note"], bidirectional: false },
        ],
        shared_properties: [],
      };
      expect(() => validateSchema(schema)).toThrow("missing required fields");
    });

    it("throws when link type has non-array source_types", () => {
      const schema = {
        version: "1.0.0",
        object_types: [{ name: "Note", plural: "Notes", description: "A note", properties: [], folder: "Notes" }],
        link_types: [
          { name: "bad_link", source_types: "not-array", target_types: ["Note"], bidirectional: false },
        ],
        shared_properties: [],
      };
      expect(() => validateSchema(schema)).toThrow("missing required fields");
    });

    it("throws on duplicate link type names", () => {
      const schema = {
        version: "1.0.0",
        object_types: [{ name: "Note", plural: "Notes", description: "A note", properties: [], folder: "Notes" }],
        link_types: [
          { name: "discusses", source_types: ["Note"], target_types: ["Note"], bidirectional: false },
          { name: "discusses", source_types: ["Note"], target_types: ["Note"], bidirectional: false },
        ],
        shared_properties: [],
      };
      expect(() => validateSchema(schema)).toThrow("Duplicate link type");
    });

    it("throws if object type missing name", () => {
      const schema = {
        version: "1.0.0",
        object_types: [{ name: "", plural: "Test", description: "Test", properties: [], folder: "Test" }],
        link_types: [],
        shared_properties: [],
      };
      expect(() => validateSchema(schema)).toThrow("missing required fields");
    });
  });

  describe("getObjectType / getObjectTypeNames", () => {
    it("finds existing object type by name", () => {
      const schema = getDefaultSchema();
      const person = getObjectType(schema, "Person");
      expect(person).toBeDefined();
      expect(person!.plural).toBe("People");
    });

    it("returns undefined for non-existent type", () => {
      const schema = getDefaultSchema();
      expect(getObjectType(schema, "Nonexistent")).toBeUndefined();
    });

    it("returns all type names", () => {
      const schema = getDefaultSchema();
      const names = getObjectTypeNames(schema);
      expect(names.length).toBe(schema.object_types.length);
    });
  });

  describe("getLinkType", () => {
    it("finds existing link type", () => {
      const schema = getDefaultSchema();
      const discusses = getLinkType(schema, "discusses");
      expect(discusses).toBeDefined();
      expect(discusses!.bidirectional).toBe(false);
    });

    it("returns undefined for non-existent link type", () => {
      const schema = getDefaultSchema();
      expect(getLinkType(schema, "nonexistent")).toBeUndefined();
    });
  });

  describe("loadSchemaFromFile", () => {
    it("loads a valid schema from YAML file", async () => {
      const schema = getDefaultSchema();
      const yamlContent = serializeSchemaToYaml(schema);
      const filePath = join(tmpDir, "ontology.yaml");
      await writeFile(filePath, yamlContent, "utf-8");

      const loaded = await loadSchemaFromFile(filePath);
      expect(loaded.version).toBe(schema.version);
      expect(loaded.object_types.length).toBe(schema.object_types.length);
    });

    it("throws for non-existent file", async () => {
      await expect(loadSchemaFromFile(join(tmpDir, "nope.yaml"))).rejects.toThrow("not found");
    });
  });

  describe("serializeSchemaToYaml", () => {
    it("produces valid YAML that roundtrips", async () => {
      const schema = getDefaultSchema();
      const yaml = serializeSchemaToYaml(schema);
      expect(yaml).toContain("version:");
      expect(yaml).toContain("object_types:");
      expect(yaml).toContain("Person");

      const filePath = join(tmpDir, "test.yaml");
      await writeFile(filePath, yaml, "utf-8");
      const loaded = await loadSchemaFromFile(filePath);
      expect(loaded.object_types.length).toBe(schema.object_types.length);
    });
  });
});

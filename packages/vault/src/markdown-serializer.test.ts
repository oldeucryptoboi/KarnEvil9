import { describe, it, expect } from "vitest";
import { serializeVaultObject, deserializeVaultObject, sanitizeFileName } from "./markdown-serializer.js";
import type { VaultObject, VaultObjectFrontmatter, VaultLink } from "./types.js";

function makeObject(overrides?: Partial<VaultObject>): VaultObject {
  const fm: VaultObjectFrontmatter = {
    object_id: "test-123",
    object_type: "Conversation",
    source: "chatgpt",
    source_id: "conv_abc",
    created_at: "2024-01-15T10:30:00Z",
    ingested_at: "2026-02-17T12:00:00Z",
    tags: ["coding", "typescript"],
    entities: ["TypeScript", "Express"],
    para_category: "resources",
    confidence: 0.87,
    classified_by: "claude-3-haiku",
  };

  return {
    frontmatter: fm,
    title: "Test Conversation",
    content: "This is the content of the conversation.",
    file_path: "03-Resources/Test Conversation.md",
    links: [],
    ...overrides,
  };
}

describe("MarkdownSerializer", () => {
  describe("serializeVaultObject", () => {
    it("produces valid markdown with frontmatter", () => {
      const obj = makeObject();
      const md = serializeVaultObject(obj);

      expect(md).toContain("---");
      expect(md).toContain("object_id: test-123");
      expect(md).toContain("object_type: Conversation");
      expect(md).toContain("# Test Conversation");
      expect(md).toContain("This is the content");
    });

    it("includes entities section when links present", () => {
      const link: VaultLink = {
        link_id: "link-1",
        source_id: "test-123",
        target_id: "typescript",
        link_type: "discusses",
        confidence: 0.87,
        created_at: "2026-02-17T12:00:00Z",
      };
      const obj = makeObject({ links: [link] });
      const md = serializeVaultObject(obj);

      expect(md).toContain("## Entities");
      expect(md).toContain("[[typescript]] (discusses)");
    });

    it("omits entities section when no links", () => {
      const obj = makeObject({ links: [] });
      const md = serializeVaultObject(obj);

      expect(md).not.toContain("## Entities");
    });
  });

  describe("deserializeVaultObject", () => {
    it("roundtrips serialize/deserialize", () => {
      const original = makeObject();
      const md = serializeVaultObject(original);
      const parsed = deserializeVaultObject(md, original.file_path);

      expect(parsed.frontmatter.object_id).toBe("test-123");
      expect(parsed.frontmatter.object_type).toBe("Conversation");
      expect(parsed.frontmatter.source).toBe("chatgpt");
      expect(parsed.title).toBe("Test Conversation");
      expect(parsed.content).toContain("This is the content");
      expect(parsed.frontmatter.tags).toEqual(["coding", "typescript"]);
    });

    it("roundtrips with links", () => {
      const link: VaultLink = {
        link_id: "link-1",
        source_id: "test-123",
        target_id: "typescript",
        link_type: "discusses",
        confidence: 0.87,
        created_at: "2026-02-17T12:00:00Z",
      };
      const original = makeObject({ links: [link] });
      const md = serializeVaultObject(original);
      const parsed = deserializeVaultObject(md, original.file_path);

      expect(parsed.links.length).toBe(1);
      expect(parsed.links[0]!.target_id).toBe("typescript");
      expect(parsed.links[0]!.link_type).toBe("discusses");
    });

    it("throws on missing required frontmatter fields", () => {
      const md = "---\ntitle: test\n---\n\n# Test";
      expect(() => deserializeVaultObject(md, "test.md")).toThrow("missing required fields");
    });

    it("handles missing frontmatter gracefully", () => {
      const md = "# Just a heading\n\nSome content";
      expect(() => deserializeVaultObject(md, "test.md")).toThrow("missing required fields");
    });

    it("defaults optional fields when missing", () => {
      const md = `---
object_id: xyz
object_type: Note
source: manual
source_id: xyz
---

# A Note

Some content here.
`;
      const parsed = deserializeVaultObject(md, "test.md");
      expect(parsed.frontmatter.tags).toEqual([]);
      expect(parsed.frontmatter.entities).toEqual([]);
      expect(parsed.frontmatter.confidence).toBe(0);
      expect(parsed.frontmatter.para_category).toBe("inbox");
      expect(parsed.frontmatter.classified_by).toBe("unclassified");
    });
  });

  describe("sanitizeFileName", () => {
    it("removes invalid path characters", () => {
      expect(sanitizeFileName("file/with\\bad?chars")).toBe("file-with-bad-chars");
    });

    it("normalizes whitespace", () => {
      expect(sanitizeFileName("  multiple   spaces  ")).toBe("multiple spaces");
    });

    it("truncates long names", () => {
      const longName = "a".repeat(250);
      expect(sanitizeFileName(longName).length).toBeLessThanOrEqual(200);
    });

    it("handles special characters", () => {
      expect(sanitizeFileName('file"name<>|test')).toBe("file-name---test");
    });
  });
});

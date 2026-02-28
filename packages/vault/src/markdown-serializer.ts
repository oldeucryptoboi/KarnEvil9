import yaml from "js-yaml";
import type { VaultObject, VaultObjectFrontmatter, VaultLink } from "./types.js";

const FRONTMATTER_DELIMITER = "---";

export function serializeVaultObject(obj: VaultObject): string {
  const fm = yaml.dump(obj.frontmatter, { lineWidth: 120, noRefs: true, sortKeys: false }).trim();
  const parts = [
    FRONTMATTER_DELIMITER,
    fm,
    FRONTMATTER_DELIMITER,
    "",
    `# ${obj.title}`,
    "",
    obj.content,
  ];

  if (obj.links.length > 0) {
    parts.push("", "## Entities");
    for (const link of obj.links) {
      parts.push(`- [[${link.target_id}]] (${link.link_type})`);
    }
  }

  return parts.join("\n") + "\n";
}

export function deserializeVaultObject(markdown: string, filePath: string): VaultObject {
  const { frontmatter, body } = parseFrontmatter(markdown);

  const fm = frontmatter as VaultObjectFrontmatter;
  if (!fm.object_id || !fm.object_type || !fm.source) {
    throw new Error(`Invalid vault object frontmatter in ${filePath}: missing required fields`);
  }

  // Ensure arrays
  fm.tags = fm.tags ?? [];
  fm.entities = fm.entities ?? [];
  fm.confidence = fm.confidence ?? 0;
  fm.classified_by = fm.classified_by ?? "unclassified";
  fm.para_category = fm.para_category ?? "inbox";

  // Extract title from first heading
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1]! : "";

  // Extract links from Entities section
  const links: VaultLink[] = [];
  const entitiesSection = body.match(/## Entities\n([\s\S]*?)(?:\n## |\n$|$)/);
  if (entitiesSection) {
    for (const match of (entitiesSection[1] ?? "").matchAll(/- \[\[(.+?)\]\]\s*\((\w+)\)/g)) {
      links.push({
        link_id: "",
        source_id: fm.object_id,
        target_id: match[1]!,
        link_type: match[2]!,
        confidence: fm.confidence,
        created_at: fm.ingested_at ?? fm.created_at,
      });
    }
  }

  // Extract content (everything between title and Entities section)
  let content = body;
  if (titleMatch) {
    const titleEnd = body.indexOf(titleMatch[0]) + titleMatch[0].length;
    content = body.slice(titleEnd).trim();
  }
  // Remove entities section from content
  const entitiesIdx = content.indexOf("## Entities");
  if (entitiesIdx !== -1) {
    content = content.slice(0, entitiesIdx).trim();
  }

  return { frontmatter: fm, title, content, file_path: filePath, links };
}

function parseFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } {
  const trimmed = markdown.trim();
  if (!trimmed.startsWith(FRONTMATTER_DELIMITER)) {
    return { frontmatter: {}, body: trimmed };
  }

  const endIdx = trimmed.indexOf(FRONTMATTER_DELIMITER, FRONTMATTER_DELIMITER.length);
  if (endIdx === -1) {
    return { frontmatter: {}, body: trimmed };
  }

  const fmContent = trimmed.slice(FRONTMATTER_DELIMITER.length, endIdx).trim();
  const body = trimmed.slice(endIdx + FRONTMATTER_DELIMITER.length).trim();

  const frontmatter = (yaml.load(fmContent) as Record<string, unknown>) ?? {};
  return { frontmatter, body };
}

export function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

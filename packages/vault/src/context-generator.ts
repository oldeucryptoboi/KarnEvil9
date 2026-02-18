import { writeFile, mkdir, rename, readdir, unlink, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { ContextBriefing } from "./types.js";
import type { ObjectStore } from "./object-store.js";
import type { LinkStore } from "./link-store.js";

export class ContextGenerator {
  private objectStore: ObjectStore;
  private linkStore: LinkStore;
  private vaultRoot: string;
  private lessonsProvider: (() => string[]) | null;
  private archiveMaxFiles: number;

  constructor(
    objectStore: ObjectStore,
    linkStore: LinkStore,
    vaultRoot: string,
    lessonsProvider?: () => string[],
    archiveMaxFiles: number = 100,
  ) {
    this.objectStore = objectStore;
    this.linkStore = linkStore;
    this.vaultRoot = vaultRoot;
    this.lessonsProvider = lessonsProvider ?? null;
    this.archiveMaxFiles = archiveMaxFiles;
  }

  async generate(): Promise<ContextBriefing> {
    const now = new Date().toISOString();

    // Recent conversations (last 7 days)
    const recentConversations = this.objectStore
      .search({ object_type: "Conversation", limit: 20 })
      .filter((entry) => {
        const age = Date.now() - new Date(entry.created_at).getTime();
        return age < 7 * 24 * 60 * 60 * 1000;
      })
      .map((entry) => ({
        title: entry.title,
        date: entry.created_at,
        entities: entry.entities,
      }));

    // Open threads: conversations from last 48h
    const openThreads = this.objectStore
      .search({ object_type: "Conversation", limit: 10 })
      .filter((entry) => {
        const age = Date.now() - new Date(entry.created_at).getTime();
        return age < 48 * 60 * 60 * 1000;
      })
      .map((entry) => ({
        title: entry.title,
        date: entry.created_at,
        source: entry.source,
      }));

    // Active projects
    const activeProjects = this.objectStore
      .search({ object_type: "Project", para_category: "projects", limit: 10 })
      .map((entry) => ({
        title: entry.title,
        status: "active",
      }));

    // Key entities by mention count, with top linked object titles
    const entityMentions = new Map<string, { name: string; type: string; count: number; linkedTitles: string[] }>();
    const allLinks = this.linkStore.allLinks();
    for (const link of allLinks) {
      const targetLinks = this.linkStore.getLinksForObject(link.target_id);
      const key = link.target_id;
      if (!entityMentions.has(key)) {
        // Look up entity info from index
        const results = this.objectStore.search({ text: link.target_id, limit: 1 });
        const entry = results[0];

        // Get top 3 linked object titles
        const linkedTitles: string[] = [];
        for (const tl of targetLinks.slice(0, 3)) {
          const linkedId = tl.source_id === link.target_id ? tl.target_id : tl.source_id;
          const linkedEntry = this.objectStore.search({}).find((e) => e.object_id === linkedId);
          if (linkedEntry) linkedTitles.push(linkedEntry.title);
        }

        entityMentions.set(key, {
          name: entry?.title ?? link.target_id,
          type: entry?.object_type ?? "unknown",
          count: targetLinks.length,
          linkedTitles,
        });
      }
    }

    const keyEntities = Array.from(entityMentions.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 15)
      .map((e) => ({
        name: e.name,
        type: e.type,
        mention_count: e.count,
        top_linked: e.linkedTitles.length > 0 ? e.linkedTitles : undefined,
      }));

    // Lessons from provider
    const recentLessons = this.lessonsProvider ? this.lessonsProvider() : [];

    const briefing: ContextBriefing = {
      generated_at: now,
      recent_conversations: recentConversations,
      active_projects: activeProjects,
      key_entities: keyEntities,
      recent_lessons: recentLessons,
      open_threads: openThreads.length > 0 ? openThreads : undefined,
    };

    return briefing;
  }

  private async archiveCurrentBriefing(): Promise<void> {
    const currentPath = join(this.vaultRoot, "_Meta", "current-context.md");
    if (!existsSync(currentPath)) return;

    const archiveDir = join(this.vaultRoot, "_Meta", "archive");
    await mkdir(archiveDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = join(archiveDir, `context-${timestamp}.md`);

    await copyFile(currentPath, archivePath);
  }

  private async pruneArchive(): Promise<void> {
    const archiveDir = join(this.vaultRoot, "_Meta", "archive");
    if (!existsSync(archiveDir)) return;

    const entries = await readdir(archiveDir);
    const contextFiles = entries
      .filter((f) => f.startsWith("context-") && f.endsWith(".md"))
      .sort();

    if (contextFiles.length <= this.archiveMaxFiles) return;

    const toRemove = contextFiles.slice(0, contextFiles.length - this.archiveMaxFiles);
    for (const file of toRemove) {
      await unlink(join(archiveDir, file));
    }
  }

  async writeContextFile(briefing?: ContextBriefing): Promise<string> {
    const ctx = briefing ?? (await this.generate());
    const filePath = join(this.vaultRoot, "_Meta", "current-context.md");

    // Archive existing briefing before overwriting
    await this.archiveCurrentBriefing();

    const lines: string[] = [
      "---",
      `generated_at: ${ctx.generated_at}`,
      "---",
      "",
      "# Current Context",
      "",
      `> Auto-generated briefing. Last updated: ${ctx.generated_at}`,
      "",
    ];

    // Open Threads
    if (ctx.open_threads && ctx.open_threads.length > 0) {
      lines.push("## Open Threads", "");
      for (const thread of ctx.open_threads) {
        lines.push(`- **${thread.title}** — ${thread.source} — ${thread.date.split("T")[0]}`);
      }
      lines.push("");
    }

    // Recent Conversations
    lines.push("## Recent Conversations", "");
    if (ctx.recent_conversations.length === 0) {
      lines.push("_No recent conversations._", "");
    } else {
      for (const conv of ctx.recent_conversations) {
        const entities = conv.entities.length > 0 ? ` (${conv.entities.join(", ")})` : "";
        lines.push(`- **${conv.title}** — ${conv.date.split("T")[0]}${entities}`);
      }
      lines.push("");
    }

    // Active Projects
    lines.push("## Active Projects", "");
    if (ctx.active_projects.length === 0) {
      lines.push("_No active projects._", "");
    } else {
      for (const proj of ctx.active_projects) {
        lines.push(`- [[${proj.title}]] (${proj.status})`);
      }
      lines.push("");
    }

    // Key Entities
    lines.push("## Key Entities", "");
    if (ctx.key_entities.length === 0) {
      lines.push("_No key entities yet._", "");
    } else {
      for (const ent of ctx.key_entities) {
        let line = `- [[${ent.name}]] (${ent.type}) — ${ent.mention_count} mentions`;
        if (ent.top_linked && ent.top_linked.length > 0) {
          line += ` → ${ent.top_linked.map((t) => `[[${t}]]`).join(", ")}`;
        }
        lines.push(line);
      }
      lines.push("");
    }

    // Recent Lessons
    if (ctx.recent_lessons.length > 0) {
      lines.push("## Recent Lessons", "");
      for (const lesson of ctx.recent_lessons) {
        lines.push(`- ${lesson}`);
      }
      lines.push("");
    }

    // Footer with generation timestamp
    lines.push("---", "");
    lines.push(`*Generated: ${ctx.generated_at}*`, "");

    const content = lines.join("\n");
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, filePath);

    // Prune old archived briefings
    await this.pruneArchive();

    return filePath;
  }
}

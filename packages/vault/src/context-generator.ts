import { writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ContextBriefing } from "./types.js";
import type { ObjectStore } from "./object-store.js";
import type { LinkStore } from "./link-store.js";

export class ContextGenerator {
  private objectStore: ObjectStore;
  private linkStore: LinkStore;
  private vaultRoot: string;

  constructor(objectStore: ObjectStore, linkStore: LinkStore, vaultRoot: string) {
    this.objectStore = objectStore;
    this.linkStore = linkStore;
    this.vaultRoot = vaultRoot;
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

    // Active projects
    const activeProjects = this.objectStore
      .search({ object_type: "Project", para_category: "projects", limit: 10 })
      .map((entry) => ({
        title: entry.title,
        status: "active",
      }));

    // Key entities by mention count
    const entityMentions = new Map<string, { name: string; type: string; count: number }>();
    const allLinks = this.linkStore.allLinks();
    for (const link of allLinks) {
      const targetLinks = this.linkStore.getLinksForObject(link.target_id);
      const key = link.target_id;
      if (!entityMentions.has(key)) {
        // Look up entity info from index
        const results = this.objectStore.search({ text: link.target_id, limit: 1 });
        const entry = results[0];
        entityMentions.set(key, {
          name: entry?.title ?? link.target_id,
          type: entry?.object_type ?? "unknown",
          count: targetLinks.length,
        });
      }
    }

    const keyEntities = Array.from(entityMentions.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 15)
      .map((e) => ({ name: e.name, type: e.type, mention_count: e.count }));

    const briefing: ContextBriefing = {
      generated_at: now,
      recent_conversations: recentConversations,
      active_projects: activeProjects,
      key_entities: keyEntities,
      recent_lessons: [],
    };

    return briefing;
  }

  async writeContextFile(briefing?: ContextBriefing): Promise<string> {
    const ctx = briefing ?? (await this.generate());
    const filePath = join(this.vaultRoot, "current-context.md");

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
        lines.push(`- [[${ent.name}]] (${ent.type}) — ${ent.mention_count} mentions`);
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

    const content = lines.join("\n");
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, filePath);

    return filePath;
  }
}

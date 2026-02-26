import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { existsSync } from "node:fs";
import type { IngestItem } from "../types.js";
import { BaseAdapter } from "./adapter.js";

interface ChatGPTConversation {
  id: string;
  title: string;
  create_time: number;
  update_time: number;
  mapping: Record<string, {
    id: string;
    message?: {
      author: { role: string };
      content: { parts?: string[]; content_type?: string };
      create_time?: number;
    };
    children: string[];
    parent?: string;
  }>;
}

export class ChatGPTAdapter extends BaseAdapter {
  readonly name = "chatgpt";
  readonly source = "chatgpt";
  private inputPath: string;

  constructor(inputPath: string) {
    super();
    this.inputPath = inputPath;
  }

  async *extract(): AsyncGenerator<IngestItem, void, undefined> {
    if (!existsSync(this.inputPath)) {
      throw new Error(`ChatGPT export not found: ${this.inputPath}`);
    }

    // Handle both single JSON file and directory of files
    const ext = extname(this.inputPath);
    if (ext === ".json") {
      yield* this.processJsonFile(this.inputPath);
    } else {
      // Directory — look for conversations.json
      const convPath = join(this.inputPath, "conversations.json");
      if (existsSync(convPath)) {
        yield* this.processJsonFile(convPath);
      } else {
        // Try all JSON files in directory
        const files = await readdir(this.inputPath);
        for (const file of files) {
          if (file.endsWith(".json")) {
            yield* this.processJsonFile(join(this.inputPath, file));
          }
        }
      }
    }
  }

  private async *processJsonFile(filePath: string): AsyncGenerator<IngestItem, void, undefined> {
    const raw = await readFile(filePath, "utf-8");
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`Failed to parse ChatGPT export file: ${filePath}`);
    }

    const conversations: ChatGPTConversation[] = Array.isArray(data) ? data : [data];

    for (const conv of conversations) {
      const messages = this.extractMessages(conv);
      if (messages.length === 0) continue;

      const content = messages
        .map((m) => `**${m.role}:** ${m.text}`)
        .join("\n\n");

      yield {
        source: "chatgpt",
        source_id: conv.id,
        title: conv.title || "Untitled Conversation",
        content,
        created_at: new Date(conv.create_time * 1000).toISOString(),
        metadata: {
          object_type: "Conversation",
          message_count: messages.length,
          update_time: new Date(conv.update_time * 1000).toISOString(),
        },
      };
    }
  }

  private extractMessages(conv: ChatGPTConversation): Array<{ role: string; text: string }> {
    const messages: Array<{ role: string; text: string; time: number }> = [];

    for (const node of Object.values(conv.mapping)) {
      if (!node.message) continue;
      const msg = node.message;
      if (msg.author.role === "system") continue;

      const parts = msg.content.parts ?? [];
      const text = parts
        .filter((p): p is string => typeof p === "string")
        .join("\n")
        .trim();

      if (text.length === 0) continue;

      messages.push({
        role: msg.author.role,
        text,
        time: msg.create_time ?? 0,
      });
    }

    messages.sort((a, b) => a.time - b.time);
    return messages.map(({ role, text }) => ({ role, text }));
  }
}

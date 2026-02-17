import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { existsSync } from "node:fs";
import type { IngestItem } from "../types.js";
import { BaseAdapter } from "./adapter.js";

interface ClaudeConversation {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
  chat_messages: Array<{
    uuid: string;
    sender: "human" | "assistant";
    text: string;
    created_at: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
}

export class ClaudeAdapter extends BaseAdapter {
  readonly name = "claude";
  readonly source = "claude";
  private inputPath: string;

  constructor(inputPath: string) {
    super();
    this.inputPath = inputPath;
  }

  async *extract(): AsyncGenerator<IngestItem, void, undefined> {
    if (!existsSync(this.inputPath)) {
      throw new Error(`Claude export not found: ${this.inputPath}`);
    }

    const ext = extname(this.inputPath);
    if (ext === ".json") {
      yield* this.processJsonFile(this.inputPath);
    } else {
      // Directory
      const files = await readdir(this.inputPath);
      for (const file of files) {
        if (file.endsWith(".json")) {
          yield* this.processJsonFile(join(this.inputPath, file));
        }
      }
    }
  }

  private async *processJsonFile(filePath: string): AsyncGenerator<IngestItem, void, undefined> {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw);

    const conversations: ClaudeConversation[] = Array.isArray(data) ? data : [data];

    for (const conv of conversations) {
      const messages = conv.chat_messages ?? [];
      if (messages.length === 0) continue;

      const content = messages
        .map((m) => {
          const text = m.text || m.content?.map((c) => c.text ?? "").join("") || "";
          return `**${m.sender}:** ${text}`;
        })
        .join("\n\n");

      yield {
        source: "claude",
        source_id: conv.uuid,
        title: conv.name || "Untitled Conversation",
        content,
        created_at: conv.created_at,
        metadata: {
          object_type: "Conversation",
          message_count: messages.length,
          updated_at: conv.updated_at,
        },
      };
    }
  }
}

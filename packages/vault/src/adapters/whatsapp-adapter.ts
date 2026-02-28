import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { existsSync } from "node:fs";
import type { IngestItem } from "../types.js";
import { BaseAdapter } from "./adapter.js";

// WhatsApp message format: "DD/MM/YYYY, HH:MM - Sender: Message"
// or "M/D/YY, H:MM AM/PM - Sender: Message" (US format)
const MESSAGE_REGEX = /^(\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)\s+-\s+([^:]+):\s+([\s\S]*?)$/;
const SYSTEM_REGEX = /^(\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)\s+-\s+([\s\S]*?)$/;

interface WhatsAppMessage {
  timestamp: string;
  sender: string;
  text: string;
}

export class WhatsAppAdapter extends BaseAdapter {
  readonly name = "whatsapp";
  readonly source = "whatsapp";
  private inputPath: string;

  constructor(inputPath: string) {
    super();
    this.inputPath = inputPath;
  }

  async *extract(): AsyncGenerator<IngestItem, void, undefined> {
    if (!existsSync(this.inputPath)) {
      throw new Error(`WhatsApp export not found: ${this.inputPath}`);
    }

    const raw = await readFile(this.inputPath, "utf-8");
    const messages = this.parseMessages(raw);

    if (messages.length === 0) return;

    // Extract chat name from filename
    const chatName = basename(this.inputPath, extname(this.inputPath))
      .replace(/^WhatsApp Chat with /i, "")
      .replace(/_/g, " ");

    // Group by date for chunking large chats
    const dayGroups = new Map<string, WhatsAppMessage[]>();
    for (const msg of messages) {
      const day = msg.timestamp.split(",")[0] ?? msg.timestamp.slice(0, 10);
      if (!dayGroups.has(day)) {
        dayGroups.set(day, []);
      }
      dayGroups.get(day)!.push(msg);
    }

    // If chat is small enough, yield as single item
    if (messages.length <= 500) {
      const content = messages
        .map((m) => `**${m.sender}** (${m.timestamp}): ${m.text}`)
        .join("\n");

      const participants = [...new Set(messages.map((m) => m.sender))];

      yield {
        source: "whatsapp",
        source_id: `${chatName}`,
        title: `WhatsApp: ${chatName}`,
        content,
        created_at: this.parseTimestamp(messages[0]!.timestamp),
        metadata: {
          object_type: "Conversation",
          message_count: messages.length,
          participants,
        },
      };
      return;
    }

    // Large chat: yield by day
    for (const [day, dayMessages] of dayGroups) {
      const content = dayMessages
        .map((m) => `**${m.sender}** (${m.timestamp}): ${m.text}`)
        .join("\n");

      const participants = [...new Set(dayMessages.map((m) => m.sender))];

      yield {
        source: "whatsapp",
        source_id: `${chatName}:${day}`,
        title: `WhatsApp: ${chatName} (${day})`,
        content,
        created_at: this.parseTimestamp(dayMessages[0]!.timestamp),
        metadata: {
          object_type: "Conversation",
          message_count: dayMessages.length,
          participants,
        },
      };
    }
  }

  private parseMessages(raw: string): WhatsAppMessage[] {
    const messages: WhatsAppMessage[] = [];
    const lines = raw.split("\n");

    let current: WhatsAppMessage | null = null;

    for (const line of lines) {
      const msgMatch = line.match(MESSAGE_REGEX);
      if (msgMatch) {
        if (current) messages.push(current);
        current = {
          timestamp: msgMatch[1]!,
          sender: msgMatch[2]!.trim(),
          text: msgMatch[3]!.trim(),
        };
        continue;
      }

      // System message (no sender)
      const sysMatch = line.match(SYSTEM_REGEX);
      if (sysMatch && !current) {
        continue; // Skip system messages
      }

      // Continuation of previous message
      if (current && line.trim().length > 0) {
        current.text += "\n" + line;
      }
    }

    if (current) messages.push(current);

    return messages;
  }

  private parseTimestamp(ts: string): string {
    // Try parsing common formats
    const date = new Date(ts);
    if (!Number.isNaN(date.getTime())) return date.toISOString();

    // Manual parsing for DD/MM/YYYY format (always present in WhatsApp timestamps)
    const match = ts.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!match) return new Date(0).toISOString();
    let year = parseInt(match[3]!, 10);
    if (year < 100) year += 2000;
    return new Date(year, parseInt(match[2]!, 10) - 1, parseInt(match[1]!, 10)).toISOString();
  }
}

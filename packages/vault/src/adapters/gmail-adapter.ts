import type { IngestItem } from "../types.js";
import { BaseAdapter } from "./adapter.js";

export interface GmailAdapterOptions {
  accessToken: string;
  query?: string;
  maxResults?: number;
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{
      mimeType: string;
      body?: { data?: string };
    }>;
  };
  internalDate: string;
}

export class GmailAdapter extends BaseAdapter {
  readonly name = "gmail";
  readonly source = "gmail";
  private accessToken: string;
  private query: string;
  private maxResults: number;

  constructor(options: GmailAdapterOptions) {
    super();
    this.accessToken = options.accessToken;
    this.query = options.query ?? "is:important";
    this.maxResults = options.maxResults ?? 100;
  }

  async *extract(): AsyncGenerator<IngestItem, void, undefined> {
    // List message IDs
    const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(this.query)}&maxResults=${this.maxResults}`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!listRes.ok) {
      throw new Error(`Gmail API error: ${listRes.status} ${listRes.statusText}`);
    }

    const listData = await listRes.json() as { messages?: Array<{ id: string }> };
    const messageIds = listData.messages ?? [];

    for (const { id } of messageIds) {
      const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
      const msgRes = await fetch(msgUrl, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });

      if (!msgRes.ok) continue;

      const msg = await msgRes.json() as GmailMessage;
      const item = this.messageToItem(msg);
      if (item) yield item;
    }
  }

  private messageToItem(msg: GmailMessage): IngestItem | null {
    const headers = msg.payload.headers;
    const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "No Subject";
    const from = headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "Unknown";
    const to = headers.find((h) => h.name.toLowerCase() === "to")?.value ?? "";
    const date = headers.find((h) => h.name.toLowerCase() === "date")?.value;

    const body = this.extractBody(msg);
    if (!body) return null;

    return {
      source: "gmail",
      source_id: msg.id,
      title: subject,
      content: `From: ${from}\nTo: ${to}\n\n${body}`,
      created_at: this.parseDate(date, msg.internalDate),
      metadata: {
        object_type: "Document",
        thread_id: msg.threadId,
        labels: msg.labelIds,
        from,
        to,
      },
    };
  }

  private extractBody(msg: GmailMessage): string | null {
    // Try plain text part first
    if (msg.payload.parts) {
      const textPart = msg.payload.parts.find((p) => p.mimeType === "text/plain");
      if (textPart?.body?.data) {
        return Buffer.from(textPart.body.data, "base64url").toString("utf-8");
      }
      // Fallback to HTML part
      const htmlPart = msg.payload.parts.find((p) => p.mimeType === "text/html");
      if (htmlPart?.body?.data) {
        const html = Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
        return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
    }

    // Single part message
    if (msg.payload.body?.data) {
      return Buffer.from(msg.payload.body.data, "base64url").toString("utf-8");
    }

    return msg.snippet || null;
  }

  private parseDate(headerDate: string | undefined, internalDate: string): string {
    if (headerDate) {
      const d = new Date(headerDate);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
    // Strict numeric check: parseInt("2023abc") returns 2023, which is wrong
    if (/^\d+$/.test(internalDate)) {
      return new Date(parseInt(internalDate, 10)).toISOString();
    }
    return new Date(0).toISOString();
  }
}

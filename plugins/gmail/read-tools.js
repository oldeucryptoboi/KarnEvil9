/**
 * Gmail read tools — search, read, and list unread messages.
 */

function stripHtml(html) {
  const links = [];
  html.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, text) => {
    const cleanText = text.replace(/<[^>]+>/g, "").trim();
    if (url && !url.startsWith("mailto:")) links.push({ url, text: cleanText });
    return "";
  });
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim();
  return { text, links };
}

function getBody(payload) {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return { text: Buffer.from(payload.body.data, "base64url").toString("utf-8"), links: [] };
  }
  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) {
      return { text: Buffer.from(plain.body.data, "base64url").toString("utf-8"), links: [] };
    }
    const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      return stripHtml(Buffer.from(htmlPart.body.data, "base64url").toString("utf-8"));
    }
    for (const part of payload.parts) {
      if (part.parts) { const r = getBody(part); if (r.text) return r; }
    }
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return stripHtml(Buffer.from(payload.body.data, "base64url").toString("utf-8"));
  }
  return { text: "", links: [] };
}

function extractHeader(headers, name) {
  return headers?.find((h) => h.name === name)?.value ?? "";
}

// ─── search-gmail ───

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const searchGmailManifest = {
  name: "search-gmail",
  version: "1.0.0",
  description: "Search Gmail messages using a query string (same syntax as Gmail search bar)",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Gmail search query (e.g. 'from:user@example.com newer_than:1d')" },
      max_results: { type: "number", description: "Maximum number of results (default 10, max 50)" },
      include_body: { type: "boolean", description: "Include message body in results (default false)" },
    },
    required: ["query"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      count: { type: "number" },
      messages: { type: "array" },
    },
  },
  permissions: ["gmail:read:messages"],
  timeout_ms: 30000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, count: 0, messages: [] }],
};

export function createSearchGmailHandler(gmailClient) {
  return async (input, mode) => {
    if (mode === "mock") return { ok: true, count: 1, messages: [{ id: "mock-id", threadId: "mock-thread", from: "user@example.com", subject: "Mock email", date: new Date().toISOString(), snippet: "Mock snippet" }] };
    if (mode === "dry_run") return { ok: true, count: 0, messages: [], dry_run: true };

    const gmail = gmailClient._gmail;
    if (!gmail) return { ok: false, error: "Gmail not connected" };

    const maxResults = Math.min(input.max_results ?? 10, 50);
    const res = await gmail.users.messages.list({ userId: "me", q: input.query, maxResults });
    const messageIds = res.data.messages || [];

    const messages = [];
    for (const m of messageIds) {
      const msg = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
      const headers = msg.data.payload.headers;
      const entry = {
        id: m.id,
        threadId: m.threadId,
        from: extractHeader(headers, "From"),
        subject: extractHeader(headers, "Subject"),
        date: extractHeader(headers, "Date"),
        snippet: msg.data.snippet ?? "",
      };
      if (input.include_body) {
        const { text, links } = getBody(msg.data.payload);
        entry.body = text;
        if (links.length > 0) entry.links = links;
      }
      messages.push(entry);
    }

    return { ok: true, count: messages.length, messages };
  };
}

// ─── read-gmail-message ───

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const readGmailMessageManifest = {
  name: "read-gmail-message",
  version: "1.0.0",
  description: "Read the full content of a Gmail message by its ID",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      message_id: { type: "string", description: "Gmail message ID" },
    },
    required: ["message_id"],
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      from: { type: "string" },
      to: { type: "string" },
      subject: { type: "string" },
      date: { type: "string" },
      threadId: { type: "string" },
      body: { type: "string" },
      links: { type: "array" },
    },
  },
  permissions: ["gmail:read:messages"],
  timeout_ms: 15000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, from: "user@example.com", to: "me@example.com", subject: "Mock", date: "2026-01-01", threadId: "mock-thread", body: "Mock body", links: [] }],
};

export function createReadGmailMessageHandler(gmailClient) {
  return async (input, mode) => {
    if (mode === "mock") return { ok: true, from: "user@example.com", to: "me@example.com", subject: "Mock email", date: new Date().toISOString(), threadId: "mock-thread", body: "Mock email body", links: [] };
    if (mode === "dry_run") return { ok: true, message_id: input.message_id, dry_run: true };

    const gmail = gmailClient._gmail;
    if (!gmail) return { ok: false, error: "Gmail not connected" };

    const msg = await gmail.users.messages.get({ userId: "me", id: input.message_id, format: "full" });
    const headers = msg.data.payload.headers;
    const { text, links } = getBody(msg.data.payload);

    return {
      ok: true,
      from: extractHeader(headers, "From"),
      to: extractHeader(headers, "To"),
      subject: extractHeader(headers, "Subject"),
      date: extractHeader(headers, "Date"),
      threadId: msg.data.threadId,
      body: text,
      links: links.length > 0 ? links : undefined,
    };
  };
}

// ─── list-gmail-unread ───

/** @type {import("@karnevil9/schemas").ToolManifest} */
export const listGmailUnreadManifest = {
  name: "list-gmail-unread",
  version: "1.0.0",
  description: "List unread Gmail messages from the last 24 hours",
  runner: "internal",
  input_schema: {
    type: "object",
    properties: {
      max_results: { type: "number", description: "Maximum number of results (default 20, max 50)" },
    },
  },
  output_schema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      count: { type: "number" },
      messages: { type: "array" },
    },
  },
  permissions: ["gmail:read:messages"],
  timeout_ms: 30000,
  supports: { mock: true, dry_run: true },
  mock_responses: [{ ok: true, count: 0, messages: [] }],
};

export function createListGmailUnreadHandler(gmailClient) {
  return async (input, mode) => {
    if (mode === "mock") return { ok: true, count: 0, messages: [] };
    if (mode === "dry_run") return { ok: true, count: 0, messages: [], dry_run: true };

    const gmail = gmailClient._gmail;
    if (!gmail) return { ok: false, error: "Gmail not connected" };

    const maxResults = Math.min(input?.max_results ?? 20, 50);
    const res = await gmail.users.messages.list({ userId: "me", q: "is:unread newer_than:1d", maxResults });
    const messageIds = res.data.messages || [];

    const messages = [];
    for (const m of messageIds) {
      const msg = await gmail.users.messages.get({ userId: "me", id: m.id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
      const headers = msg.data.payload.headers;
      messages.push({
        id: m.id,
        threadId: m.threadId,
        from: extractHeader(headers, "From"),
        subject: extractHeader(headers, "Subject"),
        date: extractHeader(headers, "Date"),
        snippet: msg.data.snippet ?? "",
      });
    }

    return { ok: true, count: messages.length, messages };
  };
}

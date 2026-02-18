import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IngestItem } from "../types.js";
import { GmailAdapter } from "./gmail-adapter.js";

function base64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

function makeGmailMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg-1",
    threadId: "thread-1",
    labelIds: ["INBOX", "IMPORTANT"],
    snippet: "Snippet text",
    payload: {
      headers: [
        { name: "Subject", value: "Test Subject" },
        { name: "From", value: "alice@example.com" },
        { name: "To", value: "bob@example.com" },
        { name: "Date", value: "Mon, 15 Jan 2024 10:30:00 +0000" },
      ],
      body: { data: base64url("Hello from the body") },
    },
    internalDate: "1705312200000",
    ...overrides,
  };
}

async function collect(adapter: GmailAdapter): Promise<IngestItem[]> {
  const items: IngestItem[] = [];
  for await (const item of adapter.extract()) {
    items.push(item);
  }
  return items;
}

describe("GmailAdapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has correct name and source", () => {
    const adapter = new GmailAdapter({ accessToken: "tok" });
    expect(adapter.name).toBe("gmail");
    expect(adapter.source).toBe("gmail");
  });

  it("uses default query and maxResults", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [] }),
    });

    const adapter = new GmailAdapter({ accessToken: "tok" });
    await collect(adapter);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("q=is%3Aimportant");
    expect(url).toContain("maxResults=100");
  });

  it("uses custom query and maxResults", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [] }),
    });

    const adapter = new GmailAdapter({ accessToken: "tok", query: "label:work", maxResults: 10 });
    await collect(adapter);

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("q=label%3Awork");
    expect(url).toContain("maxResults=10");
  });

  it("passes authorization header", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [] }),
    });

    const adapter = new GmailAdapter({ accessToken: "my-token-123" });
    await collect(adapter);

    const opts = fetchMock.mock.calls[0]![1] as { headers: { Authorization: string } };
    expect(opts.headers.Authorization).toBe("Bearer my-token-123");
  });

  it("throws on API list error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    });

    const adapter = new GmailAdapter({ accessToken: "bad-tok" });
    await expect(async () => {
      for await (const _ of adapter.extract()) { /* consume */ }
    }).rejects.toThrow("Gmail API error: 401 Unauthorized");
  });

  it("lists and processes messages with single-part body", async () => {
    const msg = makeGmailMessage();

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ id: "msg-1" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => msg,
      });

    const adapter = new GmailAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.source).toBe("gmail");
    expect(items[0]!.source_id).toBe("msg-1");
    expect(items[0]!.title).toBe("Test Subject");
    expect(items[0]!.content).toContain("From: alice@example.com");
    expect(items[0]!.content).toContain("To: bob@example.com");
    expect(items[0]!.content).toContain("Hello from the body");
    expect(items[0]!.metadata.object_type).toBe("Document");
    expect(items[0]!.metadata.thread_id).toBe("thread-1");
    expect(items[0]!.metadata.labels).toEqual(["INBOX", "IMPORTANT"]);
    expect(items[0]!.metadata.from).toBe("alice@example.com");
    expect(items[0]!.metadata.to).toBe("bob@example.com");
  });

  it("decodes base64url message bodies", async () => {
    const rawBody = "This has special chars: +/= and unicode: cafe";
    const msg = makeGmailMessage({
      payload: {
        headers: [
          { name: "Subject", value: "Encoded" },
          { name: "From", value: "sender@test.com" },
          { name: "To", value: "recv@test.com" },
          { name: "Date", value: "Tue, 16 Jan 2024 12:00:00 +0000" },
        ],
        body: { data: base64url(rawBody) },
      },
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ id: "msg-encoded" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => msg,
      });

    const adapter = new GmailAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.content).toContain(rawBody);
  });

  it("handles multipart messages with text/plain part", async () => {
    const msg = makeGmailMessage({
      payload: {
        headers: [
          { name: "Subject", value: "Multipart" },
          { name: "From", value: "a@b.com" },
          { name: "To", value: "c@d.com" },
          { name: "Date", value: "Wed, 17 Jan 2024 08:00:00 +0000" },
        ],
        body: {},
        parts: [
          { mimeType: "text/plain", body: { data: base64url("Plain text body") } },
          { mimeType: "text/html", body: { data: base64url("<p>HTML body</p>") } },
        ],
      },
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ id: "msg-multi" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => msg,
      });

    const adapter = new GmailAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.content).toContain("Plain text body");
    // Should prefer text/plain over text/html
    expect(items[0]!.content).not.toContain("HTML body");
  });

  it("falls back to HTML part when no text/plain in multipart", async () => {
    const msg = makeGmailMessage({
      payload: {
        headers: [
          { name: "Subject", value: "HTML Only" },
          { name: "From", value: "a@b.com" },
          { name: "To", value: "c@d.com" },
          { name: "Date", value: "Wed, 17 Jan 2024 08:00:00 +0000" },
        ],
        body: {},
        parts: [
          { mimeType: "text/html", body: { data: base64url("<p>Only HTML</p>") } },
        ],
      },
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ id: "msg-html" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => msg,
      });

    const adapter = new GmailAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    // HTML tags should be stripped
    expect(items[0]!.content).toContain("Only HTML");
    expect(items[0]!.content).not.toContain("<p>");
  });

  it("falls back to snippet when no body data exists", async () => {
    const msg = makeGmailMessage({
      snippet: "Fallback snippet text",
      payload: {
        headers: [
          { name: "Subject", value: "Snippet Fallback" },
          { name: "From", value: "a@b.com" },
          { name: "To", value: "c@d.com" },
          { name: "Date", value: "Wed, 17 Jan 2024 08:00:00 +0000" },
        ],
        body: {},
      },
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ id: "msg-snippet" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => msg,
      });

    const adapter = new GmailAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.content).toContain("Fallback snippet text");
  });

  it("skips messages with no body (no parts, no body data, empty snippet)", async () => {
    const msg = makeGmailMessage({
      snippet: "",
      payload: {
        headers: [
          { name: "Subject", value: "Empty" },
          { name: "From", value: "a@b.com" },
          { name: "To", value: "c@d.com" },
          { name: "Date", value: "Wed, 17 Jan 2024 08:00:00 +0000" },
        ],
        body: {},
      },
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ id: "msg-empty" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => msg,
      });

    const adapter = new GmailAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(0);
  });

  it("skips individual message fetch failures", async () => {
    const goodMsg = makeGmailMessage({ id: "msg-good" });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ id: "msg-bad" }, { id: "msg-good" }] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => goodMsg,
      });

    const adapter = new GmailAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.source_id).toBe("msg-good");
  });

  it("handles empty messages list", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: undefined }),
    });

    const adapter = new GmailAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(0);
  });

  it("uses internalDate when Date header is missing", async () => {
    const msg = makeGmailMessage({
      internalDate: "1705312200000",
      payload: {
        headers: [
          { name: "Subject", value: "No Date Header" },
          { name: "From", value: "a@b.com" },
          { name: "To", value: "c@d.com" },
        ],
        body: { data: base64url("body text") },
      },
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ id: "msg-nodate" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => msg,
      });

    const adapter = new GmailAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    const ts = new Date(items[0]!.created_at).getTime();
    expect(ts).toBe(1705312200000);
  });

  it("uses default subject and from when headers missing", async () => {
    const msg = makeGmailMessage({
      payload: {
        headers: [],
        body: { data: base64url("Some body") },
      },
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ id: "msg-noheaders" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => msg,
      });

    const adapter = new GmailAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.title).toBe("No Subject");
    expect(items[0]!.content).toContain("From: Unknown");
  });

  it("processes multiple messages", async () => {
    const msg1 = makeGmailMessage({ id: "m1" });
    const msg2 = makeGmailMessage({
      id: "m2",
      payload: {
        headers: [
          { name: "Subject", value: "Second" },
          { name: "From", value: "b@b.com" },
          { name: "To", value: "c@c.com" },
          { name: "Date", value: "Thu, 18 Jan 2024 09:00:00 +0000" },
        ],
        body: { data: base64url("Second body") },
      },
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ id: "m1" }, { id: "m2" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => msg1,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => msg2,
      });

    const adapter = new GmailAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(2);
    expect(items[0]!.source_id).toBe("m1");
    expect(items[1]!.source_id).toBe("m2");
  });
});

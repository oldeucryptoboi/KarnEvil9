import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IngestItem } from "../types.js";
import { GoogleDriveAdapter } from "./google-drive-adapter.js";

function makeDriveFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "file-1",
    name: "My Document",
    mimeType: "application/vnd.google-apps.document",
    createdTime: "2024-01-15T10:30:00Z",
    modifiedTime: "2024-01-16T08:00:00Z",
    ...overrides,
  };
}

async function collect(adapter: GoogleDriveAdapter): Promise<IngestItem[]> {
  const items: IngestItem[] = [];
  for await (const item of adapter.extract()) {
    items.push(item);
  }
  return items;
}

describe("GoogleDriveAdapter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has correct name and source", () => {
    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    expect(adapter.name).toBe("google-drive");
    expect(adapter.source).toBe("google-drive");
  });

  it("uses default query when none specified", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: [] }),
    });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    await collect(adapter);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    const decodedQ = decodeURIComponent(url.split("q=")[1]!.split("&")[0]!);
    expect(decodedQ).toContain("trashed = false");
  });

  it("uses custom query", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: [] }),
    });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok", query: "name contains 'report'" });
    await collect(adapter);

    const url = fetchMock.mock.calls[0]![0] as string;
    const decodedQ = decodeURIComponent(url.split("q=")[1]!.split("&")[0]!);
    expect(decodedQ).toContain("name contains 'report'");
  });

  it("prepends folderId filter when specified", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: [] }),
    });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok", folderId: "folder-abc" });
    await collect(adapter);

    const url = fetchMock.mock.calls[0]![0] as string;
    const decodedQ = decodeURIComponent(url.split("q=")[1]!.split("&")[0]!);
    expect(decodedQ).toContain("'folder-abc' in parents");
    expect(decodedQ).toContain("trashed = false");
  });

  it("uses custom maxResults (pageSize)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: [] }),
    });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok", maxResults: 25 });
    await collect(adapter);

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("pageSize=25");
  });

  it("defaults maxResults to 100", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: [] }),
    });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    await collect(adapter);

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("pageSize=100");
  });

  it("passes authorization header", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: [] }),
    });

    const adapter = new GoogleDriveAdapter({ accessToken: "my-drive-token" });
    await collect(adapter);

    const opts = fetchMock.mock.calls[0]![1] as { headers: { Authorization: string } };
    expect(opts.headers.Authorization).toBe("Bearer my-drive-token");
  });

  it("throws on API list error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });

    const adapter = new GoogleDriveAdapter({ accessToken: "bad-tok" });
    await expect(async () => {
      for await (const _ of adapter.extract()) { /* consume */ }
    }).rejects.toThrow("Google Drive API error: 403 Forbidden");
  });

  it("exports Google Docs as text", async () => {
    const file = makeDriveFile({
      id: "doc-1",
      name: "My Google Doc",
      mimeType: "application/vnd.google-apps.document",
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [file] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "Exported plain text content of the doc",
      });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.source).toBe("google-drive");
    expect(items[0]!.source_id).toBe("doc-1");
    expect(items[0]!.title).toBe("My Google Doc");
    expect(items[0]!.content).toBe("Exported plain text content of the doc");
    expect(items[0]!.created_at).toBe("2024-01-15T10:30:00Z");
    expect(items[0]!.metadata.object_type).toBe("Document");
    expect(items[0]!.metadata.mime_type).toBe("application/vnd.google-apps.document");
    expect(items[0]!.metadata.modified_at).toBe("2024-01-16T08:00:00Z");

    // Verify the export URL was used
    const exportUrl = fetchMock.mock.calls[1]![0] as string;
    expect(exportUrl).toContain("/export?mimeType=text/plain");
  });

  it("downloads plain text files directly", async () => {
    const file = makeDriveFile({
      id: "txt-1",
      name: "notes.txt",
      mimeType: "text/plain",
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [file] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "Plain text file content",
      });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.content).toBe("Plain text file content");

    const downloadUrl = fetchMock.mock.calls[1]![0] as string;
    expect(downloadUrl).toContain("?alt=media");
  });

  it("downloads markdown files directly", async () => {
    const file = makeDriveFile({
      id: "md-1",
      name: "readme.md",
      mimeType: "text/markdown",
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [file] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "# Heading\n\nMarkdown content",
      });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.content).toBe("# Heading\n\nMarkdown content");
    expect(items[0]!.metadata.mime_type).toBe("text/markdown");
  });

  it("returns null for unsupported mime types (PDF)", async () => {
    const file = makeDriveFile({
      id: "pdf-1",
      name: "document.pdf",
      mimeType: "application/pdf",
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: [file] }),
    });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    // PDF is not handled by fetchFileContent -> returns null -> skipped
    expect(items.length).toBe(0);
    // Only the list call should have been made, no content fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips files with empty content", async () => {
    const file = makeDriveFile({
      id: "empty-doc",
      name: "Empty Doc",
      mimeType: "application/vnd.google-apps.document",
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [file] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "",
      });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(0);
  });

  it("skips files with whitespace-only content", async () => {
    const file = makeDriveFile({
      id: "ws-doc",
      name: "Whitespace Doc",
      mimeType: "text/plain",
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [file] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "   \n  \t  ",
      });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(0);
  });

  it("skips files when content fetch fails", async () => {
    const file = makeDriveFile({
      id: "fail-doc",
      name: "Failing Doc",
      mimeType: "application/vnd.google-apps.document",
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [file] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    // fetchFileContent returns null when res.ok is false
    expect(items.length).toBe(0);
  });

  it("skips files when content fetch throws", async () => {
    const file = makeDriveFile({
      id: "throw-doc",
      name: "Throwing Doc",
      mimeType: "application/vnd.google-apps.document",
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [file] }),
      })
      .mockRejectedValueOnce(new Error("Network failure"));

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    // The catch block silently skips
    expect(items.length).toBe(0);
  });

  it("handles empty files list", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: undefined }),
    });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(0);
  });

  it("processes multiple files of different types", async () => {
    const files = [
      makeDriveFile({ id: "doc-a", name: "Doc A", mimeType: "application/vnd.google-apps.document" }),
      makeDriveFile({ id: "txt-b", name: "Text B", mimeType: "text/plain" }),
      makeDriveFile({ id: "md-c", name: "MD C", mimeType: "text/markdown" }),
    ];

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "Doc A content",
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "Text B content",
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "MD C content",
      });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(3);
    expect(items[0]!.source_id).toBe("doc-a");
    expect(items[0]!.content).toBe("Doc A content");
    expect(items[1]!.source_id).toBe("txt-b");
    expect(items[1]!.content).toBe("Text B content");
    expect(items[2]!.source_id).toBe("md-c");
    expect(items[2]!.content).toBe("MD C content");
  });

  it("skips failed files but continues processing rest", async () => {
    const files = [
      makeDriveFile({ id: "fail", name: "Fail", mimeType: "application/vnd.google-apps.document" }),
      makeDriveFile({ id: "ok", name: "OK", mimeType: "text/plain" }),
    ];

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files }),
      })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        ok: true,
        text: async () => "OK content",
      });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.source_id).toBe("ok");
  });

  it("includes mimeType filter in query", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: [] }),
    });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    await collect(adapter);

    const url = fetchMock.mock.calls[0]![0] as string;
    const decodedQ = decodeURIComponent(url.split("q=")[1]!.split("&")[0]!);
    expect(decodedQ).toContain("application/vnd.google-apps.document");
    expect(decodedQ).toContain("text/plain");
    expect(decodedQ).toContain("text/markdown");
    expect(decodedQ).toContain("application/pdf");
  });

  it("includes correct fields parameter", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: [] }),
    });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    await collect(adapter);

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("fields=files(id,name,mimeType,createdTime,modifiedTime,parents)");
  });

  it("handles text/plain download failure gracefully", async () => {
    const file = makeDriveFile({
      id: "txt-fail",
      name: "Fail Text",
      mimeType: "text/plain",
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ files: [file] }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

    const adapter = new GoogleDriveAdapter({ accessToken: "tok" });
    const items = await collect(adapter);

    expect(items.length).toBe(0);
  });
});

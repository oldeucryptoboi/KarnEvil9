import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IngestItem } from "../types.js";

// Mock node:child_process before importing the adapter
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { AppleNotesAdapter } from "./apple-notes-adapter.js";

function makeExecFileSucceed(stdout: string): void {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      // promisify calls (cmd, args, opts) and expects a callback-style function
      // When promisified, the last argument is the callback
      if (typeof _opts === "function") {
        // (cmd, args, cb) form
        _opts(null, { stdout, stderr: "" });
      } else if (typeof cb === "function") {
        cb(null, { stdout, stderr: "" });
      }
    },
  );
}

function makeExecFileFail(message: string): void {
  (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      const err = new Error(message);
      if (typeof _opts === "function") {
        _opts(err, { stdout: "", stderr: "" });
      } else if (typeof cb === "function") {
        cb(err, { stdout: "", stderr: "" });
      }
    },
  );
}

async function collect(adapter: AppleNotesAdapter): Promise<IngestItem[]> {
  const items: IngestItem[] = [];
  for await (const item of adapter.extract()) {
    items.push(item);
  }
  return items;
}

function buildNoteOutput(notes: Array<{
  id: string;
  title: string;
  folder: string;
  created: string;
  modified: string;
  body: string;
}>): string {
  return notes
    .map(
      (n) =>
        `<<<NOTE_START>>>\nID:${n.id}\nTITLE:${n.title}\nFOLDER:${n.folder}\nCREATED:${n.created}\nMODIFIED:${n.modified}\nBODY:\n${n.body}\n<<<NOTE_END>>>`,
    )
    .join("\n");
}

describe("AppleNotesAdapter", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure we're on "darwin" by default for most tests
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("has correct name and source", () => {
    const adapter = new AppleNotesAdapter();
    expect(adapter.name).toBe("apple-notes");
    expect(adapter.source).toBe("apple-notes");
  });

  it("throws on non-darwin platform", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const adapter = new AppleNotesAdapter();
    await expect(async () => {
      for await (const _ of adapter.extract()) { /* consume */ }
    }).rejects.toThrow("Apple Notes adapter only works on macOS");
  });

  it("throws when execFile fails", async () => {
    makeExecFileFail("osascript crashed");
    const adapter = new AppleNotesAdapter();
    await expect(async () => {
      for await (const _ of adapter.extract()) { /* consume */ }
    }).rejects.toThrow("Failed to read Apple Notes: osascript crashed");
  });

  it("parses output correctly from osascript", async () => {
    const output = buildNoteOutput([
      {
        id: "note-1",
        title: "My First Note",
        folder: "Work",
        created: "2024-01-15T10:30:00Z",
        modified: "2024-01-16T08:00:00Z",
        body: "This is the note content.",
      },
    ]);
    makeExecFileSucceed(output);

    const adapter = new AppleNotesAdapter();
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.source).toBe("apple-notes");
    expect(items[0]!.source_id).toBe("note-1");
    expect(items[0]!.title).toBe("My First Note");
    expect(items[0]!.content).toBe("This is the note content.");
    expect(items[0]!.metadata.object_type).toBe("Note");
    expect(items[0]!.metadata.folder).toBe("Work");
  });

  it("strips HTML tags from body", async () => {
    const output = buildNoteOutput([
      {
        id: "note-html",
        title: "HTML Note",
        folder: "Personal",
        created: "2024-03-01T00:00:00Z",
        modified: "2024-03-01T00:00:00Z",
        body: "<div>Hello <b>World</b></div><br><p>Second paragraph</p>",
      },
    ]);
    makeExecFileSucceed(output);

    const adapter = new AppleNotesAdapter();
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.content).not.toContain("<div>");
    expect(items[0]!.content).not.toContain("<b>");
    expect(items[0]!.content).not.toContain("<br>");
    expect(items[0]!.content).not.toContain("<p>");
    expect(items[0]!.content).toContain("Hello");
    expect(items[0]!.content).toContain("World");
    expect(items[0]!.content).toContain("Second paragraph");
  });

  it("decodes HTML entities in body", async () => {
    const output = buildNoteOutput([
      {
        id: "note-entities",
        title: "Entity Note",
        folder: "Notes",
        created: "2024-01-01T00:00:00Z",
        modified: "2024-01-01T00:00:00Z",
        body: "A&nbsp;B &amp; C &lt;tag&gt; &quot;quoted&quot;",
      },
    ]);
    makeExecFileSucceed(output);

    const adapter = new AppleNotesAdapter();
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.content).toContain("A B");
    expect(items[0]!.content).toContain("& C");
    expect(items[0]!.content).toContain("<tag>");
    expect(items[0]!.content).toContain('"quoted"');
  });

  it("skips notes with empty body", async () => {
    const output = buildNoteOutput([
      {
        id: "note-empty",
        title: "Empty Note",
        folder: "Trash",
        created: "2024-01-01T00:00:00Z",
        modified: "2024-01-01T00:00:00Z",
        body: "",
      },
      {
        id: "note-whitespace",
        title: "Whitespace Note",
        folder: "Trash",
        created: "2024-01-01T00:00:00Z",
        modified: "2024-01-01T00:00:00Z",
        body: "   \n   ",
      },
    ]);
    makeExecFileSucceed(output);

    const adapter = new AppleNotesAdapter();
    const items = await collect(adapter);

    expect(items.length).toBe(0);
  });

  it("skips notes with body containing only HTML tags (no text content)", async () => {
    const output = buildNoteOutput([
      {
        id: "note-onlytags",
        title: "Tags Only",
        folder: "Notes",
        created: "2024-01-01T00:00:00Z",
        modified: "2024-01-01T00:00:00Z",
        body: "<div><br></div>",
      },
    ]);
    makeExecFileSucceed(output);

    const adapter = new AppleNotesAdapter();
    const items = await collect(adapter);

    expect(items.length).toBe(0);
  });

  it("uses 'Untitled Note' for notes with empty title", async () => {
    const output = buildNoteOutput([
      {
        id: "note-notitle",
        title: "",
        folder: "Notes",
        created: "2024-01-01T00:00:00Z",
        modified: "2024-01-01T00:00:00Z",
        body: "Some content here",
      },
    ]);
    makeExecFileSucceed(output);

    const adapter = new AppleNotesAdapter();
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.title).toBe("Untitled Note");
  });

  it("handles parse errors in date by falling back to current time", async () => {
    const now = Date.now();
    const output = buildNoteOutput([
      {
        id: "note-baddate",
        title: "Bad Date Note",
        folder: "Notes",
        created: "not-a-date",
        modified: "also-not-a-date",
        body: "Content with bad dates",
      },
    ]);
    makeExecFileSucceed(output);

    const adapter = new AppleNotesAdapter();
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    // The fallback should produce a recent ISO date
    const createdTime = new Date(items[0]!.created_at).getTime();
    expect(createdTime).toBeGreaterThanOrEqual(now - 5000);
    expect(createdTime).toBeLessThanOrEqual(now + 5000);

    const modifiedTime = new Date(items[0]!.metadata.modified_at as string).getTime();
    expect(modifiedTime).toBeGreaterThanOrEqual(now - 5000);
    expect(modifiedTime).toBeLessThanOrEqual(now + 5000);
  });

  it("parses valid dates to ISO strings", async () => {
    const output = buildNoteOutput([
      {
        id: "note-gooddate",
        title: "Good Date",
        folder: "Notes",
        created: "2024-06-15T14:30:00Z",
        modified: "2024-07-01T09:00:00Z",
        body: "Content here",
      },
    ]);
    makeExecFileSucceed(output);

    const adapter = new AppleNotesAdapter();
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.created_at).toBe("2024-06-15T14:30:00.000Z");
    expect(items[0]!.metadata.modified_at).toBe("2024-07-01T09:00:00.000Z");
  });

  it("parseOutput correctly splits on NOTE_START/NOTE_END", async () => {
    const output = [
      "some garbage before",
      "<<<NOTE_START>>>",
      "ID:id-1",
      "TITLE:First",
      "FOLDER:F1",
      "CREATED:2024-01-01",
      "MODIFIED:2024-01-02",
      "BODY:",
      "Body one",
      "<<<NOTE_END>>>",
      "garbage in between",
      "<<<NOTE_START>>>",
      "ID:id-2",
      "TITLE:Second",
      "FOLDER:F2",
      "CREATED:2024-02-01",
      "MODIFIED:2024-02-02",
      "BODY:",
      "Body two line 1",
      "Body two line 2",
      "<<<NOTE_END>>>",
      "trailing garbage",
    ].join("\n");

    makeExecFileSucceed(output);

    const adapter = new AppleNotesAdapter();
    const items = await collect(adapter);

    expect(items.length).toBe(2);
    expect(items[0]!.source_id).toBe("id-1");
    expect(items[0]!.title).toBe("First");
    expect(items[0]!.content).toBe("Body one");
    expect(items[0]!.metadata.folder).toBe("F1");

    expect(items[1]!.source_id).toBe("id-2");
    expect(items[1]!.title).toBe("Second");
    expect(items[1]!.content).toContain("Body two line 1");
    expect(items[1]!.content).toContain("Body two line 2");
  });

  it("skips blocks without an ID", async () => {
    const output = [
      "<<<NOTE_START>>>",
      "TITLE:No ID Note",
      "FOLDER:F1",
      "CREATED:2024-01-01",
      "MODIFIED:2024-01-01",
      "BODY:",
      "Some body",
      "<<<NOTE_END>>>",
      "<<<NOTE_START>>>",
      "ID:valid-id",
      "TITLE:Valid Note",
      "FOLDER:F2",
      "CREATED:2024-01-01",
      "MODIFIED:2024-01-01",
      "BODY:",
      "Valid body",
      "<<<NOTE_END>>>",
    ].join("\n");

    makeExecFileSucceed(output);

    const adapter = new AppleNotesAdapter();
    const items = await collect(adapter);

    expect(items.length).toBe(1);
    expect(items[0]!.source_id).toBe("valid-id");
  });

  it("handles empty output from osascript", async () => {
    makeExecFileSucceed("");

    const adapter = new AppleNotesAdapter();
    const items = await collect(adapter);

    expect(items.length).toBe(0);
  });

  it("handles multiple notes in a single extraction", async () => {
    const notes = Array.from({ length: 5 }, (_, i) => ({
      id: `note-${i}`,
      title: `Note ${i}`,
      folder: "Test",
      created: "2024-01-01T00:00:00Z",
      modified: "2024-01-01T00:00:00Z",
      body: `Content of note ${i}`,
    }));
    makeExecFileSucceed(buildNoteOutput(notes));

    const adapter = new AppleNotesAdapter();
    const items = await collect(adapter);

    expect(items.length).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(items[i]!.source_id).toBe(`note-${i}`);
      expect(items[i]!.content).toBe(`Content of note ${i}`);
    }
  });

  it("wraps non-Error throws from execFile", async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: (err: unknown) => void) => {
        if (typeof _opts === "function") {
          _opts("string error");
        } else if (typeof cb === "function") {
          cb("string error");
        }
      },
    );

    const adapter = new AppleNotesAdapter();
    await expect(async () => {
      for await (const _ of adapter.extract()) { /* consume */ }
    }).rejects.toThrow("Failed to read Apple Notes: string error");
  });
});

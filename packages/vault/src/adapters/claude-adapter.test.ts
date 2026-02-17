import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { ClaudeAdapter } from "./claude-adapter.js";

describe("ClaudeAdapter", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vault-claude-test-${uuid()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("has correct name and source", () => {
    const adapter = new ClaudeAdapter(tmpDir);
    expect(adapter.name).toBe("claude");
    expect(adapter.source).toBe("claude");
  });

  it("parses a Claude export JSON file", async () => {
    const conversations = [{
      uuid: "conv-uuid-1",
      name: "Express Routing",
      created_at: "2024-06-15T10:00:00Z",
      updated_at: "2024-06-15T11:00:00Z",
      chat_messages: [
        { uuid: "msg-1", sender: "human", text: "How do I set up Express routes?", created_at: "2024-06-15T10:00:00Z" },
        { uuid: "msg-2", sender: "assistant", text: "Here's how to set up Express routes...", created_at: "2024-06-15T10:01:00Z" },
      ],
    }];

    const filePath = join(tmpDir, "conversations.json");
    await writeFile(filePath, JSON.stringify(conversations), "utf-8");

    const adapter = new ClaudeAdapter(filePath);
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }

    expect(items.length).toBe(1);
    expect(items[0]!.source).toBe("claude");
    expect(items[0]!.source_id).toBe("conv-uuid-1");
    expect(items[0]!.title).toBe("Express Routing");
    expect(items[0]!.content).toContain("How do I set up Express routes?");
    expect(items[0]!.content).toContain("Here's how to set up");
    expect(items[0]!.metadata.message_count).toBe(2);
  });

  it("handles content array format", async () => {
    const conversations = [{
      uuid: "c2",
      name: "Content Array Test",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      chat_messages: [
        {
          uuid: "m1",
          sender: "human",
          text: "",
          created_at: "2024-01-01T00:00:00Z",
          content: [{ type: "text", text: "Hello from content array" }],
        },
      ],
    }];

    const filePath = join(tmpDir, "content-array.json");
    await writeFile(filePath, JSON.stringify(conversations), "utf-8");

    const adapter = new ClaudeAdapter(filePath);
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }

    expect(items.length).toBe(1);
    expect(items[0]!.content).toContain("Hello from content array");
  });

  it("handles directory of JSON files", async () => {
    const data = [{
      uuid: "d1",
      name: "Dir Test",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      chat_messages: [
        { uuid: "m1", sender: "human", text: "Hi", created_at: "2024-01-01T00:00:00Z" },
      ],
    }];

    await writeFile(join(tmpDir, "file1.json"), JSON.stringify(data), "utf-8");

    const adapter = new ClaudeAdapter(tmpDir);
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }

    expect(items.length).toBe(1);
  });

  it("skips conversations with no messages", async () => {
    const data = [{
      uuid: "empty",
      name: "Empty",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      chat_messages: [],
    }];

    await writeFile(join(tmpDir, "empty.json"), JSON.stringify(data), "utf-8");

    const adapter = new ClaudeAdapter(join(tmpDir, "empty.json"));
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }
    expect(items.length).toBe(0);
  });

  it("throws for non-existent path", async () => {
    const adapter = new ClaudeAdapter("/nonexistent/path");
    await expect(async () => {
      for await (const _ of adapter.extract()) { /* */ }
    }).rejects.toThrow("not found");
  });
});

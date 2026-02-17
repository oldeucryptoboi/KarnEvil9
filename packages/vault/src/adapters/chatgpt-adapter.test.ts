import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { ChatGPTAdapter } from "./chatgpt-adapter.js";

describe("ChatGPTAdapter", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vault-chatgpt-test-${uuid()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("has correct name and source", () => {
    const adapter = new ChatGPTAdapter(tmpDir);
    expect(adapter.name).toBe("chatgpt");
    expect(adapter.source).toBe("chatgpt");
  });

  it("parses a ChatGPT export JSON file", async () => {
    const conversations = [{
      id: "conv-1",
      title: "TypeScript Discussion",
      create_time: 1705312200,
      update_time: 1705315800,
      mapping: {
        "node-1": {
          id: "node-1",
          message: {
            author: { role: "user" },
            content: { parts: ["What is TypeScript?"] },
            create_time: 1705312200,
          },
          children: ["node-2"],
        },
        "node-2": {
          id: "node-2",
          message: {
            author: { role: "assistant" },
            content: { parts: ["TypeScript is a typed superset of JavaScript."] },
            create_time: 1705312201,
          },
          children: [],
          parent: "node-1",
        },
      },
    }];

    const filePath = join(tmpDir, "conversations.json");
    await writeFile(filePath, JSON.stringify(conversations), "utf-8");

    const adapter = new ChatGPTAdapter(filePath);
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }

    expect(items.length).toBe(1);
    expect(items[0]!.source).toBe("chatgpt");
    expect(items[0]!.source_id).toBe("conv-1");
    expect(items[0]!.title).toBe("TypeScript Discussion");
    expect(items[0]!.content).toContain("What is TypeScript?");
    expect(items[0]!.content).toContain("TypeScript is a typed superset");
    expect(items[0]!.metadata.message_count).toBe(2);
  });

  it("handles directory with conversations.json", async () => {
    const data = [{
      id: "c1",
      title: "Test",
      create_time: 1705312200,
      update_time: 1705312200,
      mapping: {
        "n1": {
          id: "n1",
          message: { author: { role: "user" }, content: { parts: ["Hello"] }, create_time: 1 },
          children: [],
        },
      },
    }];

    await writeFile(join(tmpDir, "conversations.json"), JSON.stringify(data), "utf-8");

    const adapter = new ChatGPTAdapter(tmpDir);
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }

    expect(items.length).toBe(1);
  });

  it("skips system messages", async () => {
    const data = [{
      id: "c2",
      title: "System Test",
      create_time: 1705312200,
      update_time: 1705312200,
      mapping: {
        "sys": {
          id: "sys",
          message: { author: { role: "system" }, content: { parts: ["You are helpful"] }, create_time: 0 },
          children: ["u1"],
        },
        "u1": {
          id: "u1",
          message: { author: { role: "user" }, content: { parts: ["Hi"] }, create_time: 1 },
          children: [],
          parent: "sys",
        },
      },
    }];

    await writeFile(join(tmpDir, "test.json"), JSON.stringify(data), "utf-8");

    const adapter = new ChatGPTAdapter(join(tmpDir, "test.json"));
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }

    expect(items.length).toBe(1);
    expect(items[0]!.content).not.toContain("You are helpful");
    expect(items[0]!.metadata.message_count).toBe(1);
  });

  it("throws for non-existent path", async () => {
    const adapter = new ChatGPTAdapter("/nonexistent/path");
    await expect(async () => {
      for await (const _ of adapter.extract()) { /* */ }
    }).rejects.toThrow("not found");
  });

  it("handles conversations with no messages", async () => {
    const data = [{
      id: "empty",
      title: "Empty",
      create_time: 1705312200,
      update_time: 1705312200,
      mapping: {
        "sys": {
          id: "sys",
          message: { author: { role: "system" }, content: { parts: [] }, create_time: 0 },
          children: [],
        },
      },
    }];

    await writeFile(join(tmpDir, "empty.json"), JSON.stringify(data), "utf-8");

    const adapter = new ChatGPTAdapter(join(tmpDir, "empty.json"));
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }
    expect(items.length).toBe(0);
  });
});

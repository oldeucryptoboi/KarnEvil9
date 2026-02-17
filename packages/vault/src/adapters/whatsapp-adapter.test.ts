import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { WhatsAppAdapter } from "./whatsapp-adapter.js";

describe("WhatsAppAdapter", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vault-whatsapp-test-${uuid()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("has correct name and source", () => {
    const adapter = new WhatsAppAdapter(join(tmpDir, "chat.txt"));
    expect(adapter.name).toBe("whatsapp");
    expect(adapter.source).toBe("whatsapp");
  });

  it("parses a WhatsApp chat export", async () => {
    const chatContent = [
      "15/01/2024, 10:30 - Alice: Hello there!",
      "15/01/2024, 10:31 - Bob: Hi Alice!",
      "15/01/2024, 10:32 - Alice: How are you?",
    ].join("\n");

    const filePath = join(tmpDir, "WhatsApp Chat with Alice.txt");
    await writeFile(filePath, chatContent, "utf-8");

    const adapter = new WhatsAppAdapter(filePath);
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }

    expect(items.length).toBe(1);
    expect(items[0]!.source).toBe("whatsapp");
    expect(items[0]!.title).toContain("Alice");
    expect(items[0]!.content).toContain("Alice");
    expect(items[0]!.content).toContain("Bob");
    expect(items[0]!.content).toContain("Hello there!");
    expect(items[0]!.metadata.message_count).toBe(3);
    expect(items[0]!.metadata.participants).toContain("Alice");
    expect(items[0]!.metadata.participants).toContain("Bob");
  });

  it("handles multiline messages", async () => {
    const chatContent = [
      "15/01/2024, 10:30 - Alice: First line",
      "Second line of same message",
      "Third line too",
      "15/01/2024, 10:31 - Bob: Reply",
    ].join("\n");

    const filePath = join(tmpDir, "chat.txt");
    await writeFile(filePath, chatContent, "utf-8");

    const adapter = new WhatsAppAdapter(filePath);
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }

    expect(items.length).toBe(1);
    expect(items[0]!.content).toContain("Second line");
    expect(items[0]!.content).toContain("Third line");
    expect(items[0]!.metadata.message_count).toBe(2);
  });

  it("handles empty file", async () => {
    const filePath = join(tmpDir, "empty.txt");
    await writeFile(filePath, "", "utf-8");

    const adapter = new WhatsAppAdapter(filePath);
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }
    expect(items.length).toBe(0);
  });

  it("throws for non-existent file", async () => {
    const adapter = new WhatsAppAdapter("/nonexistent/file.txt");
    await expect(async () => {
      for await (const _ of adapter.extract()) { /* */ }
    }).rejects.toThrow("not found");
  });

  it("extracts chat name from filename", async () => {
    const chatContent = "15/01/2024, 10:30 - User: Hey";
    const filePath = join(tmpDir, "WhatsApp Chat with Team Work.txt");
    await writeFile(filePath, chatContent, "utf-8");

    const adapter = new WhatsAppAdapter(filePath);
    const items = [];
    for await (const item of adapter.extract()) {
      items.push(item);
    }

    expect(items[0]!.title).toContain("Team Work");
  });
});

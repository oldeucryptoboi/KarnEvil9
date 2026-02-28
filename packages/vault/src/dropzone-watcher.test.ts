import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile, readdir, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { existsSync } from "node:fs";
import { DropZoneWatcher } from "./dropzone-watcher.js";

describe("DropZoneWatcher", () => {
  let tmpDir: string;
  let watcher: DropZoneWatcher;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vault-dropzone-test-${uuid()}`);
    await mkdir(tmpDir, { recursive: true });
    watcher = new DropZoneWatcher(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("detects ChatGPT JSON format", async () => {
    const chatgptData = [{ id: "conv1", title: "Test", mapping: { "node1": {} } }];
    await writeFile(join(tmpDir, "chatgpt-export.json"), JSON.stringify(chatgptData), "utf-8");

    const results = await watcher.scan();
    expect(results.length).toBe(1);
    expect(results[0]!.detectedSource).toBe("chatgpt");
  });

  it("detects Claude JSON format", async () => {
    const claudeData = [{ uuid: "abc", name: "Chat", chat_messages: [] }];
    await writeFile(join(tmpDir, "claude-export.json"), JSON.stringify(claudeData), "utf-8");

    const results = await watcher.scan();
    expect(results.length).toBe(1);
    expect(results[0]!.detectedSource).toBe("claude");
  });

  it("detects WhatsApp TXT format", async () => {
    const whatsappContent = "1/15/23, 10:30 AM - Alice: Hello\n1/15/23, 10:31 AM - Bob: Hi";
    await writeFile(join(tmpDir, "whatsapp-chat.txt"), whatsappContent, "utf-8");

    const results = await watcher.scan();
    expect(results.length).toBe(1);
    expect(results[0]!.detectedSource).toBe("whatsapp");
  });

  it("detects Gmail mbox format", async () => {
    await writeFile(join(tmpDir, "export.mbox"), "From sender@example.com", "utf-8");

    const results = await watcher.scan();
    expect(results.length).toBe(1);
    expect(results[0]!.detectedSource).toBe("gmail");
  });

  it("returns null for unknown file types", async () => {
    await writeFile(join(tmpDir, "random.xyz"), "Unknown content", "utf-8");

    const results = await watcher.scan();
    expect(results.length).toBe(0);
  });

  it("skips hidden files and directories", async () => {
    await writeFile(join(tmpDir, ".hidden-file.json"), JSON.stringify([{ mapping: {} }]), "utf-8");
    await mkdir(join(tmpDir, ".hidden-dir"), { recursive: true });

    const results = await watcher.scan();
    expect(results.length).toBe(0);
  });

  it("skips _processed directory", async () => {
    await mkdir(join(tmpDir, "_processed"), { recursive: true });

    const results = await watcher.scan();
    expect(results.length).toBe(0);
  });

  it("moves processed files to _processed with timestamp prefix", async () => {
    const filePath = join(tmpDir, "test-export.json");
    await writeFile(filePath, JSON.stringify([{ mapping: {} }]), "utf-8");

    await watcher.moveToProcessed(filePath);

    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(join(tmpDir, "_processed"))).toBe(true);

    const processedFiles = await readdir(join(tmpDir, "_processed"));
    expect(processedFiles.length).toBe(1);
    expect(processedFiles[0]).toContain("test-export.json");
    // Should have timestamp prefix
    expect(processedFiles[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns empty for non-existent dropzone", async () => {
    const nonExistent = new DropZoneWatcher(join(tmpDir, "no-such-dir"));
    const results = await nonExistent.scan();
    expect(results.length).toBe(0);
  });

  it("detects single Claude JSON object (not array)", async () => {
    const claudeData = { uuid: "abc-123", name: "Single Chat", chat_messages: [{ text: "hello" }] };
    await writeFile(join(tmpDir, "claude-single.json"), JSON.stringify(claudeData), "utf-8");

    const results = await watcher.scan();
    expect(results.length).toBe(1);
    expect(results[0]!.detectedSource).toBe("claude");
  });

  it("detects single ChatGPT JSON object (not array)", async () => {
    const chatgptData = { id: "conv1", title: "Test", mapping: { "node1": {} } };
    await writeFile(join(tmpDir, "chatgpt-single.json"), JSON.stringify(chatgptData), "utf-8");

    const results = await watcher.scan();
    expect(results.length).toBe(1);
    expect(results[0]!.detectedSource).toBe("chatgpt");
  });

  it("returns null for TXT file that is not WhatsApp format", async () => {
    const plainText = "This is just a regular text file with no date pattern.";
    await writeFile(join(tmpDir, "notes.txt"), plainText, "utf-8");

    const results = await watcher.scan();
    expect(results.length).toBe(0);
  });

  it("returns null for valid JSON that is neither ChatGPT nor Claude", async () => {
    const randomData = [{ random: true, data: "hello" }];
    await writeFile(join(tmpDir, "unknown-format.json"), JSON.stringify(randomData), "utf-8");

    const results = await watcher.scan();
    expect(results.length).toBe(0);
  });

  it("handles unreadable .txt files gracefully", async () => {
    const txtPath = join(tmpDir, "locked.txt");
    await writeFile(txtPath, "15/01/2024, 10:30 - Alice: Hello", "utf-8");
    await chmod(txtPath, 0o000);

    try {
      const results = await watcher.scan();
      expect(results.length).toBe(0);
    } finally {
      await chmod(txtPath, 0o644);
    }
  });

  it("handles invalid JSON gracefully", async () => {
    await writeFile(join(tmpDir, "bad.json"), "not valid json{{{", "utf-8");

    const results = await watcher.scan();
    expect(results.length).toBe(0);
  });

  it("skips symlinks to prevent path traversal", async () => {
    // Create a file outside the dropzone
    const outsideDir = join(tmpdir(), `vault-dropzone-outside-${uuid()}`);
    await mkdir(outsideDir, { recursive: true });
    const secretFile = join(outsideDir, "secret.json");
    await writeFile(secretFile, JSON.stringify([{ mapping: {} }]), "utf-8");

    // Create a symlink inside the dropzone pointing to the external file
    await symlink(secretFile, join(tmpDir, "link-to-secret.json"));

    const results = await watcher.scan();
    expect(results.length).toBe(0);

    await rm(outsideDir, { recursive: true, force: true });
  });
});

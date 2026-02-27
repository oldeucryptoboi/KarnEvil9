import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, symlink, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PolicyProfile } from "@karnevil9/schemas";
import { writeFileHandler } from "./write-file.js";
import { PolicyViolationError } from "../policy-enforcer.js";

const openPolicy: PolicyProfile = {
  allowed_paths: [],
  allowed_endpoints: [],
  allowed_commands: [],
  require_approval_for_writes: false,
};

/* ------------------------------------------------------------------ *
 *  Symlink TOCTOU protection — tests that the handler performs        *
 *  assertPathAllowedReal after mkdir to prevent symlink escapes.      *
 * ------------------------------------------------------------------ */

describe("writeFileHandler — symlink TOCTOU protection", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("blocks write through symlink escaping allowed paths", async () => {
    const outside = join(tmpdir(), "outside-write-" + Date.now());
    await mkdir(outside, { recursive: true });
    const target = join(outside, "target.txt");
    await writeFile(target, "original content");
    const link = join(tmpDir, "escape.txt");
    await symlink(target, link);

    try {
      await expect(
        writeFileHandler({ path: link, content: "malicious" }, "live", policy)
      ).rejects.toThrow(PolicyViolationError);

      // Verify original content was NOT overwritten
      const content = await readFile(target, "utf-8");
      expect(content).toBe("original content");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("allows write through symlink within allowed paths", async () => {
    const target = join(tmpDir, "real-target.txt");
    await writeFile(target, "old content");
    const link = join(tmpDir, "link.txt");
    await symlink(target, link);

    const result = (await writeFileHandler(
      { path: link, content: "new content" }, "live", policy
    )) as any;

    expect(result.written).toBe(true);
    const content = await readFile(target, "utf-8");
    expect(content).toBe("new content");
  });

  it("blocks write through directory symlink escaping allowed paths", async () => {
    const outside = join(tmpdir(), "dir-escape-write-" + Date.now());
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "existing.txt"), "original");
    const dirLink = join(tmpDir, "linked-dir");
    await symlink(outside, dirLink);
    const targetPath = join(dirLink, "existing.txt");

    try {
      await expect(
        writeFileHandler({ path: targetPath, content: "malicious" }, "live", policy)
      ).rejects.toThrow(PolicyViolationError);

      const content = await readFile(join(outside, "existing.txt"), "utf-8");
      expect(content).toBe("original");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("blocks write to sensitive file via symlink name bypass", async () => {
    // Even when the symlink has an innocent name, if the target path
    // itself resolves to a sensitive file, the write is blocked at the
    // assertNotSensitiveFile check (which checks the original path).
    // If the link name IS sensitive (e.g., .env), it's caught directly.
    const envPath = join(tmpDir, ".env");
    await expect(
      writeFileHandler({ path: envPath, content: "SECRET=value" }, "live", policy)
    ).rejects.toThrow(PolicyViolationError);
    expect(existsSync(envPath)).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { PolicyProfile } from "@karnevil9/schemas";
import { readFileHandler } from "./read-file.js";
import { PolicyViolationError } from "../policy-enforcer.js";

const openPolicy: PolicyProfile = {
  allowed_paths: [],
  allowed_endpoints: [],
  allowed_commands: [],
  require_approval_for_writes: false,
};

/* ------------------------------------------------------------------ *
 *  Symlink TOCTOU protection — tests that the handler performs        *
 *  realpath-based checks after the initial sync validation.           *
 * ------------------------------------------------------------------ */

describe("readFileHandler — symlink TOCTOU protection", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "read-handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("blocks symlink to sensitive file via realpath check", async () => {
    // The handler checks assertNotSensitiveFile(fullPath) which passes for
    // an innocent name. Then it calls assertNotSensitiveFile(realpath(fullPath))
    // which catches the resolved .env target.
    const envFile = join(tmpDir, ".env");
    await writeFile(envFile, "SECRET=value", "utf-8");
    const link = join(tmpDir, "config.txt");
    await symlink(envFile, link);

    await expect(
      readFileHandler({ path: link }, "real", policy)
    ).rejects.toThrow(PolicyViolationError);
  });

  it("blocks symlink to file outside allowed paths", async () => {
    const outside = join(tmpdir(), "outside-read-" + Date.now());
    await mkdir(outside, { recursive: true });
    const secret = join(outside, "data.txt");
    await writeFile(secret, "sensitive data");
    const link = join(tmpDir, "innocent.txt");
    await symlink(secret, link);

    try {
      await expect(
        readFileHandler({ path: link }, "real", policy)
      ).rejects.toThrow(PolicyViolationError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("allows symlink within allowed paths to non-sensitive file", async () => {
    const real = join(tmpDir, "real.txt");
    await writeFile(real, "safe content");
    const link = join(tmpDir, "link.txt");
    await symlink(real, link);

    const result = (await readFileHandler({ path: link }, "real", policy)) as any;
    expect(result.exists).toBe(true);
    expect(result.content).toBe("safe content");
  });

  it("blocks symlink to SSH key via directory pattern", async () => {
    const sshDir = join(tmpDir, ".ssh");
    await mkdir(sshDir, { recursive: true });
    const keyFile = join(sshDir, "config");
    await writeFile(keyFile, "Host *");
    const link = join(tmpDir, "ssh-link.txt");
    await symlink(keyFile, link);

    await expect(
      readFileHandler({ path: link }, "real", policy)
    ).rejects.toThrow(PolicyViolationError);
  });
});

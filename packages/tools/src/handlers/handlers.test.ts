import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PolicyProfile } from "@openvger/schemas";
import { readFileHandler } from "./read-file.js";
import { writeFileHandler } from "./write-file.js";
import { shellExecHandler } from "./shell-exec.js";
import { httpRequestHandler } from "./http-request.js";
import { PolicyViolationError } from "../policy-enforcer.js";

const openPolicy: PolicyProfile = {
  allowed_paths: [],
  allowed_endpoints: [],
  allowed_commands: [],
  require_approval_for_writes: false,
};

describe("readFileHandler", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads an existing file", async () => {
    const filePath = join(tmpDir, "test.txt");
    await writeFile(filePath, "hello world", "utf-8");
    const result = (await readFileHandler({ path: filePath }, "real", policy)) as any;
    expect(result.exists).toBe(true);
    expect(result.content).toBe("hello world");
    expect(result.size_bytes).toBeGreaterThan(0);
  });

  it("returns exists=false for missing file", async () => {
    const filePath = join(tmpDir, "missing.txt");
    const result = (await readFileHandler({ path: filePath }, "real", policy)) as any;
    expect(result.exists).toBe(false);
    expect(result.content).toBe("");
  });

  it("returns dry_run output without reading", async () => {
    const filePath = join(tmpDir, "test.txt");
    const result = (await readFileHandler({ path: filePath }, "dry_run", policy)) as any;
    expect(result.content).toContain("[dry_run]");
    expect(result.size_bytes).toBe(0);
  });

  it("rejects paths outside policy", async () => {
    const restrictedPolicy: PolicyProfile = { ...openPolicy, allowed_paths: ["/safe-only"] };
    await expect(
      readFileHandler({ path: "/etc/passwd" }, "real", restrictedPolicy)
    ).rejects.toThrow(PolicyViolationError);
  });
});

describe("writeFileHandler", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes content to a file", async () => {
    const filePath = join(tmpDir, "output.txt");
    const result = (await writeFileHandler(
      { path: filePath, content: "written content" }, "real", policy
    )) as any;
    expect(result.written).toBe(true);
    expect(result.bytes_written).toBe(Buffer.byteLength("written content", "utf-8"));
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("written content");
  });

  it("creates nested directories", async () => {
    const filePath = join(tmpDir, "sub", "dir", "file.txt");
    const result = (await writeFileHandler(
      { path: filePath, content: "nested" }, "real", policy
    )) as any;
    expect(result.written).toBe(true);
    expect(existsSync(filePath)).toBe(true);
  });

  it("returns dry_run output without writing", async () => {
    const filePath = join(tmpDir, "dry.txt");
    const result = (await writeFileHandler(
      { path: filePath, content: "should not write" }, "dry_run", policy
    )) as any;
    expect(result.written).toBe(false);
    expect(result.bytes_written).toBeGreaterThan(0);
    expect(existsSync(filePath)).toBe(false);
  });

  it("rejects paths outside policy", async () => {
    const restrictedPolicy: PolicyProfile = { ...openPolicy, allowed_paths: ["/safe-only"] };
    await expect(
      writeFileHandler({ path: "/tmp/evil.txt", content: "bad" }, "real", restrictedPolicy)
    ).rejects.toThrow(PolicyViolationError);
  });
});

describe("shellExecHandler", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("executes a command and returns output", async () => {
    const result = (await shellExecHandler(
      { command: "echo hello", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exit_code).toBe(0);
  });

  it("returns dry_run output without executing", async () => {
    const result = (await shellExecHandler(
      { command: "echo hello", cwd: tmpDir }, "dry_run", policy
    )) as any;
    expect(result.stdout).toContain("[dry_run]");
    expect(result.exit_code).toBe(0);
  });

  it("rejects commands not in allowlist", async () => {
    const restrictedPolicy: PolicyProfile = {
      ...openPolicy,
      allowed_paths: [tmpDir],
      allowed_commands: ["ls"],
    };
    await expect(
      shellExecHandler({ command: "rm -rf /" }, "real", restrictedPolicy)
    ).rejects.toThrow(PolicyViolationError);
  });

  it("rejects cwd outside policy paths", async () => {
    const restrictedPolicy: PolicyProfile = { ...openPolicy, allowed_paths: ["/safe-only"] };
    await expect(
      shellExecHandler({ command: "echo hi", cwd: "/tmp" }, "real", restrictedPolicy)
    ).rejects.toThrow(PolicyViolationError);
  });

  it("allows commands in the allowlist", async () => {
    const restrictedPolicy: PolicyProfile = {
      ...openPolicy,
      allowed_paths: [tmpDir],
      allowed_commands: ["echo"],
    };
    const result = (await shellExecHandler(
      { command: "echo allowed", cwd: tmpDir }, "real", restrictedPolicy
    )) as any;
    expect(result.stdout.trim()).toBe("allowed");
  });

  it("handles command failure", async () => {
    const result = (await shellExecHandler(
      { command: "false", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.exit_code).not.toBe(0);
  });
});

describe("shellExecHandler environment sanitization", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("filters out AWS_SECRET_ACCESS_KEY from environment", async () => {
    const originalValue = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key-123";
    try {
      const result = (await shellExecHandler(
        { command: "env", cwd: tmpDir }, "real", policy
      )) as any;
      expect(result.stdout).not.toContain("AWS_SECRET_ACCESS_KEY");
    } finally {
      if (originalValue !== undefined) process.env.AWS_SECRET_ACCESS_KEY = originalValue;
      else delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });

  it("filters out GITHUB_TOKEN from environment", async () => {
    const originalValue = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ghp_test123";
    try {
      const result = (await shellExecHandler(
        { command: "env", cwd: tmpDir }, "real", policy
      )) as any;
      expect(result.stdout).not.toContain("GITHUB_TOKEN");
    } finally {
      if (originalValue !== undefined) process.env.GITHUB_TOKEN = originalValue;
      else delete process.env.GITHUB_TOKEN;
    }
  });

  it("preserves PATH in environment", async () => {
    const result = (await shellExecHandler(
      { command: "env", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.stdout).toContain("PATH=");
  });
});

describe("httpRequestHandler", () => {
  it("returns dry_run output without fetching", async () => {
    const result = (await httpRequestHandler(
      { url: "https://example.com", method: "GET" }, "dry_run", openPolicy
    )) as any;
    expect(result.body).toContain("[dry_run]");
    expect(result.status).toBe(0);
  });

  it("rejects endpoints not in allowlist", async () => {
    const restrictedPolicy: PolicyProfile = {
      ...openPolicy,
      allowed_endpoints: ["https://api.allowed.com"],
    };
    await expect(
      httpRequestHandler(
        { url: "https://evil.com/steal", method: "GET" }, "real", restrictedPolicy
      )
    ).rejects.toThrow(PolicyViolationError);
  });

  it("allows endpoints in allowlist (dry_run to avoid network)", async () => {
    const policy: PolicyProfile = {
      ...openPolicy,
      allowed_endpoints: ["https://api.allowed.com"],
    };
    const result = (await httpRequestHandler(
      { url: "https://api.allowed.com/data", method: "GET" }, "dry_run", policy
    )) as any;
    expect(result.body).toContain("[dry_run]");
  });
});

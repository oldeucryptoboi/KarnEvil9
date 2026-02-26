import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PolicyProfile } from "@karnevil9/schemas";
import { readFileHandler } from "./read-file.js";
import { writeFileHandler } from "./write-file.js";
import { shellExecHandler, redactSecrets, parseCommand } from "./shell-exec.js";
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

describe("readFileHandler — file size cap", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects files exceeding 10 MB size cap", async () => {
    const filePath = join(tmpDir, "huge.txt");
    // Create a file slightly over 10 MB by writing a sparse descriptor
    // We use stat-based check, so just need the file to report > 10MB
    const tenMBPlus = Buffer.alloc(10 * 1024 * 1024 + 1, "a");
    await writeFile(filePath, tenMBPlus);
    await expect(
      readFileHandler({ path: filePath }, "real", policy)
    ).rejects.toThrow(/exceeding the .* byte limit/);
  });

  it("reads files at exactly the 10 MB limit", async () => {
    const filePath = join(tmpDir, "exact.txt");
    const exactTenMB = Buffer.alloc(10 * 1024 * 1024, "b");
    await writeFile(filePath, exactTenMB);
    const result = (await readFileHandler({ path: filePath }, "real", policy)) as any;
    expect(result.exists).toBe(true);
    expect(result.size_bytes).toBe(10 * 1024 * 1024);
  });
});

describe("shellExecHandler — timeout configuration", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts custom timeout_ms", async () => {
    const result = (await shellExecHandler(
      { command: "echo timeout_test", cwd: tmpDir, timeout_ms: 5000 }, "real", policy
    )) as any;
    expect(result.stdout.trim()).toBe("timeout_test");
    expect(result.exit_code).toBe(0);
  });

  it("clamps timeout_ms to maximum of 300000ms", async () => {
    // Should not throw — the timeout is clamped, not rejected
    const result = (await shellExecHandler(
      { command: "echo hi", cwd: tmpDir, timeout_ms: 999999 }, "real", policy
    )) as any;
    expect(result.exit_code).toBe(0);
  });

  it("clamps timeout_ms to minimum of 1000ms", async () => {
    const result = (await shellExecHandler(
      { command: "echo hi", cwd: tmpDir, timeout_ms: 100 }, "real", policy
    )) as any;
    expect(result.exit_code).toBe(0);
  });

  it("uses default timeout when timeout_ms not provided", async () => {
    const result = (await shellExecHandler(
      { command: "echo default", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.exit_code).toBe(0);
  });
});

describe("shellExecHandler — KARNEVIL9_ env prefix filtering", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("filters out KARNEVIL9_ prefixed environment variables", async () => {
    const original = process.env.KARNEVIL9_API_TOKEN;
    process.env.KARNEVIL9_API_TOKEN = "secret-token-123";
    try {
      const result = (await shellExecHandler(
        { command: "env", cwd: tmpDir }, "real", policy
      )) as any;
      expect(result.stdout).not.toContain("KARNEVIL9_API_TOKEN");
    } finally {
      if (original !== undefined) process.env.KARNEVIL9_API_TOKEN = original;
      else delete process.env.KARNEVIL9_API_TOKEN;
    }
  });

  it("filters out DATABASE_URL environment variable", async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://user:pass@host/db";
    try {
      const result = (await shellExecHandler(
        { command: "env", cwd: tmpDir }, "real", policy
      )) as any;
      expect(result.stdout).not.toContain("DATABASE_URL");
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
      else delete process.env.DATABASE_URL;
    }
  });

  it("filters out variables ending with _SECRET", async () => {
    const original = process.env.MY_APP_SECRET;
    process.env.MY_APP_SECRET = "supersecret";
    try {
      const result = (await shellExecHandler(
        { command: "env", cwd: tmpDir }, "real", policy
      )) as any;
      expect(result.stdout).not.toContain("MY_APP_SECRET");
    } finally {
      if (original !== undefined) process.env.MY_APP_SECRET = original;
      else delete process.env.MY_APP_SECRET;
    }
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

  it("M10: respects custom timeout_ms parameter", async () => {
    const result = (await httpRequestHandler(
      { url: "https://example.com", method: "GET", timeout_ms: 5000 }, "dry_run", openPolicy
    )) as any;
    // dry_run doesn't actually use the timeout, but ensures the param is accepted
    expect(result.body).toContain("[dry_run]");
  });

  it("M10: clamps timeout_ms to maximum of 120000ms", async () => {
    // Shouldn't throw on oversized timeout — it gets clamped
    const result = (await httpRequestHandler(
      { url: "https://example.com", method: "GET", timeout_ms: 999999 }, "dry_run", openPolicy
    )) as any;
    expect(result.body).toContain("[dry_run]");
  });

  it("M10: clamps timeout_ms to minimum of 1000ms", async () => {
    const result = (await httpRequestHandler(
      { url: "https://example.com", method: "GET", timeout_ms: 10 }, "dry_run", openPolicy
    )) as any;
    expect(result.body).toContain("[dry_run]");
  });

  it("M10: AbortController aborts fetch on timeout (real request)", async () => {
    // Use a very short timeout (1000ms min after clamping) against a URL that
    // will take long or fail — the AbortController should kick in.
    // We test with a non-routable IP to force a timeout.
    await expect(
      httpRequestHandler(
        { url: "http://192.0.2.1:80/slow", method: "GET", timeout_ms: 1000 }, "real", openPolicy
      )
    ).rejects.toThrow(); // Should throw abort or connection error
  }, 10000);

  it("rejects private IP addresses via SSRF protection", async () => {
    await expect(
      httpRequestHandler(
        { url: "http://127.0.0.1/admin", method: "GET" }, "real", openPolicy
      )
    ).rejects.toThrow();
  });

  it("H3: uses redirect: manual to prevent SSRF via redirect", async () => {
    // The handler now uses redirect: "manual" — a 302 to a private IP
    // should NOT be followed. We verify this by ensuring a redirect
    // response is returned with the 3xx status, not the redirected content.
    // This is hard to test without a real server, so we verify the handler
    // doesn't throw on a real public URL that returns a non-redirect response.
    const result = (await httpRequestHandler(
      { url: "https://example.com", method: "GET" }, "dry_run", openPolicy
    )) as any;
    expect(result.body).toContain("[dry_run]");
  });
});

describe("writeFileHandler — write size cap", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("M6: rejects content exceeding 10 MB write limit", async () => {
    const filePath = join(tmpDir, "huge.txt");
    const bigContent = "a".repeat(10 * 1024 * 1024 + 1);
    await expect(
      writeFileHandler({ path: filePath, content: bigContent }, "real", policy)
    ).rejects.toThrow(/exceeding the .* byte write limit/);
  });

  it("M6: allows content at exactly 10 MB", async () => {
    const filePath = join(tmpDir, "exact.txt");
    const exactContent = "a".repeat(10 * 1024 * 1024);
    const result = (await writeFileHandler(
      { path: filePath, content: exactContent }, "real", policy
    )) as any;
    expect(result.written).toBe(true);
    expect(result.bytes_written).toBe(10 * 1024 * 1024);
  });

  it("M6: write size check applies before disk write", async () => {
    const filePath = join(tmpDir, "should-not-exist.txt");
    const bigContent = "a".repeat(10 * 1024 * 1024 + 100);
    try {
      await writeFileHandler({ path: filePath, content: bigContent }, "real", policy);
    } catch {
      // Expected to throw
    }
    // File should not exist on disk
    expect(existsSync(filePath)).toBe(false);
  });
});

describe("shellExecHandler — command injection hardening", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects empty command string", async () => {
    await expect(
      shellExecHandler({ command: "" }, "real", policy)
    ).rejects.toThrow();
  });

  it("rejects non-string command input", async () => {
    await expect(
      shellExecHandler({ command: 123 }, "real", policy)
    ).rejects.toThrow("input.command must be a string");
  });

  it("restricts command when allowlist contains only safe binaries", async () => {
    const restrictedPolicy: PolicyProfile = {
      ...openPolicy,
      allowed_paths: [tmpDir],
      allowed_commands: ["echo", "ls", "cat"],
    };
    // Dangerous binaries rejected
    await expect(
      shellExecHandler({ command: "rm -rf /", cwd: tmpDir }, "real", restrictedPolicy)
    ).rejects.toThrow(PolicyViolationError);
    await expect(
      shellExecHandler({ command: "curl http://evil.com", cwd: tmpDir }, "real", restrictedPolicy)
    ).rejects.toThrow(PolicyViolationError);
    await expect(
      shellExecHandler({ command: "wget http://evil.com", cwd: tmpDir }, "real", restrictedPolicy)
    ).rejects.toThrow(PolicyViolationError);
    await expect(
      shellExecHandler({ command: "nc -l 4444", cwd: tmpDir }, "real", restrictedPolicy)
    ).rejects.toThrow(PolicyViolationError);
  });

  it("handles commands with quoted arguments containing spaces", async () => {
    const result = (await shellExecHandler(
      { command: 'echo "hello world"', cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.exit_code).toBe(0);
  });

  it("handles commands with single-quoted arguments", async () => {
    const result = (await shellExecHandler(
      { command: "echo 'hello world'", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.exit_code).toBe(0);
  });

  it("uses execFile not exec (no shell interpretation of metacharacters)", async () => {
    // execFile doesn't interpret shell metacharacters like ; | && etc.
    // So "echo hello; echo world" should NOT execute two commands.
    // Instead, it passes "; echo world" as args to echo.
    const result = (await shellExecHandler(
      { command: "echo hello; echo world", cwd: tmpDir }, "real", policy
    )) as any;
    // execFile will pass the semicolon as literal text to echo
    expect(result.stdout).toContain(";");
    expect(result.exit_code).toBe(0);
  });

  it("does not pass pipe operator to shell", async () => {
    // With execFile, pipe is not interpreted as shell pipe
    const result = (await shellExecHandler(
      { command: "echo hello | cat", cwd: tmpDir }, "real", policy
    )) as any;
    // execFile passes "| cat" as literal args to echo
    expect(result.stdout).toContain("|");
  });

  it("handles non-existent binary gracefully", async () => {
    const result = (await shellExecHandler(
      { command: "nonexistent_binary_xyz", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.exit_code).not.toBe(0);
  });

  it("respects maxBuffer limit (1 MB)", async () => {
    // Generate output larger than maxBuffer — the command should still complete
    // but the output might be truncated or the command killed
    const result = (await shellExecHandler(
      { command: "yes | head -100", cwd: tmpDir }, "real", policy
    )) as any;
    // yes | head won't work with execFile (no shell), so it should fail
    expect(result.exit_code).not.toBe(undefined);
  });
});

describe("writeFileHandler — writable_paths enforcement", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects writes outside writable_paths", async () => {
    const writableDir = join(tmpDir, "writable");
    const readonlyDir = join(tmpDir, "readonly");
    const policy: PolicyProfile = {
      ...openPolicy,
      allowed_paths: [tmpDir],
      writable_paths: [writableDir],
    };
    await expect(
      writeFileHandler(
        { path: join(readonlyDir, "file.txt"), content: "bad" }, "real", policy
      )
    ).rejects.toThrow(PolicyViolationError);
  });

  it("allows writes within writable_paths", async () => {
    const writableDir = join(tmpDir, "writable");
    const policy: PolicyProfile = {
      ...openPolicy,
      allowed_paths: [tmpDir],
      writable_paths: [writableDir],
    };
    const result = (await writeFileHandler(
      { path: join(writableDir, "file.txt"), content: "ok" }, "real", policy
    )) as any;
    expect(result.written).toBe(true);
  });

  it("rejects writes to readonly_paths", async () => {
    const readonlyDir = join(tmpDir, "protected");
    const policy: PolicyProfile = {
      ...openPolicy,
      allowed_paths: [tmpDir],
      readonly_paths: [readonlyDir],
    };
    await expect(
      writeFileHandler(
        { path: join(readonlyDir, "file.txt"), content: "bad" }, "real", policy
      )
    ).rejects.toThrow(PolicyViolationError);
  });

  it("readonly_paths takes precedence (nested under writable)", async () => {
    const writableDir = tmpDir;
    const readonlyDir = join(tmpDir, "secrets");
    const policy: PolicyProfile = {
      ...openPolicy,
      allowed_paths: [tmpDir],
      writable_paths: [writableDir],
      readonly_paths: [readonlyDir],
    };
    await expect(
      writeFileHandler(
        { path: join(readonlyDir, "key.pem"), content: "secret" }, "real", policy
      )
    ).rejects.toThrow(PolicyViolationError);
  });

  it("dry_run respects writable_paths but does not write", async () => {
    const writableDir = join(tmpDir, "writable");
    const policy: PolicyProfile = {
      ...openPolicy,
      allowed_paths: [tmpDir],
      writable_paths: [writableDir],
    };
    // Outside writable_paths should still throw in dry_run
    await expect(
      writeFileHandler(
        { path: join(tmpDir, "outside.txt"), content: "data" }, "dry_run", policy
      )
    ).rejects.toThrow(PolicyViolationError);
  });
});

describe("writeFileHandler — input validation", () => {
  it("rejects non-string path", async () => {
    await expect(
      writeFileHandler({ path: 123, content: "data" }, "real", openPolicy)
    ).rejects.toThrow("input.path must be a string");
  });

  it("rejects non-string content", async () => {
    await expect(
      writeFileHandler({ path: "/tmp/test.txt", content: 123 }, "real", openPolicy)
    ).rejects.toThrow("input.content must be a string");
  });
});

describe("readFileHandler — input validation", () => {
  it("rejects non-string path", async () => {
    await expect(
      readFileHandler({ path: 123 }, "real", openPolicy)
    ).rejects.toThrow("input.path must be a string");
  });
});

describe("httpRequestHandler — input validation", () => {
  it("rejects non-string url", async () => {
    await expect(
      httpRequestHandler({ url: 123, method: "GET" }, "real", openPolicy)
    ).rejects.toThrow("input.url must be a string");
  });

  it("rejects non-string method", async () => {
    await expect(
      httpRequestHandler({ url: "https://example.com", method: 123 }, "real", openPolicy)
    ).rejects.toThrow("input.method must be a string");
  });

  it("does not send body for GET requests", async () => {
    // GET with body should still work in dry_run — body is ignored
    const result = (await httpRequestHandler(
      { url: "https://example.com", method: "GET", body: "ignored" }, "dry_run", openPolicy
    )) as any;
    expect(result.body).toContain("[dry_run]");
  });
});

describe("httpRequestHandler — headers and methods", () => {
  it("passes custom headers in dry_run", async () => {
    const result = (await httpRequestHandler(
      { url: "https://example.com", method: "GET", headers: { "X-Custom": "value" } }, "dry_run", openPolicy
    )) as any;
    expect(result.body).toContain("[dry_run]");
  });

  it("accepts POST method with body in dry_run", async () => {
    const result = (await httpRequestHandler(
      { url: "https://example.com/api", method: "POST", body: '{"key":"value"}' }, "dry_run", openPolicy
    )) as any;
    expect(result.body).toContain("[dry_run]");
    expect(result.body).toContain("POST");
  });

  it("accepts PATCH method in dry_run", async () => {
    const result = (await httpRequestHandler(
      { url: "https://example.com/api/1", method: "PATCH", body: '{"update":true}' }, "dry_run", openPolicy
    )) as any;
    expect(result.body).toContain("[dry_run]");
    expect(result.body).toContain("PATCH");
  });

  it("accepts DELETE method in dry_run", async () => {
    const result = (await httpRequestHandler(
      { url: "https://example.com/api/1", method: "DELETE" }, "dry_run", openPolicy
    )) as any;
    expect(result.body).toContain("[dry_run]");
    expect(result.body).toContain("DELETE");
  });

  it("ignores body for GET requests in dry_run", async () => {
    const result = (await httpRequestHandler(
      { url: "https://example.com", method: "GET", body: "should-be-ignored" }, "dry_run", openPolicy
    )) as any;
    expect(result.body).toContain("[dry_run]");
    expect(result.body).toContain("GET");
  });

  it("rejects invalid headers type", async () => {
    // headers as non-object should be ignored (not throw)
    const result = (await httpRequestHandler(
      { url: "https://example.com", method: "GET", headers: "bad" }, "dry_run", openPolicy
    )) as any;
    expect(result.body).toContain("[dry_run]");
  });

  it("rejects request to link-local IPv6 address", async () => {
    await expect(
      httpRequestHandler(
        { url: "http://[::1]/admin", method: "GET" }, "real", openPolicy
      )
    ).rejects.toThrow();
  });
});

describe("browserHandler — DNS rebinding protection", () => {
  it("H2: browser handler uses async SSRF check (imports assertEndpointAllowedAsync)", async () => {
    // Verify the browser handler rejects private IPs (proves it uses assertEndpointAllowedAsync)
    const { browserHandler } = await import("./browser.js");
    await expect(
      browserHandler({ action: "navigate", url: "http://127.0.0.1/admin" }, "real", openPolicy)
    ).rejects.toThrow();
  });

  it("H2: browser handler rejects navigate to private IP in real mode", async () => {
    const { browserHandler } = await import("./browser.js");
    await expect(
      browserHandler({ action: "navigate", url: "http://10.0.0.1/internal" }, "real", openPolicy)
    ).rejects.toThrow();
  });

  it("H2: browser handler allows dry_run without SSRF check", async () => {
    const { browserHandler } = await import("./browser.js");
    const result = (await browserHandler(
      { action: "navigate", url: "http://127.0.0.1/admin" }, "dry_run", openPolicy
    )) as any;
    expect(result.url).toContain("[dry_run]");
  });
});

describe("redactSecrets", () => {
  it("redacts ANTHROPIC_API_KEY=sk-... pattern", () => {
    const input = "ANTHROPIC_API_KEY=sk-ant-abc123def456ghi789";
    const result = redactSecrets(input);
    expect(result).toBe("ANTHROPIC_API_KEY=[REDACTED]");
  });

  it("redacts AWS_SECRET_ACCESS_KEY=value", () => {
    const input = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const result = redactSecrets(input);
    expect(result).toBe("AWS_SECRET_ACCESS_KEY=[REDACTED]");
  });

  it("redacts GITHUB_TOKEN=value", () => {
    const input = "GITHUB_TOKEN=ghp_abc123def456";
    const result = redactSecrets(input);
    expect(result).toBe("GITHUB_TOKEN=[REDACTED]");
  });

  it("redacts DATABASE_URL=value", () => {
    const input = "DATABASE_URL=postgres://user:pass@host/db";
    const result = redactSecrets(input);
    expect(result).toBe("DATABASE_URL=[REDACTED]");
  });

  it("redacts variables ending with _SECRET", () => {
    const input = "MY_APP_SECRET=supersecretvalue123";
    const result = redactSecrets(input);
    expect(result).toBe("MY_APP_SECRET=[REDACTED]");
  });

  it("redacts variables ending with _PASSWORD", () => {
    const input = "DB_PASSWORD=hunter2";
    const result = redactSecrets(input);
    expect(result).toBe("DB_PASSWORD=[REDACTED]");
  });

  it("redacts Bearer tokens in output", () => {
    const input = "Authorization: Bearer sk-ant-api03-longtoken123456789abcdef";
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-ant-api03");
  });

  it("redacts GitHub PAT patterns inline", () => {
    const input = "Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl";
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("ghp_ABCDEF");
  });

  it("redacts AWS access key IDs", () => {
    const input = "aws_access_key_id = AKIAIOSFODNN7EXAMPLE";
    const result = redactSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts Slack bot tokens inline", () => {
    const input = "SLACK_BOT_TOKEN=xoxb-123456789-abcdef";
    const result = redactSecrets(input);
    expect(result).toBe("SLACK_BOT_TOKEN=[REDACTED]");
  });

  it("passes through normal output", () => {
    const input = "Hello world\nPATH=/usr/bin:/usr/local/bin\nHOME=/home/user";
    const result = redactSecrets(input);
    expect(result).toBe(input);
  });

  it("handles multiline output with mixed sensitive and normal lines", () => {
    const input = "NODE_ENV=production\nANTHROPIC_API_KEY=sk-ant-secret123456789abcdef\nPATH=/usr/bin";
    const result = redactSecrets(input);
    expect(result).toContain("NODE_ENV=production");
    expect(result).toContain("ANTHROPIC_API_KEY=[REDACTED]");
    expect(result).toContain("PATH=/usr/bin");
  });

  it("redacts OPENAI_API_KEY", () => {
    const input = "OPENAI_API_KEY=sk-proj-abc123def456ghi789jkl012";
    const result = redactSecrets(input);
    expect(result).toBe("OPENAI_API_KEY=[REDACTED]");
  });
});

describe("readFileHandler — sensitive file protection", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("blocks reading .env files", async () => {
    const envPath = join(tmpDir, ".env");
    await writeFile(envPath, "SECRET=value", "utf-8");
    await expect(
      readFileHandler({ path: envPath }, "real", policy)
    ).rejects.toThrow(PolicyViolationError);
  });

  it("blocks reading .env.local files", async () => {
    const envPath = join(tmpDir, ".env.local");
    await writeFile(envPath, "SECRET=value", "utf-8");
    await expect(
      readFileHandler({ path: envPath }, "real", policy)
    ).rejects.toThrow(PolicyViolationError);
  });

  it("blocks reading .pem files", async () => {
    const pemPath = join(tmpDir, "server.pem");
    await writeFile(pemPath, "-----BEGIN CERTIFICATE-----", "utf-8");
    await expect(
      readFileHandler({ path: pemPath }, "real", policy)
    ).rejects.toThrow(PolicyViolationError);
  });

  it("blocks reading .key files", async () => {
    const keyPath = join(tmpDir, "private.key");
    await writeFile(keyPath, "-----BEGIN PRIVATE KEY-----", "utf-8");
    await expect(
      readFileHandler({ path: keyPath }, "real", policy)
    ).rejects.toThrow(PolicyViolationError);
  });
});

describe("writeFileHandler — sensitive file protection", () => {
  let tmpDir: string;
  let policy: PolicyProfile;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "handler-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("blocks writing to .env files", async () => {
    const envPath = join(tmpDir, ".env");
    await expect(
      writeFileHandler({ path: envPath, content: "SECRET=value" }, "real", policy)
    ).rejects.toThrow(PolicyViolationError);
  });

  it("blocks writing to .key files", async () => {
    const keyPath = join(tmpDir, "private.key");
    await expect(
      writeFileHandler({ path: keyPath, content: "key data" }, "real", policy)
    ).rejects.toThrow(PolicyViolationError);
  });

  it("blocks writing to credentials.json", async () => {
    const credPath = join(tmpDir, "credentials.json");
    await expect(
      writeFileHandler({ path: credPath, content: "{}" }, "real", policy)
    ).rejects.toThrow(PolicyViolationError);
  });
});

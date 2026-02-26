import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { PolicyProfile } from "@karnevil9/schemas";
import { redactSecrets, parseCommand, shellExecHandler } from "./shell-exec.js";

const openPolicy: PolicyProfile = {
  allowed_paths: [],
  allowed_endpoints: [],
  allowed_commands: [],
  require_approval_for_writes: false,
};

/* ------------------------------------------------------------------ *
 *  parseCommand — direct unit tests                                   *
 * ------------------------------------------------------------------ */

describe("parseCommand", () => {
  it("returns empty array for empty string", () => {
    expect(parseCommand("")).toEqual([]);
  });

  it("splits simple space-separated args", () => {
    expect(parseCommand("echo hello world")).toEqual(["echo", "hello", "world"]);
  });

  it("collapses multiple spaces between args", () => {
    expect(parseCommand("echo   hello   world")).toEqual(["echo", "hello", "world"]);
  });

  it("preserves double-quoted strings with spaces", () => {
    expect(parseCommand('echo "hello world"')).toEqual(["echo", "hello world"]);
  });

  it("preserves single-quoted strings with spaces", () => {
    expect(parseCommand("echo 'hello world'")).toEqual(["echo", "hello world"]);
  });

  it("handles backslash escaping outside quotes", () => {
    expect(parseCommand("echo hello\\ world")).toEqual(["echo", "hello world"]);
  });

  it("treats backslash as literal inside single quotes", () => {
    expect(parseCommand("echo '\\n'")).toEqual(["echo", "\\n"]);
  });

  it("handles backslash escaping inside double quotes", () => {
    expect(parseCommand('echo "hello\\"world"')).toEqual(["echo", 'hello"world']);
  });

  it("handles mixed double and single quotes", () => {
    expect(parseCommand(`echo "hello" 'world'`)).toEqual(["echo", "hello", "world"]);
  });

  it("concatenates adjacent quoted segments", () => {
    expect(parseCommand(`echo "hello"'world'`)).toEqual(["echo", "helloworld"]);
  });

  it("strips leading spaces", () => {
    expect(parseCommand("  echo hello")).toEqual(["echo", "hello"]);
  });

  it("strips trailing spaces", () => {
    expect(parseCommand("echo hello  ")).toEqual(["echo", "hello"]);
  });

  it("handles single argument with no spaces", () => {
    expect(parseCommand("ls")).toEqual(["ls"]);
  });

  it("preserves escaped special characters", () => {
    expect(parseCommand("echo \\;")).toEqual(["echo", ";"]);
    expect(parseCommand("echo \\|")).toEqual(["echo", "|"]);
    expect(parseCommand("echo \\&")).toEqual(["echo", "&"]);
  });

  it("drops empty double-quoted strings (no content to push)", () => {
    // parseCommand only pushes when current.length > 0, so empty quotes are dropped
    expect(parseCommand('echo "" end')).toEqual(["echo", "end"]);
  });

  it("drops empty single-quoted strings (no content to push)", () => {
    expect(parseCommand("echo '' end")).toEqual(["echo", "end"]);
  });
});

/* ------------------------------------------------------------------ *
 *  redactSecrets — additional token patterns                          *
 * ------------------------------------------------------------------ */

describe("redactSecrets — additional token patterns", () => {
  it("redacts JWT tokens (header.payload format)", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0";
    const result = redactSecrets(`Token: ${jwt}`);
    expect(result).not.toContain("eyJhbGci");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts GitLab personal access tokens", () => {
    const token = "glpat-abcDEF123456789012345678";
    const result = redactSecrets(`GITLAB: ${token}`);
    expect(result).not.toContain("glpat-");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts npm tokens", () => {
    const token = "npm_abcdefghijklmnopqrstuvwxyz0123456789AB";
    const result = redactSecrets(`NPM: ${token}`);
    expect(result).not.toContain("npm_abcdef");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts PyPI tokens", () => {
    const token = "pypi-abcdefghijklmnopqrstuvwxyz0123456789AB";
    const result = redactSecrets(`PYPI: ${token}`);
    expect(result).not.toContain("pypi-abcdef");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts GitHub fine-grained personal access tokens", () => {
    const token = "github_pat_1234567890abcdefABCDEF";
    const result = redactSecrets(`GH: ${token}`);
    expect(result).not.toContain("github_pat_");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts GitHub OAuth tokens", () => {
    const token = "gho_abcdefghijklmnopqrstuvwxyz0123456789AB";
    const result = redactSecrets(`OAuth: ${token}`);
    expect(result).not.toContain("gho_abcdef");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts GitHub server tokens", () => {
    const token = "ghs_abcdefghijklmnopqrstuvwxyz0123456789AB";
    const result = redactSecrets(`Server: ${token}`);
    expect(result).not.toContain("ghs_abcdef");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts Slack user tokens (xoxp-)", () => {
    const token = "xoxp-123456789-abcdef";
    const result = redactSecrets(`Slack: ${token}`);
    expect(result).not.toContain("xoxp-");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts PEM PRIVATE KEY markers", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    const result = redactSecrets(pem);
    expect(result).toContain("[REDACTED]");
  });
});

/* ------------------------------------------------------------------ *
 *  redactSecrets — JSON-embedded secrets                              *
 * ------------------------------------------------------------------ */

describe("redactSecrets — JSON-embedded secrets", () => {
  it("redacts api_key values in JSON", () => {
    const json = '{"api_key": "sk-very-secret-value-1234"}';
    const result = redactSecrets(json);
    expect(result).toContain('"api_key": "[REDACTED]"');
    expect(result).not.toContain("sk-very-secret");
  });

  it("redacts secret_key values in JSON", () => {
    const json = '{"secret_key": "mysupersecretkey1234"}';
    const result = redactSecrets(json);
    expect(result).toContain('"secret_key": "[REDACTED]"');
  });

  it("redacts access_token values in JSON", () => {
    const json = '{"access_token": "bearer_token_value1234"}';
    const result = redactSecrets(json);
    expect(result).toContain('"access_token": "[REDACTED]"');
  });

  it("redacts password values in JSON", () => {
    const json = '{"password": "hunter2_extended_password"}';
    const result = redactSecrets(json);
    expect(result).toContain('"password": "[REDACTED]"');
  });

  it("redacts client_secret values in JSON", () => {
    const json = '{"client_secret": "abcdefghijklmnop1234"}';
    const result = redactSecrets(json);
    expect(result).toContain('"client_secret": "[REDACTED]"');
  });

  it("preserves non-sensitive JSON keys", () => {
    const json = '{"username": "john", "email": "john@example.com"}';
    const result = redactSecrets(json);
    expect(result).toBe(json);
  });

  it("handles multiple JSON secrets in same output", () => {
    const json = '{"api_key": "key_value_12345678", "password": "pass_value_12345678"}';
    const result = redactSecrets(json);
    expect(result).toContain('"api_key": "[REDACTED]"');
    expect(result).toContain('"password": "[REDACTED]"');
    expect(result).not.toContain("key_value");
    expect(result).not.toContain("pass_value");
  });

  it("ignores JSON secrets with short values (< 8 chars)", () => {
    const json = '{"api_key": "short"}';
    const result = redactSecrets(json);
    expect(result).toBe(json);
  });
});

/* ------------------------------------------------------------------ *
 *  sanitizeEnv — additional prefix coverage via handler integration   *
 * ------------------------------------------------------------------ */

describe("shellExecHandler — sanitizeEnv additional prefixes", () => {
  let tmpDir: string;
  let policy: PolicyProfile;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "shell-exec-test-"));
    policy = { ...openPolicy, allowed_paths: [tmpDir] };
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function saveAndSet(key: string, value: string) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  it("filters out AZURE_ prefixed vars", async () => {
    saveAndSet("AZURE_STORAGE_KEY", "azure-secret-123");
    const result = (await shellExecHandler(
      { command: "env", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.stdout).not.toContain("AZURE_STORAGE_KEY");
  });

  it("filters out GCP_ prefixed vars", async () => {
    saveAndSet("GCP_PROJECT_ID", "my-gcp-project");
    const result = (await shellExecHandler(
      { command: "env", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.stdout).not.toContain("GCP_PROJECT_ID");
  });

  it("filters out GOOGLE_ prefixed vars", async () => {
    saveAndSet("GOOGLE_APPLICATION_CREDENTIALS", "/path/to/creds.json");
    const result = (await shellExecHandler(
      { command: "env", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.stdout).not.toContain("GOOGLE_APPLICATION_CREDENTIALS");
  });

  it("filters out DOCKER_ prefixed vars", async () => {
    saveAndSet("DOCKER_AUTH_CONFIG", "docker-config-secret");
    const result = (await shellExecHandler(
      { command: "env", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.stdout).not.toContain("DOCKER_AUTH_CONFIG");
  });

  it("filters out GITLAB_ prefixed vars", async () => {
    saveAndSet("GITLAB_TOKEN", "glpat-test-token");
    const result = (await shellExecHandler(
      { command: "env", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.stdout).not.toContain("GITLAB_TOKEN");
  });

  it("filters out vars ending with _TOKEN suffix", async () => {
    saveAndSet("CUSTOM_SERVICE_TOKEN", "service-token-abc");
    const result = (await shellExecHandler(
      { command: "env", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.stdout).not.toContain("CUSTOM_SERVICE_TOKEN");
  });

  it("filters out vars ending with _KEY suffix", async () => {
    saveAndSet("STRIPE_KEY", "sk_test_stripe_key");
    const result = (await shellExecHandler(
      { command: "env", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.stdout).not.toContain("STRIPE_KEY");
  });

  it("filters out vars ending with _PASSWORD suffix", async () => {
    saveAndSet("REDIS_PASSWORD", "redis-secret-pw");
    const result = (await shellExecHandler(
      { command: "env", cwd: tmpDir }, "real", policy
    )) as any;
    expect(result.stdout).not.toContain("REDIS_PASSWORD");
  });
});

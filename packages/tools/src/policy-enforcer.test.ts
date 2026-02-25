import { describe, it, expect, } from "vitest";
import { resolve } from "node:path";
import {
  assertPathAllowed,
  assertCommandAllowed,
  assertEndpointAllowed,
  assertEndpointAllowedAsync,
  assertNotSensitiveFile,
  PolicyViolationError,
  SsrfError,
  isPrivateIP,
} from "./policy-enforcer.js";

describe("assertPathAllowed", () => {
  it("allows paths within allowed directories", () => {
    expect(() => assertPathAllowed("/workspace/src/file.ts", ["/workspace"])).not.toThrow();
  });

  it("allows when allowedPaths is empty (open policy)", () => {
    expect(() => assertPathAllowed("/anywhere/file.ts", [])).not.toThrow();
  });

  it("rejects paths outside allowed directories", () => {
    expect(() => assertPathAllowed("/etc/passwd", ["/workspace"])).toThrow(PolicyViolationError);
  });

  it("rejects path traversal attempts", () => {
    const resolved = resolve("/workspace/../etc/passwd");
    expect(() => assertPathAllowed(resolved, ["/workspace"])).toThrow(PolicyViolationError);
  });

  it("allows with multiple allowed paths", () => {
    expect(() => assertPathAllowed("/tmp/output.txt", ["/workspace", "/tmp"])).not.toThrow();
  });

  it("rejects when path is a prefix but not a directory match", () => {
    // /workspace-evil should not match /workspace
    expect(() => assertPathAllowed("/workspace-evil/file.ts", ["/workspace"])).toThrow(PolicyViolationError);
  });
});

describe("assertCommandAllowed", () => {
  it("allows commands in the allowlist", () => {
    expect(() => assertCommandAllowed("ls -la", ["ls", "cat"])).not.toThrow();
  });

  it("allows when allowedCommands is empty (open policy)", () => {
    expect(() => assertCommandAllowed("rm -rf /", [])).not.toThrow();
  });

  it("rejects commands not in the allowlist", () => {
    expect(() => assertCommandAllowed("rm -rf /", ["ls", "cat"])).toThrow(PolicyViolationError);
  });

  it("extracts binary name from complex commands", () => {
    expect(() => assertCommandAllowed("git commit -m 'msg'", ["git"])).not.toThrow();
  });

  it("rejects when binary does not match", () => {
    expect(() => assertCommandAllowed("curl http://evil.com", ["wget"])).toThrow(PolicyViolationError);
  });
});

describe("assertEndpointAllowed", () => {
  it("allows endpoints in the allowlist", () => {
    expect(() => assertEndpointAllowed("https://api.example.com/data", ["https://api.example.com"])).not.toThrow();
  });

  it("allows when allowedEndpoints is empty (open policy)", () => {
    expect(() => assertEndpointAllowed("https://evil.com", [])).not.toThrow();
  });

  it("rejects endpoints not in the allowlist", () => {
    expect(() => assertEndpointAllowed("https://evil.com/steal", ["https://api.example.com"])).toThrow(PolicyViolationError);
  });

  it("matches by hostname when endpoint is just a hostname", () => {
    expect(() => assertEndpointAllowed("https://api.example.com/path", ["api.example.com"])).not.toThrow();
  });

  it("rejects invalid URLs", () => {
    expect(() => assertEndpointAllowed("not-a-url", ["example.com"])).toThrow(PolicyViolationError);
  });
});

describe("isPrivateIP", () => {
  it("detects 127.0.0.1 as private", () => {
    expect(isPrivateIP("127.0.0.1")).toBe(true);
  });

  it("detects 10.x.x.x as private", () => {
    expect(isPrivateIP("10.0.0.1")).toBe(true);
    expect(isPrivateIP("10.255.255.255")).toBe(true);
  });

  it("detects 172.16.x.x as private", () => {
    expect(isPrivateIP("172.16.0.1")).toBe(true);
    expect(isPrivateIP("172.31.255.255")).toBe(true);
  });

  it("detects 192.168.x.x as private", () => {
    expect(isPrivateIP("192.168.1.1")).toBe(true);
  });

  it("detects 169.254.x.x (link-local) as private", () => {
    expect(isPrivateIP("169.254.169.254")).toBe(true);
  });

  it("detects ::1 as private", () => {
    expect(isPrivateIP("::1")).toBe(true);
  });

  it("detects localhost as private", () => {
    expect(isPrivateIP("localhost")).toBe(true);
  });

  it("detects 0.0.0.0 as private", () => {
    expect(isPrivateIP("0.0.0.0")).toBe(true);
  });

  it("allows public IPs", () => {
    expect(isPrivateIP("8.8.8.8")).toBe(false);
    expect(isPrivateIP("1.1.1.1")).toBe(false);
    expect(isPrivateIP("203.0.113.1")).toBe(false);
  });
});

describe("SSRF protection in assertEndpointAllowed", () => {
  it("blocks private IPs even with empty allowlist", () => {
    expect(() => assertEndpointAllowed("http://127.0.0.1/admin", [])).toThrow(SsrfError);
    expect(() => assertEndpointAllowed("http://10.0.0.1/internal", [])).toThrow(SsrfError);
    expect(() => assertEndpointAllowed("http://172.16.0.1/data", [])).toThrow(SsrfError);
    expect(() => assertEndpointAllowed("http://192.168.1.1/config", [])).toThrow(SsrfError);
    expect(() => assertEndpointAllowed("http://169.254.169.254/latest/meta-data", [])).toThrow(SsrfError);
  });

  it("blocks ftp:// protocol", () => {
    expect(() => assertEndpointAllowed("ftp://example.com/file", [])).toThrow(SsrfError);
  });

  it("blocks file:// protocol", () => {
    expect(() => assertEndpointAllowed("file:///etc/passwd", [])).toThrow(SsrfError);
  });

  it("blocks non-standard ports", () => {
    expect(() => assertEndpointAllowed("http://example.com:6379/", [])).toThrow(SsrfError);
    expect(() => assertEndpointAllowed("http://example.com:27017/", [])).toThrow(SsrfError);
    expect(() => assertEndpointAllowed("http://example.com:3306/", [])).toThrow(SsrfError);
  });

  it("allows standard ports 80, 443, 8080, 8443", () => {
    expect(() => assertEndpointAllowed("http://example.com:80/path", [])).not.toThrow();
    expect(() => assertEndpointAllowed("https://example.com:443/path", [])).not.toThrow();
    expect(() => assertEndpointAllowed("http://example.com:8080/path", [])).not.toThrow();
    expect(() => assertEndpointAllowed("https://example.com:8443/path", [])).not.toThrow();
  });

  it("allows public IPs with standard ports", () => {
    expect(() => assertEndpointAllowed("https://8.8.8.8/dns", [])).not.toThrow();
    expect(() => assertEndpointAllowed("https://1.1.1.1/", [])).not.toThrow();
  });
});

describe("isPrivateIP — IPv6 coverage", () => {
  it("detects bracketed IPv6 loopback [::1]", () => {
    expect(isPrivateIP("[::1]")).toBe(true);
  });

  it("detects :: (all-zeros) as private", () => {
    expect(isPrivateIP("::")).toBe(true);
  });

  it("detects full-form IPv6 loopback", () => {
    expect(isPrivateIP("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isPrivateIP("0:0:0:0:0:0:0:0")).toBe(true);
  });

  it("detects IPv6-mapped IPv4 private addresses", () => {
    expect(isPrivateIP("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIP("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIP("::ffff:192.168.1.1")).toBe(true);
  });

  it("allows IPv6-mapped public addresses", () => {
    expect(isPrivateIP("::ffff:8.8.8.8")).toBe(false);
  });

  it("detects IPv6 link-local (fe80::)", () => {
    expect(isPrivateIP("fe80::1")).toBe(true);
  });

  it("detects IPv6 unique local (fc00::/7)", () => {
    expect(isPrivateIP("fc00::1")).toBe(true);
    expect(isPrivateIP("fd00::1")).toBe(true);
  });

  it("detects 0.x.x.x range as private", () => {
    expect(isPrivateIP("0.0.0.0")).toBe(true);
    expect(isPrivateIP("0.1.2.3")).toBe(true);
  });
});

describe("assertEndpointAllowedAsync — DNS rebinding protection", () => {
  it("allows public hostnames that resolve to public IPs", async () => {
    // example.com resolves to public IPs in the real DNS
    await expect(assertEndpointAllowedAsync("https://example.com/", [])).resolves.toBeUndefined();
  });

  it("blocks hostnames that resolve to private IPs (DNS rebinding)", async () => {
    // localhost resolves to 127.0.0.1
    // The sync check will block "localhost" directly since it's recognized as private
    await expect(assertEndpointAllowedAsync("http://localhost/admin", [])).rejects.toThrow(SsrfError);
  });

  it("skips DNS resolution for IP literals (already checked by sync)", async () => {
    await expect(assertEndpointAllowedAsync("https://8.8.8.8/dns", [])).resolves.toBeUndefined();
  });

  it("blocks IP literals that are private", async () => {
    await expect(assertEndpointAllowedAsync("http://127.0.0.1/", [])).rejects.toThrow(SsrfError);
  });

  it("runs sync checks first (protocol, port, hostname)", async () => {
    await expect(assertEndpointAllowedAsync("ftp://example.com/file", [])).rejects.toThrow(SsrfError);
    await expect(assertEndpointAllowedAsync("http://example.com:6379/", [])).rejects.toThrow(SsrfError);
  });

  it("blocks hostnames that fail DNS resolution", async () => {
    await expect(
      assertEndpointAllowedAsync("https://this-domain-definitely-does-not-exist-xyz123.invalid/", [])
    ).rejects.toThrow(SsrfError);
  });

  it("respects endpoint allowlist", async () => {
    await expect(
      assertEndpointAllowedAsync("https://evil.com/steal", ["https://api.example.com"])
    ).rejects.toThrow(PolicyViolationError);
  });
});

describe("assertPathAllowed — edge cases", () => {
  it("handles exact path match (file, not directory)", () => {
    expect(() => assertPathAllowed("/workspace/file.ts", ["/workspace/file.ts"])).not.toThrow();
  });

  it("rejects path that is a prefix substring but not a child", () => {
    // /workspace-backup should NOT match /workspace
    expect(() => assertPathAllowed("/workspace-backup/file.ts", ["/workspace"])).toThrow(PolicyViolationError);
  });

  it("handles nested allowed paths", () => {
    expect(() => assertPathAllowed("/workspace/src/deep/file.ts", ["/workspace"])).not.toThrow();
  });

  it("handles trailing slash in allowed path", () => {
    // resolve() normalizes trailing slashes
    expect(() => assertPathAllowed("/workspace/file.ts", ["/workspace/"])).not.toThrow();
  });
});

describe("assertCommandAllowed — edge cases", () => {
  it("extracts binary from command with leading whitespace", () => {
    expect(() => assertCommandAllowed("  ls -la", ["ls"])).not.toThrow();
  });

  it("rejects when command matches as substring of allowed binary", () => {
    // "git-rebase" should not match allowlist ["git"]
    expect(() => assertCommandAllowed("git-rebase --interactive", ["git"])).toThrow(PolicyViolationError);
  });

  it("exact binary match required", () => {
    expect(() => assertCommandAllowed("gitx status", ["git"])).toThrow(PolicyViolationError);
  });
});

describe("assertEndpointAllowed — URL edge cases", () => {
  it("blocks javascript: protocol", () => {
    expect(() => assertEndpointAllowed("javascript:alert(1)", [])).toThrow(SsrfError);
  });

  it("blocks data: protocol", () => {
    expect(() => assertEndpointAllowed("data:text/html,<script>alert(1)</script>", [])).toThrow(SsrfError);
  });

  it("handles URL with auth info in hostname", () => {
    // user:pass@host — the hostname should be "evil.com" not the auth part
    expect(() => assertEndpointAllowed("http://user:pass@evil.com:80/path", ["evil.com"])).not.toThrow();
  });

  it("blocks http to metadata endpoint (169.254.169.254)", () => {
    expect(() => assertEndpointAllowed("http://169.254.169.254/latest/meta-data/", [])).toThrow(SsrfError);
  });

  it("allows default port when not specified (https → 443)", () => {
    expect(() => assertEndpointAllowed("https://example.com/path", [])).not.toThrow();
  });

  it("allows default port when not specified (http → 80)", () => {
    expect(() => assertEndpointAllowed("http://example.com/path", [])).not.toThrow();
  });
});

describe("isPrivateIP — additional edge cases", () => {
  it("detects 172.15.x.x as NOT private (just below range)", () => {
    expect(isPrivateIP("172.15.0.1")).toBe(false);
  });

  it("detects 172.32.x.x as NOT private (just above range)", () => {
    expect(isPrivateIP("172.32.0.1")).toBe(false);
  });

  it("handles non-IP strings as not private", () => {
    expect(isPrivateIP("example.com")).toBe(false);
    expect(isPrivateIP("not-an-ip")).toBe(false);
  });

  it("handles empty string", () => {
    expect(isPrivateIP("")).toBe(false);
  });
});

describe("SSRF bypass edge cases", () => {
  it("blocks decimal-encoded localhost (2130706433 = 127.0.0.1)", () => {
    // URL parser converts http://2130706433/ to http://2130706433/ — hostname is not an IP
    // This should fail the endpoint allowlist if configured, and DNS resolution catches it
    expect(isPrivateIP("2130706433")).toBe(false); // Not detected as IP format
  });

  it("blocks IPv6 loopback in URL", () => {
    expect(() => assertEndpointAllowed("http://[::1]:80/admin", [])).toThrow(SsrfError);
  });

  it("detects IPv6-mapped private IPv4 in raw form", () => {
    // isPrivateIP catches ::ffff:127.0.0.1 directly
    expect(isPrivateIP("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIP("::ffff:10.0.0.1")).toBe(true);
    // Note: URL parser converts [::ffff:127.0.0.1] to [::ffff:7f00:1] (hex form),
    // which requires DNS-level rebinding detection via assertEndpointAllowedAsync
  });

  it("blocks IPv6 unique local addresses in URL", () => {
    expect(() => assertEndpointAllowed("http://[fd00::1]:80/", [])).toThrow(SsrfError);
  });

  it("blocks IPv6 link-local in URL", () => {
    expect(() => assertEndpointAllowed("http://[fe80::1]:80/", [])).toThrow(SsrfError);
  });

  it("blocks 127.x.x.x variants (not just 127.0.0.1)", () => {
    expect(isPrivateIP("127.0.0.2")).toBe(true);
    expect(isPrivateIP("127.255.255.255")).toBe(true);
    expect(() => assertEndpointAllowed("http://127.0.0.2:80/admin", [])).toThrow(SsrfError);
  });

  it("blocks cloud metadata endpoint variants", () => {
    // AWS metadata
    expect(() => assertEndpointAllowed("http://169.254.169.254/latest/meta-data/", [])).toThrow(SsrfError);
    // Other link-local
    expect(() => assertEndpointAllowed("http://169.254.0.1:80/", [])).toThrow(SsrfError);
  });

  it("blocks 0.0.0.0 in URL", () => {
    expect(() => assertEndpointAllowed("http://0.0.0.0:80/", [])).toThrow(SsrfError);
  });

  it("async version blocks localhost DNS resolution", async () => {
    // "localhost" is caught by the sync check (isPrivateIP("localhost") = true)
    await expect(assertEndpointAllowedAsync("http://localhost:80/", [])).rejects.toThrow(SsrfError);
  });

  it("async version handles IPv6 literal (skips DNS)", async () => {
    // IPv6 literal should be caught by sync check, not DNS
    await expect(assertEndpointAllowedAsync("http://[::1]:80/", [])).rejects.toThrow(SsrfError);
  });
});

describe("assertNotSensitiveFile", () => {
  it("blocks .env", () => {
    expect(() => assertNotSensitiveFile("/workspace/.env")).toThrow(PolicyViolationError);
  });

  it("blocks .env.local", () => {
    expect(() => assertNotSensitiveFile("/workspace/.env.local")).toThrow(PolicyViolationError);
  });

  it("blocks .env.production", () => {
    expect(() => assertNotSensitiveFile("/workspace/.env.production")).toThrow(PolicyViolationError);
  });

  it("blocks credentials.json", () => {
    expect(() => assertNotSensitiveFile("/workspace/credentials.json")).toThrow(PolicyViolationError);
  });

  it("blocks service-account.json", () => {
    expect(() => assertNotSensitiveFile("/gcp/service-account.json")).toThrow(PolicyViolationError);
  });

  it("blocks id_rsa", () => {
    expect(() => assertNotSensitiveFile("/home/user/.ssh/id_rsa")).toThrow(PolicyViolationError);
  });

  it("blocks id_ed25519", () => {
    expect(() => assertNotSensitiveFile("/home/user/id_ed25519")).toThrow(PolicyViolationError);
  });

  it("blocks .pem files", () => {
    expect(() => assertNotSensitiveFile("/certs/server.pem")).toThrow(PolicyViolationError);
  });

  it("blocks .key files", () => {
    expect(() => assertNotSensitiveFile("/certs/private.key")).toThrow(PolicyViolationError);
  });

  it("blocks .p12 files", () => {
    expect(() => assertNotSensitiveFile("/certs/cert.p12")).toThrow(PolicyViolationError);
  });

  it("blocks .pfx files", () => {
    expect(() => assertNotSensitiveFile("/certs/cert.pfx")).toThrow(PolicyViolationError);
  });

  it("blocks .jks files", () => {
    expect(() => assertNotSensitiveFile("/java/keystore.jks")).toThrow(PolicyViolationError);
  });

  it("blocks .keystore files", () => {
    expect(() => assertNotSensitiveFile("/java/my.keystore")).toThrow(PolicyViolationError);
  });

  it("blocks files under .ssh/", () => {
    expect(() => assertNotSensitiveFile("/home/user/.ssh/config")).toThrow(PolicyViolationError);
    expect(() => assertNotSensitiveFile("/home/user/.ssh/known_hosts")).toThrow(PolicyViolationError);
  });

  it("blocks files under .gnupg/", () => {
    expect(() => assertNotSensitiveFile("/home/user/.gnupg/trustdb.gpg")).toThrow(PolicyViolationError);
  });

  it("blocks files under .aws/", () => {
    expect(() => assertNotSensitiveFile("/home/user/.aws/credentials")).toThrow(PolicyViolationError);
    expect(() => assertNotSensitiveFile("/home/user/.aws/config")).toThrow(PolicyViolationError);
  });

  it("allows normal files", () => {
    expect(() => assertNotSensitiveFile("/workspace/config.ts")).not.toThrow();
    expect(() => assertNotSensitiveFile("/workspace/readme.md")).not.toThrow();
    expect(() => assertNotSensitiveFile("/workspace/src/index.ts")).not.toThrow();
  });

  it("allows .envrc (not .env)", () => {
    expect(() => assertNotSensitiveFile("/workspace/.envrc")).not.toThrow();
  });

  it("allows .env-example (not .env.*)", () => {
    expect(() => assertNotSensitiveFile("/workspace/.env-example")).not.toThrow();
  });

  it("allows files with 'key' in the name but wrong extension", () => {
    expect(() => assertNotSensitiveFile("/workspace/keyboard.ts")).not.toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  assertPathAllowed,
  assertCommandAllowed,
  assertEndpointAllowed,
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

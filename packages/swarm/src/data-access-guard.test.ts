import { describe, it, expect } from "vitest";
import { DataAccessGuard } from "./data-access-guard.js";

describe("DataAccessGuard", () => {
  describe("validatePath", () => {
    it("allows paths matching allowed_paths", () => {
      const guard = new DataAccessGuard({ allowed_paths: ["/data/", "/config/"] });
      expect(guard.validatePath("/data/file.txt").allowed).toBe(true);
      expect(guard.validatePath("/config/app.json").allowed).toBe(true);
    });

    it("denies paths not in allowed_paths", () => {
      const guard = new DataAccessGuard({ allowed_paths: ["/data/"] });
      const result = guard.validatePath("/secret/keys.json");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in allowed paths");
    });

    it("denies paths matching denied_paths", () => {
      const guard = new DataAccessGuard({ denied_paths: ["/secret/", "/private/"] });
      const result = guard.validatePath("/secret/keys.json");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("denied pattern");
    });

    it("denied_paths take precedence over allowed_paths", () => {
      const guard = new DataAccessGuard({
        allowed_paths: ["/data/*"],
        denied_paths: ["/data/secret*"],
      });
      expect(guard.validatePath("/data/public.txt").allowed).toBe(true);
      expect(guard.validatePath("/data/secret.key").allowed).toBe(false);
    });

    it("supports wildcard patterns", () => {
      const guard = new DataAccessGuard({ allowed_paths: ["/app/*"] });
      expect(guard.validatePath("/app/src/index.ts").allowed).toBe(true);
      expect(guard.validatePath("/other/file.ts").allowed).toBe(false);
    });

    it("allows all paths when no scope restrictions", () => {
      const guard = new DataAccessGuard({});
      expect(guard.validatePath("/anything/anywhere.txt").allowed).toBe(true);
    });

    it("allows exact path match", () => {
      const guard = new DataAccessGuard({ allowed_paths: ["/data/file.txt"] });
      expect(guard.validatePath("/data/file.txt").allowed).toBe(true);
      expect(guard.validatePath("/data/other.txt").allowed).toBe(false);
    });
  });

  describe("redactSensitiveFields", () => {
    it("redacts specified fields", () => {
      const guard = new DataAccessGuard({ sensitive_fields: ["password", "api_key"] });
      const data = { name: "test", password: "secret123", api_key: "key-abc" };
      const redacted = guard.redactSensitiveFields(data);
      expect(redacted.name).toBe("test");
      expect(redacted.password).toBe("[REDACTED]");
      expect(redacted.api_key).toBe("[REDACTED]");
    });

    it("redacts nested fields", () => {
      const guard = new DataAccessGuard({ sensitive_fields: ["token"] });
      const data = { user: { name: "test", auth: { token: "secret" } } };
      const redacted = guard.redactSensitiveFields(data);
      expect((redacted.user as Record<string, unknown>).name).toBe("test");
      expect(((redacted.user as Record<string, unknown>).auth as Record<string, unknown>).token).toBe("[REDACTED]");
    });

    it("returns data unchanged when no sensitive fields", () => {
      const guard = new DataAccessGuard({});
      const data = { name: "test", value: 42 };
      const redacted = guard.redactSensitiveFields(data);
      expect(redacted).toEqual(data);
    });
  });

  describe("checkDataSize", () => {
    it("allows data within size limit", () => {
      const guard = new DataAccessGuard({ max_data_size_bytes: 1024 });
      expect(guard.checkDataSize(500).allowed).toBe(true);
    });

    it("denies data exceeding size limit", () => {
      const guard = new DataAccessGuard({ max_data_size_bytes: 1024 });
      const result = guard.checkDataSize(2048);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("exceeds limit");
    });

    it("allows any size when no limit set", () => {
      const guard = new DataAccessGuard({});
      expect(guard.checkDataSize(999999999).allowed).toBe(true);
    });
  });

  describe("toConstraints", () => {
    it("generates tool_allowlist constraint when allowed_paths set", () => {
      const guard = new DataAccessGuard({ allowed_paths: ["/data/"] });
      const constraints = guard.toConstraints();
      expect(constraints.tool_allowlist).toBeDefined();
    });

    it("returns empty constraints when no paths set", () => {
      const guard = new DataAccessGuard({});
      const constraints = guard.toConstraints();
      expect(constraints.tool_allowlist).toBeUndefined();
    });
  });

  describe("deepRedact hardening", () => {
    it("stops recursing at MAX_REDACT_DEPTH (20) to prevent stack overflow", () => {
      const guard = new DataAccessGuard({ sensitive_fields: ["secret"] });
      // Build a deeply nested object (30 levels)
      let obj: Record<string, unknown> = { secret: "deep-secret" };
      for (let i = 0; i < 30; i++) {
        obj = { nested: obj };
      }
      // Should not throw (would overflow without depth guard)
      const redacted = guard.redactSensitiveFields(obj);
      // At depth 20 the recursion stops and returns the raw object;
      // levels < 20 should still traverse normally
      expect(redacted).toBeDefined();
    });

    it("skips __proto__, constructor, and prototype keys to prevent pollution", () => {
      const guard = new DataAccessGuard({ sensitive_fields: ["token"] });
      const data = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"bad": true}, "prototype": {"evil": true}, "token": "abc", "safe": 1}');
      const redacted = guard.redactSensitiveFields(data);
      expect(redacted.safe).toBe(1);
      expect(redacted.token).toBe("[REDACTED]");
      // Pollution keys should be stripped
      expect(Object.hasOwn(redacted, "__proto__")).toBe(false);
      expect(Object.hasOwn(redacted, "constructor")).toBe(false);
      expect(Object.hasOwn(redacted, "prototype")).toBe(false);
    });
  });

  describe("getScope", () => {
    it("returns a copy of the scope", () => {
      const scope = { allowed_paths: ["/data/"], sensitive_fields: ["password"] };
      const guard = new DataAccessGuard(scope);
      const retrieved = guard.getScope();
      expect(retrieved).toEqual(scope);
      // Verify it's a copy
      retrieved.allowed_paths!.push("/evil/");
      expect(guard.getScope().allowed_paths).toHaveLength(1);
    });
  });
});

import { describe, it, expect } from "vitest";
import { AccessControl } from "./access-control.js";

describe("AccessControl", () => {
  // ── Constructor defaults ──

  describe("constructor", () => {
    it("defaults to allowlist mode", () => {
      const ac = new AccessControl();
      expect(ac.mode).toBe("allowlist");
      expect(ac.isPairingMode).toBe(false);
    });

    it("accepts pairing mode", () => {
      const ac = new AccessControl({ mode: "pairing" });
      expect(ac.mode).toBe("pairing");
      expect(ac.isPairingMode).toBe(true);
    });

    it("filters falsy values from allowedUsers", () => {
      const ac = new AccessControl({ allowedUsers: [0, NaN, 123, 456] });
      // 0 and NaN are falsy, filtered out
      expect(ac.allowedUsers.size).toBe(2);
      expect(ac.isAllowed(123)).toBe(true);
      expect(ac.isAllowed(0)).toBe(false);
    });
  });

  // ── isAllowed ──

  describe("isAllowed", () => {
    it("denies all when allowlist is empty (allowlist mode)", () => {
      const ac = new AccessControl({ allowedUsers: [], mode: "allowlist" });
      expect(ac.isAllowed(12345)).toBe(false);
    });

    it("denies all when allowlist is empty (pairing mode)", () => {
      const ac = new AccessControl({ allowedUsers: [], mode: "pairing" });
      expect(ac.isAllowed(12345)).toBe(false);
    });

    it("allows listed users", () => {
      const ac = new AccessControl({ allowedUsers: [100, 200] });
      expect(ac.isAllowed(100)).toBe(true);
      expect(ac.isAllowed(200)).toBe(true);
    });

    it("denies unlisted users", () => {
      const ac = new AccessControl({ allowedUsers: [100] });
      expect(ac.isAllowed(999)).toBe(false);
    });
  });

  // ── isPairingMode ──

  describe("isPairingMode", () => {
    it("returns true for pairing mode", () => {
      expect(new AccessControl({ mode: "pairing" }).isPairingMode).toBe(true);
    });

    it("returns false for allowlist mode", () => {
      expect(new AccessControl({ mode: "allowlist" }).isPairingMode).toBe(false);
    });
  });

  // ── addUser ──

  describe("addUser", () => {
    it("adds a user at runtime", () => {
      const ac = new AccessControl({ mode: "pairing" });
      expect(ac.isAllowed(42)).toBe(false);

      ac.addUser(42);
      expect(ac.isAllowed(42)).toBe(true);
    });

    it("is idempotent (adding same user twice is fine)", () => {
      const ac = new AccessControl({ mode: "pairing" });
      ac.addUser(42);
      ac.addUser(42);
      expect(ac.allowedUsers.size).toBe(1);
      expect(ac.isAllowed(42)).toBe(true);
    });

    it("works in allowlist mode too", () => {
      const ac = new AccessControl({ allowedUsers: [100], mode: "allowlist" });
      ac.addUser(200);
      expect(ac.isAllowed(200)).toBe(true);
    });
  });
});

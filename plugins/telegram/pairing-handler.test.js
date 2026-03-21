import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PairingHandler } from "./pairing-handler.js";

describe("PairingHandler", () => {
  let handler;

  beforeEach(() => {
    handler = new PairingHandler();
  });

  // ── Code generation ──

  describe("createPairingCode", () => {
    it("returns a 6-character alphanumeric code", () => {
      const code = handler.createPairingCode(111, 111);
      expect(code).toMatch(/^[23456789A-HJ-NP-Z]{6}$/);
    });

    it("excludes ambiguous characters (0, O, 1, I)", () => {
      // Generate many codes and check none contain ambiguous chars
      for (let i = 0; i < 100; i++) {
        const h = new PairingHandler();
        const code = h.createPairingCode(i, i);
        expect(code).not.toMatch(/[01OI]/);
      }
    });

    it("reuses existing code for same user", () => {
      const code1 = handler.createPairingCode(42, 42);
      const code2 = handler.createPairingCode(42, 42);
      expect(code2).toBe(code1);
    });

    it("generates different codes for different users", () => {
      const code1 = handler.createPairingCode(100, 100);
      const code2 = handler.createPairingCode(200, 200);
      // Theoretically could collide but astronomically unlikely with 28^6 space
      expect(code1).not.toBe(code2);
    });
  });

  // ── Listing ──

  describe("listPending", () => {
    it("returns empty array initially", () => {
      expect(handler.listPending()).toEqual([]);
    });

    it("lists all pending pairings", () => {
      handler.createPairingCode(10, 10);
      handler.createPairingCode(20, 20);
      const pending = handler.listPending();
      expect(pending).toHaveLength(2);
      expect(pending[0]).toMatchObject({ userId: 10, chatId: 10 });
      expect(pending[1]).toMatchObject({ userId: 20, chatId: 20 });
      expect(pending[0].code).toEqual(expect.any(String));
      expect(pending[0].createdAt).toEqual(expect.any(Number));
    });
  });

  // ── Approve ──

  describe("approve", () => {
    it("returns userId and chatId on valid code", () => {
      const code = handler.createPairingCode(55, 55);
      const result = handler.approve(code);
      expect(result).toEqual({ userId: 55, chatId: 55 });
    });

    it("removes the code after approval", () => {
      const code = handler.createPairingCode(55, 55);
      handler.approve(code);
      expect(handler.approve(code)).toBeNull();
      expect(handler.listPending()).toHaveLength(0);
    });

    it("returns null for unknown code", () => {
      expect(handler.approve("ZZZZZZ")).toBeNull();
    });
  });

  // ── Deny ──

  describe("deny", () => {
    it("returns userId and chatId on valid code", () => {
      const code = handler.createPairingCode(77, 77);
      const result = handler.deny(code);
      expect(result).toEqual({ userId: 77, chatId: 77 });
    });

    it("removes the code after denial", () => {
      const code = handler.createPairingCode(77, 77);
      handler.deny(code);
      expect(handler.deny(code)).toBeNull();
      expect(handler.listPending()).toHaveLength(0);
    });

    it("returns null for unknown code", () => {
      expect(handler.deny("AAAAAA")).toBeNull();
    });
  });

  // ── pendingCount ──

  describe("pendingCount", () => {
    it("returns 0 initially", () => {
      expect(handler.pendingCount).toBe(0);
    });

    it("increments as codes are created", () => {
      handler.createPairingCode(1, 1);
      handler.createPairingCode(2, 2);
      expect(handler.pendingCount).toBe(2);
    });

    it("decrements after approve", () => {
      const code = handler.createPairingCode(1, 1);
      handler.approve(code);
      expect(handler.pendingCount).toBe(0);
    });

    it("does not double-count reuse for same user", () => {
      handler.createPairingCode(1, 1);
      handler.createPairingCode(1, 1);
      expect(handler.pendingCount).toBe(1);
    });
  });

  // ── Expiry ──

  describe("expiry", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("purges expired codes on listPending", () => {
      const code = handler.createPairingCode(99, 99);
      expect(handler.listPending()).toHaveLength(1);

      // Advance past 1 hour TTL
      vi.advanceTimersByTime(60 * 60 * 1000 + 1);

      expect(handler.listPending()).toHaveLength(0);
    });

    it("purges expired codes on createPairingCode", () => {
      handler.createPairingCode(99, 99);
      vi.advanceTimersByTime(60 * 60 * 1000 + 1);

      // Creating a new code should purge the expired one
      handler.createPairingCode(100, 100);
      expect(handler.pendingCount).toBe(1);
    });

    it("expired code returns null on approve", () => {
      const code = handler.createPairingCode(99, 99);
      vi.advanceTimersByTime(60 * 60 * 1000 + 1);
      expect(handler.approve(code)).toBeNull();
    });

    it("expired code returns null on deny", () => {
      const code = handler.createPairingCode(99, 99);
      vi.advanceTimersByTime(60 * 60 * 1000 + 1);
      expect(handler.deny(code)).toBeNull();
    });

    it("generates new code for user after their old code expired", () => {
      const code1 = handler.createPairingCode(99, 99);
      vi.advanceTimersByTime(60 * 60 * 1000 + 1);

      const code2 = handler.createPairingCode(99, 99);
      expect(code2).not.toBe(code1);
      expect(handler.pendingCount).toBe(1);
    });
  });
});

import { describe, it, expect } from "vitest";
import { parseInterval, computeNextCron, computeNextInterval } from "./interval.js";

describe("parseInterval", () => {
  it("parses seconds", () => {
    expect(parseInterval("30s")).toBe(30_000);
  });

  it("parses minutes", () => {
    expect(parseInterval("5m")).toBe(300_000);
  });

  it("parses hours", () => {
    expect(parseInterval("1h")).toBe(3_600_000);
  });

  it("parses days", () => {
    expect(parseInterval("2d")).toBe(172_800_000);
  });

  it("throws on invalid format", () => {
    expect(() => parseInterval("abc")).toThrow("Invalid interval format");
    expect(() => parseInterval("10x")).toThrow("Invalid interval format");
    expect(() => parseInterval("")).toThrow("Invalid interval format");
  });

  it("throws on integer overflow for large interval values", () => {
    // 99999999999999d = 99999999999999 * 86400000 which overflows MAX_SAFE_INTEGER
    expect(() => parseInterval("99999999999999d")).toThrow("overflows safe integer range");
    // 99999999999999h = 99999999999999 * 3600000 which overflows MAX_SAFE_INTEGER
    expect(() => parseInterval("99999999999999h")).toThrow("overflows safe integer range");
  });

  it("accepts large but safe interval values", () => {
    // 365d = 31_536_000_000ms — well within safe integer range
    expect(parseInterval("365d")).toBe(365 * 86_400_000);
  });
});

describe("computeNextCron", () => {
  it("returns a valid ISO date for a cron expression", () => {
    const next = computeNextCron("*/5 * * * *");
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("computes next from a specific date", () => {
    const from = new Date("2025-01-01T00:00:00Z");
    const next = computeNextCron("0 9 * * 1-5", "UTC", from);
    const d = new Date(next);
    expect(d.getUTCHours()).toBe(9);
    expect(d.getUTCMinutes()).toBe(0);
    // Jan 1, 2025 is Wednesday — next weekday 9am should be Jan 1
    expect(d.getTime()).toBeGreaterThan(from.getTime());
  });
});

describe("computeNextInterval", () => {
  it("computes next from lastRunAt", () => {
    const lastRun = new Date(Date.now() - 10_000).toISOString();
    const next = computeNextInterval("30s", lastRun);
    const nextDate = new Date(next);
    // Should be ~20s from now (30s - 10s elapsed)
    expect(nextDate.getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(nextDate.getTime()).toBeLessThanOrEqual(Date.now() + 21_000);
  });

  it("computes next from startAt in the future", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const next = computeNextInterval("5m", undefined, future);
    expect(new Date(next).toISOString()).toBe(future);
  });

  it("falls back to now + interval when no base is given", () => {
    const before = Date.now();
    const next = computeNextInterval("1h");
    const after = Date.now();
    const nextMs = new Date(next).getTime();
    expect(nextMs).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(nextMs).toBeLessThanOrEqual(after + 3_600_000);
  });

  it("throws on invalid lastRunAt date", () => {
    expect(() => computeNextInterval("30s", "not-a-date")).toThrow("Invalid lastRunAt date");
  });

  it("throws on invalid startAt date", () => {
    expect(() => computeNextInterval("30s", undefined, "garbage")).toThrow("Invalid startAt date");
  });
});

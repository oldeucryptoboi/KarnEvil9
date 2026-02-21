import { describe, it, expect } from "vitest";
import { TimeoutError, withTimeout } from "./timeout.js";

describe("TimeoutError", () => {
  it("is an instance of Error", () => {
    const err = new TimeoutError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("TimeoutError");
    expect(err.message).toBe("test");
  });
});

describe("withTimeout", () => {
  it("resolves when the promise completes before the timeout", async () => {
    const result = await withTimeout(Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });

  it("rejects with TimeoutError when the promise exceeds the timeout", async () => {
    const slow = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await expect(withTimeout(slow, 50, "Slow op")).rejects.toThrow(TimeoutError);
    await expect(withTimeout(slow, 50, "Slow op")).rejects.toThrow("Slow op timed out after 50ms");
  });

  it("uses default label when none is provided", async () => {
    const slow = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await expect(withTimeout(slow, 50)).rejects.toThrow("Operation timed out after 50ms");
  });

  it("passes through rejections from the original promise", async () => {
    const failing = Promise.reject(new Error("original error"));
    await expect(withTimeout(failing, 1000)).rejects.toThrow("original error");
  });

  it("returns the promise directly when ms <= 0", async () => {
    const p = Promise.resolve("fast");
    const result = await withTimeout(p, 0);
    expect(result).toBe("fast");
  });

  it("cleans up the timer after resolution", async () => {
    const result = await withTimeout(Promise.resolve("done"), 5000);
    expect(result).toBe("done");
    // No lingering timer — if unref/cleanup failed this test would hang
  });
});

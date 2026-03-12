import { describe, it, expect, afterEach } from "vitest";
import { StealthDriver } from "./stealth.js";

describe("StealthDriver (smoke)", () => {
  let driver: StealthDriver | undefined;

  afterEach(async () => {
    if (driver) {
      await driver.close();
      driver = undefined;
    }
  });

  it("falls back to ManagedDriver when playwright-extra is unavailable", async () => {
    driver = new StealthDriver({ headless: true });
    // playwright-extra is not installed in test env → getPage() catches
    // the import error and falls back to super.getPage() using regular playwright
    const result = await driver.execute({ action: "snapshot" }) as { success: boolean; snapshot: string };
    expect(result.success).toBe(true);
    expect(typeof result.snapshot).toBe("string");
  });
});

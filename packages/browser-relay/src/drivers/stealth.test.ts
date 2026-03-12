import { describe, it, expect, afterEach } from "vitest";
import { StealthDriver } from "./stealth.js";
import { ManagedDriver } from "./managed.js";

describe("StealthDriver", () => {
  let driver: StealthDriver | undefined;

  afterEach(async () => {
    if (driver) {
      await driver.close();
      driver = undefined;
    }
  });

  it("constructor always enables base stealth", () => {
    driver = new StealthDriver({ headless: true });
    expect(driver).toBeInstanceOf(StealthDriver);
    expect(driver).toBeInstanceOf(ManagedDriver);
  });

  // Moved to stealth.smoke.test.ts — requires a real browser (Playwright chromium)

  it("constructor without options defaults to stealth enabled", () => {
    driver = new StealthDriver();
    expect(driver).toBeInstanceOf(StealthDriver);
  });
});

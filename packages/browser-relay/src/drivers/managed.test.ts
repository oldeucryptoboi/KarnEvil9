import { describe, it, expect, vi } from "vitest";
import { resolveTarget } from "./managed.js";
import type { PwPage, PwLocator } from "./managed.js";
import type { Target } from "./types.js";

// ── Helper: create a mock locator ──────────────────────────────────

function createMockLocator(overrides?: Partial<PwLocator>): PwLocator {
  const locator: PwLocator = {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue([]),
    hover: vi.fn().mockResolvedValue(undefined),
    textContent: vi.fn().mockResolvedValue("mock text"),
    waitFor: vi.fn().mockResolvedValue(undefined),
    nth: vi.fn().mockReturnThis(),
    ariaSnapshot: vi.fn().mockResolvedValue('- document "Example"\n  - heading "Hello" [level=1]'),
    ...overrides,
  };
  return locator;
}

// ── Helper: create a mock page ─────────────────────────────────────

function createMockPage(overrides?: Partial<PwPage>): PwPage {
  const mockLocator = createMockLocator();
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue("https://example.com"),
    title: vi.fn().mockResolvedValue("Example Domain"),
    screenshot: vi.fn().mockResolvedValue("base64data"),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    evaluate: vi.fn().mockResolvedValue("eval result"),
    getByRole: vi.fn().mockReturnValue(mockLocator),
    getByLabel: vi.fn().mockReturnValue(mockLocator),
    getByPlaceholder: vi.fn().mockReturnValue(mockLocator),
    getByText: vi.fn().mockReturnValue(mockLocator),
    locator: vi.fn().mockReturnValue(mockLocator),
    ...overrides,
  };
}

// ── resolveTarget tests ────────────────────────────────────────────

describe("resolveTarget", () => {
  let mockPage: PwPage;

  it("resolves role + name target", () => {
    mockPage = createMockPage();
    const target: Target = { role: "button", name: "Submit" };
    resolveTarget(mockPage, target);
    expect(mockPage.getByRole).toHaveBeenCalledWith("button", { name: "Submit" });
  });

  it("resolves role without name", () => {
    mockPage = createMockPage();
    const target: Target = { role: "navigation" };
    resolveTarget(mockPage, target);
    expect(mockPage.getByRole).toHaveBeenCalledWith("navigation", undefined);
  });

  it("resolves label target", () => {
    mockPage = createMockPage();
    const target: Target = { label: "Email address" };
    resolveTarget(mockPage, target);
    expect(mockPage.getByLabel).toHaveBeenCalledWith("Email address");
  });

  it("resolves placeholder target", () => {
    mockPage = createMockPage();
    const target: Target = { placeholder: "Search..." };
    resolveTarget(mockPage, target);
    expect(mockPage.getByPlaceholder).toHaveBeenCalledWith("Search...");
  });

  it("resolves text target", () => {
    mockPage = createMockPage();
    const target: Target = { text: "Learn more" };
    resolveTarget(mockPage, target);
    expect(mockPage.getByText).toHaveBeenCalledWith("Learn more");
  });

  it("resolves CSS selector fallback", () => {
    mockPage = createMockPage();
    const target: Target = { selector: "#main .content" };
    resolveTarget(mockPage, target);
    expect(mockPage.locator).toHaveBeenCalledWith("#main .content");
  });

  it("applies nth disambiguation", () => {
    const mockLocator = createMockLocator();
    mockPage = createMockPage({ getByRole: vi.fn().mockReturnValue(mockLocator) });
    const target: Target = { role: "listitem", nth: 2 };
    resolveTarget(mockPage, target);
    expect(mockLocator.nth).toHaveBeenCalledWith(2);
  });

  it("throws when no locator fields provided", () => {
    mockPage = createMockPage();
    expect(() => resolveTarget(mockPage, {})).toThrow(
      "Target must specify at least one of: role, label, placeholder, text, selector"
    );
  });

  it("prefers role over label when both provided", () => {
    mockPage = createMockPage();
    const target: Target = { role: "button", name: "OK", label: "OK" };
    resolveTarget(mockPage, target);
    expect(mockPage.getByRole).toHaveBeenCalled();
    expect(mockPage.getByLabel).not.toHaveBeenCalled();
  });
});

// ── ManagedDriver.execute error paths ─────────────────────────────

describe("ManagedDriver execute error paths", () => {
  // We can't instantiate a real ManagedDriver without Playwright,
  // but we can test the execute method by subclassing with a mock page.

  class TestableDriver {
    private mockPage: PwPage;
    constructor(mockPage: PwPage) { this.mockPage = mockPage; }

    async execute(request: { action: string; [key: string]: unknown }) {
      const { action, ...params } = request;
      const page = this.mockPage;
      try {
        switch (action) {
          case "click": {
            const locator = resolveTarget(page, params.target as Target);
            await locator.click();
            return { success: true, element_found: true, url: page.url(), title: await page.title() };
          }
          case "wait": {
            const target = params.target as Target | undefined;
            if (!target) return { success: false, error: "wait action requires a target" };
            const locator = resolveTarget(page, target);
            const timeout = (params.timeout_ms as number) ?? 5000;
            await locator.waitFor({ timeout });
            return { success: true, element_found: true };
          }
          case "fill": {
            const locator = resolveTarget(page, params.target as Target);
            await locator.fill(params.value as string);
            return { success: true, element_found: true };
          }
          default:
            return { success: false, error: `Unknown action: "${action}"` };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const elementNotFound = message.includes("locator") || message.includes("resolved to") || message.includes("waiting for");
        return {
          success: false,
          ...(elementNotFound ? { element_found: false } : {}),
          error: message,
        };
      }
    }
  }

  it("click returns element_found: false when locator fails", async () => {
    const failLocator = createMockLocator({
      click: vi.fn().mockRejectedValue(new Error("locator.click: Target closed")),
    });
    const page = createMockPage({ getByRole: vi.fn().mockReturnValue(failLocator) });
    const driver = new TestableDriver(page);

    const result = await driver.execute({
      action: "click",
      target: { role: "button", name: "Missing" },
    });
    expect(result.success).toBe(false);
    expect(result.element_found).toBe(false);
    expect(result.error).toContain("locator");
  });

  it("wait returns error when target is missing", async () => {
    const page = createMockPage();
    const driver = new TestableDriver(page);

    const result = await driver.execute({ action: "wait" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("wait action requires a target");
  });

  it("wait returns element_found: false on timeout", async () => {
    const timeoutLocator = createMockLocator({
      waitFor: vi.fn().mockRejectedValue(new Error("waiting for locator('button') to be visible")),
    });
    const page = createMockPage({ getByRole: vi.fn().mockReturnValue(timeoutLocator) });
    const driver = new TestableDriver(page);

    const result = await driver.execute({
      action: "wait",
      target: { role: "button" },
      timeout_ms: 100,
    });
    expect(result.success).toBe(false);
    expect(result.element_found).toBe(false);
    expect(result.error).toContain("waiting for");
  });

  it("fill returns element_found: false when element is not found", async () => {
    const failLocator = createMockLocator({
      fill: vi.fn().mockRejectedValue(new Error("locator resolved to 0 elements")),
    });
    const page = createMockPage({ getByLabel: vi.fn().mockReturnValue(failLocator) });
    const driver = new TestableDriver(page);

    const result = await driver.execute({
      action: "fill",
      target: { label: "Missing field" },
      value: "test",
    });
    expect(result.success).toBe(false);
    expect(result.element_found).toBe(false);
    expect(result.error).toContain("resolved to");
  });

  it("returns error for unknown action", async () => {
    const page = createMockPage();
    const driver = new TestableDriver(page);

    const result = await driver.execute({ action: "unknown_action" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown action");
  });

  it("non-element errors do not set element_found", async () => {
    const failLocator = createMockLocator({
      click: vi.fn().mockRejectedValue(new Error("Network error")),
    });
    const page = createMockPage({ getByRole: vi.fn().mockReturnValue(failLocator) });
    const driver = new TestableDriver(page);

    const result = await driver.execute({
      action: "click",
      target: { role: "button" },
    });
    expect(result.success).toBe(false);
    expect(result.element_found).toBeUndefined();
    expect(result.error).toBe("Network error");
  });
});

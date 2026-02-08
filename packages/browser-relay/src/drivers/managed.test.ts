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

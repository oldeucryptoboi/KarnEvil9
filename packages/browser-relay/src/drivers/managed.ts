/**
 * ManagedDriver — Playwright-backed browser driver.
 * Refactored from browser-session.ts + executeAction() from browser.ts.
 * Playwright is loaded dynamically so the module works without it installed.
 */

import type { BrowserDriver, ActionRequest, ActionResult, Target } from "./types.js";

// ── Re-declared minimal Playwright types (avoids compile-time dependency) ────

interface PwBrowser { close(): Promise<void>; newPage(): Promise<PwPage> }
interface PwPage {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  screenshot(opts?: { fullPage?: boolean; encoding?: string }): Promise<string | Buffer>;
  keyboard: { press(key: string): Promise<void> };
  evaluate<R>(fn: string | ((...args: unknown[]) => R)): Promise<R>;
  getByRole(role: string, opts?: { name?: string }): PwLocator;
  getByLabel(text: string): PwLocator;
  getByPlaceholder(text: string): PwLocator;
  getByText(text: string): PwLocator;
  locator(selector: string): PwLocator;
}
interface PwLocator {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  selectOption(value: string): Promise<string[]>;
  hover(): Promise<void>;
  textContent(): Promise<string | null>;
  waitFor(opts?: { timeout?: number }): Promise<void>;
  nth(index: number): PwLocator;
  ariaSnapshot(): Promise<string>;
}

export type { Target };

export interface ManagedDriverOptions {
  headless?: boolean;
  idleTimeoutMs?: number;
  snapshotMaxChars?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_SNAPSHOT_MAX_CHARS = 8000;

export class ManagedDriver implements BrowserDriver {
  private browser: PwBrowser | null = null;
  private page: PwPage | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly headless: boolean;
  private readonly idleTimeoutMs: number;
  private readonly snapshotMaxChars: number;

  constructor(options?: ManagedDriverOptions) {
    this.headless = options?.headless ?? true;
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.snapshotMaxChars = options?.snapshotMaxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS;
  }

  isActive(): boolean {
    return this.browser !== null;
  }

  async execute(request: ActionRequest): Promise<ActionResult> {
    const { action, ...params } = request;
    const page = await this.getPage();

    try {
      switch (action) {
        case "navigate": {
          await page.goto(params.url as string, { waitUntil: "domcontentloaded" });
          const title = await page.title();
          return { success: true, url: page.url(), title };
        }

        case "snapshot": {
          const snapshot = await this.getSnapshot(page);
          return { success: true, url: page.url(), title: await page.title(), snapshot };
        }

        case "click": {
          const locator = resolveTarget(page, params.target as Target);
          await locator.click();
          return { success: true, element_found: true, url: page.url(), title: await page.title() };
        }

        case "fill": {
          const locator = resolveTarget(page, params.target as Target);
          await locator.fill(params.value as string);
          return { success: true, element_found: true };
        }

        case "select": {
          const locator = resolveTarget(page, params.target as Target);
          await locator.selectOption(params.value as string);
          return { success: true, element_found: true };
        }

        case "hover": {
          const locator = resolveTarget(page, params.target as Target);
          await locator.hover();
          return { success: true, element_found: true };
        }

        case "keyboard": {
          await page.keyboard.press(params.key as string);
          return { success: true };
        }

        case "screenshot": {
          const fullPage = (params.full_page as boolean) ?? false;
          const base64 = await page.screenshot({ fullPage, encoding: "base64" }) as string;
          return { success: true, screenshot_base64: base64 };
        }

        case "get_text": {
          const target = params.target as Target | undefined;
          if (target) {
            const locator = resolveTarget(page, target);
            const text = await locator.textContent();
            return { success: true, element_found: true, text: text ?? "" };
          }
          const bodyText = await page.evaluate("document.body.innerText");
          return { success: true, text: bodyText as string };
        }

        case "evaluate": {
          const result = await page.evaluate(params.script as string);
          return { success: true, result };
        }

        case "wait": {
          const target = params.target as Target | undefined;
          if (!target) {
            return { success: false, error: "wait action requires a target" };
          }
          const locator = resolveTarget(page, target);
          const timeout = (params.timeout_ms as number) ?? 5000;
          await locator.waitFor({ timeout });
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

  async close(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.browser) {
      const b = this.browser;
      this.browser = null;
      this.page = null;
      await b.close();
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), this.idleTimeoutMs);
  }

  private async getPage(): Promise<PwPage> {
    if (this.page) {
      this.resetIdleTimer();
      return this.page;
    }
    const pw = await loadPlaywright();
    this.browser = await pw.chromium.launch({ headless: this.headless });
    this.page = await this.browser.newPage();
    this.resetIdleTimer();
    return this.page;
  }

  private async getSnapshot(page: PwPage): Promise<string> {
    const snapshot = await page.locator(":root").ariaSnapshot();
    if (!snapshot) return "(empty accessibility tree)";
    if (snapshot.length > this.snapshotMaxChars) {
      return snapshot.slice(0, this.snapshotMaxChars) + "\n... (truncated)";
    }
    return snapshot;
  }
}

// ── Shared helpers (exported for testing) ──────────────────────────

async function loadPlaywright(): Promise<{ chromium: { launch(opts?: Record<string, unknown>): Promise<PwBrowser> } }> {
  try {
    const moduleName = "playwright";
    return await import(/* webpackIgnore: true */ moduleName) as any;
  } catch {
    throw new Error(
      "Playwright is not installed. Install it with: pnpm add playwright\n" +
      "Then run: npx playwright install chromium"
    );
  }
}

export function resolveTarget(page: PwPage, target: Target): PwLocator {
  let locator: PwLocator;

  if (target.role) {
    locator = page.getByRole(target.role, target.name ? { name: target.name } : undefined);
  } else if (target.label) {
    locator = page.getByLabel(target.label);
  } else if (target.placeholder) {
    locator = page.getByPlaceholder(target.placeholder);
  } else if (target.text) {
    locator = page.getByText(target.text);
  } else if (target.selector) {
    locator = page.locator(target.selector);
  } else {
    throw new Error("Target must specify at least one of: role, label, placeholder, text, selector");
  }

  if (target.nth !== undefined) {
    locator = locator.nth(target.nth);
  }

  return locator;
}

// Exported for testing
export type { PwPage, PwLocator };

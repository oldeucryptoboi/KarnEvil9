/**
 * ManagedDriver — Playwright-backed browser driver.
 * Refactored from browser-session.ts + executeAction() from browser.ts.
 * Playwright is loaded dynamically so the module works without it installed.
 *
 * Layer 1 anti-detection: stealth launch args, realistic browser context
 * fingerprint, and navigator patches injected via addInitScript().
 */

import type { BrowserDriver, ActionRequest, ActionResult, Target } from "./types.js";

// ── Re-declared minimal Playwright types (avoids compile-time dependency) ────

export interface PwBrowser {
  close(): Promise<void>;
  newPage(): Promise<PwPage>;
  newContext(opts?: Record<string, unknown>): Promise<PwContext>;
}
export interface PwContext {
  newPage(): Promise<PwPage>;
  addInitScript(script: string): Promise<void>;
  close(): Promise<void>;
}
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
  /** Enable stealth anti-detection (launch args + fingerprint + init scripts). Default: true */
  stealth?: boolean;
  /** Use real Chrome instead of Playwright's Chromium. Passes TLS fingerprint checks. */
  channel?: "chrome" | "msedge";
  /** Directory for persistent browser profile (cookies survive across sessions). */
  userDataDir?: string;
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_SNAPSHOT_MAX_CHARS = 8000;

/** Chromium args that reduce automation fingerprinting. */
export const STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-component-extensions-with-background-pages",
  "--disable-default-apps",
  "--disable-features=Translate",
  "--disable-hang-monitor",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-sync",
  "--enable-features=NetworkService,NetworkServiceInProcess",
  "--metrics-recording-only",
  "--password-store=basic",
  "--use-mock-keychain",
  "--lang=en-US,en",
  "--use-gl=angle",
  "--use-angle=default",
];

/** Realistic browser context options for anti-fingerprinting. */
export const STEALTH_CONTEXT_OPTS: Record<string, unknown> = {
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  viewport: { width: 1920, height: 1080 },
  locale: "en-US",
  timezoneId: "America/New_York",
  extraHTTPHeaders: {
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Sec-CH-UA": '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"macOS"',
    "Upgrade-Insecure-Requests": "1",
  },
};

/**
 * Init script injected into every page to patch navigator properties that
 * reveal headless / automation mode.
 */
export const STEALTH_INIT_SCRIPT = `
// Hide navigator.webdriver on the prototype so Chromium can't override it
Object.defineProperty(Navigator.prototype, 'webdriver', {
  get: () => undefined,
  configurable: true,
});

// Realistic navigator.plugins — use native PluginArray if available
Object.defineProperty(Navigator.prototype, 'plugins', {
  get: () => {
    try {
      const arr = Object.create(PluginArray.prototype);
      const defs = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      for (let i = 0; i < defs.length; i++) {
        const p = Object.create(Plugin.prototype);
        Object.defineProperties(p, {
          name: { value: defs[i].name, enumerable: true },
          filename: { value: defs[i].filename, enumerable: true },
          description: { value: defs[i].description, enumerable: true },
          length: { value: 0 },
          item: { value: () => null },
          namedItem: { value: () => null },
        });
        arr[i] = p;
      }
      Object.defineProperty(arr, 'length', { value: defs.length });
      arr.item = (i) => arr[i] || null;
      arr.namedItem = (n) => {
        for (let i = 0; i < defs.length; i++) { if (arr[i].name === n) return arr[i]; }
        return null;
      };
      arr.refresh = () => {};
      return arr;
    } catch (_) {
      // Fallback if PluginArray/Plugin prototypes not available
      const arr = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      arr.item = (i) => arr[i] || null;
      arr.namedItem = (n) => arr.find(p => p.name === n) || null;
      arr.refresh = () => {};
      return arr;
    }
  },
});

// Realistic navigator.languages
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

// Ensure chrome.runtime exists (Chromium detection)
if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) window.chrome.runtime = {};

// Patch permissions.query to not reveal automation
const originalQuery = window.navigator.permissions.query;
window.navigator.permissions.query = (parameters) => (
  parameters.name === 'notifications' ?
    Promise.resolve({ state: Notification.permission }) :
    originalQuery(parameters)
);
`;

export class ManagedDriver implements BrowserDriver {
  protected browser: PwBrowser | null = null;
  protected context: PwContext | null = null;
  protected page: PwPage | null = null;
  protected idleTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly headless: boolean;
  protected readonly stealth: boolean;
  protected readonly channel: string | undefined;
  protected readonly userDataDir: string | undefined;
  private readonly idleTimeoutMs: number;
  private readonly snapshotMaxChars: number;

  constructor(options?: ManagedDriverOptions) {
    this.headless = options?.headless ?? true;
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.snapshotMaxChars = options?.snapshotMaxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS;
    this.stealth = options?.stealth ?? true;
    this.channel = options?.channel;
    this.userDataDir = options?.userDataDir;
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
      this.context = null;
      this.page = null;
      await b.close();
    }
  }

  // ── Protected helpers (accessible to subclasses) ───────────────────

  protected resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), this.idleTimeoutMs);
  }

  protected async getPage(): Promise<PwPage> {
    if (this.page) {
      this.resetIdleTimer();
      return this.page;
    }
    const pw = await loadPlaywright();
    const launchOpts: Record<string, unknown> = { headless: this.headless };
    if (this.stealth) {
      launchOpts.args = STEALTH_ARGS;
    }
    if (this.channel) {
      launchOpts.channel = this.channel;
    }

    // Real Chrome (channel set) doesn't need stealth patches — its native TLS
    // fingerprint and navigator properties are already genuine. Applying init
    // script overrides on real Chrome can actually trigger bot detection.
    const needsStealthPatches = this.stealth && !this.channel;

    if (this.userDataDir) {
      // Persistent context — browser + context are one object, cookies survive
      const contextOpts: Record<string, unknown> = {
        ...launchOpts,
        ...(needsStealthPatches ? STEALTH_CONTEXT_OPTS : { viewport: { width: 1920, height: 1080 }, locale: "en-US" }),
      };
      const persistentCtx = await pw.chromium.launchPersistentContext(this.userDataDir, contextOpts);
      this.browser = persistentCtx as unknown as PwBrowser;
      this.context = persistentCtx as unknown as PwContext;
      if (needsStealthPatches) {
        await (persistentCtx as unknown as PwContext).addInitScript(STEALTH_INIT_SCRIPT);
      }
      this.page = await (persistentCtx as unknown as PwContext).newPage();
    } else {
      this.browser = await pw.chromium.launch(launchOpts);

      if (this.stealth) {
        const ctx = await this.browser.newContext(STEALTH_CONTEXT_OPTS);
        await ctx.addInitScript(STEALTH_INIT_SCRIPT);
        this.context = ctx;
        this.page = await ctx.newPage();
      } else {
        this.page = await this.browser.newPage();
      }
    }

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

export async function loadPlaywright(): Promise<{ chromium: { launch(opts?: Record<string, unknown>): Promise<PwBrowser>; launchPersistentContext(userDataDir: string, opts?: Record<string, unknown>): Promise<PwContext & PwBrowser> } }> {
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

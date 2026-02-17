/**
 * StealthDriver — Layer 3 anti-detection using playwright-extra + stealth plugin.
 *
 * Extends ManagedDriver and overrides getPage() to launch Chromium via
 * playwright-extra with puppeteer-extra-plugin-stealth, which patches WebGL,
 * canvas, codec fingerprints, and many other detection vectors beyond what the
 * basic init-script approach in ManagedDriver covers.
 *
 * If playwright-extra is not installed, falls back to ManagedDriver's built-in
 * stealth (Layer 1).
 */

import {
  ManagedDriver,
  STEALTH_ARGS,
  STEALTH_CONTEXT_OPTS,
  STEALTH_INIT_SCRIPT,
  type ManagedDriverOptions,
  type PwPage,
  type PwBrowser,
} from "./managed.js";

export class StealthDriver extends ManagedDriver {
  constructor(options?: ManagedDriverOptions) {
    // Always enable base stealth — the init script still helps even with playwright-extra
    super({ ...options, stealth: true });
  }

  protected override async getPage(): Promise<PwPage> {
    if (this.page) {
      this.resetIdleTimer();
      return this.page;
    }

    let browser: PwBrowser;

    try {
      // Attempt to load playwright-extra + stealth plugin
      const pwExtra = await import(/* webpackIgnore: true */ "playwright-extra");
      const chromium = pwExtra.chromium;
      const stealthMod = await import(/* webpackIgnore: true */ "puppeteer-extra-plugin-stealth");
      const StealthPlugin = stealthMod.default ?? stealthMod;
      chromium.use(StealthPlugin());

      browser = await (chromium as any).launch({
        headless: this.headless,
        args: STEALTH_ARGS,
      }) as PwBrowser;
    } catch {
      // playwright-extra not installed — fall back to base ManagedDriver stealth
      return super.getPage();
    }

    this.browser = browser;

    // Create context with realistic fingerprint + init scripts
    const ctx = await browser.newContext(STEALTH_CONTEXT_OPTS);
    await ctx.addInitScript(STEALTH_INIT_SCRIPT);
    this.context = ctx;
    this.page = await ctx.newPage();

    this.resetIdleTimer();
    return this.page;
  }
}

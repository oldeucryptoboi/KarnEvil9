import type { PluginLogger } from "@karnevil9/schemas";

export class PluginLoggerImpl implements PluginLogger {
  private prefix: string;

  constructor(pluginId: string) {
    // Sanitize plugin ID to prevent log injection via newlines/control chars
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitization of control chars
    const safeId = pluginId.replace(/[\x00-\x1f\x7f]/g, "_").slice(0, 128);
    this.prefix = `[plugin:${safeId}]`;
  }

  info(message: string, data?: Record<string, unknown>): void {
    console.log(`${this.prefix} ${message}`, data !== undefined ? data : "");
  }

  warn(message: string, data?: Record<string, unknown>): void {
    console.warn(`${this.prefix} ${message}`, data !== undefined ? data : "");
  }

  error(message: string, data?: Record<string, unknown>): void {
    console.error(`${this.prefix} ${message}`, data !== undefined ? data : "");
  }

  debug(message: string, data?: Record<string, unknown>): void {
    console.debug(`${this.prefix} ${message}`, data !== undefined ? data : "");
  }
}

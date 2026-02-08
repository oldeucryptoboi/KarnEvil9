import type { PluginLogger } from "@openvger/schemas";

export class PluginLoggerImpl implements PluginLogger {
  private prefix: string;

  constructor(pluginId: string) {
    this.prefix = `[plugin:${pluginId}]`;
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

export { RelayServer, type RelayServerConfig } from "./server.js";
export { ManagedDriver, type ManagedDriverOptions } from "./drivers/managed.js";
export { ExtensionDriver, type ExtensionDriverOptions } from "./drivers/extension.js";
export type { BrowserDriver, ActionRequest, ActionResult, Target } from "./drivers/types.js";

// Standalone startup when run directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  const { ManagedDriver: Driver } = await import("./drivers/managed.js");
  const { RelayServer: Server } = await import("./server.js");
  const port = parseInt(process.env.OPENVGER_RELAY_PORT ?? "9222", 10);
  const server = new Server({ port, driver: new Driver() });
  await server.listen();
}

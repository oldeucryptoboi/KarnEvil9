import express from "express";
import type { BrowserDriver } from "./drivers/types.js";

export interface RelayServerConfig {
  port?: number;
  driver: BrowserDriver;
  driverName?: string;  // "managed" | "extension" — shown in /health
}

export class RelayServer {
  private readonly port: number;
  private readonly driver: BrowserDriver;
  private readonly driverName: string;
  private readonly app: express.Application;
  private server: ReturnType<typeof this.app.listen> | null = null;
  private readonly startTime = Date.now();

  constructor(config: RelayServerConfig) {
    this.port = config.port ?? 9222;
    this.driver = config.driver;
    this.driverName = config.driverName ?? "managed";
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json({ limit: "256kb" }));

    this.app.get("/health", (_req, res) => {
      res.json({
        status: "ok",
        driver: this.driverName,
        browser_active: this.driver.isActive(),
        uptime_ms: Date.now() - this.startTime,
      });
    });

    this.app.post("/actions", async (req, res) => {
      const body = req.body;
      if (!body || typeof body !== "object" || typeof body.action !== "string") {
        res.status(400).json({ success: false, error: 'Request body must be JSON with a string "action" field' });
        return;
      }
      try {
        const result = await this.driver.execute(body);
        const status = result.success ? 200 : 422;
        res.status(status).json(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ success: false, error: message });
      }
    });

    this.app.post("/close", async (_req, res) => {
      try {
        await this.driver.close();
        res.json({ closed: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ closed: false, error: message });
      }
    });
  }

  async listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`Browser relay server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async shutdown(): Promise<void> {
    await this.driver.close();
    if (this.server) {
      return new Promise((resolve, reject) => {
        this.server!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  getExpressApp(): express.Application {
    return this.app;
  }
}

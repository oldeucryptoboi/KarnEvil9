import { defineConfig } from "@playwright/test";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "../..");

export default defineConfig({
  testDir: "./specs",
  globalSetup: require.resolve("./global-setup"),
  globalTeardown: require.resolve("./global-teardown"),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : 3,
  reporter: [["html", { open: "never" }]],
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:3099",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npx tsx tests/e2e-playwright/start-api-server.ts",
      cwd: ROOT,
      port: 3199,
      timeout: 30_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npx next dev -p 3099",
      cwd: join(ROOT, "packages/dashboard"),
      port: 3099,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});

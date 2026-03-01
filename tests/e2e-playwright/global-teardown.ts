/**
 * Playwright global teardown: removes the .env.development.local file
 * written by global-setup so it doesn't affect normal dev workflow.
 */
import { unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

export default function globalTeardown() {
  const dashboardDir = resolve(__dirname, "../../packages/dashboard");
  const envFile = join(dashboardDir, ".env.development.local");
  try {
    unlinkSync(envFile);
    console.log(`[pw-teardown] Removed ${envFile}`);
  } catch {
    // File may not exist if setup failed
  }
}

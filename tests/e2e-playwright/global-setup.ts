/**
 * Playwright global setup: writes a .env.development.local in the dashboard
 * directory so that NEXT_PUBLIC_API_URL points to the test API server (port 3199).
 * .env.development.local takes precedence over .env.local for `next dev`.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export default function globalSetup() {
  const dashboardDir = resolve(__dirname, "../../packages/dashboard");
  const envFile = join(dashboardDir, ".env.development.local");
  writeFileSync(envFile, "NEXT_PUBLIC_API_URL=http://localhost:3199\n");
  console.log(`[pw-setup] Wrote ${envFile}`);
}

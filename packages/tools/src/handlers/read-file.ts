import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolHandler } from "../tool-runtime.js";
import type { ExecutionMode, PolicyProfile } from "@karnevil9/schemas";
import { assertPathAllowed, assertPathAllowedReal, assertNotSensitiveFile } from "../policy-enforcer.js";

export const readFileHandler: ToolHandler = async (
  input: Record<string, unknown>, mode: ExecutionMode, policy: PolicyProfile
): Promise<unknown> => {
  if (typeof input.path !== "string") {
    throw new Error("input.path must be a string");
  }
  const path = input.path;
  const fullPath = resolve(process.cwd(), path);
  // Quick check first (sync) — catches obvious violations cheaply
  assertPathAllowed(fullPath, policy.allowed_paths);
  assertNotSensitiveFile(fullPath);
  if (mode === "dry_run") {
    return { content: `[dry_run] Would read file: ${fullPath}`, exists: existsSync(fullPath), size_bytes: 0 };
  }
  if (!existsSync(fullPath)) return { content: "", exists: false, size_bytes: 0 };
  // Resolve symlinks BEFORE any I/O to close TOCTOU window
  await assertPathAllowedReal(fullPath, policy.allowed_paths);
  assertNotSensitiveFile(await import("node:fs/promises").then(fs => fs.realpath(fullPath)));
  // Size cap: reject files larger than 10 MB to prevent memory exhaustion
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const stats = await stat(fullPath);
  if (stats.size > MAX_FILE_SIZE) {
    throw new Error(`File "${fullPath}" is ${stats.size} bytes, exceeding the ${MAX_FILE_SIZE} byte limit`);
  }
  const content = await readFile(fullPath, "utf-8");
  return { content, exists: true, size_bytes: stats.size };
};

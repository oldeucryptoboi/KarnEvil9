import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolHandler } from "../tool-runtime.js";
import type { ExecutionMode, PolicyProfile } from "@openvger/schemas";
import { assertPathAllowed, assertPathAllowedReal } from "../policy-enforcer.js";

export const readFileHandler: ToolHandler = async (
  input: Record<string, unknown>, mode: ExecutionMode, policy: PolicyProfile
): Promise<unknown> => {
  if (typeof input.path !== "string") {
    throw new Error("input.path must be a string");
  }
  const path = input.path;
  const fullPath = resolve(process.cwd(), path);
  // Quick check first (sync), then symlink-safe check before actual read
  assertPathAllowed(fullPath, policy.allowed_paths);
  if (mode === "dry_run") {
    return { content: `[dry_run] Would read file: ${fullPath}`, exists: existsSync(fullPath), size_bytes: 0 };
  }
  if (!existsSync(fullPath)) return { content: "", exists: false, size_bytes: 0 };
  // Resolve symlinks before reading to prevent traversal attacks
  await assertPathAllowedReal(fullPath, policy.allowed_paths);
  const content = await readFile(fullPath, "utf-8");
  const stats = await stat(fullPath);
  return { content, exists: true, size_bytes: stats.size };
};

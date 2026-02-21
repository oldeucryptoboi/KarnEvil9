import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { ToolHandler } from "../tool-runtime.js";
import type { ExecutionMode, PolicyProfile } from "@karnevil9/schemas";
import { assertPathAllowed, assertPathAllowedReal, assertNotSensitiveFile, PolicyViolationError } from "../policy-enforcer.js";

export const writeFileHandler: ToolHandler = async (
  input: Record<string, unknown>, mode: ExecutionMode, policy: PolicyProfile
): Promise<unknown> => {
  if (typeof input.path !== "string") {
    throw new Error("input.path must be a string");
  }
  if (typeof input.content !== "string") {
    throw new Error("input.content must be a string");
  }
  const path = input.path;
  const content = input.content;

  // Enforce write size limit (10 MB) to prevent disk exhaustion
  const MAX_WRITE_SIZE = 10 * 1024 * 1024;
  const contentBytes = Buffer.byteLength(content, "utf-8");
  if (contentBytes > MAX_WRITE_SIZE) {
    throw new Error(`Content is ${contentBytes} bytes, exceeding the ${MAX_WRITE_SIZE} byte write limit`);
  }

  const fullPath = resolve(process.cwd(), path);
  assertPathAllowed(fullPath, policy.allowed_paths);
  assertNotSensitiveFile(fullPath);

  // Enforce writable_paths constraint: writes only allowed within writable_paths
  if (policy.writable_paths && policy.writable_paths.length > 0) {
    assertPathAllowed(fullPath, policy.writable_paths);
  }

  // Enforce readonly_paths constraint: deny writes to readonly paths
  if (policy.readonly_paths) {
    const resolved = resolve(fullPath);
    for (const rp of policy.readonly_paths) {
      const resolvedReadonly = resolve(rp);
      if (resolved === resolvedReadonly || resolved.startsWith(resolvedReadonly + "/")) {
        throw new PolicyViolationError(
          `Path "${resolved}" is within readonly_paths and cannot be written to`
        );
      }
    }
  }

  if (mode === "dry_run") {
    return { written: false, bytes_written: Buffer.byteLength(content, "utf-8") };
  }
  await mkdir(dirname(fullPath), { recursive: true });
  // Resolve symlinks AFTER mkdir but BEFORE write to close TOCTOU window.
  // assertPathAllowedReal resolves both the target AND allowed_paths through
  // symlinks, so it handles macOS /var → /private/var correctly.
  await assertPathAllowedReal(fullPath, policy.allowed_paths);
  await writeFile(fullPath, content, "utf-8");
  return { written: true, bytes_written: Buffer.byteLength(content, "utf-8") };
};

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { ToolHandler } from "../tool-runtime.js";
import type { ExecutionMode, PolicyProfile } from "@openvger/schemas";
import { assertPathAllowed, assertPathAllowedReal, PolicyViolationError } from "../policy-enforcer.js";

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
  const fullPath = resolve(process.cwd(), path);
  assertPathAllowed(fullPath, policy.allowed_paths);

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
  // Resolve symlinks before writing to prevent traversal attacks
  await assertPathAllowedReal(fullPath, policy.allowed_paths);
  await writeFile(fullPath, content, "utf-8");
  return { written: true, bytes_written: Buffer.byteLength(content, "utf-8") };
};

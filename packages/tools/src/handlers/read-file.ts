import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolHandler } from "../tool-runtime.js";
import type { ExecutionMode } from "@openflaw/schemas";

export const readFileHandler: ToolHandler = async (
  input: Record<string, unknown>, mode: ExecutionMode
): Promise<unknown> => {
  const path = input.path as string;
  const fullPath = resolve(process.cwd(), path);
  if (mode === "dry_run") {
    return { content: `[dry_run] Would read file: ${fullPath}`, exists: existsSync(fullPath), size_bytes: 0 };
  }
  if (!existsSync(fullPath)) return { content: "", exists: false, size_bytes: 0 };
  const content = await readFile(fullPath, "utf-8");
  const stats = await stat(fullPath);
  return { content, exists: true, size_bytes: stats.size };
};

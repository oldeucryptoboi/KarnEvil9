import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { ToolHandler } from "../tool-runtime.js";
import type { ExecutionMode } from "@openflaw/schemas";

export const writeFileHandler: ToolHandler = async (
  input: Record<string, unknown>, mode: ExecutionMode
): Promise<unknown> => {
  const path = input.path as string;
  const content = input.content as string;
  const fullPath = resolve(process.cwd(), path);
  if (mode === "dry_run") {
    return { written: false, bytes_written: Buffer.byteLength(content, "utf-8") };
  }
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
  return { written: true, bytes_written: Buffer.byteLength(content, "utf-8") };
};

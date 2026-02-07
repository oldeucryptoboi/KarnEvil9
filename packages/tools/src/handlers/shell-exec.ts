import { exec } from "node:child_process";
import { resolve } from "node:path";
import type { ToolHandler } from "../tool-runtime.js";
import type { ExecutionMode } from "@openflaw/schemas";

export const shellExecHandler: ToolHandler = async (
  input: Record<string, unknown>, mode: ExecutionMode
): Promise<unknown> => {
  const command = input.command as string;
  const cwd = input.cwd ? resolve(process.cwd(), input.cwd as string) : process.cwd();
  if (mode === "dry_run") {
    return { exit_code: 0, stdout: `[dry_run] Would execute: ${command}`, stderr: "" };
  }
  return new Promise((resolvePromise) => {
    exec(command, { cwd, timeout: 60000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolvePromise({ exit_code: error?.code ?? 0, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
};

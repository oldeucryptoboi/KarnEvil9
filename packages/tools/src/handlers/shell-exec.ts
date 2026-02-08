import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { ToolHandler } from "../tool-runtime.js";
import type { ExecutionMode, PolicyProfile } from "@jarvis/schemas";
import { assertCommandAllowed, assertPathAllowed } from "../policy-enforcer.js";

const SENSITIVE_ENV_PREFIXES = ["AWS_", "AZURE_", "GCP_", "GOOGLE_", "OPENAI_", "ANTHROPIC_", "GITHUB_", "GITLAB_", "NPM_TOKEN", "DOCKER_", "JARVIS_"];
const SENSITIVE_ENV_KEYS = new Set(["TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "API_KEY", "PRIVATE_KEY", "DATABASE_URL"]);

function sanitizeEnv(): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (SENSITIVE_ENV_PREFIXES.some((p) => upper.startsWith(p))) continue;
    if (SENSITIVE_ENV_KEYS.has(upper)) continue;
    if (upper.endsWith("_SECRET") || upper.endsWith("_TOKEN") || upper.endsWith("_KEY") || upper.endsWith("_PASSWORD")) continue;
    clean[key] = value;
  }
  return clean;
}

/**
 * Parse a command string into binary + arguments, handling basic quoting.
 * Supports double quotes and single quotes for arguments with spaces.
 */
function parseCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (c === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (c === " " && !inDouble && !inSingle) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
    } else {
      current += c;
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}

export const shellExecHandler: ToolHandler = async (
  input: Record<string, unknown>, mode: ExecutionMode, policy: PolicyProfile
): Promise<unknown> => {
  if (typeof input.command !== "string") {
    throw new Error("input.command must be a string");
  }
  const command = input.command;
  const cwd = input.cwd ? resolve(process.cwd(), String(input.cwd)) : process.cwd();
  assertCommandAllowed(command, policy.allowed_commands);
  assertPathAllowed(cwd, policy.allowed_paths);
  if (mode === "dry_run") {
    return { exit_code: 0, stdout: `[dry_run] Would execute: ${command}`, stderr: "" };
  }
  const MAX_SHELL_TIMEOUT = 300000; // 5 minutes
  const DEFAULT_SHELL_TIMEOUT = 60000;
  const rawTimeout = typeof input.timeout_ms === "number" ? input.timeout_ms : DEFAULT_SHELL_TIMEOUT;
  const shellTimeout = Math.max(1000, Math.min(rawTimeout, MAX_SHELL_TIMEOUT));
  const args = parseCommand(command.trim());
  const binary = args.shift()!;
  return new Promise((resolvePromise) => {
    execFile(binary, args, { env: sanitizeEnv(), cwd, timeout: shellTimeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      let exitCode: number;
      if (!error) {
        exitCode = 0;
      } else if (typeof error.code === "number") {
        exitCode = error.code;
      } else {
        // Spawn failure (ENOENT, EACCES) or signal kill — report as non-zero
        exitCode = 1;
      }
      const stderrStr = stderr.toString();
      const errorDetail = error && typeof error.code === "string"
        ? `${stderrStr}${stderrStr ? "\n" : ""}${error.code}: ${error.message}`
        : stderrStr;
      resolvePromise({ exit_code: exitCode, stdout: stdout.toString(), stderr: errorDetail });
    });
  });
};

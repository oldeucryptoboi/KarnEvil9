import type { ToolHandler } from "../tool-runtime.js";
import type { ExecutionMode } from "@openflaw/schemas";

export const httpRequestHandler: ToolHandler = async (
  input: Record<string, unknown>, mode: ExecutionMode
): Promise<unknown> => {
  const url = input.url as string;
  const method = input.method as string;
  const headers = (input.headers ?? {}) as Record<string, string>;
  const body = input.body as string | undefined;
  if (mode === "dry_run") {
    return { status: 0, body: `[dry_run] Would ${method} ${url}`, headers: {} };
  }
  const fetchOpts: RequestInit = { method, headers };
  if (body && method !== "GET") fetchOpts.body = body;
  const response = await fetch(url, fetchOpts);
  const responseBody = await response.text();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => { responseHeaders[key] = value; });
  return { status: response.status, body: responseBody, headers: responseHeaders };
};

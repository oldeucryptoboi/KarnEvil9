import type { ToolHandler } from "../tool-runtime.js";
import type { ExecutionMode, PolicyProfile } from "@openvger/schemas";
import { assertEndpointAllowed } from "../policy-enforcer.js";

export const httpRequestHandler: ToolHandler = async (
  input: Record<string, unknown>, mode: ExecutionMode, policy: PolicyProfile
): Promise<unknown> => {
  if (typeof input.url !== "string") {
    throw new Error("input.url must be a string");
  }
  if (typeof input.method !== "string") {
    throw new Error("input.method must be a string");
  }
  const url = input.url;
  const method = input.method;
  const headers = (input.headers && typeof input.headers === "object" && !Array.isArray(input.headers))
    ? input.headers as Record<string, string>
    : {};
  const body = typeof input.body === "string" ? input.body : undefined;
  assertEndpointAllowed(url, policy.allowed_endpoints);
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

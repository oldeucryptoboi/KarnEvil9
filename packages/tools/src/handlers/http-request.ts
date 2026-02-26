import type { ToolHandler } from "../tool-runtime.js";
import type { ExecutionMode, PolicyProfile } from "@karnevil9/schemas";
import { assertEndpointAllowedAsync } from "../policy-enforcer.js";

const MAX_RESPONSE_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

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
  await assertEndpointAllowedAsync(url, policy.allowed_endpoints);
  if (mode === "dry_run") {
    return { status: 0, body: `[dry_run] Would ${method} ${url}`, headers: {} };
  }
  const DEFAULT_FETCH_TIMEOUT = 30000;
  const MAX_FETCH_TIMEOUT = 120000;
  const rawTimeout = typeof input.timeout_ms === "number" ? input.timeout_ms : DEFAULT_FETCH_TIMEOUT;
  const fetchTimeout = Math.max(1000, Math.min(rawTimeout, MAX_FETCH_TIMEOUT));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeout);
  const fetchOpts: RequestInit = { method, headers, signal: controller.signal, redirect: "manual" };
  if (body && method !== "GET") fetchOpts.body = body;
  let response: Response;
  try {
    response = await fetch(url, fetchOpts);
  } finally {
    clearTimeout(timer);
  }

  // Handle redirects manually to prevent SSRF via redirect to private IPs.
  // Loop to follow chained redirects (e.g. HTTP→HTTPS→domain) up to a bounded limit.
  const MAX_REDIRECTS = 5;
  for (let redirectCount = 0; redirectCount < MAX_REDIRECTS; redirectCount++) {
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) break;
    // Validate redirect target against SSRF and endpoint policy
    let redirectUrl: string;
    try {
      redirectUrl = new URL(location, url).href;
    } catch {
      return { status: response.status, body: "", headers: {}, error: `Malformed redirect URL: ${location}` };
    }
    await assertEndpointAllowedAsync(redirectUrl, policy.allowed_endpoints);
    // Fresh AbortController for each redirect hop
    const redirectController = new AbortController();
    const redirectTimer = setTimeout(() => redirectController.abort(), fetchTimeout);
    try {
      response = await fetch(redirectUrl, { ...fetchOpts, signal: redirectController.signal, redirect: "manual" });
    } finally {
      clearTimeout(redirectTimer);
    }
  }

  // Read response body with size limit to prevent OOM
  const responseBody = await readBodyWithLimit(response, MAX_RESPONSE_BODY_SIZE);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => { responseHeaders[key] = value; });
  return { status: response.status, body: responseBody, headers: responseHeaders };
};

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        reader.cancel();
        throw new Error(`Response body exceeds ${maxBytes} byte limit (received ${totalBytes}+ bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c, { stream: true })).join("") + decoder.decode();
}

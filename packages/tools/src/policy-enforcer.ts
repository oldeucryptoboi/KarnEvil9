import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { KarnEvil9Error } from "@karnevil9/schemas";

export class PolicyViolationError extends KarnEvil9Error {
  constructor(message: string) {
    super("POLICY_VIOLATION", message);
    this.name = "PolicyViolationError";
  }
}

export class SsrfError extends KarnEvil9Error {
  constructor(message: string) {
    super("POLICY_VIOLATION", message);
    this.name = "SsrfError";
  }
}

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export function isPrivateIP(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "0.0.0.0") return true;

  // IPv6 loopback and special addresses
  // Strip brackets from IPv6 [::1] notation
  const bare = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
  if (bare === "::1" || bare === "::" || bare === "0:0:0:0:0:0:0:1" || bare === "0:0:0:0:0:0:0:0") return true;
  // IPv6 mapped IPv4 loopback (::ffff:127.0.0.1)
  if (bare.startsWith("::ffff:")) {
    const mapped = bare.slice(7);
    if (isPrivateIPv4(mapped)) return true;
  }
  // IPv6 link-local (fe80::/10)
  if (bare.startsWith("fe80")) return true;
  // IPv6 fc00::/7 (unique local)
  if (bare.startsWith("fc") || bare.startsWith("fd")) return true;

  // IPv4 checks
  if (isPrivateIPv4(hostname)) return true;

  return false;
}

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p))) return false;
  const octets = parts.map(Number);
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return true;         // 127.0.0.0/8
  if (a === 10) return true;          // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16
  if (a === 169 && b === 254) return true;           // 169.254.0.0/16
  if (a === 0) return true;           // 0.0.0.0/8
  return false;
}

export function assertPathAllowed(
  targetPath: string,
  allowedPaths: string[]
): void {
  if (allowedPaths.length === 0) return;
  const resolved = resolve(targetPath);
  const allowed = allowedPaths.some((p) => {
    const resolvedAllowed = resolve(p);
    return resolved === resolvedAllowed || resolved.startsWith(resolvedAllowed + "/");
  });
  if (!allowed) {
    throw new PolicyViolationError(
      `Path "${resolved}" is outside allowed paths: ${allowedPaths.join(", ")}`
    );
  }
}

/**
 * Like assertPathAllowed but resolves symlinks first using realpath().
 * Use this for actual file operations to prevent symlink traversal attacks.
 * For non-existent paths (e.g., write targets), resolves the closest existing
 * ancestor to detect symlinks in the parent chain.
 */
export async function assertPathAllowedReal(
  targetPath: string,
  allowedPaths: string[]
): Promise<void> {
  if (allowedPaths.length === 0) return;
  const resolved = await resolveReal(targetPath);
  const allowed = await Promise.all(
    allowedPaths.map(async (p) => {
      const resolvedAllowed = await resolveReal(p);
      return resolved === resolvedAllowed || resolved.startsWith(resolvedAllowed + "/");
    })
  );
  if (!allowed.some(Boolean)) {
    throw new PolicyViolationError(
      `Path "${resolved}" is outside allowed paths (symlink-resolved): ${allowedPaths.join(", ")}`
    );
  }
}

/**
 * Resolve a path following symlinks. If the path doesn't exist,
 * resolve the closest existing ancestor and append the remaining segments.
 */
async function resolveReal(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath);
  } catch {
    // Path doesn't exist — resolve parent + basename
    const { dirname: dirnameFn, basename } = await import("node:path");
    const parent = dirnameFn(resolve(targetPath));
    const name = basename(resolve(targetPath));
    try {
      const resolvedParent = await realpath(parent);
      return resolvedParent + "/" + name;
    } catch {
      // Even parent doesn't exist — fall back to resolve()
      return resolve(targetPath);
    }
  }
}

const SENSITIVE_BASENAMES = new Set([
  ".env", "credentials.json", "service-account.json",
  "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore",
]);

const SENSITIVE_DIRS = [".ssh", ".gnupg", ".aws"];

/**
 * Defense-in-depth: blocks reads/writes to files that are very likely secrets.
 * Not configurable — this is a safety net that applies regardless of policy.
 */
export function assertNotSensitiveFile(targetPath: string): void {
  const resolved = resolve(targetPath);
  const segments = resolved.split("/");
  const basename = segments[segments.length - 1] ?? "";

  // Exact basename match
  if (SENSITIVE_BASENAMES.has(basename)) {
    throw new PolicyViolationError(
      `Access to sensitive file "${basename}" is blocked`
    );
  }

  // .env.* variants (e.g. .env.local, .env.production)
  if (/^\.env\..+$/.test(basename)) {
    throw new PolicyViolationError(
      `Access to sensitive file "${basename}" is blocked`
    );
  }

  // Extension match
  const dotIdx = basename.lastIndexOf(".");
  if (dotIdx > 0) {
    const ext = basename.slice(dotIdx);
    if (SENSITIVE_EXTENSIONS.has(ext)) {
      throw new PolicyViolationError(
        `Access to sensitive file "${basename}" is blocked (extension ${ext})`
      );
    }
  }

  // Directory pattern match
  for (const dir of SENSITIVE_DIRS) {
    if (segments.includes(dir)) {
      throw new PolicyViolationError(
        `Access to files under "${dir}/" is blocked`
      );
    }
  }
}

export function assertCommandAllowed(
  command: string,
  allowedCommands: string[]
): void {
  if (allowedCommands.length === 0) return;
  const binary = command.trim().split(/\s+/)[0]!;
  if (!allowedCommands.includes(binary)) {
    throw new PolicyViolationError(
      `Command "${binary}" is not in allowed commands: ${allowedCommands.join(", ")}`
    );
  }
}

export function assertEndpointAllowed(
  url: string,
  allowedEndpoints: string[]
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PolicyViolationError(`Invalid URL: "${url}"`);
  }

  // SSRF validation — always applied regardless of allowlist
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new SsrfError(`Protocol "${parsed.protocol}" is not allowed. Only http: and https: are permitted.`);
  }

  if (isPrivateIP(parsed.hostname)) {
    throw new SsrfError(`Requests to private/reserved IP "${parsed.hostname}" are blocked.`);
  }

  const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80);
  if (!ALLOWED_PORTS.has(port)) {
    throw new SsrfError(`Port ${port} is not allowed. Only ports 80, 443, 8080, 8443 are permitted.`);
  }

  // Allowlist check
  if (allowedEndpoints.length === 0) return;
  const hostname = parsed.hostname;
  const allowed = allowedEndpoints.some((ep) => {
    try {
      return new URL(ep).hostname === hostname;
    } catch {
      return ep === hostname;
    }
  });
  if (!allowed) {
    throw new PolicyViolationError(
      `Endpoint "${hostname}" is not in allowed endpoints: ${allowedEndpoints.join(", ")}`
    );
  }
}

/**
 * Async version of assertEndpointAllowed that resolves DNS to prevent
 * DNS rebinding attacks. A hostname like "evil.com" could resolve to
 * 127.0.0.1 — this function catches that by resolving and re-checking.
 */
export async function assertEndpointAllowedAsync(
  url: string,
  allowedEndpoints: string[]
): Promise<void> {
  // First, run all synchronous checks
  assertEndpointAllowed(url, allowedEndpoints);

  // Then resolve DNS and check the resolved IP
  const parsed = new URL(url);
  const hostname = parsed.hostname;

  // Skip DNS resolution for IP literals (already checked by sync version)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
    return;
  }

  try {
    const result = await lookup(hostname, { all: true });
    for (const entry of result) {
      if (isPrivateIP(entry.address)) {
        throw new SsrfError(
          `DNS rebinding detected: "${hostname}" resolves to private IP ${entry.address}`
        );
      }
    }
  } catch (err) {
    if (err instanceof SsrfError) throw err;
    // DNS resolution failure — block the request to be safe
    throw new SsrfError(
      `DNS resolution failed for "${hostname}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

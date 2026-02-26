import type { ToolHandler } from "../tool-runtime.js";
import type { ExecutionMode, PolicyProfile } from "@karnevil9/schemas";
import { assertEndpointAllowedAsync } from "../policy-enforcer.js";

interface Target {
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  selector?: string;
  nth?: number;
}

/** Minimal interface a browser driver must satisfy. */
export interface BrowserDriverLike {
  execute(request: { action: string; [key: string]: unknown }): Promise<{ success: boolean; [key: string]: unknown }>;
}

const RELAY_URL = (() => {
  const url = process.env.OPENVGER_RELAY_URL ?? "http://localhost:9222";
  // Validate relay URL at module load to prevent SSRF via env var injection
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      console.warn(`[browser] WARNING: OPENVGER_RELAY_URL uses non-HTTP protocol "${parsed.protocol}" — falling back to default`);
      return "http://localhost:9222";
    }
  } catch {
    console.warn(`[browser] WARNING: Invalid OPENVGER_RELAY_URL "${url}" — falling back to default`);
    return "http://localhost:9222";
  }
  return url;
})();

const MOCK_RESPONSE = {
  success: true,
  url: "https://example.com",
  title: "Example Domain",
  snapshot: 'document [role=document]\n  heading "Example Domain" [role=heading, level=1]\n  paragraph [role=paragraph]\n    text "This domain is for use in examples."',
};

const VALID_ACTIONS = new Set([
  "navigate", "snapshot", "click", "fill", "select",
  "hover", "keyboard", "screenshot", "get_text", "evaluate", "wait",
]);

/**
 * Factory that creates a browser tool handler.
 * When `driver` is provided, requests are sent directly to the in-process driver.
 * Otherwise, requests are forwarded via HTTP to the relay server.
 */
export function createBrowserHandler(driver?: BrowserDriverLike): ToolHandler {
  return async (
    input: Record<string, unknown>,
    mode: ExecutionMode,
    policy: PolicyProfile,
  ): Promise<unknown> => {
    if (typeof input.action !== "string") {
      return { success: false, error: "input.action must be a string" };
    }
    const action = input.action;

    if (!VALID_ACTIONS.has(action)) {
      return { success: false, error: `Unknown action: "${action}". Valid actions: ${[...VALID_ACTIONS].join(", ")}` };
    }

    if (mode === "mock") {
      return MOCK_RESPONSE;
    }

    if (mode === "dry_run") {
      return dryRun(action, input);
    }

    // Real mode — enforce policy for navigate and evaluate
    if (action === "navigate") {
      if (typeof input.url !== "string") {
        return { success: false, error: "input.url must be a string for navigate action" };
      }
      await assertEndpointAllowedAsync(input.url, policy.allowed_endpoints);
    }

    // Evaluate executes arbitrary JS — require explicit opt-in via allowed_commands
    if (action === "evaluate") {
      if (!policy.allowed_commands.includes("browser_evaluate")) {
        return { success: false, error: 'browser "evaluate" action requires "browser_evaluate" in allowed_commands' };
      }
    }

    // Direct: use in-process driver
    if (driver) {
      return driver.execute(input as { action: string; [key: string]: unknown });
    }

    // Fallback: forward to relay server
    const response = await fetch(`${RELAY_URL}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    // 5xx = server error (may be non-JSON proxy page); 4xx = tool-level error with JSON body
    if (response.status >= 500) {
      const text = typeof response.text === "function"
        ? await response.text().catch(() => "")
        : "";
      throw new Error(`Browser relay server error: ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(`Browser relay returned non-JSON response (status ${response.status})`);
    }
    return body;
  };
}

/** Backward-compatible default handler (uses HTTP relay). */
export const browserHandler: ToolHandler = createBrowserHandler();

function dryRun(action: string, input: Record<string, unknown>): unknown {
  const target = input.target as Target | undefined;
  const targetDesc = target ? describeTarget(target) : "";

  switch (action) {
    case "navigate":
      return { success: true, url: `[dry_run] Would navigate to ${input.url}` };
    case "snapshot":
      return { success: true, snapshot: "[dry_run] Would capture accessibility tree" };
    case "click":
      return { success: true, url: `[dry_run] Would click ${targetDesc}` };
    case "fill":
      return { success: true, url: `[dry_run] Would fill ${targetDesc} with "${input.value}"` };
    case "select":
      return { success: true, url: `[dry_run] Would select "${input.value}" on ${targetDesc}` };
    case "hover":
      return { success: true, url: `[dry_run] Would hover ${targetDesc}` };
    case "keyboard":
      return { success: true, url: `[dry_run] Would press key "${input.key}"` };
    case "screenshot":
      return { success: true, url: "[dry_run] Would take screenshot" };
    case "get_text":
      return { success: true, text: `[dry_run] Would get text from ${targetDesc || "page"}` };
    case "evaluate":
      return { success: true, url: "[dry_run] Would evaluate script" };
    case "wait":
      return { success: true, url: `[dry_run] Would wait for ${targetDesc}` };
    default:
      return { success: false, error: `Unknown action: "${action}"` };
  }
}

function describeTarget(target: Target): string {
  if (target.role) return `role=${target.role}${target.name ? ` name="${target.name}"` : ""}`;
  if (target.label) return `label="${target.label}"`;
  if (target.placeholder) return `placeholder="${target.placeholder}"`;
  if (target.text) return `text="${target.text}"`;
  if (target.selector) return `selector="${target.selector}"`;
  return "(empty target)";
}

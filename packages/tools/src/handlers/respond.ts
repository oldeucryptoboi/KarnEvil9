import type { ToolHandler } from "../tool-runtime.js";

/**
 * Handler for the "respond" tool — delivers a text response to the user.
 * This is a passthrough: the planner generates the response text, and
 * this handler simply confirms delivery. The kernel/API layer reads the
 * output to present it to the user.
 */
export const respondHandler: ToolHandler = async (
  input: Record<string, unknown>,
  mode,
  _policy,
): Promise<unknown> => {
  if (typeof input.text !== "string" || input.text.trim().length === 0) {
    throw new Error("input.text must be a non-empty string");
  }

  const text = input.text.trim();

  if (mode === "dry_run") {
    return { delivered: false, text: `[dry_run] Would respond: ${text.slice(0, 100)}...` };
  }

  return { delivered: true, text };
};

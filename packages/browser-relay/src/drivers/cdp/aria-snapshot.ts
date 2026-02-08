/**
 * Build a text accessibility tree from Accessibility.getFullAXTree().
 * Output format matches Playwright's ariaSnapshot() style for consistency.
 * Truncates at maxChars (default 8000).
 */

import type { CDPClient } from "./client.js";
import type { AXNode } from "./protocol.js";

const DEFAULT_MAX_CHARS = 8000;

/** Roles that are typically not interesting for a text snapshot. */
const IGNORED_ROLES = new Set([
  "none",
  "generic",
  "InlineTextBox",
  "LineBreak",
]);

/**
 * Build a human-readable accessibility tree from CDP's Accessibility.getFullAXTree.
 */
export async function buildAriaSnapshot(
  cdp: CDPClient,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<string> {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");

  if (!nodes || nodes.length === 0) {
    return "(empty accessibility tree)";
  }

  // Build a map of nodeId → AXNode for tree reconstruction
  const nodeMap = new Map<string, AXNode>();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  // Find root node (first non-ignored node, usually "RootWebArea" or "document")
  const root = nodes[0]!;

  const lines: string[] = [];
  renderNode(root, nodeMap, 0, lines, maxChars);

  const snapshot = lines.join("\n");
  if (snapshot.length === 0) {
    return "(empty accessibility tree)";
  }
  if (snapshot.length > maxChars) {
    return snapshot.slice(0, maxChars) + "\n... (truncated)";
  }
  return snapshot;
}

function renderNode(
  node: AXNode,
  nodeMap: Map<string, AXNode>,
  depth: number,
  lines: string[],
  maxChars: number,
): void {
  // Bail early if already too long
  if (totalLength(lines) >= maxChars) return;

  if (node.ignored) {
    // Still render children of ignored nodes
    renderChildren(node, nodeMap, depth, lines, maxChars);
    return;
  }

  const role = node.role?.value ?? "";
  const name = node.name?.value ?? "";

  if (IGNORED_ROLES.has(role)) {
    renderChildren(node, nodeMap, depth, lines, maxChars);
    return;
  }

  // Build the line
  const indent = "  ".repeat(depth);
  const props = formatProperties(node);
  let line: string;

  if (name) {
    line = `${indent}- ${role} ${JSON.stringify(name)}${props}`;
  } else {
    line = `${indent}- ${role}${props}`;
  }

  lines.push(line);

  // Render children
  renderChildren(node, nodeMap, depth + 1, lines, maxChars);
}

function renderChildren(
  node: AXNode,
  nodeMap: Map<string, AXNode>,
  depth: number,
  lines: string[],
  maxChars: number,
): void {
  // Try inline children first, then childIds
  if (node.children) {
    for (const child of node.children) {
      renderNode(child, nodeMap, depth, lines, maxChars);
    }
  } else if (node.childIds) {
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId);
      if (child) {
        renderNode(child, nodeMap, depth, lines, maxChars);
      }
    }
  }
}

function formatProperties(node: AXNode): string {
  if (!node.properties || node.properties.length === 0) return "";

  const parts: string[] = [];
  for (const prop of node.properties) {
    const { name, value } = prop;
    // Only include interesting properties
    if (name === "level" || name === "checked" || name === "selected" ||
        name === "expanded" || name === "disabled" || name === "required" ||
        name === "valuetext" || name === "valuemin" || name === "valuemax" ||
        name === "valuenow") {
      parts.push(`${name}=${formatValue(value.value)}`);
    }
  }

  return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
}

function formatValue(val: unknown): string {
  if (typeof val === "string") return val;
  if (typeof val === "number") return String(val);
  if (typeof val === "boolean") return String(val);
  return JSON.stringify(val);
}

function totalLength(lines: string[]): number {
  let len = 0;
  for (const l of lines) len += l.length + 1; // +1 for \n
  return len;
}

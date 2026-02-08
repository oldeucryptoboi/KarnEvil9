import { describe, it, expect, vi } from "vitest";
import { buildAriaSnapshot } from "./aria-snapshot.js";
import type { CDPClient } from "./client.js";
import type { AXNode } from "./protocol.js";

function createMockCDP(nodes: AXNode[]): CDPClient {
  return {
    send: vi.fn().mockResolvedValue({ nodes }),
  } as unknown as CDPClient;
}

describe("buildAriaSnapshot", () => {
  it("builds a basic tree from AX nodes", async () => {
    const nodes: AXNode[] = [
      {
        nodeId: "1",
        ignored: false,
        role: { type: "role", value: "document" },
        name: { type: "computedString", value: "Example Page" },
        childIds: ["2", "3"],
      },
      {
        nodeId: "2",
        ignored: false,
        role: { type: "role", value: "heading" },
        name: { type: "computedString", value: "Hello" },
        properties: [{ name: "level", value: { type: "integer", value: 1 } }],
      },
      {
        nodeId: "3",
        ignored: false,
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Submit" },
      },
    ];

    const cdp = createMockCDP(nodes);
    const snapshot = await buildAriaSnapshot(cdp);

    expect(snapshot).toContain('- document "Example Page"');
    expect(snapshot).toContain('- heading "Hello" [level=1]');
    expect(snapshot).toContain('- button "Submit"');
  });

  it("skips ignored nodes but renders their children", async () => {
    const nodes: AXNode[] = [
      {
        nodeId: "1",
        ignored: false,
        role: { type: "role", value: "document" },
        name: { type: "computedString", value: "Page" },
        childIds: ["2"],
      },
      {
        nodeId: "2",
        ignored: true,
        role: { type: "role", value: "generic" },
        childIds: ["3"],
      },
      {
        nodeId: "3",
        ignored: false,
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Click" },
      },
    ];

    const cdp = createMockCDP(nodes);
    const snapshot = await buildAriaSnapshot(cdp);

    expect(snapshot).not.toContain("generic");
    expect(snapshot).toContain('- button "Click"');
  });

  it("skips generic/none roles but renders children", async () => {
    const nodes: AXNode[] = [
      {
        nodeId: "1",
        ignored: false,
        role: { type: "role", value: "document" },
        name: { type: "computedString", value: "Page" },
        childIds: ["2"],
      },
      {
        nodeId: "2",
        ignored: false,
        role: { type: "role", value: "generic" },
        childIds: ["3"],
      },
      {
        nodeId: "3",
        ignored: false,
        role: { type: "role", value: "link" },
        name: { type: "computedString", value: "Home" },
      },
    ];

    const cdp = createMockCDP(nodes);
    const snapshot = await buildAriaSnapshot(cdp);

    expect(snapshot).not.toContain("generic");
    expect(snapshot).toContain('- link "Home"');
  });

  it("renders properties like checked, disabled, expanded", async () => {
    const nodes: AXNode[] = [
      {
        nodeId: "1",
        ignored: false,
        role: { type: "role", value: "checkbox" },
        name: { type: "computedString", value: "Accept terms" },
        properties: [
          { name: "checked", value: { type: "tristate", value: true } },
          { name: "required", value: { type: "boolean", value: true } },
        ],
      },
    ];

    const cdp = createMockCDP(nodes);
    const snapshot = await buildAriaSnapshot(cdp);

    expect(snapshot).toContain('- checkbox "Accept terms" [checked=true, required=true]');
  });

  it("returns empty message when no nodes", async () => {
    const cdp = createMockCDP([]);
    const snapshot = await buildAriaSnapshot(cdp);
    expect(snapshot).toBe("(empty accessibility tree)");
  });

  it("truncates at maxChars", async () => {
    // Build a large tree
    const nodes: AXNode[] = [
      {
        nodeId: "1",
        ignored: false,
        role: { type: "role", value: "document" },
        name: { type: "computedString", value: "Page" },
        childIds: Array.from({ length: 100 }, (_, i) => String(i + 10)),
      },
      ...Array.from({ length: 100 }, (_, i) => ({
        nodeId: String(i + 10),
        ignored: false,
        role: { type: "role", value: "listitem" },
        name: { type: "computedString", value: `Item number ${i} with a reasonably long description that takes up space` },
      } as AXNode)),
    ];

    const cdp = createMockCDP(nodes);
    const snapshot = await buildAriaSnapshot(cdp, 500);

    expect(snapshot.length).toBeLessThanOrEqual(520); // 500 + truncation message
    expect(snapshot).toContain("... (truncated)");
  });

  it("handles inline children", async () => {
    const nodes: AXNode[] = [
      {
        nodeId: "1",
        ignored: false,
        role: { type: "role", value: "document" },
        name: { type: "computedString", value: "Page" },
        children: [
          {
            nodeId: "2",
            ignored: false,
            role: { type: "role", value: "heading" },
            name: { type: "computedString", value: "Title" },
            properties: [{ name: "level", value: { type: "integer", value: 1 } }],
          },
        ],
      },
    ];

    const cdp = createMockCDP(nodes);
    const snapshot = await buildAriaSnapshot(cdp);

    expect(snapshot).toContain('- heading "Title" [level=1]');
  });

  it("renders nodes without a name", async () => {
    const nodes: AXNode[] = [
      {
        nodeId: "1",
        ignored: false,
        role: { type: "role", value: "navigation" },
      },
    ];

    const cdp = createMockCDP(nodes);
    const snapshot = await buildAriaSnapshot(cdp);

    expect(snapshot).toBe("- navigation");
  });
});

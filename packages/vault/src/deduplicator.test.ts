import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { v4 as uuid } from "uuid";
import { Deduplicator, levenshtein } from "./deduplicator.js";

describe("Deduplicator", () => {
  let tmpDir: string;
  let dedup: Deduplicator;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `vault-dedup-test-${uuid()}`);
    await mkdir(tmpDir, { recursive: true });
    dedup = new Deduplicator(join(tmpDir, "aliases.yaml"));
    await dedup.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves unknown names to normalized form", () => {
    expect(dedup.resolve("TypeScript")).toBe("typescript");
    expect(dedup.resolve("type_script")).toBe("type script");
  });

  it("resolves via alias map", () => {
    dedup.addAlias("typescript", "TS");
    dedup.addAlias("typescript", "TypeScript");

    expect(dedup.resolve("TS")).toBe("typescript");
    expect(dedup.resolve("ts")).toBe("typescript");
    expect(dedup.resolve("TypeScript")).toBe("typescript");
  });

  it("resolves via fuzzy matching", () => {
    dedup.addAlias("typescript", "ts");
    // "typescipt" is 1 edit away from "typescript"
    expect(dedup.resolve("typescipt")).toBe("typescript");
  });

  it("returns normalized form when no match found", () => {
    expect(dedup.resolve("CompletelyNewThing")).toBe("completelynewthing");
  });

  it("retrieves canonical name", () => {
    dedup.addAlias("javascript", "JS");
    expect(dedup.getCanonical("js")).toBe("javascript");
    expect(dedup.getCanonical("unknown")).toBeUndefined();
  });

  it("retrieves all aliases for a canonical name", () => {
    dedup.addAlias("react", "ReactJS");
    dedup.addAlias("react", "React.js");

    const aliases = dedup.getAliases("react");
    expect(aliases.length).toBe(2);
    expect(aliases).toContain("reactjs");
    expect(aliases).toContain("react.js");
  });

  it("saves and loads aliases", async () => {
    dedup.addAlias("typescript", "TS");
    dedup.addAlias("typescript", "TypeScript");
    await dedup.save();

    const content = await readFile(join(tmpDir, "aliases.yaml"), "utf-8");
    expect(content).toContain("typescript");

    const dedup2 = new Deduplicator(join(tmpDir, "aliases.yaml"));
    await dedup2.init();
    expect(dedup2.resolve("TS")).toBe("typescript");
  });
});

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("hello", "hello")).toBe(0);
  });

  it("returns length for empty strings", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("counts single edits", () => {
    expect(levenshtein("cat", "hat")).toBe(1);
    expect(levenshtein("cat", "cats")).toBe(1);
    expect(levenshtein("cats", "cat")).toBe(1);
  });

  it("counts multiple edits", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

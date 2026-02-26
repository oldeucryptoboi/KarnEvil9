import { readFile, mkdir, rename, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import yaml from "js-yaml";

interface AliasMap {
  [canonical: string]: string[];
}

export class Deduplicator {
  private aliasFilePath: string;
  private aliases = new Map<string, string>(); // variant → canonical
  private reverseMap = new Map<string, Set<string>>(); // canonical → Set<variants>

  constructor(aliasFilePath: string) {
    this.aliasFilePath = aliasFilePath;
  }

  async init(): Promise<void> {
    if (!existsSync(this.aliasFilePath)) return;

    const content = await readFile(this.aliasFilePath, "utf-8");
    const parsed = yaml.load(content) as AliasMap | null;
    if (!parsed) return;

    for (const [canonical, variants] of Object.entries(parsed)) {
      const normalizedCanonical = this.normalize(canonical);
      if (!this.reverseMap.has(normalizedCanonical)) {
        this.reverseMap.set(normalizedCanonical, new Set());
      }
      for (const variant of variants) {
        const normalizedVariant = this.normalize(variant);
        this.aliases.set(normalizedVariant, normalizedCanonical);
        this.reverseMap.get(normalizedCanonical)!.add(normalizedVariant);
      }
      // Map canonical to itself too
      this.aliases.set(normalizedCanonical, normalizedCanonical);
    }
  }

  resolve(name: string): string {
    const normalized = this.normalize(name);

    // Direct alias match
    const canonical = this.aliases.get(normalized);
    if (canonical) return canonical;

    // Fuzzy match against known entities
    const bestMatch = this.fuzzyMatch(normalized);
    if (bestMatch) return bestMatch;

    return normalized;
  }

  addAlias(canonical: string, variant: string): void {
    const normalizedCanonical = this.normalize(canonical);
    const normalizedVariant = this.normalize(variant);

    this.aliases.set(normalizedVariant, normalizedCanonical);

    if (!this.reverseMap.has(normalizedCanonical)) {
      this.reverseMap.set(normalizedCanonical, new Set());
    }
    this.reverseMap.get(normalizedCanonical)!.add(normalizedVariant);
    this.aliases.set(normalizedCanonical, normalizedCanonical);
  }

  getCanonical(name: string): string | undefined {
    return this.aliases.get(this.normalize(name));
  }

  getAliases(canonical: string): string[] {
    const normalized = this.normalize(canonical);
    const variants = this.reverseMap.get(normalized);
    return variants ? Array.from(variants) : [];
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.aliasFilePath), { recursive: true });

    const aliasMap: AliasMap = {};
    for (const [canonical, variants] of this.reverseMap) {
      aliasMap[canonical] = Array.from(variants).filter((v) => v !== canonical);
    }

    const content = yaml.dump(aliasMap, { lineWidth: 120, noRefs: true });
    const tmpPath = this.aliasFilePath + ".tmp";
    const fh = await open(tmpPath, "w");
    try {
      await fh.writeFile(content, "utf-8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, this.aliasFilePath);
  }

  private normalize(name: string): string {
    return name.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  }

  private fuzzyMatch(normalized: string): string | undefined {
    let bestMatch: string | undefined;
    let bestDistance = Infinity;
    const threshold = Math.max(2, Math.floor(normalized.length * 0.3));

    for (const canonical of this.reverseMap.keys()) {
      const distance = levenshtein(normalized, canonical);
      if (distance < bestDistance && distance <= threshold) {
        bestDistance = distance;
        bestMatch = canonical;
      }
    }

    return bestMatch;
  }
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  // Use two rows instead of full matrix
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1,        // deletion
        curr[j - 1]! + 1,    // insertion
        prev[j - 1]! + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n]!;
}

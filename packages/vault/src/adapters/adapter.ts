import type { VaultAdapter, IngestItem } from "../types.js";

export type { VaultAdapter, IngestItem };

export abstract class BaseAdapter implements VaultAdapter {
  abstract readonly name: string;
  abstract readonly source: string;
  abstract extract(options?: Record<string, unknown>): AsyncGenerator<IngestItem, void, undefined>;
}

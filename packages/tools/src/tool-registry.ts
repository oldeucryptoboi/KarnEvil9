import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { ToolManifest, ToolSchemaForPlanner } from "@openflaw/schemas";
import { validateToolManifestData } from "@openflaw/schemas";

export class ToolRegistry {
  private tools = new Map<string, ToolManifest>();

  register(manifest: ToolManifest): void {
    const validation = validateToolManifestData(manifest);
    if (!validation.valid) {
      throw new Error(`Invalid tool manifest "${manifest.name}": ${validation.errors.join(", ")}`);
    }
    this.tools.set(manifest.name, manifest);
  }

  async loadFromFile(filePath: string): Promise<ToolManifest> {
    if (!existsSync(filePath)) throw new Error(`Tool manifest not found: ${filePath}`);
    const content = await readFile(filePath, "utf-8");
    const data = yaml.load(content) as ToolManifest;
    const validation = validateToolManifestData(data);
    if (!validation.valid) {
      throw new Error(`Invalid tool manifest at "${filePath}": ${validation.errors.join(", ")}`);
    }
    this.tools.set(data.name, data);
    return data;
  }

  async loadFromDirectory(dirPath: string): Promise<ToolManifest[]> {
    if (!existsSync(dirPath)) return [];
    const entries = await readdir(dirPath, { withFileTypes: true });
    const loaded: ToolManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(dirPath, entry.name, "tool.yaml");
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = await this.loadFromFile(manifestPath);
        loaded.push(manifest);
      } catch (err) {
        console.error(`Failed to load tool "${entry.name}": ${err}`);
      }
    }
    return loaded;
  }

  get(name: string): ToolManifest | undefined { return this.tools.get(name); }

  require(name: string): ToolManifest {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: "${name}"`);
    return tool;
  }

  list(): ToolManifest[] { return [...this.tools.values()]; }

  getSchemasForPlanner(): ToolSchemaForPlanner[] {
    return this.list().map((t) => ({
      name: t.name,
      version: t.version,
      description: t.description,
      input_schema: t.input_schema,
      output_schema: t.output_schema,
    }));
  }
}

import { readFile, readdir, mkdir, rename } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { existsSync } from "node:fs";

export interface DropZoneFile {
  filePath: string;
  detectedSource: string;
}

export class DropZoneWatcher {
  private dropZonePath: string;

  constructor(dropZonePath: string) {
    this.dropZonePath = dropZonePath;
  }

  async scan(): Promise<DropZoneFile[]> {
    if (!existsSync(this.dropZonePath)) return [];

    const entries = await readdir(this.dropZonePath, { withFileTypes: true });
    const results: DropZoneFile[] = [];

    for (const entry of entries) {
      // Skip hidden files/dirs and _processed directory
      if (entry.name.startsWith(".") || entry.name === "_processed") continue;
      if (entry.isDirectory()) continue;

      const filePath = join(this.dropZonePath, entry.name);
      const source = await this.detectSource(filePath);
      if (source) {
        results.push({ filePath, detectedSource: source });
      }
    }

    return results;
  }

  async moveToProcessed(filePath: string): Promise<void> {
    const processedDir = join(this.dropZonePath, "_processed");
    await mkdir(processedDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = basename(filePath);
    const destPath = join(processedDir, `${timestamp}_${name}`);

    await rename(filePath, destPath);
  }

  private async detectSource(filePath: string): Promise<string | null> {
    const ext = extname(filePath).toLowerCase();

    switch (ext) {
      case ".json":
        return this.detectJsonSource(filePath);
      case ".txt":
        return this.detectTxtSource(filePath);
      case ".mbox":
        return "gmail";
      default:
        return null;
    }
  }

  private async detectJsonSource(filePath: string): Promise<string | null> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const data = JSON.parse(raw);

      // ChatGPT exports have a `mapping` field per conversation
      if (Array.isArray(data)) {
        if (data.length > 0 && data[0]?.mapping) return "chatgpt";
        if (data.length > 0 && (data[0]?.chat_messages || data[0]?.uuid)) return "claude";
      } else if (typeof data === "object" && data !== null) {
        if (data.mapping) return "chatgpt";
        if (data.chat_messages || data.uuid) return "claude";
      }

      return null;
    } catch {
      return null;
    }
  }

  private async detectTxtSource(filePath: string): Promise<string | null> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const firstLine = raw.split("\n")[0] ?? "";

      // WhatsApp date pattern: e.g. "1/15/23, 10:30 AM" or "15/01/2023, 10:30"
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(firstLine)) return "whatsapp";

      return null;
    } catch {
      return null;
    }
  }
}

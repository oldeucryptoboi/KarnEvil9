import type { IngestItem } from "../types.js";
import { BaseAdapter } from "./adapter.js";

export interface GoogleDriveAdapterOptions {
  accessToken: string;
  folderId?: string;
  query?: string;
  maxResults?: number;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
  parents?: string[];
}

export class GoogleDriveAdapter extends BaseAdapter {
  readonly name = "google-drive";
  readonly source = "google-drive";
  private accessToken: string;
  private folderId?: string;
  private query?: string;
  private maxResults: number;

  constructor(options: GoogleDriveAdapterOptions) {
    super();
    this.accessToken = options.accessToken;
    this.folderId = options.folderId;
    this.query = options.query;
    this.maxResults = options.maxResults ?? 100;
  }

  async *extract(): AsyncGenerator<IngestItem, void, undefined> {
    let q = this.query ?? "trashed = false";
    if (this.folderId) {
      q = `'${this.folderId}' in parents and ${q}`;
    }

    // Only process text-readable formats
    q += " and (mimeType = 'application/vnd.google-apps.document' or mimeType = 'text/plain' or mimeType = 'text/markdown' or mimeType = 'application/pdf')";

    const listUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${this.maxResults}&fields=files(id,name,mimeType,createdTime,modifiedTime,parents)`;

    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!listRes.ok) {
      throw new Error(`Google Drive API error: ${listRes.status} ${listRes.statusText}`);
    }

    const listData = await listRes.json() as { files?: DriveFile[] };
    const files = listData.files ?? [];

    for (const file of files) {
      try {
        const content = await this.fetchFileContent(file);
        if (!content || content.trim().length === 0) continue;

        yield {
          source: "google-drive",
          source_id: file.id,
          title: file.name,
          content,
          created_at: file.createdTime,
          metadata: {
            object_type: "Document",
            mime_type: file.mimeType,
            modified_at: file.modifiedTime,
          },
        };
      } catch {
        // Skip files that can't be read
      }
    }
  }

  private async fetchFileContent(file: DriveFile): Promise<string | null> {
    // Google Docs — export as plain text
    if (file.mimeType === "application/vnd.google-apps.document") {
      const exportUrl = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`;
      const res = await fetch(exportUrl, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (!res.ok) return null;
      return res.text();
    }

    // Plain text / markdown — download directly
    if (file.mimeType === "text/plain" || file.mimeType === "text/markdown") {
      const downloadUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
      const res = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (!res.ok) return null;
      return res.text();
    }

    return null;
  }
}

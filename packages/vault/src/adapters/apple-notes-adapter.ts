import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IngestItem } from "../types.js";
import { BaseAdapter } from "./adapter.js";

const execFileAsync = promisify(execFile);

const APPLESCRIPT = `
tell application "Notes"
  set output to ""
  repeat with aNote in notes
    set noteId to id of aNote
    set noteName to name of aNote
    set noteBody to body of aNote
    set noteDate to creation date of aNote
    set modDate to modification date of aNote
    set folderName to name of container of aNote
    set output to output & "<<<NOTE_START>>>" & return
    set output to output & "ID:" & noteId & return
    set output to output & "TITLE:" & noteName & return
    set output to output & "FOLDER:" & folderName & return
    set output to output & "CREATED:" & (noteDate as string) & return
    set output to output & "MODIFIED:" & (modDate as string) & return
    set output to output & "BODY:" & return & noteBody & return
    set output to output & "<<<NOTE_END>>>" & return
  end repeat
  return output
end tell
`;

interface ParsedNote {
  id: string;
  title: string;
  folder: string;
  created: string;
  modified: string;
  body: string;
}

export class AppleNotesAdapter extends BaseAdapter {
  readonly name = "apple-notes";
  readonly source = "apple-notes";

  async *extract(): AsyncGenerator<IngestItem, void, undefined> {
    // Only works on macOS
    if (process.platform !== "darwin") {
      throw new Error("Apple Notes adapter only works on macOS");
    }

    let output: string;
    try {
      const result = await execFileAsync("osascript", ["-e", APPLESCRIPT], {
        timeout: 120000,
        maxBuffer: 50 * 1024 * 1024, // 50MB for large note collections
      });
      output = result.stdout;
    } catch (err) {
      throw new Error(`Failed to read Apple Notes: ${err instanceof Error ? err.message : String(err)}`);
    }

    const notes = this.parseOutput(output);

    for (const note of notes) {
      // Strip HTML tags from note body
      const cleanBody = note.body
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .trim();

      if (cleanBody.length === 0) continue;

      yield {
        source: "apple-notes",
        source_id: note.id,
        title: note.title || "Untitled Note",
        content: cleanBody,
        created_at: this.parseAppleDate(note.created),
        metadata: {
          object_type: "Note",
          folder: note.folder,
          modified_at: this.parseAppleDate(note.modified),
        },
      };
    }
  }

  private parseOutput(output: string): ParsedNote[] {
    const notes: ParsedNote[] = [];
    const blocks = output.split("<<<NOTE_START>>>").filter((b) => b.includes("<<<NOTE_END>>>"));

    for (const block of blocks) {
      const content = block.split("<<<NOTE_END>>>")[0]!;
      const lines = content.split("\n");

      const note: ParsedNote = { id: "", title: "", folder: "", created: "", modified: "", body: "" };
      let inBody = false;
      const bodyLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("ID:")) { note.id = line.slice(3).trim(); continue; }
        if (line.startsWith("TITLE:")) { note.title = line.slice(6).trim(); continue; }
        if (line.startsWith("FOLDER:")) { note.folder = line.slice(7).trim(); continue; }
        if (line.startsWith("CREATED:")) { note.created = line.slice(8).trim(); continue; }
        if (line.startsWith("MODIFIED:")) { note.modified = line.slice(9).trim(); continue; }
        if (line.startsWith("BODY:")) { inBody = true; continue; }
        if (inBody) bodyLines.push(line);
      }

      note.body = bodyLines.join("\n");
      if (note.id) notes.push(note);
    }

    return notes;
  }

  private parseAppleDate(dateStr: string): string {
    const date = new Date(dateStr);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
    return new Date().toISOString();
  }
}

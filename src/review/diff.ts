export type LineType = "add" | "del" | "context";

export interface DiffLine {
  type: LineType;
  newLine: number | null; // right-side line number (null for deletions)
  content: string;
}

export interface Hunk {
  newStart: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string; // new path (right side)
  hunks: Hunk[];
  /** Right-side line numbers that exist in the diff (added + context) — valid comment anchors. */
  validLines: Set<number>;
  /** Added right-side line numbers only — what the rules engine scans. */
  addedLines: { line: number; content: string }[];
}

const FILE_HEADER = /^diff --git /;
const NEW_PATH = /^\+\+\+ b\/(.+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse a unified diff into per-file hunks with right-side line numbers. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: Hunk | null = null;
  let newLine = 0;

  for (const raw of diff.split("\n")) {
    if (FILE_HEADER.test(raw)) {
      current = { path: "", hunks: [], validLines: new Set(), addedLines: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (!current) continue;

    const pathMatch = raw.match(NEW_PATH);
    if (pathMatch) {
      current.path = pathMatch[1];
      continue;
    }

    const hunkMatch = raw.match(HUNK_HEADER);
    if (hunkMatch) {
      newLine = parseInt(hunkMatch[1], 10);
      hunk = { newStart: newLine, lines: [] };
      current.hunks.push(hunk);
      continue;
    }

    if (!hunk) continue;

    // Metadata lines inside the diff we ignore for line tracking.
    if (
      raw.startsWith("--- ") ||
      raw.startsWith("index ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("similarity ") ||
      raw.startsWith("rename ")
    ) {
      continue;
    }

    const marker = raw[0];
    const content = raw.slice(1);
    if (marker === "+") {
      hunk.lines.push({ type: "add", newLine, content });
      current.validLines.add(newLine);
      current.addedLines.push({ line: newLine, content });
      newLine++;
    } else if (marker === "-") {
      hunk.lines.push({ type: "del", newLine: null, content });
      // deletions don't advance the right-side counter
    } else if (marker === " ") {
      hunk.lines.push({ type: "context", newLine, content });
      current.validLines.add(newLine);
      newLine++;
    }
    // "\ No newline at end of file" and blanks fall through
  }

  return files.filter((f) => f.path.length > 0);
}

export function fileByPath(files: DiffFile[], path: string): DiffFile | undefined {
  return files.find((f) => f.path === path);
}

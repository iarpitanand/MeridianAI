import type { DiffFile, Hunk } from "./diff.js";

export interface AnchorResult {
  ok: boolean;
  startLine?: number;
  endLine?: number;
  multiLine: boolean;
}

/**
 * Validate that a finding's line range anchors to the current diff.
 * A comment line must be a right-side line that appears in a hunk. If the exact
 * range isn't valid we try to snap; if nothing anchors, ok=false (caller demotes
 * the finding to the summary).
 */
export function anchorFinding(
  file: DiffFile,
  startLine: number,
  endLine: number,
): AnchorResult {
  const start = Math.min(startLine, endLine);
  const end = Math.max(startLine, endLine);

  const startValid = file.validLines.has(start);
  const endValid = file.validLines.has(end);

  // Both endpoints valid and in the same hunk -> keep as range.
  if (startValid && endValid && sameHunk(file, start, end)) {
    return {
      ok: true,
      startLine: start,
      endLine: end,
      multiLine: end > start,
    };
  }

  // Start valid -> collapse to a single-line comment on the start line.
  if (startValid) {
    return { ok: true, startLine: start, endLine: start, multiLine: false };
  }

  // End valid -> single-line on the end line.
  if (endValid) {
    return { ok: true, startLine: end, endLine: end, multiLine: false };
  }

  // Nothing anchors -> snap to the nearest valid line within a small window.
  const nearest = nearestValid(file, start, 3);
  if (nearest !== null) {
    return { ok: true, startLine: nearest, endLine: nearest, multiLine: false };
  }

  return { ok: false, multiLine: false };
}

/**
 * A ```suggestion``` block replaces the commented range, which must be added or
 * context lines on the RIGHT side within one hunk. anchorFinding already
 * guarantees right-side validity; this just confirms single-hunk containment.
 */
export function canSuggest(
  file: DiffFile,
  startLine: number,
  endLine: number,
): boolean {
  return sameHunk(file, startLine, endLine);
}

function hunkOf(file: DiffFile, line: number): Hunk | undefined {
  return file.hunks.find((h) =>
    h.lines.some((l) => l.newLine === line),
  );
}

function sameHunk(file: DiffFile, a: number, b: number): boolean {
  const ha = hunkOf(file, a);
  const hb = hunkOf(file, b);
  return ha !== undefined && ha === hb;
}

function nearestValid(
  file: DiffFile,
  target: number,
  window: number,
): number | null {
  for (let d = 0; d <= window; d++) {
    if (file.validLines.has(target - d)) return target - d;
    if (file.validLines.has(target + d)) return target + d;
  }
  return null;
}

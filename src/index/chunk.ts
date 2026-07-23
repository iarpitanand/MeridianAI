import type { ExtractedSymbol } from "./parser.js";

export interface Chunk {
  symbolName: string | null;
  startLine: number;
  endLine: number;
  content: string;
}

// ~3.5 chars per token is a safe rough estimate for code.
const CHARS_PER_TOKEN = 3.5;
const MAX_CHUNK_TOKENS = 1500;
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN;
const WHOLE_FILE_WINDOW_LINES = 120;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Chunk a file for embedding. Prefer one chunk per TOP-LEVEL symbol
 * (a class chunk already contains its methods, so nested symbols are skipped).
 * Files with no symbols get windowed line-range chunks.
 */
export function chunkFile(source: string, symbols: ExtractedSymbol[]): Chunk[] {
  const lines = source.split("\n");

  const topLevel = symbols
    .filter((s) => !symbols.some((o) => o !== s && contains(o, s)))
    .sort((a, b) => a.startLine - b.startLine);

  if (topLevel.length === 0) {
    return windowWholeFile(lines);
  }

  const chunks: Chunk[] = [];
  for (const sym of topLevel) {
    const content = lines.slice(sym.startLine - 1, sym.endLine).join("\n");
    if (content.length <= MAX_CHUNK_CHARS) {
      chunks.push({
        symbolName: sym.name,
        startLine: sym.startLine,
        endLine: sym.endLine,
        content,
      });
    } else {
      // Oversized symbol (huge function/class) — window it.
      for (const w of windowRange(lines, sym.startLine, sym.endLine)) {
        chunks.push({ ...w, symbolName: sym.name });
      }
    }
  }
  return chunks;
}

function contains(outer: ExtractedSymbol, inner: ExtractedSymbol): boolean {
  return (
    outer.startLine <= inner.startLine &&
    outer.endLine >= inner.endLine &&
    !(outer.startLine === inner.startLine && outer.endLine === inner.endLine)
  );
}

function windowWholeFile(lines: string[]): Chunk[] {
  return windowRange(lines, 1, lines.length).map((w) => ({
    ...w,
    symbolName: null,
  }));
}

function windowRange(
  lines: string[],
  startLine: number,
  endLine: number,
): { startLine: number; endLine: number; content: string; symbolName: null }[] {
  const out: {
    startLine: number;
    endLine: number;
    content: string;
    symbolName: null;
  }[] = [];
  for (let s = startLine; s <= endLine; s += WHOLE_FILE_WINDOW_LINES) {
    const e = Math.min(s + WHOLE_FILE_WINDOW_LINES - 1, endLine);
    const content = lines.slice(s - 1, e).join("\n");
    if (content.trim().length > 0) {
      out.push({ startLine: s, endLine: e, content, symbolName: null });
    }
  }
  return out;
}

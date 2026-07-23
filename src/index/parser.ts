import Parser from "web-tree-sitter";
import { createRequire } from "node:module";
import {
  LANGS,
  langForPath,
  kindFromNodeType,
  type LangSpec,
} from "./languages.js";

const require = createRequire(import.meta.url);

export interface ExtractedSymbol {
  name: string;
  kind: string;
  startLine: number; // 1-based
  endLine: number; // 1-based
}
export interface ExtractedRef {
  name: string;
  line: number; // 1-based
}
export interface Extracted {
  language: string;
  symbols: ExtractedSymbol[];
  refs: ExtractedRef[];
}

// web-tree-sitter 0.24 is CJS with a namespace-style default export; the loaded
// grammar and query objects aren't cleanly typed here, so we keep them loose.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface LoadedLang {
  lang: any;
  defQuery: any;
  refQuery: any;
  spec: LangSpec;
}

let initPromise: Promise<void> | null = null;
const cache = new Map<string, LoadedLang>();

function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

async function loadLang(spec: LangSpec): Promise<LoadedLang> {
  const cached = cache.get(spec.name);
  if (cached) return cached;
  await ensureInit();
  const wasmPath = require.resolve(
    `tree-sitter-wasms/out/tree-sitter-${spec.grammar}.wasm`,
  );
  const lang = await (Parser as any).Language.load(wasmPath);
  const loaded: LoadedLang = {
    lang,
    defQuery: lang.query(spec.defQuery),
    refQuery: lang.query(spec.refQuery),
    spec,
  };
  cache.set(spec.name, loaded);
  return loaded;
}

/** Pre-load every grammar (optional warm-up). */
export async function warmup(): Promise<void> {
  await Promise.all(LANGS.map(loadLang));
}

/**
 * Parse a source file and extract definitions + references.
 * Returns null for unsupported file types (caller falls back to whole-file chunking).
 */
export async function extract(
  path: string,
  source: string,
): Promise<Extracted | null> {
  const spec = langForPath(path);
  if (!spec) return null;

  const { lang, defQuery, refQuery } = await loadLang(spec);
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  const root = tree.rootNode;

  const symbols: ExtractedSymbol[] = [];
  for (const match of defQuery.matches(root)) {
    const defNode = match.captures.find((c: any) => c.name === "def")?.node;
    const nameNode = match.captures.find((c: any) => c.name === "name")?.node;
    if (!defNode || !nameNode) continue;
    symbols.push({
      name: nameNode.text,
      kind: kindFromNodeType(defNode.type),
      startLine: defNode.startPosition.row + 1,
      endLine: defNode.endPosition.row + 1,
    });
  }

  const refs: ExtractedRef[] = [];
  for (const match of refQuery.matches(root)) {
    const nameNode = match.captures.find((c: any) => c.name === "name")?.node;
    if (!nameNode) continue;
    refs.push({ name: nameNode.text, line: nameNode.startPosition.row + 1 });
  }

  tree.delete();
  return { language: spec.name, symbols, refs };
}

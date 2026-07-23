import type { ProbotOctokit } from "probot";
import { pool } from "../db.js";
import { getEmbedder } from "../index/embed.js";
import { estimateTokens } from "../index/chunk.js";
import { getFileAtRef, sliceLines } from "./content.js";
import type { DiffFile } from "./diff.js";
import type { MeridianConfig } from "./meridianConfig.js";

type Octo = InstanceType<typeof ProbotOctokit>;

export interface CallerContext {
  symbol: string;
  callerFile: string;
  callerLine: number;
  snippet: string;
}
export interface SemanticContext {
  file: string;
  symbolName: string | null;
  snippet: string;
}
export interface ContextPack {
  prTitle: string;
  prBody: string;
  diff: string;
  changedFileContents: { path: string; content: string }[];
  callers: CallerContext[];
  semantic: SemanticContext[];
  conventions: string;
  dropped: string[];
}

const TOKEN_BUDGET = 40_000;
const MAX_CHANGED_FILES = 20;
const MAX_CALLERS = 10;
const MAX_SEMANTIC = 8;
const SNIPPET_RADIUS = 6;

export async function buildContextPack(params: {
  octokit: Octo;
  repoId: number;
  owner: string;
  repo: string;
  headSha: string;
  prTitle: string;
  prBody: string;
  diff: string;
  files: DiffFile[];
  config: MeridianConfig;
}): Promise<ContextPack> {
  const { octokit, repoId, owner, repo, headSha, files, config } = params;
  const dropped: string[] = [];

  // Cache of file contents fetched this pass (also honours "no code at rest").
  const fileCache = new Map<string, string | null>();
  const getFile = async (path: string): Promise<string | null> => {
    if (fileCache.has(path)) return fileCache.get(path) ?? null;
    const content = await getFileAtRef(octokit, owner, repo, path, headSha);
    fileCache.set(path, content);
    return content;
  };

  // --- Full content of changed files (capped) ---
  const changedFileContents: { path: string; content: string }[] = [];
  for (const f of files.slice(0, MAX_CHANGED_FILES)) {
    const content = await getFile(f.path);
    if (content) changedFileContents.push({ path: f.path, content });
  }
  if (files.length > MAX_CHANGED_FILES) {
    dropped.push(`${files.length - MAX_CHANGED_FILES} changed files (over cap)`);
  }

  // --- Changed symbols -> callers (the blast radius) ---
  const changedPaths = files.map((f) => f.path);
  const changedSymbols = await findChangedSymbols(repoId, files);
  const callers: CallerContext[] = [];
  if (changedSymbols.length > 0) {
    const names = [...new Set(changedSymbols.map((s) => s.name))];
    const refRows = await pool.query<{
      ref_name: string;
      ref_file: string;
      ref_line: number;
    }>(
      `select ref_name, ref_file, ref_line
       from symbol_refs
       where repo_id = $1 and ref_name = any($2)
       limit 200`,
      [repoId, names],
    );
    // Prefer callers OUTSIDE the changed files (true blast radius), then others.
    const sorted = refRows.rows.sort((a, b) => {
      const aOut = changedPaths.includes(a.ref_file) ? 1 : 0;
      const bOut = changedPaths.includes(b.ref_file) ? 1 : 0;
      return aOut - bOut;
    });
    for (const r of sorted.slice(0, MAX_CALLERS)) {
      const content = await getFile(r.ref_file);
      const snippet = content
        ? sliceLines(content, r.ref_line - SNIPPET_RADIUS, r.ref_line + SNIPPET_RADIUS)
        : "";
      callers.push({
        symbol: r.ref_name,
        callerFile: r.ref_file,
        callerLine: r.ref_line,
        snippet,
      });
    }
  }

  // --- Semantic neighbours (embeddings) ---
  const semantic: SemanticContext[] = [];
  const embedder = getEmbedder();
  if (embedder.enabled) {
    const [vec] = await embedder.embed([truncate(params.diff, 8000)], "query");
    if (vec) {
      const rows = await pool.query<{
        file_path: string;
        symbol_name: string | null;
        start_line: number | null;
        end_line: number | null;
      }>(
        `select file_path, symbol_name, start_line, end_line
         from code_chunks
         where repo_id = $1 and embedding is not null
           and file_path <> all($2)
         order by embedding <=> $3::vector
         limit $4`,
        [repoId, changedPaths, `[${vec.join(",")}]`, MAX_SEMANTIC],
      );
      for (const r of rows.rows) {
        const content = await getFile(r.file_path);
        const snippet =
          content && r.start_line && r.end_line
            ? sliceLines(content, r.start_line, r.end_line)
            : "";
        if (snippet) {
          semantic.push({
            file: r.file_path,
            symbolName: r.symbol_name,
            snippet,
          });
        }
      }
    }
  }

  // --- Token budget: never drop the diff; trim semantic -> callers -> file contents ---
  const pack: ContextPack = {
    prTitle: params.prTitle,
    prBody: params.prBody,
    diff: params.diff,
    changedFileContents,
    callers,
    semantic,
    conventions: config.instructions,
    dropped,
  };
  enforceBudget(pack);
  return pack;
}

async function findChangedSymbols(
  repoId: number,
  files: DiffFile[],
): Promise<{ name: string; file: string }[]> {
  const out: { name: string; file: string }[] = [];
  for (const f of files) {
    const changedLines = f.addedLines.map((a) => a.line);
    if (changedLines.length === 0) continue;
    const rows = await pool.query<{
      symbol_name: string;
      start_line: number;
      end_line: number;
    }>(
      `select symbol_name, start_line, end_line
       from symbols
       where repo_id = $1 and file_path = $2`,
      [repoId, f.path],
    );
    for (const s of rows.rows) {
      if (changedLines.some((l) => l >= s.start_line && l <= s.end_line)) {
        out.push({ name: s.symbol_name, file: f.path });
      }
    }
  }
  return out;
}

function enforceBudget(pack: ContextPack): void {
  const size = (): number =>
    estimateTokens(pack.diff) +
    estimateTokens(pack.conventions) +
    pack.changedFileContents.reduce((n, f) => n + estimateTokens(f.content), 0) +
    pack.callers.reduce((n, c) => n + estimateTokens(c.snippet), 0) +
    pack.semantic.reduce((n, s) => n + estimateTokens(s.snippet), 0);

  while (size() > TOKEN_BUDGET && pack.semantic.length > 0) {
    pack.semantic.pop();
    pack.dropped.push("semantic neighbour (budget)");
  }
  while (size() > TOKEN_BUDGET && pack.callers.length > 0) {
    pack.callers.pop();
    pack.dropped.push("caller context (budget)");
  }
  while (size() > TOKEN_BUDGET && pack.changedFileContents.length > 0) {
    pack.changedFileContents.pop();
    pack.dropped.push("changed file content (budget)");
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

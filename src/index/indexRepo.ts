import { createHash } from "node:crypto";
import type { ProbotOctokit } from "probot";
import { extract } from "./parser.js";
import { chunkFile } from "./chunk.js";
import { getEmbedder } from "./embed.js";
import {
  listIndexableFiles,
  getBlobContent,
  isIndexable,
  defaultBranchSha,
  type TreeFile,
} from "./github.js";
import {
  storeFile,
  removeFile,
  getFileHash,
  setRepoIndexStatus,
  type StoredChunk,
} from "./store.js";
import { config } from "../config.js";

type Octo = InstanceType<typeof ProbotOctokit>;

interface RepoRef {
  repoId: number;
  owner: string;
  repo: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Index (or re-index) one file: fetch, parse, chunk, embed, store. */
async function indexOneFile(
  octokit: Octo,
  ref: RepoRef,
  file: TreeFile,
  indexedSha: string,
): Promise<void> {
  const source = await getBlobContent(octokit, ref.owner, ref.repo, file.sha);
  const contentHash = sha256(source);

  // Skip if unchanged since last index.
  const prev = await getFileHash(ref.repoId, file.path);
  if (prev === contentHash) return;

  const extracted = await extract(file.path, source);
  const chunks = chunkFile(source, extracted?.symbols ?? []);

  const embedder = getEmbedder();
  let vectors: number[][] = [];
  if (embedder.enabled && chunks.length > 0) {
    vectors = await embedder.embed(
      chunks.map((c) => c.content),
      "document",
    );
  }

  const stored: StoredChunk[] = chunks.map((c, i) => ({
    ...c,
    contentHash: sha256(c.content),
    embedding: vectors[i] ?? null,
  }));

  await storeFile({
    repoId: ref.repoId,
    path: file.path,
    contentHash,
    indexedSha,
    extracted,
    chunks: stored,
  });
}

/** Simple bounded-concurrency map. */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<{ errors: number }> {
  let errors = 0;
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        await fn(items[i]);
      } catch (err) {
        errors++;
        // eslint-disable-next-line no-console
        console.error(`index error:`, (err as Error).message);
      }
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return { errors };
}

/** Full index of a repo's default branch. Runs on install. */
export async function indexRepoFull(octokit: Octo, ref: RepoRef): Promise<void> {
  const { sha } = await defaultBranchSha(octokit, ref.owner, ref.repo);
  await setRepoIndexStatus(ref.repoId, "indexing");
  try {
    const files = await listIndexableFiles(octokit, ref.owner, ref.repo, sha);
    const { errors } = await mapLimit(files, config.INDEX_CONCURRENCY, (f) =>
      indexOneFile(octokit, ref, f, sha),
    );
    await setRepoIndexStatus(ref.repoId, "ready", sha);
    // eslint-disable-next-line no-console
    console.log(
      `indexed ${ref.owner}/${ref.repo}: ${files.length} files, ${errors} errors`,
    );
  } catch (err) {
    await setRepoIndexStatus(ref.repoId, "failed");
    throw err;
  }
}

/** Incremental re-index of specific paths. Runs on push to default branch. */
export async function indexRepoIncremental(
  octokit: Octo,
  ref: RepoRef,
  headSha: string,
  changed: string[],
  removed: string[],
): Promise<void> {
  for (const path of removed) {
    await removeFile(ref.repoId, path).catch(() => undefined);
  }

  // Resolve each changed path to its blob at headSha via the tree.
  const files = await listIndexableFiles(octokit, ref.owner, ref.repo, headSha);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const targets = changed
    .filter((p) => isIndexable(p, 0) || byPath.has(p))
    .map((p) => byPath.get(p))
    .filter((f): f is TreeFile => f !== undefined);

  await mapLimit(targets, config.INDEX_CONCURRENCY, (f) =>
    indexOneFile(octokit, ref, f, headSha),
  );

  await setRepoIndexStatus(ref.repoId, "ready", headSha);
  // eslint-disable-next-line no-console
  console.log(
    `incremental ${ref.owner}/${ref.repo}: ${targets.length} changed, ${removed.length} removed`,
  );
}

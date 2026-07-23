import type { ProbotOctokit } from "probot";
import { config } from "../config.js";
import { langForPath } from "./languages.js";

type Octo = InstanceType<typeof ProbotOctokit>;

export interface TreeFile {
  path: string;
  sha: string;
  size: number;
}

const IGNORE_SEGMENTS = [
  "node_modules/",
  "dist/",
  "build/",
  "vendor/",
  ".git/",
  "__pycache__/",
  "target/",
  ".next/",
  "coverage/",
];
const IGNORE_SUFFIXES = [
  ".min.js",
  ".lock",
  ".map",
  ".snap",
  "-lock.json",
  ".generated.ts",
];

export function isIndexable(path: string, size: number): boolean {
  if (size > config.INDEX_MAX_FILE_BYTES) return false;
  if (IGNORE_SEGMENTS.some((seg) => path.includes(seg))) return false;
  if (IGNORE_SUFFIXES.some((suf) => path.endsWith(suf))) return false;
  return langForPath(path) !== undefined;
}

/** Resolve the head commit SHA of the repo's default branch. */
export async function defaultBranchSha(
  octokit: Octo,
  owner: string,
  repo: string,
): Promise<{ sha: string; branch: string }> {
  const { data: r } = await octokit.rest.repos.get({ owner, repo });
  const branch = r.default_branch;
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  });
  return { sha: ref.object.sha, branch };
}

/** List all indexable blobs in the tree at a commit SHA. */
export async function listIndexableFiles(
  octokit: Octo,
  owner: string,
  repo: string,
  commitSha: string,
): Promise<TreeFile[]> {
  const { data } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: commitSha,
    recursive: "true",
  });
  const files: TreeFile[] = [];
  for (const entry of data.tree) {
    if (entry.type !== "blob" || !entry.path || !entry.sha) continue;
    const size = entry.size ?? 0;
    if (isIndexable(entry.path, size)) {
      files.push({ path: entry.path, sha: entry.sha, size });
    }
  }
  return files;
}

/** Fetch a single blob's decoded UTF-8 content. */
export async function getBlobContent(
  octokit: Octo,
  owner: string,
  repo: string,
  fileSha: string,
): Promise<string> {
  const { data } = await octokit.rest.git.getBlob({
    owner,
    repo,
    file_sha: fileSha,
  });
  return Buffer.from(data.content, data.encoding as BufferEncoding).toString(
    "utf8",
  );
}

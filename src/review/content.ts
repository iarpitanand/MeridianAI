import type { ProbotOctokit } from "probot";

type Octo = InstanceType<typeof ProbotOctokit>;

/** Fetch a file's text at a specific ref. Returns null on 404 or if too large. */
export async function getFileAtRef(
  octokit: Octo,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });
    if (!Array.isArray(data) && data.type === "file" && data.content) {
      return Buffer.from(data.content, "base64").toString("utf8");
    }
  } catch {
    // 404 / too large -> null
  }
  return null;
}

export function sliceLines(
  source: string,
  startLine: number,
  endLine: number,
): string {
  return source
    .split("\n")
    .slice(Math.max(0, startLine - 1), endLine)
    .join("\n");
}

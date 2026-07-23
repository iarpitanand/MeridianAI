import micromatch from "micromatch";
import type { ProbotOctokit } from "probot";
import type { ReviewJob } from "../queue.js";
import { query } from "../db.js";
import { getRepo } from "../db/repos.js";
import { parseDiff, type DiffFile } from "./diff.js";
import { loadMeridianConfig } from "./meridianConfig.js";
import { runPipeline } from "./pipeline.js";
import type { InlineComment } from "./types.js";

const MARKER = "<!-- meridianai:summary -->";
const INFO_MARKER = "<!-- meridianai:repo-info -->";
const CHECK_NAME = "MeridianAI review";

type Octo = InstanceType<typeof ProbotOctokit>;

export async function runReview(octokit: Octo, job: ReviewJob): Promise<void> {
  const { owner, repo, prNumber, headSha, repoId } = job;

  // 1. Freshness
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  if (pr.state !== "open") return;
  if (pr.head.sha !== headSha) return; // newer push queued; let it win

  // 1b. Post repo details once per PR (separate from the review summary)
  await postRepoInfoComment(octokit, owner, repo, prNumber, pr.base.repo.default_branch);

  // 2. Idempotency
  const already = await query(
    `select id from reviews
     where repo_id=$1 and pr_number=$2 and head_sha=$3 and status='posted'`,
    [repoId, prNumber, headSha],
  );
  if (already.rowCount) return;

  const ins = await query<{ id: string }>(
    `insert into reviews (repo_id, pr_number, head_sha, status)
     values ($1,$2,$3,'running') returning id`,
    [repoId, prNumber, headSha],
  );
  const reviewId = ins.rows[0].id;

  // 2b. Load repo + config early: whether to review a draft at all depends on it.
  const repoRow = await getRepo(repoId);
  const { config, warning } = await loadMeridianConfig(
    octokit,
    owner,
    repo,
    headSha,
    repoRow?.config,
  );

  if ((repoRow && !repoRow.enabled) || (pr.draft && !config.reviewDrafts)) {
    await query(`update reviews set status='skipped' where id=$1`, [reviewId]);
    return;
  }

  // 3. In-progress check run (visible in the merge box)
  const check = await octokit.rest.checks
    .create({
      owner,
      repo,
      name: CHECK_NAME,
      head_sha: headSha,
      status: "in_progress",
    })
    .catch(() => null);

  try {
    // 4. Acknowledge fast
    await octokit.rest.reactions
      .createForIssue({ owner, repo, issue_number: prNumber, content: "eyes" })
      .catch(() => undefined);

    // 5. Fetch diff, drop files matching config.ignore
    const diffRes = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    });
    const diff = diffRes.data as unknown as string;
    const allFiles = parseDiff(diff);
    const files: DiffFile[] =
      config.ignore.length > 0
        ? allFiles.filter((f) => !micromatch.isMatch(f.path, config.ignore))
        : allFiles;

    // 6. Run the pipeline (context pack -> reviewer -> critic -> filter)
    const result = await runPipeline({
      octokit,
      repoId,
      owner,
      repo,
      headSha,
      prTitle: pr.title,
      prBody: pr.body ?? "",
      diff,
      files,
      config,
      configWarning: warning,
    });

    // 7. Post inline comments as one review, then upsert the summary comment
    if (result.inline.length > 0) {
      await postReview(octokit, owner, repo, prNumber, headSha, result.inline);
    }
    await upsertSummaryComment(
      octokit,
      owner,
      repo,
      prNumber,
      `${MARKER}\n${result.summary}`,
    );

    // 8. Persist findings for the learning loop
    await persistFindings(reviewId, result.inline);

    // 9. Complete the check (never fail the merge)
    const counts = summarizeCounts(result.inline);
    if (check?.data.id) {
      await octokit.rest.checks
        .update({
          owner,
          repo,
          check_run_id: check.data.id,
          status: "completed",
          conclusion: "neutral",
          output: { title: counts, summary: counts },
        })
        .catch(() => undefined);
    }

    await query(
      `update reviews set status='posted', posted_at=now() where id=$1`,
      [reviewId],
    );
  } catch (err) {
    await query(`update reviews set status='failed' where id=$1`, [reviewId]);
    if (check?.data.id) {
      await octokit.rest.checks
        .update({
          owner,
          repo,
          check_run_id: check.data.id,
          status: "completed",
          conclusion: "neutral",
          output: {
            title: "Review could not complete",
            summary: "MeridianAI hit an error; your merge is not blocked.",
          },
        })
        .catch(() => undefined);
    }
    throw err;
  }
}

async function postReview(
  octokit: Octo,
  owner: string,
  repo: string,
  prNumber: number,
  commitId: string,
  inline: InlineComment[],
): Promise<void> {
  const comments = inline.map((c) =>
    c.multiLine
      ? {
          path: c.path,
          start_line: c.startLine,
          start_side: "RIGHT" as const,
          line: c.endLine,
          side: "RIGHT" as const,
          body: c.body,
        }
      : { path: c.path, line: c.startLine, side: "RIGHT" as const, body: c.body },
  );

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitId,
      event: "COMMENT",
      comments,
    });
  } catch {
    // If a batch post fails (e.g. one bad anchor), retry comment-by-comment so
    // one bad finding doesn't sink the whole review.
    for (const c of comments) {
      await octokit.rest.pulls
        .createReview({
          owner,
          repo,
          pull_number: prNumber,
          commit_id: commitId,
          event: "COMMENT",
          comments: [c],
        })
        .catch(() => undefined);
    }
  }
}

async function postRepoInfoComment(
  octokit: Octo,
  owner: string,
  repo: string,
  prNumber: number,
  defaultBranch: string,
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  if (comments.some((c) => c.body?.includes(INFO_MARKER))) return; // already posted

  const body = [
    INFO_MARKER,
    "**Repository:** `" + owner + "/" + repo + "`",
    "**Default branch:** `" + defaultBranch + "`",
  ].join("\n");

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

async function upsertSummaryComment(
  octokit: Octo,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const mine = comments.find((c) => c.body?.includes(MARKER));
  if (mine) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: mine.id,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
  }
}

async function persistFindings(
  reviewId: string,
  inline: InlineComment[],
): Promise<void> {
  for (const c of inline) {
    await query(
      `insert into findings (review_id, file, start_line, end_line, severity, confidence, body)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [reviewId, c.path, c.startLine, c.endLine, c.severity, c.confidence, c.body],
    );
  }
}

function summarizeCounts(inline: InlineComment[]): string {
  if (inline.length === 0) return "No blocking issues";
  const by: Record<string, number> = {};
  for (const c of inline) by[c.severity] = (by[c.severity] ?? 0) + 1;
  const parts = Object.entries(by).map(([s, n]) => `${n} ${s}`);
  return `${inline.length} finding(s): ${parts.join(", ")}`;
}

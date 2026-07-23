import { dump as dumpYaml } from "js-yaml";
import type { ApplicationFunctionOptions, Probot } from "probot";
import { reviewQueue, type ReviewJob } from "./queue.js";
import { indexQueue, type IndexJob } from "./index/queue.js";
import { seenDelivery } from "./lib/dedupe.js";
import {
  upsertInstallation,
  markInstallationDeleted,
  updateInstallationStatus,
  upsertRepo,
  deleteRepos,
  deleteReposForInstallation,
} from "./db/repos.js";
import { unlinkInstallation } from "./db/users.js";
import { loadMeridianConfig } from "./review/meridianConfig.js";
import { config } from "./config.js";
import { dashboardRouter } from "./dashboard/routes.js";

const VALIDATE_COMMAND = "@meridianai validate";

export function app(probot: Probot, { getRouter }: ApplicationFunctionOptions): void {
  if (getRouter) {
    getRouter().use(dashboardRouter);
  }

  // ---- PR events -> enqueue a (debounced) review job ----
  probot.on(
    [
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.synchronize",
      "pull_request.ready_for_review",
    ],
    async (context) => {
      const pr = context.payload.pull_request;
      const repo = context.payload.repository;
      const installation = context.payload.installation;

      // Draft PRs are still enqueued — whether to actually review one depends
      // on `.meridian.yml`'s `review_drafts`, which isn't known until the
      // worker loads config; see run.ts's post-config skip.
      if (!installation) {
        context.log.warn("no installation on payload; skipping");
        return;
      }

      // GitHub redelivers on timeout — dedupe on delivery id.
      if (await seenDelivery(context.id)) {
        context.log.info(`duplicate delivery ${context.id}; skipping`);
        return;
      }

      // `installation` on a pull_request payload is just {id, node_id} — no
      // account info. repos.installation_id has a FK to installations, so if
      // the `installation` webhook for this install hasn't landed yet (missed
      // delivery, ordering race), upsertRepo below would fail. Self-heal with
      // what we do have (the repo's owner); the real `installation` event
      // will overwrite this with the correct account_type if they differ.
      await upsertInstallation({
        installationId: installation.id,
        account: repo.owner.login,
        accountType: repo.owner.type,
      });

      await upsertRepo({
        repoId: repo.id,
        installationId: installation.id,
        owner: repo.owner.login,
        name: repo.name,
        defaultBranch: repo.default_branch,
      });

      const job: ReviewJob = {
        installationId: installation.id,
        repoId: repo.id,
        owner: repo.owner.login,
        repo: repo.name,
        prNumber: pr.number,
        headSha: pr.head.sha,
        deliveryId: context.id,
      };

      // Debounce: one job per PR. Remove any pending job so the newest head SHA
      // wins and the delay timer resets.
      const jobId = `review:${repo.id}:${pr.number}`;
      const existing = await reviewQueue.getJob(jobId);
      if (existing) {
        try {
          await existing.remove();
        } catch {
          /* already picked up by a worker; the freshness check will handle it */
        }
      }

      await reviewQueue.add("review", job, {
        jobId,
        delay: config.REVIEW_DEBOUNCE_MS,
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      });

      context.log.info(`queued ${jobId} @ ${pr.head.sha}`);
    },
  );

  // ---- Push to default branch -> incremental re-index ----
  probot.on("push", async (context) => {
    const { ref, repository: repo, installation } = context.payload;
    if (!installation) return;
    const defaultRef = `refs/heads/${repo.default_branch}`;
    if (ref !== defaultRef) return; // only index the default branch

    const changed = new Set<string>();
    const removed = new Set<string>();
    for (const c of context.payload.commits ?? []) {
      for (const p of [...c.added, ...c.modified]) changed.add(p);
      for (const p of c.removed) removed.add(p);
    }
    // A file both changed and removed across commits => treat as removed.
    for (const p of removed) changed.delete(p);
    if (changed.size === 0 && removed.size === 0) return;

    const job: IndexJob = {
      kind: "incremental",
      installationId: installation.id,
      repoId: repo.id,
      owner: repo.owner.login,
      repo: repo.name,
      headSha: context.payload.after,
      changed: [...changed],
      removed: [...removed],
    };
    await indexQueue.add("index", job, {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 500,
      removeOnFail: 2000,
    });
    context.log.info(
      `queued incremental index ${repo.full_name}: +${changed.size} -${removed.size}`,
    );
  });

  // ---- Installation lifecycle ----
  probot.on("installation", async (context) => {
    const inst = context.payload.installation;

    if (context.payload.action === "deleted") {
      // Purge repo/index data (privacy: nothing of theirs stays once uninstalled).
      await deleteReposForInstallation(inst.id);
      await unlinkInstallation(inst.id);
      await markInstallationDeleted(inst.id);
      context.log.info(`installation ${inst.id} deleted`);
      return;
    }

    if (context.payload.action === "suspend" || context.payload.action === "unsuspend") {
      await updateInstallationStatus(
        inst.id,
        context.payload.action === "suspend" ? "suspended" : "active",
      );
      context.log.info(`installation ${inst.id} ${context.payload.action}ed`);
      return;
    }

    await upsertInstallation({
      installationId: inst.id,
      account: inst.account && "login" in inst.account ? inst.account.login : "unknown",
      accountType: inst.account && "type" in inst.account ? inst.account.type : "User",
    });

    const repos = context.payload.repositories ?? [];
    for (const r of repos) {
      const [owner] = r.full_name.split("/");
      await upsertRepo({
        repoId: r.id,
        installationId: inst.id,
        owner: owner ?? "",
        name: r.name,
        // Not present on installation payload; corrected on first PR event.
        defaultBranch: "main",
      });
      await enqueueFullIndex(inst.id, r.id, owner ?? "", r.name);
    }
    context.log.info(`installation ${inst.id} active with ${repos.length} repo(s)`);
  });

  probot.on("installation_repositories", async (context) => {
    const inst = context.payload.installation;
    const added = context.payload.repositories_added ?? [];
    for (const r of added) {
      const [owner] = r.full_name.split("/");
      await upsertRepo({
        repoId: r.id,
        installationId: inst.id,
        owner: owner ?? "",
        name: r.name,
        defaultBranch: "main",
      });
      await enqueueFullIndex(inst.id, r.id, owner ?? "", r.name);
    }

    const removed = context.payload.repositories_removed ?? [];
    if (removed.length > 0) {
      await deleteRepos(removed.map((r) => r.id)); // cascades reviews/findings/index data
    }

    context.log.info(
      `installation ${inst.id}: +${added.length} -${removed.length} repo(s)`,
    );
  });

  // ---- `@meridianai validate` PR comment command ----
  probot.on("issue_comment.created", async (context) => {
    const { issue, comment, repository } = context.payload;
    if (!issue.pull_request) return; // plain issue comment, not a PR
    if (comment.body.trim().toLowerCase() !== VALIDATE_COMMAND) return;

    const { data: pr } = await context.octokit.rest.pulls.get({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: issue.number,
    });

    const { config: effective, warning } = await loadMeridianConfig(
      context.octokit,
      repository.owner.login,
      repository.name,
      pr.head.sha,
    );

    const body = warning
      ? `⚠️ ${warning}`
      : `✅ \`.meridian.yml\` is valid. Effective config:\n\n\`\`\`yaml\n${dumpYaml(effective)}\`\`\``;

    await context.octokit.rest.issues.createComment({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: issue.number,
      body,
    });
  });
}

async function enqueueFullIndex(
  installationId: number,
  repoId: number,
  owner: string,
  repo: string,
): Promise<void> {
  const job: IndexJob = { kind: "full", installationId, repoId, owner, repo };
  await indexQueue.add("index", job, {
    // BullMQ rejects a custom jobId containing ":" unless it splits into
    // exactly 3 parts (legacy repeatable-job compat) — `index-full:${id}`
    // has one colon (2 parts) and was silently throwing on every call.
    jobId: `index-full-${repoId}`,
    attempts: 2,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  });
}

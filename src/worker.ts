import { Worker } from "bullmq";
import { Probot } from "probot";
import { connection } from "./redis.js";
import { REVIEW_QUEUE, type ReviewJob } from "./queue.js";
import { INDEX_QUEUE, type IndexJob } from "./index/queue.js";
import { config } from "./config.js";
import { runReview } from "./review/run.js";
import { indexRepoFull, indexRepoIncremental } from "./index/indexRepo.js";

// Standalone Probot instance, used only to mint installation-scoped Octokit clients.
const probot = new Probot({
  appId: config.APP_ID,
  privateKey: config.PRIVATE_KEY,
  secret: config.WEBHOOK_SECRET,
});

const reviewWorker = new Worker<ReviewJob>(
  REVIEW_QUEUE,
  async (job) => {
    const octokit = await probot.auth(job.data.installationId);
    await runReview(octokit, job.data);
  },
  { connection, concurrency: 5 },
);

const indexWorker = new Worker<IndexJob>(
  INDEX_QUEUE,
  async (job) => {
    const octokit = await probot.auth(job.data.installationId);
    const ref = {
      repoId: job.data.repoId,
      owner: job.data.owner,
      repo: job.data.repo,
    };
    if (job.data.kind === "full") {
      await indexRepoFull(octokit, ref);
    } else {
      await indexRepoIncremental(
        octokit,
        ref,
        job.data.headSha,
        job.data.changed,
        job.data.removed,
      );
    }
  },
  { connection, concurrency: 2 }, // indexing is heavier; keep it lower
);

for (const [name, w] of [
  ["review", reviewWorker],
  ["index", indexWorker],
] as const) {
  w.on("completed", (job) => {
    // eslint-disable-next-line no-console
    console.log(`${name} completed: ${job.id}`);
  });
  w.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`${name} failed: ${job?.id}: ${err.message}`);
  });
}

// eslint-disable-next-line no-console
console.log("MeridianAI worker started (review + index)");

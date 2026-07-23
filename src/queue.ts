import { Queue } from "bullmq";
import { connection } from "./redis.js";

export interface ReviewJob {
  installationId: number;
  repoId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  deliveryId: string;
}

export const REVIEW_QUEUE = "reviews";

export const reviewQueue = new Queue<ReviewJob>(REVIEW_QUEUE, { connection });

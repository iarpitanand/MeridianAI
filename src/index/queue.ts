import { Queue } from "bullmq";
import { connection } from "../redis.js";

export const INDEX_QUEUE = "index";

export type IndexJob =
  | {
      kind: "full";
      installationId: number;
      repoId: number;
      owner: string;
      repo: string;
    }
  | {
      kind: "incremental";
      installationId: number;
      repoId: number;
      owner: string;
      repo: string;
      headSha: string;
      changed: string[];
      removed: string[];
    };

export const indexQueue = new Queue<IndexJob>(INDEX_QUEUE, { connection });

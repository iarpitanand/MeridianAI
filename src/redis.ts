import { Redis } from "ioredis";
import { config } from "./config.js";

// BullMQ requires maxRetriesPerRequest = null on the shared connection.
export const connection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});

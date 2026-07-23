import { connection } from "../redis.js";

const TTL_SECONDS = 60 * 60 * 24; // 24h

/**
 * Returns true if this GitHub delivery id has been seen before.
 * GitHub redelivers on webhook timeouts, so we must dedupe on X-GitHub-Delivery.
 */
export async function seenDelivery(deliveryId: string): Promise<boolean> {
  const res = await connection.set(
    `delivery:${deliveryId}`,
    "1",
    "EX",
    TTL_SECONDS,
    "NX",
  );
  // "OK" => newly set (not seen). null => key existed (already seen).
  return res === null;
}

import pg from "pg";
import { config } from "./config.js";

// Neon requires SSL. rejectUnauthorized:false avoids local cert-chain hassles;
// tighten to a CA bundle for production if your platform provides one.
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as pg.QueryConfigValues<unknown[]> | undefined);
}

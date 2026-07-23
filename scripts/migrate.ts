import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { config } from "../src/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(path.join(here, "..", "db", "schema.sql"), "utf8");

const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const client = await pool.connect();
try {
  await client.query(sql);
  // eslint-disable-next-line no-console
  console.log("✓ migration applied");
} finally {
  client.release();
  await pool.end();
}

import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const PKCS1 = ["-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"] as const;
const PKCS8 = ["-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"] as const;

/**
 * Probot's CLI bootstrapping (createProbot()) normalizes PRIVATE_KEY via
 * @probot/get-private-key, but we build our own Probot instances directly
 * (Probot.defaults(...) in server.ts, `new Probot(...)` in worker.ts) so that
 * normalization never runs. Reimplemented here so a PEM pasted as one line
 * (with `\n` escapes, or even just spaces where the newlines should be)
 * still parses — jsonwebtoken's RS256 signer otherwise fails with
 * "secretOrPrivateKey must be an asymmetric key when using RS256".
 */
function normalizePrivateKey(raw: string): string {
  let key = raw.trim();
  if (key.includes("\\n")) key = key.replace(/\\n/g, "\n");

  const markers = [PKCS1, PKCS8].find(([begin, end]) => key.includes(begin) && key.includes(end));
  if (!markers) {
    throw new Error(
      'PRIVATE_KEY does not look like a PEM key (missing "-----BEGIN ... PRIVATE KEY-----"). ' +
        "Paste the full .pem contents.",
    );
  }
  if (!key.includes("\n")) {
    const [begin, end] = markers;
    const start = key.indexOf(begin) + begin.length;
    const stop = key.indexOf(end);
    const middle = key.slice(start, stop).trim().replace(/\s+/g, "\n");
    key = `${begin}\n${middle}\n${end}`;
  }
  return key;
}

const schema = z.object({
  APP_ID: z.string().min(1, "APP_ID is required"),
  PRIVATE_KEY: z.string().min(1, "PRIVATE_KEY is required").transform(normalizePrivateKey),
  WEBHOOK_SECRET: z.string().min(1, "WEBHOOK_SECRET is required"),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  PORT: z.coerce.number().default(3000),
  REVIEW_DEBOUNCE_MS: z.coerce.number().default(75_000),
  LOG_LEVEL: z.string().default("info"),

  // ---- Dashboard (Sign in with GitHub + Connect repos) ----
  APP_BASE_URL: z.string().default("http://localhost:3000"),
  GITHUB_APP_SLUG: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || Buffer.from(v, "base64").length === 32,
      "TOKEN_ENCRYPTION_KEY must be base64 for exactly 32 bytes",
    ),

  // ---- Embeddings (optional: without a key, indexing still builds the call graph) ----
  VOYAGE_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default("voyage-code-3"),
  EMBEDDING_DIMENSIONS: z.coerce.number().default(1024),

  // ---- Indexing ----
  INDEX_CONCURRENCY: z.coerce.number().default(8),
  INDEX_MAX_FILE_BYTES: z.coerce.number().default(300_000),

  // ---- LLM review (optional: without a key, reviews post change-size summaries only) ----
  ANTHROPIC_API_KEY: z.string().optional(),
  REVIEW_MODEL: z.string().default("claude-sonnet-5"),
  CRITIC_MODEL: z.string().default("claude-haiku-4-5-20251001"),
});

export const config = schema.parse(process.env);
export type Config = z.infer<typeof schema>;

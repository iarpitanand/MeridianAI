# MeridianAI

AI PR review that knows your **whole repo**, not just the diff.

On every pull request, MeridianAI posts one summary comment plus a few
high-value inline suggestions (with GitHub "Commit suggestion" buttons). It
reviews with whole-repo context — callers of changed symbols, semantically
related code — and stays quiet where there's nothing worth saying.

## The full pipeline

```
GitHub PR event ──► webhook server ──► Redis / BullMQ ──► worker
   (HMAC verified)     (verify,            (debounce)        │
                        dedupe,                              ▼
                        enqueue)                    ┌──────────────────┐
                                                    │  review pipeline │
 push to default branch ──► index queue ──► worker  │                  │
   (incremental re-index)                     │     │ 1 context pack   │
 install ──► index queue ──► worker           │     │ 2 reviewer (LLM) │
   (full index)                               │     │ 3 critic (LLM)   │
                                              ▼     │ 4 filter+anchor  │
                                   tree-sitter + embeddings   │        │
                                   → Postgres/pgvector        └────┬─────┘
                                                                   ▼
                                              one review: summary + inline
                                              suggestions ──► GitHub PR
```

## What's built

- **Webhook + queue + worker** — verified, deduped, debounced job pipeline.
- **Indexing service** — tree-sitter symbols + call graph, embeddings → pgvector.
  Full index on install, incremental on push. 7 languages.
- **Context pack** — per PR: full changed files, callers of changed symbols
  (the blast radius), semantic neighbours, token-budgeted. Never stores code at rest.
- **LLM pipeline** — reviewer (Claude Sonnet) finds issues → critic (Claude Haiku)
  scores them → mechanical filter anchors, dedupes, thresholds, caps.
- **Line-anchor validator** — snaps findings to valid diff lines or demotes them
  to the summary (no 422s, no lost comments).
- **Inline suggestions** — ```suggestion``` blocks where a concrete fix exists.
- **Rules engine** — deterministic `.meridian.yml` regex rules that always fire.
- **Config** — `.meridian.yml` (depth, caps, ignore paths, instructions, rules)
  merged over defaults; fails open with a warning.
- **Check run** — live status in the merge box; never blocks the merge.

Graceful degradation: without `ANTHROPIC_API_KEY` reviews still post (change-size
summary); without `VOYAGE_API_KEY` the call graph still builds (no semantic search).

## Prerequisites

- Node.js 20+
- Neon Postgres (`DATABASE_URL`)
- Redis (`REDIS_URL`) — self-hosted / always-on recommended for BullMQ
- A GitHub App
- Optional: `ANTHROPIC_API_KEY` (reviews), `VOYAGE_API_KEY` (semantic search)

## 1. Create the GitHub App

Settings → Developer settings → GitHub Apps → New GitHub App.

- **Webhook URL:** your public URL (smee.io / tunnel in dev)
- **Webhook secret:** random string → `WEBHOOK_SECRET`
- **Repository permissions:** Pull requests R/W · Contents R · Checks R/W · Metadata R
- **Subscribe to events:** Pull request, Push, Installation, Installation repositories, Issue comment
- Note the **App ID**, generate a **private key** (.pem), install on a test repo.

## 2. Configure & install

```bash
cp .env.example .env      # fill in the values
npm install
```

`PRIVATE_KEY`: paste the PEM on one line with `\n` for newlines.

## 3. Migrate

```bash
npm run db:migrate
```

## 4. Run (two processes)

```bash
npm run dev:server   # webhook receiver on :3000
npm run dev:worker   # queue consumer (reviews + indexing)
```

Local webhooks:

```bash
npx smee-client --url https://smee.io/your-channel --target http://localhost:3000/api/github/webhooks
```

## Verify

1. Install on a test repo → worker full-indexes it (watch the logs).
2. Open a PR → within ~75s you get 👀, a check run, and one review with a
   summary + inline suggestions.
3. Push a fix → the summary comment updates.

## Project layout

```
src/
  server.ts            webhook receiver (Probot)
  worker.ts            BullMQ workers: reviews + indexing
  probot-app.ts        webhook handlers -> enqueue
  queue.ts             review queue
  config.ts db.ts redis.ts
  db/repos.ts          installations/repos upserts
  lib/dedupe.ts        delivery-id dedupe
  index/               INDEXING SERVICE
    languages.ts       tree-sitter queries (7 languages)
    parser.ts chunk.ts embed.ts github.ts store.ts indexRepo.ts queue.ts
  review/              REVIEW PIPELINE
    diff.ts            unified-diff parser (right-side line tracking)
    anchor.ts          line-anchor + suggestion validator
    context.ts         context pack builder
    content.ts         file-at-ref fetch
    meridianConfig.ts  .meridian.yml loader
    rules.ts           deterministic rules engine
    reviewer.ts        LLM pass 1 (findings + summary)
    critic.ts          LLM pass 2 (selectivity scoring)
    pipeline.ts        orchestration + mechanical filter
    types.ts
    run.ts             fetch -> pipeline -> post review + check run
  llm/anthropic.ts     Anthropic client + forced tool-use helper
db/schema.sql          Neon schema (+ pgvector)
scripts/migrate.ts
meridian.example.yml   sample repo config
```

## Notes / decisions

- `web-tree-sitter` pinned to 0.24.7 (grammar ABI compatibility).
- References resolve by name (robust to indexing order; ~80% precision — SCIP later).
- Models: `claude-sonnet-5` (reviewer) / `claude-haiku-4-5-20251001` (critic), env-overridable.

## What's built (dashboard)

- **Sign in with GitHub + connect repos** — OAuth login, `GET /user/installations`
  is the only source of truth for authorization (never the DB alone).
  Server-rendered pages mounted on the same Express instance as the webhook
  receiver (`src/dashboard/`) — no separate frontend app.
- **Onboarding state machine** at `/` — no install / pending admin approval /
  indexing / ready, plus the repos list (index status, review count).
- **Per-repo settings** at `/repos/:id/settings` — depth, max comments, ignore
  paths, custom instructions. Stored in `repos.config`; `.meridian.yml` always
  wins over these when both set the same field.
- **`@meridianai validate`** PR comment command — replies with the effective
  resolved config for that PR.

## Not yet built (next)

- Team/billing/analytics dashboard screens (deliberately deferred — thin launch).
- Next.js rebuild of the dashboard, if/when it outgrows server-rendered pages.
- Re-review housekeeping: resolve/minimize stale threads on `synchronize`.
- Learning loop: feed `findings.outcome` back into per-repo thresholds.

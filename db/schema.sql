-- MeridianAI schema (Neon Postgres)
-- Safe to re-run: everything is IF NOT EXISTS / idempotent.

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Onboarding: who installed us, on which repos
-- ---------------------------------------------------------------------------
create table if not exists installations (
  installation_id bigint primary key,
  account         text not null,
  account_type    text not null default 'User',
  status          text not null default 'active',   -- active | suspended | deleted
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists repos (
  repo_id          bigint primary key,
  installation_id  bigint not null references installations(installation_id) on delete cascade,
  owner            text not null,
  name             text not null,
  default_branch   text not null default 'main',
  enabled          boolean not null default true,
  config           jsonb not null default '{}'::jsonb,   -- resolved .meridian.yml + dashboard settings
  index_status     text not null default 'pending',      -- pending | indexing | ready | failed
  last_indexed_sha text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists repos_installation_idx on repos(installation_id);

-- ---------------------------------------------------------------------------
-- Review lifecycle
-- ---------------------------------------------------------------------------
create table if not exists reviews (
  id           bigint generated always as identity primary key,
  repo_id      bigint not null references repos(repo_id) on delete cascade,
  pr_number    integer not null,
  head_sha     text not null,
  status       text not null default 'running',   -- running | posted | superseded | skipped | failed
  tokens_used  integer,
  started_at   timestamptz not null default now(),
  posted_at    timestamptz
);
create index if not exists reviews_repo_pr_idx on reviews(repo_id, pr_number);
create index if not exists reviews_head_sha_idx on reviews(repo_id, pr_number, head_sha);

create table if not exists findings (
  id                bigint generated always as identity primary key,
  review_id         bigint not null references reviews(id) on delete cascade,
  file              text not null,
  start_line        integer,
  end_line          integer,
  severity          text not null,   -- low | medium | high | critical
  confidence        real,
  category          text,            -- bug | security | perf | logic | style | rule
  body              text not null,
  suggestion        text,
  source            text not null default 'ai',   -- ai | rule
  posted_comment_id bigint,
  outcome           text,            -- committed | resolved | dismissed | ignored
  created_at        timestamptz not null default now()
);
create index if not exists findings_review_idx on findings(review_id);
create index if not exists findings_outcome_idx on findings(outcome);

-- ---------------------------------------------------------------------------
-- Repo index (populated by the indexing service — used from the context-pack step on)
-- ---------------------------------------------------------------------------
create table if not exists files (
  id            bigint generated always as identity primary key,
  repo_id       bigint not null references repos(repo_id) on delete cascade,
  path          text not null,
  content_hash  text not null,
  last_indexed_sha text,
  unique (repo_id, path)
);

create table if not exists symbols (
  id          bigint generated always as identity primary key,
  repo_id     bigint not null references repos(repo_id) on delete cascade,
  file_path   text not null,
  symbol_name text not null,
  kind        text,            -- function | class | method | export | ...
  start_line  integer not null,
  end_line    integer not null,
  language    text
);
create index if not exists symbols_lookup_idx on symbols(repo_id, symbol_name);
create index if not exists symbols_file_idx on symbols(repo_id, file_path);

-- References are stored by callee NAME and resolved at query time.
-- This is robust to indexing order (the target may be indexed later) and
-- matches the tree-sitter "80% precision" tradeoff. "Who calls getUser?" =
--   select ref_file, ref_line from symbol_refs where repo_id=? and ref_name='getUser'
create table if not exists symbol_refs (
  id         bigint generated always as identity primary key,
  repo_id    bigint not null references repos(repo_id) on delete cascade,
  ref_name   text not null,
  ref_file   text not null,
  ref_line   integer not null
);
create index if not exists symbol_refs_name_idx on symbol_refs(repo_id, ref_name);

-- Embeddings for semantic retrieval.
-- NOTE: vector dimension must match your embedding model.
--   voyage-code-3 / voyage-4 default = 1024. Change here if you pick another model.
create table if not exists code_chunks (
  id           bigint generated always as identity primary key,
  repo_id      bigint not null references repos(repo_id) on delete cascade,
  file_path    text not null,
  symbol_name  text,
  start_line   integer,
  end_line     integer,
  content_hash text not null,
  embedding    vector(1024)
);
create index if not exists code_chunks_repo_idx on code_chunks(repo_id);
-- Approximate nearest-neighbour index (build after you have data; HNSW is read-optimised).
create index if not exists code_chunks_embedding_idx
  on code_chunks using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Dashboard: "Sign in with GitHub" + connect repos
-- ---------------------------------------------------------------------------
create table if not exists users (
  id                        bigint generated always as identity primary key,
  github_id                 bigint unique not null,
  username                  text not null,
  avatar_url                text,
  access_token_enc          text,   -- AES-256-GCM, base64(iv || authTag || ciphertext)
  refresh_token_enc         text,
  token_expires_at          timestamptz,
  refresh_token_expires_at  timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create table if not exists sessions (
  id          text primary key,   -- crypto.randomBytes(32).toString('hex')
  user_id     bigint not null references users(id) on delete cascade,
  csrf_token  text not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions(user_id);

-- Which installations a logged-in user genuinely has access to (many-to-many:
-- one user can belong to several orgs/accounts, one installation can have
-- several admins). Always re-verified against GET /user/installations —
-- never trust this table alone for authorization.
create table if not exists user_installations (
  user_id          bigint not null references users(id) on delete cascade,
  installation_id  bigint not null references installations(installation_id) on delete cascade,
  created_at       timestamptz not null default now(),
  primary key (user_id, installation_id)
);

-- A user started the GitHub App install flow but isn't an org admin, so
-- GitHub is waiting on approval. No "installation_request" webhook exists —
-- this is populated from the Setup URL callback (setup_action=request).
create table if not exists installation_requests (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists installation_requests_user_idx on installation_requests(user_id);

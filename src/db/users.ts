import { query } from "../db.js";
import { upsertInstallation } from "./repos.js";

export interface UserRow {
  id: number;
  githubId: number;
  username: string;
  avatarUrl: string | null;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}

interface UserRowDb {
  id: string;
  github_id: string;
  username: string;
  avatar_url: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: Date | null;
  refresh_token_expires_at: Date | null;
}

function fromDb(row: UserRowDb): UserRow {
  return {
    id: Number(row.id),
    githubId: Number(row.github_id),
    username: row.username,
    avatarUrl: row.avatar_url,
    accessTokenEnc: row.access_token_enc,
    refreshTokenEnc: row.refresh_token_enc,
    tokenExpiresAt: row.token_expires_at,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
  };
}

export async function upsertUser(u: {
  githubId: number;
  username: string;
  avatarUrl: string | null;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}): Promise<UserRow> {
  const res = await query<UserRowDb>(
    `insert into users (github_id, username, avatar_url, access_token_enc, refresh_token_enc, token_expires_at, refresh_token_expires_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (github_id) do update
       set username = excluded.username,
           avatar_url = excluded.avatar_url,
           access_token_enc = excluded.access_token_enc,
           refresh_token_enc = excluded.refresh_token_enc,
           token_expires_at = excluded.token_expires_at,
           refresh_token_expires_at = excluded.refresh_token_expires_at,
           updated_at = now()
     returning id, github_id, username, avatar_url, access_token_enc, refresh_token_enc, token_expires_at, refresh_token_expires_at`,
    [
      u.githubId,
      u.username,
      u.avatarUrl,
      u.accessTokenEnc,
      u.refreshTokenEnc,
      u.tokenExpiresAt,
      u.refreshTokenExpiresAt,
    ],
  );
  return fromDb(res.rows[0]);
}

export async function getUserById(id: number): Promise<UserRow | null> {
  const res = await query<UserRowDb>(`select * from users where id = $1`, [id]);
  return res.rows[0] ? fromDb(res.rows[0]) : null;
}

/** Upserts the parent installation row (from a live GET /user/installations entry) then links it to the user. */
export async function linkUserInstallation(
  userId: number,
  installation: { id: number; account: string; accountType: string },
): Promise<void> {
  await upsertInstallation({
    installationId: installation.id,
    account: installation.account,
    accountType: installation.accountType,
  });
  await query(
    `insert into user_installations (user_id, installation_id)
     values ($1, $2) on conflict do nothing`,
    [userId, installation.id],
  );
}

export interface UserRepoRow {
  repoId: number;
  owner: string;
  name: string;
  enabled: boolean;
  indexStatus: string;
  lastIndexedSha: string | null;
  reviewsCount: number;
}

export interface UserInstallationRow {
  installationId: number;
  account: string;
  accountType: string;
  status: string;
  repos: UserRepoRow[];
}

export async function getUserInstallationsAndRepos(
  userId: number,
): Promise<UserInstallationRow[]> {
  const res = await query<{
    installation_id: string;
    account: string;
    account_type: string;
    status: string;
    repo_id: string | null;
    owner: string | null;
    name: string | null;
    enabled: boolean | null;
    index_status: string | null;
    last_indexed_sha: string | null;
    reviews_count: string | null;
  }>(
    `select i.installation_id, i.account, i.account_type, i.status,
            r.repo_id, r.owner, r.name, r.enabled, r.index_status, r.last_indexed_sha,
            (select count(*) from reviews rv where rv.repo_id = r.repo_id) as reviews_count
     from user_installations ui
     join installations i on i.installation_id = ui.installation_id
     left join repos r on r.installation_id = i.installation_id
     where ui.user_id = $1
     order by i.installation_id, r.name`,
    [userId],
  );

  const byInstallation = new Map<number, UserInstallationRow>();
  for (const row of res.rows) {
    const id = Number(row.installation_id);
    let inst = byInstallation.get(id);
    if (!inst) {
      inst = {
        installationId: id,
        account: row.account,
        accountType: row.account_type,
        status: row.status,
        repos: [],
      };
      byInstallation.set(id, inst);
    }
    if (row.repo_id) {
      inst.repos.push({
        repoId: Number(row.repo_id),
        owner: row.owner!,
        name: row.name!,
        enabled: row.enabled!,
        indexStatus: row.index_status!,
        lastIndexedSha: row.last_indexed_sha,
        reviewsCount: Number(row.reviews_count ?? 0),
      });
    }
  }
  return [...byInstallation.values()];
}

export async function unlinkInstallation(installationId: number): Promise<void> {
  await query(`delete from user_installations where installation_id = $1`, [installationId]);
}

export async function createInstallationRequest(userId: number): Promise<void> {
  await query(`insert into installation_requests (user_id) values ($1)`, [userId]);
}

export async function clearInstallationRequest(userId: number): Promise<void> {
  await query(`delete from installation_requests where user_id = $1`, [userId]);
}

export async function hasPendingInstallationRequest(userId: number): Promise<boolean> {
  const res = await query(`select 1 from installation_requests where user_id = $1 limit 1`, [
    userId,
  ]);
  return (res.rowCount ?? 0) > 0;
}

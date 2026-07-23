import { query } from "../db.js";
import type { MeridianConfig } from "../review/meridianConfig.js";

export async function upsertInstallation(i: {
  installationId: number;
  account: string;
  accountType: string;
}): Promise<void> {
  await query(
    `insert into installations (installation_id, account, account_type, status)
     values ($1, $2, $3, 'active')
     on conflict (installation_id) do update
       set account = excluded.account,
           account_type = excluded.account_type,
           status = 'active',
           updated_at = now()`,
    [i.installationId, i.account, i.accountType],
  );
}

export async function markInstallationDeleted(installationId: number): Promise<void> {
  await query(
    `update installations set status = 'deleted', updated_at = now()
     where installation_id = $1`,
    [installationId],
  );
}

export async function updateInstallationStatus(
  installationId: number,
  status: "active" | "suspended",
): Promise<void> {
  await query(
    `update installations set status = $2, updated_at = now()
     where installation_id = $1`,
    [installationId, status],
  );
}

/** Deletes repo rows (cascades reviews/findings/index data) for an uninstall or repositories_removed. */
export async function deleteRepos(repoIds: number[]): Promise<void> {
  if (repoIds.length === 0) return;
  await query(`delete from repos where repo_id = any($1)`, [repoIds]);
}

export async function deleteReposForInstallation(installationId: number): Promise<void> {
  await query(`delete from repos where installation_id = $1`, [installationId]);
}

export async function upsertRepo(r: {
  repoId: number;
  installationId: number;
  owner: string;
  name: string;
  defaultBranch: string;
}): Promise<void> {
  await query(
    `insert into repos (repo_id, installation_id, owner, name, default_branch)
     values ($1, $2, $3, $4, $5)
     on conflict (repo_id) do update
       set installation_id = excluded.installation_id,
           owner = excluded.owner,
           name = excluded.name,
           default_branch = excluded.default_branch,
           updated_at = now()`,
    [r.repoId, r.installationId, r.owner, r.name, r.defaultBranch],
  );
}

export interface RepoRow {
  repoId: number;
  installationId: number;
  owner: string;
  name: string;
  enabled: boolean;
  indexStatus: string;
  config: Partial<MeridianConfig>;
}

interface RepoRowDb {
  repo_id: string;
  installation_id: string;
  owner: string;
  name: string;
  enabled: boolean;
  index_status: string;
  config: Partial<MeridianConfig>;
}

function fromRepoDb(row: RepoRowDb): RepoRow {
  return {
    repoId: Number(row.repo_id),
    installationId: Number(row.installation_id),
    owner: row.owner,
    name: row.name,
    enabled: row.enabled,
    indexStatus: row.index_status,
    config: row.config ?? {},
  };
}

export async function getRepo(repoId: number): Promise<RepoRow | null> {
  const res = await query<RepoRowDb>(
    `select repo_id, installation_id, owner, name, enabled, index_status, config
     from repos where repo_id = $1`,
    [repoId],
  );
  return res.rows[0] ? fromRepoDb(res.rows[0]) : null;
}

/** Same as getRepo, but scoped to repos the given user is authorized for
 * (their session's linked installations) — use this for anything reachable
 * from the dashboard, never getRepo() + a bare repo id from a URL. */
export async function getRepoForUser(userId: number, repoId: number): Promise<RepoRow | null> {
  const res = await query<RepoRowDb>(
    `select r.repo_id, r.installation_id, r.owner, r.name, r.enabled, r.index_status, r.config
     from repos r
     join user_installations ui on ui.installation_id = r.installation_id
     where r.repo_id = $1 and ui.user_id = $2`,
    [repoId, userId],
  );
  return res.rows[0] ? fromRepoDb(res.rows[0]) : null;
}

export async function updateRepoSettings(
  repoId: number,
  update: { enabled: boolean; config: Partial<MeridianConfig> },
): Promise<void> {
  await query(
    `update repos set enabled = $2, config = $3, updated_at = now() where repo_id = $1`,
    [repoId, update.enabled, JSON.stringify(update.config)],
  );
}

/** Disconnect/reconnect: leaves config + index data untouched. Durable — the
 * webhook upsert path never resets `enabled`, so a disconnected repo stays
 * disconnected until explicitly reconnected here. */
export async function setRepoEnabled(repoId: number, enabled: boolean): Promise<void> {
  await query(`update repos set enabled = $2, updated_at = now() where repo_id = $1`, [
    repoId,
    enabled,
  ]);
}

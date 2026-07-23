import { randomBytes } from "node:crypto";
import express, { type Request, type Response, Router } from "express";
import { config } from "../config.js";
import { getRepoForUser, updateRepoSettings } from "../db/repos.js";
import {
  clearInstallationRequest,
  createInstallationRequest,
  getUserById,
  getUserInstallationsAndRepos,
  hasPendingInstallationRequest,
  linkUserInstallation,
  upsertUser,
  type UserRow,
} from "../db/users.js";
import { decryptToken, encryptToken } from "./crypto.js";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  getGitHubUser,
  getUserInstallations,
  refreshAccessToken,
} from "./githubOAuth.js";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getSessionFromRequest,
  getSessionIdFromRequest,
  readAndClearStateCookie,
  type Session,
  setSessionCookie,
  setStateCookie,
} from "./session.js";
import type { MeridianConfig } from "../review/meridianConfig.js";

export const dashboardRouter = Router();
dashboardRouter.use(express.urlencoded({ extended: false }));

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)} · MeridianAI</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
  a.button { display: inline-block; background: #1a1a1a; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
  .repo { border: 1px solid #ddd; border-radius: 8px; padding: 14px 16px; margin: 10px 0; display: flex; justify-content: space-between; align-items: center; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #eee; }
  .badge.ready { background: #d5f5df; }
  .badge.indexing, .badge.pending { background: #fdf3d5; }
  form.settings label { display: block; margin-top: 14px; font-weight: 600; }
  form.settings input, form.settings select, form.settings textarea { width: 100%; padding: 6px 8px; margin-top: 4px; box-sizing: border-box; }
  form.settings button { margin-top: 18px; }
</style></head>
<body>${body}</body></html>`;
}

async function requireUser(req: Request, res: Response): Promise<UserRow | null> {
  const session = await getSessionFromRequest(req);
  if (!session) {
    res.redirect("/login");
    return null;
  }
  const user = await getUserById(session.userId);
  if (!user) {
    clearSessionCookie(res);
    res.redirect("/login");
    return null;
  }
  return user;
}

/** Decrypts the user's stored GitHub access token, refreshing it first if expired. */
async function getValidAccessToken(user: UserRow): Promise<string> {
  if (!user.accessTokenEnc) throw new Error("user has no stored access token");
  const expired = user.tokenExpiresAt !== null && user.tokenExpiresAt.getTime() < Date.now();
  if (!expired) return decryptToken(user.accessTokenEnc);

  if (!user.refreshTokenEnc) throw new Error("access token expired and no refresh token stored");
  const refreshed = await refreshAccessToken(decryptToken(user.refreshTokenEnc));
  const updated = await upsertUser({
    githubId: user.githubId,
    username: user.username,
    avatarUrl: user.avatarUrl,
    accessTokenEnc: encryptToken(refreshed.accessToken),
    refreshTokenEnc: refreshed.refreshToken ? encryptToken(refreshed.refreshToken) : null,
    tokenExpiresAt: refreshed.expiresAt,
    refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
  });
  return decryptToken(updated.accessTokenEnc!);
}

/**
 * Links every installation GitHub says this user genuinely has access to.
 * GitHub only hits the Setup URL after a *new* install/request completes —
 * if the user already had the app installed on their account (e.g. installed
 * once before ever signing in here, or "Connect repositories" just took them
 * straight to the existing installation's settings page because there was
 * nothing new to install), /install/setup never fires. Calling this from the
 * onboarding page too makes linking self-healing instead of depending on that
 * redirect happening at all.
 */
async function syncInstallations(user: UserRow): Promise<void> {
  const accessToken = await getValidAccessToken(user);
  const liveInstallations = await getUserInstallations(accessToken);
  for (const inst of liveInstallations) {
    await linkUserInstallation(user.id, inst);
  }
  if (liveInstallations.length > 0) await clearInstallationRequest(user.id);
}

// ---- Login ----

dashboardRouter.get("/login", (_req: Request, res: Response) => {
  const state = randomBytes(16).toString("hex");
  setStateCookie(res, state);
  res.redirect(buildAuthorizeUrl(state));
});

dashboardRouter.get("/auth/callback", async (req: Request, res: Response) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const expectedState = readAndClearStateCookie(req, res);

  if (!code || !state || state !== expectedState) {
    res.status(400).send(layout("Login failed", "<p>Invalid or expired login attempt. <a href=\"/login\">Try again</a>.</p>"));
    return;
  }

  try {
    const token = await exchangeCodeForToken(code);
    const ghUser = await getGitHubUser(token.accessToken);
    const user = await upsertUser({
      githubId: ghUser.id,
      username: ghUser.login,
      avatarUrl: ghUser.avatarUrl,
      accessTokenEnc: encryptToken(token.accessToken),
      refreshTokenEnc: token.refreshToken ? encryptToken(token.refreshToken) : null,
      tokenExpiresAt: token.expiresAt,
      refreshTokenExpiresAt: token.refreshTokenExpiresAt,
    });
    const session = await createSession(user.id);
    setSessionCookie(res, session.id);
    res.redirect("/");
  } catch (err) {
    res
      .status(500)
      .send(layout("Login failed", `<p>Could not complete GitHub login: ${escapeHtml((err as Error).message)}</p>`));
  }
});

dashboardRouter.get("/logout", async (req: Request, res: Response) => {
  const sessionId = getSessionIdFromRequest(req);
  if (sessionId) await destroySession(sessionId);
  clearSessionCookie(res);
  res.redirect("/");
});

// ---- Onboarding + repos list ----

dashboardRouter.get("/", async (req: Request, res: Response) => {
  const session: Session | null = await getSessionFromRequest(req);
  if (!session) {
    res.send(
      layout(
        "Welcome",
        `<header><h1>MeridianAI</h1><a class="button" href="/login">Sign in with GitHub</a></header>
         <p>AI PR review that knows your whole repo, not just the diff.</p>`,
      ),
    );
    return;
  }

  const user = await getUserById(session.userId);
  if (!user) {
    clearSessionCookie(res);
    res.redirect("/login");
    return;
  }

  let installations = await getUserInstallationsAndRepos(user.id);
  if (installations.length === 0) {
    // Covers the case where GitHub never hit /install/setup at all (see
    // syncInstallations' doc comment) — try a live lookup before giving up.
    try {
      await syncInstallations(user);
      installations = await getUserInstallationsAndRepos(user.id);
    } catch {
      // No stored token yet, or GitHub call failed — fall through to the
      // normal "connect repositories" / "pending approval" empty state.
    }
  }

  const installUrl = config.GITHUB_APP_SLUG
    ? `https://github.com/apps/${config.GITHUB_APP_SLUG}/installations/new`
    : "https://github.com/settings/installations";

  const header = `<header><h1>MeridianAI</h1><span>${escapeHtml(user.username)} · <a href="/logout">Sign out</a></span></header>`;

  if (installations.length === 0) {
    const pending = await hasPendingInstallationRequest(user.id);
    const body = pending
      ? `<p><span class="badge pending">Pending approval</span> An org admin needs to approve installing MeridianAI. We'll pick it up automatically once they do — refresh this page after they approve.</p>`
      : `<p>Connect a repository to get started — MeridianAI reviews every pull request automatically.</p>
         <a class="button" href="${installUrl}">Connect repositories</a>`;
    res.send(layout("Onboarding", header + body));
    return;
  }

  const rows = installations
    .flatMap((inst) =>
      inst.repos.map((r) => {
        const badgeClass = r.indexStatus === "ready" ? "ready" : "indexing";
        const badgeLabel = r.indexStatus === "ready" ? "Ready" : r.indexStatus;
        return `<div class="repo">
          <div><strong>${escapeHtml(inst.account)}/${escapeHtml(r.name)}</strong>
            <span class="badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>
            ${r.enabled ? "" : '<span class="badge">disabled</span>'}
            <div>${r.reviewsCount} review(s) run</div>
          </div>
          <a href="/repos/${r.repoId}/settings">Settings</a>
        </div>`;
      }),
    )
    .join("\n");

  res.send(
    layout(
      "Repos",
      `${header}<p><a class="button" href="${installUrl}">Connect repositories</a></p>${rows}`,
    ),
  );
});

// ---- GitHub App Setup URL callback ----

dashboardRouter.get("/install/setup", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const setupAction = req.query.setup_action;
  if (setupAction === "request") {
    // Non-admin install request — no installation_id exists yet.
    await createInstallationRequest(user.id);
    res.redirect("/");
    return;
  }

  try {
    await syncInstallations(user);
  } catch (err) {
    res
      .status(500)
      .send(layout("Setup failed", `<p>Could not confirm your installations: ${escapeHtml((err as Error).message)}</p>`));
    return;
  }
  res.redirect("/");
});

// ---- Repo settings ----

function renderSettingsForm(repoLabel: string, cfg: Partial<MeridianConfig>, enabled: boolean, csrfToken: string, saved: boolean): string {
  const depth = cfg.depth ?? "standard";
  const maxComments = cfg.maxComments ?? 10;
  const ignore = (cfg.ignore ?? []).join("\n");
  const instructions = cfg.instructions ?? "";
  return `<header><h1>${escapeHtml(repoLabel)}</h1><a href="/">&larr; Back</a></header>
${saved ? "<p><strong>Saved.</strong></p>" : ""}
<form class="settings" method="post">
  <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
  <label><input type="checkbox" name="enabled" ${enabled ? "checked" : ""}> Enabled</label>
  <label>Depth
    <select name="depth">
      ${(["chill", "standard", "strict"] as const)
        .map((d) => `<option value="${d}" ${d === depth ? "selected" : ""}>${d}</option>`)
        .join("")}
    </select>
  </label>
  <label>Max comments per PR
    <input type="number" name="max_comments" min="1" max="50" value="${maxComments}">
  </label>
  <label>Ignore paths (one glob per line)
    <textarea name="ignore" rows="4">${escapeHtml(ignore)}</textarea>
  </label>
  <label>Custom instructions
    <textarea name="instructions" rows="4">${escapeHtml(instructions)}</textarea>
  </label>
  <p style="color:#666;font-size:13px">A committed <code>.meridian.yml</code> overrides these settings field-by-field.</p>
  <button type="submit">Save</button>
</form>`;
}

dashboardRouter.get("/repos/:repoId/settings", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const repoId = Number(req.params.repoId);
  if (!Number.isInteger(repoId)) {
    res.status(400).send(layout("Not found", "<p>Invalid repo id.</p>"));
    return;
  }
  const repo = await getRepoForUser(user.id, repoId);
  if (!repo) {
    res.status(404).send(layout("Not found", "<p>Repo not found, or you don't have access to it.</p>"));
    return;
  }

  const session = await getSessionFromRequest(req);
  const body = renderSettingsForm(
    `${repo.owner}/${repo.name}`,
    repo.config,
    repo.enabled,
    session!.csrfToken,
    req.query.saved === "1",
  );
  res.send(layout("Repo settings", body));
});

dashboardRouter.post("/repos/:repoId/settings", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const session = await getSessionFromRequest(req);
  if (!session || req.body.csrf_token !== session.csrfToken) {
    res.status(403).send(layout("Forbidden", "<p>Invalid form submission — please reload the page and try again.</p>"));
    return;
  }

  const repoId = Number(req.params.repoId);
  if (!Number.isInteger(repoId)) {
    res.status(400).send(layout("Not found", "<p>Invalid repo id.</p>"));
    return;
  }
  const repo = await getRepoForUser(user.id, repoId);
  if (!repo) {
    res.status(404).send(layout("Not found", "<p>Repo not found, or you don't have access to it.</p>"));
    return;
  }

  const depthInput = String(req.body.depth ?? "");
  const depth: MeridianConfig["depth"] =
    depthInput === "chill" || depthInput === "strict" ? depthInput : "standard";
  const maxComments = Math.min(50, Math.max(1, parseInt(String(req.body.max_comments), 10) || 10));
  const ignore = String(req.body.ignore ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const instructions = String(req.body.instructions ?? "");
  const enabled = req.body.enabled !== undefined;

  await updateRepoSettings(repoId, {
    enabled,
    config: { depth, maxComments, ignore, instructions },
  });

  res.redirect(`/repos/${repoId}/settings?saved=1`);
});

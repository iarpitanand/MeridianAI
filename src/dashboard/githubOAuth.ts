import { config } from "../config.js";

const GITHUB_OAUTH_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_OAUTH_TOKEN = "https://github.com/login/oauth/access_token";

function requireClientCreds(): { id: string; secret: string } {
  if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) {
    throw new Error(
      "GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET are not set — required for Sign in with GitHub",
    );
  }
  return { id: config.GITHUB_CLIENT_ID, secret: config.GITHUB_CLIENT_SECRET };
}

function redirectUri(): string {
  return `${config.APP_BASE_URL}/auth/callback`;
}

export function buildAuthorizeUrl(state: string): string {
  const { id } = requireClientCreds();
  const url = new URL(GITHUB_OAUTH_AUTHORIZE);
  url.searchParams.set("client_id", id);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("state", state);
  return url.toString();
}

export interface TokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
}

async function requestToken(body: Record<string, string>): Promise<TokenResult> {
  const { id, secret } = requireClientCreds();
  const res = await fetch(GITHUB_OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: id, client_secret: secret, ...body }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token || data.error) {
    throw new Error(
      `GitHub OAuth token request failed: ${data.error_description ?? data.error ?? res.status}`,
    );
  }
  const now = Date.now();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in ? new Date(now + data.expires_in * 1000) : null,
    refreshTokenExpiresAt: data.refresh_token_expires_in
      ? new Date(now + data.refresh_token_expires_in * 1000)
      : null,
  };
}

export function exchangeCodeForToken(code: string): Promise<TokenResult> {
  return requestToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri() });
}

export function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  return requestToken({ grant_type: "refresh_token", refresh_token: refreshToken });
}

export interface GitHubUser {
  id: number;
  login: string;
  avatarUrl: string | null;
}

export async function getGitHubUser(accessToken: string): Promise<GitHubUser> {
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GET /user failed: ${res.status}`);
  const data = (await res.json()) as { id: number; login: string; avatar_url: string | null };
  return { id: data.id, login: data.login, avatarUrl: data.avatar_url };
}

export interface GitHubInstallation {
  id: number;
  account: string;
  accountType: string;
}

/** Live, authoritative list of installations this token's user actually has
 * access to — the only thing safe to trust for authorization (never the DB
 * alone, never a query param). */
export async function getUserInstallations(accessToken: string): Promise<GitHubInstallation[]> {
  const res = await fetch("https://api.github.com/user/installations", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GET /user/installations failed: ${res.status}`);
  const data = (await res.json()) as {
    installations: Array<{
      id: number;
      account: { login?: string; slug?: string; type?: string } | null;
    }>;
  };
  return data.installations.map((i) => ({
    id: i.id,
    account: i.account?.login ?? i.account?.slug ?? "unknown",
    accountType: i.account?.type ?? "User",
  }));
}

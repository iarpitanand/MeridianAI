import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { query } from "../db.js";
import { config } from "../config.js";
import { appendSetCookie, parseCookies, serializeCookie } from "./cookies.js";

const SESSION_COOKIE = "meridian_session";
const STATE_COOKIE = "meridian_oauth_state";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const STATE_TTL_SECONDS = 600; // 10 min, single-use

function isSecure(): boolean {
  return config.APP_BASE_URL.startsWith("https://");
}

export interface Session {
  id: string;
  userId: number;
  csrfToken: string;
}

export async function createSession(userId: number): Promise<Session> {
  const id = randomBytes(32).toString("hex");
  const csrfToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await query(
    `insert into sessions (id, user_id, csrf_token, expires_at) values ($1, $2, $3, $4)`,
    [id, userId, csrfToken, expiresAt],
  );
  return { id, userId, csrfToken };
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const res = await query<{ id: string; user_id: string; csrf_token: string }>(
    `select id, user_id, csrf_token from sessions where id = $1 and expires_at > now()`,
    [sessionId],
  );
  const row = res.rows[0];
  return row ? { id: row.id, userId: Number(row.user_id), csrfToken: row.csrf_token } : null;
}

export async function destroySession(sessionId: string): Promise<void> {
  await query(`delete from sessions where id = $1`, [sessionId]);
}

export async function getSessionFromRequest(req: Request): Promise<Session | null> {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return null;
  return getSession(sessionId);
}

export function getSessionIdFromRequest(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

export function setSessionCookie(res: Response, sessionId: string): void {
  appendSetCookie(
    res,
    serializeCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: isSecure(),
      sameSite: "Lax",
      maxAge: SESSION_TTL_SECONDS,
    }),
  );
}

export function clearSessionCookie(res: Response): void {
  appendSetCookie(res, serializeCookie(SESSION_COOKIE, "", { maxAge: 0 }));
}

// ---- OAuth `state` cookie (CSRF protection for the /login -> /auth/callback round trip) ----

export function setStateCookie(res: Response, state: string): void {
  appendSetCookie(
    res,
    serializeCookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure: isSecure(),
      sameSite: "Lax",
      maxAge: STATE_TTL_SECONDS,
    }),
  );
}

/** Reads the state cookie and queues its removal (single-use) in the same response. */
export function readAndClearStateCookie(req: Request, res: Response): string | undefined {
  const state = parseCookies(req.headers.cookie)[STATE_COOKIE];
  appendSetCookie(res, serializeCookie(STATE_COOKIE, "", { maxAge: 0 }));
  return state;
}

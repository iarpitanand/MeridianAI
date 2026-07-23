import { randomBytes } from "node:crypto";
import express, { type Request, type Response, Router } from "express";
import { config } from "../config.js";
import { getRepoForUser, setRepoEnabled, updateRepoSettings } from "../db/repos.js";
import {
  clearInstallationRequest,
  createInstallationRequest,
  getUserById,
  getUserInstallationsAndRepos,
  hasPendingInstallationRequest,
  linkUserInstallation,
  upsertUser,
  type UserInstallationRow,
  type UserRepoRow,
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

// ---- Rendering primitives ----

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="black"/><path d="M8 23V9l8 8 8-8v14" stroke="white" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
)}`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · MeridianAI</title>
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  @view-transition { navigation: auto; }
  :root {
    --bg: #ffffff; --surface: #fafafa; --surface-2: #f0f0f0;
    --border: #e6e6e6; --text: #0a0a0a; --text-2: #58585a; --text-3: #9a9a9c;
    --radius: 10px;
    --ease: cubic-bezier(.16, 1, .3, 1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0a0a; --surface: #141414; --surface-2: #1c1c1e;
      --border: #2a2a2c; --text: #f5f5f5; --text-2: #a3a3a5; --text-3: #6b6b6d;
    }
  }
  * { box-sizing: border-box; }
  html { color-scheme: light dark; scroll-behavior: smooth; }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    margin: 0; background: var(--bg); color: var(--text); line-height: 1.5;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  a { color: inherit; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  ::selection { background: var(--text); color: var(--bg); }
  * { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 8px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text-3); }
  :focus-visible { outline: 2px solid var(--text); outline-offset: 3px; border-radius: 4px; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes shimmer { 0%, 100% { opacity: .3; } 50% { opacity: 1; } }
  @keyframes slideDown { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
  .fade-up { animation: fadeUp .6s var(--ease) both; }
  .fade { animation: fade .5s ease both; }
  .stagger > * { opacity: 0; animation: fadeUp .5s var(--ease) both; }
  .stagger > *:nth-child(1) { animation-delay: .03s; }
  .stagger > *:nth-child(2) { animation-delay: .09s; }
  .stagger > *:nth-child(3) { animation-delay: .15s; }
  .stagger > *:nth-child(4) { animation-delay: .21s; }
  .stagger > *:nth-child(5) { animation-delay: .27s; }
  .stagger > *:nth-child(n+6) { animation-delay: .3s; }
  .btn {
    display: inline-flex; align-items: center; gap: 8px; justify-content: center;
    padding: 10px 20px; border-radius: 8px; font-weight: 500; font-size: 14px;
    text-decoration: none; border: 1px solid transparent; cursor: pointer;
    font-family: inherit; transition: transform .2s var(--ease), background .2s var(--ease), border-color .2s var(--ease), opacity .2s var(--ease), box-shadow .2s var(--ease);
  }
  .btn:active { transform: scale(0.96); }
  .btn-primary { background: var(--text); color: var(--bg); }
  .btn-primary:hover { opacity: .84; transform: translateY(-1px); }
  .btn-arrow .arrow { display: inline-block; transition: transform .25s var(--ease); }
  .btn-arrow:hover .arrow { transform: translateX(3px); }
  .btn-ghost { background: transparent; color: var(--text); border-color: var(--border); }
  .btn-ghost:hover { border-color: var(--text-2); transform: translateY(-1px); }
  .btn-danger { background: transparent; color: var(--text); border-color: var(--border); }
  .btn-danger:hover { border-color: var(--text); background: var(--surface-2); transform: translateY(-1px); }
  .btn-sm { padding: 6px 14px; font-size: 13px; }
  .card {
    border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
    transition: border-color .25s var(--ease), transform .25s var(--ease), box-shadow .25s var(--ease);
  }
  .card:hover { border-color: var(--text-3); transform: translateY(-2px); box-shadow: 0 6px 20px -8px rgba(0,0,0,.15); }
  .landing-shell { display: flex; flex-direction: column; min-height: 100dvh; }
  .landing-hero-row { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 32px; padding: 16px 0 40px; }
  .landing-copy { text-align: left; }
  .eyebrow { font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--text-3); margin-bottom: 14px; }
  .landing-features { display: flex; flex-direction: column; gap: 9px; margin-top: 28px; font-size: 13px; color: var(--text-2); }
  .landing-features .tick { color: var(--text); margin-right: 8px; }
  .landing-steps {
    display: flex; align-items: center; justify-content: center; flex-wrap: wrap;
    gap: 10px 18px; padding: 22px 32px; border-top: 1px solid var(--border); font-size: 13px; color: var(--text-2);
  }
  .landing-steps .step { display: flex; align-items: center; gap: 8px; }
  .landing-steps .step b { color: var(--text); font-weight: 500; }
  .landing-steps .step-num {
    display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
    border-radius: 50%; background: var(--surface-2); font-size: 10px; font-weight: 600; color: var(--text); flex-shrink: 0;
  }
  .landing-steps .divider { color: var(--text-3); }
  .landing-trust {
    text-align: center; padding: 16px 32px; border-bottom: 1px solid var(--border);
    font-size: 13px; color: var(--text-3);
  }
  @media (min-width: 900px) {
    .landing-shell { height: 100dvh; overflow: hidden; }
    .landing-hero-row { flex-direction: row; align-items: center; gap: 64px; }
    .landing-copy, .landing-mockup { flex: 1; min-width: 0; }
    .landing-features { flex-direction: row; gap: 22px; }
  }
  .nav-link { position: relative; padding: 8px 1px; font-size: 14px; font-weight: 500; text-decoration: none; transition: color .2s ease; }
  .nav-link::after {
    content: ""; position: absolute; left: 0; right: 0; bottom: -13px; height: 2px; background: var(--text);
    transform: scaleX(0); transform-origin: center; transition: transform .3s var(--ease), opacity .3s var(--ease);
  }
  .nav-link.active::after { transform: scaleX(1); }
  .nav-link:not(.active) { color: var(--text-2); }
  .nav-link:not(.active):hover::after { transform: scaleX(1); opacity: .35; }
  form.settings label { display: block; margin-top: 16px; font-weight: 500; font-size: 13px; color: var(--text-2); }
  form.settings input, form.settings select, form.settings textarea {
    width: 100%; padding: 9px 11px; margin-top: 6px; box-sizing: border-box;
    border: 1px solid var(--border); border-radius: 8px; font-family: inherit; font-size: 14px;
    background: var(--surface); color: var(--text); transition: border-color .2s ease;
  }
  form.settings input:focus, form.settings select:focus, form.settings textarea:focus {
    outline: none; border-color: var(--text-2);
  }
  form.settings button { margin-top: 22px; }
</style></head>
<body>${body}</body></html>`;
}

function errorPage(title: string, message: string): string {
  return layout(
    title,
    `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
      <div class="fade-up" style="max-width:400px;text-align:center">
        <div style="font-weight:600;font-size:17px;margin-bottom:8px">${escapeHtml(title)}</div>
        <div style="font-size:14px;color:var(--text-2);margin-bottom:20px">${message}</div>
        <a href="/" class="btn btn-ghost btn-sm">Go home</a>
      </div>
    </div>`,
  );
}

function avatarEl(user: UserRow, size: number): string {
  if (user.avatarUrl) {
    return `<img src="${escapeHtml(user.avatarUrl)}" alt="" width="${size}" height="${size}" style="border-radius:50%;filter:grayscale(1);object-fit:cover;display:block">`;
  }
  const initial = user.username.slice(0, 1).toUpperCase();
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:var(--surface-2);display:flex;align-items:center;justify-content:center;font-size:${Math.round(size * 0.35)}px;font-weight:600">${escapeHtml(initial)}</div>`;
}

type Tab = "repositories" | "account";

function navBar(user: UserRow, activeTab: Tab): string {
  const tab = (id: Tab, label: string, href: string): string =>
    `<a href="${href}" class="nav-link${id === activeTab ? " active" : ""}">${label}</a>`;
  return `<nav style="position:sticky;top:0;background:color-mix(in srgb, var(--bg) 82%, transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--border);z-index:10">
    <div style="max-width:960px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;height:60px">
      <div style="display:flex;align-items:center;gap:36px">
        <a href="/app/repositories" style="font-weight:700;font-size:16px;letter-spacing:-0.02em;text-decoration:none">MeridianAI</a>
        <div style="display:flex;gap:28px">
          ${tab("repositories", "Repositories", "/app/repositories")}
          ${tab("account", "Account", "/app/account")}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        ${avatarEl(user, 26)}
        <span style="font-size:14px;color:var(--text-2)">${escapeHtml(user.username)}</span>
        <a href="/logout" class="btn btn-ghost btn-sm">Sign out</a>
      </div>
    </div>
  </nav>`;
}

function appShell(user: UserRow, activeTab: Tab, title: string, body: string): string {
  return layout(
    title,
    `${navBar(user, activeTab)}<main style="max-width:960px;margin:0 auto;padding:36px 24px 80px" class="fade-up">${body}</main>`,
  );
}

const FLASH_MESSAGES: Record<string, string> = {
  saved: "Settings saved.",
  disconnected: "Repository disconnected — reviews paused, index data kept.",
  reconnected: "Repository reconnected.",
};

function flashBanner(req: Request): string {
  const key = typeof req.query.flash === "string" ? req.query.flash : undefined;
  const message = key ? FLASH_MESSAGES[key] : undefined;
  if (!message) return "";
  return `<div id="flash" style="animation:slideDown .4s var(--ease) both;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;margin-bottom:20px;font-size:14px;display:flex;justify-content:space-between;align-items:center;gap:12px">
    <span>${escapeHtml(message)}</span>
    <button onclick="this.closest('#flash').style.display='none'" aria-label="Dismiss" style="background:none;border:none;color:var(--text-3);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;font-family:inherit">&times;</button>
  </div>
  <script>setTimeout(()=>{const f=document.getElementById('flash');if(f){f.style.transition='opacity .4s ease, transform .4s ease';f.style.opacity='0';f.style.transform='translateY(-6px)';setTimeout(()=>f.style.display='none',400);}},4000);</script>`;
}

function emptyState(title: string, body: string, ctaHref?: string, ctaLabel?: string): string {
  return `<div class="fade-up" style="text-align:center;padding:80px 20px;border:1px dashed var(--border);border-radius:var(--radius)">
    <div style="font-size:17px;font-weight:600;margin-bottom:8px">${escapeHtml(title)}</div>
    <div style="font-size:14px;color:var(--text-2);max-width:420px;margin:0 auto 24px">${escapeHtml(body)}</div>
    ${ctaHref ? `<a href="${ctaHref}" class="btn btn-primary">${escapeHtml(ctaLabel ?? "")}</a>` : ""}
  </div>`;
}

const STATUS_GLYPH: Record<string, { glyph: string; label: string; pulse?: boolean }> = {
  ready: { glyph: "●", label: "Ready" },
  indexing: { glyph: "◐", label: "Indexing…", pulse: true },
  pending: { glyph: "◐", label: "Queued", pulse: true },
  failed: { glyph: "✕", label: "Failed" },
};

function statusBadge(indexStatus: string, enabled: boolean): string {
  if (!enabled) {
    return `<span style="display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--text-3)"><span>○</span>Disconnected</span>`;
  }
  const s = STATUS_GLYPH[indexStatus] ?? { glyph: "○", label: indexStatus };
  return `<span style="display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--text-2)"><span${s.pulse ? ' style="display:inline-block;animation:shimmer 1.6s ease-in-out infinite"' : ""}>${s.glyph}</span>${escapeHtml(s.label)}</span>`;
}

function repoCard(inst: UserInstallationRow, r: UserRepoRow, csrfToken: string): string {
  const shaHtml = r.lastIndexedSha
    ? `<span class="mono" style="font-size:12px;color:var(--text-3)">${escapeHtml(r.lastIndexedSha.slice(0, 7))}</span>`
    : "";
  return `<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:16px;padding:16px 18px;margin-bottom:10px;${r.enabled ? "" : "opacity:.55"}">
    <div>
      <div style="font-weight:500;font-size:14px;margin-bottom:6px">${escapeHtml(inst.account)}/${escapeHtml(r.name)}</div>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        ${statusBadge(r.indexStatus, r.enabled)}
        ${shaHtml}
        <span style="font-size:13px;color:var(--text-3)">${r.reviewsCount} review(s)</span>
      </div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;white-space:nowrap">
      <a href="/repos/${r.repoId}/settings" class="btn btn-ghost btn-sm">Settings</a>
      <form method="post" action="/repos/${r.repoId}/toggle" style="display:inline">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
        <button type="submit" class="btn ${r.enabled ? "btn-danger" : "btn-primary"} btn-sm">${r.enabled ? "Disconnect" : "Reconnect"}</button>
      </form>
    </div>
  </div>`;
}

function installGroup(inst: UserInstallationRow, csrfToken: string): string {
  const manageUrl = `https://github.com/settings/installations/${inst.installationId}`;
  return `<div style="margin-bottom:32px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <span style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3)">${escapeHtml(inst.account)}</span>
      <a href="${manageUrl}" target="_blank" rel="noopener" style="font-size:12px;color:var(--text-3);text-decoration:none">Manage on GitHub &rarr;</a>
    </div>
    <div class="stagger">${inst.repos.map((r) => repoCard(inst, r, csrfToken)).join("")}</div>
  </div>`;
}

function commentMockup(): string {
  return `<div class="card fade-up landing-mockup" style="max-width:440px;width:100%;margin:0 auto;padding:0;overflow:hidden;text-align:left;animation-delay:.15s">
    <div style="padding:11px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text-2)">
      <span class="mono">src/loop.js</span>
      <span style="color:var(--text-3)">&middot;</span>
      <span>lines 2&ndash;6</span>
    </div>
    <div style="padding:16px;display:flex;gap:11px">
      <div style="width:22px;height:22px;border-radius:6px;background:var(--surface-2);display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0;margin-top:1px">✕</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12.5px;font-weight:500;margin-bottom:4px">critical &middot; bug</div>
        <div style="font-size:12.5px;color:var(--text-2);margin-bottom:11px">The while loop condition never changes because <code class="mono">i</code> is never incremented &mdash; infinite loop.</div>
        <div class="mono" style="font-size:12px;background:var(--surface-2);border-radius:8px;padding:9px 0;line-height:1.65">
          <div style="padding:0 11px">let i = 0;</div>
          <div style="padding:0 11px">while (i &lt; 5) {</div>
          <div style="padding:0 11px">&nbsp;&nbsp;console.log("Stuck at:", i);</div>
          <div style="background:color-mix(in srgb, var(--text) 9%, transparent);padding:0 11px">+&nbsp;&nbsp;i++;</div>
          <div style="padding:0 11px">}</div>
        </div>
        <div style="margin-top:11px"><span class="btn btn-primary btn-sm" style="cursor:default;pointer-events:none">Commit suggestion</span></div>
      </div>
    </div>
  </div>`;
}

function landingPage(): string {
  return layout(
    "MeridianAI",
    `<div class="landing-shell">
      <nav style="max-width:1080px;width:100%;margin:0 auto;padding:20px 32px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-weight:700;font-size:16px;letter-spacing:-0.02em">MeridianAI</span>
        <a href="/login" style="font-size:14px;color:var(--text-2);text-decoration:none">Sign in</a>
      </nav>
      <div class="fade landing-trust">
        No credit card. No seat limits. Just connect a repo and start reviewing PRs.
      </div>
      <div class="landing-hero-row" style="max-width:1080px;width:100%;margin:0 auto;padding:0 32px">
        <div class="fade-up landing-copy">
          <div class="eyebrow">AI code review</div>
          <h1 style="font-size:clamp(30px,4vw,42px);font-weight:600;letter-spacing:-0.03em;line-height:1.15;margin:0 0 16px">AI PR review that knows your whole repo.</h1>
          <p style="font-size:15.5px;color:var(--text-2);margin:0 0 28px;max-width:440px">Not just the diff. MeridianAI indexes your codebase's call graph so every review understands the blast radius of a change &mdash; then posts one summary and a handful of high-value inline suggestions, with one-click commits.</p>
          <a href="/login" class="btn btn-primary btn-arrow" style="padding:13px 26px;font-size:15px">
            Get started
            <span class="arrow">&rarr;</span>
          </a>
          <div class="landing-features">
            <div><span class="tick">&check;</span>Whole-repo context</div>
            <div><span class="tick">&check;</span>Deterministic rules</div>
            <div><span class="tick">&check;</span>One-click fixes</div>
          </div>
        </div>
        ${commentMockup()}
      </div>
      <div class="fade landing-steps">
        <span class="step"><span class="step-num">1</span>Connect a repo &mdash; <b>one click</b></span>
        <span class="divider">&rarr;</span>
        <span class="step"><span class="step-num">2</span>We index the <b>call graph</b></span>
        <span class="divider">&rarr;</span>
        <span class="step"><span class="step-num">3</span>Every PR gets <b>reviewed automatically</b></span>
      </div>
    </div>`,
  );
}

function loginPage(): string {
  return layout(
    "Sign in",
    `<div class="fade-up" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
      <div style="max-width:340px;width:100%;text-align:center">
        <div style="font-weight:700;font-size:18px;margin-bottom:8px;letter-spacing:-0.02em">MeridianAI</div>
        <p style="color:var(--text-2);font-size:14px;margin-bottom:28px">Sign in to connect your repositories.</p>
        <a href="/login/github" class="btn btn-primary" style="width:100%;padding:12px">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          Continue with GitHub
        </a>
        <p style="margin-top:24px"><a href="/" style="color:var(--text-3);font-size:13px;text-decoration:none">&larr; Back home</a></p>
      </div>
    </div>`,
  );
}

// ---- Auth helpers ----

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
 * if the user already had the app installed (or "Connect repositories" just
 * took them straight to the existing installation's settings page because
 * there was nothing new to install), /install/setup never fires. Calling
 * this from the repositories tab too makes linking self-healing instead of
 * depending on that redirect happening at all.
 */
async function syncInstallations(user: UserRow): Promise<void> {
  const accessToken = await getValidAccessToken(user);
  const liveInstallations = await getUserInstallations(accessToken);
  for (const inst of liveInstallations) {
    await linkUserInstallation(user.id, inst);
  }
  if (liveInstallations.length > 0) await clearInstallationRequest(user.id);
}

// ---- Landing + Login ----

dashboardRouter.get("/", async (req: Request, res: Response) => {
  const session = await getSessionFromRequest(req);
  if (session) {
    res.redirect("/app/repositories");
    return;
  }
  res.send(landingPage());
});

dashboardRouter.get("/login", async (req: Request, res: Response) => {
  const session = await getSessionFromRequest(req);
  if (session) {
    res.redirect("/app/repositories");
    return;
  }
  res.send(loginPage());
});

dashboardRouter.get("/login/github", (_req: Request, res: Response) => {
  const state = randomBytes(16).toString("hex");
  setStateCookie(res, state);
  res.redirect(buildAuthorizeUrl(state));
});

dashboardRouter.get("/auth/callback", async (req: Request, res: Response) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  const expectedState = readAndClearStateCookie(req, res);

  if (!code || !state || state !== expectedState) {
    res.status(400).send(errorPage("Login failed", "Invalid or expired login attempt. <a href=\"/login\">Try again</a>."));
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
    res.redirect("/app/repositories");
  } catch (err) {
    res
      .status(500)
      .send(errorPage("Login failed", `Could not complete GitHub login: ${escapeHtml((err as Error).message)}`));
  }
});

dashboardRouter.get("/logout", async (req: Request, res: Response) => {
  const sessionId = getSessionIdFromRequest(req);
  if (sessionId) await destroySession(sessionId);
  clearSessionCookie(res);
  res.redirect("/");
});

// ---- Repositories tab ----

dashboardRouter.get("/app/repositories", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const session = await getSessionFromRequest(req);

  let installations = await getUserInstallationsAndRepos(user.id);
  if (installations.length === 0) {
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

  let body = flashBanner(req);

  if (installations.length === 0) {
    const pending = await hasPendingInstallationRequest(user.id);
    body += pending
      ? emptyState(
          "Pending approval",
          "An org admin needs to approve installing MeridianAI. We'll pick it up automatically once they do — refresh this page after they approve.",
        )
      : emptyState(
          "Connect a repository",
          "MeridianAI reviews every pull request automatically once connected.",
          installUrl,
          "Connect repositories",
        );
    res.send(appShell(user, "repositories", "Repositories", body));
    return;
  }

  body += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
    <h1 style="font-size:20px;font-weight:600;margin:0">Repositories</h1>
    <a href="${installUrl}" class="btn btn-ghost btn-sm">+ Connect repositories</a>
  </div>`;
  body += installations.map((inst) => installGroup(inst, session!.csrfToken)).join("");

  res.send(appShell(user, "repositories", "Repositories", body));
});

// ---- Account tab ----

dashboardRouter.get("/app/account", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const body = `
    <h1 style="font-size:20px;font-weight:600;margin:0 0 24px">Account</h1>
    <div class="fade-up" style="display:flex;gap:20px;align-items:center;padding:24px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:20px">
      ${avatarEl(user, 60)}
      <div>
        <div style="font-weight:600;font-size:16px">${escapeHtml(user.username)}</div>
        <a href="https://github.com/${escapeHtml(user.username)}" target="_blank" rel="noopener" style="font-size:13px;color:var(--text-2);text-decoration:none">github.com/${escapeHtml(user.username)} &rarr;</a>
      </div>
    </div>
    <div style="border:1px solid var(--border);border-radius:var(--radius);padding:20px">
      <div style="font-weight:500;font-size:14px;margin-bottom:4px">Sign out</div>
      <div style="font-size:13px;color:var(--text-2);margin-bottom:14px">Ends your session on this device.</div>
      <a href="/logout" class="btn btn-ghost btn-sm">Sign out</a>
    </div>`;

  res.send(appShell(user, "account", "Account", body));
});

// ---- GitHub App Setup URL callback ----

dashboardRouter.get("/install/setup", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const setupAction = req.query.setup_action;
  if (setupAction === "request") {
    // Non-admin install request — no installation_id exists yet.
    await createInstallationRequest(user.id);
    res.redirect("/app/repositories");
    return;
  }

  try {
    await syncInstallations(user);
  } catch (err) {
    res
      .status(500)
      .send(errorPage("Setup failed", `Could not confirm your installations: ${escapeHtml((err as Error).message)}`));
    return;
  }
  res.redirect("/app/repositories");
});

// ---- Quick disconnect/reconnect (durable: the webhook upsert path never
// re-enables a disabled repo, so this sticks until reversed here) ----

dashboardRouter.post("/repos/:repoId/toggle", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const session = await getSessionFromRequest(req);
  if (!session || req.body.csrf_token !== session.csrfToken) {
    res.status(403).send(errorPage("Forbidden", "Invalid form submission — please reload the page and try again."));
    return;
  }

  const repoId = Number(req.params.repoId);
  if (!Number.isInteger(repoId)) {
    res.status(400).send(errorPage("Not found", "Invalid repo id."));
    return;
  }
  const repo = await getRepoForUser(user.id, repoId);
  if (!repo) {
    res.status(404).send(errorPage("Not found", "Repo not found, or you don't have access to it."));
    return;
  }

  await setRepoEnabled(repoId, !repo.enabled);
  res.redirect(`/app/repositories?flash=${repo.enabled ? "disconnected" : "reconnected"}`);
});

// ---- Repo settings ----

function renderSettingsForm(
  repoLabel: string,
  cfg: Partial<MeridianConfig>,
  enabled: boolean,
  csrfToken: string,
): string {
  const depth = cfg.depth ?? "standard";
  const maxComments = cfg.maxComments ?? 10;
  const ignore = (cfg.ignore ?? []).join("\n");
  const instructions = cfg.instructions ?? "";
  return `<a href="/app/repositories" style="font-size:13px;color:var(--text-3);text-decoration:none">&larr; Repositories</a>
<h1 style="font-size:20px;font-weight:600;margin:14px 0 4px">${escapeHtml(repoLabel)}</h1>
<p style="font-size:13px;color:var(--text-3);margin:0 0 24px">Settings</p>
<form class="settings" method="post">
  <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
  <label><input type="checkbox" name="enabled" ${enabled ? "checked" : ""}> Connected (uncheck to disconnect — same as the button on the repo list)</label>
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
  <p style="color:var(--text-3);font-size:13px">A committed <code>.meridian.yml</code> overrides these settings field-by-field.</p>
  <button type="submit" class="btn btn-primary">Save</button>
</form>`;
}

dashboardRouter.get("/repos/:repoId/settings", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const repoId = Number(req.params.repoId);
  if (!Number.isInteger(repoId)) {
    res.status(400).send(errorPage("Not found", "Invalid repo id."));
    return;
  }
  const repo = await getRepoForUser(user.id, repoId);
  if (!repo) {
    res.status(404).send(errorPage("Not found", "Repo not found, or you don't have access to it."));
    return;
  }

  const session = await getSessionFromRequest(req);
  const body = flashBanner(req) + renderSettingsForm(`${repo.owner}/${repo.name}`, repo.config, repo.enabled, session!.csrfToken);
  res.send(appShell(user, "repositories", "Repo settings", body));
});

dashboardRouter.post("/repos/:repoId/settings", async (req: Request, res: Response) => {
  const user = await requireUser(req, res);
  if (!user) return;

  const session = await getSessionFromRequest(req);
  if (!session || req.body.csrf_token !== session.csrfToken) {
    res.status(403).send(errorPage("Forbidden", "Invalid form submission — please reload the page and try again."));
    return;
  }

  const repoId = Number(req.params.repoId);
  if (!Number.isInteger(repoId)) {
    res.status(400).send(errorPage("Not found", "Invalid repo id."));
    return;
  }
  const repo = await getRepoForUser(user.id, repoId);
  if (!repo) {
    res.status(404).send(errorPage("Not found", "Repo not found, or you don't have access to it."));
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

  res.redirect(`/repos/${repoId}/settings?flash=saved`);
});

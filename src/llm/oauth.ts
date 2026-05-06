// 1. This module owns Claude.ai Pro/Max OAuth login + refresh for the `anthropic` LLM preset.
// 2. Single-flight refresh via the module-level `inflightRefresh` Map<slug, Promise<OAuthSession>>.
// 3. Refresh-mutation contract: `withFreshToken(cfg, save)` mutates `cfg.llm.oauth` in-place and persists via `persistOAuth(cfg, session)` BEFORE resolving — callers may safely run `writeConfig(cfg)` afterwards without rolling back the new tokens.
// 4. Documented exception to CLAUDE.md "no new stateful classes besides Runtime": the module-level Map is data, not a class instance, and is the smallest mechanism that prevents concurrent refresh storms.
// 5. PKCE via S256. All constants below sourced from `.omc/research/anthropic-oauth-literals.md` (captured 2026-05-06 from `@anthropic-ai/claude-code` v2.1.114 bundle).
// 6. AUP caveat: Claude.ai Pro/Max OAuth on a bot serving third parties may violate Anthropic's Acceptable Use Policy — see CHANGELOG 0.2.0 and the wizard hint.

import { randomBytes, createHash } from "node:crypto";
import type { OAuthSession, ProfileConfig } from "../types.js";
import { persistOAuth } from "../storage/md.js";
export type { OAuthSession };

export class OAuthStateMismatchError extends Error {
  constructor() {
    super("OAuth state mismatch — pasted URL did not originate from this login attempt (CSRF protection). Restart the login.");
    this.name = "OAuthStateMismatchError";
  }
}

export class OAuthExchangeError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`OAuth token endpoint returned ${status}: ${body.slice(0, 240)}`);
    this.name = "OAuthExchangeError";
  }
}

export class OAuthSessionRevokedError extends Error {
  constructor(public readonly slug: string) {
    super(`OAuth session for profile "${slug}" was revoked or expired beyond refresh. Hint: re-run \`girl-agent --reauth=${slug}\`.`);
    this.name = "OAuthSessionRevokedError";
  }
}

export const OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
export const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const OAUTH_SUCCESS_URL_PREFIX = "https://claude.com/oauth/code/success";
export const OAUTH_CODE_CHALLENGE_METHOD = "S256" as const;
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";
export const OAUTH_SCOPES = ["user:inference"] as const;

export type SaveCallback =
  | { kind: "persist"; slug: string }
  | { kind: "capture"; onCapture: (session: OAuthSession) => void };

const inflightRefresh = new Map<string, Promise<OAuthSession>>();
export { inflightRefresh };

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

export function codeChallengeS256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function generateState(): string {
  return base64url(randomBytes(16));
}

export function buildAuthorizeUrl(opts: { codeChallenge: string; state: string; scope?: readonly string[] }): string {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", (opts.scope ?? OAUTH_SCOPES).join(" "));
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", OAUTH_CODE_CHALLENGE_METHOD);
  return url.toString();
}

/**
 * Accepts either a bare `code` string or a full callback/success URL and returns the `code`.
 *
 * Two paste shapes:
 * 1. URL paste — typically copied from the browser address bar before the redirect to the success page.
 *    Carries both `code` and `state`. We verify `state` matches `expectedState` (CSRF protection).
 * 2. Bare code — copied from the success page text. `state` is unavailable so it can't be verified.
 *    Still functional but loses CSRF protection. The wizard header nudges users to the URL paste.
 */
export function extractCodeFromPaste(input: string, expectedState: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("paste is empty");
  if (trimmed.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error("paste looks like a URL but failed to parse");
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) throw new Error("URL has no `code` query param — paste the full callback URL");
    if (state !== null && state !== expectedState) throw new OAuthStateMismatchError();
    return code;
  }
  return trimmed;
}

export async function exchangeCode(opts: { code: string; codeVerifier: string }): Promise<OAuthSession> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OAUTH_CLIENT_ID,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: OAUTH_REDIRECT_URI
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) {
    const text = await res.text();
    throw new OAuthExchangeError(res.status, text);
  }
  const json = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope?: string };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope
  };
}

export async function refreshTokens(refreshToken: string): Promise<OAuthSession> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refreshToken
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) {
    const text = await res.text();
    throw new OAuthExchangeError(res.status, text);
  }
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope
  };
}

const REFRESH_SKEW_MS = 60_000;

export async function withFreshToken(cfg: ProfileConfig, save: SaveCallback): Promise<string> {
  const current = cfg.llm.oauth;
  if (!current) {
    throw new Error(`profile "${cfg.slug}" has no OAuth session`);
  }
  if (Date.now() < current.expiresAt - REFRESH_SKEW_MS) {
    return current.accessToken;
  }
  let refreshing = inflightRefresh.get(cfg.slug);
  if (!refreshing) {
    refreshing = refreshTokens(current.refreshToken);
    inflightRefresh.set(cfg.slug, refreshing);
  }
  let session: OAuthSession;
  try {
    session = await refreshing;
  } finally {
    if (inflightRefresh.get(cfg.slug) === refreshing) {
      inflightRefresh.delete(cfg.slug);
    }
  }
  cfg.llm.oauth = session;
  if (save.kind === "persist") {
    await persistOAuth(cfg, session);
  } else {
    save.onCapture(session);
  }
  return session.accessToken;
}

interface MaybeStatusError {
  status?: number;
  response?: { status?: number };
}

function is401(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as MaybeStatusError;
  return e.status === 401 || e.response?.status === 401;
}

export async function wrapForLazy401Retry<T>(fn: () => Promise<T>, forceRefresh: () => Promise<void>, slug: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!is401(err)) throw err;
    await forceRefresh();
    try {
      return await fn();
    } catch (err2) {
      if (is401(err2)) throw new OAuthSessionRevokedError(slug);
      throw err2;
    }
  }
}

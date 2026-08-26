/**
 * Read-only access to the orders mailbox, for the "סנכרון שטרי מטען" button.
 *
 * Until now nothing on the server could read mail: bill-of-lading numbers reached
 * the database only through the scheduled Claude task, which holds the Gmail
 * connector and posts what it found to /api/bol/matches. That works but it is not
 * on demand — a number that arrived at 11:00 waits for the next run. This module
 * is the second door, so a person looking at the open-orders screen can ask the
 * question now.
 *
 * Authentication is a Google Workspace **service account with domain-wide
 * delegation**, impersonating the mailbox, and not an OAuth refresh token. An
 * unattended server needs a credential that does not expire on its own: a
 * refresh token issued to an app still in testing dies after seven days, and the
 * button would fail a week after it was set up, silently, with no one to consent
 * again.
 *
 * The scope is `gmail.readonly` — the narrowest scope that can search and read.
 * This code never sends, labels, deletes, or modifies anything.
 */

import { createSign } from "node:crypto";
import { extractBody, headerValue, messageDate, type GmailMessage } from "./gmail-parse";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://gmail.googleapis.com/gmail/v1/users";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** One HTTP call's budget. The sync runs inside a request that must not hang. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A failure worth showing the person who pressed the button, in their language.
 * A missing key and a revoked delegation are both "the mailbox is unreachable",
 * and both need a human — so neither is swallowed into an empty result, which
 * would read as "no tracking numbers arrived".
 */
export class GmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailError";
  }
}

export interface GmailConfig {
  clientEmail: string;
  privateKey: string;
  mailbox: string;
}

/**
 * The three variables this needs, or null when it is not configured at all.
 *
 * Returning null rather than throwing lets the UI hide the button on a
 * deployment that has no mailbox wired up, instead of offering an action that
 * cannot work.
 */
export function gmailConfig(env: NodeJS.ProcessEnv = process.env): GmailConfig | null {
  const clientEmail = (env.GMAIL_SERVICE_ACCOUNT_EMAIL ?? "").trim();
  const mailbox = (env.GMAIL_MAILBOX ?? "").trim();
  // A PEM cannot survive a dashboard environment variable with real newlines, so
  // the escaped form is what actually gets pasted. Both are accepted.
  const privateKey = (env.GMAIL_SERVICE_ACCOUNT_KEY ?? "").replace(/\\n/g, "\n").trim();
  if (!clientEmail || !mailbox || !privateKey) return null;
  return { clientEmail, privateKey, mailbox };
}

export function isGmailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return gmailConfig(env) !== null;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * A signed assertion that this service account may act as the mailbox.
 *
 * `sub` is the impersonation: without it the token belongs to the service
 * account itself, which owns no mail, and every search comes back empty rather
 * than failing — the most confusing outcome available. Which is why the mailbox
 * address is required configuration and not an optional override.
 */
function buildAssertion(config: GmailConfig, now: number): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: config.clientEmail,
      sub: config.mailbox,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    const signature = signer.sign(config.privateKey);
    return `${signingInput}.${base64Url(signature)}`;
  } catch {
    throw new GmailError(
      "המפתח הפרטי של חשבון השירות לא נקרא — יש לבדוק את GMAIL_SERVICE_ACCOUNT_KEY (PEM שלם, כולל שורות BEGIN/END)",
    );
  }
}

/**
 * Access token, cached until shortly before it expires.
 *
 * A sync is dozens of API calls; minting a token for each would triple the
 * traffic and Google's own rate limit is on the token endpoint too. The 60s
 * margin is so a token cannot expire mid-sync.
 */
let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(config: GmailConfig): Promise<string> {
  const nowMs = Date.now();
  if (cached && cached.expiresAt > nowMs + 60_000) return cached.token;

  const assertion = buildAssertion(config, Math.floor(nowMs / 1000));
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GmailError("לא הייתה תשובה משרת ההרשאות של גוגל");
  }

  if (!response.ok) {
    // Google states the reason here and it is almost always actionable —
    // unauthorized_client means the delegation was never granted in the Admin
    // console for this client id and scope, which no amount of retrying fixes.
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new GmailError(
      `גוגל דחתה את ההרשאה (${response.status}). ${
        detail.includes("unauthorized_client")
          ? "נראה שההרשאה לכל הדומיין (domain-wide delegation) לא הוגדרה ל-client id הזה עם ההיקף gmail.readonly."
          : detail
      }`,
    );
  }

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new GmailError("גוגל החזירה תשובה בלי access token");
  cached = {
    token: body.access_token,
    expiresAt: nowMs + (body.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

/** Only used by tests, to keep one case's token out of the next case. */
export function resetGmailTokenCache(): void {
  cached = null;
}

async function apiGet<T>(config: GmailConfig, path: string, params: URLSearchParams): Promise<T> {
  const token = await accessToken(config);
  const url = `${API_BASE}/${encodeURIComponent(config.mailbox)}/${path}?${params}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GmailError("הבקשה ל-Gmail לא הושלמה בזמן");
  }
  if (response.status === 401 || response.status === 403) {
    // A token that was fine a moment ago can be rejected after a scope change;
    // drop it so the next attempt mints a fresh one instead of replaying it.
    cached = null;
    throw new GmailError(
      `Gmail דחתה את הבקשה (${response.status}) — יש לוודא שההיקף gmail.readonly מאושר לתיבה ${config.mailbox}`,
    );
  }
  if (!response.ok) {
    throw new GmailError(`Gmail החזירה שגיאה ${response.status}`);
  }
  return (await response.json()) as T;
}

/**
 * Message ids matching a Gmail search query, newest first.
 *
 * Paged, because a broad query over three months of a working mailbox is more
 * than one page, and `limit` is a hard stop rather than a suggestion: this runs
 * inside a web request, and an unbounded search is how a button becomes a
 * timeout.
 */
export async function searchMessageIds(
  config: GmailConfig,
  query: string,
  limit: number,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  while (ids.length < limit) {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(Math.min(100, limit - ids.length)),
    });
    if (pageToken) params.set("pageToken", pageToken);

    const page = await apiGet<{
      messages?: { id?: string }[];
      nextPageToken?: string;
    }>(config, "messages", params);

    for (const message of page.messages ?? []) {
      if (message.id) ids.push(message.id);
    }
    if (!page.nextPageToken || (page.messages ?? []).length === 0) break;
    pageToken = page.nextPageToken;
  }

  return ids.slice(0, limit);
}

/** One message, full payload. */
export async function fetchMessage(config: GmailConfig, id: string): Promise<GmailMessage> {
  return apiGet<GmailMessage>(config, `messages/${encodeURIComponent(id)}`, new URLSearchParams({ format: "full" }));
}

export { extractBody, headerValue, messageDate };

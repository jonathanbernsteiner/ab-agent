import "server-only";
import { config } from "@/lib/config";
import type { MailAccount, MailAttachment, MailMessage } from "./types";

// Google OAuth + Gmail REST client for the mailbox integration. Plain fetch
// against the public endpoints — the three calls we need (profile, history,
// message get) don't justify the googleapis SDK. Everything network-shaped goes
// through googleFetch() so tests can swap it out (__setTestGoogleFetch), same
// pattern as __setTestProvider / __setTestClassifier.

// Read-only mailbox scan + send replies. Both are "restricted" Gmail scopes:
// fine in a Testing-mode OAuth consent screen (up to 100 test users), Google
// verification only needed for a public launch.
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
].join(" ");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

// Test seam: inject a fake fetch so provider/send tests run fully offline.
let fetchImpl: typeof fetch | null = null;
export function __setTestGoogleFetch(f: typeof fetch | null): void {
  fetchImpl = f;
}
function googleFetch(input: string, init?: RequestInit): Promise<Response> {
  return (fetchImpl ?? fetch)(input, init);
}

// ── OAuth ────────────────────────────────────────────────────────────────────

// The app's external origin as the browser sees it. APP_URL wins; otherwise the
// proxy-forwarded headers (Vercel) or the request URL (localhost dev).
export function externalOrigin(req: Request): string {
  const configured = config.appUrl();
  if (configured) return configured.replace(/\/$/, "");
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

// Must byte-match an "Authorized redirect URI" on the Google OAuth client.
export function oauthRedirectUri(req: Request): string {
  return `${externalOrigin(req)}/api/mail/connect/google/callback`;
}

export function buildGoogleAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: config.google.clientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES,
    // offline + consent forces a refresh_token on every connect, not just the
    // first — without it a reconnect after disconnect gets no refresh token.
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null; // absent on refresh responses
  expiresAt: string; // ISO
}

function toTokens(json: {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}): GoogleTokens {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (json.expires_in - 60) * 1000).toISOString(),
  };
}

async function tokenRequest(params: Record<string, string>): Promise<GoogleTokens> {
  const res = await googleFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.google.clientId(),
      client_secret: config.google.clientSecret(),
      ...params,
    }).toString(),
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Google token request failed: ${json.error ?? res.status}${json.error_description ? ` — ${json.error_description}` : ""}`,
    );
  }
  return toTokens(json as { access_token: string; refresh_token?: string; expires_in: number });
}

export function exchangeGoogleCode(code: string, redirectUri: string): Promise<GoogleTokens> {
  return tokenRequest({ code, redirect_uri: redirectUri, grant_type: "authorization_code" });
}

export function refreshGoogleToken(refreshToken: string): Promise<GoogleTokens> {
  return tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
}

// Best-effort revoke on disconnect — a failure (already revoked, network) must
// not block the local disconnect.
export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await googleFetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST" });
  } catch {
    // ignore
  }
}

// A valid access token for this account, refreshing (and persisting via
// onRefresh) when the stored one is expired or about to be.
export async function freshAccessToken(
  account: MailAccount,
  onRefresh: (tokens: GoogleTokens) => Promise<void>,
): Promise<string> {
  const expiresAt = account.tokenExpiresAt ? Date.parse(account.tokenExpiresAt) : 0;
  if (account.accessToken && expiresAt > Date.now() + 30_000) {
    return account.accessToken;
  }
  if (!account.refreshToken) {
    throw new Error("Gmail authorization expired. Reconnect the mailbox in Settings → Integrations.");
  }
  const tokens = await refreshGoogleToken(account.refreshToken);
  await onRefresh(tokens);
  return tokens.accessToken;
}

// ── Gmail REST ───────────────────────────────────────────────────────────────

class GmailApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function gmailGet<T>(accessToken: string, path: string): Promise<T> {
  const res = await googleFetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GmailApiError(res.status, `Gmail API ${path} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function gmailPost<T>(accessToken: string, path: string, body: unknown): Promise<T> {
  const res = await googleFetch(`${GMAIL_API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GmailApiError(res.status, `Gmail API ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
}

export function getGmailProfile(accessToken: string): Promise<GmailProfile> {
  return gmailGet<GmailProfile>(accessToken, "/profile");
}

// New message ids since startHistoryId. `expired: true` means Gmail no longer
// has history that far back (404) — the caller falls back to a recency scan.
export async function listHistoryMessageIds(
  accessToken: string,
  startHistoryId: string,
): Promise<{ ids: string[]; historyId: string | null; expired: boolean }> {
  const ids: string[] = [];
  let historyId: string | null = null;
  let pageToken: string | undefined;

  try {
    do {
      const params = new URLSearchParams({
        startHistoryId,
        historyTypes: "messageAdded",
        maxResults: "100",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await gmailGet<{
        history?: { messagesAdded?: { message?: { id?: string } }[] }[];
        historyId?: string;
        nextPageToken?: string;
      }>(accessToken, `/history?${params.toString()}`);

      for (const h of page.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          if (added.message?.id) ids.push(added.message.id);
        }
      }
      historyId = page.historyId ?? historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (err) {
    if (err instanceof GmailApiError && err.status === 404) {
      return { ids: [], historyId: null, expired: true };
    }
    throw err;
  }

  return { ids: [...new Set(ids)], historyId, expired: false };
}

// Recency scan for the first sync (or an expired cursor): message ids matching
// the query, newest first, capped.
export async function listRecentMessageIds(
  accessToken: string,
  query: string,
  max: number,
): Promise<string[]> {
  const params = new URLSearchParams({ q: query, maxResults: String(max) });
  const page = await gmailGet<{ messages?: { id: string }[] }>(
    accessToken,
    `/messages?${params.toString()}`,
  );
  return (page.messages ?? []).map((m) => m.id);
}

// ── Message normalization ────────────────────────────────────────────────────

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessageRaw {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}

export function fetchGmailMessage(accessToken: string, id: string): Promise<GmailMessageRaw> {
  return gmailGet<GmailMessageRaw>(accessToken, `/messages/${id}?format=full`);
}

async function fetchAttachmentData(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<string> {
  const res = await gmailGet<{ data?: string }>(
    accessToken,
    `/messages/${messageId}/attachments/${encodeURIComponent(attachmentId)}`,
  );
  return res.data ?? "";
}

// Gmail returns URL-safe base64 (RFC 4648 §5); the pipeline expects standard.
export function base64UrlToBase64(data: string): string {
  const std = data.replace(/-/g, "+").replace(/_/g, "/");
  return std + "=".repeat((4 - (std.length % 4)) % 4);
}

export function decodeBase64Url(data: string): string {
  return Buffer.from(base64UrlToBase64(data), "base64").toString("utf-8");
}

export function headerValue(part: GmailPart | undefined, name: string): string | null {
  const h = part?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

function walkParts(part: GmailPart | undefined, visit: (p: GmailPart) => void): void {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walkParts(child, visit);
}

// Crude but sufficient: triage only needs keywords, not layout.
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Plain-text body: prefer a text/plain part, fall back to stripped text/html.
export function extractBodyText(payload: GmailPart | undefined): string | null {
  let plain: string | null = null;
  let html: string | null = null;
  walkParts(payload, (p) => {
    if (!p.body?.data || p.filename) return;
    const mime = (p.mimeType ?? "").toLowerCase();
    if (mime.startsWith("text/plain") && plain === null) plain = decodeBase64Url(p.body.data);
    else if (mime.startsWith("text/html") && html === null) html = decodeBase64Url(p.body.data);
  });
  if (plain !== null) return plain;
  if (html !== null) return htmlToText(html);
  return null;
}

interface PdfPartRef {
  filename: string;
  contentType: string;
  data?: string;
  attachmentId?: string;
}

export function collectPdfParts(payload: GmailPart | undefined): PdfPartRef[] {
  const refs: PdfPartRef[] = [];
  walkParts(payload, (p) => {
    const filename = p.filename ?? "";
    const mime = (p.mimeType ?? "").toLowerCase();
    if (!filename && !mime.includes("pdf")) return;
    if (!mime.includes("pdf") && !filename.toLowerCase().endsWith(".pdf")) return;
    if (!p.body?.data && !p.body?.attachmentId) return;
    refs.push({
      filename: filename || "attachment.pdf",
      contentType: p.mimeType || "application/pdf",
      data: p.body.data,
      attachmentId: p.body.attachmentId,
    });
  });
  return refs;
}

// Full raw Gmail message → the provider-agnostic MailMessage the pipeline eats.
// Returns null for mail the scan must ignore (our own sent mail, drafts, spam,
// trash) — history.list reports those as "added" too.
export async function normalizeGmailMessage(
  accessToken: string,
  raw: GmailMessageRaw,
): Promise<MailMessage | null> {
  const labels = raw.labelIds ?? [];
  if (["SENT", "DRAFT", "SPAM", "TRASH"].some((l) => labels.includes(l))) return null;

  const attachments: MailAttachment[] = [];
  for (const ref of collectPdfParts(raw.payload)) {
    const data = ref.data ?? (ref.attachmentId
      ? await fetchAttachmentData(accessToken, raw.id, ref.attachmentId)
      : "");
    if (!data) continue;
    attachments.push({
      filename: ref.filename,
      contentType: ref.contentType,
      base64: base64UrlToBase64(data),
    });
  }

  return {
    externalId: raw.id,
    from: headerValue(raw.payload, "From"),
    subject: headerValue(raw.payload, "Subject"),
    text: extractBodyText(raw.payload),
    attachments,
    receivedAt: raw.internalDate ? new Date(Number(raw.internalDate)).toISOString() : null,
    threadId: raw.threadId ?? null,
    rfcMessageId: headerValue(raw.payload, "Message-ID") ?? headerValue(raw.payload, "Message-Id"),
  };
}

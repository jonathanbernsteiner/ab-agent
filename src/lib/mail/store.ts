import "server-only";
import { getSupabase } from "@/lib/supabase";
import { getCompanyId } from "@/lib/tenant";
import { paginate } from "@/lib/store";
import type { MailAccount, MailMessage, MailProviderId } from "./types";

// The decision persisted on a mail_event. Mirrors TriageDecision but "ingest"
// becomes past-tense "ingested" (it happened) and adds "error".
export type MailEventDecision =
  | "ingested"
  | "skipped_prefilter"
  | "skipped_classifier"
  | "error";

// Persistence for the mailbox integration: connected accounts + the per-message
// audit log. Everything is company-scoped via getCompanyId(), same as store.ts.

// ── Accounts ────────────────────────────────────────────────────────────────

interface AccountRow {
  id: string;
  company_id: string;
  provider: string;
  external_email: string | null;
  status: string;
  cursor: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  last_polled_at: string | null;
  last_error: string | null;
}

function toAccount(r: AccountRow): MailAccount {
  return {
    id: r.id,
    companyId: r.company_id,
    provider: r.provider as MailProviderId,
    externalEmail: r.external_email,
    status: r.status as MailAccount["status"],
    cursor: r.cursor,
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    tokenExpiresAt: r.token_expires_at,
    lastPolledAt: r.last_polled_at,
    lastError: r.last_error,
  };
}

// All mailbox accounts for the current company (any status) — drives the
// Settings → Integrations panel.
export async function getMailAccounts(): Promise<MailAccount[]> {
  const sb = getSupabase();
  const { data } = await sb
    .from("mail_accounts")
    .select("*")
    .eq("company_id", getCompanyId())
    .order("created_at", { ascending: true });
  return ((data as AccountRow[]) ?? []).map(toAccount);
}

// Accounts the poll loop should actually fetch from (connected + real provider).
export async function getConnectedAccounts(): Promise<MailAccount[]> {
  return (await getMailAccounts()).filter(
    (a) => a.status === "connected" && a.provider !== "manual",
  );
}

// System-level (cross-tenant). The poll cron has no single company context, so
// this deliberately bypasses the getCompanyId scope to find every connected
// mailbox across all tenants; the cron then re-enters each account's company via
// runWithCompany before touching any company-scoped data.
export async function getAllConnectedAccounts(): Promise<MailAccount[]> {
  const sb = getSupabase();
  const { data } = await sb
    .from("mail_accounts")
    .select("*")
    .eq("status", "connected")
    .neq("provider", "manual");
  return ((data as AccountRow[]) ?? []).map(toAccount);
}

// System-level (cross-tenant) lookup by id. Used by the push endpoint, which is
// told "account X changed" and needs the account (and its company) to poll it.
export async function getAccountById(id: string): Promise<MailAccount | null> {
  const sb = getSupabase();
  const { data } = await sb.from("mail_accounts").select("*").eq("id", id).limit(1);
  return data && data.length ? toAccount(data[0] as AccountRow) : null;
}

// The first connected mailbox that can SEND for the current company. Gmail-only
// today; when Outlook lands this grows a provider dispatch.
export async function getSendingAccount(): Promise<MailAccount | null> {
  const accounts = await getConnectedAccounts();
  return accounts.find((a) => a.provider === "gmail") ?? null;
}

// Create-or-refresh the row for a just-completed OAuth connect. Keyed on
// (company, provider, email) so reconnecting the same mailbox updates tokens in
// place instead of duplicating the account.
export interface ConnectAccountArgs {
  provider: MailProviderId;
  externalEmail: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string;
  cursor: string | null; // provider position at connect time (Gmail historyId)
}

export async function upsertConnectedAccount(args: ConnectAccountArgs): Promise<void> {
  const sb = getSupabase();
  const companyId = getCompanyId();
  const fields = {
    status: "connected",
    access_token: args.accessToken,
    // A reconnect may come back without a refresh token if Google skipped the
    // consent screen; keep whatever we get (null overwrites are acceptable —
    // prompt=consent makes this rare).
    refresh_token: args.refreshToken,
    token_expires_at: args.tokenExpiresAt,
    cursor: args.cursor,
    last_error: null,
    updated_at: new Date().toISOString(),
  };

  // Select-then-write instead of ON CONFLICT: the uniqueness on
  // (company, provider, email) is an expression index (coalesce on the nullable
  // email), which ON CONFLICT column inference can't target. Races are a
  // non-issue — connects are a human finishing an OAuth redirect — and the
  // index still backstops duplicates.
  const { data: existing } = await sb
    .from("mail_accounts")
    .select("id")
    .eq("company_id", companyId)
    .eq("provider", args.provider)
    .eq("external_email", args.externalEmail)
    .limit(1);

  const { error } = existing?.length
    ? await sb.from("mail_accounts").update(fields).eq("id", existing[0].id).eq("company_id", companyId)
    : await sb.from("mail_accounts").insert({
        company_id: companyId,
        provider: args.provider,
        external_email: args.externalEmail,
        ...fields,
      });
  if (error) throw new Error(`Could not save the mailbox connection: ${error.message}`);
}

// Persist a refreshed access token (refresh_token stays untouched).
export async function updateAccountTokens(
  accountId: string,
  accessToken: string,
  tokenExpiresAt: string,
): Promise<void> {
  const sb = getSupabase();
  await sb
    .from("mail_accounts")
    .update({
      access_token: accessToken,
      token_expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", accountId)
    .eq("company_id", getCompanyId());
}

// Disconnect: drop the tokens, keep the row (and its audit history).
export async function disconnectAccount(accountId: string): Promise<MailAccount | null> {
  const sb = getSupabase();
  const account = (await getMailAccounts()).find((a) => a.id === accountId) ?? null;
  if (!account) return null;
  await sb
    .from("mail_accounts")
    .update({
      status: "disconnected",
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      cursor: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", accountId)
    .eq("company_id", getCompanyId());
  return account;
}

// Persist the provider sync cursor + poll timestamp after a successful poll.
export async function advanceCursor(
  accountId: string,
  cursor: string | null,
): Promise<void> {
  const sb = getSupabase();
  await sb
    .from("mail_accounts")
    .update({
      cursor,
      last_polled_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", accountId)
    .eq("company_id", getCompanyId());
}

export async function recordAccountError(accountId: string, message: string): Promise<void> {
  const sb = getSupabase();
  await sb
    .from("mail_accounts")
    .update({
      status: "error",
      last_error: message,
      last_polled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", accountId)
    .eq("company_id", getCompanyId());
}

// Threading handles for replying to the email that delivered an AB. Present only
// when the AB came in through a scanned Gmail mailbox (process.ts stores them on
// source_meta); a forwarded/uploaded AB sends as a fresh email instead.
export interface AbReplyMeta {
  threadId: string | null;
  rfcMessageId: string | null;
}

export async function getAbReplyMeta(abId: string): Promise<AbReplyMeta> {
  const sb = getSupabase();
  const { data } = await sb
    .from("abs")
    .select("source_meta")
    .eq("company_id", getCompanyId())
    .eq("id", abId)
    .limit(1);
  const meta = (data?.[0]?.source_meta ?? {}) as Record<string, unknown>;
  return {
    threadId: typeof meta.threadId === "string" ? meta.threadId : null,
    rfcMessageId: typeof meta.rfcMessageId === "string" ? meta.rfcMessageId : null,
  };
}

// ── Events (audit log + idempotency) ────────────────────────────────────────

// Has this provider message already been processed for this company? Guards the
// loop against re-processing on overlapping polls (upstream of content-hash
// dedupe in the pipeline).
export async function wasMessageSeen(
  provider: MailProviderId,
  externalMessageId: string,
): Promise<boolean> {
  const sb = getSupabase();
  const { data } = await sb
    .from("mail_events")
    .select("id")
    .eq("company_id", getCompanyId())
    .eq("provider", provider)
    .eq("external_message_id", externalMessageId)
    .limit(1);
  return !!(data && data.length);
}

export interface RecordEventArgs {
  accountId: string | null;
  provider: MailProviderId;
  message: MailMessage;
  decision: MailEventDecision;
  reason: string;
  confidence?: "high" | "medium" | "low" | null;
  abId?: string | null;
}

// Best-effort: the audit log is observability, not a source of truth, so a failed
// insert (e.g. the unique-index collision when the same message is logged twice)
// must never break ingestion. A 23505 collision simply means "already logged".
export async function recordMailEvent(args: RecordEventArgs): Promise<void> {
  const sb = getSupabase();
  try {
    const { error } = await sb.from("mail_events").insert({
      company_id: getCompanyId(),
      account_id: args.accountId,
      provider: args.provider,
      external_message_id: args.message.externalId,
      from_addr: args.message.from,
      subject: args.message.subject,
      decision: args.decision,
      reason: args.reason,
      classifier_confidence: args.confidence ?? null,
      ab_id: args.abId ?? null,
    });
    if (error && (error as { code?: string }).code !== "23505") {
      console.error("[mail_events] insert failed", error);
    }
  } catch (err) {
    console.error("[mail_events] insert threw", err);
  }
}

// ── Activity (Settings → Integrations) ──────────────────────────────────────

export interface MailActivityRow {
  id: string;
  provider: string;
  from: string | null;
  subject: string | null;
  decision: string;
  reason: string | null;
  confidence: string | null;
  abId: string | null;
  createdAt: string;
}

export async function getMailActivity(limit = 25): Promise<MailActivityRow[]> {
  const sb = getSupabase();
  const { data } = await sb
    .from("mail_events")
    .select(
      "id, provider, from_addr, subject, decision, reason, classifier_confidence, ab_id, created_at",
    )
    .eq("company_id", getCompanyId())
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((r) => ({
    id: r.id,
    provider: r.provider,
    from: r.from_addr,
    subject: r.subject,
    decision: r.decision,
    reason: r.reason,
    confidence: r.classifier_confidence,
    abId: r.ab_id,
    createdAt: String(r.created_at),
  }));
}

// Rollup counts for the panel header ("scanned N · ingested M · skipped K").
export interface MailStats {
  total: number;
  ingested: number;
  skipped: number;
}

export async function getMailStats(): Promise<MailStats> {
  const sb = getSupabase();
  const rows = await paginate<{ decision: string }>(() =>
    sb.from("mail_events").select("decision").eq("company_id", getCompanyId()),
  );
  let ingested = 0;
  let skipped = 0;
  for (const r of rows) {
    if (r.decision === "ingested") ingested++;
    else if (r.decision.startsWith("skipped")) skipped++;
  }
  return { total: rows.length, ingested, skipped };
}

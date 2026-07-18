import "server-only";
import { config } from "@/lib/config";
import {
  fetchGmailMessage,
  freshAccessToken,
  getGmailProfile,
  listHistoryMessageIds,
  listRecentMessageIds,
  normalizeGmailMessage,
} from "./google";
import { updateAccountTokens } from "./store";
import type { MailAccount, MailMessage, MailProvider, MailProviderId, PollResult } from "./types";

// Provider registry. Gmail is live (OAuth via /api/mail/connect/google, fetch
// via users.history.list); Microsoft is still a stub. Providers only differ in
// how they FETCH — triage/ingest/audit downstream is source-agnostic.

const NOT_CONNECTED = (label: string) =>
  new Error(
    `${label} is not connected yet. Implement its listNewMessages() (OAuth + ` +
      `history/delta fetch) and set connectable=true in src/lib/mail/providers.ts.`,
  );

// First sync after connect (cursor is null) and expired-history recovery scan
// the recent past instead of a history delta. Triage keeps the cost sane: the
// free prefilter rejects most of a week's mail before the cheap classifier runs.
const BACKFILL_QUERY = "newer_than:7d";
const BACKFILL_MAX = 50;
// Safety valve per poll: history bursts beyond this are deferred — the cursor is
// NOT advanced, so the next poll re-lists and the loop's wasMessageSeen() skips
// what's already done.
const MAX_MESSAGES_PER_POLL = 100;

async function fetchAndNormalize(token: string, ids: string[]): Promise<MailMessage[]> {
  const messages: MailMessage[] = [];
  for (const id of ids) {
    const raw = await fetchGmailMessage(token, id);
    const normalized = await normalizeGmailMessage(token, raw);
    if (normalized) messages.push(normalized); // null = own sent mail / draft / spam
  }
  return messages;
}

async function gmailListNewMessages(account: MailAccount): Promise<PollResult> {
  const token = await freshAccessToken(account, (t) =>
    updateAccountTokens(account.id, t.accessToken, t.expiresAt),
  );

  // Delta path: everything since the stored historyId.
  if (account.cursor) {
    const delta = await listHistoryMessageIds(token, account.cursor);
    if (!delta.expired) {
      const capped = delta.ids.length > MAX_MESSAGES_PER_POLL;
      const ids = capped ? delta.ids.slice(0, MAX_MESSAGES_PER_POLL) : delta.ids;
      const messages = await fetchAndNormalize(token, ids);
      return { messages, cursor: capped ? account.cursor : (delta.historyId ?? account.cursor) };
    }
    // Gmail dropped history that far back (cursor too old) → recency rescan below.
  }

  // First sync / expired cursor: pin the cursor to "now" first (a message that
  // lands mid-scan is covered by the next delta), then backfill recent mail.
  const profile = await getGmailProfile(token);
  const ids = await listRecentMessageIds(token, BACKFILL_QUERY, BACKFILL_MAX);
  const messages = await fetchAndNormalize(token, ids.reverse()); // oldest first
  return { messages, cursor: profile.historyId };
}

const gmail: MailProvider = {
  id: "gmail",
  label: "Gmail",
  // Connectable once the Google OAuth client is configured; without env vars the
  // UI honestly shows "not configured" instead of a dead Connect button.
  get connectable() {
    return config.google.isConfigured();
  },
  listNewMessages: gmailListNewMessages,
};

// Microsoft 365 / Outlook: OAuth via Entra, then a Graph delta query on the
// mailbox (or a change subscription); cursor is the deltaLink.
const microsoft: MailProvider = {
  id: "microsoft",
  label: "Outlook / Microsoft 365",
  connectable: false,
  async listNewMessages() {
    throw NOT_CONNECTED("Outlook / Microsoft 365");
  },
};

// The "manual" provider represents the forward-to-intake webhook path. It never
// polls — messages arrive push-style at /api/inbound — so listNewMessages is a
// no-op. It exists so webhook events share the same mail_events audit log.
const manual: MailProvider = {
  id: "manual",
  label: "Forwarded email",
  connectable: true,
  async listNewMessages() {
    return { messages: [], cursor: null };
  },
};

const REGISTRY: Record<MailProviderId, MailProvider> = { gmail, microsoft, manual };

// Test seam: inject a fetching provider so the poll loop is exercisable offline
// (no OAuth), mirroring __setTestSupabaseClient / __setTestClassifier.
const testProviders = new Map<MailProviderId, MailProvider>();
export function __setTestProvider(id: MailProviderId, provider: MailProvider | null): void {
  if (provider) testProviders.set(id, provider);
  else testProviders.delete(id);
}

export function getProvider(id: MailProviderId): MailProvider {
  return testProviders.get(id) ?? REGISTRY[id];
}

export function allProviders(): MailProvider[] {
  return Object.values(REGISTRY);
}

// Providers a user can actually connect a mailbox with today (drives the UI).
export function connectableProviders(): MailProvider[] {
  return allProviders().filter((p) => p.connectable && p.id !== "manual");
}

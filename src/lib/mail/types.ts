// Shared types for the mailbox auto-triage loop.
//
// The whole feature funnels every source — a forwarded webhook email today, a
// connected Gmail/Outlook mailbox tomorrow — into ONE normalized MailMessage and
// ONE processor (process.ts). Providers differ only in how they *fetch* messages;
// everything downstream (triage → ingest → log) is source-agnostic.

export interface MailAttachment {
  filename: string;
  contentType: string;
  base64: string;
}

// A provider-agnostic inbound message. Both the webhook and any real mailbox
// provider normalize their payload down to this.
export interface MailMessage {
  // Provider's stable id for this message. Used for at-most-once processing
  // (mail_events dedupe) — distinct from the pipeline's content-hash dedupe.
  externalId: string;
  from: string | null;
  subject: string | null;
  text: string | null; // plain-text body (HTML already stripped)
  attachments: MailAttachment[];
  receivedAt?: string | null; // ISO, if the provider gives one
  // Threading handles, when the provider has them (Gmail does): the provider's
  // conversation id and the RFC 2822 Message-ID header. Stored on the AB's
  // source_meta so an outbound reply can thread onto the original email.
  threadId?: string | null;
  rfcMessageId?: string | null;
}

export type MailProviderId = "gmail" | "microsoft" | "manual";

// A connected mailbox row (mail_accounts). Tokens are omitted from the shape the
// loop passes around unless a provider needs them; providers read them via the
// account record they're handed.
export interface MailAccount {
  id: string;
  companyId: string;
  provider: MailProviderId;
  externalEmail: string | null;
  status: "disconnected" | "connected" | "error";
  cursor: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
  lastPolledAt?: string | null;
  lastError?: string | null;
}

// What a provider returns from one poll: the new messages plus the cursor to
// persist so the next poll resumes after them.
export interface PollResult {
  messages: MailMessage[];
  cursor: string | null;
}

// The seam that OAuth plugs into later. A provider only has to answer "what's
// new since this cursor?" — normalization and everything after is shared.
export interface MailProvider {
  id: MailProviderId;
  label: string;
  // True once real fetching is implemented (OAuth wired). Stubs return false so
  // the UI can show "on the roadmap" honestly and the loop skips them.
  connectable: boolean;
  listNewMessages(account: MailAccount): Promise<PollResult>;
}

// ── Triage ──────────────────────────────────────────────────────────────────

// How much we trust that a message is worth the expensive pipeline:
//   forwarded — a human deliberately forwarded it to the intake address, so we
//               ingest without spending the classifier (today's webhook path).
//   scanned   — the loop is reading the WHOLE mailbox, so most mail is junk; run
//               the free prefilter, then the cheap classifier, then ingest only
//               confirmed ABs.
export type TriageMode = "forwarded" | "scanned";

export type TriageDecision =
  | "ingest"
  | "skipped_prefilter"
  | "skipped_classifier";

export interface TriageResult {
  decision: TriageDecision;
  reason: string;
  confidence: "high" | "medium" | "low" | null;
}

import "server-only";
import { getProvider } from "./providers";
import {
  advanceCursor,
  getConnectedAccounts,
  recordAccountError,
  wasMessageSeen,
} from "./store";
import { processMailMessage } from "./process";
import type { MailAccount } from "./types";

// The scan loop: for each connected mailbox, ask the provider "what's new since
// my cursor?", process each unseen message through the shared pipeline in
// `scanned` mode (prefilter → cheap classifier → ingest confirmed ABs), and
// advance the cursor. Inert today — getConnectedAccounts() returns nothing until
// a real provider is wired up — but the entire machine around the OAuth seam is
// here and exercised by tests.

export interface PollSummary {
  accountId: string;
  provider: string;
  fetched: number;
  processed: number; // newly seen (not dedupe-skipped)
  ingested: number;
  skipped: number;
  error?: string;
}

export async function pollMailbox(account: MailAccount): Promise<PollSummary> {
  const summary: PollSummary = {
    accountId: account.id,
    provider: account.provider,
    fetched: 0,
    processed: 0,
    ingested: 0,
    skipped: 0,
  };

  const provider = getProvider(account.provider);

  try {
    const { messages, cursor } = await provider.listNewMessages(account);
    summary.fetched = messages.length;

    for (const message of messages) {
      // At-most-once: overlapping polls (or a cursor that re-delivers) must not
      // reprocess a message. This is the mail-layer guard; the pipeline's
      // content-hash dedupe is the second line.
      if (await wasMessageSeen(account.provider, message.externalId)) continue;

      const outcome = await processMailMessage({
        message,
        provider: account.provider,
        mode: "scanned",
        accountId: account.id,
      });
      summary.processed++;
      if (outcome.decision === "ingested") summary.ingested++;
      else summary.skipped++;
    }

    // Only advance the cursor after every message is durably logged, so a crash
    // mid-poll re-fetches rather than silently skipping.
    await advanceCursor(account.id, cursor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "poll failed";
    summary.error = message;
    await recordAccountError(account.id, message);
  }

  return summary;
}

// Poll every connected mailbox for the CURRENT company (call inside
// runWithCompany). The cron route fans this out across tenants.
export async function pollAllForCompany(): Promise<PollSummary[]> {
  const accounts = await getConnectedAccounts();
  const summaries: PollSummary[] = [];
  for (const account of accounts) {
    summaries.push(await pollMailbox(account));
  }
  return summaries;
}

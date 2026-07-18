import "server-only";
import { ingestDocument } from "@/lib/pipeline";
import type { IngestInput, IngestResult } from "@/lib/pipeline";
import { MAX_UPLOAD_BYTES } from "@/lib/config";
import { triage } from "./triage";
import { recordMailEvent, type MailEventDecision } from "./store";
import type { MailMessage, MailProviderId, TriageMode } from "./types";

// The one processor every mail source funnels through. Given a normalized
// MailMessage it: triages (forwarded → ingest; scanned → prefilter + classifier),
// runs the pipeline only on ABs, and writes exactly one audit row to mail_events.
//
// Idempotency (has-this-message-been-seen) is the caller's job — the webhook has
// no cursor so it relies on the pipeline's content-hash dedupe, while the loop
// checks wasMessageSeen() before calling this. Keeping the seen-check out of here
// lets the webhook stay push-style and the loop stay pull-style.

export interface ProcessArgs {
  message: MailMessage;
  provider: MailProviderId;
  mode: TriageMode;
  accountId: string | null;
}

export interface ProcessOutcome {
  decision: MailEventDecision;
  reason: string;
  results: IngestResult[]; // pipeline results when ingested; empty when skipped
}

function pdfInputs(msg: MailMessage): IngestInput[] {
  const inputs: IngestInput[] = [];
  // Keep the provider message id on the record: a future outbound reply threads
  // to the AB by replying to this sender/message (In-Reply-To), and the sender
  // address is the exact, correct reply-to — no vendor-master lookup needed.
  const sourceMeta = {
    from: msg.from,
    subject: msg.subject,
    messageId: msg.externalId,
    ...(msg.threadId ? { threadId: msg.threadId } : {}),
    ...(msg.rfcMessageId ? { rfcMessageId: msg.rfcMessageId } : {}),
  };

  const pdfs = msg.attachments.filter(
    (a) =>
      a.contentType.toLowerCase().includes("pdf") ||
      a.filename.toLowerCase().endsWith(".pdf"),
  );

  if (pdfs.length > 0) {
    for (const a of pdfs) {
      const bytes = Buffer.from(a.base64, "base64");
      if (bytes.byteLength > MAX_UPLOAD_BYTES) continue;
      inputs.push({
        bytes: new Uint8Array(bytes),
        filename: a.filename,
        mimeType: a.contentType,
        source: "email",
        sourceMeta,
      });
    }
    return inputs;
  }

  // Body-only email: treat the text (with subject prepended) as the document.
  const text = msg.text?.trim();
  if (text) {
    inputs.push({
      bodyText: `${msg.subject ? msg.subject + "\n\n" : ""}${text}`,
      filename: null,
      source: "email",
      sourceMeta,
    });
  }
  return inputs;
}

export async function processMailMessage(args: ProcessArgs): Promise<ProcessOutcome> {
  const { message, provider, mode, accountId } = args;

  const verdict = await triage(message, mode);

  if (verdict.decision !== "ingest") {
    await recordMailEvent({
      accountId,
      provider,
      message,
      decision: verdict.decision, // "skipped_prefilter" | "skipped_classifier"
      reason: verdict.reason,
      confidence: verdict.confidence,
    });
    return { decision: verdict.decision, reason: verdict.reason, results: [] };
  }

  const inputs = pdfInputs(message);
  if (inputs.length === 0) {
    // Passed triage but carried nothing extractable (e.g. empty forwarded mail).
    await recordMailEvent({
      accountId,
      provider,
      message,
      decision: "skipped_prefilter",
      reason: "no attachment or body text to extract",
      confidence: verdict.confidence,
    });
    return { decision: "skipped_prefilter", reason: "empty message", results: [] };
  }

  const results: IngestResult[] = [];
  for (const input of inputs) {
    results.push(await ingestDocument(input));
  }

  await recordMailEvent({
    accountId,
    provider,
    message,
    decision: "ingested",
    reason: verdict.reason,
    confidence: verdict.confidence,
    abId: results[0]?.abId ?? null,
  });

  return { decision: "ingested", reason: verdict.reason, results };
}

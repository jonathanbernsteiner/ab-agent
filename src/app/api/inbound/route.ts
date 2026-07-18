import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { resolveCompanyByIntake } from "@/lib/auth/guard";
import { runWithCompany } from "@/lib/tenant";
import { processMailMessage } from "@/lib/mail/process";
import type { MailAttachment, MailMessage } from "@/lib/mail/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Inbound email webhook (Resend / Postmark shape). A human forwarded this AB to
// the intake address, so it runs in `forwarded` triage mode: no classifier, ingest
// and log. Same pipeline as upload, so a reply that contains the AB closes the
// loop automatically. Machine-scanned mailboxes take the pull path in mail/loop.ts.
interface InboundAttachment {
  filename?: string;
  contentType?: string;
  content?: string; // base64
  contentBase64?: string; // Postmark uses "Content"
}

interface InboundPayload {
  from?: string;
  From?: string;
  subject?: string;
  Subject?: string;
  text?: string;
  TextBody?: string;
  html?: string;
  HtmlBody?: string;
  to?: string;
  To?: string;
  recipient?: string;
  OriginalRecipient?: string;
  MessageID?: string;
  MessageId?: string;
  messageId?: string;
  attachments?: InboundAttachment[];
  Attachments?: Array<{ Name?: string; ContentType?: string; Content?: string }>;
}

export async function POST(req: Request) {
  const secret = config.inboundSecret();
  // Fail closed: this webhook runs a paid LLM extraction per call and writes
  // rows. If no INBOUND_WEBHOOK_SECRET is configured, disable it rather than
  // leave an open, unauthenticated cost/injection surface on a public deploy.
  if (!secret) {
    return NextResponse.json(
      { error: "Inbound webhook is disabled. Set INBOUND_WEBHOOK_SECRET to enable it." },
      { status: 403 },
    );
  }
  const url = new URL(req.url);
  const provided = url.searchParams.get("secret") || req.headers.get("x-webhook-secret");
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: InboundPayload;
  try {
    payload = (await req.json()) as InboundPayload;
  } catch {
    return NextResponse.json({ error: "Ungültiges JSON." }, { status: 400 });
  }

  const from = payload.from ?? payload.From ?? null;
  const subject = payload.subject ?? payload.Subject ?? null;
  const text = payload.text ?? payload.TextBody ?? stripHtml(payload.html ?? payload.HtmlBody);

  // Normalize attachments across providers into the shared MailMessage shape.
  const attachments: MailAttachment[] = [];
  for (const a of payload.attachments ?? []) {
    const b64 = a.content ?? a.contentBase64;
    if (b64) attachments.push({ filename: a.filename ?? "anhang.pdf", contentType: a.contentType ?? "application/pdf", base64: b64 });
  }
  for (const a of payload.Attachments ?? []) {
    if (a.Content) attachments.push({ filename: a.Name ?? "anhang.pdf", contentType: a.ContentType ?? "application/pdf", base64: a.Content });
  }

  // Route the email to a tenant by its recipient (intake) address.
  const companyId = await resolveCompanyByIntake([
    payload.to,
    payload.To,
    payload.recipient,
    payload.OriginalRecipient,
  ]);
  if (!companyId) {
    return NextResponse.json(
      { error: "Kein Postfach für diese Empfängeradresse gefunden." },
      { status: 404 },
    );
  }

  const message: MailMessage = {
    externalId:
      payload.MessageID ?? payload.MessageId ?? payload.messageId ?? synthId(from, subject, text),
    from,
    subject,
    text: text || null,
    attachments,
  };

  // Nothing to work with → acknowledge without spending the pipeline.
  if (attachments.length === 0 && !(text && text.trim())) {
    return NextResponse.json({ ok: true, skipped: "Leere E-Mail ohne Anhang." });
  }

  try {
    const outcome = await runWithCompany(companyId, () =>
      processMailMessage({ message, provider: "manual", mode: "forwarded", accountId: null }),
    );
    return NextResponse.json({ ok: true, decision: outcome.decision, results: outcome.results });
  } catch (err) {
    console.error("[inbound]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Verarbeitung fehlgeschlagen." },
      { status: 500 },
    );
  }
}

// Fallback message id when the provider gives none. Deterministic (no clock/rng)
// so a retimed retry of the same mail collides on the audit unique-index rather
// than logging twice; the pipeline's content-hash dedupe still owns real dedupe.
function synthId(from: string | null, subject: string | null, text: string): string {
  return `syn:${(from ?? "").toLowerCase()}|${subject ?? ""}|${text.length}`;
}

function stripHtml(html?: string): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

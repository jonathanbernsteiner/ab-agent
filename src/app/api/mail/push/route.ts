import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getAccountById } from "@/lib/mail/store";
import { pollMailbox } from "@/lib/mail/loop";
import { runWithCompany } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Event-triggered ingestion. This is the PRIMARY, real-time path: a connected
// mailbox's provider (Gmail Pub/Sub push, Microsoft Graph change subscription)
// calls this the instant a message arrives; we pull just that account's delta via
// its cursor and process the new mail immediately. The /api/mail/poll cron stays
// as a reconciliation safety-net for anything a missed push notification dropped.
//
// Inert until a mailbox is connected (no account → 404). Fail closed on the secret.
export async function POST(req: Request) {
  const secret = config.mailPollSecret();
  if (!secret) {
    return NextResponse.json(
      { error: "Mail push is disabled. Set MAIL_POLL_SECRET to enable it." },
      { status: 403 },
    );
  }
  const url = new URL(req.url);
  const provided =
    url.searchParams.get("secret") ||
    req.headers.get("x-webhook-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { account_id?: string };
  try {
    body = (await req.json()) as { account_id?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (!body.account_id) {
    return NextResponse.json({ error: "account_id required." }, { status: 400 });
  }

  const account = await getAccountById(body.account_id);
  if (!account) {
    return NextResponse.json({ error: "Unknown mailbox account." }, { status: 404 });
  }

  const summary = await runWithCompany(account.companyId, () => pollMailbox(account));
  return NextResponse.json({ ok: true, summary });
}
